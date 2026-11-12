// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PRODUCT SHORT CODES LIVE ON THE PRODUCT, not in this app. The kernel keeps per-SKU product
// attributes (`kernel:product_attributes_list` / `_upsert`, key `short_code`), provider-neutral:
// a store app reads them to summarise a cart, another shipping provider reads and writes the same
// rows, and nobody imports anybody.
//
// This app's part:
//   - WRITE: every shipping profile's `short_code` is copied onto the SKU of each variant linked
//     to it. A profile write that CHANGES a code (upsert, merge) overwrites the codes of the
//     variants it touched; a link fills in only a missing one. The daily `sync-product-codes`
//     job fills in every code the kernel does not have yet, never overwriting one set elsewhere.
//     Both are idempotent: an unchanged value is not re-written.
//   - CONFLICTS: before writing a SKU, every profile linked to it is read: when two profiles give
//     one SKU different codes nothing is written for it, and the conflict is reported (tool
//     answer, catalog row) instead of one profile clobbering the other.
//   - NOT SYNCED YET: the kernel's write is approval-gated and can be parked, refused or fail.
//     Each SKU whose write did not complete gets a marker in this app's `short_code_sync` table;
//     while a marker is there a draft reads the profile's own code (the kernel still holds the
//     old one), the catalog row says "not synced yet", and the daily job retries the SKU with
//     overwrite, clearing the marker once the kernel holds the code. The gate is never bypassed.
//   - READ: a draft resolves each variant's short code from the product attributes first and
//     falls back to the profile's own `short_code` (a variant whose SKU is not known yet, whose
//     SKU has no attribute, or whose SKU carries a marker).
//
// A variant is keyed here by `(product_source, product_id)`; the kernel keys by SKU. A `local`
// product's id IS its SKU. A Shopify variant's SKU is read once through `shopify:variants_brief`
// and cached in `variant_sku`, so the read path never calls the store.
//
// To port to another store provider: teach `resolveVariantSkus` how that source's variant ids
// map to SKUs (its own brief tool), nothing else changes.

import type { CrossAppEnvelope } from "./ctx"
import {
  LINK_TABLE,
  loadVariantProfiles,
  PROFILE_TABLE,
  type ProfileDb,
  type VariantProfile,
  type VariantRef,
} from "./profiles"

export const VARIANT_SKU_TABLE = "variant_sku"
export const SHORT_CODE_KEY = "short_code"
export const CODE_SYNC_TABLE = "short_code_sync"
const MAX = 1000
/** Shopify's nodes() lookup takes at most this many ids per call. */
const BRIEF_BATCH = 50
const ATTRIBUTE_BATCH = 500
/** Ids per `in` lookup on this app's own tables. */
const LOOKUP_BATCH = 200
export const SHOPIFY_VARIANT_GID = "gid://shopify/ProductVariant/"

export interface ProductAttributeCtx {
  db: ProfileDb
  executeTool: (target: string, args: Record<string, unknown>) => Promise<CrossAppEnvelope>
  logger?: { warn?(msg: string, data?: unknown): void }
}

interface VariantSkuRow {
  id: string
  product_source: string
  product_id: string
  sku: string
}

