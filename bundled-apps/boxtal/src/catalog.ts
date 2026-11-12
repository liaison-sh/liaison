// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Catalog CRUD tools: shipping profiles (per-product weight/dims), packs
// (named cartons with a component bill of materials), and local products
// (non-Shopify SKUs). All straight DB CRUD via `ctx.db`; none gated — catalog
// edits are local config, not external side effects. These rows feed the
// package resolver (Task 7) and customs assembly (Task 9).

import type { DbBatchOp, DbBatchResult, DbBatchSpec } from "@liaison/app-sdk"
import { codeSyncByProfile, type ProfileCodeSync } from "./product-attributes"
import { listSharedProfiles, loadVariantProfiles, type SharedProfileView, upsertVariantProfile, type VariantProfile, type VariantRef } from "./profiles"

export interface CatalogDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  delete(entity: string, id: string): Promise<void>
  /** `ctx.db.batch`: writes committed together or not at all. */
  batch(spec: DbBatchSpec): Promise<DbBatchResult>
}

export interface CatalogCtx {
  db: CatalogDb
}

const MAX = 1000

// — shipping_profile —

export interface ProductProfileInput {
  product_source: string
  product_id: string
  unit_weight: number
  /** Solo carton dims and category: absent keeps the stored value, null clears it. */
  solo_length?: number | null
  solo_width?: number | null
  solo_height?: number | null
  content_category?: string | null
  /** Short operator-facing product code (2-4 chars, e.g. "ET2", "MP", "BS") shown in the
   *  prep-grid products summary ("1xET2, 1xMP"). Optional; when unset the summary derives
   *  a code from the invoice line description's initials. */
  short_code?: string
  /** Operator-facing name of the profile ("Device 2"), shown in the catalog. Only written when sent. */
  label?: string
  /** Small item laid beside the stack (power supply, cable): the resolver adds the
   *  height of the tallest such item once instead of stacking each one. */
  accessory?: boolean
  /** Required when the variant's profile is shared with other variants: the edit changes all. */
  apply_to_shared?: boolean
}

/** Write the shipping profile a variant uses (profiles.ts): a linked variant's profile is updated
 *  in place (refused without apply_to_shared when other variants share it), an unlinked one gets
 *  its own new profile. Only the fields sent are written. */
export async function productProfileUpsert(
  ctx: CatalogCtx,
  input: ProductProfileInput,
): Promise<{ id: string; shared_with: VariantRef[] }> {
  return upsertVariantProfile(ctx, input)
}

// — pack + pack_component —

export interface PackComponentInput {
  product_source: string
  product_id: string
  quantity: number
}

export interface PackUpsertInput {
  id?: string
  name: string
  length: number
  width: number
  height: number
  gross_weight: number
  content_category?: string
  /** The shipping carton's own tare (kg) already folded into gross_weight, when this
   *  pack's weight was itself derived from a CARTON_LADDER stacking calculation (e.g.
   *  a pack recorded straight off a resolver worked example). Leave unset for a pack
   *  whose gross_weight is items-only (its own retail box, no separate shipping-carton
   *  tare) — the resolver treats an unset tare as zero, its existing behavior. Only
   *  matters when this pack later absorbs a loose leftover item into a bigger carton:
   *  it is what lets that merge tare the result exactly once instead of double-taping. */
  carton_tare?: number
  components: PackComponentInput[]
}

