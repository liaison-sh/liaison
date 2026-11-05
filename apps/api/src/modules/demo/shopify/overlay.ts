// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a visitor CHANGES in the demo store.
//
// A demo where nothing can be done is a weak demo: the whole point of showing
// Boxtal is that the operator picks an order, buys a label and watches the row
// leave the worklist. So writes are ACCEPTED, into this per-org overlay, rather
// than refused: the fixtures stay immutable and read-only, and every write is a
// small patch laid over one record on read.
//
// Why an overlay and not a table:
//   * a demo org is disposable by construction (a visitor org expires, the
//     reserved org is reseeded nightly), so durability across a restart buys
//     nothing a fresh, coherent store does not buy more cheaply,
//   * no migration, so no ledger slot, and nothing to undo when the demo is
//     retired,
//   * the reset is exact: `resetDemoShopifyOverlay(orgId)` at seed time puts the
//     store back to the book, which is what the nightly reset needs and what a
//     truncate of a table would only approximate.
//
// It is BOUNDED. A public box hands strangers a write path, so the overlay caps
// both the number of orgs it remembers and the number of records per org, and
// drops the least recently touched org rather than growing without limit.
//
// Only the writes that tell a story are modelled (tagging, notes, fulfilment,
// refunds, creating and completing a quote, cancelling, creating a discount code). Everything else is refused with the
// demo message, which is the honest answer: the demo store cannot do it.
import type { DemoDraftOrder, DemoFulfillment, DemoOrder, DemoRefund } from "./fixtures"

/** Orgs remembered at once. Past this, the least recently written one is dropped. */
const MAX_ORGS = 200
/** Records patched per org. Past this, a further write is refused. */
const MAX_RECORDS_PER_ORG = 500

export interface OrderPatch {
  tags?: string[]
  note?: string | null
  email?: string | null
  fulfillmentStatus?: string
  financialStatus?: string
  cancelledAt?: string | null
  cancelReason?: string | null
  closed?: boolean
  addedFulfillments?: DemoFulfillment[]
  addedRefunds?: DemoRefund[]
}

export interface DraftPatch {
  status?: string
  orderId?: string | null
  orderName?: string | null
  tags?: string[]
}

export interface CustomerPatch {
  tags?: string[]
}

/** A finished `discountRedeemCodeBulkAdd` job. The demo runs it synchronously. */
export interface DemoBulkCodeJob {
  id: string
  discountId: string
  codesCount: number
  importedCount: number
  failedCount: number
}

/**
 * A discount code a visitor created. The book has no discounts, so unlike the
 * patches above this is a whole record, appended in creation order.
 */
export interface DemoCreatedDiscount {
  id: string
  title: string
  /** The code the discount was created with. */
  code: string
  /** Codes bulk-added after creation, in the order they were added. */
  extraCodes: string[]
  startsAt: string
  endsAt: string | null
  createdAt: string
  usageLimit: number | null
  appliesOncePerCustomer: boolean
  /** The 0-1 fraction off, when the discount is a percentage. */
  percentage: number | null
  /** The fixed amount off in minor units, when it is an amount. */
  amountMinor: number | null
}

interface OrgOverlay {
  orders: Map<string, OrderPatch>
  drafts: Map<string, DraftPatch>
  customers: Map<string, CustomerPatch>
  discounts: DemoCreatedDiscount[]
  /** Quotes (draft orders) created in this org's store, oldest first. */
  createdDrafts: DemoDraftOrder[]
  bulkJobs: Map<string, DemoBulkCodeJob>
  /** Orders a demo scenario placed live (modules/demo/world/commerce-order.ts), newest first. */
  worldOrders: DemoOrder[]
  touchedAt: number
  /**
   * Where this replica stands in the org's shared write log (replica.ts): the
   * log's epoch it follows (null until it first syncs) and how many of its
   * entries it has applied. Kept on the overlay itself, so an evicted overlay
   * starts again from the log's first entry.
   */
  epoch: string | null
  applied: number
}

const overlays = new Map<string, OrgOverlay>()

/** Thrown when the overlay will not take another record for this org. */
export class DemoOverlayFullError extends Error {}

