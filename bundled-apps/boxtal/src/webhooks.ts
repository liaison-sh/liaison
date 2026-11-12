// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boxtal v3 webhook handlers: tracking-changed + document-created.
//
// Each handler dedups by delivery id against the `webhook_delivery` ledger
// (defense-in-depth on top of the kernel `replayKey`; the claim is an expiring lease, so a
// run killed before it marked its row does not block the redeliveries), then applies the change
// via the link store. Out-of-order (older) tracking events are ignored by the
// link store's timestamp guard. An unknown order id logs + returns 200 (never
// errors the sender). A handler that throws mid-process flips the ledger row to
// `failed` so the next Boxtal retry re-applies.

import type { WebhookResult } from "@liaison/app-sdk"
import { getClient } from "./lib/get-client"
import { applyDocumentCreated, applyTrackingChanged } from "./link-store"
import {
  fulfillShipment,
  shopifyOrderIdForShipment,
  type FulfillmentShipmentRow,
} from "./fulfillment"
import { sourceTrackingFromLabel } from "./label-tracking"
import { checkMissingLabels } from "./label-missing"
import type { BoxtalToolCtx } from "./ctx"

type WebhookCtx = BoxtalToolCtx

export type { WebhookResult }

const OK: WebhookResult = { status: 200, body: "ok" }

/**
 * Derive the dedup key. Prefer Boxtal's own `x-bxt-delivery-id`. Without it,
 * the fallback MUST distinguish genuinely distinct events for the same order —
 * two TRACKING_CHANGED events (ANNOUNCED → IN_TRANSIT → DELIVERED) must NOT
 * collide on `eventType:orderId` (I3) or the 2nd+ event is silently dropped and
 * the shipment freezes at its first status. We fold in the event's own
 * status + timestamp (the same per-event identity the verifier's body-hash
 * captures) so each status change claims a distinct key.
 */
function deliveryIdOf(headers: Record<string, string>, payload: Record<string, unknown>): string {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  const explicit = lower["x-bxt-delivery-id"]
  if (explicit) return explicit
  // A real v3.1 body carries its own event id — the strongest dedup key.
  if (typeof payload.id === "string" && payload.id) return `evt:${payload.id}`
  const eventType = String(payload.type ?? payload.eventType ?? "evt")
  const orderId = String(payload.shippingOrderId ?? payload.orderId ?? "")
  // status + timestamp give per-event identity; documents[] count distinguishes
  // repeated DOCUMENT_CREATED. Fall back to a JSON digest of the payload when
  // those are absent so the key is never just eventType:orderId.
  const discriminator =
    payload.trackingDateTime ??
    payload.status ??
    payload.timestamp ??
    (Array.isArray(payload.documents) ? `docs:${payload.documents.length}` : undefined) ??
    `body:${stableHash(JSON.stringify(payload))}`
  return `${eventType}:${orderId}:${String(discriminator)}`
}

/** Tiny deterministic string hash (FNV-1a) — no crypto needed for a dedup key. */
function stableHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

type DedupRow = {
  id: string
  status: string
  claim_token?: string | null
  claimed_at?: string | null
  received_at?: string | null
}

/**
 * How long a `processing` claim holds: past any webhook run's wall clock (29 s at most), so a
 * claim older than this belongs to a run that was killed before it marked the row.
 */
export const CLAIM_TTL_MS = 2 * 60_000

