// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ready_set_packed — the warehouse bench tick on a Ready-to-ship row, and the moment the order is
// fulfilled on Shopify.
//
// The packer works the queue top down: print, box, tape, put it on the pickup pallet, tick. The
// tick used to stamp `packed_at` and nothing else, so a ticked row looked done while the Shopify
// order stayed unfulfilled and the customer never got a tracking number (order #3475, 2026-09-29:
// ticked, no error, nothing on Shopify).
//
// Ticking now fulfils the Shopify order with the parcel's tracking number (fulfillment.ts), and the
// tick only lands when that succeeds: a failed or merely staged fulfillment returns its reason and
// the row stays unticked. Unticking a fulfilled row cancels the Shopify fulfillment, and only after
// the operator confirmed it (`confirm_unfulfill`), so an untick is never purely visual.
//
// The state lives on the SHIPMENT row: one parcel is packed, not "an order". `packed_at` is a
// timestamp, so WHEN the parcel was boxed is kept; "packed" is simply `packed_at != null`.
//
// Gating: shopify:fulfillments_create / _cancel are gated. Reached from a direct click by a user who
// may approve, the click is the decision and they run at once; from an agent, they park an approval
// and this tool reports `pending_approval` without ticking.

import type { BoxtalToolCtx } from "./ctx"
import {
  type FulfillmentShipmentRow,
  fulfillShipment,
  retirePendingFulfillment,
  shopifyOrderIdForShipment,
  unfulfillShipment,
} from "./fulfillment"
import { isValidCarrierTracking, labelCarrierOf } from "./label-tracking"
import { readQueueFacts } from "./queue-facts"
import { findShipmentByRef } from "./shipment-lookup"

type Ctx = BoxtalToolCtx

export interface ReadySetPackedInput {
  /** The local shipment row id (a ready_list row id) or the Boxtal order id. */
  shipment_id: string
  /** true packs and fulfils the order, false unpacks (and cancels the fulfillment, once confirmed). */
  packed: boolean
  /** Required to untick a row whose order is fulfilled: the operator confirmed the cancellation. */
  confirm_unfulfill?: boolean
  /** With packed:true on a row that has no tracking number: the number the operator read off the
   *  label, for when the app could not read it (the way out of "No tracking number yet"). */
  tracking_number?: string
}

export interface ReadySetPackedResult {
  shipment_id: string
  packed: boolean
  packed_at: string | null
  /** Where the Shopify fulfillment of this parcel stands after the call. */
  fulfillment_state: string | null
  fulfillment_error: string | null
  tracking_number: string | null
  /** The order number, for the confirmation the UI shows before unfulfilling. */
  order_name: string | null
  /** A non-error remark, e.g. a parcel with no Shopify order to fulfil. */
  notice?: string
  error?: { code: string; message: string }
}

interface ShipmentRowView extends FulfillmentShipmentRow {
  packed_at?: string | null
  fulfillment_error?: string | null
  queue_facts?: unknown
}

function view(
  row: ShipmentRowView,
  patch: Partial<ReadySetPackedResult> = {},
): ReadySetPackedResult {
  return {
    shipment_id: String(row.id),
    packed: row.packed_at != null,
    packed_at: row.packed_at ?? null,
    fulfillment_state: row.fulfillment_state ?? null,
    fulfillment_error: row.fulfillment_error ?? null,
    tracking_number: row.tracking_number ?? null,
    order_name: readQueueFacts(row.queue_facts).order_name ?? null,
    ...patch,
  }
}

async function loadRow(ctx: Ctx, ref: string): Promise<ShipmentRowView | null> {
  return findShipmentByRef<ShipmentRowView>(ctx, ref)
}

/** A number typed by the operator: no spaces, uppercase. */
function normaliseTypedTracking(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase()
}

/** The carrier's own format (and check digit where it has one) when we know the carrier; any
 *  other carrier, a plausible tracking number. */
function typedTrackingIsValid(offerCode: string | null | undefined, n: string): boolean {
  const carrier = labelCarrierOf(offerCode)
  if (carrier) return isValidCarrierTracking(carrier, n)
  return /^[A-Z0-9]{8,40}$/.test(n)
}

function isFulfilled(row: ShipmentRowView): boolean {
  return (
    row.fulfillment_state === "fulfilled" ||
    (row.fulfillment_synced === true && row.fulfillment_state !== "cancelled")
  )
}

/**
 * Pack (and fulfil) or unpack (and unfulfil) one shipment row. Resolved by local `id` first, then
 * by `boxtal_order_id`, the way printPack resolves a ready_list row.
 */
