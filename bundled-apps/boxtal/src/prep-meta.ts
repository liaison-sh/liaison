// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `prep_meta` — the per-document cache of the ORDER facts (order number, order DATE, tags,
// refund/cancel state, staff note) that every shipping surface reads back without a Shopify
// round trip: the prep grid's Order cell, the Ready-to-ship order date column, the label's
// merchant `externalId`, and the refunded/cancelled ship block.
//
// It lives in its own module because BOTH prep.ts (the sync that fills it) and shipment.ts (the
// label buy that WARMS it, see `warmPrepMetaForDocument`) need it, and those two already import
// each other — hanging it off either one would close the cycle.
import { stateRequired } from "./address"
import { sameLocation } from "./address-check"
import type { BoxtalToolCtx } from "./ctx"
import { toShopifyOrderGid } from "./shopify-ref"

function blankField(v: string | null | undefined): boolean {
  return v == null || v.trim() === ""
}

interface ShopifyOrderMeta {
  name?: string | null
  tags?: string[] | null
  createdAt?: string | null
  created_at?: string | null
  /** shopify:orders_get nests tags/createdAt under `attributes` — the
   *  top-level fields cover other order shapes. */
  attributes?: {
    tags?: string[] | null
    createdAt?: string | null
    /** Shopify `displayFinancialStatus` — REFUNDED / PARTIALLY_REFUNDED / … */
    financialStatus?: string | null
    /** Shopify `cancelledAt` — null on a live order. */
    cancelledAt?: string | null
    /** The order's own email (shopify:orders_get puts it here, not on
     *  shippingAddress/customerAddress — neither carries an email field). */
    email?: string | null
  } | null
  financialStatus?: string | null
  cancelledAt?: string | null
  email?: string | null
}

export interface ShopifyOrderAddress {
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  city?: string | null
  zip?: string | null
  countryCode?: string | null
  phone?: string | null
  province?: string | null
  provinceCode?: string | null
  email?: string | null
}

export interface ShopifyOrderMetaRead {
  name: string | null
  tags: string[]
  created_at: string | null
  /** Refund/cancel facts — a refunded or cancelled order must never be
   *  prepared or shipped. See order-shippability.ts. */
  financial_status: string | null
  cancelled_at: string | null
  /** Structured ship-to (per-order shippingAddress, else the customer's
   *  default address) — the source for the contact shipping_address backfill. */
  address: ShopifyOrderAddress | null
  /** The ship-to a shipment draft reads, marked as the order's own shippingAddress or the
   *  customer's default address (the order carries none). As `address`, except that the customer's phone fills an
   *  order address with none only when the customer's address is the same place (a B2B customer's
   *  head-office phone must not ride on a parcel to its warehouse). */
  ship_to: CachedShipTo | null
}

/** The order's ship-to as cached on `prep_meta.ship_to`, so worklist drafts (which never read the
 *  order) still let the order's own address beat an address copied onto the contact. */
export interface CachedShipTo {
  source: "order" | "customer"
  address: ShopifyOrderAddress
  fetched_at?: string
}

/** What `prep_meta.ship_to` holds once the order has been read and carries NO address at all. Kept
 *  apart from an empty column (never read): without it an order with no address was read again on
 *  every sync, and a worklist draft could not tell "the order has no address" from "not read". */
export interface NoShipTo {
  source: "none"
  fetched_at?: string
}

export type StoredShipTo = CachedShipTo | NoShipTo

/** The value to store for an order read: its ship-to, or the "no address" marker. */
export function storedShipTo(shipTo: CachedShipTo | null): StoredShipTo {
  const fetched_at = new Date().toISOString()
  return shipTo ? { ...shipTo, fetched_at } : { source: "none", fetched_at }
}

/** What the cache knows about the order's ship-to: nothing (never read), or the answer of a read
 *  (an address, or none) with when it was read. */
export type ShipToCacheEntry =
  | { known: false }
  | { known: true; shipTo: CachedShipTo | null; fetched_at: string | null }

