// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ContactDocumentsPanel F5 tests — bundled-app bun:test (no jsdom).
//
// Pinned:
//   - Component is a Component with optional props.
//   - manifest declares `slots.contact_detail.panels[]` with the
//     ContactDocumentsPanel contribution (id, label, component name,
//     visibility_scope, order).
//   - source emits the right tool calls (search docs for contact, set
//     relationship) and the "+ Create document" CTA.
//   - empty-state copy is present.
//   - relationship editor offers the four enum options.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import manifest from "../../app.manifest.json"
import {
  ContactDocumentsPanel,
  type DocumentRow,
  displayTotal,
  loadPanel,
  RELATIONSHIP_OPTIONS,
} from "./ContactDocumentsPanel"

const source = readFileSync(join(import.meta.dir, "ContactDocumentsPanel.tsx"), "utf-8")

describe("ContactDocumentsPanel (Phase 17 F5)", () => {
  it("exports a Component", () => {
    expect(typeof ContactDocumentsPanel).toBe("function")
  })

  it("RELATIONSHIP_OPTIONS matches the manifest enum (customer/vendor/both/other)", () => {
    expect(RELATIONSHIP_OPTIONS).toEqual(["customer", "vendor", "both", "other"])
  })

  it("manifest declares the contact_detail panel contribution", () => {
    const slots = (manifest as { slots?: Record<string, unknown> }).slots ?? {}
    const cd = (slots as Record<string, unknown>).contact_detail as
      | { panels?: Array<Record<string, unknown>> }
      | undefined
    expect(cd).toBeDefined()
    expect(Array.isArray(cd?.panels)).toBe(true)
    const panel = cd?.panels?.find((p) => p.id === "invoicing-documents")
    expect(panel).toBeDefined()
    expect(panel?.component).toBe("ContactDocumentsPanel")
    expect(panel?.visibility_scope).toBe("invoicing:documents:read")
    expect(typeof panel?.order).toBe("number")
    expect(panel?.label).toBe("Documents")
  })

  it("calls invoicing:documents.search with the contact filter", () => {
    expect(source).toContain("documents_search")
    // The search query must include the contact id parameter.
    expect(source).toMatch(/contact[_ ]?id|contact:/)
  })

  it("calls invoicing:contact_relationships.set when relationship is edited", () => {
    expect(source).toContain("contact_relationships_set")
  })

  it("emits the + Create document CTA", () => {
    expect(source).toContain("+ Create document")
    expect(source).toContain("contact-documents-panel-create")
  })

  it("emits an empty-state copy", () => {
    expect(source).toContain("No documents yet")
  })

  it("renders the relationship-conflict attention surface (manual vs inferred)", () => {
    // spec §10 attention — manual override + inferred mismatch → user-visible badge
    expect(source).toContain("manual vs inferred")
  })

  it("renders testids for each row (E2E pickup)", () => {
    expect(source).toContain("contact-documents-panel-row")
    expect(source).toContain("contact-documents-panel")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Regression: documents_search resolves to a BARE DocumentHeader[] (the route
// wraps it as { data: [...] } and the api-client unwraps `.data`). loadPanel
// must read that bare array — it previously read a non-existent `.items`
// envelope (the settings_* list shape), collapsing the contact's documents to
// empty even when issued invoices existed. Drives the REAL loadPanel against a
// host whose invokeTool returns the real bare-array shape.
// ─────────────────────────────────────────────────────────────────────────
describe("ContactDocumentsPanel loadPanel — reads the bare documents_search array", () => {
  const BARE_ROWS = [
    { id: "d1", type: "invoice", number: "INV-1", status: "issued", counterparty_name: "Acme" },
    { id: "d2", type: "invoice", number: "INV-2", status: "issued", counterparty_name: "Acme" },
    { id: "d3", type: "invoice", number: "INV-3", status: "issued", counterparty_name: "Acme" },
  ]

  beforeEach(() => {
    const host = {
      invokeTool: async (_appName: string, toolName: string) => {
        // documents_search hands back a bare array (NOT { items: [...] }).
        if (toolName === "documents_search") return BARE_ROWS
        if (toolName === "contact_relationships_get") return { item: null }
        throw new Error(`unexpected tool: ${toolName}`)
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = host
    // biome-ignore lint/suspicious/noExplicitAny: test-bound app name for the `app` namespace.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "invoicing"
  })

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: clear the global host slot.
    ;(globalThis as any).__liaisonHost = undefined
    // biome-ignore lint/suspicious/noExplicitAny: clear the bound app name.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
  })

  it("surfaces all rows from a bare-array tool result (was empty when it read .items)", async () => {
    const panel = await loadPanel("contact-x")
    expect(panel.documents.map((d) => d.id)).toEqual(["d1", "d2", "d3"])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Regression: loadPanel used to request `include_lines: true` on the FULL page (up to 100 rows),
// and documents_search's include_lines branch does one extra host round trip PER ROW — so a
// contact with 100 documents and 5 open drafts cost ~100 round trips to derive 5 totals. loadPanel
// now makes a SECOND, narrower documents_search call scoped to `status: "draft"` for the lines,
// and merges those (few) rows over the lines-free full list by id.
// ─────────────────────────────────────────────────────────────────────────
describe("ContactDocumentsPanel loadPanel — requests lines only for draft rows", () => {
  const FULL_PAGE = [
    {
      id: "d1",
      type: "invoice",
      number: "INV-1",
      status: "issued",
      counterparty_name: "Acme",
      grand_total_minor: "5000",
      currency: "EUR",
    },
    {
      id: "d2",
      type: "quote",
      number: null,
      status: "draft",
      counterparty_name: "Acme",
      grand_total_minor: "0",
      currency: "EUR",
    },
    {
      id: "d3",
      type: "invoice",
      number: "INV-3",
      status: "issued",
      counterparty_name: "Acme",
      grand_total_minor: "7000",
      currency: "EUR",
    },
  ]
  const DRAFT_ROWS_WITH_LINES = [
    {
      id: "d2",
      type: "quote",
      number: null,
      status: "draft",
      counterparty_name: "Acme",
      grand_total_minor: "0",
      currency: "EUR",
      lines: [{ quantity: "1", unit_price_minor: "24917", tax_rate_bp: 2000 }],
    },
  ]

  let searchCalls: Array<Record<string, unknown>> = []

  beforeEach(() => {
    searchCalls = []
    const host = {
      invokeTool: async (_appName: string, toolName: string, args: Record<string, unknown>) => {
        if (toolName === "documents_search") {
          searchCalls.push(args)
          return args.status === "draft" ? DRAFT_ROWS_WITH_LINES : FULL_PAGE
        }
        if (toolName === "contact_relationships_get") return { item: null }
        throw new Error(`unexpected tool: ${toolName}`)
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = host
    // biome-ignore lint/suspicious/noExplicitAny: test-bound app name for the `app` namespace.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "invoicing"
  })

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: clear the global host slot.
    ;(globalThis as any).__liaisonHost = undefined
    // biome-ignore lint/suspicious/noExplicitAny: clear the bound app name.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
  })

  it("makes exactly two documents_search calls: the full page without lines, and a draft-only page with lines", async () => {
    await loadPanel("contact-x")
    expect(searchCalls).toHaveLength(2)
    const fullPageCall = searchCalls.find((c) => c.status === undefined)!
    const draftOnlyCall = searchCalls.find((c) => c.status === "draft")!
    expect(fullPageCall).toBeDefined()
    expect(fullPageCall.include_lines).not.toBe(true)
    expect(draftOnlyCall).toBeDefined()
    expect(draftOnlyCall.include_lines).toBe(true)
  })

  it("merges the draft row's lines onto the full-page result, leaving non-draft rows untouched", async () => {
    const panel = await loadPanel("contact-x")
    expect(panel.documents.map((d) => d.id)).toEqual(["d1", "d2", "d3"])
    const draftRow = panel.documents.find((d) => d.id === "d2")!
    expect(draftRow.lines).toEqual(DRAFT_ROWS_WITH_LINES[0]!.lines)
    const issuedRow = panel.documents.find((d) => d.id === "d1")!
    expect(issuedRow.lines).toBeUndefined()
  })

  it("the merged draft row's derived total reflects its lines (299.00), not the raw 0", async () => {
    const panel = await loadPanel("contact-x")
    const draftRow = panel.documents.find((d) => d.id === "d2")!
    expect(displayTotal(draftRow)).toBe("299.00 EUR")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Regression: a draft's grand_total_minor is legitimately 0 — it is only computed at issue
// (mutations.ts insertDraftRow / issue.ts) — so the row showed "0.00" for a draft even when it
// carried real priced lines. displayTotal derives the figure from the lines instead, the way
// EditorSummary's totals panel does for the open Editor.
// ─────────────────────────────────────────────────────────────────────────
describe("displayTotal (draft rows derive their total from lines)", () => {
  const baseRow: DocumentRow = {
    id: "d1",
    type: "invoice",
    status: "draft",
    currency: "EUR",
    grand_total_minor: "0",
  }

  it("derives 299.00 from a draft's net line (24917 subtotal + 4983 VAT), instead of showing 0.00", () => {
    const row: DocumentRow = {
      ...baseRow,
      lines: [{ quantity: "1", unit_price_minor: "24917", tax_rate_bp: 2000 }],
    }
    expect(displayTotal(row)).toBe("299.00 EUR")
  })

  it("falls back to grand_total_minor when the draft has no lines yet", () => {
    expect(displayTotal({ ...baseRow, lines: [] })).toBe("0.00 EUR")
  })

  it("does NOT derive from lines for a non-draft row — grand_total_minor is authoritative post-issue", () => {
    const row: DocumentRow = {
      ...baseRow,
      status: "issued",
      grand_total_minor: "29900",
      // A stale/mismatched lines array must be ignored once the document is issued.
      lines: [{ quantity: "1", unit_price_minor: "1", tax_rate_bp: 2000 }],
    }
    expect(displayTotal(row)).toBe("299.00 EUR")
  })

  it("loadPanel requests include_lines so a draft's lines are available to derive its total", () => {
    expect(source).toContain("include_lines: true")
  })

  it("source renders displayTotal(row) in the table, not the raw grand_total_minor", () => {
    expect(source).toContain("displayTotal(row)")
  })
})
