// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { APPROVING_WEDGE_GRACE_MS, isApprovingWedged } from "./wedge-grace"

describe("isApprovingWedged: the one grace window the server and the card share", () => {
  const now = Date.parse("2026-10-08T12:00:00Z")

  it("is false inside the window and true past it", () => {
    expect(isApprovingWedged(now - APPROVING_WEDGE_GRACE_MS + 1_000, now)).toBe(false)
    expect(isApprovingWedged(now - APPROVING_WEDGE_GRACE_MS - 1_000, now)).toBe(true)
  })

  it("outlasts the longest tool budget the sandbox allows (120 s)", () => {
    expect(isApprovingWedged(now - 120_000, now)).toBe(false)
  })

  it("treats an unknown claim time as wedged", () => {
    expect(isApprovingWedged(Number.NaN, now)).toBe(true)
  })
})
