// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Request signing between this cell and the app loader (the Workers executor's
// wire protocol), both directions, one HMAC key per cell (LIAISON_APP_LOADER_KEY).
//
//   x-cell-id                the cell's id, the loader's key into its cell table
//   x-cell-ts                unix milliseconds, as a decimal string
//   x-cell-signature-version "2"
//   x-cell-signature         base64(HMAC-SHA256(cellKey, canonical))
//
// v2 canonical (both directions):
//
//   liaison-v2\n<direction>\n<METHOD>\n<path>\n<ts>\n<sha256hex(body)>
//
// direction "cell->loader" for the cell's POST /run, "loader->cell" for the
// loader's GET /api/app-bridge/bundles/<sha256> (bundle-route.ts); <path> is
// the URL's pathname (no query). A signature therefore holds for one
// direction, one method, one path and one body: a captured /run signature is
// no bundle GET, and a bundle GET for one sha is none for another.
//
// v1 (legacy, no version header): base64(HMAC-SHA256(cellKey, "<ts>.<sha256hex(body)>")).
// The loader still accepts it on /run during the transition (this cell sends
// v2 only); it goes once every cell runs a release that signs v2. The cell
// never accepts v1.
//
// Either side accepts a timestamp within ±60 s of its own clock. The same
// vectors (__fixtures__/sign-vectors.json) prove this signer and the loader's
// verifier; the verifiers here are the loader's checks (the test loader uses
// them) and the cell's own check of the bundle GET.

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

export const CELL_ID_HEADER = "x-cell-id"
export const CELL_TS_HEADER = "x-cell-ts"
export const CELL_SIGNATURE_HEADER = "x-cell-signature"
export const CELL_SIGNATURE_VERSION_HEADER = "x-cell-signature-version"
export const CELL_SIGNATURE_VERSION = "2"
export const CELL_SIGNATURE_SKEW_MS = 60_000

export type SignDirection = "cell->loader" | "loader->cell"

type Bytes = string | Uint8Array

export function sha256Hex(body: Bytes): string {
  return createHash("sha256").update(body).digest("hex")
}

/** The v2 string both sides sign. */
export function canonicalV2(
  direction: SignDirection,
  method: string,
  path: string,
  ts: string,
  bodySha256: string,
): string {
  return `liaison-v2\n${direction}\n${method.toUpperCase()}\n${path}\n${ts}\n${bodySha256}`
}

function hmac(cellKey: string, canonical: string): Buffer {
  return createHmac("sha256", cellKey).update(canonical, "utf8").digest()
}

export interface SignV2Input {
  cellId: string
  cellKey: string
  direction: SignDirection
  method: string
  /** The request URL's pathname. */
  path: string
  body: Bytes
  ts?: number
}

/** The four signing headers (v2) for one request. */
export function signCellRequestV2(input: SignV2Input): Record<string, string> {
  const t = String(input.ts ?? Date.now())
  const canonical = canonicalV2(input.direction, input.method, input.path, t, sha256Hex(input.body))
  return {
    [CELL_ID_HEADER]: input.cellId,
    [CELL_TS_HEADER]: t,
    [CELL_SIGNATURE_VERSION_HEADER]: CELL_SIGNATURE_VERSION,
    [CELL_SIGNATURE_HEADER]: hmac(input.cellKey, canonical).toString("base64"),
  }
}

export type CellVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "bad_ts" | "skew" | "bad_version" | "bad_signature" }

function checkTsAndSig(
  ts: string | null | undefined,
  sig: string | null | undefined,
  now: number,
): CellVerifyResult | Buffer {
  if (!ts || !sig) return { ok: false, reason: "missing" }
  if (!/^\d{1,16}$/.test(ts)) return { ok: false, reason: "bad_ts" }
  if (Math.abs(now - Number(ts)) > CELL_SIGNATURE_SKEW_MS) return { ok: false, reason: "skew" }
  const presented = Buffer.from(sig, "base64")
  if (presented.length !== 32) return { ok: false, reason: "bad_signature" }
  return presented
}

export interface VerifyV2Input {
  cellKey: string
  direction: SignDirection
  method: string
  path: string
  ts: string | null | undefined
  signature: string | null | undefined
  /** The x-cell-signature-version header as received. */
  version: string | null | undefined
  body: Bytes
  now?: number
}

/** A v2 check: version marker, timestamp shape, skew window, constant-time HMAC compare. */
export function verifyCellRequestV2(input: VerifyV2Input): CellVerifyResult {
  if (input.version !== CELL_SIGNATURE_VERSION) {
    return input.version ? { ok: false, reason: "bad_version" } : { ok: false, reason: "missing" }
  }
  const presented = checkTsAndSig(input.ts, input.signature, input.now ?? Date.now())
  if (!Buffer.isBuffer(presented)) return presented
  const expected = hmac(
    input.cellKey,
    canonicalV2(
      input.direction,
      input.method,
      input.path,
      input.ts as string,
      sha256Hex(input.body),
    ),
  )
  return timingSafeEqual(presented, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" }
}

// ── v1 (legacy) ──────────────────────────────────────────────────────────────

/** @legacy v1 headers for one /run body (the vectors keep proving the loader's v1 check). */
export function signCellRequestV1(
  cellId: string,
  cellKey: string,
  body: Bytes,
  ts: number = Date.now(),
): Record<string, string> {
  const t = String(ts)
  return {
    [CELL_ID_HEADER]: cellId,
    [CELL_TS_HEADER]: t,
    [CELL_SIGNATURE_HEADER]: hmac(cellKey, `${t}.${sha256Hex(body)}`).toString("base64"),
  }
}

/** @legacy the loader's v1 check of /run (accepted during the transition only). */
export function verifyCellRequestV1(
  cellKey: string,
  ts: string | null | undefined,
  sig: string | null | undefined,
  body: Bytes,
  now: number = Date.now(),
): CellVerifyResult {
  const presented = checkTsAndSig(ts, sig, now)
  if (!Buffer.isBuffer(presented)) return presented
  const expected = hmac(cellKey, `${ts}.${sha256Hex(body)}`)
  return timingSafeEqual(presented, expected)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" }
}