function newClaimToken(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function claimExpired(row: DedupRow, now: number): boolean {
  const at = Date.parse(String(row.claimed_at ?? row.received_at ?? ""))
  return !Number.isFinite(at) || now - at > CLAIM_TTL_MS
}

/**
 * Claim a delivery; returns false when it has already been processed or another run holds it.
 *
 * No run holds a transaction across its bridge calls, so the claim is an expiring lease on the
 * ledger row: a new delivery inserts its row (the unique `delivery_id` decides a race), and a
 * `failed` row or a `processing` row whose claim expired (a killed run) is taken over with a
 * compare-and-set on its claim token, so two redeliveries never both proceed.
 */
async function claimDelivery(
  ctx: WebhookCtx,
  deliveryId: string,
  eventType: string,
): Promise<{ proceed: boolean; rowId?: string }> {
  const now = Date.now()
  const existing = (await ctx.db.findMany("webhook_delivery", {
    where: { delivery_id: deliveryId },
    limit: 1,
  })) as DedupRow[]
  if (existing.length > 0) {
    const row = existing[0]!
    const takeOver = row.status === "failed" || (row.status === "processing" && claimExpired(row, now))
    if (!takeOver) return { proceed: false }
    const res = (await ctx.db.updateMany("webhook_delivery", {
      where: { delivery_id: deliveryId, status: row.status, claim_token: row.claim_token ?? null },
      data: { status: "processing", claim_token: newClaimToken(), claimed_at: new Date(now).toISOString() },
    })) as { count?: number }
    return res.count === 1 ? { proceed: true, rowId: row.id } : { proceed: false }
  }
  try {
    const at = new Date(now).toISOString()
    const ins = await ctx.db.insert("webhook_delivery", {
      delivery_id: deliveryId,
      event_type: eventType,
      status: "processing",
      failure_count: 0,
      received_at: at,
      claim_token: newClaimToken(),
      claimed_at: at,
    })
    return { proceed: true, rowId: ins.id }
  } catch {
    // Race lost — another delivery inserted first; treat as duplicate.
    return { proceed: false }
  }
}

async function markProcessed(ctx: WebhookCtx, rowId: string): Promise<void> {
  await ctx.db.update("webhook_delivery", rowId, {
    status: "processed",
    processed_at: new Date().toISOString(),
  })
}

async function markFailed(ctx: WebhookCtx, rowId: string): Promise<void> {
  const rows = (await ctx.db.findMany("webhook_delivery", { where: { id: rowId }, limit: 1 })) as Array<{ failure_count?: number }>
  const failure_count = (rows[0]?.failure_count ?? 0) + 1
  await ctx.db.update("webhook_delivery", rowId, { status: "failed", failure_count })
}

/**
 * Dedup wrapper: claim → run → mark processed/failed. Returns 200 on success or
 * a duplicate (already-claimed) delivery; returns 503 when the handler throws,
 * so Boxtal's retry schedule re-delivers and the ledger row is marked `failed`
 * for the next attempt.
 */
async function runDelivery(
  ctx: WebhookCtx,
  deliveryId: string,
  eventType: string,
  run: () => Promise<void>,
): Promise<WebhookResult> {
  const claim = await claimDelivery(ctx, deliveryId, eventType)
  if (!claim.proceed) return OK
  try {
    await run()
    if (claim.rowId) await markProcessed(ctx, claim.rowId)
    return OK
  } catch (err) {
    ctx.logger?.error?.("boxtal webhook handler failed", { eventType, deliveryId, err: String(err) })
    if (claim.rowId) await markFailed(ctx, claim.rowId)
    // 503 so Boxtal retries (its retry schedule re-delivers).
    return { status: 503, body: "handler failed" }
  }
}

interface TrackingPayload {
  eventType?: string
  orderId?: string
  status?: string
  trackingNumber?: string | null
  trackingDateTime?: string
  // — real Boxtal v3.1 delivery shape (WebhookEventTrackingChanged) —
  id?: string
  type?: string
  shippingOrderId?: string
  payload?: {
    trackings?: Array<{
      status?: string
      trackingNumber?: string | null
      trackingDateTime?: string
    }>
    documents?: unknown[]
  }
}

/**
 * Normalize a delivery body to the flat fields the handlers consume. Boxtal's
 * REAL v3.1 body is `{id, type, shippingOrderId, payload: {trackings: [...]}}`
 * (api-v3.json WebhookEventTrackingChanged) — NOT the flat shape this module
 * historically expected. No genuine delivery was ever parsed before 2026-08-04
 * (they were all rejected at the signature layer first), so the flat path only
 * ever saw synthetic tests; keep accepting it for those and for any older
 * proxy shape. `trackings[0]` is the current status (history-first ordering is
 * inside each tracking's own `history`, not across the array).
 */
export function normalizeTrackingEvent(body: TrackingPayload): {
  eventType: string
  orderId: string
  status?: string
  trackingNumber?: string | null
  trackingDateTime?: string
} {
  const t = body.payload?.trackings?.[0]
  return {
    eventType: String(body.type ?? body.eventType ?? "TRACKING_CHANGED"),
    orderId: String(body.shippingOrderId ?? body.orderId ?? ""),
    status: t?.status ?? body.status,
    trackingNumber: t?.trackingNumber ?? body.trackingNumber ?? null,
    trackingDateTime: t?.trackingDateTime ?? body.trackingDateTime,
  }
}

/**
 * Idempotent auto-fulfillment: once a shipment carries a tracking number (the carrier's, from a
 * TRACKING_CHANGED event, or the one printed on the label, read at DOCUMENT_CREATED) and its
 * document is linked to a Shopify order, fulfil that order with the number (fulfillment.ts).
 *
 * The outcome is written onto the shipment row, so a failure shows on the Ready to ship row and in
 * stuck_list instead of disappearing into a log line; the webhook itself still answers 200, since
 * a Shopify refusal is not a reason for Boxtal to redeliver. Skipped silently when there is nothing
 * to do yet (no tracking number, no linked Shopify order: returns, repairs, manual shipments),
 * when the row is already fulfilled, and when the operator deliberately unfulfilled it (unticked
 * a packed row): a later carrier scan must not undo that decision behind their back.
 */
async function maybeAutoFulfill(ctx: WebhookCtx, boxtalOrderId: string): Promise<void> {
  try {
    const rows = (await ctx.db.findMany("shipment", {
      where: { boxtal_order_id: boxtalOrderId },
      limit: 1,
    })) as FulfillmentShipmentRow[]
    const shipment = rows[0]
    if (!shipment) return
    if (shipment.fulfillment_synced) return
    if (shipment.fulfillment_state === "cancelled") return
    // The automatic trigger is the CARRIER's tracking number. A number only read off the label
    // means the parcel may not even be packed yet, and fulfilling marks the order shipped on
    // Shopify, which may email the customer with the tracking (the shopify app's shipping email
    // policy decides: e.g. retail orders only, B2B never); that waits for the operator's tick or
    // the carrier's first event.
    if (shipment.tracking_from_label) return
    if (!shipment.tracking_number) return
    if (!(await shopifyOrderIdForShipment(ctx, shipment))) return
    const outcome = await fulfillShipment(ctx, shipment)
    if (outcome.status === "error") {
      ctx.logger?.warn?.("auto-fulfillment failed, recorded on the shipment row", {
        boxtalOrderId,
        code: outcome.code,
      })
    }
  } catch (err) {
    ctx.logger?.warn?.("auto-fulfillment threw", { boxtalOrderId, err: String(err) })
  }
}

export async function trackingChangedHandler(
  payload: TrackingPayload,
  ctx: WebhookCtx,
  headers: Record<string, string> = {},
): Promise<WebhookResult> {
  const deliveryId = deliveryIdOf(headers, payload as Record<string, unknown>)
  return runDelivery(ctx, deliveryId, "TRACKING_CHANGED", async () => {
    const evt = normalizeTrackingEvent(payload)
    if (!evt.orderId || !evt.status) return
    const res = await applyTrackingChanged(ctx, evt.orderId, {
      tracking_status: evt.status,
      tracking_number: evt.trackingNumber ?? null,
      at: evt.trackingDateTime ?? new Date().toISOString(),
    })
    if (!res.applied) {
      ctx.logger?.warn?.("tracking-changed for unknown/older order", { orderId: evt.orderId })
      return
    }
    if (evt.trackingNumber) {
      await maybeAutoFulfill(ctx, evt.orderId)
    }
  })
}

interface DocumentPayload {
  eventType?: string
  orderId?: string
  // — real Boxtal v3.1 delivery shape (WebhookEventDocumentCreated) —
  id?: string
  type?: string
  shippingOrderId?: string
}

export async function documentCreatedHandler(
  payload: DocumentPayload,
  ctx: WebhookCtx,
  headers: Record<string, string> = {},
): Promise<WebhookResult> {
  const deliveryId = deliveryIdOf(headers, payload as Record<string, unknown>)
  return runDelivery(ctx, deliveryId, "DOCUMENT_CREATED", async () => {
    const orderId = String(payload.shippingOrderId ?? payload.orderId ?? "")
    if (!orderId) return
    // Fetch the live documents and persist url-stripped descriptors.
    const client = await getClient(ctx)
    const descriptors = await client.v3.getDocuments(orderId)
    const res = await applyDocumentCreated(ctx, orderId, descriptors)
    if (!res.applied) {
      ctx.logger?.warn?.("document-created for unknown order", { orderId })
      return
    }
    // The label now exists, and it prints the carrier's number even when the carrier has not
    // scanned the parcel yet (FedEx Regional Economy, Domestic Express): store it before fulfilling.
    const rows = (await ctx.db.findMany("shipment", { where: { boxtal_order_id: orderId }, limit: 1 })) as FulfillmentShipmentRow[]
    if (rows[0] && !rows[0].tracking_number) {
      const labelUrl = descriptors.find((d) => d.type === "LABEL" && d.url)?.url ?? null
      await sourceTrackingFromLabel(ctx, rows[0], { labelUrl })
    }
    // This label was one the shipping team had been told is missing: clear that item now.
    if ((rows[0] as { label_missing_alerted?: boolean | null } | undefined)?.label_missing_alerted) {
      try {
        await checkMissingLabels(ctx, { heal: false })
      } catch (err) {
        ctx.logger?.warn?.("boxtal: missing-label check failed", { orderId, err: String(err) })
      }
    }
    await maybeAutoFulfill(ctx, orderId)
  })
}
