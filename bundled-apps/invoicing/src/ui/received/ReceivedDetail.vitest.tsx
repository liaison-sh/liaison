// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The received-invoice tab, rendered. Refusing: the reason must be picked from the platform's
// reasons (no default), the confirmation says it only asks for approval, and confirming calls the
// approval REQUEST tool (never the gated action) with exactly the picked reason; the tab then
// says it waits. A refused invoice shows no action, only why. The list's empty state explains
// where invoices come from; a failure to load is never shown as "nothing yet"; the list pages past
// its first page; a reader without the permission to act sees no Refresh / Refuse / Dispute.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
let detail: Record<string, unknown> = {}
let pending: Record<string, unknown> | null = null
// Per-test answers of the other tools.
let getAnswer: (() => unknown) | null = null
let listAnswer: (params: Record<string, unknown>) => unknown = () => ({ status: "ok", items: [], has_more: false, last_refreshed_at: null })
let refreshAnswer: unknown = { status: "ok", refreshed: 1 }

const REASONS = [
  { reason: "duplicate_invoice", afnor_code: "DOUBLON", label_en: "Duplicate invoice", label_fr: "Facture en double" },
  { reason: "incorrect_vat_rate", afnor_code: "TX_TVA_ERR", label_en: "Incorrect VAT rate", label_fr: "Taux de TVA erroné" },
]

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    supplier: { name: "Fournisseur Exemple", siren: "732829320", vat_id: null },
    invoice_number: "FS-1",
    issue_date: "2026-11-03",
    due_date: "2026-12-03",
    currency: "EUR",
    totals: { before_tax: "100.0", tax: "20.0", total: "120.0" },
    file_facts: null,
    totals_mismatch: [],
    parse_status: "parsed",
    status: "received",
    status_code: null,
    status_reason: null,
    payment_linked: false,
    received_at: "2026-11-03T08:00:00Z",
    last_synced_at: "2026-11-03T08:00:00Z",
    files_pending: false,
    ...over,
  }
}

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: () => {},
  fetchBlob: async () => new Blob(["x"]),
  app: {
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      if (tool === "received_einvoices_get") return getAnswer ? getAnswer() : { ...detail, pending_action: pending }
      if (tool === "received_einvoices_refresh") return refreshAnswer
      if (tool === "received_einvoice_action_request") {
        pending = { action: params.action, reason: params.reason, requested_at: new Date().toISOString() }
        return { status: "staged", approval_id: "appr-1", deduped: false }
      }
      if (tool === "received_einvoices_list") return listAnswer(params)
      return { status: "ok" }
    },
  },
}))

const { InvoicingReceivedDetail } = await import("./ReceivedDetail")
const { InvoicingReceived } = await import("./ReceivedList")

/** A tool's error answer (its text is the server's, not the tab's copy). */
const failed = (code: string, text: string) => ({ status: "error", error: { code, message: text } })

function item(i: number) {
  return { id: `r${i}`, supplier_name: `Supplier ${i}`, invoice_number: `FS-${i}`, issue_date: "2026-11-03", due_date: null, total: "10.0", currency: "EUR", status: "received", status_code: null, received_at: "2026-11-03T08:00:00Z" }
}

beforeEach(() => {
  calls.length = 0
  pending = null
  getAnswer = null
  listAnswer = () => ({ status: "ok", items: [], has_more: false, last_refreshed_at: null })
  refreshAnswer = { status: "ok", refreshed: 1 }
  detail = {
    status: "ok",
    invoice: invoice(),
    files: [
      { kind: "original", file_id: "f1", filename: "FS-1.xml", mime_type: "application/xml", byte_size: 10, sha256: "a", url: "/api/files/f1/inline" },
      { kind: "rendering", file_id: "f2", filename: "FS-1.pdf", mime_type: "application/pdf", byte_size: 10, sha256: "b", url: "/api/files/f2/inline" },
    ],
    history: [{ raw: null, mapped: "received", code: null, provider_ts: null, observed_at: "2026-11-03T08:01:00Z", source: "webhook" }],
    actions: [
      { action: "refuse", reasons: REASONS, comment: false },
      { action: "dispute", reasons: REASONS, comment: false },
    ],
  }
})
afterEach(() => cleanup())

