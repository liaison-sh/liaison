// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The DRAFT CACHE (`prep_draft_cache`): what a resolved shipment draft says about a row, stored so
// the list read never has to resolve one.
//
// Resolving a draft is 2+ cross-app bridge calls (~250 ms). The pre-rework list read resolved one
// PER CANDIDATE, which is why queues.ts's own comment records ~26 rows approaching the sandbox
// worker timeout, and why every row action (each of which ended in a whole-list refetch) felt like
// a page reload. Resolution now happens in exactly two places, both bounded and both explicitly
// asked for: `prep_sync` (the Pull orders button) and the row-scoped read. Everything else reads
// this table.
//
// A row whose anchor has no cache entry is NOT an error: it is `not_synced`, and the grid says so
// and offers Sync. Guessing at parcels for an unresolved anchor would be worse than admitting the
// row has not been looked at yet.

import { validateRecipientPhone } from "./address"
import type { AddressCheck } from "./address-check"
import type { BoxtalToolCtx } from "./ctx"
import type { CustomsArticle } from "./customs"
import { isUniqueViolation } from "./db-errors"
import type { PrepRecipient } from "./order-state"
import type { Parcel } from "./resolver"
import { shipmentDraftCreate, type ShipmentDraft } from "./shipment"
import { unresolvedLinesBlockLabel } from "./shippable-lines"

/** Bounded concurrency for a resolution pass: rows are independent, but a large worklist must not
 *  burst-fire dozens of simultaneous same-org reads. */
export const RESOLVE_CONCURRENCY = 6

/** Default cap on how many anchors one `prep_sync` pass resolves, oldest first. */
/** A resolution that THREW: nothing is cached for it, and the reason is carried out for the log
 *  and the sync result instead of being written onto the row as a verdict. */
interface ResolveFailure {
  document_ref: string
  error: string
}

function isResolveFailure(row: DraftCacheRow | ResolveFailure): row is ResolveFailure {
  return typeof (row as ResolveFailure).error === "string" && !("parcels" in row)
}

export const RESOLVE_LIMIT = 40

/** How long a cached resolution is trusted before Pull orders refreshes it. */
export const DRAFT_CACHE_TTL_MS = 12 * 60 * 60 * 1000

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export const REASON_LABEL: Record<string, string> = {
  no_profile: "Unresolved pack",
  missing_weight: "Missing weight",
  missing_dims: "Missing dimensions",
}

/**
 * On an EXPORT route a draft can resolve a parcel yet still be un-shippable because its CUSTOMS
 * declaration is incomplete (Boxtal 422s an article with no value, no HS code, no origin, or no
 * weight). Returns the FIRST defect's human-readable label, most actionable first, or undefined.
 * Moved here from queues.ts unchanged: the classification belongs with the resolution that feeds it.
 */
export function customsArticleDefect(articles: CustomsArticle[]): string | undefined {
  if (articles.length === 0) return undefined
  if (articles.some((a) => !(a.unitValue && a.unitValue.value > 0))) return "Missing customs value"
  if (articles.some((a) => a.blocked && a.reason === "missing_weight")) return "Missing weight"
  if (articles.some((a) => a.blocked && a.reason === "fx_unavailable")) {
    return "Customs value needs a manual EUR amount"
  }
  if (articles.some((a) => a.incomplete && a.tariffNumber == null)) return "Missing HS code"
  if (articles.some((a) => a.incomplete)) return "Missing country of origin"
  return undefined
}

/**
 * Deterministic products summary from the draft's line summaries, e.g. "1xES, 1xET2". ALWAYS
 * available regardless of whether the route requires a customs declaration, unlike customsArticles.
 */
export function summarizeProducts(draft: ShipmentDraft): string {
  const counts = new Map<string, number>()
  for (const l of draft.lineSummaries) {
    if (l.line_kind !== "goods") continue
    counts.set(l.label, (counts.get(l.label) ?? 0) + l.quantity)
  }
  if (counts.size === 0) {
    return draft.parcels.length > 0
      ? `${draft.parcels.length} parcel${draft.parcels.length === 1 ? "" : "s"}`
      : "-"
  }
  return [...counts.entries()].map(([label, qty]) => `${qty}x${label}`).join(", ")
}

