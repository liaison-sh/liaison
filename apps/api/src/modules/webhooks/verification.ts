// SPDX-License-Identifier: FSL-1.1-ALv2
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"

const DEFAULT_REPLAY_TTL_SECONDS = 24 * 60 * 60

/** Clamp an HTTP status code into the [400, 599] error range. */
function clampHttpStatus(status: number, defaultStatus: number): number {
  const clamped = Math.trunc(status)
  if (clamped >= 400 && clamped <= 599) return clamped
  return defaultStatus
}
const MIN_REPLAY_TTL_SECONDS = 60
const MAX_REPLAY_TTL_SECONDS = 7 * 24 * 60 * 60

export type WebhookVerificationResult =
  | { valid: true; replayKey: string; replayTtlSeconds?: number; scopes?: string[] }
  | { valid: false; status: number; retryAfterSeconds?: number }
  | { drop: true; status: number }

export type ParsedWebhookOutcome =
  | { kind: "accept"; replayKey: string; replayTtlSeconds?: number; scopes: string[] }
  | { kind: "drop"; status: number }
  | { kind: "reject"; status: number; retryAfterSeconds?: number }

/**
 * The scopes a webhook handler runs with. The verifier is app code, so what it asks
 * for is a request, not a grant: for an installed third-party app each requested
 * scope is kept only if the admin's grant for that app covers it. A first-party app
 * (in-tree, or the image's own catalog artifact) ships in the image and may ask for
 * what it needs. With nothing left the handler gets the app's own namespace, which is
 * what the default has always been.
 */
export function resolveHandlerScopes(
  appName: string,
  requested: string[],
  app: { thirdParty: boolean; grantedScopes: string[] },
): string[] {
  const fallback = [`${appName}:*`]
  if (requested.length === 0) return fallback
  if (!app.thirdParty) return requested
  const kept = requested.filter((s) => isScopeCovered([s], app.grantedScopes))
  return kept.length > 0 ? kept : fallback
}

export function normalizeReplayTtlSeconds(ttl?: number): number {
  const value = Number.isFinite(ttl) ? Math.trunc(ttl as number) : DEFAULT_REPLAY_TTL_SECONDS
  return Math.min(Math.max(value, MIN_REPLAY_TTL_SECONDS), MAX_REPLAY_TTL_SECONDS)
}

export function parseWebhookVerificationResult(result: unknown): ParsedWebhookOutcome | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  // Accept both `{valid: true}` (kernel-internal shape) and `{ok: true}`
  // (manifest-format shape — what bundled-app verifiers return per the
  // hmac.ts contract). Both are equivalent success markers.
  const isAccept = r.valid === true || r.ok === true
  if (isAccept && typeof r.replayKey === "string" && r.replayKey.length > 0) {
    return {
      kind: "accept",
      replayKey: r.replayKey,
      replayTtlSeconds: typeof r.replayTtlSeconds === "number" ? r.replayTtlSeconds : undefined,
      scopes: Array.isArray(r.scopes)
        ? r.scopes.filter((s): s is string => typeof s === "string")
        : [],
    }
  }
  if (r.drop === true && typeof r.status === "number") {
    // `drop` is a silent-acknowledge outcome — the delivery is discarded but the
    // provider is told "received" so it stops retrying. Its status is meant to be
    // a 2xx (typically 200/204), so it must NOT be clamped into the [400,599]
    // error range (that would signal a client error and trigger provider retries).
    // Only the `reject` branch below carries an error status worth clamping.
    return { kind: "drop", status: Math.trunc(r.status) }
  }
  const isReject = r.valid === false || r.ok === false
  if (isReject && typeof r.status === "number") {
    return {
      kind: "reject",
      status: clampHttpStatus(r.status, 400),
      retryAfterSeconds: typeof r.retryAfterSeconds === "number" ? r.retryAfterSeconds : undefined,
    }
  }
  return null
}
