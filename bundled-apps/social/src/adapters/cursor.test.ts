// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cursor base64 codec is hand-rolled (no Buffer/btoa) so it survives the
// QuickJS sandbox. These round-trips pin the encode/decode against ASCII +
// UTF-8 (multibyte) JSON payloads — the bug class is a codec that works in Bun
// (Buffer) but throws in-sandbox.
import { describe, expect, test } from "bun:test"
import { packCursor, parseJsonCursor } from "./cursor"

describe("cursor base64 codec (QuickJS-safe)", () => {
  test("packs + parses a compound JSON cursor round-trip", () => {
    const value = { publishedAfter: "2026-05-31T00:00:00Z", pageToken: "CAUQAA" }
    const packed = packCursor(value)
    expect(typeof packed).toBe("string")
    expect(parseJsonCursor(packed)).toEqual(value)
  })

  test("round-trips a UTF-8 (multibyte) payload", () => {
    const value = { note: "café — naïve 日本語 🚀", n: 7 }
    expect(parseJsonCursor(packCursor(value))).toEqual(value)
  })

  test("passes an opaque string cursor through verbatim (not re-encoded)", () => {
    expect(packCursor("AFTER_TOKEN")).toBe("AFTER_TOKEN")
  })

  test("null in → null out; garbage decode → {}", () => {
    expect(packCursor(null)).toBeNull()
    expect(parseJsonCursor(null)).toEqual({})
    expect(parseJsonCursor("not-valid-base64-json!!")).toEqual({})
  })
})
