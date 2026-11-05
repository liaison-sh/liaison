// SPDX-License-Identifier: FSL-1.1-ALv2
//
// InvoicingEditor route wiring — bundled-app suites use bun:test (no jsdom),
// so the rendered <Editor> shell is exercised via Playwright (G6); here we
// pin the two testable, non-JSX surfaces this task added:
//   - mapDocumentToDraft(): maps a `documents_get` document + lines into the
//     Editor's DraftDocument shape, reusing documents_get's exact field
//     names (position/description/quantity/unit_price_minor(STRING)/
//     tax_rate_bp/hs_code/country_of_origin/customs_description).
//   - loadEditorDocument(): the real `documents_get` load, driven against
//     the same globalThis.__liaisonHost harness ContactDocumentsPanel.test.tsx
//     uses, including the not-found and {status:"error"} failure paths.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import manifest from "../../app.manifest.json"
import * as uiIndex from "./index"
import {
  isNewDocumentEntityId,
  loadEditorDocument,
  mapDocumentToDraft,
  parseDocTypeFromEntityId,
} from "./index"
import type { DocumentLine, DocumentSummary } from "./DocumentDetail"

const source = readFileSync(join(import.meta.dir, "index.tsx"), "utf-8")

const baseDoc: DocumentSummary = {
  id: "doc-1",
  type: "invoice",
  status: "draft",
  number: null,
  currency: "EUR",
  subtotal_minor: "10000",
  tax_total_minor: "2000",
  grand_total_minor: "12000",
  tax_treatment: "domestic",
  incoterm: "DAP",
  issued_at: "2026-06-01",
  due_at: "2026-07-01",
  counterparty_contact_id: "contact-1",
  issuer_profile_id: "issuer-1",
}

const line: DocumentLine = {
  id: "line-1",
  position: 1,
  description: "Fabrikam field recorder",
  quantity: "2",
  unit_price_minor: "45000",
  tax_rate_bp: 2000,
  subtotal_minor: "90000",
  tax_minor: "18000",
  total_minor: "108000",
  hs_code: "851981",
  country_of_origin: "FR",
  customs_description: "Audio recorder",
}

describe("mapDocumentToDraft (Phase 17 — reopen an existing draft for edit)", () => {
  it("carries header fields through with documents_get's exact names", () => {
    const draft = mapDocumentToDraft(baseDoc, [])
    expect(draft.id).toBe("doc-1")
    expect(draft.type).toBe("invoice")
    expect(draft.status).toBe("draft")
    expect(draft.currency).toBe("EUR")
    expect(draft.incoterm).toBe("DAP")
    expect(draft.issuer_profile_id).toBe("issuer-1")
    expect(draft.counterparty_contact_id).toBe("contact-1")
    expect(draft.issued_at).toBe("2026-06-01")
    expect(draft.due_at).toBe("2026-07-01")
    expect(draft.tax_treatment).toBe("domestic")
  })

  it("maps lines reusing documents_get's line field names exactly", () => {
    const draft = mapDocumentToDraft(baseDoc, [line])
    expect(draft.lines).toHaveLength(1)
    const l = draft.lines[0]
    expect(l).toBeDefined()
    if (!l) throw new Error("unreachable")
    expect(l.position).toBe(1)
    expect(l.description).toBe("Fabrikam field recorder")
    expect(l.quantity).toBe("2")
    expect(l.unit_price_minor).toBe("45000")
    expect(l.tax_rate_bp).toBe(2000)
    expect(l.hs_code).toBe("851981")
    expect(l.country_of_origin).toBe("FR")
    expect(l.customs_description).toBe("Audio recorder")
  })

  it("falls back to defaultDraft's single blank line when the document has none", () => {
    const draft = mapDocumentToDraft(baseDoc, [])
    expect(draft.lines).toHaveLength(1)
    expect(draft.lines[0]?.description).toBe("")
  })

  it("maps non-draft statuses through unchanged (Editor's readOnly() renders the banner)", () => {
    const issued = mapDocumentToDraft({ ...baseDoc, status: "issued" }, [line])
    expect(issued.status).toBe("issued")
  })

  it("coerces a numeric unit_price_minor to a string (defensive against wire-shape drift)", () => {
    const numericLine = { ...line, unit_price_minor: 45000 } as unknown as DocumentLine
    const draft = mapDocumentToDraft(baseDoc, [numericLine])
    expect(draft.lines[0]?.unit_price_minor).toBe("45000")
    expect(typeof draft.lines[0]?.unit_price_minor).toBe("string")
  })
})

describe("loadEditorDocument (real @liaison/host documents_get, no jsdom)", () => {
  beforeEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: test-bound app name for the @liaison/host `app` namespace.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "invoicing"
  })

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: clear the global host slot.
    ;(globalThis as any).__liaisonHost = undefined
    // biome-ignore lint/suspicious/noExplicitAny: clear the bound app name.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
  })

  it("resolves { document, lines } from documents_get's flat shape", async () => {
    const host = {
      invokeTool: async (_appName: string, toolName: string) => {
        if (toolName === "documents_get") return { ...baseDoc, lines: [line] }
        throw new Error(`unexpected tool: ${toolName}`)
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = host
    const loaded = await loadEditorDocument("doc-1")
    expect(loaded.document.id).toBe("doc-1")
    expect(loaded.lines).toHaveLength(1)
  })

  it("throws when documents_get resolves null (not found)", async () => {
    const host = { invokeTool: async () => null }
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = host
    await expect(loadEditorDocument("missing")).rejects.toThrow(/document not found/)
  })

  it("throws with the tool's message when documents_get returns a {status:'error'} payload", async () => {
    const host = {
      invokeTool: async () => ({
        status: "error" as const,
        error: { code: "not_found", message: "Document not found or access denied." },
      }),
    }
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = host
    await expect(loadEditorDocument("doc-1")).rejects.toThrow("Document not found or access denied.")
  })
})

