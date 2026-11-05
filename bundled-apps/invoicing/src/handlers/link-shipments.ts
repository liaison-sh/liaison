// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shipment write back: an invoice learns the parcel that carries it.
//
// The boxtal app creates a shipment AGAINST an invoicing document (its `document_ref` is the
// document id), but nothing ever told the invoice: the order -> invoice -> parcel chain resolved
// in one direction only. This scheduled job closes it through boxtal's PUBLIC search tool (its
// `document_ref` field is searchable and returned on every hit), so neither app reaches into the
// other's tables and boxtal needs no change.
//
// What is written: `external_refs.shipments`, one entry per live shipment
// ({ shipment_id, tracking_number, carrier }), plus a `shipment_linked` lifecycle entry. NOT the
// `shipment_ref` column: that column identifies a per shipment PROFORMA batch and is part of the
// (shopify_order_id, scope, shipment_ref) uniqueness key. A legal invoice carrying it would stop
// counting as the order's billing document, and the order webhook would issue a duplicate.
//
// Bounded and self limiting: it looks at recent shippable invoices only (goods or whole order
// scope, issued within the window), asks boxtal once per document, and a linked document is not
// asked again. A cancelled shipment is never linked. Best effort: boxtal not installed, or any one
// lookup failing, never fails the run.

/** Days after issue during which an unlinked invoice is still looked up. */
const DEFAULT_WINDOW_DAYS = 60
/** Documents asked about per run: each costs one boxtal:search call. */
const DEFAULT_BATCH = 25
/** Most recent documents scanned per run. */
const SCAN_LIMIT = 300

export interface LinkShipmentsDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface LinkShipmentsCtx {
  db: LinkShipmentsDb
  executeTool(
    target: string,
    args: Record<string, unknown>,
  ): Promise<{
    status: "completed" | "pending_approval" | "error"
    result?: unknown
    error?: { code?: string; message?: string }
  }>
}

export interface LinkedShipment {
  shipment_id: string
  tracking_number: string | null
  carrier: string | null
}

export interface LinkShipmentsResult {
  scanned: number
  asked: number
  linked: number
  errors: Array<{ id: string; reason: string }>
  /** Set when boxtal is not reachable: the run stopped without asking further. */
  stopped?: string
}

const SHIPPABLE_STATUSES = new Set(["issued", "sent", "paid", "overdue"])