export async function readySetPacked(
  ctx: Ctx,
  input: ReadySetPackedInput,
): Promise<ReadySetPackedResult> {
  const ref = String(input.shipment_id ?? "").trim()
  const empty: ReadySetPackedResult = {
    shipment_id: ref,
    packed: false,
    packed_at: null,
    fulfillment_state: null,
    fulfillment_error: null,
    tracking_number: null,
    order_name: null,
  }
  if (!ref) {
    return {
      ...empty,
      error: { code: "invalid_params", message: "shipment_id is required (a ready_list row id)." },
    }
  }
  const row = await loadRow(ctx, ref)
  if (!row) {
    return { ...empty, error: { code: "not_found", message: `No shipment row matches "${ref}".` } }
  }
  const id = String(row.id)

  if (input.packed === true) {
    const typed =
      typeof input.tracking_number === "string" ? normaliseTypedTracking(input.tracking_number) : ""
    if (typed) {
      if (row.tracking_number && row.tracking_number !== typed) {
        return view(row, {
          error: {
            code: "tracking_already_set",
            message: `This parcel already has tracking number ${row.tracking_number}; a typed number never replaces it.`,
          },
        })
      }
      if (!typedTrackingIsValid(row.offer_code, typed)) {
        return view(row, {
          error: {
            code: "invalid_tracking_number",
            message: `"${typed}" is not a tracking number for this carrier. Type the number printed next to TRK# (or the carrier's tracking number) on the label.`,
          },
        })
      }
      if (!row.tracking_number) {
        // Not a carrier event: flagged like a number read off the label, so the carrier's own number
        // replaces it at its first scan, and it never triggers the automatic fulfillment.
        await ctx.db.update("shipment", id, {
          tracking_number: typed,
          tracking_from_label: true,
          tracking_to_confirm: false,
        })
        row.tracking_number = typed
        row.tracking_from_label = true
      }
    }
    // A parcel with no Shopify order behind it (a repair return, a manual shipment) has nothing to
    // fulfil: it can still be packed, and the result says why no fulfillment happened.
    if (!(await shopifyOrderIdForShipment(ctx, row))) {
      const packedAt = new Date().toISOString()
      await ctx.db.update("shipment", id, { packed_at: packedAt })
      return view(
        { ...row, packed_at: packedAt },
        { notice: "Not linked to a Shopify order: marked packed, there is no order to fulfil." },
      )
    }
    const outcome = await fulfillShipment(ctx, row)
    const fresh = (await loadRow(ctx, id)) ?? row
    if (outcome.status !== "fulfilled") {
      // The tick does not land: the row stays unpacked, with the reason on it.
      return view(fresh, {
        error: {
          code: outcome.status === "pending_approval" ? "pending_approval" : outcome.code,
          message: outcome.message,
        },
      })
    }
    const packedAt = new Date().toISOString()
    await ctx.db.update("shipment", id, { packed_at: packedAt })
    return view({ ...fresh, packed_at: packedAt })
  }

  // Unpacking.
  if (row.fulfillment_state === "pending_approval") {
    // Nothing reached Shopify yet, but a request to fulfil is parked: unticking withdraws it, so
    // nobody approves a fulfillment the operator took back.
    if (
      row.fulfillment_approval_id &&
      (await retirePendingFulfillment(ctx, row.fulfillment_approval_id)) === "kept"
    ) {
      return view(row, {
        error: {
          code: "approval_not_withdrawn",
          message:
            "The pending fulfillment request could not be withdrawn (only the person who raised it can). Deny it in the approvals instead.",
        },
      })
    }
    await ctx.db.update("shipment", id, {
      fulfillment_state: null,
      fulfillment_error: null,
      fulfillment_approval_id: null,
    })
  } else if (isFulfilled(row)) {
    const orderName = readQueueFacts(row.queue_facts).order_name ?? null
    if (input.confirm_unfulfill !== true) {
      return view(row, {
        error: {
          code: "confirm_required",
          message: `Confirm unfulfilling order ${orderName ?? "of this parcel"}? The Shopify fulfillment will be cancelled.`,
        },
      })
    }
    const outcome = await unfulfillShipment(ctx, row)
    if (outcome.status !== "cancelled") {
      // The untick does not land either: the order is still fulfilled, so the row stays packed.
      const fresh = (await loadRow(ctx, id)) ?? row
      return view(fresh, {
        error: {
          code: outcome.status === "pending_approval" ? "pending_approval" : outcome.code,
          message: outcome.message,
        },
      })
    }
  }
  await ctx.db.update("shipment", id, { packed_at: null })
  const fresh = (await loadRow(ctx, id)) ?? row
  return view({ ...fresh, packed_at: null })
}
