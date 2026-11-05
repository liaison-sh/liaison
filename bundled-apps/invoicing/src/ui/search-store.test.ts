// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The documents search crosses views through the route (`?q=`) as well as the
// shared signal: framed, the sidebar and the documents list are two frames, two
// copies of this module, and only the route reaches both.
import { describe, expect, it } from "bun:test"
import { documentsSearchTarget, searchInPath } from "./search-store"

describe("the documents search in the route", () => {
  it("reads the search from a path's ?q=, and nothing from a path without it", () => {
    expect(searchInPath("/invoicing/documents/all?q=acme%20sa")).toBe("acme sa")
    expect(searchInPath("/invoicing/documents/all?q=")).toBe("")
    expect(searchInPath("/invoicing/documents/all")).toBeNull()
    expect(searchInPath("/invoicing/documents/all?status=paid")).toBeNull()
  })

  it("searches in the documents list on view, else in all documents", () => {
    expect(documentsSearchTarget("/invoicing/documents/invoice", "acme")).toBe(
      "/invoicing/documents/invoice?q=acme",
    )
    expect(documentsSearchTarget("/invoicing/documents/invoice?q=old", "new one")).toBe(
      "/invoicing/documents/invoice?q=new%20one",
    )
    expect(documentsSearchTarget("/invoicing/readiness", "acme")).toBe(
      "/invoicing/documents/all?q=acme",
    )
    expect(documentsSearchTarget("/invoicing/documents/all?q=x", "")).toBe(
      "/invoicing/documents/all",
    )
  })
})
