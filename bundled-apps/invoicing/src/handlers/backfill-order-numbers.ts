// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One-time BACKFILL job — record the HUMAN Shopify order number ("#1149") on
// documents that predate `documents.shopify_order_number` (v0.9.0).
//
// Context: until 0.9.0 a Shopify-synced document recorded only the NUMERIC
// order id ("12768069779622"). That id is the API handle; it is not what a
// customer writes, what the store's order list shows, or what an operator types
// into search. So an invoice could not be found by its order number, and the
// order number could not be read off the document. 0.9.0 records the order name
// at issue time -- this job fills in everything already issued.
//
// Two sources, cheapest first:
//   1. `external_refs.shopify_order_number` -- the CSV importer has always
//      written it, so imported documents need no Shopify call at all.
//   2. `shopify:orders_get(...).name` -- one fetch per unique order for the
//      webhook-era documents that carry only the numeric id.
//
// It does NOT re-render any PDF. The order line appears on documents rendered
// from 0.9.0 onward; an already-issued invoice keeps the exact artifact the
// customer received (and imported documents keep their original supplier PDF as
// the legal artifact). Backfilling the COLUMN is what makes the order number
// searchable and visible in the list and detail views for the whole history.
//
// Idempotent + resumable WITHOUT external cursor state, like the settled-PDF
// backfill before it: a lifecycle_log marker is the progress record, so
// overlapping runs (the cron plus a manual run_routine_now) converge, each
// document is processed once, and the job self-terminates into a no-op.

/** lifecycle_log marker proving this document went through the order-number backfill. */
export const ORDER_NUMBER_BACKFILL_MARKER = "shopify_order_number_backfill_v090"

/** Documents resolved per run. Bounded by the Shopify fetches (one per unique
 *  order), which dominate the runtime. */
const DEFAULT_BATCH = 100
/** Page size for scanning the document set (the bridge caps large limits, so we page). */
const SCAN_PAGE = 500

export interface BackfillDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface BackfillCrossAppEnvelope {
  status: "completed" | "pending_approval" | "error"
  result?: unknown
  error?: { code: string; message: string; retryable?: boolean }
}

export interface BackfillCtx {
  db: BackfillDb
  executeTool(target: string, args: Record<string, unknown>): Promise<BackfillCrossAppEnvelope>
}

export interface BackfillOrderNumbersResult {
  scanned: number
  /** Already carried an order number (column set) or a done-marker. */
  already_done: number
  /** Filled from `external_refs.shopify_order_number` — no Shopify call. */
  filled_from_refs: number
  /** Filled from `shopify:orders_get(...).name`. */
  filled_from_shopify: number
  /** Shopify returned no usable name for the order — marked done so it is not refetched. */
  no_name_available: number
  /** Documents still lacking an order number after this run. */
  remaining: number
  errors: Array<{ id: string; reason: string }>
}

interface CandidateRow {
  id: string
  order_id: string | null
  order_number: string | null
  external_refs: Record<string, unknown>
  lifecycle_log: Array<Record<string, unknown>>
}

