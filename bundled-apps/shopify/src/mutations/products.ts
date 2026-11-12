// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: products (create, update, delete, publish, unpublish).

import type { AppContext } from "@liaison/app-sdk"
import { grantSatisfies, recordedGrantedScopes } from "../lib/constants"
import { getShopifyClient, resolveInstallMetadata } from "../lib/get-client"
import {
  idempotencyKey,
  makeMutationError,
  type PreflightResult,
  preflightRefusal,
  readGatedTarget,
  requireTargetId,
  resolveMutationInput,
  runMutation,
  type ShopClient,
} from "./shared"
import { VARIANTS_BULK_UPDATE } from "./variants"

// ─────────────────────────────────────────────────────────────────────────
//  Products
// ─────────────────────────────────────────────────────────────────────────

// A weak/flash-lite model, drawing on older Shopify training data, INTERMITTENTLY decorates its
// ProductInput with deprecated/renamed/invalid fields — `bodyHtml` one run, `productCategory` the next,
// and other one-offs — each of which Shopify 422s ("Variable $input of type ProductInput! was provided
// invalid value for <field> (Field is not defined on ProductInput)") and fails the WHOLE APPROVED gated
// product create/update on EXECUTION (an unverifiable gated /decide → verdict-override non-green). Per-
// field whack-a-mole can't keep up. So `canonicalizeProductInput` does TWO things, the same "normalize
// weak-model mistakes at the handler" pattern as the DraftOrderInput allowlist:
//   1. CANONICALIZE the documented renames the agent naturally reaches for (first-writer-wins — an
//      explicit canonical field is never clobbered by its alias).
//   2. ALLOWLIST-STRIP any key NOT in the real Admin-API ProductInput field set, so a stray/deprecated/
//      hallucinated extra (`productCategory`, `published`, `vendorName`, …) is DROPPED rather than
//      sinking the whole write — the core create/update (title/description/handle/tags/status/…) still
//      succeeds. Erring toward keeping a field only when it is in the CONFIRMED-valid set.
const PRODUCT_INPUT_FIELD_ALIASES: Record<string, string> = {
  bodyHtml: "descriptionHtml",
  body_html: "descriptionHtml",
  descriptionHTML: "descriptionHtml",
  productType: "productType", // identity (kept for documentation of the canonical key)
}
// The authoritative ProductInput field set (Shopify GraphQL Admin API 2024-04 → 2026-04). `category` is
// the current taxonomy field (a taxonomy node GID string) — the deprecated `productCategory`
// (ProductCategoryInput) is NOT here, so a weak model's `productCategory` is stripped (it can't be cleanly
// value-mapped to a `category` GID, and a product creates fine without a category). Variant/sku/price keys
// are deliberately NOT in this set — `products_create` extracts those for the default-variant step BEFORE
// canonicalization, and `products_update` does not take them.
const PRODUCT_INPUT_FIELDS = new Set([
  "id",
  "title",
  "descriptionHtml",
  "handle",
  "productType",
  "vendor",
  "tags",
  "status",
  "category",
  "templateSuffix",
  "seo",
  "metafields",
  "giftCard",
  "giftCardTemplateSuffix",
  "requiresSellingPlan",
  "collectionsToJoin",
  "collectionsToLeave",
  "redirectNewHandle",
  "combinedListingRole",
  "productOptions",
  "claimOwnership",
])
/** Canonicalize a ProductInput a weak model malforms: map deprecated/renamed field names
 *  (`bodyHtml`/`body_html`/`descriptionHTML` → `descriptionHtml`), then STRIP any key outside the real
 *  Admin-API ProductInput field set (so a stray `productCategory`/`published`/hallucinated extra is
 *  dropped, not 422'd). Mutates and returns the same object. An already-correct input passes through
 *  unchanged; an explicit canonical field is never overwritten by its alias. */
export function canonicalizeProductInput(input: Record<string, unknown>): Record<string, unknown> {
  for (const [alias, canonical] of Object.entries(PRODUCT_INPUT_FIELD_ALIASES)) {
    if (alias === canonical) continue
    if (alias in input) {
      if (input[canonical] === undefined && input[alias] !== undefined)
        input[canonical] = input[alias]
      delete input[alias]
    }
  }
  // Allowlist-strip: drop everything not in the confirmed-valid ProductInput field set. Runs AFTER the
  // alias mapping so a canonicalized field (e.g. descriptionHtml) is kept, and the original alias is gone.
  for (const k of Object.keys(input)) {
    if (!PRODUCT_INPUT_FIELDS.has(k)) delete input[k]
  }
  return input
}

