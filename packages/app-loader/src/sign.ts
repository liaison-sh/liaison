// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Request signing between a cell (a Liaison instance) and an app loader, both
// directions, one HMAC key per cell. WebCrypto only, so it runs in a Worker,
// in workerd and in Bun alike.
//
//   x-cell-id                the cell's id, the loader's key into its cell table
//   x-cell-ts                unix milliseconds, as a decimal string
//   x-cell-signature-version "2"
//   x-cell-signature         base64(HMAC-SHA256(cellKey, canonical))
//
// canonical: "liaison-v2\n<direction>\n<METHOD>\n<path>\n<ts>\n<sha256hex(body)>"
//   direction "cell->loader" for the cell's POST /run (and any signed GET the
//   loader serves, path WITH its query), "loader->cell" for the loader's GET
//   <bridgeOrigin>/api/app-bridge/bundles/<sha256>.
// The legacy v1 form ("<ts>.<sha256hex(body)>", no version header) is refused;
// its entries stay in test/sign-vectors.json only to prove the refusal. Skew
// window ±60 s. The cell's own signer (apps/api workers/sign.ts) is proven on
// the same vectors.

export const CELL_ID_HEADER = "x-cell-id"
export const CELL_TS_HEADER = "x-cell-ts"
export const CELL_SIGNATURE_HEADER = "x-cell-signature"
export const CELL_SIGNATURE_VERSION_HEADER = "x-cell-signature-version"
export const CELL_SIGNATURE_VERSION = "2"
export type SignDirection = "cell->loader" | "loader->cell"
export const SKEW_MS = 60_000

const encoder = new TextEncoder()

type Bytes = string | ArrayBuffer | Uint8Array

function toBytes(b: Bytes): Uint8Array<ArrayBuffer> {
  if (typeof b === "string") return encoder.encode(b)
  // A view over a shared or foreign buffer is copied: WebCrypto takes ArrayBuffer-backed bytes.
  return b instanceof Uint8Array ? Uint8Array.from(b) : new Uint8Array(b)
}

export function hex(buf: ArrayBuffer | Uint8Array): string {
  let s = ""
  for (const b of buf instanceof Uint8Array ? buf : new Uint8Array(buf))
    s += b.toString(16).padStart(2, "0")
  return s
}

export async function sha256Hex(body: Bytes): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", toBytes(body)))
}

async function hmacKey(key: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  )
}

function b64(buf: ArrayBuffer): string {
  let bin = ""
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin)
}

function unb64(s: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "bad_ts" | "skew" | "bad_version" | "bad_signature" }

// ── v2 ──────────────────────────────────────────────────────────────────────

export function canonicalV2(
  direction: SignDirection,
  method: string,
  path: string,
  ts: string,
  bodySha256Hex: string,
): string {
  return `liaison-v2\n${direction}\n${method.toUpperCase()}\n${path}\n${ts}\n${bodySha256Hex}`
}

export async function signCellRequestV2(i: {
  cellId: string
  cellKey: string
  direction: SignDirection
  method: string
  path: string
  body: Bytes
  ts?: number
}): Promise<Record<string, string>> {
  const t = String(i.ts ?? Date.now())
  const c = canonicalV2(i.direction, i.method, i.path, t, await sha256Hex(i.body))
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(i.cellKey, "sign"), encoder.encode(c))
  return {
    [CELL_ID_HEADER]: i.cellId,
    [CELL_TS_HEADER]: t,
    [CELL_SIGNATURE_VERSION_HEADER]: CELL_SIGNATURE_VERSION,
    [CELL_SIGNATURE_HEADER]: b64(sig),
  }
}

export async function verifyCellRequestV2(i: {
  cellKey: string
  direction: SignDirection
  method: string
  path: string
  ts: string | null
  signature: string | null
  version: string | null
  body: Bytes
  now?: number
}): Promise<VerifyResult> {
  if (i.version !== CELL_SIGNATURE_VERSION)
    return { ok: false, reason: i.version ? "bad_version" : "missing" }
  if (!i.ts || !i.signature) return { ok: false, reason: "missing" }
  if (!/^\d{1,16}$/.test(i.ts)) return { ok: false, reason: "bad_ts" }
  if (Math.abs((i.now ?? Date.now()) - Number(i.ts)) > SKEW_MS) return { ok: false, reason: "skew" }
  const sig = unb64(i.signature)
  if (sig?.length !== 32) return { ok: false, reason: "bad_signature" }
  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(i.cellKey, "verify"),
    sig,
    encoder.encode(canonicalV2(i.direction, i.method, i.path, i.ts, await sha256Hex(i.body))),
  )
  return ok ? { ok: true } : { ok: false, reason: "bad_signature" }
}