export function shipToCacheOf(value: unknown): ShipToCacheEntry {
  const shipTo = cachedShipToOf(value)
  if (shipTo) return { known: true, shipTo, fetched_at: shipTo.fetched_at ?? null }
  let v = value
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return { known: false }
    }
  }
  if (
    v != null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    (v as { source?: unknown }).source === "none"
  ) {
    const at = (v as { fetched_at?: unknown }).fetched_at
    return { known: true, shipTo: null, fetched_at: typeof at === "string" ? at : null }
  }
  return { known: false }
}

/** A cached ship-to is refreshed by prep_sync once it is older than this. */
export const SHIP_TO_CACHE_TTL_MS = 12 * 60 * 60 * 1000

/** At most this many cached ship-tos are refreshed (re-read from the store) per sync run. A first
 *  read of a never-cached order is not counted: without it the worklist knows nothing. */
export const SHIP_TO_REFRESHES_PER_SYNC = 20

/** The TTL for one document: 12 h plus up to 6 h, fixed per document, so ship-tos cached in one
 *  sync expire on different runs instead of all on the same one. */
export function shipToTtlMs(documentRef: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < documentRef.length; i++) {
    h ^= documentRef.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return SHIP_TO_CACHE_TTL_MS + ((h >>> 0) % 1000) * (SHIP_TO_CACHE_TTL_MS / 2000)
}

/** A sync run's refresh allowance, shared by its rows (see SHIP_TO_REFRESHES_PER_SYNC). */
export interface ShipToRefreshBudget {
  remaining: number
}

/** Read a `prep_meta.ship_to` value back, or null when absent or malformed. */
export function cachedShipToOf(value: unknown): CachedShipTo | null {
  let v = value
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (v == null || typeof v !== "object" || Array.isArray(v)) return null
  const r = v as { source?: unknown; address?: unknown; fetched_at?: unknown }
  if (r.source !== "order" && r.source !== "customer") return null
  if (r.address == null || typeof r.address !== "object" || Array.isArray(r.address)) return null
  return {
    source: r.source,
    address: r.address as ShopifyOrderAddress,
    ...(typeof r.fetched_at === "string" ? { fetched_at: r.fetched_at } : {}),
  }
}

function locationOf(a: ShopifyOrderAddress) {
  return {
    street: [a.address1, a.address2].filter((v) => v && v.trim()).join(", ") || null,
    city: a.city ?? null,
    postalCode: a.zip ?? null,
    countryIsoCode: a.countryCode ?? null,
  }
}

export async function fetchShopifyOrderMeta(
  ctx: BoxtalToolCtx,
  shopifyOrderId: string,
): Promise<ShopifyOrderMetaRead | null> {
  try {
    // Invoicing stores the NUMERIC Shopify order id; shopify:orders_get resolves
    // only the gid form (see shopify-ref.ts for why this bites).
    const env = await ctx.executeTool("shopify:orders_get", {
      id: toShopifyOrderGid(shopifyOrderId),
    })
    return shopifyOrderMetaOf(env)
  } catch {
    return null
  }
}