const PRODUCT_CREATE = `
  mutation ProductCreate($input: ProductInput!) {
    productCreate(input: $input) {
      product { id title status variants(first: 1) { edges { node { id } } } }
      userErrors { field message }
    }
  }
`

// ProductInput (API 2024-04+) no longer accepts `variants`/`sku`/`price` — those live on the variant.
// But "create product X with SKU Y at price Z" is the natural ask, and a weak model bundles a
// variant/sku/price into products_create. We extract that spec, strip it from the ProductInput, and
// apply it to the product's auto-created default variant after creation (a 2-step in one tool call).
const PRODUCT_INPUT_VARIANT_KEYS = new Set([
  "variants",
  "sku",
  "price",
  "options",
  "optionValues",
  "inventoryItem",
])
function extractVariantSpec(
  input: Record<string, unknown>,
): { price?: unknown; sku?: unknown } | null {
  const v =
    Array.isArray(input.variants) &&
    input.variants.length > 0 &&
    typeof input.variants[0] === "object"
      ? (input.variants[0] as Record<string, unknown>)
      : input
  const price = v.price
  const sku = v.sku ?? (v.inventoryItem as { sku?: unknown } | undefined)?.sku
  if (price === undefined && sku === undefined) return null
  return { price, sku }
}

type ProductCreateNode = {
  product: {
    id: string
    title?: string
    status?: string
    variants?: { edges?: Array<{ node: { id: string } }> }
  } | null
  [k: string]: unknown
}

export async function products_create(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  // Extract the bundled variant spec (variants/sku/price) BEFORE canonicalizeProductInput's allowlist
  // strips those non-ProductInput keys — they belong on the default variant, applied post-create below.
  const raw = resolveMutationInput(params)
  const variantSpec = extractVariantSpec(raw)
  // Drop the variant-only keys, THEN canonicalize/allowlist the remaining ProductInput fields.
  const productInput = canonicalizeProductInput(
    Object.fromEntries(Object.entries(raw).filter(([k]) => !PRODUCT_INPUT_VARIANT_KEYS.has(k))),
  )
  const created = await runMutation<ProductCreateNode>(ctx, {
    query: PRODUCT_CREATE,
    variables: { input: productInput },
    dataKey: "productCreate",
    eventEntity: "product",
    eventAction: "created",
    entityIdPath: "product.id",
  })
  // Apply the bundled SKU/price to the auto-created default variant via the bulk-update mutation.
  const defaultVariantId = created.product?.variants?.edges?.[0]?.node?.id
  if (variantSpec && created.product?.id && defaultVariantId) {
    const variant: Record<string, unknown> = { id: defaultVariantId }
    if (variantSpec.price !== undefined) variant.price = String(variantSpec.price)
    if (variantSpec.sku !== undefined) variant.inventoryItem = { sku: String(variantSpec.sku) }
    await runMutation(ctx, {
      query: VARIANTS_BULK_UPDATE,
      variables: {
        productId: created.product.id,
        variants: [variant],
        key: idempotencyKey("variants-update", { productId: created.product.id, variant }),
      },
      dataKey: "productVariantsBulkUpdate",
      eventEntity: "variant",
      eventAction: "updated",
      entityIdPath: "productVariants.0.id",
    })
  }
  return created
}

const PRODUCT_UPDATE = `
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) { product { id title status } userErrors { field message } }
  }
`
/** Build + validate the ProductInput a products_update call resolves to. PURE (no network). Shared by
 *  the handler and its stage-time preflight so the wrong-entity refusal cannot drift. */
function buildProductUpdateInput(params: Record<string, unknown>): Record<string, unknown> {
  const input = canonicalizeProductInput(resolveMutationInput(params))
  if (!input.id && params.id) input.id = params.id
  if (!input.id) throw makeMutationError("BAD_PARAM", "id is required")
  // WRONG-ENTITY GUARD (Modular-Expo-leads gate fail): a weak model tasked with TAGGING AN ORDER reaches
  // for products_update (it edits tags too) but passes an ORDER gid. Shopify's productUpdate then 422s with
  // a cryptic "Invalid id: gid://shopify/Order/…" — and because the gate approved the well-formed-looking
  // request, the failure only surfaces on EXECUTION (an unverifiable gated write → forced non-green). Catch
  // the entity mismatch HERE, before the gated approval is even created, with a precise redirect so the
  // agent self-corrects to the right tool (the BL-112 capability-boundary pattern). Only Product gids are
  // valid for productUpdate; an Order gid is the common confusion (order tags → order_update).
  assertProductGid(input.id, "products_update")
  return input
}

