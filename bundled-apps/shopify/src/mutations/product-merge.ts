// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: products_merge (fold a duplicate product into a survivor).

import type { AppContext } from "@liaison/app-sdk"
import { grantSatisfies, recordedGrantedScopes } from "../lib/constants"
import { getShopifyClient, resolveInstallMetadata } from "../lib/get-client"
import { inventory_adjust } from "./inventory"
import { PRODUCT_DELETE } from "./products"
import {
  assertNoUserErrors,
  emitMutationEvent,
  gidFrom,
  idempotencyKey,
  makeMutationError,
  markExternalEffect,
  type PreflightResult,
  preflightRefusal,
  resolveMutationInput,
  runMutation,
  type UserError,
} from "./shared"
import { VARIANTS_BULK_CREATE } from "./variants"

// ─────────────────────────────────────────────────────────────────────────
//  products_merge — synthetic merge primitive (BL-262)
// ─────────────────────────────────────────────────────────────────────────
//
// Shopify Admin has NO native product-merge primitive: merging two duplicate
// listings into one is not a single Admin API call. `products_merge` is a
// SYNTHETIC, orchestrated, GATED helper that does the merge legibly in ONE
// gated action so the human reviews a real consolidation (survivor + the
// to-be-deleted duplicate + the data-loss/redirect summary) instead of a bare
// `products_delete` on an opaque id. On approval it:
//   (1) REASSIGNS the duplicate's variants/inventory onto the survivor — each
//       duplicate variant whose SKU is NOT already on the survivor is recreated
//       on the survivor carrying its SKU + price + on-hand inventory per
//       location (productVariantsBulkCreate). Variants whose SKU already exists
//       on the survivor are skipped (no duplicate-SKU 422).
//   (2) SETS UP A URL REDIRECT from the deleted duplicate's storefront handle to
//       the survivor, so inbound links/SEO are preserved (urlRedirectCreate).
//   (3) DELETES the duplicate product (productDelete).
// Every leg fails LOUD on a Shopify userError (the gated write surfaces the real
// message in the approval-result panel) — never a silent skip that would leave a
// half-merged store and a misleading "merged" claim. Reviews/metafields do NOT
// carry over (no Admin primitive exists) — the data-loss caveat the summarizer
// surfaces says so.

interface MergeInventoryLevel {
  location: { id: string } | null
  quantities: { name: string; quantity: number }[] | null
}
interface MergeVariantNode {
  id: string
  sku: string | null
  price: string | null
  inventoryQuantity: number | null
  selectedOptions: { name: string; value: string }[] | null
  inventoryItem: {
    id: string | null
    inventoryLevels: { edges: { node: MergeInventoryLevel }[] } | null
  } | null
}
interface MergeProductNode {
  id: string
  title: string
  handle: string | null
  hasOnlyDefaultVariant: boolean | null
  options: { name: string; optionValues: { name: string }[] | null }[] | null
  variants: { edges: { node: MergeVariantNode }[] }
}
// Reads everything the merge orchestration needs in one round-trip per product: the option structure
// (`hasOnlyDefaultVariant` + `options`) so we know whether the survivor can take a NEW variant at all (a
// single-default-option product CANNOT — Shopify rejects a 2nd variant with "The variant 'Default Title'
// already exists"), each variant's selectedOptions (to carry distinct optionValues when the survivor IS
// multi-option), and per-location on-hand levels (to consolidate the duplicate's inventory onto the
// survivor without splitting it across two listings).
const PRODUCT_MERGE_READ = `
  query ProductMergeRead($id: ID!) {
    product(id: $id) {
      id title handle hasOnlyDefaultVariant
      options { name optionValues { name } }
      variants(first: 100) {
        edges { node {
          id sku price inventoryQuantity
          selectedOptions { name value }
          inventoryItem {
            id
            inventoryLevels(first: 20) {
              edges { node { location { id } quantities(names: ["on_hand"]) { name quantity } } }
            }
          }
        } }
      }
    }
  }
`

/** Read a product (id, title, handle, variants with sku/price/inventory) for the merge orchestration. */
async function readMergeProduct(
  ctx: AppContext,
  id: string,
  role: string,
): Promise<MergeProductNode> {
  const client = await getShopifyClient(ctx)
  const data = await client.query<{ product?: MergeProductNode | null }>(PRODUCT_MERGE_READ, { id })
  if (!data.product)
    throw makeMutationError("NOT_FOUND", `products_merge: the ${role} product ${id} was not found`)
  return data.product
}

