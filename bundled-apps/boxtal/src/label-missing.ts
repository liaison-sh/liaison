// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bought label that never arrives.
//
// Boxtal generates the label document asynchronously and tells us with a DOCUMENT_CREATED webhook.
// When that document never comes (Boxtal still generating, or the webhook lost), the parcel sits in
// Ready to ship with no Label button and nobody is told: the operator found out at the end of the
// day, when the carrier's van had already gone.
//
// This check runs with the reconcile job (every 15 minutes) and when a label arrives. A live label
// bought more than LABEL_MISSING_AFTER_MS ago (and less than LABEL_MISSING_MAX_AGE_MS) with no
// LABEL document is first re-read from Boxtal (a lost webhook heals here, with no alert); what is
// still missing raises ONE calm attention item for the shipping team, naming the orders. Each
// parcel raises it once (`label_missing_alerted`) and is then re-read only every
// LABEL_MISSING_RECHECK_MS, so neither the item nor the Boxtal reads repeat every 15 minutes. When
// part of the set arrives the item is updated to what remains; once every missing label has
// arrived (or its order was cancelled), the item is cleared.
import type { BoxtalToolCtx } from "./ctx"
import { getClientOrError } from "./lib/get-client"
import { applyDocumentCreated } from "./link-store"
import { findAllShipments, findShipmentsInAny, shipmentHasLabel } from "./queues"

/** How long a bought label may go without its document before someone is told. */
export const LABEL_MISSING_AFTER_MS = 15 * 60 * 1000

/** How often a parcel already in the alert is re-read from Boxtal (a lost webhook still heals). */
export const LABEL_MISSING_RECHECK_MS = 60 * 60 * 1000

/** A label bought longer ago than this is out of the check: the parcel is long gone or handled. */
export const LABEL_MISSING_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

/** The attention event this check emits (manifest `attention.translations`). */
export const LABEL_MISSING_EVENT = { entity: "queue", action: "labels_missing", entityId: "ready" } as const

/** Most orders named in the attention summary; the rest are counted. */
const NAMED_ORDERS_MAX = 5

const LIVE_ORDER_STATES = ["PENDING", "REQUESTED", "CONFIRMED"]

interface LabelRow {
  id: string | number
  boxtal_order_id?: string | null
  order_status?: string | null
  tracking_status?: string | null
  external_id?: string | null
  recipient_summary?: string | null
  documents?: Array<{ type?: string }> | null
  link_state?: string | null
  created_at?: string | null
  label_missing_alerted?: boolean | null
  /** When an alerted row was last re-read from Boxtal (LABEL_MISSING_RECHECK_MS backoff). */
  label_missing_checked_at?: string | null
}

export interface LabelMissingResult {
  missing: number
  alerted: boolean
  resolved: boolean
}

function orderLabel(r: LabelRow): string {
  return r.external_id || r.recipient_summary || r.boxtal_order_id || String(r.id)
}

/** Re-read the documents of a row Boxtal may have finished without telling us. True when its
 *  label is there now (and stored on the row). */
async function healFromBoxtal(
  ctx: BoxtalToolCtx,
  client: { v3: { getDocuments(id: string): Promise<Array<{ url?: string; type: string; format: string }>> } } | null,
  row: LabelRow,
): Promise<boolean> {
  if (!client || !row.boxtal_order_id) return false
  try {
    const docs = await client.v3.getDocuments(row.boxtal_order_id)
    if (!docs.some((d) => d.type === "LABEL")) return false
    await applyDocumentCreated(ctx, row.boxtal_order_id, docs)
    return true
  } catch {
    return false
  }
}

export async function checkMissingLabels(
  ctx: BoxtalToolCtx,
  opts: { now?: number; heal?: boolean } = {},
): Promise<LabelMissingResult> {
  const now = opts.now ?? Date.now()
  const [live, flagged] = await Promise.all([
    findShipmentsInAny(ctx, [
      { order_status: { in: LIVE_ORDER_STATES }, tracking_status: null },
      { order_status: { in: LIVE_ORDER_STATES }, tracking_status: { in: ["ANNOUNCED", ""] } },
    ]) as Promise<LabelRow[]>,
    findAllShipments(ctx, { label_missing_alerted: true }) as Promise<LabelRow[]>,
  ])

  let client: Parameters<typeof healFromBoxtal>[1] = null
  if (opts.heal !== false) {
    const c = await getClientOrError(ctx)
    client = "error" in c ? null : c
  }

  const missing: LabelRow[] = []
  for (const r of live) {
    if (r.link_state && r.link_state !== "created") continue
    if (!r.boxtal_order_id || shipmentHasLabel(r)) continue
    const bought = r.created_at ? Date.parse(r.created_at) : Number.NaN
    if (!Number.isFinite(bought) || now - bought < LABEL_MISSING_AFTER_MS) continue
    if (now - bought > LABEL_MISSING_MAX_AGE_MS) continue
    // A row already in the alert is re-read only every LABEL_MISSING_RECHECK_MS, not every pass.
    const checked = r.label_missing_checked_at ? Date.parse(r.label_missing_checked_at) : Number.NaN
    const due = !r.label_missing_alerted || !Number.isFinite(checked) || now - checked >= LABEL_MISSING_RECHECK_MS
    if (client && due) {
      if (await healFromBoxtal(ctx, client, r)) continue
      r.label_missing_checked_at = new Date(now).toISOString()
      if (r.label_missing_alerted) {
        await ctx.db.update("shipment", String(r.id), { label_missing_checked_at: r.label_missing_checked_at })
      }
    }
    missing.push(r)
  }
  const missingIds = new Set(missing.map((r) => String(r.id)))

  // Flags whose label has arrived, or whose order left play: their part of the alert is over.
  const done = flagged.filter((r) => !missingIds.has(String(r.id)))
  for (const r of done) await ctx.db.update("shipment", String(r.id), { label_missing_alerted: false })

  const fresh = missing.filter((r) => !r.label_missing_alerted)
  // New parcels in the alert, or some left it while others remain: the item shows the set as it is.
  if (fresh.length > 0 || (done.length > 0 && missing.length > 0)) {
    const named = missing.slice(0, NAMED_ORDERS_MAX).map(orderLabel)
    const more = missing.length - named.length
    await ctx.emit?.({
      ...LABEL_MISSING_EVENT,
      data: {
        count: missing.length,
        orders: more > 0 ? `${named.join(", ")} (+${more})` : named.join(", "),
        resolved: false,
      },
    })
    for (const r of fresh) {
      await ctx.db.update("shipment", String(r.id), {
        label_missing_alerted: true,
        ...(r.label_missing_checked_at ? { label_missing_checked_at: r.label_missing_checked_at } : {}),
      })
    }
    return { missing: missing.length, alerted: fresh.length > 0, resolved: false }
  }
  if (missing.length === 0 && done.length > 0) {
    await ctx.emit?.({ ...LABEL_MISSING_EVENT, data: { count: 0, orders: "", resolved: true } })
    return { missing: 0, alerted: false, resolved: true }
  }
  return { missing: missing.length, alerted: false, resolved: false }
}
