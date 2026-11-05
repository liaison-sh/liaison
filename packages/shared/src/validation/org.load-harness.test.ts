// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org-settings PATCH can never flag an org for the load harness, nor
// write the demo marker (whose `synthetic` field the harness's start sets):
// only the harness's own signed paths set them. A regression guard: the
// strict settings object refuses both keys. Relative import, as beside it.
import { describe, expect, it } from "bun:test"
import { updateOrgSchema } from "./org"

describe("the org-settings PATCH and the load harness's keys", () => {
  it("refuses settings.loadHarness", () => {
    expect(updateOrgSchema.safeParse({ settings: { loadHarness: true } }).success).toBe(false)
  })

  it("refuses settings.demo (synthetic or not)", () => {
    const demo = {
      variant: "visitor",
      createdAt: "2026-10-30T00:00:00Z",
      expiresAt: null,
      synthetic: true,
    }
    expect(updateOrgSchema.safeParse({ settings: { demo } }).success).toBe(false)
  })

  it("still accepts an ordinary setting", () => {
    expect(updateOrgSchema.safeParse({ settings: { auditRetentionDays: 30 } }).success).toBe(true)
  })
})