export interface DraftCacheRow {
  document_ref: string
  parcels: Parcel[]
  products: string
  recipient: PrepRecipient | null
  destination_country: string | null
  grand_total_minor: number | null
  currency: string | null
  customs_ok: boolean
  needs_fix_reason: string | null
  recipient_phone_issue: string | null
  /** Present only when a PARTIAL batch covers part of the anchor: the units still to pack. */
  partial_remaining: Array<{ line_id: string; quantity: number }> | null
  /** FULL invoice line totals, the denominator a partial-coverage check needs without re-reading
   *  the document. */
  invoice_lines: Array<{ line_id: string; quantity: number }>
  /** The catalog variants this resolution found with no shipping profile, so the catalog can offer
   *  to link each to an existing profile. Absent on rows resolved before it existed. */
  unresolved_refs?: Array<{ product_source: string; product_id: string; description: string | null }>
  /** How the address was chosen and whether it matches the customer's verified one
   *  (address-check.ts). Absent on rows resolved before it existed. */
  address_check?: AddressCheck | null
  resolved_at: string
}

type StoredDraftCacheRow = DraftCacheRow & { id: string }

export async function loadDraftCache(ctx: BoxtalToolCtx): Promise<Map<string, DraftCacheRow>> {
  const rows = (await ctx.db.findMany("prep_draft_cache", { limit: 1000 })) as StoredDraftCacheRow[]
  const out = new Map<string, DraftCacheRow>()
  for (const r of rows) if (r.document_ref) out.set(r.document_ref, r)
  return out
}

export function isDraftCacheStale(row: DraftCacheRow | undefined, now = Date.now()): boolean {
  if (!row) return true
  const t = row.resolved_at ? Date.parse(row.resolved_at) : NaN
  return Number.isNaN(t) || now - t > DRAFT_CACHE_TTL_MS
}

/**
 * True when live PARTIAL coverage has moved since the cache was resolved, so the row's parcels
 * describe a box that has already been sent. Time-based staleness cannot catch this: a batch bought
 * a second ago changes what is left to pack without making the resolution old.
 */
export function coverageMovedSince(
  row: DraftCacheRow | undefined,
  cov: { full: boolean; shippedByLine: Map<string, number> } | undefined,
): boolean {
  if (!row) return false
  const shipped = cov && !cov.full ? cov.shippedByLine : new Map<string, number>()
  const expected =
    shipped.size === 0
      ? null
      : row.invoice_lines
          .map((l) => ({ line_id: l.line_id, quantity: l.quantity - (shipped.get(l.line_id) ?? 0) }))
          .filter((l) => l.quantity > 0)
  const key = (v: Array<{ line_id: string; quantity: number }> | null) =>
    v == null ? "" : [...v].map((l) => `${l.line_id}:${l.quantity}`).sort().join("|")
  return key(row.partial_remaining ?? null) !== key(expected)
}

/** The distinct variants a draft resolved with no profile (lines with a catalog ref only). */
function unresolvedRefs(draft: ShipmentDraft): NonNullable<DraftCacheRow["unresolved_refs"]> {
  const out = new Map<string, { product_source: string; product_id: string; description: string | null }>()
  for (const u of draft.unresolved ?? []) {
    if (u.reason !== "no_profile") continue
    const { product_source, external_id } = u.line
    if (!product_source || !external_id) continue
    const key = `${product_source}:${external_id}`
    if (out.has(key)) continue
    const summary = (draft.lineSummaries ?? []).find((l) => l.external_id === external_id)
    out.set(key, { product_source, product_id: external_id, description: summary?.description ?? null })
  }
  return [...out.values()]
}