/** The order meta out of a `shopify:orders_get` envelope already in hand, or null. */
export function shopifyOrderMetaOf(env: {
  status?: string
  result?: unknown
}): ShopifyOrderMetaRead | null {
  try {
    if (env.status !== "completed" || env.result == null) return null
    const order = env.result as ShopifyOrderMeta & {
      shippingAddress?: ShopifyOrderAddress | null
      customerAddress?: ShopifyOrderAddress | null
    }
    // Neither shippingAddress nor customerAddress carries an email (shopify's
    // normalizeAddress never sets one) — the order's own email lives separately
    // (attributes.email, else the top-level field), so it is stitched onto the
    // address here rather than lost.
    // Field level fallback, not object level. A Shopify order often carries a
    // shipping address with no phone while the customer record has one: taking
    // the shipping address wholesale threw that phone away and left the row
    // blocked as incomplete for a value we already held. Carriers require a
    // phone, so this is the difference between a row that can ship and one that
    // cannot.
    const shipAddr = order.shippingAddress ?? null
    const custAddr = order.customerAddress ?? null
    const rawAddress =
      shipAddr && custAddr
        ? {
            ...shipAddr,
            phone: blankField(shipAddr.phone) ? (custAddr.phone ?? null) : shipAddr.phone,
          }
        : (shipAddr ?? custAddr ?? null)
    const email = order.attributes?.email ?? order.email ?? null
    const samePlace =
      shipAddr != null &&
      custAddr != null &&
      sameLocation(locationOf(shipAddr), locationOf(custAddr))
    const shipTo: CachedShipTo | null = shipAddr
      ? {
          source: "order",
          address: {
            ...shipAddr,
            phone:
              blankField(shipAddr.phone) && samePlace
                ? (custAddr?.phone ?? null)
                : (shipAddr.phone ?? null),
            email,
          },
        }
      : custAddr
        ? { source: "customer", address: { ...custAddr, email } }
        : null
    return {
      name: order.name ?? null,
      tags: Array.isArray(order.tags)
        ? order.tags
        : Array.isArray(order.attributes?.tags)
          ? order.attributes.tags
          : [],
      created_at: order.createdAt ?? order.created_at ?? order.attributes?.createdAt ?? null,
      financial_status: order.attributes?.financialStatus ?? order.financialStatus ?? null,
      cancelled_at: order.attributes?.cancelledAt ?? order.cancelledAt ?? null,
      address: rawAddress ? { ...rawAddress, email } : null,
      ship_to: shipTo,
    }
  } catch {
    return null
  }
}

export async function upsertPrepMeta(
  ctx: BoxtalToolCtx,
  documentRef: string,
  data: {
    shopify_order_id: string | null
    order_name: string | null
    order_tags: string[]
    order_created_at: string | null
    financial_status?: string | null
    cancelled_at?: string | null
    staff_note?: string | null
    ship_to?: StoredShipTo | null
  },
): Promise<void> {
  const rows = (await ctx.db.findMany("prep_meta", {
    where: { document_ref: documentRef },
    limit: 1,
  })) as Array<{
    id: string
  }>
  const patch = { ...data, fetched_at: new Date().toISOString() }
  if (rows[0]) {
    await ctx.db.update("prep_meta", rows[0].id, patch)
  } else {
    await ctx.db.insert("prep_meta", { document_ref: documentRef, ...patch })
  }
}

/**
 * Fill `prep_meta` for one document from its Shopify order, when it is EMPTY.
 *
 * Nothing but `prep_sync` used to write this table, so a document that was never synced (the
 * agent bought a label straight off a draft, the operator worked from Ready-to-ship, the order
 * arrived after the last sync) had NO cached order facts at all. Two things then went wrong at
 * the worst moment, the label buy: the parcel's merchant reference fell back to the invoice UUID
 * instead of the order number, and the Ready-to-ship row had no ORDER DATE, so it sorted to the
 * bottom of the print station's oldest-first queue.
 *
 * Rules: best effort (never throws, never fails a buy), and never DESTRUCTIVE — a row that
 * already carries an order date is left exactly as `prep_sync` wrote it, including its staff
 * note, which this path cannot know. Returns whether it wrote anything.
 */
