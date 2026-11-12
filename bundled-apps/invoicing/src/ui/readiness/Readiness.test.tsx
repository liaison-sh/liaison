// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The readiness tab lists only blockers, each with exactly one action, and says plainly when
// nothing blocks.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { InvoicingReadiness, READINESS_EMPTY, readinessGroups, readinessRows } from "./Readiness"

const source = readFileSync(join(import.meta.dir, "Readiness.tsx"), "utf-8")

describe("readiness", () => {
  it("empty state explains that nothing blocks", () => {
    expect(readinessRows({ items: [] })).toEqual([])
    expect(readinessRows(null)).toEqual([])
    expect(READINESS_EMPTY).toBe(
      "Nothing blocks e-invoicing: every French business customer has what an e-invoice needs.",
    )
    expect(source).toContain("READINESS_EMPTY")
  })

  it("each blocker gets exactly one action, the tab where it is fixed", () => {
    const rows = readinessRows({
      items: [
        {
          subject: { contact_id: "c-1", label: "Atelier Fictif" },
          blocker_code: "registry_unconfirmed",
          action: { tool: "counterparty_identity_lookup", label: "Look up the SIREN" },
          last_document_date: "2026-10-01",
        },
        {
          subject: { document_id: "d-1", label: "Draft for Studio Imaginaire" },
          blocker_code: "operation_category_missing",
          action: { tool: "drafts_update", label: "Set the operation type" },
          last_document_date: null,
        },
        {
          subject: { contact_id: "c-2", label: "Maison Inventée" },
          blocker_code: "einvoice_needs_review",
          action: { tool: "counterparty_territory_set", label: "Decide the territory" },
          last_document_date: null,
        },
      ],
    })
    expect(rows.map((r) => [r.label, r.action.href])).toEqual([
      ["Atelier Fictif", "/invoicing/identity/c-1"],
      ["Draft for Studio Imaginaire", "/invoicing/editor/d-1"],
      ["Maison Inventée", "/invoicing/identity/c-2"],
    ])
    expect(rows[0]!.blocker).toBe("The SIREN is not confirmed against the business registry.")
    expect(rows[0]!.action.label).toBe("Look up the SIREN")
    for (const r of rows) expect(r.action.href.length).toBeGreaterThan(0)
  })

  it("a customer with two blockers is one card with two lines, each with its own action", () => {
    const rows = readinessRows({
      items: [
        {
          subject: { contact_id: "c-1", label: "Atelier Fictif" },
          blocker_code: "einvoice_data_missing",
          action: { tool: "counterparty_identity_lookup", label: "Look up the SIREN" },
          last_document_date: "2026-10-01",
        },
        {
          subject: { contact_id: "c-2", label: "Maison Inventée" },
          blocker_code: "customer_kind_missing",
          action: { tool: "counterparty_identity_set", label: "Record the customer type" },
          last_document_date: null,
        },
        {
          subject: { contact_id: "c-1", label: "Atelier Fictif" },
          blocker_code: "einvoice_data_missing",
          action: { tool: "drafts_update", label: "Add the billing postcode and city" },
          last_document_date: "2026-10-04",
        },
      ],
    })
    // Two blockers with the same code for one customer stay two rows with distinct keys.
    expect(new Set(rows.map((r) => r.key)).size).toBe(3)
    const groups = readinessGroups(rows)
    expect(groups.map((g) => [g.label, g.rows.length, g.lastDocumentDate])).toEqual([
      ["Atelier Fictif", 2, "2026-10-04"],
      ["Maison Inventée", 1, null],
    ])
    expect(groups[0]!.rows.map((r) => r.action.label)).toEqual([
      "Look up the SIREN",
      "Add the billing postcode and city",
    ])
  })

  it("a blocker with an unknown tool still opens its subject", () => {
    const [row] = readinessRows({
      items: [
        {
          subject: { contact_id: "c-9" },
          blocker_code: "einvoice_data_missing",
          action: { tool: "something_new" },
        },
      ],
    })
    expect(row!.action.href).toBe("/invoicing/identity/c-9")
    expect(row!.label).toBe("Customer (name not recorded)")
    expect(row!.label).not.toContain("c-9")
  })

  it("shows the contact's name, else the stored customer name, never the raw id", () => {
    const items = [
      {
        subject: { contact_id: "c-1", label: "Stored Name" },
        blocker_code: "einvoice_data_missing",
      },
      {
        subject: { contact_id: "c-2", label: "Stored Two" },
        blocker_code: "einvoice_data_missing",
      },
      { subject: { contact_id: "c-3" }, blocker_code: "einvoice_data_missing" },
    ]
    const labels = readinessRows({ items }, new Map([["c-1", "Atelier Fictif"]])).map(
      (r) => r.label,
    )
    expect(labels).toEqual(["Atelier Fictif", "Stored Two", "Customer (name not recorded)"])
    for (const l of labels) expect(l).not.toMatch(/c-\d/)
  })

  it("is a tab, calm, no modal", () => {
    expect(typeof InvoicingReadiness).toBe("function")
    expect(source).toContain("einvoicing_readiness")
    expect(source).toContain('data-testid="invoicing-readiness"')
    expect(source).not.toMatch(/ConfirmDialog|role="dialog"|text-error|bg-error|red-\d/)
  })
})