function nonBlank(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

function toCandidate(row: unknown): CandidateRow {
  const r = row as Record<string, unknown>
  const refs = (r.external_refs as Record<string, unknown> | null) ?? {}
  return {
    id: String(r.id),
    order_id: nonBlank(r.shopify_order_id) ?? nonBlank(refs.shopify_order_id),
    order_number: nonBlank(r.shopify_order_number),
    external_refs: refs,
    lifecycle_log: (r.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
  }
}

function alreadyMarked(doc: CandidateRow): boolean {
  return doc.lifecycle_log.some((e) => e.event === ORDER_NUMBER_BACKFILL_MARKER)
}

function toGid(orderId: string): string {
  return orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`
}

/** `shopify:orders_get` returns the order name top-level; tolerate the
 *  `.attributes` nesting the same way reconcile does. */
function extractOrderName(result: unknown): string | null {
  const r = (result as Record<string, unknown>) ?? {}
  const attrs = (r.attributes as Record<string, unknown> | undefined) ?? {}
  return nonBlank(r.name) ?? nonBlank(attrs.name)
}

/**
 * Fill the order number on up to `batchSize` documents that carry a Shopify
 * order id but no order number yet. Scans the WHOLE document set (id-asc) so it
 * keeps finding unmarked work after the low ids are done, whatever cap the
 * bridge applies to `limit`.
 */
export async function backfillOrderNumbers(
  ctx: BackfillCtx,
  opts?: { batchSize?: number; now?: Date },
): Promise<BackfillOrderNumbersResult> {
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH
  const now = opts?.now ?? new Date()

  const result: BackfillOrderNumbersResult = {
    scanned: 0,
    already_done: 0,
    filled_from_refs: 0,
    filled_from_shopify: 0,
    no_name_available: 0,
    remaining: 0,
    errors: [],
  }

  const toProcess: CandidateRow[] = []
  let offset = 0
  // Advance by the ACTUAL page length and stop on an empty page — never assume
  // the bridge honors SCAN_PAGE.
  for (;;) {
    const page = (await ctx.db.findMany("documents", {
      orderBy: { id: "asc" },
      limit: SCAN_PAGE,
      offset,
    })) as unknown[]
    if (page.length === 0) break
    result.scanned += page.length
    for (const row of page) {
      const doc = toCandidate(row)
      // A document with no order id has no order number to find — not a candidate,
      // and not "remaining" work either.
      if (!doc.order_id) continue
      if (doc.order_number || alreadyMarked(doc)) {
        result.already_done += 1
        continue
      }
      if (toProcess.length < batchSize) toProcess.push(doc)
      else result.remaining += 1
    }
    offset += page.length
  }

  // One Shopify fetch per UNIQUE order — a split order (goods + software) is two
  // documents sharing one order, and both want the same name.
  const nameByOrderId = new Map<string, string | null>()
  const fetchName = async (orderId: string): Promise<string | null> => {
    const cached = nameByOrderId.get(orderId)
    if (cached !== undefined) return cached
    let name: string | null = null
    const envelope = await ctx.executeTool("shopify:orders_get", { id: toGid(orderId) })
    if (envelope.status === "completed") name = extractOrderName(envelope.result)
    nameByOrderId.set(orderId, name)
    return name
  }

  for (const doc of toProcess) {
    try {
      const fromRefs = nonBlank(doc.external_refs.shopify_order_number)
      const orderNumber = fromRefs ?? (await fetchName(doc.order_id as string))
      // Mark the document processed either way. A marked document with no number
      // means Shopify had no name for that order; without the marker the job would
      // refetch it forever and never terminate.
      const patch: Record<string, unknown> = {
        lifecycle_log: [
          ...doc.lifecycle_log,
          {
            event: ORDER_NUMBER_BACKFILL_MARKER,
            ts: now.toISOString(),
            ...(orderNumber ? { order_number: orderNumber } : { outcome: "no_name_available" }),
          },
        ],
      }
      if (orderNumber) {
        patch.shopify_order_number = orderNumber
        patch.external_refs = { ...doc.external_refs, shopify_order_number: orderNumber }
      }
      await ctx.db.update("documents", doc.id, patch)
      if (!orderNumber) result.no_name_available += 1
      else if (fromRefs) result.filled_from_refs += 1
      else result.filled_from_shopify += 1
    } catch (err) {
      // Left unmarked on purpose — a transient Shopify/DB failure is retried next run.
      result.remaining += 1
      result.errors.push({
        id: doc.id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/**
 * Kernel-shaped `(payload, ctx)` job wrapper — the manifest cannot call the
 * readable `(ctx, opts)` form directly (mirrors reconcileShopifyPaymentsJobHandler).
 */
export async function backfillOrderNumbersJobHandler(
  _payload: unknown,
  ctx: BackfillCtx,
  opts?: { batchSize?: number; now?: Date },
): Promise<BackfillOrderNumbersResult> {
  return backfillOrderNumbers(ctx, opts)
}
