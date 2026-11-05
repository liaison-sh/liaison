// SPDX-License-Identifier: FSL-1.1-ALv2
//
// onShopifyProductChanged — syncs a Shopify product's customs data into the
// local `product_customs_overlay`. Subscribed to `shopify/product:created` and
// `shopify/product:updated`.
//
// On the event we fetch the product (with customs) via `shopify:products_get`
// and upsert one overlay row per variant. HS code + country of origin are
// NATIVE Shopify fields (`InventoryItem.harmonizedSystemCode` /
// `countryCodeOfOrigin`); the customs goods-description is a Shopify metafield
// (`custom.customs_description`) — see the shopify app's `products_get`. The
// export-issue path (`issue.ts` → `lookupOverlay`) then reads these, so export
// invoices carry HS/CoO/description with zero manual entry; a manual edit via
// `hs_codes_assign` still overrides (same row, source='shopify').
//
// Shopify is an OPTIONAL dependency: this only runs when a shopify product
// event is delivered, so invoicing still installs + works fully standalone.
import type { CrossAppExecuteTool } from "../cross-app"
import type { IssueCtx } from "../issue"

export interface ProductSyncCtx {
  db: IssueCtx["db"]
  executeTool: CrossAppExecuteTool
}

// The slice of `shopify:products_get` (normalizeProduct) we consume. Each
// variant carries the flattened native customs fields + the product-level
// customs description metafield.
interface ShopifyProductHit {
  id?: string
  attributes?: {
    customs_description?: string | null
    variants?: Array<{
      id?: string | null
      hs_code?: string | null
      country_of_origin?: string | null
      customs_description?: string | null
    }>
  }
}

export interface ProductSyncResult {
  status: "ok" | "skipped"
  synced: number
  reason?: string
}

type OverlayRow = {
  external_id: string
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
}

async function upsertOverlay(db: ProductSyncCtx["db"], row: OverlayRow): Promise<void> {
  const existing = (await db.findMany("product_customs_overlay", {
    where: { source: "shopify", external_id: row.external_id },
    limit: 1,
  })) as Array<Record<string, unknown>>
  const data = {
    source: "shopify",
    external_id: row.external_id,
    hs_code: row.hs_code,
    country_of_origin: row.country_of_origin,
    customs_description: row.customs_description,
    // System sync has no human author (column is nullable). A subsequent manual
    // edit via hs_codes_assign stamps the editing user on the same row.
    updated_by_user_id: null,
  }
  const current = existing[0]
  if (current) {
    await db.update("product_customs_overlay", String(current.id), data)
  } else {
    await db.insert("product_customs_overlay", data)
  }
}

export async function onShopifyProductChanged(
  event: { entityId?: string; data?: { id?: string; product?: { id?: string } } },
  ctx: ProductSyncCtx,
): Promise<ProductSyncResult> {
  // The kernel delivers the full event envelope; the product gid is the
  // entityId (shopify emits product:created/updated with entityId = product.id).
  const productId = event?.entityId ?? event?.data?.id ?? event?.data?.product?.id
  if (!productId) return { status: "skipped", synced: 0, reason: "no_product_id" }

  const envelope = await ctx.executeTool("shopify:products_get", { id: productId })
  if (envelope.status !== "completed") {
    return { status: "skipped", synced: 0, reason: "products_get_unavailable" }
  }
  const product = envelope.result as ShopifyProductHit
  const variants = product?.attributes?.variants ?? []

  let synced = 0
  for (const v of variants) {
    if (!v.id) continue
    // Only sync variants that actually carry customs data — don't create empty
    // overlay rows for unclassified / non-export products.
    if (!v.hs_code && !v.country_of_origin && !v.customs_description) continue
    await upsertOverlay(ctx.db, {
      external_id: v.id,
      hs_code: v.hs_code ?? null,
      country_of_origin: v.country_of_origin ?? null,
      customs_description: v.customs_description ?? null,
    })
    synced++
  }
  return { status: "ok", synced }
}