const URL_REDIRECT_CREATE = `
  mutation UrlRedirectCreate($urlRedirect: UrlRedirectInput!) {
    urlRedirectCreate(urlRedirect: $urlRedirect) {
      urlRedirect { id path target }
      userErrors { field message }
    }
  }
`
// Read an existing redirect by exact path (to reconcile an "already taken" create idempotently).
const URL_REDIRECTS_BY_PATH = `
  query UrlRedirectsByPath($q: String!) {
    urlRedirects(first: 10, query: $q) { edges { node { id path target } } }
  }
`
// Repoint an existing redirect's target onto the survivor (when a stale redirect points elsewhere).
const URL_REDIRECT_UPDATE = `
  mutation UrlRedirectUpdate($id: ID!, $urlRedirect: UrlRedirectInput!) {
    urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) {
      urlRedirect { id path target }
      userErrors { field message }
    }
  }
`

/** Resolve the two product gids the merge operates on, accepting the natural aliases a weak model
 *  reaches for: survivorId/keepId/keep/canonicalId/targetId for the listing to KEEP, and
 *  duplicateId/removeId/remove/sourceId/deleteId for the one to remove. The survivor is the listing
 *  inventory/variants are reassigned ONTO; the duplicate is redirected + deleted. */
function resolveMergeIds(params: Record<string, unknown>): {
  survivorId: string
  duplicateId: string
} {
  const input = resolveMutationInput(params)
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = (input[k] ?? params[k]) as unknown
      const gid = gidFrom(v)
      if (gid) return gid
    }
    return undefined
  }
  const survivorId = pick(
    "survivorId",
    "keepId",
    "keep",
    "canonicalId",
    "canonical",
    "targetId",
    "winnerId",
  )
  const duplicateId = pick(
    "duplicateId",
    "removeId",
    "remove",
    "sourceId",
    "deleteId",
    "loserId",
    "redundantId",
  )
  if (!survivorId)
    throw makeMutationError(
      "BAD_PARAM",
      "products_merge: the survivor product id is required (survivorId, the listing to KEEP). Read both listings with products_search first, then pass the canonical one to keep.",
    )
  if (!duplicateId)
    throw makeMutationError(
      "BAD_PARAM",
      "products_merge: the duplicate product id is required (duplicateId, the listing to REMOVE).",
    )
  if (survivorId === duplicateId)
    throw makeMutationError(
      "BAD_PARAM",
      "products_merge: survivorId and duplicateId are the SAME product: you must name two distinct listings.",
    )
  return { survivorId, duplicateId }
}

/**
 * Synthetic, gated product merge: reassign the duplicate's variants/inventory onto the survivor, set up
 * a handle→survivor URL redirect, then delete the duplicate. One legible orchestrated action.
 */
/**
 * STAGE-TIME preflight for the gated `products_merge` (manifest `preflight`). A gated call must not be
 * parked for a human when the data it needs is missing: products_merge DELETES the duplicate listing,
 * so a survivor/duplicate id that resolves to nothing must be refused at staging, never after the
 * approve (by then the merge has already started reassigning variants). Runs the SAME id resolution
 * and the SAME two product reads the handler runs, read-only.
 */
