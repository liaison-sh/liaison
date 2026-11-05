// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { humanizeToolName, splitToolName } from "~/modules/approvals/event-data"

describe("splitToolName", () => {
  it("splits app and short name on the first colon", () => {
    expect(splitToolName("invoicing:documents_mark_paid")).toEqual({
      appName: "invoicing",
      toolShortName: "documents_mark_paid",
    })
  })

  it("returns the whole string as app name when there is no colon", () => {
    expect(splitToolName("standalone")).toEqual({ appName: "standalone", toolShortName: "" })
  })
})

describe("humanizeToolName", () => {
  // Regression B3: a pending-approval tile once titled itself with the raw tool
  // id "invoicing:documents_mark_paid". The humanizer turns it into a readable
  // action label with no raw ids and no dash punctuation.
  it("turns entity_verb tool ids into an imperative action label", () => {
    expect(humanizeToolName("invoicing:documents_mark_paid")).toBe("Invoicing: mark document paid")
  })

  it("handles create/issue style ids (verb moves to the front)", () => {
    expect(humanizeToolName("invoicing:invoice_create_and_issue")).toBe(
      "Invoicing: create invoice and issue",
    )
    expect(humanizeToolName("shopify:orders_cancel")).toBe("Shopify: cancel order")
  })

  it("keeps a verb-first id in order", () => {
    expect(humanizeToolName("tickets:reply")).toBe("Tickets: reply")
    // An -us noun is already singular: "status" must not become "statu".
    expect(humanizeToolName("projects:status_update")).toBe("Projects: update status")
    expect(humanizeToolName("projects:status_add")).toBe("Projects: status add")
    expect(humanizeToolName("mail:send_message")).toBe("Mail: send message")
  })

  it("title-cases the app name alone when there is no action segment", () => {
    expect(humanizeToolName("invoicing")).toBe("Invoicing")
  })

  it("never emits a raw colon-joined tool id", () => {
    const out = humanizeToolName("boxtal:shipment_create")
    expect(out).not.toContain("boxtal:")
    expect(out).toBe("Boxtal: create shipment")
  })

  it("names the kernel's own actions after the Workspace, never 'Kernel'", () => {
    // A reviewer read "Kernel: update skill" on an approval card (iPhone walk,
    // 2026-10-19): the kernel app's display name is "Workspace".
    expect(humanizeToolName("kernel:update_skill")).toBe("Workspace: update skill")
    expect(humanizeToolName("kernel:contacts_merge")).toBe("Workspace: contacts merge")
    expect(humanizeToolName("kernel")).toBe("Workspace")
  })
})
