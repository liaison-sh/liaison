// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recorder's error map for a demo visitor dictating on the demo's own
// key: each spend refusal reads as the right line, and the ones the demo shell
// acts on (the email code, the budget page) are announced on the window.
import { afterEach, describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"
import { apiErrorKind, DEMO_REFUSAL_EVENT } from "./useDictation"

describe("dictation error map, demo spend refusals", () => {
  const seen: string[] = []
  const listener = (e: Event) => seen.push((e as CustomEvent<{ code: string }>).detail.code)
  window.addEventListener(DEMO_REFUSAL_EVENT, listener)
  afterEach(() => {
    seen.length = 0
  })

  it("asks for the email code and tells the demo shell", () => {
    expect(apiErrorKind(new ApiError("confirm", 403, "demo_verification_required"))).toBe(
      "demo_verify",
    )
    expect(seen).toEqual(["demo_verification_required"])
  })

  it("reads an exhausted budget as out of credits and tells the demo shell", () => {
    for (const code of ["demo_budget_exhausted", "demo_network_exhausted", "demo_box_exhausted"]) {
      expect(apiErrorKind(new ApiError("out", 402, code))).toBe("credits")
    }
    expect(seen).toEqual(["demo_budget_exhausted", "demo_network_exhausted", "demo_box_exhausted"])
  })

  it("reads load as rate limited and an unavailable demo as failed, without announcing", () => {
    expect(apiErrorKind(new ApiError("busy", 429, "demo_busy"))).toBe("rate_limited")
    expect(apiErrorKind(new ApiError("slow", 429, "demo_rate_limited"))).toBe("rate_limited")
    expect(apiErrorKind(new ApiError("off", 503, "demo_unavailable"))).toBe("failed")
    expect(seen).toEqual([])
  })
})