export async function packUpsert(
  ctx: CatalogCtx,
  input: PackUpsertInput,
): Promise<{ id: string; component_count: number; warning?: string }> {
  const packData = {
    name: input.name,
    length: input.length,
    width: input.width,
    height: input.height,
    gross_weight: input.gross_weight,
    content_category: input.content_category ?? null,
    carton_tare: input.carton_tare ?? null,
  }
  // The pack and its whole component set land in one commit: a failed save never leaves a pack
  // with half its bill of materials (no transaction is held across the run).
  const components = input.components ?? []
  const ops: DbBatchOp[] = []
  const packRef = input.id ?? { $ref: "pack" }
  if (input.id) {
    ops.push({ update: "pack", id: input.id, data: packData })
    // Replace the component set.
    const old = (await ctx.db.findMany("pack_component", {
      where: { pack_id: input.id },
      limit: MAX,
    })) as Array<{ id: string }>
    for (const c of old) ops.push({ delete: "pack_component", id: c.id })
  } else {
    ops.push({ insert: "pack", as: "pack", data: packData })
  }
  for (const c of components) {
    ops.push({
      insert: "pack_component",
      data: { pack_id: packRef, product_source: c.product_source, product_id: c.product_id, quantity: c.quantity },
    })
  }
  const committed = await ctx.db.batch({ ops })
  const packId = input.id ?? String(committed.rows.pack?.id)
  // AFFORDANCE HINT (not a fallback): echo the component count and, when the BOM is EMPTY, a warning so
  // the model knows a bundle/kit pack was created WITHOUT its bill of materials and is incomplete. A weak
  // model otherwise silently omits `components` (the BOM is the last, easily-skipped param) and reports
  // the pack as done — leaving a carton template with no contents. This surfaces the gap so it can
  // resolve the component SKUs (packages_list.local_products gives label↔sku) and re-upsert with the BOM.
  const component_count = components.length
  return component_count === 0
    ? {
        id: packId,
        component_count,
        warning:
          "This pack was saved with an EMPTY component bill of materials (components: []). If it is a bundle/kit carton (holds several products), the BOM is required: resolve each component's SKU (packages_list.local_products maps label→sku) and call pack_upsert again with the full `components` array.",
      }
    : { id: packId, component_count }
}

export async function packDelete(ctx: CatalogCtx, input: { id: string }): Promise<{ ok: true }> {
  const comps = (await ctx.db.findMany("pack_component", {
    where: { pack_id: input.id },
    limit: MAX,
  })) as Array<{ id: string }>
  await ctx.db.batch({
    ops: [...comps.map((c) => ({ delete: "pack_component", id: c.id })), { delete: "pack", id: input.id }],
  })
  return { ok: true }
}

// — local_product —

export async function localProductUpsert(
  ctx: CatalogCtx,
  input: { sku: string; label: string },
): Promise<{ id: string }> {
  const existing = (await ctx.db.findMany("local_product", {
    where: { sku: input.sku },
    limit: 1,
  })) as Array<{ id: string }>
  const row = existing[0]
  if (row) {
    await ctx.db.update("local_product", row.id, { sku: input.sku, label: input.label })
    return { id: row.id }
  }
  return ctx.db.insert("local_product", { sku: input.sku, label: input.label })
}

// — packages_list —

export interface PackView {
  id: string
  name: string
  length: number
  width: number
  height: number
  gross_weight: number
  content_category: string | null
  /** Null on rows saved before this field existed, or a pack with no separate
   *  shipping-carton tare baked into gross_weight. See PackUpsertInput.carton_tare. */
  carton_tare: number | null
  components: Array<{
    product_source: string
    product_id: string
    quantity: number
    label: string | null
  }>
  /** True when any component references a product that has no profile. */
  stale: boolean
}

