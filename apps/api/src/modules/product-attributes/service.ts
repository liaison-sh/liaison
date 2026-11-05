// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Product attributes: small facts an organisation keeps about each product it
// sells, keyed by SKU (kernel.product_attributes, migration 0254).
//
// Provider-neutral on purpose. A store app (which knows each order line's SKU)
// reads them to summarise a cart; a shipping app reads them and writes its own
// codes into them; neither imports the other, and a second shipping or store
// provider reads and writes the same rows. Keys are free-form lowercase
// identifiers. Documented keys:
//   short_code   the short operator-facing code a product reads as in a cart
//                summary ("E2"), at most SHORT_CODE_MAX characters.
//
// Every read and write runs under the caller's RLS context, so a row is only
// ever visible or writable inside its own org.

import { and, asc, eq, inArray, type SQL } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient, RlsTx } from "~/db"
import { productAttributes } from "~/db/schema/kernel"
import { UUID_RE } from "~/lib/uuid"

type Db = RlsClient | RlsTx

/** The documented key for a product's short display code. */
export const SHORT_CODE_KEY = "short_code"
/** Longest short code accepted, in characters (a cart summary chip). */
export const SHORT_CODE_MAX = 12
export const SKU_MAX = 255
export const VALUE_MAX = 2000
/** Most SKUs one list call filters on, and most items one upsert call writes. */
export const PRODUCT_ATTRIBUTES_BATCH_MAX = 500
/** Most rows one list call returns. */
export const PRODUCT_ATTRIBUTES_LIST_MAX = 2000

const KEY_RE = /^[a-z][a-z0-9_]{0,63}$/

export interface ProductAttribute {
  sku: string
  key: string
  value: string
  updatedAt: string
}

function invalid(message: string): HTTPException {
  return new HTTPException(422, { message })
}

function cleanSku(raw: string): string {
  const sku = raw.trim()
  if (sku === "") throw invalid("A product attribute needs a non-empty sku")
  if (sku.length > SKU_MAX) throw invalid(`A sku is at most ${SKU_MAX} characters`)
  return sku
}

function cleanKey(raw: string): string {
  const key = raw.trim()
  if (!KEY_RE.test(key)) {
    throw invalid(
      `Invalid attribute key "${raw}": use a lowercase identifier (letters, digits, underscore; starts with a letter; at most 64 characters), e.g. "${SHORT_CODE_KEY}"`,
    )
  }
  return key
}

/** The stored form of a value, or null for "delete this attribute" (null or blank). */
function cleanValue(key: string, raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.trim()
  if (value === "") return null
  if (value.length > VALUE_MAX)
    throw invalid(`An attribute value is at most ${VALUE_MAX} characters`)
  if (key === SHORT_CODE_KEY && value.length > SHORT_CODE_MAX) {
    throw invalid(`A ${SHORT_CODE_KEY} is at most ${SHORT_CODE_MAX} characters, got "${value}"`)
  }
  return value
}

export interface ListProductAttributesParams {
  orgId: string
  skus?: string[]
  keys?: string[]
  limit?: number
}

/** The attributes the caller can see, optionally narrowed to some SKUs and keys. */
export async function listProductAttributes(
  db: Db,
  params: ListProductAttributesParams,
): Promise<{ attributes: ProductAttribute[]; truncated: boolean }> {
  const skus = [...new Set((params.skus ?? []).map((s) => s.trim()).filter((s) => s !== ""))]
  const keys = [...new Set((params.keys ?? []).map(cleanKey))]
  if (skus.length > PRODUCT_ATTRIBUTES_BATCH_MAX) {
    throw invalid(`At most ${PRODUCT_ATTRIBUTES_BATCH_MAX} skus per call`)
  }
  const limit = Math.max(
    1,
    Math.min(PRODUCT_ATTRIBUTES_LIST_MAX, params.limit ?? PRODUCT_ATTRIBUTES_LIST_MAX),
  )
  const where: SQL[] = [eq(productAttributes.orgId, params.orgId)]
  if (params.skus !== undefined) {
    if (skus.length === 0) return { attributes: [], truncated: false }
    where.push(inArray(productAttributes.sku, skus))
  }
  if (keys.length > 0) where.push(inArray(productAttributes.key, keys))
  const rows = await db
    .select({
      sku: productAttributes.sku,
      key: productAttributes.key,
      value: productAttributes.value,
      updatedAt: productAttributes.updatedAt,
    })
    .from(productAttributes)
    .where(and(...where))
    .orderBy(asc(productAttributes.sku), asc(productAttributes.key))
    .limit(limit + 1)
  return {
    attributes: rows.slice(0, limit).map((r) => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
    truncated: rows.length > limit,
  }
}

export interface ProductAttributeWrite {
  sku: string
  key: string
  /** null or blank deletes the attribute. */
  value: string | null
}

export interface UpsertProductAttributesResult {
  written: number
  deleted: number
  unchanged: number
}

/** Validate and de-duplicate a write batch (the last write of a (sku, key) wins). */
export function normalizeAttributeWrites(items: ProductAttributeWrite[]): ProductAttributeWrite[] {
  if (items.length > PRODUCT_ATTRIBUTES_BATCH_MAX) {
    throw invalid(`At most ${PRODUCT_ATTRIBUTES_BATCH_MAX} attributes per call`)
  }
  const byPair = new Map<string, ProductAttributeWrite>()
  for (const item of items) {
    const sku = cleanSku(item.sku)
    const key = cleanKey(item.key)
    byPair.set(`${key}\u0000${sku}`, { sku, key, value: cleanValue(key, item.value) })
  }
  return [...byPair.values()]
}

/**
 * Set (or, with a null/blank value, delete) attributes. Idempotent: a write
 * whose value is already stored changes nothing (not even updated_at) and
 * counts as unchanged, so a backfill can re-run freely.
 */
export async function upsertProductAttributes(
  db: Db,
  params: { orgId: string; userId: string; items: ProductAttributeWrite[] },
): Promise<UpsertProductAttributesResult> {
  const items = normalizeAttributeWrites(params.items)
  const result: UpsertProductAttributesResult = { written: 0, deleted: 0, unchanged: 0 }
  if (items.length === 0) return result
  const updatedBy = UUID_RE.test(params.userId) ? params.userId : null
  const skus = [...new Set(items.map((i) => i.sku))]
  const existing = await db
    .select({
      id: productAttributes.id,
      sku: productAttributes.sku,
      key: productAttributes.key,
      value: productAttributes.value,
    })
    .from(productAttributes)
    .where(and(eq(productAttributes.orgId, params.orgId), inArray(productAttributes.sku, skus)))
  const current = new Map(existing.map((r) => [`${r.key}\u0000${r.sku}`, r]))
  for (const item of items) {
    const row = current.get(`${item.key}\u0000${item.sku}`)
    if (item.value === null) {
      if (!row) {
        result.unchanged++
        continue
      }
      await db.delete(productAttributes).where(eq(productAttributes.id, row.id))
      result.deleted++
      continue
    }
    if (row?.value === item.value) {
      result.unchanged++
      continue
    }
    const now = new Date()
    await db
      .insert(productAttributes)
      .values({ orgId: params.orgId, sku: item.sku, key: item.key, value: item.value, updatedBy })
      .onConflictDoUpdate({
        target: [productAttributes.orgId, productAttributes.sku, productAttributes.key],
        set: { value: item.value, updatedBy, updatedAt: now },
      })
    result.written++
  }
  return result
}
