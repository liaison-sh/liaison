// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One sale on Stripe, one legal invoice. A sale has up to two names: the Stripe invoice (in_...)
// and its charge (ch_...). A document takes one of them as its unique `external_ref`, so two
// documents of one sale made under different names would both commit. `stripe_sales` holds every
// name of a sale that has a document, one row per name, unique: the batch that numbers an invoice
// (and the one that links a payment to an invoice made by hand) writes the rows with the document,
// so of two transactions on one sale one commits and the other rolls back with its number.
//
// Every path that issues asks `saleDocument` first: the finalized and paid events, the retry, the
// safety job, a person's click and the approval of the threshold card.
import type { IssueBatchOp } from "../issue"
import type { MutationsCtx } from "../mutations/shared"

type Row = Record<string, unknown>
/** Reads and the claim batch only (the issuing flows hold narrower db handles than mutations). */
type Db = { db: Pick<MutationsCtx["db"], "findMany" | "batch"> }

export const STRIPE_SALES = "stripe_sales"

export const stripeRef = (id: string) => `stripe:${id}`

/** The names of a sale as document keys, sorted (two transactions claim them in one order). */
export function saleKeys(ids: ReadonlyArray<string | null | undefined>): string[] {
  const named = ids.filter((id): id is string => typeof id === "string" && id !== "")
  return [...new Set(named.map(stripeRef))].sort()
}

const isCharge = (key: string) => /^stripe:(ch|py)_/.test(key)
const PAGE = 1000

/** Invoices linked to these charges by hand, by charge (`external_refs.stripe_charge_id`): every
 *  invoice is read, a page of the three fields at a time, and none is missed. */
export async function invoicesLinkedTo(
  ctx: Db,
  chargeIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const left = new Set(chargeIds)
  for (let offset = 0; left.size > 0; offset += PAGE) {
    const page = (await ctx.db.findMany("documents", {
      where: { type: "invoice" },
      select: ["id", "external_refs"],
      orderBy: { id: "asc" },
      limit: PAGE,
      offset,
    })) as Row[]
    for (const d of page) {
      const charge = (d.external_refs as Row | null)?.stripe_charge_id
      if (typeof charge !== "string" || !left.delete(charge)) continue
      out.set(charge, String(d.id))
    }
    if (page.length < PAGE) return out
  }
  return out
}

async function documentById(ctx: Db, id: string): Promise<Row | null> {
  const rows = (await ctx.db.findMany("documents", { where: { id }, limit: 1 })) as Row[]
  return rows[0] ?? null
}

/** Documents of sales by any of these keys: the key itself, or a row of `stripe_sales`. */
export async function documentIdsByKey(
  ctx: Db,
  keys: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < keys.length; i += PAGE) {
    const some = keys.slice(i, i + PAGE)
    const claims = (await ctx.db.findMany(STRIPE_SALES, {
      where: { key: { in: some } },
      limit: some.length,
    })) as Row[]
    for (const c of claims) out.set(String(c.key), String(c.document_id))
    const docs = (await ctx.db.findMany("documents", {
      where: { external_ref: { in: some } },
      select: ["id", "external_ref"],
      limit: some.length,
    })) as Row[]
    for (const d of docs) out.set(String(d.external_ref), String(d.id))
  }
  return out
}

/**
 * The document a sale already has, under any of its names: issued from Stripe, issued or linked by
 * hand. Null: none yet.
 */
export async function saleDocument(
  ctx: Db,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Row | null> {
  const keys = saleKeys(ids)
  if (keys.length === 0) return null
  const byKey = await documentIdsByKey(ctx, keys)
  for (const key of keys) {
    const id = byKey.get(key)
    const doc = id ? await documentById(ctx, id) : null
    if (doc) return doc
  }
  const charges = keys.filter(isCharge).map((k) => k.slice("stripe:".length))
  if (charges.length === 0) return null
  const linked = await invoicesLinkedTo(ctx, charges)
  const id = charges.map((c) => linked.get(c)).find((x) => x !== undefined)
  return id ? documentById(ctx, id) : null
}

/** The writes that claim a sale's names, for the batch that writes its document. */
export function claimOps(
  ids: ReadonlyArray<string | null | undefined>,
  document: string | { $ref: string },
): Array<Extract<IssueBatchOp, { insert: string }>> {
  return saleKeys(ids).map((key) => ({
    insert: STRIPE_SALES,
    data: { key, document_id: document },
  }))
}

/** The other transaction on this sale committed first: the batch failed on one of its keys. */
export function isSaleTaken(err: unknown): boolean {
  const text = `${(err as Error)?.message ?? err}`
  return (
    /23505|duplicate key|unique constraint/i.test(text) && /stripe_sales|external_ref/.test(text)
  )
}

/**
 * Record that a sale found invoiced under one name is invoiced under the others too, so the next
 * read under any of them finds it at once. Best effort: the document is what counts.
 */
export async function recordSale(
  ctx: Db,
  ids: ReadonlyArray<string | null | undefined>,
  documentId: string,
): Promise<void> {
  const keys = saleKeys(ids)
  const known = await documentIdsByKey(ctx, keys)
  for (const key of keys) {
    if (known.has(key)) continue
    try {
      await ctx.db.batch({
        ops: [{ insert: STRIPE_SALES, data: { key, document_id: documentId } }],
      })
    } catch (err) {
      if (!isSaleTaken(err)) throw err
    }
  }
}