export async function packagesList(
  ctx: CatalogCtx,
  _input: Record<string, never>,
): Promise<{
  /** One row per variant (the per-variant view every reader uses). */
  profiles: VariantProfile[]
  /** One row per shared profile with the variants linked to it, and its short codes' sync state
   *  (null: in sync; else not synced yet, or in conflict with another profile). */
  shared_profiles: Array<SharedProfileView & { short_code_sync: ProfileCodeSync | null }>
  /** Variants the last draft resolutions found with no profile and that still have none. */
  unprofiled_variants: UnprofiledVariant[]
  packs: PackView[]
  local_products: Array<Record<string, unknown>>
}> {
  const profiles = await loadVariantProfiles(ctx.db)
  const sharedProfiles = await listSharedProfiles(ctx.db)
  const codeSync = await codeSyncByProfile(
    ctx.db,
    sharedProfiles.map((p) => ({ id: String(p.id), variants: p.variants })),
  ).catch(() => new Map<string, ProfileCodeSync>())
  const profileRefs = new Set(profiles.map((p) => `${p.product_source}:${p.product_id}`))
  const localProducts = (await ctx.db.findMany("local_product", { limit: MAX })) as Array<Record<string, unknown>>
  const localBySku = new Map(localProducts.map((l) => [String(l.sku), String(l.label)]))
  const packRows = (await ctx.db.findMany("pack", { limit: MAX })) as Array<Record<string, unknown>>
  const allComponents = (await ctx.db.findMany("pack_component", { limit: MAX })) as Array<Record<string, unknown>>

  const packs: PackView[] = packRows.map((p) => {
    const comps = allComponents.filter((c) => c.pack_id === p.id)
    let stale = false
    const components = comps.map((c) => {
      const ref = `${c.product_source}:${c.product_id}`
      const hasProfile = profileRefs.has(ref)
      if (!hasProfile) stale = true
      const label =
        c.product_source === "local"
          ? (localBySku.get(String(c.product_id)) ?? null)
          : hasProfile
            ? String(c.product_id)
            : null
      return {
        product_source: String(c.product_source),
        product_id: String(c.product_id),
        quantity: Number(c.quantity ?? 0),
        label,
      }
    })
    return {
      id: String(p.id),
      name: String(p.name),
      length: Number(p.length),
      width: Number(p.width),
      height: Number(p.height),
      gross_weight: Number(p.gross_weight),
      content_category: (p.content_category as string | null) ?? null,
      carton_tare: p.carton_tare == null ? null : Number(p.carton_tare),
      components,
      stale,
    }
  })

  return {
    profiles,
    shared_profiles: sharedProfiles.map((p) => ({ ...p, short_code_sync: codeSync.get(String(p.id)) ?? null })),
    unprofiled_variants: await unprofiledVariants(ctx, profileRefs),
    packs,
    local_products: localProducts,
  }
}

export interface UnprofiledVariant extends VariantRef {
  /** The invoice line text it was seen under, so an operator can tell which product it is. */
  description: string | null
  /** How many resolved rows hold it. */
  rows: number
}

/** Variants a cached draft resolution reported without a profile (`unresolved_refs`) that still
 *  have none: what the catalog offers to "Link to existing profile". A reader without access to the
 *  draft cache sees none. */
async function unprofiledVariants(ctx: CatalogCtx, profiled: Set<string>): Promise<UnprofiledVariant[]> {
  let rows: Array<{ unresolved_refs?: unknown }>
  try {
    rows = (await ctx.db.findMany("prep_draft_cache", { limit: MAX })) as Array<{ unresolved_refs?: unknown }>
  } catch {
    return []
  }
  const out = new Map<string, UnprofiledVariant>()
  for (const r of rows) {
    const refs = Array.isArray(r.unresolved_refs) ? r.unresolved_refs : []
    const seen = new Set<string>()
    for (const raw of refs) {
      if (!raw || typeof raw !== "object") continue
      const { product_source, product_id, description } = raw as Record<string, unknown>
      if (typeof product_source !== "string" || typeof product_id !== "string" || !product_id) continue
      const key = `${product_source}:${product_id}`
      if (profiled.has(key) || seen.has(key)) continue
      seen.add(key)
      const entry = out.get(key) ?? {
        product_source,
        product_id,
        description: typeof description === "string" ? description : null,
        rows: 0,
      }
      entry.rows++
      out.set(key, entry)
    }
  }
  return [...out.values()].sort((a, b) => b.rows - a.rows || a.product_id.localeCompare(b.product_id))
}