/**
 * STAGE-TIME preflight for the gated `products_update` (manifest `preflight`). A gated call must not be
 * parked for a human when the data it needs is wrong: an ORDER gid passed to a PRODUCT tool can only
 * 422, and the approval card looks perfectly legitimate until the human clicks approve.
 */
export async function products_update_preflight(
  params: Record<string, unknown>,
  _ctx: AppContext,
): Promise<PreflightResult> {
  try {
    buildProductUpdateInput(params)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function products_update(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const input = buildProductUpdateInput(params)
  return runMutation(ctx, {
    query: PRODUCT_UPDATE,
    variables: { input },
    dataKey: "productUpdate",
    eventEntity: "product",
    eventAction: "updated",
    entityIdPath: "product.id",
  })
}

/** Throw a precise capability-boundary error if `id` is a Shopify gid for a NON-Product entity (most
 *  commonly an Order, which a weak model passes when it grabs products_update to tag an ORDER). Redirects
 *  to the correct tool so the agent retries instead of issuing a gated write that 422s on execution. A
 *  numeric/legacy id or a non-gid string is left alone (Shopify resolves those). */
function assertProductGid(id: unknown, tool: string): void {
  if (typeof id !== "string") return
  const m = id.match(/^gid:\/\/shopify\/([A-Za-z]+)\//)
  if (!m) return
  const type = m[1]
  if (type === "Product") return
  if (type === "Order") {
    throw makeMutationError(
      "WRONG_ENTITY_FOR_TOOL",
      `${tool} edits a PRODUCT, but you passed an ORDER id (${id}). To edit an order's tags or note, use order_update (it takes the order id + tags/note). products_update CANNOT modify an order.`,
    )
  }
  throw makeMutationError(
    "WRONG_ENTITY_FOR_TOOL",
    `${tool} edits a PRODUCT, but you passed a ${type} id (${id}). Use the tool that matches the entity you want to change (e.g. order_update for an order).`,
  )
}

export const PRODUCT_DELETE = `
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }
`
/** PURE part of the products_delete guard: the id is present and it names a PRODUCT. Shared by the
 *  handler and its stage-time preflight, exactly like `buildProductUpdateInput`. */
function resolveProductDeleteId(params: Record<string, unknown>): string {
  const id = requireTargetId(params, "id")
  assertProductGid(id, "products_delete")
  return id
}

/**
 * STAGE-TIME preflight for the gated `products_delete` (manifest `preflight`). This is a PERMANENT
 * delete, and it was the one product tool with no id guard at all: an ORDER gid or a product that no
 * longer exists produced an approval card the human could only discover was doomed by clicking
 * approve. Runs the SAME pure guard the handler runs, plus a read-only existence probe.
 */
export async function products_delete_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = resolveProductDeleteId(params)
    await readGatedTarget(ctx, id, "Product", "products_delete")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function products_delete(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const id = resolveProductDeleteId(params)
  return runMutation(ctx, {
    query: PRODUCT_DELETE,
    variables: { input: { id } },
    dataKey: "productDelete",
    eventEntity: "product",
    eventAction: "deleted",
    entityIdPath: "deletedProductId",
  })
}
// ─────────────────────────────────────────────────────────────────────────
//  Products — publish / unpublish  (C6)
// ─────────────────────────────────────────────────────────────────────────
//
// `publishablePublish` / `publishableUnpublish` both require `input: [{ publicationId }]`, the sales
// channels (publications) to act on, and both need the `write_publications` OAuth scope. An agent has
// NO way to know a store's real Publication gids, so a weak model either omits them or fabricates one
// (the observed `gid://shopify/Channel/1`, a Channel id, not even a Publication). The agent's INTENT
// ("put this listing on sale" / "take it offline") is unambiguous; the channel ids are an
// implementation detail the handler resolves, never the model:
//   - caller-supplied publicationIds are kept ONLY when they are real Publication gids (and, for a
//     publish, ones the store actually has); anything else is ignored in favour of the resolved set;
//   - publish with no usable ids targets EVERY SALES-CHANNEL publication (catalog == null) the
//     product is not yet on. That is what the Shopify admin does for a new product (available on all
//     sales channels), and it covers the Online Store plus any headless / Storefront API channel a
//     storefront token reads from, without guessing which one is "the" storefront. Catalog
//     publications (B2B company catalogs, market catalogs) are targeted only when named explicitly;
//   - unpublish with no usable ids targets the channels the product is CURRENTLY on, else (on none)
//     every store publication, so the call is a well-formed no-op rather than an empty `input`.
// Never an empty `input`: an empty publish silently publishes nowhere while the card claims success.

/** The OAuth scope both publication mutations need. Shopify: "Access denied for publishablePublish
 *  field. Required access: `write_publications` access scope." */
const PUBLICATIONS_WRITE_SCOPE = "write_publications"

const VALID_PUBLICATION_GID = /^gid:\/\/shopify\/Publication\/\d+$/

// `Publication.name` is deprecated in favour of `catalog.title`, but sales-channel publications carry
// NO catalog (it is null on Online Store / Shop / Point of Sale, checked on API 2026-04), so `name` is
// the only field that names them. Both are read; catalog.title wins when present.
const PRODUCT_PUBLICATIONS_QUERY = `
  query ProductPublications($id: ID!) {
    product(id: $id) {
      id
      title
      createdAt
      resourcePublicationsV2(first: 50) { edges { node { publication { id } isPublished } } }
    }
    publications(first: 50) { edges { node { id name catalog { id title } } } }
  }
`

interface PublicationTarget {
  publicationId: string
  name: string
  publishDate?: string
}

interface ProductPublicationState {
  product: { id: string; title: string | null; createdAt: string | null } | null
  /** Every store publication, in Shopify's order. `catalog` marks a CATALOG publication (B2B company
   *  catalog, market catalog: a non-null `catalog`), as opposed to a sales channel (catalog null). */
  store: Array<{ id: string; name: string; catalog: boolean }>
  /** Publication ids the product is currently published on. */
  publishedOn: string[]
}

async function readProductPublicationState(
  client: ShopClient,
  productId: string,
): Promise<ProductPublicationState> {
  const data = await client.query<{
    product?: {
      id?: string
      title?: string | null
      createdAt?: string | null
      resourcePublicationsV2?: {
        edges?: Array<{ node?: { publication?: { id?: string }; isPublished?: boolean } }>
      } | null
    } | null
    publications?: {
      edges?: Array<{
        node?: {
          id?: string
          name?: string | null
          catalog?: { id?: string; title?: string | null } | null
        }
      }>
    } | null
  }>(PRODUCT_PUBLICATIONS_QUERY, { id: productId })
  const store: ProductPublicationState["store"] = []
  for (const e of data.publications?.edges ?? []) {
    const id = e.node?.id
    if (typeof id !== "string") continue
    const name = e.node?.catalog?.title || e.node?.name || id
    store.push({ id, name, catalog: e.node?.catalog != null })
  }
  const publishedOn = (data.product?.resourcePublicationsV2?.edges ?? [])
    .filter((e) => e.node?.isPublished !== false)
    .map((e) => e.node?.publication?.id)
    .filter((id): id is string => typeof id === "string")
  const p = data.product
  return {
    product: p
      ? { id: p.id ?? productId, title: p.title ?? null, createdAt: p.createdAt ?? null }
      : null,
    store,
    publishedOn,
  }
}

/** Caller-supplied publication targets whose id is a real Publication gid (deduplicated, publishDate
 *  kept). A fabricated Channel id, a bare number or a malformed entry is dropped. */
function suppliedPublicationTargets(
  input: unknown,
): Array<{ publicationId: string; publishDate?: string }> {
  if (!Array.isArray(input)) return []
  const out: Array<{ publicationId: string; publishDate?: string }> = []
  const seen = new Set<string>()
  for (const entry of input) {
    const rec = entry as { publicationId?: unknown; publishDate?: unknown } | null
    const pid = rec?.publicationId
    if (typeof pid !== "string" || !VALID_PUBLICATION_GID.test(pid) || seen.has(pid)) continue
    seen.add(pid)
    const publishDate =
      typeof rec?.publishDate === "string" && rec.publishDate.trim() !== ""
        ? rec.publishDate
        : undefined
    out.push(publishDate ? { publicationId: pid, publishDate } : { publicationId: pid })
  }
  return out
}

function nameOf(state: ProductPublicationState, id: string): string {
  return state.store.find((p) => p.id === id)?.name ?? id
}

/** Sales-channel publications only (catalog == null). Catalog publications (B2B company catalogs,
 *  market catalogs) are never a DEFAULT target: a consumer product must not leak into a B2B or market
 *  catalog because the caller named no channel. They are targeted only when the caller names their gid. */
function salesChannels(state: ProductPublicationState): ProductPublicationState["store"] {
  return state.store.filter((p) => !p.catalog)
}

/** The channels a publish targets (PURE): the caller's real store publications (catalogs included,
 *  since they were named explicitly), else every SALES CHANNEL the product is not yet on. May be empty
 *  (already on every sales channel). */
function publishTargetsFrom(input: unknown, state: ProductPublicationState): PublicationTarget[] {
  const storeIds = new Set(state.store.map((p) => p.id))
  const supplied = suppliedPublicationTargets(input).filter((t) => storeIds.has(t.publicationId))
  if (supplied.length > 0)
    return supplied.map((t) => ({ ...t, name: nameOf(state, t.publicationId) }))
  const on = new Set(state.publishedOn)
  return salesChannels(state)
    .filter((p) => !on.has(p.id))
    .map((p) => ({ publicationId: p.id, name: p.name }))
}

/** The channels an unpublish targets (PURE): the caller's real Publication gids, else the channels the
 *  product is on, else every store publication. */
function unpublishTargetsFrom(input: unknown, state: ProductPublicationState): PublicationTarget[] {
  const supplied = suppliedPublicationTargets(input)
  const ids =
    supplied.length > 0
      ? supplied.map((t) => t.publicationId)
      : state.publishedOn.length > 0
        ? state.publishedOn
        : state.store.map((p) => p.id)
  return ids.map((publicationId) => ({ publicationId, name: nameOf(state, publicationId) }))
}

/** Refuse when the connection's RECORDED grant lacks `write_publications`, so a human is never asked
 *  to approve a publish Shopify will reject. An unrecorded grant (a connection that predates scope
 *  tracking) is unknown, not missing: it passes, and Shopify's own error stays the backstop. */
async function assertPublicationsScope(ctx: AppContext, tool: string): Promise<void> {
  const granted = recordedGrantedScopes(await resolveInstallMetadata(ctx))
  if (granted.length === 0) return
  if (grantSatisfies(new Set(granted), PUBLICATIONS_WRITE_SCOPE)) return
  throw makeMutationError(
    "MISSING_SHOPIFY_SCOPE",
    `${tool} needs the Shopify "${PUBLICATIONS_WRITE_SCOPE}" permission, which this store's connection has not granted. An admin must add it to the Shopify app's configuration (its shopify.app.toml scopes, then shopify app deploy), then reconnect Shopify (Settings, Shopify, Reconnect) to approve the updated permissions, then retry.`,
    403,
  )
}

/** Resolve the product + the channels a products_publish call targets. READ ONLY. Shared by the
 *  handler and its stage-time preflight so the refusals cannot drift. */
async function resolvePublishTarget(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ productId: string; targets: PublicationTarget[] }> {
  const productId = requireTargetId(params, "id")
  assertProductGid(productId, "products_publish")
  const client = await getShopifyClient(ctx)
  const state = await readProductPublicationState(client, productId)
  if (!state.product)
    throw makeMutationError("NOT_FOUND", `products_publish: no Product found for ${productId}.`)
  const targets = publishTargetsFrom(params.input, state)
  if (targets.length === 0 && salesChannels(state).length === 0) {
    throw makeMutationError(
      "NO_PUBLICATIONS",
      `product ${productId} cannot be published: the store has no sales-channel publications`,
    )
  }
  if (targets.length === 0) {
    throw makeMutationError(
      "ALREADY_PUBLISHED",
      `product ${productId} is already published on every sales channel (${salesChannels(state)
        .map((p) => p.name)
        .join(", ")}); there is nothing to publish`,
    )
  }
  return { productId, targets }
}

const PRODUCT_PUBLISH = `
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable { __typename }
      userErrors { field message }
    }
  }
`
/**
 * STAGE-TIME preflight for the gated `products_publish` (manifest `preflight`). Publishing puts a
 * listing in front of customers: a product that does not exist, a connection without the publications
 * permission, or a product already on every channel must never reach the approval card looking
 * legitimate.
 */
export async function products_publish_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    await assertPublicationsScope(ctx, "products_publish")
    await resolvePublishTarget(params, ctx)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function products_publish(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  await assertPublicationsScope(ctx, "products_publish")
  const { productId, targets } = await resolvePublishTarget(params, ctx)
  return runMutation(ctx, {
    query: PRODUCT_PUBLISH,
    variables: {
      id: productId,
      input: targets.map((t) =>
        t.publishDate
          ? { publicationId: t.publicationId, publishDate: t.publishDate }
          : { publicationId: t.publicationId },
      ),
    },
    dataKey: "publishablePublish",
    eventEntity: "product",
    eventAction: "published",
    entityIdOverride: productId,
  })
}

const PRODUCT_UNPUBLISH = `
  mutation PublishableUnpublish($id: ID!, $input: [PublicationInput!]!) {
    publishableUnpublish(id: $id, input: $input) {
      publishable { __typename }
      userErrors { field message }
    }
  }
`
/** Resolve the product + the publications a products_unpublish call targets. READ ONLY. Shared by the
 *  handler and its stage-time preflight so the NO_PUBLICATIONS refusal cannot drift. Real
 *  caller-supplied Publication gids skip the lookup. */
async function resolveUnpublishTarget(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ productId: string; publicationIds: string[] }> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  const productId = String(params.id)
  let publicationIds = suppliedPublicationTargets(params.input).map((t) => t.publicationId)
  if (publicationIds.length === 0) {
    const client = await getShopifyClient(ctx)
    const state = await readProductPublicationState(client, productId)
    publicationIds = unpublishTargetsFrom(undefined, state).map((t) => t.publicationId)
  }
  if (publicationIds.length === 0) {
    // No publications exist on the store at all — nothing this product could be published to.
    throw makeMutationError(
      "NO_PUBLICATIONS",
      `product ${productId} cannot be unpublished: the store has no sales-channel publications`,
    )
  }
  return { productId, publicationIds }
}

/**
 * STAGE-TIME preflight for the gated `products_unpublish` (manifest `preflight`). A gated call must not
 * be parked for a human when there is nothing to unpublish from, or when the connection lacks the
 * publications permission: either way the human learns it only after approving.
 */
export async function products_unpublish_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    await assertPublicationsScope(ctx, "products_unpublish")
    await resolveUnpublishTarget(params, ctx)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function products_unpublish(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  await assertPublicationsScope(ctx, "products_unpublish")
  const { productId, publicationIds } = await resolveUnpublishTarget(params, ctx)
  return runMutation(ctx, {
    query: PRODUCT_UNPUBLISH,
    variables: { id: productId, input: publicationIds.map((publicationId) => ({ publicationId })) },
    dataKey: "publishableUnpublish",
    eventEntity: "product",
    eventAction: "unpublished",
    entityIdOverride: productId,
  })
}

/**
 * Read-only, ungated. Backs `products_publication_targets`, the `summarizerContext` of
 * products_publish and products_unpublish: the approval card names the EXACT channels the approved
 * call will act on, resolved by the same pure rules the handlers use. Also lets an agent see a
 * product's channels before proposing a change.
 */
export async function products_publication_targets(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const productId = requireTargetId(params, "id")
  assertProductGid(productId, "products_publication_targets")
  const client = await getShopifyClient(ctx)
  const state = await readProductPublicationState(client, productId)
  if (!state.product) throw makeMutationError("NOT_FOUND", `no Product found for ${productId}`, 404)
  return {
    id: state.product.id,
    entity: "product",
    title: state.product.title,
    attributes: {
      createdAt: state.product.createdAt,
      salesChannels: state.store.map((p) => ({
        publicationId: p.id,
        name: p.name,
        catalog: p.catalog,
        published: state.publishedOn.includes(p.id),
      })),
      publishTargets: publishTargetsFrom(params.input, state),
      unpublishTargets: unpublishTargetsFrom(params.input, state),
    },
  }
}
