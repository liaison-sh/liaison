// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: product variants (bulk create, update, delete).

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "../lib/get-client"
import {
  type PreflightResult,
  makeMutationError,
  resolveMutationInput,
  runMutation,
  idempotencyKey,
  preflightRefusal,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Variants
// ─────────────────────────────────────────────────────────────────────────

// API 2026-01 removed the single productVariant{Create,Update,Delete} mutations in favour of the
// productVariantsBulk* family (a `productId` arg + a `variants` array of ProductVariantsBulkInput).
// The tools keep accepting a SINGLE variant for agent ergonomics; the handlers resolve the owning
// productId (from the variant id when the caller doesn't supply it) and wrap it into a 1-element
// bulk array. `productId` is NOT a field of ProductVariantsBulkInput, so it is stripped from the
// variant before sending.

/** Resolve the owning product gid for a variant gid (the bulk variant mutations require productId). */
async function resolveProductIdForVariant(ctx: AppContext, variantId: string): Promise<string> {
  const client = await getShopifyClient(ctx)
  const data = await client.query<{ productVariant?: { product?: { id?: string } } | null }>(
    `query VariantProduct($id: ID!) { productVariant(id: $id) { product { id } } }`,
    { id: variantId },
  )
  const pid = data.productVariant?.product?.id
  if (!pid) throw makeMutationError("NOT_FOUND", `variant ${variantId} not found (cannot resolve productId)`)
  return pid
}

/** Strip the `productId` key (a mutation ARG, not a ProductVariantsBulkInput field) from a variant. */
function stripProductId(variant: Record<string, unknown>): Record<string, unknown> {
  const v = { ...variant }
  delete v.productId
  return v
}

// ProductVariantsBulkInput shape drift (weak-model API drift — the same class `products_create`'s
// `extractVariantSpec` + the inventory normaliser already handle). On Admin API 2024-04+ a variant's
// `sku` is NOT a field of ProductVariantsBulkInput — it lives under `inventoryItem.sku`. And
// `optionValues` items are `VariantOptionValueInput { name, optionName }`, NOT `{ value }`. A weak
// model (and the natural "consolidate the variant onto this product with sku X, option Y" ask in
// merge-duplicate-products-cleanup) supplies a flat top-level `sku` and `optionValues:[{value}]`, which
// 422s ("Field is not defined on ProductVariantsBulkInput" / "...on VariantOptionValueInput") and — in a
// GATED flow — leaves the approval unverified (forces non-green). Normalise to the exact valid shape so a
// correct-intent tool call from a weak model executes, mirroring `normalizeDraftOrderInput`. Idempotent:
// an already-correct `inventoryItem.sku` / `optionValues:[{name}]` passes through untouched.
function normalizeVariantBulkInput(variant: Record<string, unknown>): Record<string, unknown> {
  const v = { ...variant }
  // sku → inventoryItem.sku (merge with any caller-supplied inventoryItem; never clobber a nested sku).
  if (v.sku !== undefined) {
    const existing =
      v.inventoryItem && typeof v.inventoryItem === "object"
        ? (v.inventoryItem as Record<string, unknown>)
        : {}
    if (existing.sku === undefined) v.inventoryItem = { ...existing, sku: v.sku }
    else v.inventoryItem = existing
    delete v.sku
  }
  // CUSTOMS FIELDS → inventoryItem (same class as `sku`, and the same 422).
  // The READ path already maps `inventoryItem.harmonizedSystemCode → hs_code` and
  // `countryCodeOfOrigin → country_of_origin` (reads.ts), so an agent that reads a
  // variant, edits `hs_code`, and writes it back sends a field that does NOT exist
  // on ProductVariantsBulkInput. That 422s with "Field is not defined on
  // ProductVariantsBulkInput" and, in a GATED flow, parks the approval at
  // `approving` forever. Five HS-code approvals died exactly this way on
  // 2026-07-20 and again on 2026-08-04 — an operator approved them, the card
  // vanished, and nothing was written. Round-tripping a read must WORK.
  for (const [flat, nested] of [
    ["hs_code", "harmonizedSystemCode"],
    ["harmonizedSystemCode", "harmonizedSystemCode"],
    ["country_of_origin", "countryCodeOfOrigin"],
    ["countryCodeOfOrigin", "countryCodeOfOrigin"],
  ] as const) {
    if (v[flat] === undefined) continue
    const existing =
      v.inventoryItem && typeof v.inventoryItem === "object"
        ? (v.inventoryItem as Record<string, unknown>)
        : {}
    // Never clobber an explicitly-nested value the caller already supplied.
    if (existing[nested] === undefined) v.inventoryItem = { ...existing, [nested]: v[flat] }
    else v.inventoryItem = existing
    delete v[flat]
  }
  // optionValues:[{value}] → [{name}] (VariantOptionValueInput uses `name`, not `value`). Preserve
  // `optionName`/`optionId` if the caller supplied them; only the value→name key is remapped.
  if (Array.isArray(v.optionValues)) {
    v.optionValues = v.optionValues.map((ov) => {
      if (!ov || typeof ov !== "object") return ov
      const o = { ...(ov as Record<string, unknown>) }
      if (o.name === undefined && o.value !== undefined) {
        o.name = o.value
        delete o.value
      }
      return o
    })
  }
  return v
}

export const VARIANTS_BULK_CREATE = `
  mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $key: String!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) @idempotent(key: $key) {
      productVariants { id sku price } userErrors { field message }
    }
  }
`
export async function variants_create(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const input = resolveMutationInput(params)
  const productId = (input.productId ?? params.productId) as string | undefined
  if (!productId) throw makeMutationError("BAD_PARAM", "productId is required")
  const variant = normalizeVariantBulkInput(stripProductId(input))
  return runMutation(ctx, {
    query: VARIANTS_BULK_CREATE,
    variables: { productId, variants: [variant], key: idempotencyKey("variants-create", { productId, variant }) },
    dataKey: "productVariantsBulkCreate",
    eventEntity: "variant",
    eventAction: "created",
    entityIdPath: "productVariants.0.id",
  })
}

export const VARIANTS_BULK_UPDATE = `
  mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $key: String!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) @idempotent(key: $key) {
      productVariants { id sku price } userErrors { field message }
    }
  }
`
/** Resolve the variant + owning product a variants_update call targets. READ ONLY. Shared by the
 *  handler and its stage-time preflight so the "variant not found" refusal cannot drift. */
async function resolveVariantsUpdateTarget(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ input: Record<string, unknown>; productId: string }> {
  const input = resolveMutationInput(params)
  if (!input.id && params.id) input.id = params.id
  if (!input.id) throw makeMutationError("BAD_PARAM", "id is required")
  const productId =
    ((input.productId ?? params.productId) as string | undefined) ??
    (await resolveProductIdForVariant(ctx, input.id as string))
  return { input, productId }
}

/**
 * STAGE-TIME preflight for the gated `variants_update` (manifest `preflight`). A gated call must not
 * be parked for a human when the data it needs is missing: a variant gid that resolves to no owning
 * product can never execute, and the human would be handed an error only the agent can fix.
 */
export async function variants_update_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    await resolveVariantsUpdateTarget(params, ctx)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function variants_update(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const { input, productId } = await resolveVariantsUpdateTarget(params, ctx)
  const variant = normalizeVariantBulkInput(stripProductId(input))
  return runMutation(ctx, {
    query: VARIANTS_BULK_UPDATE,
    variables: { productId, variants: [variant], key: idempotencyKey("variants-update", { productId, variant }) },
    dataKey: "productVariantsBulkUpdate",
    eventEntity: "variant",
    eventAction: "updated",
    entityIdPath: "productVariants.0.id",
  })
}

const VARIANTS_BULK_DELETE = `
  mutation ProductVariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id } userErrors { field message }
    }
  }
`
/** Resolve the variant + owning product a variants_delete call targets. READ ONLY. Shared by the
 *  handler and its stage-time preflight so the "variant not found" refusal cannot drift. */
async function resolveVariantsDeleteTarget(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ variantId: string; productId: string }> {
  const variantId = (params.id ?? resolveMutationInput(params).id) as string | undefined
  if (!variantId) throw makeMutationError("BAD_PARAM", "id is required")
  const productId =
    ((params.productId ?? resolveMutationInput(params).productId) as string | undefined) ??
    (await resolveProductIdForVariant(ctx, variantId))
  return { variantId, productId }
}

/**
 * STAGE-TIME preflight for the gated `variants_delete` (manifest `preflight`). A gated call must not
 * be parked for a human when the data it needs is missing: a variant gid that resolves to no owning
 * product can never execute, and a DELETE approval on a phantom variant is pure noise for the human.
 */
export async function variants_delete_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    await resolveVariantsDeleteTarget(params, ctx)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function variants_delete(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const { variantId, productId } = await resolveVariantsDeleteTarget(params, ctx)
  return runMutation(ctx, {
    query: VARIANTS_BULK_DELETE,
    variables: { productId, variantsIds: [variantId] },
    dataKey: "productVariantsBulkDelete",
    eventEntity: "variant",
    eventAction: "deleted",
    entityIdOverride: variantId,
  })
}
