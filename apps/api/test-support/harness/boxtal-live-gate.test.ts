// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M0.3 — the live-mode gate decision. `index.e2e.ts` installs the Boxtal
// sandbox-fetch mock IFF this returns true. BOXTAL_E2E_LIVE=1 → false (go live).
import { describe, expect, it } from "bun:test"
import { shouldInstallBoxtalMock } from "./boxtal-mock-fetch"

describe("M0.3 Boxtal live-mode gate", () => {
  it("installs the mock by default (gate unset)", () => {
    expect(shouldInstallBoxtalMock({})).toBe(true)
    expect(shouldInstallBoxtalMock({ BOXTAL_E2E_LIVE: undefined })).toBe(true)
    expect(shouldInstallBoxtalMock({ BOXTAL_E2E_LIVE: "" })).toBe(true)
    expect(shouldInstallBoxtalMock({ BOXTAL_E2E_LIVE: "0" })).toBe(true)
    expect(shouldInstallBoxtalMock({ BOXTAL_E2E_LIVE: "false" })).toBe(true)
  })

  it("skips the mock (goes live) only on the exact opt-in '1'", () => {
    expect(shouldInstallBoxtalMock({ BOXTAL_E2E_LIVE: "1" })).toBe(false)
  })
})
