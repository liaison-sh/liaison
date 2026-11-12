// SPDX-License-Identifier: FSL-1.1-ALv2
// Cell <-> loader signing, proven on the shared vectors (the cell's signer runs the same ones).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CELL_ID_HEADER,
  CELL_SIGNATURE_HEADER,
  CELL_SIGNATURE_VERSION,
  CELL_SIGNATURE_VERSION_HEADER,
  CELL_TS_HEADER,
  canonicalV2,
  type SignDirection,
  SKEW_MS,
  sha256Hex,
  signCellRequestV2,
  verifyCellRequestV2,
} from "../src/sign"

const vectors = JSON.parse(
  readFileSync(join(import.meta.dir, "__fixtures__", "sign-vectors.json"), "utf8"),
)

describe("sign vectors v1 (REFUSED since 2026-11-07)", () => {
  test("headers and window match the vectors", () => {
    expect(vectors.headers).toEqual({
      cellId: CELL_ID_HEADER,
      ts: CELL_TS_HEADER,
      signature: CELL_SIGNATURE_HEADER,
    })
    expect(vectors.skewMs).toBe(SKEW_MS)
  })
  for (const v of vectors.sign) {
    test(`v1 signature ${v.signature.slice(0, 12)}… is refused with or without a version header`, async () => {
      const base = {
        cellKey: v.cellKey,
        direction: "cell->loader" as const,
        method: "POST",
        path: "/run",
        ts: String(v.ts),
        signature: v.signature,
        body: new TextEncoder().encode(v.body),
        now: v.ts,
      }
      expect(await verifyCellRequestV2({ ...base, version: null })).toEqual({
        ok: false,
        reason: "missing",
      })
      expect(await verifyCellRequestV2({ ...base, version: "2" })).toEqual({
        ok: false,
        reason: "bad_signature",
      })
    })
  }
})

describe("sign vectors v2 (both directions)", () => {
  test("version marker matches the vectors", () => {
    expect(CELL_SIGNATURE_VERSION_HEADER).toBe(vectors.v2.versionHeader)
    expect(CELL_SIGNATURE_VERSION).toBe(vectors.v2.version)
  })
  for (const v of vectors.v2.sign) {
    test(`sign v2 ${v.direction} ${v.method} ${v.path.slice(0, 28)}`, async () => {
      expect(await sha256Hex(v.body)).toBe(v.bodySha256)
      expect(
        canonicalV2(v.direction as SignDirection, v.method, v.path, String(v.ts), v.bodySha256),
      ).toBe(v.canonical)
      const h = await signCellRequestV2({
        cellId: v.cellId,
        cellKey: v.cellKey,
        direction: v.direction as SignDirection,
        method: v.method,
        path: v.path,
        body: v.body,
        ts: v.ts,
      })
      expect(h).toEqual({
        [CELL_ID_HEADER]: v.cellId,
        [CELL_TS_HEADER]: String(v.ts),
        [CELL_SIGNATURE_VERSION_HEADER]: "2",
        [CELL_SIGNATURE_HEADER]: v.signature,
      })
    })
  }
  for (const v of vectors.v2.verify) {
    test(`verify v2 ${v.case}`, async () => {
      const r = await verifyCellRequestV2({
        cellKey: vectors.cellKey,
        direction: v.direction as SignDirection,
        method: v.method,
        path: v.path,
        ts: String(v.ts),
        signature: v.signature,
        version: v.version,
        body: new TextEncoder().encode(v.body),
        now: v.now,
      })
      expect(r.ok).toBe(v.ok)
      if (!v.ok) expect((r as { reason: string }).reason).toBe(v.reason)
    })
  }
})
