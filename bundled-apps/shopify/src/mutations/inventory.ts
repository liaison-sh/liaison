// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: inventory (adjust, set on hand) and their input normalisation.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "../lib/get-client"
import {
  type PreflightResult,
  isRec,
  resolveMutationInput,
  preflightRefusal,
  runMutation,
  idempotencyKey,
  makeMutationError,
} from "./shared"

// Inventory input normalisation (weak-model API drift). Both mutations expect a precise Shopify
// shape; a weak model supplies natural/wrong fields — a flat `{inventoryItemId, locationId, quantity}`
// (no `setQuantities`/`changes` wrapper), or `newQuantity`/`onHand` instead of `quantity`, or a raw
// absolute `newQuantity` on an ADJUST call (which 422s: `newQuantity` is not a field on
// InventoryChangeInput). Build the exact InventorySetOnHandQuantitiesInput / InventoryAdjustQuantitiesInput
// here so a correct tool call from a weak model executes, mirroring `normalizeDraftOrderInput`.
const invNum = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.trunc(Number(v))
  return undefined
}
// Absolute-quantity field synonyms a weak model uses for "set the count to N".
const INV_ABSOLUTE_KEYS = ["quantity", "newQuantity", "onHand", "onHandQuantity", "available", "availableQuantity", "setQuantity"] as const
// Relative-delta field synonyms for "change by ±N".
const INV_DELTA_KEYS = ["delta", "availableDelta", "adjustment", "change", "quantityDelta"] as const
const invPick = (o: Record<string, unknown>, keys: readonly string[]): number | undefined => {
  for (const k of keys) {
    const n = invNum(o[k])
    if (n !== undefined) return n
  }
  return undefined
}
// Shopify's allowed inventory adjustment-group `reason` enum (Admin API 2026-04). A weak model
// invents free-text reasons ("physical_count", "stocktake", "reconciliation") which 422 the gated
// write; map anything outside the enum to the always-valid "correction".
const SHOPIFY_INVENTORY_REASONS = new Set([
  "correction", "cycle_count_available", "damaged", "movement_canceled", "movement_created",
  "movement_received", "movement_updated", "other", "promotion", "quality_control", "received",
  "reservation_created", "reservation_deleted", "reservation_updated", "restock", "safety_stock",
  "shrinkage",
])
const validInventoryReason = (v: unknown): string =>
  typeof v === "string" && SHOPIFY_INVENTORY_REASONS.has(v) ? v : "correction"
const invRows = (raw: Record<string, unknown>, arrKey: "setQuantities" | "changes"): Record<string, unknown>[] => {
  const src = Array.isArray(raw[arrKey])
    ? raw[arrKey]
    : Array.isArray(raw.quantities)
      ? raw.quantities
      : [raw]
  return (src as unknown[]).filter(isRec)
}
export function normalizeInventorySetOnHandInput(raw: Record<string, unknown>): Record<string, unknown> {
  const setQuantities = invRows(raw, "setQuantities").map((r) => {
    const out: Record<string, unknown> = {}
    if (typeof r.inventoryItemId === "string") out.inventoryItemId = r.inventoryItemId
    if (typeof r.locationId === "string") out.locationId = r.locationId
    const q = invPick(r, INV_ABSOLUTE_KEYS)
    if (q !== undefined) out.quantity = q
    return out
  })
  const input: Record<string, unknown> = {
    reason: validInventoryReason(raw.reason),
    setQuantities,
  }
  if (typeof raw.referenceDocumentUri === "string") input.referenceDocumentUri = raw.referenceDocumentUri
  return input
}
export function normalizeInventoryAdjustInput(raw: Record<string, unknown>): Record<string, unknown> {
  const changes = invRows(raw, "changes").map((r) => {
    const delta = invPick(r, INV_DELTA_KEYS)
    if (delta === undefined && invPick(r, INV_ABSOLUTE_KEYS) !== undefined) {
      // The agent gave an ABSOLUTE quantity to the relative-delta tool — the exact set-vs-adjust
      // confusion. Refuse with a message naming the correct tool so it self-corrects (never silently
      // convert: that would mask the wrong-tool choice and let a non-set masquerade as a set).
      throw new Error(
        "inventory_adjust applies a RELATIVE delta (e.g. +5 received, -2 damaged). You supplied an absolute count. To SET the on-hand quantity to a specific number, use the inventory_set_on_hand tool instead.",
      )
    }
    const out: Record<string, unknown> = {}
    if (typeof r.inventoryItemId === "string") out.inventoryItemId = r.inventoryItemId
    if (typeof r.locationId === "string") out.locationId = r.locationId
    if (delta !== undefined) out.delta = delta
    return out
  })
  const input: Record<string, unknown> = {
    reason: validInventoryReason(raw.reason),
    name: typeof raw.name === "string" && raw.name ? raw.name : "available",
    changes,
  }
  if (typeof raw.referenceDocumentUri === "string") input.referenceDocumentUri = raw.referenceDocumentUri
  return input
}

