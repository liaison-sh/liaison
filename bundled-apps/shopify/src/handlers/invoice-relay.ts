// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing document changes, relayed as one Shopify order event.
//
// The Orders list shows each order's invoicing documents (`orders_invoice_links`),
// and must update when one is created, issued, edited (its order link included),
// paid, cancelled or credited. An app UI may watch only its own entity keys
// (`shopify:…`) and kernel ones, so it cannot hear invoicing's `document:*`
// events. This subscriber (manifest `events.subscribes`, invoicing being an
// optional dependency) re-emits them as `order:invoice_changed`, which the list
// already watches through `shopify:order`. The event carries no order id:
// invoicing's payloads do not name the order, and the list refetches the links
// of every order it shows anyway.
import type { AppContext } from "@liaison/app-sdk"
import { emitEvent } from "../lib/emit"

interface InvoicingDocumentEvent {
  action?: string
  entityId?: string
  data?: { document_id?: unknown; number?: unknown } | null
}

export async function onInvoicingDocumentChanged(
  event: InvoicingDocumentEvent,
  ctx: AppContext,
): Promise<void> {
  const documentId =
    typeof event.data?.document_id === "string" ? event.data.document_id : (event.entityId ?? null)
  await emitEvent(ctx, {
    entity: "order",
    action: "invoice_changed",
    data: {
      document_id: documentId,
      number: typeof event.data?.number === "string" ? event.data.number : null,
      document_action: event.action ?? null,
    },
  })
}