/** Everything the grid needs about a resolved draft, derived once. */
export function deriveDraftFacts(
  draft: ShipmentDraft,
  documentRef: string,
  partialRemaining: Array<{ line_id: string; quantity: number }> | null = null,
): DraftCacheRow {
  // The lines staging refuses are exactly the ones the worklist flags: the draft's unresolved lines
  // are parcel lines already (shippable-lines.ts), and the same rule decides whether they block.
  const physicalUnresolved = unresolvedLinesBlockLabel(draft) ? draft.unresolved : []
  const customsDefect = draft.customs_required ? customsArticleDefect(draft.customsArticles) : undefined

  let needsFixReason: string | null = null
  if (draft.parcels.length === 0 && physicalUnresolved.length === 0) {
    needsFixReason = "No shippable lines"
  } else if (!draft.recipient || !draft.recipient_country) {
    needsFixReason = "Bad address"
  } else if (physicalUnresolved.length > 0) {
    const first = physicalUnresolved[0]
    needsFixReason = (first && REASON_LABEL[first.reason]) || "Needs setup"
  } else if (customsDefect) {
    needsFixReason = customsDefect
  }

  const address = draft.recipient_address
  const recipient: PrepRecipient | null = address
    ? {
        name: address.name ?? draft.recipient ?? null,
        company: address.company ?? null,
        email: address.email ?? null,
        phone: address.phone ?? null,
        street: address.street ?? null,
        city: address.city ?? null,
        postalCode: address.postalCode ?? null,
        countryIsoCode: address.countryIsoCode ?? draft.recipient_country ?? null,
        state: address.state ?? null,
      }
    : draft.recipient
      ? { name: draft.recipient, countryIsoCode: draft.recipient_country ?? null }
      : null

  // The document's OWN total is authoritative and tax INCLUSIVE. Line unit prices are stored NET,
  // so the line sum below is a subtotal: it understates a taxed row by its whole VAT and is kept
  // ONLY as the fallback for a draft that carries no document total (order-less/legacy paths).
  const grandTotalMinor =
    draft.document_total_minor != null && Number.isFinite(draft.document_total_minor)
      ? draft.document_total_minor
      : draft.lineSummaries.length > 0
        ? draft.lineSummaries.reduce((s, l) => s + l.quantity * l.unit_price_minor, 0)
        : null

  return {
    document_ref: documentRef,
    parcels: draft.parcels,
    products: summarizeProducts(draft),
    recipient,
    destination_country: draft.recipient_country ?? null,
    grand_total_minor: grandTotalMinor,
    currency: draft.lineSummaries[0]?.currency ?? null,
    customs_ok: customsDefect === undefined,
    needs_fix_reason: needsFixReason,
    recipient_phone_issue: address
      ? (validateRecipientPhone(draft.recipient_country, address.phone) ?? null)
      : null,
    partial_remaining: partialRemaining,
    invoice_lines: (draft.invoice_lines ?? []).map((l) => ({ line_id: l.line_id, quantity: l.quantity })),
    unresolved_refs: unresolvedRefs(draft),
    address_check: draft.address_check ?? null,
    resolved_at: new Date().toISOString(),
  }
}

async function upsertDraftCache(ctx: BoxtalToolCtx, row: DraftCacheRow): Promise<void> {
  const byRef = async () =>
    (await ctx.db.findMany("prep_draft_cache", {
      where: { document_ref: row.document_ref },
      limit: 1,
    })) as Array<{ id: string }>
  const existing = await byRef()
  const { document_ref, ...patch } = row
  if (existing[0]) {
    await ctx.db.update("prep_draft_cache", existing[0].id, patch as Record<string, unknown>)
    return
  }
  try {
    await ctx.db.insert("prep_draft_cache", { document_ref, ...patch } as Record<string, unknown>)
  } catch (err) {
    // UNIQUE(document_ref) + read-then-insert: two resolutions of the same anchor (Pull orders
    // while a row patch or the 5 s poll resolves the same row) both see no row and both insert.
    // The loser's 23505 used to escape resolveDrafts and fail the whole prep_list / prep_sync call.
    if (!isUniqueViolation(err)) throw err
    const winner = await byRef()
    if (!winner[0]) throw err // genuinely gone: not a recoverable race
    await ctx.db.update("prep_draft_cache", winner[0].id, patch as Record<string, unknown>)
  }
}

