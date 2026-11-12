// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify fulfillment of one shipment row, shared by the two paths that fulfil:
//
//   - the operator's PACKED tick on Ready to ship (packed.ts): the click is the decision, so the
//     outcome is returned to the row and the tick refuses to stay set on anything but success;
//   - the webhook auto-fulfillment (webhooks.ts): a carrier event that brings a tracking number.
//
// Every outcome is written onto the shipment row (`fulfillment_state`, `fulfillment_error`), so a
// failed fulfillment is visible on the queue row and to stuck_list, never only in a log line.
//
// Gating is the kernel's, not ours: shopify:fulfillments_create and fulfillments_cancel are gated
// tools reached through this app's declared cross_app_calls. A direct click by a user who may
// approve runs them at once (the click IS the decision, no second approval is parked); a webhook
// (system origin) runs them as a declared machine dispatch; an agent's call parks an approval.
// A parked approval comes back here as `pending_approval` and is reported as such.

import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { sourceTrackingFromLabel } from "./label-tracking"
import { carrierFamilyOf } from "./print-record"
import { toShopifyOrderGid } from "./shopify-ref"

export interface FulfillmentShipmentRow {
  id: string | number
  boxtal_order_id?: string | null
  document_ref?: string | null
  tracking_number?: string | null
  fulfillment_synced?: boolean | null
  fulfillment_state?: string | null
  shopify_fulfillment_id?: string | null
  tracking_from_label?: boolean | null
  /** The pending approval of this parcel's fulfillment, while one is parked. */
  fulfillment_approval_id?: string | null
  line_quantities?: Array<{ line_id: string; external_id: string | null; quantity: number }> | null
  /** The bought Boxtal offer ("UPSE-Standard"): names the carrier on the Shopify fulfillment. */
  offer_code?: string | null
}

/**
 * The carrier name Shopify knows for each carrier family. With a known `company` Shopify builds
 * the tracking link itself, so its shipping email (when the store's policy sends one) carries a
 * working link, not a bare number.
 */
const SHOPIFY_TRACKING_COMPANY: Record<string, string> = {
  ups: "UPS",
  fedex: "FedEx",
  dhl: "DHL Express",
  chronopost: "Chronopost",
  laposte: "Colissimo",
  mondialrelay: "Mondial Relay",
  colisprive: "Colis Privé",
  tnt: "TNT",
}

/** The Shopify `trackingInfo` for a parcel: its number, and its carrier when Shopify knows it. */
export function shopifyTrackingInfo(
  row: FulfillmentShipmentRow,
  number: string,
): { number: string; company?: string } {
  const family = carrierFamilyOf(row.offer_code)
  const company = family ? SHOPIFY_TRACKING_COMPANY[family] : undefined
  return company ? { number, company } : { number }
}

export type FulfillOutcome =
  | {
      status: "fulfilled"
      fulfillment_id: string | null
      tracking_number: string
      already: boolean
    }
  | { status: "pending_approval"; message: string }
  | { status: "error"; code: string; message: string }

export type UnfulfillOutcome =
  | { status: "cancelled" }
  | { status: "pending_approval"; message: string }
  | { status: "error"; code: string; message: string }

/** The Shopify order a shipment was bought for, through the document it was bought from. */
export async function shopifyOrderIdForShipment(
  ctx: BoxtalToolCtx,
  row: FulfillmentShipmentRow,
): Promise<string | null> {
  if (!row.document_ref) return null
  const metas = (await ctx.db.findMany("prep_meta", {
    where: { document_ref: row.document_ref },
    limit: 1,
  })) as Array<{ shopify_order_id?: string | null }>
  return metas[0]?.shopify_order_id ?? null
}

interface OrderFulfillment {
  id?: string | null
  status?: string | null
  trackingInfo?: Array<{ number?: string | null }> | null
}

/**
 * The order's live SUCCESS fulfillment that carries THIS parcel's tracking number, or null.
 * Matched on the tracking number alone: several shipments can share one order, so neither the
 * order's overall status nor another parcel's number may read as "this row is done". A read that
 * fails returns `undefined` (unknown), which the caller treats as "not known to be fulfilled".
 */
