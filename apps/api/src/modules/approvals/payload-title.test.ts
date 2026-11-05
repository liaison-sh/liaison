// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The four shapes found on the demo box whose feed rows carried a badge, a
// handle and NO title, because their humanized fallback was byte-identical to
// the badge beside it.
import { describe, expect, test } from "bun:test"
import { approvalActionPhrase, deriveApprovalTitle } from "./payload-title"

describe("deriveApprovalTitle", () => {
  test("kernel:update_skill names the skill, resolved from its id", () => {
    const title = deriveApprovalTitle(
      "kernel:update_skill",
      { id: "11111111-2222-3333-4444-555555555555", body: "# A shipment that is not moving" },
      { skillNamesById: { "11111111-2222-3333-4444-555555555555": "shipment-exception" } },
    )
    expect(title).toBe("Update skill: shipment-exception")
  })

  test("kernel:update_skill falls back to a name carried in the payload", () => {
    expect(deriveApprovalTitle("kernel:update_skill", { name: "refund-policy" })).toBe(
      "Update skill: refund-policy",
    )
  })

  test("kernel:contacts_merge names both sides of the merge", () => {
    expect(
      deriveApprovalTitle("kernel:contacts_merge", {
        primaryContact: "Lena Vos (lena.vos@northfield.example)",
        duplicateContact: "L. Vos (lvos@northfield.example)",
        mergedFields: ["orders", "tickets"],
      }),
    ).toBe(
      "Contacts merge: Lena Vos (lena.vos@northfield.example) and L. Vos (lvos@northfield.example)",
    )
  })

  test("invoicing:documents_record_refund names the document", () => {
    expect(
      deriveApprovalTitle("invoicing:documents_record_refund", {
        documentNumber: "INV-2026-0418",
        amountMinor: 134900,
        currency: "EUR",
      }),
    ).toBe("Record document refund: INV-2026-0418")
  })

  test("shopify:discounts_create names the code customers type", () => {
    expect(
      deriveApprovalTitle("shopify:discounts_create", {
        title: "Autumn teaching rooms",
        code: "TEACHING26",
        percentage: 15,
      }),
    ).toBe("Create discount: TEACHING26")
  })

  test("an unknown tool still finds the first nameable field", () => {
    expect(
      deriveApprovalTitle("tickets:reply", { ticketSubject: "Kestrel 10 will not power on" }),
    ).toBe("Reply: Kestrel 10 will not power on")
  })

  test("a bare uuid is not a name", () => {
    expect(
      deriveApprovalTitle("kernel:update_skill", { id: "11111111-2222-3333-4444-555555555555" }),
    ).toBeNull()
    expect(
      deriveApprovalTitle("projects:update", { name: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    ).toBeNull()
  })

  test("a payload with nothing nameable answers null, so the caller keeps its fallback", () => {
    expect(deriveApprovalTitle("kernel:contacts_merge", { mergedFields: ["orders"] })).toBeNull()
    expect(deriveApprovalTitle("shopify:discounts_create", {})).toBeNull()
    expect(deriveApprovalTitle("shopify:discounts_create", null)).toBeNull()
  })

  test("a multi-line body collapses to one clipped line, never a paragraph", () => {
    const title = deriveApprovalTitle("mail:compose", {
      subject: `A subject\nthat someone wrapped ${"and padded ".repeat(20)}`,
    })
    expect(title?.includes("\n")).toBe(false)
    expect(title?.endsWith("...")).toBe(true)
    expect((title as string).length).toBeLessThanOrEqual("Compose: ".length + 82)
  })

  test("the action phrase drops the app, which the badge already carries", () => {
    expect(approvalActionPhrase("kernel:update_skill")).toBe("Update skill")
    expect(approvalActionPhrase("invoicing:documents_record_refund")).toBe("Record document refund")
    expect(approvalActionPhrase("shopify:discounts_create")).toBe("Create discount")
  })
})
