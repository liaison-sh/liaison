// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Import kinds of the boxtal app (manifest `import.kinds`): the bundle exports
// the import runner calls in the sandbox with a batch of records it has
// already validated against the kind's schema.
//
//   boxtal.local-product   { sku, label }                        dedup: sku
//   boxtal.pack            { externalRef, name, dims, grossWeight,
//                            components: [{ sku | shopifyProductId, quantity }] }
//                          dedup: external_ref; imported after local products
//   boxtal.shipping-profile { productSource, productId, unitWeight, … }
//                          dedup: (product_source, product_id)
//
// Imports only create: an existing row is skipped and left exactly as it is.
// The catalog tools' upserts (catalog.ts) are not reused for that reason.
// Every created row is returned for the run's undo ledger; a pack's components
// are resolved before anything is written, so a bad component writes nothing.

import type { DbClient } from "@liaison/app-sdk"
import { LEGACY_TABLE, LINK_TABLE, loadVariantProfiles, PROFILE_TABLE } from "./profiles"

export interface ImportBatch {
  runId: string
  kind: string
  sourceLabel: string
  records: Array<{ record: Record<string, unknown>; dedupValue: string }>
}

export interface ImportResult {
  status: "created" | "skipped" | "failed"
  rows: Array<{ table: string; id: string }>
  error?: string
}

export interface ImportCtx {
  db: Pick<DbClient, "findMany" | "insert">
}

const T = (table: string) => `app_boxtal.${table}`

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : ""
}

function positive(v: unknown, field: string): number {
  if (typeof v !== "number" || !(v > 0)) throw new Error(`${field} must be greater than 0`)
  return v
}

function optionalNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

async function each(
  batch: ImportBatch,
  fn: (record: Record<string, unknown>, dedupValue: string) => Promise<ImportResult>,
): Promise<ImportResult[]> {
  const out: ImportResult[] = []
  for (const { record, dedupValue } of batch.records) {
    try {
      out.push(await fn(record, dedupValue))
    } catch (err) {
      out.push({
        status: "failed",
        rows: [],
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return out
}

/** `boxtal.local-product`: a non-Shopify SKU. An existing SKU is skipped. */
export async function importLocalProducts(
  batch: ImportBatch,
  ctx: ImportCtx,
): Promise<ImportResult[]> {
  return each(batch, async (record) => {
    const sku = str(record.sku)
    const label = str(record.label)
    if (!sku || !label) throw new Error("sku and label are required")
    const existing = await ctx.db.findMany("local_product", { where: { sku }, limit: 1 })
    if (existing.length > 0) return { status: "skipped", rows: [] }
    const { id } = await ctx.db.insert("local_product", { sku, label })
    return { status: "created", rows: [{ table: T("local_product"), id }] }
  })
}

/** `boxtal.pack`: a named carton and its component bill of materials. */
export async function importPacks(batch: ImportBatch, ctx: ImportCtx): Promise<ImportResult[]> {
  return each(batch, async (record, dedupValue) => {
    const existing = await ctx.db.findMany("pack", {
      where: { external_ref: dedupValue },
      limit: 1,
    })
    if (existing.length > 0) return { status: "skipped", rows: [] }
    const name = str(record.name)
    if (!name) throw new Error("name is required")
    // Components first: an unknown SKU fails the record before any write.
    const components: Array<{ product_source: string; product_id: string; quantity: number }> = []
    for (const raw of Array.isArray(record.components) ? record.components : []) {
      const c = (raw ?? {}) as Record<string, unknown>
      const quantity = c.quantity
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
        throw new Error("a component quantity must be a positive integer")
      }
      const sku = str(c.sku)
      const shopifyId = str(c.shopifyProductId)
      if (sku) {
        const local = await ctx.db.findMany("local_product", { where: { sku }, limit: 1 })
        if (local.length === 0) throw new Error(`component SKU "${sku}" is not a local product`)
        components.push({ product_source: "local", product_id: sku, quantity })
      } else if (shopifyId) {
        components.push({ product_source: "shopify", product_id: shopifyId, quantity })
      } else {
        throw new Error("a component needs a sku or a shopifyProductId")
      }
    }
    const values = {
      name,
      length: positive(record.length, "length"),
      width: positive(record.width, "width"),
      height: positive(record.height, "height"),
      gross_weight: positive(record.grossWeight, "grossWeight"),
      content_category: str(record.contentCategory) || null,
      carton_tare: optionalNumber(record.cartonTare),
      external_ref: dedupValue,
    }
    // Everything is checked above; a write failing midway reports the rows
    // already written, so the run ledgers them and undo removes them.
    const rows: Array<{ table: string; id: string }> = []
    try {
      const pack = await ctx.db.insert("pack", values)
      rows.push({ table: T("pack"), id: pack.id })
      for (const c of components) {
        const { id } = await ctx.db.insert("pack_component", { pack_id: pack.id, ...c })
        rows.push({ table: T("pack_component"), id })
      }
    } catch (err) {
      return { status: "failed", rows, error: err instanceof Error ? err.message : String(err) }
    }
    return { status: "created", rows }
  })
}

/** `boxtal.shipping-profile`: one product's unit weight and dimensions, as its own shared profile
 *  (profiles.ts) plus the variant's link. Create-only: a variant that already has a profile, linked
 *  or not migrated yet, is skipped. */
export async function importShippingProfiles(
  batch: ImportBatch,
  ctx: ImportCtx,
): Promise<ImportResult[]> {
  return each(batch, async (record) => {
    const product_source = str(record.productSource)
    const product_id = str(record.productId)
    if (!product_source || !product_id) throw new Error("productSource and productId are required")
    const profiles = await loadVariantProfiles(ctx.db)
    if (profiles.some((p) => p.product_source === product_source && p.product_id === product_id)) {
      return { status: "skipped", rows: [] }
    }
    const fields = {
      unit_weight: positive(record.unitWeight, "unitWeight"),
      solo_length: optionalNumber(record.soloLength),
      solo_width: optionalNumber(record.soloWidth),
      solo_height: optionalNumber(record.soloHeight),
      content_category: str(record.contentCategory) || null,
      ...(str(record.shortCode) ? { short_code: str(record.shortCode) } : {}),
      ...(typeof record.accessory === "boolean" ? { accessory: record.accessory } : {}),
    }
    const { id } = await ctx.db.insert(PROFILE_TABLE, fields)
    const link = await ctx.db.insert(LINK_TABLE, { product_source, product_id, profile_id: id })
    // The previous release still reads the old per-variant table during a deploy (profiles.ts,
    // ROLLING DEPLOY): mirror the new profile onto the variant's old row, stamped. The variant had
    // no row (it would have been skipped above), and an undo of the run removes the mirror too.
    const legacy = await ctx.db.insert(LEGACY_TABLE, {
      product_source,
      product_id,
      ...fields,
      migrated_profile_id: id,
    })
    return {
      status: "created",
      rows: [
        { table: T(PROFILE_TABLE), id },
        { table: T(LINK_TABLE), id: link.id },
        { table: T(LEGACY_TABLE), id: legacy.id },
      ],
    }
  })
}