export async function fulfillmentCarryingTracking(
  ctx: BoxtalToolCtx,
  shopifyOrderId: string,
  trackingNumber: string,
): Promise<OrderFulfillment | null | undefined> {
  const wanted = trackingNumber.trim()
  if (!wanted) return null
  try {
    const env = await ctx.executeTool("shopify:orders_get", {
      id: toShopifyOrderGid(shopifyOrderId),
    })
    if (env.status !== "completed" || env.result == null) {
      ctx.logger?.warn?.("orders_get for the fulfillment check did not complete", {
        shopifyOrderId,
        status: env.status,
        error: (env as { error?: unknown }).error,
      })
      return undefined
    }
    const fulfillments = (env.result as { fulfillments?: OrderFulfillment[] | null }).fulfillments
    if (!Array.isArray(fulfillments)) return null
    return (
      fulfillments.find(
        (f) =>
          String(f?.status ?? "").toUpperCase() === "SUCCESS" &&
          Array.isArray(f?.trackingInfo) &&
          f.trackingInfo.some((t) => typeof t?.number === "string" && t.number.trim() === wanted),
      ) ?? null
    )
  } catch (err) {
    ctx.logger?.warn?.("orders_get for the fulfillment check threw", {
      shopifyOrderId,
      err: String(err),
    })
    return undefined
  }
}

/** Approval states in which the parked request will never run: a new one may be staged. */
const DEAD_APPROVAL_STATES = new Set([
  "denied",
  "rejected",
  "expired",
  "withdrawn",
  "cancelled",
  "canceled",
  "failed",
])

/**
 * Retire the parcel's parked fulfillment approval, so at most ONE exists per shipment.
 *   - "gone": withdrawn now, or it can never run anyway (denied, expired, unknown): stage afresh.
 *   - "kept": it is still live and this caller cannot withdraw it (a carrier webhook, someone other
 *     than its requester), or it is already being executed: reuse it, never stage a second one.
 */
export async function retirePendingFulfillment(
  ctx: BoxtalToolCtx,
  approvalId: string,
): Promise<"gone" | "kept"> {
  try {
    const env = await ctx.executeTool("kernel:approval_withdraw", {
      requestId: approvalId,
      reason: "Superseded: one Shopify fulfillment request per parcel.",
    })
    if (env.status === "completed") return "gone"
    if (env.status !== "error") return "kept"
    const code = env.error?.code ?? ""
    if (code === "not_found") return "gone"
    const state = /already (\w+)/.exec(env.error?.message ?? "")?.[1]?.toLowerCase()
    return state && DEAD_APPROVAL_STATES.has(state) ? "gone" : "kept"
  } catch {
    return "kept"
  }
}

const PENDING_MESSAGE =
  "Fulfillment is waiting for approval by someone allowed to approve it. The order is not fulfilled yet."

function envelopeMessage(env: CrossAppEnvelope): string {
  const e = (env as { error?: { message?: unknown; code?: unknown } }).error
  if (e && typeof e.message === "string" && e.message) return e.message
  if (e && typeof e.code === "string") return e.code
  return "Shopify did not accept the request."
}

/**
 * A Shopify refusal caused by the order's own state: nothing open to fulfil, or Shopify saying the
 * order or its fulfillment order is already fulfilled, cancelled or closed. The row says why and
 * the operator acts on it; nothing failed (409). Anything else (a bad parameter, an unknown id, any
 * other user error) means the call we built was wrong or Shopify failed: shopify_error (502).
 */
const ORDER_STATE_REFUSAL = /already fulfilled|cancell?ed|\bclosed\b/i

function shopifyFailureCode(env: CrossAppEnvelope): "shopify_refused" | "shopify_error" {
  const error = (env as { error?: { code?: unknown; message?: unknown } }).error
  if (error?.code === "NO_FULFILLABLE_ITEMS") return "shopify_refused"
  if (
    error?.code === "SHOPIFY_USER_ERROR" &&
    typeof error.message === "string" &&
    ORDER_STATE_REFUSAL.test(error.message)
  ) {
    return "shopify_refused"
  }
  return "shopify_error"
}

