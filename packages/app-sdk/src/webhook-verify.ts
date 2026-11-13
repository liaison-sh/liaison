// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/app-sdk/webhook-verify: building blocks for manifest-format webhook
// verifiers in bundled and third-party apps.
//
// Verifier bundles run inside the sandbox (no `node:crypto`): every digest and
// comparison goes through the host `crypto_*` bridges the kernel hands the
// verify handler. The signing secret never enters the verifier: it names the
// secret's config key and the host checks the signature with it
// (`crypto_verifyHmacForConfig`, `config_has`), on every executor. This file
// MUST NOT import `node:*`.

/** Lower-case every header name (the kernel forwards headers as received). */
export function lowercaseHeaderKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v
  return out
}

/**
 * A stable delivery id for a sender that sends none: the HMAC of the raw body
 * under a fixed per-app label, so an identical redelivery dedups.
 */
export function bodyDeliveryId(
  label: string,
  body: string,
  bridge: { crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string> },
): Promise<string> {
  return bridge.crypto_hmacSha256Base64(label, body)
}

/**
 * Signed `ts` (ISO-8601 string or epoch ms) as epoch ms, or null when the body
 * is not JSON or carries no parseable ts.
 */
export function extractSignedTsMs(body: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const ts = (parsed as Record<string, unknown>).ts
  if (typeof ts !== "string" && typeof ts !== "number") return null
  const ms = new Date(ts).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * Freshness TTL override from apps.config under `configKey`, else the default.
 * Non-numeric or non-positive values fall back to the default (fail closed to
 * the known-good window rather than open to "no bound").
 */
export async function freshnessTtlSeconds(
  bridge: { config_get: (key: string) => Promise<unknown> },
  configKey: string,
  defaultSeconds: number,
): Promise<number> {
  const raw = await bridge.config_get(configKey)
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : defaultSeconds
}

/** The crypto/config bridge a base64 HMAC verifier needs. */
export interface Base64HmacWebhookBridge {
  /** A plain (non-secret) config value, such as the freshness override. */
  config_get: (key: string) => Promise<unknown>
  /** Whether a config key (a declared secret included) holds a value. */
  config_has: (key: string) => Promise<boolean>
  /** Verify `signature` over `data` with the declared config secret `key`, host-side. */
  crypto_verifyHmacForConfig: (
    key: string,
    data: string,
    signature: string,
    encoding: "base64" | "hex",
  ) => Promise<boolean>
  crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
}

/** How one app signs its signed-`ts` webhooks. */
export interface SignedTsWebhookSpec {
  /** apps.config key holding the kernel-minted signing secret. */
  secretConfigKey: string
  /** Header carrying the base64 HMAC-SHA256 of the raw body (lower case). */
  signatureHeader: string
  /** Optional exact-retry dedup header (lower case). */
  deliveryIdHeader: string
  /** Fixed label hashed with the body when no delivery id header is sent. */
  deliveryIdLabel: string
  /** apps.config key overriding the freshness window (seconds > 0). */
  ttlConfigKey: string
  defaultTtlSeconds: number
  /** Per-handler scopes granted on success; omitted from the result when unset. */
  scopes?: string[]
}

export interface SignedTsWebhookResult {
  ok: boolean
  replayKey?: string
  replayTtlSeconds?: number
  reason?: string
  scopes?: string[]
}

/**
 * The signed-`ts` construction: the sender signs the RAW body with HMAC-SHA256
 * (base64) under the app's secret; after the signature verifies, the signed
 * `ts` must lie within the freshness TTL of `nowMs` in either direction (a
 * future-skewed capture is rejected too), and a body with no parseable `ts` is
 * rejected. The replay key is the digest of the SIGNED body: a delivery-id
 * header is not covered by the signature, so a captured delivery re-sent under
 * a fresh id must not read as new. (`deliveryIdHeader` is kept in the spec for
 * callers but no longer feeds the key.)
 */
export async function verifySignedTsWebhook(
  spec: SignedTsWebhookSpec,
  params: { headers: Record<string, string>; body: string },
  bridge: Base64HmacWebhookBridge,
  nowMs: number,
): Promise<SignedTsWebhookResult> {
  const headers = lowercaseHeaderKeys(params.headers)
  if (!(await bridge.config_has(spec.secretConfigKey)))
    return { ok: false, reason: "missing_secret" }

  const sig = headers[spec.signatureHeader]
  if (!sig || typeof sig !== "string") return { ok: false, reason: "missing_signature" }

  // The host digests the body with the secret and compares in constant time.
  const valid = await bridge.crypto_verifyHmacForConfig(
    spec.secretConfigKey,
    params.body,
    sig,
    "base64",
  )
  if (!valid) return { ok: false, reason: "signature_mismatch" }

  // Freshness bound on the SIGNED `ts`, checked only after the signature holds:
  // an attacker cannot mint a fresh ts without the secret.
  const tsMs = extractSignedTsMs(params.body)
  if (tsMs === null) return { ok: false, reason: "missing_ts" }
  const ttlMs =
    (await freshnessTtlSeconds(bridge, spec.ttlConfigKey, spec.defaultTtlSeconds)) * 1000
  if (nowMs - tsMs > ttlMs) return { ok: false, reason: "stale_ts" }
  if (tsMs - nowMs > ttlMs) return { ok: false, reason: "future_ts" }

  const deliveryId = await bodyDeliveryId(spec.deliveryIdLabel, params.body, bridge)
  return {
    ok: true,
    replayKey: deliveryId,
    replayTtlSeconds: 7 * 24 * 60 * 60,
    ...(spec.scopes ? { scopes: spec.scopes } : {}),
  }
}
