// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One-time (and thereafter self-healing) fill of the buy-time snapshot for shipments bought
// BEFORE the snapshot existed.
//
// Without this, every parcel already in the queue on the day this shipped would read as dashes in
// the new columns — which, to the operator who asked for those columns, is indistinguishable from
// the feature not working. The rows are few and bounded, so paying for one draft resolution each,
// once, is worth it.
//
// It is NOT a substitute for the write at buy time. A backfilled row is re-resolved from the
// invoice as it reads TODAY, which is the best available approximation and can differ from what
// was actually in the box if the invoice moved since. Rows bought from here on carry the real
// thing. That is why this only ever fills an EMPTY snapshot and never overwrites one.
import type { BoxtalToolCtx } from "./ctx"
import { buildQueueFacts, type QueueFacts } from "./queue-facts"
import { summarizeProducts } from "./draft-cache"
import { shipmentDraftCreate } from "./shipment"
import { isLiveShipment } from "./link-store"

/** Bounded per run: resolution costs an invoicing read per row, and this is a repair pass, not a
 *  hot path. A backlog larger than this simply finishes on the next run. */
export const DEFAULT_BACKFILL_LIMIT = 25

export interface BackfillResult {
  /** Rows missing a snapshot at the start of this run. */
  candidates: number
  /** Rows this run actually attempted (bounded by the limit). */
  attempted: number
  /** Rows whose snapshot was written. */
  filled: number
  /** Rows whose draft could not be resolved — logged and left for a later run. */
  failed: number
}

interface BackfillRow {
  id: string | number
  kind?: string | null
  document_ref?: string | null
  order_status?: string | null
  link_state?: string | null
  queue_facts?: unknown
}

/** A row needs the snapshot when it is still live, anchored on a document, and has none — or when
 *  what it has is known to be wrong (see `hasWrongReturnCategory`). */
export function needsQueueFacts(row: BackfillRow): boolean {
  if (!isLiveShipment(row)) return false
  if (!row.document_ref) return false
  const f = row.queue_facts
  if (f == null) return true
  if (typeof f === "string") {
    const t = f.trim()
    if (t === "" || t === "null" || t === "{}") return true
    try {
      const parsed = JSON.parse(t)
      return hasWrongReturnCategory(row.kind, parsed) || missesProducts(parsed)
    } catch {
      // Unparseable is worse than absent: redo it.
      return true
    }
  }
  if (typeof f !== "object") return true
  if (Object.keys(f as object).length === 0) return true
  return hasWrongReturnCategory(row.kind, f) || missesProducts(f)
}

/** A snapshot written before the products summary existed: it has the count but not WHAT the
 *  items are, which is the half the operator actually needed. Cheap to redo, so redo it. */
export function missesProducts(facts: unknown): boolean {
  if (facts == null || typeof facts !== "object") return false
  const f = facts as { items?: unknown; products?: unknown }
  return f.items != null && f.products == null
}

/**
 * An inbound return whose snapshot says "sale".
 *
 * The first backfill wrote the default category onto returns, and the Returns queue then typed two
 * repair returns as sales (caught by walking prod on 2026-09-14). The write path stopped doing it,
 * but rows already carrying the false value would have kept it forever, because a row WITH a
 * snapshot was never revisited. This is the one case where the backfill overwrites.
 */
export function hasWrongReturnCategory(kind: string | null | undefined, facts: unknown): boolean {
  if (kind !== "return") return false
  if (facts == null || typeof facts !== "object") return false
  return (facts as { category?: unknown }).category === "sale"
}

export async function backfillQueueFacts(
  ctx: BoxtalToolCtx,
  opts: { limit?: number } = {},
): Promise<BackfillResult> {
  const limit = opts.limit ?? DEFAULT_BACKFILL_LIMIT
  const rows = (await ctx.db.findMany("shipment", { limit: 500 })) as BackfillRow[]
  const candidates = rows.filter(needsQueueFacts)
  const batch = candidates.slice(0, limit)

  let filled = 0
  let failed = 0
  for (const row of batch) {
    try {
      const draft = await shipmentDraftCreate(ctx, { document_ref: String(row.document_ref), orderShipTo: false })
      const metas = (await ctx.db.findMany("prep_meta", {
        where: { document_ref: String(row.document_ref) },
        limit: 1,
      })) as Array<{ order_name?: string | null; order_created_at?: string | null; staff_note?: string | null }>
      const facts: QueueFacts = buildQueueFacts({ ...draft, products: summarizeProducts(draft) }, metas[0] ?? {}, {
        kind: row.kind === "return" ? "return" : "outbound",
      })
      await ctx.db.update("shipment", String(row.id), { queue_facts: facts })
      filled++
    } catch (err) {
      failed++
      ctx.logger?.warn?.("boxtal backfill-queue-facts: row skipped", {
        shipmentId: String(row.id),
        err: String(err),
      })
    }
  }

  const result: BackfillResult = {
    candidates: candidates.length,
    attempted: batch.length,
    filled,
    failed,
  }
  ctx.logger?.info?.("boxtal backfill-queue-facts run", result)
  return result
}

/** Kernel-shaped `(payload, ctx)` wrapper the manifest `jobs` entry names. */
export const backfillQueueFactsJobHandler = (
  payload: { limit?: number } | undefined,
  ctx: BoxtalToolCtx,
): Promise<BackfillResult> => backfillQueueFacts(ctx, payload ?? {})
