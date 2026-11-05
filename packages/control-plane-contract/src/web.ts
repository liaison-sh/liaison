// SPDX-License-Identifier: FSL-1.1-ALv2
// Web Crypto twins of the contract v2 helpers in `./node.ts`
// (`@liaison/control-plane-contract/web`), for runtimes with `crypto.subtle`
// and no `node:crypto` (an edge Worker). Same inputs, same bytes, async;
// both are proven on `vectors/c2c.json` and `vectors/router-lookup.json`.
// Not re-exported from `./index`: the sandboxed bundle has no `crypto.subtle`.
import {
  assertSignablePath,
  CONTROL_MESSAGE_ID_HEADER,
  CONTROL_SIGNATURE_HEADER,
  CONTROL_TO_CELL_KEY_LABEL,
  CONTROL_TS_HEADER,
  controlCanonicalString,
  controlReplayKey,
  type HeaderSource,
  nowSeconds,
  parseControlHeaders,
  parseRouterHeaders,
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TS_HEADER,
  routerLookupCanonicalString,
  type SignedRequestFailure,
} from "./index"

const encoder = new TextEncoder()

function bytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof value === "string" ? encoder.encode(value) : new Uint8Array(value)
}

function toHex(buf: ArrayBuffer): string {
  let out = ""
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, "0")
  return out
}

function toBase64(buf: ArrayBuffer): string {
  let bin = ""
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin)
}

async function hmac(key: string, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    bytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return crypto.subtle.sign("HMAC", k, bytes(message))
}

/** Constant-time over equal lengths; the lengths themselves are public (fixed 44 chars). */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** `hex(HMAC-SHA256(instanceKey, "liaison-control-to-cell:v1"))`, 64 hex chars (k_c2c). */
export async function deriveControlToCellKey(instanceKey: string): Promise<string> {
  return toHex(await hmac(instanceKey, CONTROL_TO_CELL_KEY_LABEL))
}

/** sha256 hex of the raw body bytes (a string is hashed as UTF-8). */
export async function sha256Hex(rawBody: string | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes(rawBody)))
}

export async function signControlRequest(
  controlKey: string,
  req: {
    method: string
    path: string
    body: string | Uint8Array
    messageId: string
    ts?: number
  },
): Promise<Record<string, string>> {
  assertSignablePath(req.path)
  const ts = String(req.ts ?? nowSeconds())
  const canonical = controlCanonicalString({
    ts,
    messageId: req.messageId,
    method: req.method,
    path: req.path,
    bodySha256: await sha256Hex(req.body),
  })
  return {
    [CONTROL_SIGNATURE_HEADER]: toBase64(await hmac(controlKey, canonical)),
    [CONTROL_TS_HEADER]: ts,
    [CONTROL_MESSAGE_ID_HEADER]: req.messageId,
  }
}

export async function verifyControlRequest(
  controlKey: string,
  req: {
    method: string
    path: string
    body: string | Uint8Array
    headers: HeaderSource
    now?: number
  },
): Promise<
  | { ok: true; ts: string; messageId: string; replayKey: string }
  | { ok: false; reason: SignedRequestFailure }
> {
  const parsed = parseControlHeaders(req.headers, req.now ?? nowSeconds())
  if (!parsed.ok) return parsed
  const canonical = controlCanonicalString({
    ts: parsed.ts,
    messageId: parsed.messageId,
    method: req.method,
    path: req.path,
    bodySha256: await sha256Hex(req.body),
  })
  if (!sameSignature(toBase64(await hmac(controlKey, canonical)), parsed.signature)) {
    return { ok: false, reason: "bad_signature" }
  }
  return {
    ok: true,
    ts: parsed.ts,
    messageId: parsed.messageId,
    replayKey: controlReplayKey(parsed.messageId, parsed.ts),
  }
}

export async function signRouterLookup(
  routerSecret: string,
  slug: string,
  ts: number = nowSeconds(),
): Promise<Record<string, string>> {
  const t = String(ts)
  return {
    [ROUTER_TS_HEADER]: t,
    [ROUTER_SIGNATURE_HEADER]: toBase64(
      await hmac(routerSecret, routerLookupCanonicalString(t, slug)),
    ),
  }
}

export async function verifyRouterLookup(
  routerSecret: string,
  req: { slug: string; headers: HeaderSource; now?: number },
): Promise<{ ok: true } | { ok: false; reason: SignedRequestFailure }> {
  const parsed = parseRouterHeaders(req.headers, req.slug, req.now ?? nowSeconds())
  if (!parsed.ok) return parsed
  const expected = toBase64(
    await hmac(routerSecret, routerLookupCanonicalString(parsed.ts, req.slug)),
  )
  return sameSignature(expected, parsed.signature)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" }
}