function nonBlank(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

/** The shipments already linked to a document (`external_refs.shipments`). */
export function linkedShipments(refs: unknown): LinkedShipment[] {
  const raw = (refs as Record<string, unknown> | null | undefined)?.shipments
  if (!Array.isArray(raw)) return []
  return raw
    .map((s) => s as Record<string, unknown>)
    .filter((s) => typeof s.shipment_id === "string" && s.shipment_id !== "")
    .map((s) => ({
      shipment_id: String(s.shipment_id),
      tracking_number: nonBlank(s.tracking_number),
      carrier: nonBlank(s.carrier),
    }))
}

function isCandidate(r: Record<string, unknown>, cutoff: string): boolean {
  if (r.type !== "invoice") return false
  if (!SHIPPABLE_STATUSES.has(String(r.status ?? ""))) return false
  // The services half of a split order never ships; a per shipment proforma IS the batch.
  if (r.scope === "software") return false
  if (nonBlank(r.shipment_ref)) return false
  const issued = nonBlank(r.issued_at)
  if (!issued || issued.slice(0, 10) < cutoff) return false
  return linkedShipments(r.external_refs).length === 0
}

export async function linkShipments(
  ctx: LinkShipmentsCtx,
  opts?: { now?: Date; windowDays?: number; batchSize?: number },
): Promise<LinkShipmentsResult> {
  const now = opts?.now ?? new Date()
  const windowDays = opts?.windowDays ?? DEFAULT_WINDOW_DAYS
  const batchSize = opts?.batchSize ?? DEFAULT_BATCH
  const cutoff = new Date(now.getTime() - windowDays * 86_400_000).toISOString().slice(0, 10)
  const result: LinkShipmentsResult = { scanned: 0, asked: 0, linked: 0, errors: [] }

  const rows = (await ctx.db.findMany("documents", {
    where: { type: "invoice" },
    orderBy: { createdAt: "desc" },
    limit: SCAN_LIMIT,
  })) as Array<Record<string, unknown>>
  result.scanned = rows.length
  const candidates = rows.filter((r) => isCandidate(r, cutoff)).slice(0, batchSize)

  for (const doc of candidates) {
    const id = String(doc.id)
    result.asked += 1
    let env: Awaited<ReturnType<LinkShipmentsCtx["executeTool"]>>
    try {
      env = await ctx.executeTool("boxtal:search", { query: id, limit: 10 })
    } catch (err) {
      result.errors.push({ id, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (env.status !== "completed") {
      const code = env.error?.code ?? env.status
      // Boxtal absent or not callable: nothing further this run can learn.
      if (code === "target_app_unavailable" || code === "app_not_installed") {
        result.stopped = code
        break
      }
      result.errors.push({ id, reason: code })
      continue
    }
    const hits = ((env.result as { results?: unknown[] } | null)?.results ?? []) as Array<{
      id?: unknown
      attributes?: Record<string, unknown>
    }>
    const shipments: LinkedShipment[] = hits
      .filter((h) => h.attributes?.document_ref === id && h.attributes?.order_status !== "CANCELLED")
      .map((h) => ({
        shipment_id: String(h.id),
        tracking_number: nonBlank(h.attributes?.tracking_number),
        carrier: nonBlank(h.attributes?.carrier),
      }))
    if (shipments.length === 0) continue
    if (await mergeShipmentLink(ctx.db, id, shipments, now)) result.linked += 1
  }
  return result
}

/**
 * Write the link as a MERGE onto the document as it is NOW, never onto the snapshot the scan read
 * before its boxtal calls: a refund, a payment or a send recorded on the same invoice in between
 * lives in the very lifecycle_log (and external_refs) this writes, and lifecycle_log feeds the
 * cumulative refund total. The row is locked first with a no-op `update` of its immutable number (the
 * job runs atomic, so the lock holds until commit and a concurrent writer waits behind it), then
 * re-read, then patched: our entry appended to the current log, `shipments` set on the current refs.
 * Returns false when the document vanished or another run linked it meanwhile.
 */
export async function mergeShipmentLink(
  db: LinkShipmentsDb,
  id: string,
  shipments: LinkedShipment[],
  now: Date,
): Promise<boolean> {
  const before = (await db.findOne("documents", id)) as Record<string, unknown> | null
  if (!before) return false
  if (typeof before.number === "string" && before.number !== "") {
    // By id through `update`: the bridge refuses `where.id` on updateMany, which made this lock
    // throw on every prod run. The number of an issued document never changes, so writing it
    // back is a true no-op that still takes the row lock.
    await db.update("documents", id, { number: before.number })
  }
  const fresh = (await db.findOne("documents", id)) as Record<string, unknown> | null
  if (!fresh) return false
  if (linkedShipments(fresh.external_refs).length > 0) return false
  const refs = (fresh.external_refs as Record<string, unknown> | null) ?? {}
  const log = (fresh.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
  await db.update("documents", id, {
    external_refs: { ...refs, shipments },
    lifecycle_log: [
      ...log,
      {
        event: "shipment_linked",
        actor: "system",
        ts: now.toISOString(),
        shipment_ids: shipments.map((s) => s.shipment_id),
      },
    ],
  })
  return true
}

/** Kernel shaped `(payload, ctx)` job wrapper (same pattern as the other scheduled jobs). */
export async function linkShipmentsJobHandler(
  _payload: unknown,
  ctx: LinkShipmentsCtx,
  opts?: { now?: Date; windowDays?: number; batchSize?: number },
): Promise<LinkShipmentsResult> {
  return linkShipments(ctx, opts)
}