describe("received invoice tab (rendered)", () => {
  it("refusing needs a reason picked from the platform's list; nothing is sent before the confirm", async () => {
    render(() => <InvoicingReceivedDetail entityId="r1" />)
    fireEvent.click(await screen.findByTestId("received-action-refuse"))
    const submit = screen.getByTestId("received-action-submit") as HTMLButtonElement
    expect(submit.disabled).toBe(true) // no reason chosen yet, none pre-selected
    const select = screen.getByTestId("received-action-reason") as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(["Choose the reason", "Duplicate invoice", "Incorrect VAT rate"])
    fireEvent.change(select, { target: { value: "duplicate_invoice" } })
    fireEvent.input(screen.getByTestId("received-action-comment"), { target: { value: "Billed twice" } })
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    const dialog = await screen.findByTestId("received-action-confirm")
    expect(dialog.textContent).toContain("sent to the supplier's platform now")
    expect(dialog.textContent).toContain("Reason: Duplicate invoice")
    expect(calls.some((c) => c.tool === "received_einvoice_action_request")).toBe(false)
    fireEvent.click(screen.getByText("Confirm", { selector: "[data-testid='received-action-confirm'] button" }))
    await waitFor(() => expect(calls.some((c) => c.tool === "received_einvoice_action_request")).toBe(true))
    expect(calls.find((c) => c.tool === "received_einvoice_action_request")!.params).toEqual({
      received_id: "r1",
      action: "refuse",
      reason: "duplicate_invoice",
      comment: "Billed twice",
    })
    expect(calls.some((c) => c.tool === "received_einvoice_set_status")).toBe(false)
    expect((await screen.findByTestId("received-pending")).textContent).toBe("Refusal awaiting approval")
    expect(screen.queryByTestId("received-action-refuse")).toBeNull()
  })

  it("a refused invoice offers no action and says why; the XML original is download-only", async () => {
    detail = { ...detail, invoice: invoice({ status: "refused", status_code: 210 }), actions: [] }
    render(() => <InvoicingReceivedDetail entityId="r1" />)
    expect((await screen.findByTestId("received-detail-status")).textContent).toBe("Refused (210)")
    expect(screen.getByTestId("received-no-action").textContent).toContain("refused")
    expect(screen.queryByTestId("received-action-refuse")).toBeNull()
    expect(screen.queryByTestId("received-action-dispute")).toBeNull()
    expect(screen.queryByTestId("received-file-original-preview")).toBeNull()
    expect(screen.getByTestId("received-file-original-download")).toBeTruthy()
    expect(screen.getByTestId("received-file-rendering-preview")).toBeTruthy()
  })

  it("the empty list explains where supplier e-invoices come from", async () => {
    render(() => <InvoicingReceived />)
    expect((await screen.findByTestId("received-empty")).textContent).toContain("through the e-invoicing platform")
  })

  it("a list that fails to load says so with a retry, never the empty state", async () => {
    listAnswer = () => failed("forbidden", "missing scope invoicing:received:read")
    render(() => <InvoicingReceived />)
    const err = await screen.findByTestId("received-error")
    expect(err.textContent).toContain("missing scope invoicing:received:read")
    expect(screen.queryByTestId("received-empty")).toBeNull()
    listAnswer = () => ({ status: "ok", items: [item(1)], has_more: false, last_refreshed_at: null })
    fireEvent.click(screen.getByTestId("received-retry"))
    expect(await screen.findByTestId("received-row-r1")).toBeTruthy()
  })

  it("the list pages past its first page: Show more appends the next one", async () => {
    listAnswer = (p) =>
      Number(p.offset ?? 0) === 0
        ? { status: "ok", items: Array.from({ length: 50 }, (_, i) => item(i)), has_more: true, last_refreshed_at: null }
        : { status: "ok", items: [item(50), item(51)], has_more: false, last_refreshed_at: null }
    render(() => <InvoicingReceived />)
    fireEvent.click(await screen.findByTestId("received-more"))
    expect(await screen.findByTestId("received-row-r51")).toBeTruthy()
    expect(screen.getByTestId("received-row-r0")).toBeTruthy()
    expect(calls.filter((c) => c.tool === "received_einvoices_list").map((c) => c.params.offset)).toEqual([0, 50])
    expect(screen.queryByTestId("received-more")).toBeNull()
  })

  it("a reader without the permission to act sees no Refresh, Refuse or Dispute, and why", async () => {
    listAnswer = () => ({ status: "ok", items: [item(1)], has_more: false, last_refreshed_at: null, can_act: false })
    render(() => <InvoicingReceived />)
    await screen.findByTestId("received-row-r1")
    expect(screen.queryByTestId("received-refresh")).toBeNull()
    cleanup()
    detail = { ...detail, can_act: false }
    render(() => <InvoicingReceivedDetail entityId="r1" />)
    expect((await screen.findByTestId("received-no-action")).textContent).toContain("permission")
    expect(screen.queryByTestId("received-action-refuse")).toBeNull()
    expect(screen.queryByTestId("received-action-dispute")).toBeNull()
    expect(screen.queryByTestId("received-detail-refresh")).toBeNull()
  })

  it("an invoice that cannot be loaded says so with a retry; only a missing one says not found", async () => {
    getAnswer = () => failed("db_unavailable", "connection reset")
    render(() => <InvoicingReceivedDetail entityId="r1" />)
    expect((await screen.findByTestId("received-detail-error")).textContent).toContain("connection reset")
    expect(screen.queryByTestId("received-detail-missing")).toBeNull()
    cleanup()
    getAnswer = () => failed("not_found", "No received invoice with this id.")
    render(() => <InvoicingReceivedDetail entityId="r1" />)
    expect(await screen.findByTestId("received-detail-missing")).toBeTruthy()
    expect(screen.queryByTestId("received-detail-error")).toBeNull()
  })

  it("the detail's Refresh shows its failure", async () => {
    refreshAnswer = failed("provider_unavailable", "the platform answered 503")
    render(() => <InvoicingReceivedDetail entityId="r1" />)
    fireEvent.click(await screen.findByTestId("received-detail-refresh"))
    expect((await screen.findByTestId("received-action-note")).textContent).toContain("the platform answered 503")
  })
})