function fulfillmentIdFromResult(result: unknown): string | null {
  const r = result as { fulfillment?: { id?: unknown }; id?: unknown } | null
  const id = r?.fulfillment?.id ?? r?.id
  return typeof id === "string" && id ? id : null
}

async function recordFailure(
  ctx: BoxtalToolCtx,
  row: FulfillmentShipmentRow,
  code: string,
  message: string,
): Promise<FulfillOutcome> {
  await ctx.db.update("shipment", String(row.id), {
    fulfillment_state: "failed",
    fulfillment_error: message,
  })
  ctx.logger?.warn?.("boxtal: Shopify fulfillment failed", {
    shipmentId: String(row.id),
    code,
    message,
  })
  return { status: "error", code, message }
}

/**
 * Fulfil the Shopify order of one shipment row with its tracking number. Idempotent: a row whose
 * parcel is already on a successful Shopify fulfillment is marked fulfilled without a second call.
 * Never throws; every failure is recorded on the row and returned.
 */
export async function fulfillShipment(
  ctx: BoxtalToolCtx,
  row: FulfillmentShipmentRow,
): Promise<FulfillOutcome> {
  try {
    // The carrier number, or the one printed on the label when the carrier has not scanned yet.
    const tracking = row.tracking_number || (await sourceTrackingFromLabel(ctx, row))
    if (!tracking) {
      return recordFailure(
        ctx,
        row,
        "no_tracking",
        "No tracking number yet: the label is not generated or its number could not be read. The order was not fulfilled. Type the number printed on the label to fulfil with it, or wait for the carrier's first scan.",
      )
    }
    const shopifyOrderId = await shopifyOrderIdForShipment(ctx, row)
    if (!shopifyOrderId) {
      return recordFailure(
        ctx,
        row,
        "not_linked",
        "This shipment is not linked to a Shopify order, so there is nothing to fulfil. Fulfil it in Shopify by hand.",
      )
    }

    const existing = await fulfillmentCarryingTracking(ctx, shopifyOrderId, tracking)
    if (existing) {
      const id = typeof existing.id === "string" && existing.id ? existing.id : null
      await ctx.db.update("shipment", String(row.id), {
        fulfillment_synced: true,
        fulfillment_state: "fulfilled",
        fulfillment_error: null,
        fulfillment_approval_id: null,
        ...(id ? { shopify_fulfillment_id: id } : {}),
      })
      return { status: "fulfilled", fulfillment_id: id, tracking_number: tracking, already: true }
    }

    // A PARTIAL batch fulfils only its own lines (mapped by sku). Lines with no sku cannot be
    // mapped, and fulfilling the whole order instead would over-fulfil it.
    const partialLines = Array.isArray(row.line_quantities)
      ? row.line_quantities.filter((l) => l.quantity > 0)
      : null
    if (partialLines && partialLines.some((l) => !l.external_id)) {
      return recordFailure(
        ctx,
        row,
        "partial_without_sku",
        "This partial shipment has lines without a SKU, so its items cannot be matched on the Shopify order. Fulfil it in Shopify by hand.",
      )
    }
    // ONE fulfillment intent per parcel. A request already parked for this shipment is withdrawn
    // before the current one is staged (a re-tick, possibly with the carrier's number instead of the
    // label's); when this caller cannot withdraw it (a webhook, or someone else raised it) it is
    // reused, never doubled: two granted approvals would fulfil a partial shipment twice.
    if (row.fulfillment_state === "pending_approval" && row.fulfillment_approval_id) {
      if ((await retirePendingFulfillment(ctx, row.fulfillment_approval_id)) === "kept") {
        return { status: "pending_approval", message: PENDING_MESSAGE }
      }
      await ctx.db.update("shipment", String(row.id), { fulfillment_approval_id: null })
    }
    const env = await ctx.executeTool("shopify:fulfillments_create", {
      // GID, not the bare numeric id: the shopify tool binds it to a GraphQL ID!.
      orderId: toShopifyOrderGid(shopifyOrderId),
      ...(partialLines
        ? { lineItems: partialLines.map((l) => ({ sku: l.external_id, quantity: l.quantity })) }
        : {}),
      // Whether Shopify emails the customer is the shopify app's call (the org's shipping email
      // policy, e.g. retail orders only, B2B never); false is only this caller's default when no
      // policy is set. The tracking rides on the same create, so a policy email carries it.
      fulfillment: { trackingInfo: shopifyTrackingInfo(row, tracking), notifyCustomer: false },
    })
    if (env.status === "pending_approval") {
      await ctx.db.update("shipment", String(row.id), {
        fulfillment_state: "pending_approval",
        fulfillment_error: PENDING_MESSAGE,
        fulfillment_approval_id: env.approval_id ?? null,
      })
      return { status: "pending_approval", message: PENDING_MESSAGE }
    }
    if (env.status !== "completed") {
      return recordFailure(
        ctx,
        row,
        shopifyFailureCode(env),
        `Shopify fulfillment failed: ${envelopeMessage(env)}`,
      )
    }
    const id = fulfillmentIdFromResult(env.result)
    await ctx.db.update("shipment", String(row.id), {
      fulfillment_synced: true,
      fulfillment_state: "fulfilled",
      fulfillment_error: null,
      fulfillment_approval_id: null,
      fulfilled_at: new Date().toISOString(),
      ...(id ? { shopify_fulfillment_id: id } : {}),
    })
    return { status: "fulfilled", fulfillment_id: id, tracking_number: tracking, already: false }
  } catch (err) {
    return recordFailure(
      ctx,
      row,
      "unexpected",
      `Shopify fulfillment failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Cancel the Shopify fulfillment a shipment row is on. The fulfillment id is the one stored when
 * the row was fulfilled, or, for a row fulfilled before ids were stored, the order's live
 * fulfillment carrying this parcel's tracking number. Never throws.
 */
export async function unfulfillShipment(
  ctx: BoxtalToolCtx,
  row: FulfillmentShipmentRow,
): Promise<UnfulfillOutcome> {
  try {
    let fulfillmentId = row.shopify_fulfillment_id ?? null
    if (!fulfillmentId) {
      const shopifyOrderId = await shopifyOrderIdForShipment(ctx, row)
      if (shopifyOrderId && row.tracking_number) {
        const found = await fulfillmentCarryingTracking(ctx, shopifyOrderId, row.tracking_number)
        if (found === undefined) {
          return {
            status: "error",
            code: "shopify_unreachable",
            message: "Could not read the Shopify order, so the fulfillment was not cancelled.",
          }
        }
        fulfillmentId = typeof found?.id === "string" && found.id ? found.id : null
      }
    }
    if (!fulfillmentId) {
      // Nothing on Shopify carries this parcel: there is no fulfillment to cancel.
      await ctx.db.update("shipment", String(row.id), {
        fulfillment_synced: false,
        fulfillment_state: "cancelled",
        fulfillment_error: null,
        shopify_fulfillment_id: null,
      })
      return { status: "cancelled" }
    }
    const env = await ctx.executeTool("shopify:fulfillments_cancel", { id: fulfillmentId })
    if (env.status === "pending_approval") {
      return {
        status: "pending_approval",
        message:
          "Cancelling the fulfillment is waiting for approval by someone allowed to approve it. The order is still fulfilled.",
      }
    }
    if (env.status !== "completed") {
      return {
        status: "error",
        code: "shopify_error",
        message: `Shopify did not cancel the fulfillment: ${envelopeMessage(env)}`,
      }
    }
    await ctx.db.update("shipment", String(row.id), {
      fulfillment_synced: false,
      fulfillment_state: "cancelled",
      fulfillment_error: null,
      shopify_fulfillment_id: null,
    })
    return { status: "cancelled" }
  } catch (err) {
    return {
      status: "error",
      code: "unexpected",
      message: `Shopify did not cancel the fulfillment: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
