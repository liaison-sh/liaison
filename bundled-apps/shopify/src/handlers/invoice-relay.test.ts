// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing document subscriber relays every subscribed document event as
// `order:invoice_changed`, the event the Orders list's invoice links refetch on.
import { describe, expect, it, mock } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import manifest from "../../app.manifest.json"
import * as bundle from "../handlers"
import { onInvoicingDocumentChanged } from "./invoice-relay"

function ctxWithEmit() {
  const emit = mock(async (_event: unknown) => {})
  return { ctx: { emit } as unknown as AppContext, emit }
}

describe("onInvoicingDocumentChanged", () => {
  it("re-emits an issued document as order:invoice_changed", async () => {
    const { ctx, emit } = ctxWithEmit()
    await onInvoicingDocumentChanged(
      {
        action: "issued",
        entityId: "doc-1",
        data: { document_id: "doc-1", number: "INV-2026-0023" },
      },
      ctx,
    )
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toEqual({
      entity: "order",
      action: "invoice_changed",
      entityId: undefined,
      data: { document_id: "doc-1", number: "INV-2026-0023", document_action: "issued" },
      metadata: undefined,
    })
  })

  it("falls back to the event's entityId when the payload names no document", async () => {
    const { ctx, emit } = ctxWithEmit()
    await onInvoicingDocumentChanged({ action: "created", entityId: "draft-9", data: null }, ctx)
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      data: { document_id: "draft-9", number: null, document_action: "created" },
    })
  })

  it("is wired: subscribed to invoicing's document events, exported, and its emit declared", () => {
    const events = (manifest as { events: { emits: string[]; subscribes: Record<string, string> } })
      .events
    for (const action of ["created", "issued", "updated", "paid", "cancelled", "credited"]) {
      expect(events.subscribes[`invoicing/document:${action}`]).toBe("onInvoicingDocumentChanged")
    }
    expect(events.emits).toContain("order:invoice_changed")
    // A cross-app subscription without a declared dependency is skipped at registration.
    expect(
      (manifest as { dependencies?: { optional?: string[] } }).dependencies?.optional,
    ).toContain("invoicing")
    expect(bundle.onInvoicingDocumentChanged).toBe(onInvoicingDocumentChanged)
  })
})