export interface ResolveDraftsOptions {
  limit?: number
  /** A READ's resolution (prep_list): the cache write is best effort, so a write that fails, or
   *  a run that may not write, never fails the read; the resolved rows are returned either way. */
  bestEffortWrites?: boolean
  concurrency?: number
  /**
   * Live outbound coverage per anchor. When PARTIAL batches already cover part of an anchor, the
   * draft is resolved a SECOND time over what is still to pack, so parcels, weight and customs
   * describe the next box rather than the whole invoice. The second pass is needed because the
   * line denominator (`invoice_lines`) only exists once the first resolution has happened, and it
   * only runs for anchors that actually have partial coverage.
   */
  coverage?: Map<string, { full: boolean; shippedByLine: Map<string, number> }>
}

/**
 * Resolve the given anchors' drafts and write what they say into the cache.
 *
 * The ONLY place (with the row-scoped read that calls it) where a draft is resolved. A failure is
 * cached as a `needs_fix` row rather than dropped: an invoice that cannot be resolved is a real
 * order that needs attention, and a silently missing row is how an order goes unshipped.
 */
export async function resolveDrafts(
  ctx: BoxtalToolCtx,
  refs: string[],
  opts: ResolveDraftsOptions = {},
): Promise<Map<string, DraftCacheRow>> {
  const limit = Math.max(1, opts.limit ?? RESOLVE_LIMIT)
  const scoped = refs.slice(0, limit)
  const out = new Map<string, DraftCacheRow>()
  const rows = await mapWithConcurrency(
    scoped,
    opts.concurrency ?? RESOLVE_CONCURRENCY,
    async (ref): Promise<DraftCacheRow | ResolveFailure> => {
      const cov = opts.coverage?.get(ref)
      try {
        const draft = await shipmentDraftCreate(ctx, { document_ref: ref, orderShipTo: false })
        const facts = deriveDraftFacts(draft, ref)
        if (!cov || cov.full || cov.shippedByLine.size === 0) return facts
        const subset = facts.invoice_lines
          .map((l) => ({ line_id: l.line_id, quantity: l.quantity - (cov.shippedByLine.get(l.line_id) ?? 0) }))
          .filter((l) => l.quantity > 0)
        if (subset.length === 0) {
          // Every unit has a live batch: nothing left to pack, and the row says so.
          return { ...facts, partial_remaining: [] }
        }
        const batch = await shipmentDraftCreate(ctx, { document_ref: ref, lines: subset, orderShipTo: false })
        return deriveDraftFacts(batch, ref, subset)
      } catch (err) {
        // A THROWN resolution is a read failure, not a verdict on the invoice. Caching it as a
        // needs_fix row pinned a healthy row to "Could not load invoice" with Ship disabled for the
        // whole cache TTL, and a transient bridge timeout was recorded identically to a genuinely
        // broken invoice. So: say what actually failed, and write NOTHING (the row keeps whatever it
        // had, or stays honestly not_synced). Only defects the resolution REPORTED are persisted.
        const message = err instanceof Error ? err.message : String(err)
        ctx.logger?.warn?.("prep: draft resolution failed", { document_ref: ref, err: message })
        return { document_ref: ref, error: message }
      }
    },
  )
  for (const row of rows) {
    if (isResolveFailure(row)) continue
    out.set(row.document_ref, row)
    try {
      await upsertDraftCache(ctx, row)
    } catch (err) {
      if (!opts.bestEffortWrites) throw err
      ctx.logger?.warn?.("prep: could not cache a resolved draft", {
        document_ref: row.document_ref,
        err: String(err),
      })
    }
  }
  return out
}
