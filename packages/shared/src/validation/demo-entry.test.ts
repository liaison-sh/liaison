// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { demoNeedsSchema } from "../demo/needs"
import { DEMO_ENTRIES, DEMO_ENTRY_NEEDS, DEMO_ENTRY_TEXT_MAX, demoEntrySchema } from "./demo-entry"

describe("the demo door's company question", () => {
  it("preselects the needs agreed for each entry, and none for other", () => {
    expect(DEMO_ENTRY_NEEDS).toEqual({
      products: ["support", "commerce", "knowledge"],
      software: ["support", "dev", "knowledge"],
      expertise: ["projects", "sales", "knowledge"],
      other: [],
    })
  })

  it("preselects a list the signup route accepts", () => {
    for (const entry of DEMO_ENTRIES) {
      if (entry === "other") continue
      expect(demoNeedsSchema.safeParse([...DEMO_ENTRY_NEEDS[entry]]).success).toBe(true)
    }
  })

  it("takes a known id and refuses any other", () => {
    expect(demoEntrySchema.parse({ id: "software" })).toEqual({ id: "software" })
    for (const id of ["crm", "", "PRODUCTS", 3, null, undefined]) {
      expect(demoEntrySchema.safeParse({ id }).success).toBe(false)
    }
  })

  it("keeps free text for other only", () => {
    expect(demoEntrySchema.parse({ id: "other", text: "  A bakery  " })).toEqual({
      id: "other",
      text: "A bakery",
    })
    expect(demoEntrySchema.parse({ id: "products", text: "A bakery" })).toEqual({ id: "products" })
  })

  it("caps the free text at its length", () => {
    const longest = "x".repeat(DEMO_ENTRY_TEXT_MAX)
    expect(demoEntrySchema.parse({ id: "other", text: longest }).text).toBe(longest)
    expect(demoEntrySchema.safeParse({ id: "other", text: `${longest}x` }).success).toBe(false)
  })

  it("flattens control and invisible formatting characters out of the free text", () => {
    expect(demoEntrySchema.parse({ id: "other", text: "line\none\t‮two​\0" })).toEqual({
      id: "other",
      text: "line one two",
    })
  })

  it("drops free text that holds nothing", () => {
    expect(demoEntrySchema.parse({ id: "other", text: " \n​ " })).toEqual({ id: "other" })
  })
})