function orgOverlay(orgId: string, create: boolean): OrgOverlay | undefined {
  const existing = overlays.get(orgId)
  if (existing) {
    existing.touchedAt = Date.now()
    return existing
  }
  if (!create) return undefined
  if (overlays.size >= MAX_ORGS) {
    let oldest: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, entry] of overlays) {
      if (entry.touchedAt < oldestAt) {
        oldestAt = entry.touchedAt
        oldest = id
      }
    }
    if (oldest) overlays.delete(oldest)
  }
  const fresh: OrgOverlay = {
    orders: new Map(),
    drafts: new Map(),
    customers: new Map(),
    discounts: [],
    createdDrafts: [],
    bulkJobs: new Map(),
    worldOrders: [],
    touchedAt: Date.now(),
    epoch: null,
    applied: 0,
  }
  overlays.set(orgId, fresh)
  return fresh
}

function recordCount(overlay: OrgOverlay): number {
  let codes = 0
  for (const discount of overlay.discounts) codes += 1 + discount.extraCodes.length
  return (
    overlay.orders.size +
    overlay.drafts.size +
    overlay.customers.size +
    codes +
    overlay.createdDrafts.length +
    overlay.bulkJobs.size +
    overlay.worldOrders.length
  )
}

function patchSlot<T>(map: Map<string, T>, overlay: OrgOverlay, id: string, empty: T): T {
  const existing = map.get(id)
  if (existing) return existing
  if (recordCount(overlay) >= MAX_RECORDS_PER_ORG) {
    throw new DemoOverlayFullError("demo store write limit reached")
  }
  map.set(id, empty)
  return empty
}

/** The mutable patch for one order, created on first write. */
export function orderPatch(orgId: string, orderId: string): OrderPatch {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  return patchSlot(overlay.orders, overlay, orderId, {})
}

export function draftPatch(orgId: string, draftId: string): DraftPatch {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  return patchSlot(overlay.drafts, overlay, draftId, {})
}

export function customerPatch(orgId: string, customerId: string): CustomerPatch {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  return patchSlot(overlay.customers, overlay, customerId, {})
}

/** Record a created discount. Counts against the same per-org cap as a patch. */
export function addDiscount(orgId: string, discount: DemoCreatedDiscount): void {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  if (recordCount(overlay) >= MAX_RECORDS_PER_ORG) {
    throw new DemoOverlayFullError("demo store write limit reached")
  }
  overlay.discounts.push(discount)
}

/** Record a created quote (draft order). Counts against the same per-org cap as a patch. */
export function addCreatedDraft(orgId: string, draft: DemoDraftOrder): void {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  if (recordCount(overlay) >= MAX_RECORDS_PER_ORG) {
    throw new DemoOverlayFullError("demo store write limit reached")
  }
  overlay.createdDrafts.push(draft)
}

/** The quotes this org created, oldest first. Empty when it created none. */
export function createdDraftsFor(orgId: string): readonly DemoDraftOrder[] {
  return overlays.get(orgId)?.createdDrafts ?? []
}

/**
 * Bulk-add codes to one of this org's discounts and record the finished job.
 * `codes` are the ones to import; `failedCount` the ones refused (duplicates).
 * The whole batch, plus its job, must fit under the per-org cap or nothing is
 * written.
 */
export function addBulkCodes(
  orgId: string,
  discount: DemoCreatedDiscount,
  codes: string[],
  job: DemoBulkCodeJob,
): void {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  if (recordCount(overlay) + codes.length + 1 > MAX_RECORDS_PER_ORG) {
    throw new DemoOverlayFullError("demo store write limit reached")
  }
  discount.extraCodes.push(...codes)
  overlay.bulkJobs.set(job.id, job)
}

/** A bulk-code job this org ran, or undefined. */
export function bulkCodeJob(orgId: string, jobId: string): DemoBulkCodeJob | undefined {
  return overlays.get(orgId)?.bulkJobs.get(jobId)
}

/** How many bulk-code jobs this org has run. Numbers the next job's id. */
export function bulkCodeJobCount(orgId: string): number {
  return overlays.get(orgId)?.bulkJobs.size ?? 0
}

/** The discounts this org has created, oldest first. Empty when it created none. */
export function discountsFor(orgId: string): readonly DemoCreatedDiscount[] {
  return overlays.get(orgId)?.discounts ?? []
}

/** Has this org written anything at all? One map lookup on the read path. */
export function hasOverlay(orgId: string): boolean {
  const overlay = overlays.get(orgId)
  return overlay !== undefined && recordCount(overlay) > 0
}

