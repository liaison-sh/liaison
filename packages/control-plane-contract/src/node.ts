// SPDX-License-Identifier: FSL-1.1-ALv2
// Node-only helpers of the control plane contract (`node:crypto`). The
// instance signs with these; the control plane side reproduces the same bytes
// with its sandbox bridge or a pure-JS HMAC, proven on `contractVectors.signing`.
import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import {
  assertSignablePath,
  CONTROL_MESSAGE_ID_HEADER,
  CONTROL_SIGNATURE_HEADER,
  CONTROL_TO_CELL_KEY_LABEL,
  CONTROL_TS_HEADER,
  canonicalJson,
  controlCanonicalString,
  controlReplayKey,
  type HeaderSource,
  INSTANCE_KEY_LABEL,
  nowSeconds,
  parseControlHeaders,
  parseRouterHeaders,
  ROUTER_SIGNATURE_HEADER,
  ROUTER_TS_HEADER,
  routerLookupCanonicalString,
  type SignedRequestFailure,
} from "./index"

/** `hex(HMAC-SHA256(masterSecret, "liaison-instance-key:v1:" + instanceId))`, 64 hex chars. */
export function deriveInstanceKey(masterSecret: string, instanceId: string): string {
  return createHmac("sha256", masterSecret)
    .update(INSTANCE_KEY_LABEL + instanceId)
    .digest("hex")
}

/**
 * The `x-liaison-signature` value: base64 HMAC-SHA256 keyed by the instance key
 * (its hex string as UTF-8) over the raw request body bytes.
 */
export function signBody(instanceKey: string, rawBody: string | Uint8Array): string {
  return createHmac("sha256", instanceKey).update(rawBody).digest("base64")
}

/** sha256 hex of `canonicalJson(value)`: key order never changes it. */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

// ── Contract v2: Control→cell requests and the router host lookup ────────────

/** `hex(HMAC-SHA256(instanceKey, "liaison-control-to-cell:v1"))`, 64 hex chars (k_c2c). */
export function deriveControlToCellKey(instanceKey: string): string {
  return createHmac("sha256", instanceKey).update(CONTROL_TO_CELL_KEY_LABEL).digest("hex")
}

/** sha256 hex of the raw body bytes (a string is hashed as UTF-8). */
export function sha256Hex(rawBody: string | Uint8Array): string {
  return createHash("sha256").update(rawBody).digest("hex")
}

function hmacBase64(key: string, message: string): string {
  return createHmac("sha256", key).update(message).digest("base64")
}

function sameSignature(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8")
  const y = Buffer.from(b, "utf8")
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface ControlRequestToSign {
  method: string
  /** The cell-side pathname, e.g. `/api/cloud/orgs/<id>/handoff`; no query or fragment. */
  path: string
  /** The exact bytes sent as the body ("" for none). */
  body: string | Uint8Array
  /** UUID; reuse it on a retry. */
  messageId: string
  /** Unix seconds; defaults to now. */
  ts?: number
}

/** The three `x-control-*` headers for one attempt, keyed by `controlKey` (k_c2c hex). */
export function signControlRequest(
  controlKey: string,
  req: ControlRequestToSign,
): Record<string, string> {
  assertSignablePath(req.path)
  const ts = String(req.ts ?? nowSeconds())
  const canonical = controlCanonicalString({
    ts,
    messageId: req.messageId,
    method: req.method,
    path: req.path,
    bodySha256: sha256Hex(req.body),
  })
  return {
    [CONTROL_SIGNATURE_HEADER]: hmacBase64(controlKey, canonical),
    [CONTROL_TS_HEADER]: ts,
    [CONTROL_MESSAGE_ID_HEADER]: req.messageId,
  }
}

export interface ControlRequestToVerify {
  method: string
  path: string
  body: string | Uint8Array
  headers: HeaderSource
  /** Unix seconds; defaults to now. */
  now?: number
}

export type ControlVerification =
  | { ok: true; ts: string; messageId: string; replayKey: string }
  | { ok: false; reason: SignedRequestFailure }

/** Checks headers, the ±300 s window and the signature. The replay check is the caller's. */
export function verifyControlRequest(
  controlKey: string,
  req: ControlRequestToVerify,
): ControlVerification {
  const parsed = parseControlHeaders(req.headers, req.now ?? nowSeconds())
  if (!parsed.ok) return parsed
  const canonical = controlCanonicalString({
    ts: parsed.ts,
    messageId: parsed.messageId,
    method: req.method,
    path: req.path,
    bodySha256: sha256Hex(req.body),
  })
  if (!sameSignature(hmacBase64(controlKey, canonical), parsed.signature)) {
    return { ok: false, reason: "bad_signature" }
  }
  return {
    ok: true,
    ts: parsed.ts,
    messageId: parsed.messageId,
    replayKey: controlReplayKey(parsed.messageId, parsed.ts),
  }
}

/** The `x-router-*` headers of a host lookup for `slug` (ts defaults to now). */
export function signRouterLookup(
  routerSecret: string,
  slug: string,
  ts: number = nowSeconds(),
): Record<string, string> {
  const t = String(ts)
  return {
    [ROUTER_TS_HEADER]: t,
    [ROUTER_SIGNATURE_HEADER]: hmacBase64(routerSecret, routerLookupCanonicalString(t, slug)),
  }
}

export type RouterLookupVerification = { ok: true } | { ok: false; reason: SignedRequestFailure }

/** Checks the headers, the slug, the ±60 s window and the signature. */
export function verifyRouterLookup(
  routerSecret: string,
  req: { slug: string; headers: HeaderSource; now?: number },
): RouterLookupVerification {
  const parsed = parseRouterHeaders(req.headers, req.slug, req.now ?? nowSeconds())
  if (!parsed.ok) return parsed
  const expected = hmacBase64(routerSecret, routerLookupCanonicalString(parsed.ts, req.slug))
  return sameSignature(expected, parsed.signature)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" }
}