/** The key `knownVariantSkus` / `resolveVariantSkus` answer by: "<product_source>:<product_id>". */
export function refKey(r: VariantRef): string {
  return `${r.product_source}:${r.product_id}`
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function toVariantGid(id: string): string | null {
  const trimmed = id.trim()
  if (trimmed.startsWith(SHOPIFY_VARIANT_GID)) return trimmed
  return /^\d+$/.test(trimmed) ? `${SHOPIFY_VARIANT_GID}${trimmed}` : null
}

/** The SKUs already known for these variants, without calling any store. Reads the cache by
 *  the variants asked for, never the whole table. */
export async function knownVariantSkus(
  db: ProfileDb,
  refs: VariantRef[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const idsBySource = new Map<string, Set<string>>()
  for (const r of refs) {
    if (r.product_source === "local") {
      if (r.product_id.trim() !== "") out.set(refKey(r), r.product_id.trim())
      continue
    }
    const ids = idsBySource.get(r.product_source) ?? new Set<string>()
    ids.add(r.product_id)
    idsBySource.set(r.product_source, ids)
  }
  for (const [source, ids] of idsBySource) {
    for (const batch of chunks([...ids], LOOKUP_BATCH)) {
      const rows = (await db.findMany(VARIANT_SKU_TABLE, {
        where: { product_source: source, product_id: { in: batch } },
        limit: batch.length,
      })) as VariantSkuRow[]
      for (const row of rows) {
        if (typeof row.sku === "string" && row.sku.trim() !== "")
          out.set(refKey(row), row.sku.trim())
      }
    }
  }
  return out
}

// — not-synced-yet markers (short_code_sync) —

export type CodeSyncState = "pending" | "conflict"

interface CodeSyncRow {
  id: string
  sku: string
  code: string | null
  state: CodeSyncState
  detail: string | null
}

/** The markers of these SKUs, by SKU. */
async function readMarkers(
  db: ProfileDb,
  skus: Iterable<string>,
): Promise<Map<string, CodeSyncRow>> {
  const out = new Map<string, CodeSyncRow>()
  for (const batch of chunks([...new Set(skus)], LOOKUP_BATCH)) {
    const rows = (await db.findMany(CODE_SYNC_TABLE, {
      where: { sku: { in: batch } },
      limit: batch.length,
    })) as CodeSyncRow[]
    for (const row of rows) out.set(row.sku, row)
  }
  return out
}

async function setMarker(
  db: ProfileDb,
  markers: Map<string, CodeSyncRow>,
  sku: string,
  data: { state: CodeSyncState; code: string | null; detail: string | null },
): Promise<void> {
  const row = markers.get(sku)
  if (row) {
    if (row.state !== data.state || row.code !== data.code || row.detail !== data.detail) {
      await db.update(CODE_SYNC_TABLE, row.id, data)
    }
    markers.set(sku, { ...row, ...data })
    return
  }
  try {
    const { id } = await db.insert(CODE_SYNC_TABLE, { sku, ...data })
    markers.set(sku, { id, sku, ...data })
  } catch {
    // A concurrent sync marked it first: re-read and write over it.
    const again = (await readMarkers(db, [sku])).get(sku)
    if (again) {
      await db.update(CODE_SYNC_TABLE, again.id, data)
      markers.set(sku, { ...again, ...data })
    }
  }
}

async function clearMarker(
  db: ProfileDb,
  markers: Map<string, CodeSyncRow>,
  sku: string,
): Promise<void> {
  const row = markers.get(sku)
  if (!row) return
  await db.delete(CODE_SYNC_TABLE, row.id)
  markers.delete(sku)
}

export interface ProfileCodeSync {
  /** "conflict" when any of its SKUs is in conflict, else "pending" (not synced yet). */
  state: CodeSyncState
  skus: string[]
  /** Why: the parked approval, the error, or the codes in conflict. */
  detail: string | null
}

/** Each profile's not-synced-yet or conflicting SKUs (for the catalog row), by profile id. */
export async function codeSyncByProfile(
  db: ProfileDb,
  profiles: Array<{ id: string; variants: VariantRef[] }>,
): Promise<Map<string, ProfileCodeSync>> {
  const out = new Map<string, ProfileCodeSync>()
  const skus = await knownVariantSkus(
    db,
    profiles.flatMap((p) => p.variants),
  )
  if (skus.size === 0) return out
  const markers = await readMarkers(db, skus.values())
  if (markers.size === 0) return out
  for (const p of profiles) {
    const rows = [
      ...new Set(
        p.variants.map((v) => skus.get(refKey(v))).filter((s): s is string => s !== undefined),
      ),
    ]
      .map((sku) => markers.get(sku))
      .filter((m): m is CodeSyncRow => m !== undefined)
    if (rows.length === 0) continue
    const conflict = rows.filter((m) => m.state === "conflict")
    const shown = conflict.length > 0 ? conflict : rows
    out.set(p.id, {
      state: conflict.length > 0 ? "conflict" : "pending",
      skus: shown.map((m) => m.sku).sort(),
      detail: shown.find((m) => m.detail)?.detail ?? null,
    })
  }
  return out
}

/**
 * Every variant's SKU: the known ones, plus the Shopify variants not cached yet, read through
 * `shopify:variants_brief` and cached (`cache: false` for a read-only caller: read, never write).
 * A variant whose SKU cannot be found (no store app, an empty SKU, another source) is simply
 * absent. Keyed by `refKey`.
 */
export async function resolveVariantSkus(
  ctx: ProductAttributeCtx,
  refs: VariantRef[],
  opts: { cache?: boolean } = {},
): Promise<Map<string, string>> {
  const out = await knownVariantSkus(ctx.db, refs)
  const missing = new Map<string, VariantRef>()
  for (const r of refs) {
    if (r.product_source !== "shopify" || out.has(refKey(r))) continue
    const gid = toVariantGid(r.product_id)
    if (gid) missing.set(gid, r)
  }
  for (const batch of chunks([...missing.keys()], BRIEF_BATCH)) {
    let env: CrossAppEnvelope
    try {
      env = await ctx.executeTool("shopify:variants_brief", { ids: batch })
    } catch (err) {
      ctx.logger?.warn?.("product codes: variants_brief failed", { err: String(err) })
      continue
    }
    if (env.status !== "completed") continue
    const variants =
      (env.result as { variants?: Array<{ id?: unknown; sku?: unknown }> } | null)?.variants ?? []
    for (const v of variants) {
      if (typeof v.id !== "string" || typeof v.sku !== "string" || v.sku.trim() === "") continue
      const ref = missing.get(v.id)
      if (!ref) continue
      const sku = v.sku.trim()
      out.set(refKey(ref), sku)
      if (opts.cache !== false) await cacheVariantSku(ctx.db, ref, sku)
    }
  }
  return out
}

async function cacheVariantSku(db: ProfileDb, ref: VariantRef, sku: string): Promise<void> {
  const rows = (await db.findMany(VARIANT_SKU_TABLE, {
    where: { product_source: ref.product_source, product_id: ref.product_id },
    limit: 1,
  })) as VariantSkuRow[]
  const row = rows[0]
  if (row) {
    if (row.sku !== sku) await db.update(VARIANT_SKU_TABLE, row.id, { sku })
    return
  }
  try {
    await db.insert(VARIANT_SKU_TABLE, {
      product_source: ref.product_source,
      product_id: ref.product_id,
      sku,
    })
  } catch {
    // A concurrent sync cached it first: the value is the same lookup's.
  }
}

/** The kernel's short codes for these SKUs (absent = no code there). Best effort: empty on error. */
export async function readShortCodesBySku(
  ctx: ProductAttributeCtx,
  skus: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(skus.filter((s) => s.trim() !== ""))]
  for (const batch of chunks(unique, ATTRIBUTE_BATCH)) {
    let env: CrossAppEnvelope
    try {
      env = await ctx.executeTool("kernel:product_attributes_list", {
        skus: batch,
        keys: [SHORT_CODE_KEY],
      })
    } catch (err) {
      ctx.logger?.warn?.("product codes: product_attributes_list failed", { err: String(err) })
      return out
    }
    if (env.status !== "completed") return out
    const attrs =
      (
        env.result as {
          attributes?: Array<{ sku?: unknown; key?: unknown; value?: unknown }>
        } | null
      )?.attributes ?? []
    for (const a of attrs) {
      if (a.key !== SHORT_CODE_KEY || typeof a.sku !== "string" || typeof a.value !== "string")
        continue
      if (a.value.trim() !== "") out.set(a.sku, a.value.trim())
    }
  }
  return out
}

/**
 * The variant profiles with each short code read from the product attributes first, the
 * profile's own code as the fallback. A SKU with a not-synced-yet or conflict marker keeps the
 * profile's code (the kernel's value there is stale or disputed). Never calls the store (cached
 * SKUs only), and any failure leaves the profiles' own codes in place.
 */
export async function withAttributeShortCodes<
  P extends VariantRef & { short_code?: string | null },
>(ctx: ProductAttributeCtx, profiles: P[]): Promise<P[]> {
  if (profiles.length === 0) return profiles
  let skus: Map<string, string>
  let markers: Map<string, CodeSyncRow>
  try {
    skus = await knownVariantSkus(ctx.db, profiles)
    if (skus.size === 0) return profiles
    markers = await readMarkers(ctx.db, skus.values())
  } catch {
    return profiles
  }
  const readable = [...new Set(skus.values())].filter((sku) => !markers.has(sku))
  if (readable.length === 0) return profiles
  const codes = await readShortCodesBySku(ctx, readable)
  if (codes.size === 0) return profiles
  return profiles.map((p) => {
    const sku = skus.get(refKey(p))
    const code = sku && !markers.has(sku) ? codes.get(sku) : undefined
    return code && code !== p.short_code ? { ...p, short_code: code } : p
  })
}

export interface SyncProductCodesResult {
  /** Codes the kernel now holds from this sync. */
  written: number
  /** Codes already right (or, in fill mode, already set by someone). */
  unchanged: number
  /** Variants whose SKU is unknown, or whose SKU two profiles give different codes. */
  skipped: number
  /** True when the kernel parked a write for an approval. */
  pending: boolean
  /** SKUs whose write did not complete (parked, refused, failed): marked, retried daily. */
  not_synced: number
  /** SKUs two profiles give different codes: nothing written for them. */
  conflicts: Array<{ sku: string; codes: string[] }>
  /** The kernel's refusal or the failure, when a write did not complete for another reason than an approval. */
  error?: string
}

/**
 * Copy profile short codes onto the products' SKUs.
 *   mode "fill"       only SKUs the kernel has no code for (the backfill job: a code set
 *                     elsewhere is never overwritten);
 *   mode "overwrite"  every SKU of the variants in scope (a profile write that changed a code).
 * A SKU with a not-synced-yet marker is always written over (its profile's code never landed).
 * `profileIds` limits the writes to the variants of those profiles; the conflict check still
 * reads every profile linked to each SKU.
 */
export async function syncProductShortCodes(
  ctx: ProductAttributeCtx,
  opts: { mode: "fill" | "overwrite"; profileIds?: string[] },
): Promise<SyncProductCodesResult> {
  const result: SyncProductCodesResult = {
    written: 0,
    unchanged: 0,
    skipped: 0,
    pending: false,
    not_synced: 0,
    conflicts: [],
  }
  const scope = opts.profileIds ? new Set(opts.profileIds) : null
  const all = (await loadVariantProfiles(ctx.db)).filter(
    (v: VariantProfile) => (v.short_code ?? "").trim() !== "",
  )
  const views =
    scope === null ? all : all.filter((v) => v.profile_id !== null && scope.has(v.profile_id))

  // Every coded variant's SKU, not only the scoped ones: the conflict check needs each profile
  // linked to a SKU. A SKU not cached yet is read from the store once, then cached.
  const skus = await resolveVariantSkus(ctx, all)

  // SKU -> every code its profiles give it.
  const codesBySku = new Map<string, Set<string>>()
  for (const v of all) {
    const sku = skus.get(refKey(v))
    if (!sku) continue
    const codes = codesBySku.get(sku) ?? new Set<string>()
    codes.add((v.short_code ?? "").trim())
    codesBySku.set(sku, codes)
  }
  const targets = new Set<string>()
  for (const v of views) {
    const sku = skus.get(refKey(v))
    if (sku) targets.add(sku)
    else result.skipped++
  }

  const markers = await readMarkers(ctx.db, scope === null ? codesBySku.keys() : targets)
  if (scope === null) {
    // A marker whose SKU no profile gives a code any more has nothing left to sync.
    const stale = (await ctx.db.findMany(CODE_SYNC_TABLE, { limit: MAX })) as CodeSyncRow[]
    for (const row of stale) {
      if (!codesBySku.has(row.sku)) await ctx.db.delete(CODE_SYNC_TABLE, row.id)
    }
  }

  const wanted = new Map<string, string>()
  for (const sku of targets) {
    const codes = [...(codesBySku.get(sku) ?? [])].sort()
    if (codes.length > 1) {
      result.conflicts.push({ sku, codes })
      result.skipped++
      await setMarker(ctx.db, markers, sku, {
        state: "conflict",
        code: null,
        detail: codes.join(", "),
      })
      continue
    }
    const code = codes[0]
    if (code !== undefined) wanted.set(sku, code)
  }
  if (wanted.size === 0) return result

  const current = await readShortCodesBySku(ctx, [...wanted.keys()])
  const items: Array<{ sku: string; key: string; value: string }> = []
  for (const [sku, code] of wanted) {
    const have = current.get(sku)
    const retry = markers.get(sku)?.state === "pending"
    if (have === code || (opts.mode === "fill" && have !== undefined && !retry)) {
      result.unchanged++
      // In sync (or, in fill mode, a code set elsewhere): no conflict or pending write left.
      await clearMarker(ctx.db, markers, sku)
      continue
    }
    items.push({ sku, key: SHORT_CODE_KEY, value: code })
  }
  for (const batch of chunks(items, ATTRIBUTE_BATCH)) {
    let env: CrossAppEnvelope
    try {
      env = await ctx.executeTool("kernel:product_attributes_upsert", { items: batch })
    } catch (err) {
      env = {
        status: "error",
        error: { code: "failed", message: err instanceof Error ? err.message : String(err) },
      }
    }
    if (env.status === "completed") {
      const r = env.result as { written?: number; unchanged?: number } | null
      result.written += r?.written ?? batch.length
      result.unchanged += r?.unchanged ?? 0
      for (const i of batch) await clearMarker(ctx.db, markers, i.sku)
      continue
    }
    let detail: string
    if (env.status === "pending_approval") {
      result.pending = true
      detail = "awaiting approval"
    } else {
      detail = `${env.error.code}: ${env.error.message}`
      result.error = detail
    }
    result.not_synced += batch.length
    for (const i of batch)
      await setMarker(ctx.db, markers, i.sku, { state: "pending", code: i.value, detail })
  }
  return result
}

/** The `sync-product-codes` job: fill the kernel's missing short codes from the profiles, and
 *  retry (overwriting) every SKU whose earlier write did not complete. */
export const syncProductCodesJobHandler = (_payload: unknown, ctx: ProductAttributeCtx) =>
  syncProductShortCodes(ctx, { mode: "fill" })

/** The short code a variant's profile holds now (null: none, or no profile yet). */
export async function storedShortCode(db: ProfileDb, ref: VariantRef): Promise<string | null> {
  const links = (await db.findMany(LINK_TABLE, {
    where: { product_source: ref.product_source, product_id: ref.product_id },
    limit: 1,
  })) as Array<{ profile_id: string }>
  const link = links[0]
  if (!link) return null
  const rows = (await db.findMany(PROFILE_TABLE, {
    where: { id: link.profile_id },
    limit: 1,
  })) as Array<{
    short_code?: string | null
  }>
  return rows[0]?.short_code || null
}

/**
 * After a profile write: push the touched profiles' codes onto their SKUs ("overwrite" when the
 * write changed a code here, "fill" when a variant only joined a profile). Never fails the write
 * it follows; when the sync itself fails before writing, the profiles' known SKUs are marked not
 * synced yet in overwrite mode, so drafts read the new code and the daily job retries.
 */
export async function syncAfterProfileWrite(
  ctx: ProductAttributeCtx,
  profileIds: string[],
  mode: "fill" | "overwrite",
): Promise<SyncProductCodesResult | { error: string }> {
  try {
    return await syncProductShortCodes(ctx, { mode, profileIds })
  } catch (err) {
    const error = String(err instanceof Error ? err.message : err)
    ctx.logger?.warn?.("product codes: sync after profile write failed", { err: error })
    if (mode === "overwrite") await markProfilesNotSynced(ctx.db, profileIds, error)
    return { error }
  }
}

async function markProfilesNotSynced(
  db: ProfileDb,
  profileIds: string[],
  detail: string,
): Promise<void> {
  try {
    const ids = new Set(profileIds)
    const views = (await loadVariantProfiles(db)).filter(
      (v) => v.profile_id !== null && ids.has(v.profile_id) && (v.short_code ?? "").trim() !== "",
    )
    const skus = await knownVariantSkus(db, views)
    const markers = await readMarkers(db, skus.values())
    for (const v of views) {
      const sku = skus.get(refKey(v))
      if (sku && markers.get(sku)?.state !== "conflict") {
        await setMarker(db, markers, sku, {
          state: "pending",
          code: (v.short_code ?? "").trim(),
          detail,
        })
      }
    }
  } catch {
    // The app's own tables are unreachable too: nothing to record, the daily job catches up.
  }
}