/** The order as this org now sees it. Returns the fixture untouched when unwritten. */
export function withOrderPatch(orgId: string, order: DemoOrder): DemoOrder {
  const patch = overlays.get(orgId)?.orders.get(order.id)
  if (!patch) return order
  const fulfillments = patch.addedFulfillments
    ? [...order.fulfillments, ...patch.addedFulfillments]
    : order.fulfillments
  const refunds = patch.addedRefunds ? [...order.refunds, ...patch.addedRefunds] : order.refunds
  return {
    ...order,
    tags: patch.tags ?? order.tags,
    note: patch.note !== undefined ? patch.note : order.note,
    email: patch.email !== undefined ? patch.email : order.email,
    fulfillmentStatus: patch.fulfillmentStatus ?? order.fulfillmentStatus,
    financialStatus: patch.financialStatus ?? order.financialStatus,
    cancelledAt: patch.cancelledAt !== undefined ? patch.cancelledAt : order.cancelledAt,
    cancelReason: patch.cancelReason !== undefined ? patch.cancelReason : order.cancelReason,
    closed: patch.closed ?? order.closed,
    fulfillments,
    refunds,
  }
}

export function withDraftPatch(orgId: string, draft: DemoDraftOrder): DemoDraftOrder {
  const patch = overlays.get(orgId)?.drafts.get(draft.id)
  if (!patch) return draft
  return {
    ...draft,
    status: patch.status ?? draft.status,
    tags: patch.tags ?? draft.tags,
    orderId: patch.orderId !== undefined ? patch.orderId : draft.orderId,
    orderName: patch.orderName !== undefined ? patch.orderName : draft.orderName,
  }
}

export function patchedCustomerTags(orgId: string, customerId: string): string[] | undefined {
  return overlays.get(orgId)?.customers.get(customerId)?.tags
}

/**
 * Put a demo org's store back to the fixtures. Called by
 * `installDemoShopifyConnection`, so a re-seed (the nightly reserved org reset, a
 * repeated visitor signup on the same slug) starts from the book every time.
 */
export function resetDemoShopifyOverlay(orgId?: string): void {
  if (orgId === undefined) overlays.clear()
  else overlays.delete(orgId)
}

/**
 * Place an order in a demo org's store, as a scenario's live event: it is listed
 * first (the newest) and found by id like any fixture order. False when the
 * order is already there (the injection is idempotent).
 */
export function addWorldOrder(orgId: string, order: DemoOrder): boolean {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  if (overlay.worldOrders.some((o) => o.id === order.id)) return false
  if (recordCount(overlay) >= MAX_RECORDS_PER_ORG) {
    throw new DemoOverlayFullError("demo store write limit reached")
  }
  overlay.worldOrders.unshift(order)
  return true
}

/** The orders a scenario placed in this org's store, newest first. */
export function worldOrdersFor(orgId: string): readonly DemoOrder[] {
  return overlays.get(orgId)?.worldOrders ?? []
}

/** Where this process's replica of the org's store stands in the shared write log. */
export function replicaCursor(orgId: string): { epoch: string | null; applied: number } {
  const overlay = overlays.get(orgId)
  return overlay ? { epoch: overlay.epoch, applied: overlay.applied } : { epoch: null, applied: 0 }
}

/**
 * Follow the log's `epoch`: an overlay of another epoch (a reset elsewhere)
 * is dropped and starts again; one that never synced adopts it as it is.
 */
export function followReplicaEpoch(orgId: string, epoch: string): void {
  const existing = overlays.get(orgId)
  if (existing && existing.epoch !== null && existing.epoch !== epoch) overlays.delete(orgId)
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  overlay.epoch = epoch
}

/** One more log entry applied to this org's replica. */
export function advanceReplica(orgId: string): void {
  const overlay = orgOverlay(orgId, true) as OrgOverlay
  overlay.applied += 1
}

/** How many orgs and records the overlay is holding. For the bound's own test. */
export const DemoShopifyOverlayTestAccess = {
  stats(): { orgs: number; records: number } {
    let records = 0
    for (const overlay of overlays.values()) records += recordCount(overlay)
    return { orgs: overlays.size, records }
  },
  maxRecordsPerOrg: MAX_RECORDS_PER_ORG,
  maxOrgs: MAX_ORGS,
}