// Like inventorySetQuantities, the Admin API 2026-04 `inventoryAdjustQuantities` field REQUIRES the
// `@idempotent(key:)` directive (the 2026-04 write-mutation contract) — without it the mutation errors
// ("The @idempotent directive is required"). Deterministic key (no randomness → QuickJS-sandbox-safe +
// retry-correct: a true retry of the SAME adjust dedupes, distinct adjusts get distinct keys). (BL-105.)
const INVENTORY_ADJUST = `
  mutation InventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $key: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id reason changes { delta name location { id } } }
      userErrors { field message }
    }
  }
`
/**
 * STAGE-TIME preflight for the gated `inventory_adjust` (manifest `preflight`). A gated call must not be
 * parked for a human when the tool cannot do what was asked: an ABSOLUTE count handed to the relative
 * delta tool is the wrong tool, and the agent can still switch to inventory_set_on_hand at staging.
 * Runs the SAME normaliser the handler runs; the live changeFromQuantity fill stays in the handler,
 * where it is read fresh.
 */
export async function inventory_adjust_preflight(
  params: Record<string, unknown>,
  _ctx: AppContext,
): Promise<PreflightResult> {
  try {
    normalizeInventoryAdjustInput(resolveMutationInput(params))
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function inventory_adjust(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const input = normalizeInventoryAdjustInput(resolveMutationInput(params))
  // 2026-04 ALSO requires changeFromQuantity per change (optimistic concurrency, like
  // inventorySetQuantities) — InventoryChangeInput 422s "must include changeFromQuantity" without it.
  // Fill it from the live current quantity of the adjusted `name` (skip if the caller supplied one). (BL-105.)
  const client = await getShopifyClient(ctx)
  const name = typeof input.name === "string" && input.name ? input.name : "available"
  const rows = Array.isArray(input.changes) ? (input.changes as Record<string, unknown>[]) : []
  input.changes = await Promise.all(
    rows.map(async (r) => {
      if (
        typeof r.inventoryItemId === "string" &&
        typeof r.locationId === "string" &&
        invNum(r.changeFromQuantity) === undefined
      ) {
        return { ...r, changeFromQuantity: await currentQuantity(client, r.inventoryItemId, r.locationId, name) }
      }
      return r
    }),
  )
  return runMutation(ctx, { query: INVENTORY_ADJUST, variables: { input, key: idempotencyKey("inventory-adjust", input) }, dataKey: "inventoryAdjustQuantities", eventEntity: "inventory", eventAction: "adjusted", entityIdPath: "inventoryAdjustmentGroup.id" })
}

// Set the ABSOLUTE on-hand count. Admin API 2026-04 REMOVED `inventorySetOnHandQuantities`; the
// modern path is `inventorySetQuantities(name:"on_hand")`, which (a) REQUIRES a `changeFromQuantity`
// per item (optimistic concurrency — the value you believe is current; we read it live) and (b)
// REQUIRES the `@idempotent(key:)` directive on the field. (Verified against the live dev store.)
const INVENTORY_LEVEL_READ = `
  query InvLevelOnHand($id: ID!, $loc: ID!) {
    inventoryItem(id: $id) {
      inventoryLevel(locationId: $loc) { quantities(names: ["on_hand"]) { name quantity } }
    }
  }
`
const INVENTORY_SET_QUANTITIES = `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      inventoryAdjustmentGroup { id reason changes { delta name location { id } } }
      userErrors { field message }
    }
  }
`
/** Live on-hand count for one inventoryItem/location pair, or NULL when the pair does not resolve
 *  (a mistyped inventoryItemId, a location the item is not stocked at). It used to return 0 for
 *  both, so a typo was indistinguishable from a genuine zero and rode all the way to Shopify as a
 *  changeFromQuantity of 0 the human had already approved. A genuine zero still returns 0. */
async function currentOnHand(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  inventoryItemId: string,
  locationId: string,
): Promise<number | null> {
  const data = await client.query<{
    inventoryItem: { inventoryLevel: { quantities: { name: string; quantity: number }[] } | null } | null
  }>(INVENTORY_LEVEL_READ, { id: inventoryItemId, loc: locationId })
  const q = data.inventoryItem?.inventoryLevel?.quantities?.find((x) => x.name === "on_hand")
  return typeof q?.quantity === "number" ? q.quantity : null
}
// Live current quantity of an ARBITRARY name (e.g. "available") — for inventory_adjust's
// changeFromQuantity (BL-105). Generalises currentOnHand, which is fixed to "on_hand".
const INVENTORY_LEVEL_READ_NAMED = `
  query InvLevelNamed($id: ID!, $loc: ID!, $names: [String!]!) {
    inventoryItem(id: $id) {
      inventoryLevel(locationId: $loc) { quantities(names: $names) { name quantity } }
    }
  }
`
async function currentQuantity(
  client: Awaited<ReturnType<typeof getShopifyClient>>,
  inventoryItemId: string,
  locationId: string,
  name: string,
): Promise<number> {
  const data = await client.query<{
    inventoryItem: { inventoryLevel: { quantities: { name: string; quantity: number }[] } | null } | null
  }>(INVENTORY_LEVEL_READ_NAMED, { id: inventoryItemId, loc: locationId, names: [name] })
  const q = data.inventoryItem?.inventoryLevel?.quantities?.find((x) => x.name === name)
  return typeof q?.quantity === "number" ? q.quantity : 0
}
/**
 * Normalise a set-on-hand call and resolve each row's changeFromQuantity from the LIVE on-hand count.
 * READ ONLY (one inventory-level query per row, no mutation). Shared by the handler and its
 * stage-time preflight, so the id validation cannot drift between the two.
 */
async function resolveInventorySetOnHandQuantities(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ norm: Record<string, unknown>; quantities: Record<string, unknown>[] }> {
  const norm = normalizeInventorySetOnHandInput(resolveMutationInput(params))
  const client = await getShopifyClient(ctx)
  const rawRows = Array.isArray(norm.setQuantities) ? (norm.setQuantities as Record<string, unknown>[]) : []
  if (!rawRows.some((r) => typeof r.inventoryItemId === "string" && typeof r.locationId === "string")) {
    throw makeMutationError(
      "BAD_PARAM",
      "inventory_set_on_hand needs an inventoryItemId and a locationId on every row (read them with inventory_levels_list).",
    )
  }
  const quantities = await Promise.all(
    rawRows.map(async (r) => {
      const out: Record<string, unknown> = { ...r }
      // Fill changeFromQuantity from the live current on_hand (skip if the caller already supplied one).
      if (
        typeof r.inventoryItemId === "string" &&
        typeof r.locationId === "string" &&
        invNum(r.changeFromQuantity) === undefined
      ) {
        const onHand = await currentOnHand(client, r.inventoryItemId, r.locationId)
        if (onHand === null) {
          throw makeMutationError(
            "NOT_FOUND",
            `inventory_set_on_hand: no stock level for inventory item ${r.inventoryItemId} at location ${r.locationId}. Check both ids with inventory_levels_list (the item may not be stocked at that location).`,
          )
        }
        out.changeFromQuantity = onHand
      }
      return out
    }),
  )
  return { norm, quantities }
}

/**
 * STAGE-TIME preflight for the gated `inventory_set_on_hand` (manifest `preflight`). Its sibling
 * inventory_adjust already preflights; this one did not, and its live on-hand lookup silently read 0
 * for an inventoryItemId/locationId pair that does not exist, so a typo became an approved write
 * against the wrong optimistic baseline. Runs the SAME read-only resolution the handler runs.
 */
export async function inventory_set_on_hand_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    await resolveInventorySetOnHandQuantities(params, ctx)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function inventory_set_on_hand(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const { norm, quantities } = await resolveInventorySetOnHandQuantities(params, ctx)
  const input: Record<string, unknown> = {
    reason: typeof norm.reason === "string" && norm.reason ? norm.reason : "correction",
    name: "on_hand",
    quantities,
  }
  if (typeof norm.referenceDocumentUri === "string") input.referenceDocumentUri = norm.referenceDocumentUri
  // Deterministic idempotency key (no randomness → sandbox-safe + retry-correct): a true retry of the
  // SAME set dedupes; distinct sets get distinct keys. Bounded to Shopify's String length.
  const key = `set-on-hand:${quantities
    .map((q) => `${String(q.inventoryItemId)}@${String(q.locationId)}=${String(q.quantity)}<${String(q.changeFromQuantity)}`)
    .join("|")}`.slice(0, 250)
  return runMutation(ctx, {
    query: INVENTORY_SET_QUANTITIES,
    variables: { input, key },
    dataKey: "inventorySetQuantities",
    eventEntity: "inventory",
    eventAction: "set_on_hand",
    entityIdPath: "inventoryAdjustmentGroup.id",
  })
}
