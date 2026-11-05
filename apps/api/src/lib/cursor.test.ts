// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { decodeKeysetCursor, encodeKeysetCursor } from "~/lib/cursor"

describe("keyset cursor codec", () => {
  it("round-trips an arbitrary payload", () => {
    const payload = { id: "11111111-1111-4111-8111-111111111111", createdAt: 1_700_000_000_000 }
    expect(decodeKeysetCursor(encodeKeysetCursor(payload))).toEqual(payload)
  })

  it("always starts with the keyset: prefix", () => {
    expect(encodeKeysetCursor({ a: 1 })).toMatch(/^keyset:/)
  })

  it("throws invalid_cursor for a string missing the prefix", () => {
    expect(() => decodeKeysetCursor("not-a-cursor")).toThrow("invalid_cursor")
  })

  it("throws invalid_cursor for a prefixed but malformed payload", () => {
    expect(() => decodeKeysetCursor("keyset:not-valid-base64url-json!!!")).toThrow("invalid_cursor")
  })
})