describe("InvoicingEditor source wiring", () => {
  it("accepts an entityId prop and treats missing/'new'/'new:<type>' as a brand-new document", () => {
    expect(source).toContain("entityId?: string")
    expect(source).toContain("isNewDocumentEntityId(props.entityId)")
  })

  it("loads an existing document via documents_get and passes documentId through to Editor", () => {
    expect(source).toContain("loadEditorDocument")
    expect(source).toContain("documents_get")
    expect(source).toContain("documentId={props.entityId}")
  })

  it("renders an inline error surface on load failure", () => {
    expect(source).toContain("invoicing-editor-load-error")
  })

  it("does NOT read window.location.search for the new-document type (C3 wrong-tab-URL fix)", () => {
    // The type is now parsed from entityId (parseDocTypeFromEntityId) — the
    // old `new URLSearchParams(window.location.search).get("type")` read is
    // gone entirely, since query params never reach a tab's component.
    expect(source).not.toContain("URLSearchParams(window.location.search)")
    expect(source).toContain("parseDocTypeFromEntityId(props.entityId)")
  })
})

describe("isNewDocumentEntityId", () => {
  it("is true for undefined, bare 'new', and the type-encoded 'new:<type>' form", () => {
    expect(isNewDocumentEntityId(undefined)).toBe(true)
    expect(isNewDocumentEntityId("new")).toBe(true)
    expect(isNewDocumentEntityId("new:quote")).toBe(true)
    expect(isNewDocumentEntityId("new:proforma")).toBe(true)
    expect(isNewDocumentEntityId("new:purchase_order")).toBe(true)
  })

  it("is false for a real document id", () => {
    expect(isNewDocumentEntityId("doc-123")).toBe(false)
  })
})

describe("parseDocTypeFromEntityId", () => {
  it("defaults to quote for undefined / bare 'new' / a real document id", () => {
    expect(parseDocTypeFromEntityId(undefined)).toBe("quote")
    expect(parseDocTypeFromEntityId("new")).toBe("quote")
    expect(parseDocTypeFromEntityId("doc-123")).toBe("quote")
  })

  it("parses quote / proforma / purchase_order out of the entityId segment", () => {
    expect(parseDocTypeFromEntityId("new:quote")).toBe("quote")
    expect(parseDocTypeFromEntityId("new:proforma")).toBe("proforma")
    expect(parseDocTypeFromEntityId("new:purchase_order")).toBe("purchase_order")
  })

  it("no longer parses invoice or credit_note as new-document types", () => {
    // Invoices come from orders or from converting a quote/proforma, credit
    // notes come from refunds: neither can be started by hand any more, so
    // both fall back to the quote editor.
    expect(parseDocTypeFromEntityId("new:invoice")).toBe("quote")
    expect(parseDocTypeFromEntityId("new:credit_note")).toBe("quote")
    expect(parseDocTypeFromEntityId("new:bogus")).toBe("quote")
  })
})

describe("e-invoicing tabs and fields", () => {
  it("mapDocumentToDraft carries the draft's customer type, operation type and billing", () => {
    const draft = mapDocumentToDraft(
      {
        ...baseDoc,
        customer_kind: "business",
        operation_category: "services",
        billing_line1: "1 rue Imaginaire",
        billing_postcode: "75001",
        billing_city: "Paris",
        billing_country_code: "FR",
      },
      [],
    )
    expect(draft.customer_kind).toBe("business")
    expect(draft.operation_category).toBe("services")
    expect(draft.billing_line1).toBe("1 rue Imaginaire")
    expect(draft.billing_postcode).toBe("75001")
    expect(draft.billing_city).toBe("Paris")
    expect(draft.billing_country_code).toBe("FR")
    const bare = mapDocumentToDraft(baseDoc, [])
    expect(bare.customer_kind).toBeNull()
    expect(bare.operation_category).toBeNull()
  })

  it("the identity and readiness tabs are declared once, as tabs, and exported", () => {
    const tabTypes = (manifest as unknown as {
      views: { tabTypes: Record<string, { component: string; urlPattern: string; singleton: boolean }> }
    }).views.tabTypes
    expect(tabTypes.identity).toMatchObject({
      component: "InvoicingIdentity",
      urlPattern: "/invoicing/identity/:contactId",
      singleton: false,
    })
    expect(tabTypes.readiness).toMatchObject({
      component: "InvoicingReadiness",
      urlPattern: "/invoicing/readiness",
      singleton: true,
    })
    for (const def of Object.values(tabTypes)) {
      expect(typeof (uiIndex as Record<string, unknown>)[def.component]).toBe("function")
    }
  })
})
