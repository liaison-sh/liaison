// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cell's signer and verifiers against the loader's shared vectors (an
// independent HMAC implementation produced them; the loader's own tests run
// the same file). v2 both directions; v1 kept as the legacy check.

import { describe, expect, it } from "bun:test"
import vectors from "./__fixtures__/sign-vectors.json"
import {
  CELL_ID_HEADER,
  CELL_SIGNATURE_HEADER,
  CELL_SIGNATURE_SKEW_MS,
  CELL_SIGNATURE_VERSION,
  CELL_SIGNATURE_VERSION_HEADER,
  CELL_TS_HEADER,
  canonicalV2,
  type SignDirection,
  sha256Hex,
  signCellRequestV1,
  signCellRequestV2,
  verifyCellRequestV1,
  verifyCellRequestV2,
} from "./sign"

describe("cell request signing v2 (shared vectors)", () => {
  it("uses the vectors' header names, version marker and skew window", () => {
    expect(CELL_ID_HEADER).toBe(vectors.headers.cellId)
    expect(CELL_TS_HEADER).toBe(vectors.headers.ts)
    expect(CELL_SIGNATURE_HEADER).toBe(vectors.headers.signature)
    expect(CELL_SIGNATURE_VERSION_HEADER).toBe(vectors.v2.versionHeader)
    expect(CELL_SIGNATURE_VERSION).toBe(vectors.v2.version)
    expect(CELL_SIGNATURE_SKEW_MS).toBe(vectors.skewMs)
  })

  for (const v of vectors.v2.sign) {
    it(`signs ${v.direction} ${v.method} ${v.path.slice(0, 32)} exactly as the vector`, () => {
      const direction = v.direction as SignDirection
      expect(sha256Hex(v.body)).toBe(v.bodySha256)
      expect(canonicalV2(direction, v.method, v.path, String(v.ts), v.bodySha256)).toBe(v.canonical)
      const input = {
        cellId: v.cellId,
        cellKey: v.cellKey,
        direction,
        method: v.method,
        path: v.path,
      }
      expect(signCellRequestV2({ ...input, body: v.body, ts: v.ts })).toEqual({
        [CELL_ID_HEADER]: v.cellId,
        [CELL_TS_HEADER]: String(v.ts),
        [CELL_SIGNATURE_VERSION_HEADER]: "2",
        [CELL_SIGNATURE_HEADER]: v.signature,
      })
      const bytes = new TextEncoder().encode(v.body)
      expect(signCellRequestV2({ ...input, body: bytes, ts: v.ts })[CELL_SIGNATURE_HEADER]).toBe(
        v.signature,
      )
    })
  }

  for (const v of vectors.v2.verify) {
    it(`verify v2: ${v.case}`, () => {
      const r = verifyCellRequestV2({
        cellKey: vectors.cellKey,
        direction: v.direction as SignDirection,
        method: v.method,
        path: v.path,
        ts: String(v.ts),
        signature: v.signature,
        version: v.version,
        body: v.body,
        now: v.now,
      })
      if (v.ok) expect(r).toEqual({ ok: true })
      else expect(r).toEqual({ ok: false, reason: (v as { reason: string }).reason as never })
    })
  }
})

describe("cell request signing v1 (legacy vectors)", () => {
  for (const v of vectors.sign) {
    it(`signs ${JSON.stringify(v.body).slice(0, 40)} exactly as the vector`, () => {
      expect(sha256Hex(v.body)).toBe(v.bodySha256)
      expect(signCellRequestV1(v.cellId, v.cellKey, v.body, v.ts)).toEqual({
        [CELL_ID_HEADER]: v.cellId,
        [CELL_TS_HEADER]: String(v.ts),
        [CELL_SIGNATURE_HEADER]: v.signature,
      })
    })
  }

  for (const v of vectors.verify) {
    it(`verify v1: ${v.case}`, () => {
      const r = verifyCellRequestV1(vectors.cellKey, String(v.ts), v.signature, v.body, v.now)
      if (v.ok) expect(r).toEqual({ ok: true })
      else expect(r).toEqual({ ok: false, reason: v.reason as never })
    })
  }

  it("refuses a missing or malformed header", () => {
    expect(verifyCellRequestV1("k".repeat(20), null, "x", "")).toEqual({
      ok: false,
      reason: "missing",
    })
    expect(verifyCellRequestV1("k".repeat(20), "12a", "x", "")).toEqual({
      ok: false,
      reason: "bad_ts",
    })
    expect(verifyCellRequestV1("k".repeat(20), String(Date.now()), "c2hvcnQ=", "")).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })
})
