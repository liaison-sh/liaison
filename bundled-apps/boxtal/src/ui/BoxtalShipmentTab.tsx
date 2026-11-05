// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BoxtalShipmentTab — contributed to invoicing.document_detail.tabs (K5 slot).
//
// Shown inside an invoice's detail. With no linked shipment it renders an
// EmptyState with a primary "Create shipment" CTA that opens the Boxtal draft
// pre-filled from the invoice (zero re-entry). With a linked shipment it shows
// a compact card: recipient, the order + tracking badges, carrier, declared
// cost, the tracking number, and live document download links.
//
// Styling composes ONLY the shared Boxtal kit (kit.tsx), which paints with the
// kernel charcoal theme tokens — so this panel matches the invoicing app
// pixel-for-pixel. The pure status/document mappers are kept as named exports
// (Shipments.tsx + the bun:test suite import them) and are now thin adapters
// over the kit's single-source-of-truth meta helpers.
import { type Component, createResource, For, type JSX, Show } from "solid-js"
import { app } from "@liaison/host"
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Money,
  OrderStatusBadge,
  TrackingStatusBadge,
  documentTypeLabel as kitDocumentTypeLabel,
  orderStatusMeta,
  trackingStatusMeta,
  type BadgeTone,
} from "./kit"

export const DRAFT_CREATE_TOOL = "shipment_draft_create"

// ── Backward-compatible badge mappers ────────────────────────────────────────
// These were the legacy {label, variant} shape consumed by Shipments.tsx and
// the bun:test suite. They now defer to the kit's meta helpers (the one true
// source of status→tone), translating the kit's tone vocabulary into the legacy
// variant vocabulary so existing call-sites keep working unchanged.
export type BadgeVariant = "neutral" | "info" | "success" | "warning" | "danger"
export interface BadgeSpec {
  label: string
  variant: BadgeVariant
}

const TONE_TO_VARIANT: Record<BadgeTone, BadgeVariant> = {
  neutral: "neutral",
  muted: "neutral",
  accent: "info",
  success: "success",
  warning: "warning",
  error: "danger",
}

/** Map a Boxtal order status (or null) to a legacy badge label + variant. */
export function orderStatusBadge(status: string | null): BadgeSpec {
  const m = orderStatusMeta(status)
  return { label: m.label, variant: TONE_TO_VARIANT[m.tone] }
}

/** Map a Boxtal tracking status (or null) to a legacy badge label + variant. */
export function trackingStatusBadge(status: string | null): BadgeSpec {
  const m = trackingStatusMeta(status)
  return { label: m.label, variant: TONE_TO_VARIANT[m.tone] }
}

/** Map a Boxtal document type to a display label (re-exported from the kit). */
export function documentTypeLabel(type: string): string {
  return kitDocumentTypeLabel(type)
}

// ── Linked-shipment lookup ────────────────────────────────────────────────────
interface LinkedDocument {
  type: string
  format: string
}

interface LinkedShipment {
  boxtal_order_id: string | null
  recipient: string | null
  order_status: string | null
  tracking_status: string | null
  tracking_number: string | null
  carrier: string | null
  // Declared parcel VALUE (customs/insurance), NOT the carrier shipping cost — see search.ts SearchHit.
  declared_value: number | null
  currency: string
  documents: LinkedDocument[]
}

interface TabProps {
  /** Kernel slot-contribution contract: the host id of the entity this body is
   *  shown for — here, the invoicing document id (used as the Boxtal document_ref). */
  entityId: string
}