export async function products_merge_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const { survivorId, duplicateId } = resolveMergeIds(params)
    const survivor = await readMergeProduct(ctx, survivorId, "survivor (keep)")
    const duplicate = await readMergeProduct(ctx, duplicateId, "duplicate (remove)")
    await assertRedirectScope(ctx, redirectPlan(survivor, duplicate))
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function products_merge(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const { survivorId, duplicateId } = resolveMergeIds(params)
  const survivor = await readMergeProduct(ctx, survivorId, "survivor (keep)")
  const duplicate = await readMergeProduct(ctx, duplicateId, "duplicate (remove)")
  // The redirect leg needs a scope the variant leg does not: check it BEFORE the first write, so a
  // connection without it gets a refusal, never variants copied onto the survivor with the duplicate
  // left in place (the grant can change between staging and approval, so the handler checks again).
  const plannedRedirect = redirectPlan(survivor, duplicate)
  await assertRedirectScope(ctx, plannedRedirect)

  // SKUs already on the survivor — duplicate variants matching these are NOT recreated (a duplicate SKU
  // 422s "SKU has already been taken"). Case-insensitive, trimmed.
  const survivorSkus = new Set(
    survivor.variants.edges
      .map((e) => (typeof e.node.sku === "string" ? e.node.sku.trim().toLowerCase() : ""))
      .filter((s) => s.length > 0),
  )

  // Can the survivor take a brand-new variant at all? A product whose only option is the implicit
  // default ("Default Title") has EXACTLY ONE variant slot — `productVariantsBulkCreate` of a 2nd
  // variant 422s "The variant 'Default Title' already exists" (observed on the live dev store). Two
  // migration-duplicate listings of the SAME product are each single-default-variant, so the faithful
  // merge there is NOT to mint a spurious 2nd variant on the survivor (that would invent a variant the
  // product never had) — it is to CONSOLIDATE the duplicate's on-hand inventory onto the survivor's
  // existing primary variant (the "don't split inventory" the user asked for), then let the duplicate's
  // SKU retire with the deleted listing. When the survivor DOES carry real options (a genuine
  // multi-variant product), a non-overlapping duplicate variant is recreated on it carrying its
  // distinct optionValues so it coexists. The handler picks the correct path per survivor structure.
  const survivorIsSingleDefault =
    survivor.hasOnlyDefaultVariant === true ||
    // Fallback inference for older API shapes that omit hasOnlyDefaultVariant: a single variant whose
    // only selected option is the default "Title=Default Title" is the implicit-default product.
    (survivor.variants.edges.length === 1 &&
      isImplicitDefaultOptions(survivor.variants.edges[0]?.node.selectedOptions))
  const survivorPrimary = survivor.variants.edges[0]?.node
  const survivorInvItemId = survivorPrimary?.inventoryItem?.id ?? null

  const reassigned: { sku: string; variantId: string }[] = []
  const consolidated: { sku: string; onHandAdded: number }[] = []
  const skipped: string[] = []
  for (const e of duplicate.variants.edges) {
    const v = e.node
    const sku = typeof v.sku === "string" ? v.sku.trim() : ""
    if (sku.length === 0) {
      // A variant with no SKU cannot be safely matched/reassigned — record it as a skip in the result
      // (it is a no-loss skip: no unique SKU to carry over) rather than fabricating one.
      skipped.push(v.id)
      continue
    }
    if (survivorSkus.has(sku.toLowerCase())) {
      skipped.push(sku) // already on the survivor — nothing to reassign
      continue
    }

    if (survivorIsSingleDefault) {
      // CONSOLIDATE path — the survivor cannot hold a 2nd variant. Add the duplicate variant's on-hand,
      // per location, onto the survivor's primary variant so inventory is not lost or split. We add only
      // POSITIVE on-hand and only at locations the survivor's inventory item is stocked at (adjusting an
      // untracked location 422s); a duplicate location with no matching survivor level is recorded but
      // not invented. Fail-loud on a userError (no silent half-merge).
      if (!survivorInvItemId)
        throw makeMutationError(
          "MERGE_NO_SURVIVOR_INVENTORY",
          `products_merge: the survivor's primary variant has no inventory item, so the duplicate SKU ${sku}'s on-hand cannot be consolidated onto it`,
        )
      const dupLevels = onHandByLocation(v)
      let added = 0
      for (const [locationId, dupOnHand] of dupLevels) {
        if (dupOnHand <= 0) continue
        // Only consolidate at a location the survivor item is actually tracked at (avoids a 422 on an
        // untracked location). The survivor's per-location on-hand is read live by inventory_adjust to
        // fill changeFromQuantity, so we just submit the positive delta here.
        if (!survivorTracksLocation(survivorPrimary, locationId)) {
          skipped.push(`${sku}@${locationId} (survivor not stocked at this location)`)
          continue
        }
        // Consolidate against the SAME quantity name we read off the duplicate (on_hand → on_hand) so the
        // delta is faithful; inventory_adjust fills changeFromQuantity from the survivor's live on_hand.
        await inventory_adjust(
          {
            input: {
              reason: "movement_created",
              name: "on_hand",
              changes: [{ inventoryItemId: survivorInvItemId, locationId, delta: dupOnHand }],
            },
          },
          ctx,
        )
        added += dupOnHand
      }
      consolidated.push({ sku, onHandAdded: added })
      continue
    }

    // RECREATE path — the survivor is a genuine multi-option product, so add the duplicate variant as a
    // new variant carrying its own distinct optionValues (mapped from selectedOptions) so it coexists.
    const variant: Record<string, unknown> = { inventoryItem: { sku } }
    if (v.price != null) variant.price = String(v.price)
    const optionValues = mergeOptionValues(v.selectedOptions, survivor.options)
    if (optionValues.length > 0) variant.optionValues = optionValues
    const created = await runMutation<{ productVariants?: { id?: string; sku?: string }[] }>(ctx, {
      query: VARIANTS_BULK_CREATE,
      variables: {
        productId: survivor.id,
        variants: [variant],
        key: idempotencyKey("merge-variant", { productId: survivor.id, sku }),
      },
      dataKey: "productVariantsBulkCreate",
      eventEntity: "variant",
      eventAction: "created",
      entityIdPath: "productVariants.0.id",
    })
    const newVariantId = created.productVariants?.[0]?.id ?? ""
    reassigned.push({ sku, variantId: newVariantId })
  }

  // Set up a URL redirect from the duplicate's storefront handle to the survivor's, preserving inbound
  // links + SEO. Skipped only when the duplicate has no handle (a never-published throwaway has none →
  // there is no inbound URL to preserve, so this is a legitimate no-op, not a swallowed failure).
  let redirect: { path: string; target: string } | null = null
  if (plannedRedirect) {
    const { path, target } = plannedRedirect
    const client = await getShopifyClient(ctx)
    markExternalEffect(ctx) // direct mutation send (bypasses runMutation's marking)
    const rdata = await client.query<{
      urlRedirectCreate?: {
        urlRedirect?: { id?: string; path?: string; target?: string } | null
        userErrors?: UserError[]
      }
    }>(URL_REDIRECT_CREATE, { urlRedirect: { path, target } })
    const createErrs = (rdata.urlRedirectCreate?.userErrors ?? []) as UserError[]
    if (createErrs.some((e) => /already been taken|already exists/i.test(e.message ?? ""))) {
      // A redirect for this path already exists (e.g. a prior partial merge). That is IDEMPOTENT, not a
      // failure: if it already targets the survivor we are done; if it points elsewhere we UPDATE it to
      // the survivor. Only a genuinely unresolvable state throws. (Not a swallow — the desired end-state
      // is "path → survivor", which we verify/repair rather than blindly pass.)
      const existing = await client.query<{
        urlRedirects?: { edges?: { node?: { id?: string; path?: string; target?: string } }[] }
      }>(URL_REDIRECTS_BY_PATH, { q: `path:${path}` })
      const node = (existing.urlRedirects?.edges ?? [])
        .map((e) => e.node)
        .find((n) => n?.path === path)
      if (!node?.id)
        throw makeMutationError(
          "MERGE_REDIRECT_CONFLICT",
          `products_merge: urlRedirectCreate reported the path ${path} is already taken, but no existing redirect for it could be read to reconcile`,
          502,
        )
      if (node.target !== target) {
        markExternalEffect(ctx) // direct mutation send (bypasses runMutation's marking)
        const upd = await client.query<{
          urlRedirectUpdate?: { urlRedirect?: { id?: string } | null; userErrors?: UserError[] }
        }>(URL_REDIRECT_UPDATE, { id: node.id, urlRedirect: { path, target } })
        assertNoUserErrors(
          upd.urlRedirectUpdate as Record<string, unknown> | undefined,
          "urlRedirectUpdate",
        )
      }
    } else {
      assertNoUserErrors(
        rdata.urlRedirectCreate as Record<string, unknown> | undefined,
        "urlRedirectCreate",
      )
    }
    redirect = { path, target }
  }

  // Delete the duplicate (gated approval already cleared — this is the execution leg).
  const del = await runMutation<{ deletedProductId?: string }>(ctx, {
    query: PRODUCT_DELETE,
    variables: { input: { id: duplicate.id } },
    dataKey: "productDelete",
    eventEntity: "product",
    eventAction: "deleted",
    entityIdPath: "deletedProductId",
  })

  // Top-level merge event for attention/audit (declared in manifest.events.emits as product:merged).
  await emitMutationEvent(ctx, "product", "merged", survivor.id, {
    survivor: { id: survivor.id, title: survivor.title },
    duplicate: { id: duplicate.id, title: duplicate.title },
    variantsReassigned: reassigned,
    variantsConsolidated: consolidated,
    variantsSkipped: skipped,
    redirect,
  })

  const note = survivorIsSingleDefault
    ? "The duplicate's on-hand inventory was consolidated onto the survivor's variant (the two listings " +
      "are one product, so inventory is merged rather than split into a second variant), a URL redirect " +
      "was set up, and the duplicate was deleted. Product reviews and metafields do NOT carry over " +
      "(Shopify exposes no merge primitive for them)."
    : "The duplicate's variants/inventory were reassigned onto the survivor and a URL redirect set up; " +
      "the duplicate was deleted. Product reviews and metafields do NOT carry over (Shopify exposes no " +
      "merge primitive for them)."

  return {
    survivor: { id: survivor.id, title: survivor.title },
    deletedProductId: del.deletedProductId ?? duplicate.id,
    duplicate: { id: duplicate.id, title: duplicate.title },
    variantsReassigned: reassigned,
    variantsConsolidated: consolidated,
    variantsSkipped: skipped,
    redirect,
    note,
  }
}