export async function warmPrepMetaForDocument(
  ctx: BoxtalToolCtx,
  documentRef: string,
): Promise<boolean> {
  try {
    const rows = (await ctx.db.findMany("prep_meta", {
      where: { document_ref: documentRef },
      limit: 1,
    })) as Array<{ shopify_order_id?: string | null; order_created_at?: string | null }>
    const existing = rows[0] ?? null
    // Already warm: prep_sync owns this row and knows strictly more than we do here.
    if (existing?.order_created_at) return false

    let orderId = existing?.shopify_order_id ?? null
    if (!orderId) {
      const docEnv = await ctx.executeTool("invoicing:documents_get", { id: documentRef })
      orderId =
        docEnv.status === "completed" && docEnv.result != null
          ? ((docEnv.result as { shopify_order_id?: string | null }).shopify_order_id ?? null)
          : null
    }
    // No linked Shopify order (a manual/repair document): there is no order date to cache, and
    // that is a normal state, not a failure.
    if (!orderId) return false

    const meta = await fetchShopifyOrderMeta(ctx, orderId)
    if (!meta) return false

    await upsertPrepMeta(ctx, documentRef, {
      shopify_order_id: orderId,
      order_name: meta.name,
      order_tags: meta.tags,
      order_created_at: meta.created_at,
      financial_status: meta.financial_status,
      cancelled_at: meta.cancelled_at,
      ship_to: storedShipTo(meta.ship_to),
    })
    return true
  } catch {
    // A cold cache is a cosmetic degradation (a dash in the date column); a thrown error here
    // would be a failed label buy. Never trade one for the other.
    return false
  }
}

/**
 * Cache the order's ship-to on `prep_meta` when it is missing or older than the TTL. `getShipTo`
 * is the caller's (memoised) order read, shared with the contact backfill so a row never pays two
 * reads. It resolves null when the order carries no address and undefined when the read failed,
 * which leaves the cache as it was. A refresh of an expired entry spends one unit of `budget`
 * (none left: the entry waits for a later sync; the worklist keeps showing it, and a label buy
 * reads the order itself anyway). Best effort: returns whether it wrote.
 */
export async function cacheShipToIfStale(
  ctx: BoxtalToolCtx,
  documentRef: string,
  getShipTo: () => Promise<CachedShipTo | null | undefined>,
  budget?: ShipToRefreshBudget,
): Promise<boolean> {
  try {
    const rows = (await ctx.db.findMany("prep_meta", {
      where: { document_ref: documentRef },
      limit: 1,
    })) as Array<{
      id: string
      ship_to?: unknown
    }>
    const row = rows[0]
    if (!row) return false
    // "The order has no address" is an answer too: cached like an address, so such an order is
    // not read again on every sync.
    const cached = shipToCacheOf(row.ship_to)
    const at = cached.known && cached.fetched_at ? Date.parse(cached.fetched_at) : Number.NaN
    if (cached.known && !Number.isNaN(at) && Date.now() - at < shipToTtlMs(documentRef))
      return false
    if (cached.known && budget) {
      if (budget.remaining <= 0) return false
      budget.remaining--
    }
    const shipTo = await getShipTo()
    if (shipTo === undefined) return false
    await ctx.db.update("prep_meta", row.id, { ship_to: storedShipTo(shipTo) })
    return true
  } catch {
    return false
  }
}

/**
 * Re-read the order and store its ship-to on the document's `prep_meta` row now, whatever the
 * cache's age. Used when a person picks between the order's address and the verified one: the pick
 * is tied to the addresses as read live, and the worklist must see the same ones. Best effort.
 */
export async function refreshCachedShipTo(
  ctx: BoxtalToolCtx,
  documentRef: string,
  shopifyOrderId: string,
): Promise<boolean> {
  try {
    const rows = (await ctx.db.findMany("prep_meta", {
      where: { document_ref: documentRef },
      limit: 1,
    })) as Array<{
      id: string
    }>
    if (!rows[0]) return false
    const meta = await fetchShopifyOrderMeta(ctx, shopifyOrderId)
    if (!meta) return false
    await ctx.db.update("prep_meta", rows[0].id, { ship_to: storedShipTo(meta.ship_to) })
    return true
  } catch {
    return false
  }
}

/** Trim a possibly-whitespace-only source string down to a real value, or null. Applied to every
 *  Shopify-sourced field before it is compared or written: a whitespace-only source value used to
 *  read as truthy, get written verbatim, then read back BLANK (trimmed) on the next pass, which
 *  looked "still missing" and rewrote the same whitespace value on every single sync forever. */
function trimmedOrNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim()
  return t === "" ? null : t
}

/** Backfill the counterparty contact's structured `metadata.shipping_address`
 *  from the Shopify order's ship-to when the contact has none, or heal an
 *  existing contact address that is missing `state`, `phone` or `email` by
 *  merging those fields in. The contact address (with phone) is what the
 *  label buy needs; contacts_write merges metadata at the top level so other
 *  keys are untouched. Never overwrites an existing non-blank field. */
export async function backfillContactShippingAddress(
  ctx: BoxtalToolCtx,
  contactId: string | null,
  getAddress: () => Promise<ShopifyOrderAddress | null>,
): Promise<boolean> {
  if (!contactId) return false
  try {
    const readEnv = (await ctx.executeTool("kernel:contacts_read", { contactId })) as {
      status?: string
      result?: unknown
    }
    if (readEnv.status !== "completed" || readEnv.result == null) return false
    const contact = (readEnv.result as { contact?: Record<string, unknown> }).contact
    const meta =
      contact?.metadata && typeof contact.metadata === "object"
        ? (contact.metadata as Record<string, unknown>)
        : {}
    const existing =
      meta.shipping_address && typeof meta.shipping_address === "object"
        ? (meta.shipping_address as Record<string, unknown>)
        : null
    const hasExisting = existing != null && Object.keys(existing).length > 0
    const strOf = (k: string): string =>
      existing && typeof existing[k] === "string" ? (existing[k] as string).trim() : ""
    const existingState = strOf("state")
    const existingPhone = strOf("phone")
    const existingEmail = strOf("email")
    const existingCountry = strOf("countryIsoCode")
    // A fully-populated existing address is never touched, and state is only required for it to
    // count as "full" on a destination that actually needs one (US/CA -- address.ts's
    // stateRequired, mirroring validateParty's rule). Requiring state UNCONDITIONALLY here used
    // to mean this guard could never fire for a non-US/CA contact (Shopify never sends a
    // province for e.g. an FR order, so `state` stayed blank forever), so a fully phone+email
    // healed contact still paid for a live shopify:orders_get on every single prep_sync,
    // permanently, even once there was nothing left to add.
    if (
      hasExisting &&
      existingPhone &&
      existingEmail &&
      (!stateRequired(existingCountry) || existingState)
    ) {
      return false
    }
    const address = await getAddress()
    if (!address || (!address.address1 && !address.city && !address.zip)) return false
    const state = trimmedOrNull(address.provinceCode ?? address.province ?? null)
    const phone = trimmedOrNull(address.phone)
    const email = trimmedOrNull(address.email)
    if (hasExisting) {
      // Heal: merge only the fields the existing record is missing (state, phone, email), leaving
      // every existing non-blank key untouched. Trimmed source values only, so a whitespace-only
      // Shopify field is treated as absent rather than looping forever (see trimmedOrNull).
      const patch: Record<string, unknown> = {}
      if (!existingState && state) patch.state = state
      if (!existingPhone && phone) patch.phone = phone
      if (!existingEmail && email) patch.email = email
      if (Object.keys(patch).length === 0) return false
      const env = await ctx.executeTool("kernel:contacts_write", {
        contactId,
        metadata: {
          shipping_address: { ...existing, ...patch },
        },
      })
      return env.status === "completed"
    }
    const street = [address.address1, address.address2]
      .filter((v) => v && String(v).trim())
      .join(", ")
    const env = await ctx.executeTool("kernel:contacts_write", {
      contactId,
      metadata: {
        shipping_address: {
          name: address.name ?? null,
          company: address.company ?? null,
          email,
          phone,
          street: street || null,
          city: address.city ?? null,
          postalCode: address.zip ?? null,
          countryIsoCode: address.countryCode ?? null,
          state,
        },
      },
    })
    return env.status === "completed"
  } catch {
    return false
  }
}
