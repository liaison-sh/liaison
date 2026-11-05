// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createSavedViewSchema } from "./saved-views"

describe("createSavedViewSchema", () => {
  it("requires non-empty name and viewId", () => {
    expect(
      createSavedViewSchema.safeParse({
        app: "tickets",
        viewId: "",
        name: "x",
        payload: {},
      }).success,
    ).toBe(false)
    expect(
      createSavedViewSchema.safeParse({
        app: "tickets",
        viewId: "inbox",
        name: "",
        payload: {},
      }).success,
    ).toBe(false)
  })

  it("payload is opaque object", () => {
    const r = createSavedViewSchema.safeParse({
      app: "tickets",
      viewId: "inbox",
      name: "x",
      payload: { anything: 1 },
    })
    expect(r.success).toBe(true)
  })
})