/** The Shopify scope `urlRedirectCreate` / `urlRedirectUpdate` need. */
export const REDIRECT_WRITE_SCOPE = "write_online_store_navigation"

/** The duplicate-handle -> survivor-handle redirect a merge sets up (PURE), or null when there is no
 *  inbound URL to preserve (the duplicate has no handle, or both share it). */
function redirectPlan(
  survivor: MergeProductNode,
  duplicate: MergeProductNode,
): { path: string; target: string } | null {
  const dupHandle = typeof duplicate.handle === "string" ? duplicate.handle.trim() : ""
  const survivorHandle = typeof survivor.handle === "string" ? survivor.handle.trim() : ""
  if (dupHandle.length === 0 || survivorHandle.length === 0 || dupHandle === survivorHandle)
    return null
  return { path: `/products/${dupHandle}`, target: `/products/${survivorHandle}` }
}

/** Refuse a merge that needs a redirect when the connection's recorded grant does not hold the
 *  redirect scope. An UNRECORDED grant refuses too: the scope was added to the OAuth request after
 *  grant tracking, so a connection whose grant was never recorded cannot hold it, and letting it
 *  through would copy the variants, then fail on the redirect with the duplicate still in place. */
async function assertRedirectScope(ctx: AppContext, plan: { path: string } | null): Promise<void> {
  if (!plan) return
  const granted = recordedGrantedScopes(await resolveInstallMetadata(ctx))
  if (grantSatisfies(new Set(granted), REDIRECT_WRITE_SCOPE)) return
  throw makeMutationError(
    "MISSING_SHOPIFY_SCOPE",
    `products_merge needs the Shopify "${REDIRECT_WRITE_SCOPE}" permission to redirect ${plan.path} to the kept listing, and this store's connection has not granted it, so nothing was changed. An admin must add it to the Shopify app's configuration (its shopify.app.toml scopes, then shopify app deploy), then reconnect Shopify (Settings, Shopify, Reconnect) to approve the updated permissions, then retry.`,
    403,
  )
}

