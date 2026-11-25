// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A share's approval card names the company and the thing in words, never by their ids.
import { describe, expect, it } from "bun:test"
import { shareCardTitle } from "./tools"

describe("a share's approval card", () => {
  it("names the company and the project by name, never an id", () => {
    expect(
      shareCardTitle({
        open: true,
        kind: "project_hours",
        companyName: "Maison Alpha",
        objectName: "Website",
      }),
    ).toBe('Show the hours of project "Website" on Maison Alpha\'s portal')
    expect(
      shareCardTitle({
        open: false,
        kind: "invoices",
        companyName: "Maison Alpha",
        objectName: null,
      }),
    ).toBe("Hide the invoices on Maison Alpha's portal")
  })

  it("an unreadable company or thing still reads in words", () => {
    const title = shareCardTitle({
      open: true,
      kind: "ticket",
      companyName: null,
      objectName: null,
    })
    expect(title).toBe("Show a ticket on this company's portal")
    expect(title).not.toMatch(/[0-9a-f]{8}-/)
  })
})