/** Look up a linked shipment for the invoice via the search index. */
async function fetchLinked(documentRef: string): Promise<LinkedShipment | null> {
  try {
    const res = await app.invokeTool<{
      results: Array<{ id: string; title?: string; attributes?: Record<string, unknown> }>
    }>("search", { query: documentRef, limit: 1 })
    const hit = res.results?.[0]
    if (!hit) return null
    const a = hit.attributes ?? {}
    const docsRaw = Array.isArray(a.documents) ? (a.documents as Array<Record<string, unknown>>) : []
    return {
      boxtal_order_id: hit.id,
      recipient: (a.recipient as string | null) ?? hit.title ?? null,
      order_status: (a.order_status as string | null) ?? null,
      tracking_status: (a.tracking_status as string | null) ?? null,
      tracking_number: (a.tracking_number as string | null) ?? null,
      carrier: (a.carrier as string | null) ?? null,
      declared_value: (a.declared_value as number | null) ?? null,
      currency: (a.currency as string | null) ?? "EUR",
      documents: docsRaw.map((d) => ({
        type: String(d.type ?? ""),
        format: String(d.format ?? ""),
      })),
    }
  } catch {
    return null
  }
}

// ── A single labelled key/value row inside the linked card ───────────────────
const DetailRow: Component<{ label: string; children: JSX.Element }> = (props) => (
  <div class="flex items-baseline justify-between gap-3 py-1.5">
    <span class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">{props.label}</span>
    <span class="min-w-0 text-right text-[12.5px] text-text">{props.children}</span>
  </div>
)

export const BoxtalShipmentTab: Component<TabProps> = (props) => {
  const [linked] = createResource(() => props.entityId, fetchLinked)

  const createHref = () => `/boxtal/create/${encodeURIComponent(props.entityId)}`
  const createDraft = () => {
    void app.invokeTool(DRAFT_CREATE_TOOL, { document_ref: props.entityId })
  }

  return (
    <div data-testid="boxtal-shipment-tab" class="flex h-full min-h-0 flex-col">
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <Show
          when={linked()}
          fallback={
            <EmptyState
              testid="boxtal-shipment-empty"
              title="No shipment yet"
            >
              <span class="block">
                Create a Boxtal shipment pre-filled from this invoice: recipient, parcels and
                customs carry over with no re-entry.
              </span>
              <span class="mt-4 inline-flex">
                <a href={createHref()} class="contents">
                  <Button variant="primary" testid="boxtal-tab-create" onClick={createDraft}>
                    Create shipment
                  </Button>
                </a>
              </span>
            </EmptyState>
          }
        >
          {(s) => (
            <Card class="p-4">
              <div data-testid="boxtal-shipment-linked" class="flex flex-col gap-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
                      Recipient
                    </div>
                    <div class="truncate text-[13px] font-medium text-text">{s().recipient ?? "-"}</div>
                  </div>
                  <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <OrderStatusBadge status={s().order_status} testid="boxtal-tab-order-status" />
                    <TrackingStatusBadge status={s().tracking_status} testid="boxtal-tab-tracking-status" />
                  </div>
                </div>

                <div class="border-t border-border-subtle pt-1">
                  <DetailRow label="Carrier">
                    <span class="text-text-secondary">{s().carrier ?? "-"}</span>
                  </DetailRow>
                  <DetailRow label="Declared value">
                    <Money value={s().declared_value} currency={s().currency} />
                  </DetailRow>
                  <DetailRow label="Tracking #">
                    <Show
                      when={s().tracking_number}
                      fallback={<span class="text-text-tertiary">-</span>}
                    >
                      <span class="font-mono tabular-nums text-text" data-testid="boxtal-tab-tracking-number">
                        {s().tracking_number}
                      </span>
                    </Show>
                  </DetailRow>
                </div>

                <Show when={s().documents.length > 0}>
                  <div class="border-t border-border-subtle pt-3">
                    <div class="mb-2 text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
                      Documents
                    </div>
                    <div class="flex flex-col gap-1.5" data-testid="boxtal-tab-documents">
                      <For each={s().documents}>
                        {(doc) => (
                          <a
                            href={`/boxtal/documents/${encodeURIComponent(s().boxtal_order_id ?? "")}/${encodeURIComponent(doc.type)}`}
                            class="contents"
                          >
                            <Button variant="secondary" class="w-full justify-between">
                              <span class="text-text">{documentTypeLabel(doc.type)}</span>
                              <Badge tone="muted">{doc.format || "Download"}</Badge>
                            </Button>
                          </a>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            </Card>
          )}
        </Show>
      </div>
    </div>
  )
}