// ── products_merge inventory/option helpers ──────────────────────────────
/** True iff a variant's selectedOptions are just the implicit default ("Title" = "Default Title"). */
function isImplicitDefaultOptions(
  opts: { name: string; value: string }[] | null | undefined,
): boolean {
  if (!Array.isArray(opts) || opts.length === 0) return true // no options node ⇒ implicit default
  return opts.length === 1 && opts[0]?.name === "Title" && opts[0]?.value === "Default Title"
}

/** Sum a merge variant's on-hand quantity per location → Map(locationId → onHand). */
function onHandByLocation(v: MergeVariantNode): Map<string, number> {
  const out = new Map<string, number>()
  const edges = v.inventoryItem?.inventoryLevels?.edges ?? []
  for (const le of edges) {
    const locId = le.node.location?.id
    if (!locId) continue
    const onHand = le.node.quantities?.find((q) => q.name === "on_hand")?.quantity ?? 0
    out.set(locId, (out.get(locId) ?? 0) + (typeof onHand === "number" ? onHand : 0))
  }
  return out
}

/** True iff the survivor's primary variant is tracked at the given location (so an adjust there is valid). */
function survivorTracksLocation(
  primary: MergeVariantNode | undefined,
  locationId: string,
): boolean {
  const edges = primary?.inventoryItem?.inventoryLevels?.edges ?? []
  return edges.some((le) => le.node.location?.id === locationId)
}

/** Map a duplicate variant's selectedOptions → ProductVariantsBulkInput.optionValues ([{name, optionName}]),
 *  restricted to option names the survivor actually declares (an unknown option name 422s). */
function mergeOptionValues(
  selectedOptions: { name: string; value: string }[] | null | undefined,
  survivorOptions: { name: string; optionValues: { name: string }[] | null }[] | null | undefined,
): { name: string; optionName: string }[] {
  if (!Array.isArray(selectedOptions)) return []
  const survivorOptionNames = new Set((survivorOptions ?? []).map((o) => o.name))
  return selectedOptions
    .filter((o) => o && o.name !== "Title" && survivorOptionNames.has(o.name))
    .map((o) => ({ name: o.value, optionName: o.name }))
}
