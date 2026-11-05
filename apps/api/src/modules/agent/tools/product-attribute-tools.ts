// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel tools over kernel.product_attributes (modules/product-attributes):
// `product_attributes_list` (read only) and `product_attributes_upsert` (gated,
// auto-approvable). Bundled apps reach them through a `cross_app_calls` entry
// (`kernel:product_attributes_list` / `kernel:product_attributes_upsert`).

import type { ApprovalSummary } from "@liaison/shared"
import type { RlsClient } from "~/db"
import {
  listProductAttributes,
  normalizeAttributeWrites,
  type ProductAttributeWrite,
  upsertProductAttributes,
} from "~/modules/product-attributes/service"

interface ProductAttributeToolContext {
  userId: string
  orgId: string
  db: RlsClient
}

export async function handleProductAttributesList(
  params: { skus?: string[]; keys?: string[]; limit?: number },
  ctx: ProductAttributeToolContext,
) {
  return listProductAttributes(ctx.db, {
    orgId: ctx.orgId,
    ...(params.skus !== undefined ? { skus: params.skus } : {}),
    ...(params.keys !== undefined ? { keys: params.keys } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
  })
}

export async function handleProductAttributesUpsert(
  params: { items: ProductAttributeWrite[] },
  ctx: ProductAttributeToolContext,
) {
  return upsertProductAttributes(ctx.db, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    items: params.items,
  })
}

/** Approval card: every attribute the call sets or removes, at most 20 lines. */
export async function summarizeProductAttributesUpsert(params: unknown): Promise<ApprovalSummary> {
  const raw = (params as { items?: ProductAttributeWrite[] })?.items
  let items: ProductAttributeWrite[] = []
  try {
    items = normalizeAttributeWrites(Array.isArray(raw) ? raw : [])
  } catch {
    items = Array.isArray(raw) ? raw : []
  }
  const shown = items
    .slice(0, 20)
    .map((i) =>
      i.value === null || String(i.value).trim() === ""
        ? `${i.sku}: remove ${i.key}`
        : `${i.sku}: ${i.key} = ${i.value}`,
    )
  if (items.length > shown.length) shown.push(`and ${items.length - shown.length} more`)
  return {
    kind: "product_attributes_upsert",
    title: `Update ${items.length} product attribute${items.length === 1 ? "" : "s"}`,
    lines: shown,
  }
}
