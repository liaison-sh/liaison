// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo store's book: the orders, customers, products, quotes and returns a
// visitor sees when they open Shopify, Boxtal or the Home tab.
//
// It is DERIVED from `apps/api/src/seed/world/fiction.ts`, not invented next to it, so the
// store and the seeded contacts, dealers, tickets and invoices are the same
// company. The SKUs, the dealers and the end customers are that file's; what is
// added here is a commercial history: ninety-six orders across the statuses an
// operator actually triages, the quotes that became some of them, the returns
// in flight, and the stock behind it all.
//
// EVERYTHING IS DETERMINISTIC. The only input is the UTC day, so two reads in
// the same page walk agree, a screenshot taken twice looks the same, and the
// store still reads as "this week" tomorrow. The randomness is a seeded
// mulberry32, never `Math.random`.
//
// This module is loaded LAZILY (see provider.ts): on a deployment that is not a
// demo instance it is never imported, so neither it nor `apps/api/src/seed/world/fiction.ts`
// costs anything at boot.
import {
  DEMO_FIXED_CUSTOMER,
  DEMO_FIXED_ORDER,
  DEMO_SHOPIFY_VARIANT_BASE,
  DEMO_WORLD,
  type DemoCustomer,
  type DemoSku,
} from "~/seed/world/fiction"
import { DEMO_SHOP_DOMAIN } from "./sentinel"

// ── money ────────────────────────────────────────────────────────────────────
// Every amount is carried in MINOR units and formatted once, at the edge, so a
// total is a sum of integers and can never drift by a floating-point cent.

/** Format minor units as the two-decimal string Shopify's money fields carry. */
export function money(minor: number): string {
  const sign = minor < 0 ? "-" : ""
  const abs = Math.abs(Math.round(minor))
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`
}

const CURRENCY = "EUR"

// ── determinism ──────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and identical on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length) % items.length] as T
}

/** The UTC midnight the whole book is anchored on. */
function dayAnchor(now: number): number {
  return Math.floor(now / 86_400_000) * 86_400_000
}

function isoAt(anchorMs: number, daysAgo: number, hour: number, minute: number): string {
  return new Date(
    anchorMs - daysAgo * 86_400_000 + hour * 3_600_000 + minute * 60_000,
  ).toISOString()
}

// ── shapes ───────────────────────────────────────────────────────────────────

export interface DemoAddress {
  name: string | null
  company: string | null
  address1: string
  address2: string | null
  city: string
  province: string | null
  provinceCode: string | null
  zip: string
  country: string
  countryCode: string
  phone: string | null
}

export interface DemoShopifyCustomer {
  id: string
  numericId: number
  email: string
  firstName: string | null
  lastName: string | null
  displayName: string
  phone: string | null
  tags: string[]
  createdAt: string
  address: DemoAddress
  /** Dealers are companies; end customers are people. Drives tags and pricing. */
  kind: "dealer" | "person"
  countryCode: string
}

export interface DemoLineItem {
  id: string
  title: string
  sku: string
  quantity: number
  unitMinor: number
  variantId: string
  productId: string
}

export interface DemoFulfillment {
  id: string
  status: string
  createdAt: string
  carrier: string
  trackingNumber: string
  trackingUrl: string
  lineItemIds: string[]
}

export interface DemoReturn {
  id: string
  name: string
  status: string
  requestedAt: string
  totalQuantity: number
  reason: string
  lineItemId: string
}

export interface DemoRefund {
  id: string
  note: string | null
  createdAt: string
  amountMinor: number
}

export interface DemoOrder {
  id: string
  numericId: number
  name: string
  email: string | null
  customerId: string
  createdAt: string
  processedAt: string
  tags: string[]
  note: string | null
  financialStatus: string
  fulfillmentStatus: string
  cancelledAt: string | null
  cancelReason: string | null
  closed: boolean
  lineItems: DemoLineItem[]
  shippingTitle: string | null
  shippingMinor: number
  subtotalMinor: number
  totalMinor: number
  shippingAddress: DemoAddress
  fulfillments: DemoFulfillment[]
  refunds: DemoRefund[]
  returns: DemoReturn[]
  locationId: string
}

export interface DemoDraftOrder {
  id: string
  numericId: number
  name: string
  status: string
  tags: string[]
  createdAt: string
  updatedAt: string
  customerId: string
  email: string
  note: string | null
  lineItems: DemoLineItem[]
  shippingTitle: string
  shippingMinor: number
  subtotalMinor: number
  totalMinor: number
  /** Set once a draft is completed, by the fixture or by the write overlay. */
  orderId: string | null
  orderName: string | null
}

export interface DemoVariant {
  id: string
  numericId: number
  sku: string
  title: string
  displayName: string
  priceMinor: number
  inventoryQuantity: number
  inventoryItemId: string
  hsCode: string
  originCountry: string
  productId: string
  productTitle: string
  weightKg: number
}

export interface DemoProduct {
  id: string
  numericId: number
  title: string
  vendor: string
  status: string
  productType: string
  description: string
  createdAt: string
  totalInventory: number
  variants: DemoVariant[]
}

export interface DemoLocation {
  id: string
  name: string
  isActive: boolean
  city: string
  country: string
  countryCode: string
}

export interface DemoShopifyBook {
  /** The UTC midnight this book was built for. */
  anchorMs: number
  shopDomain: string
  currency: string
  locations: DemoLocation[]
  products: DemoProduct[]
  variantsById: Map<string, DemoVariant>
  variantsByInventoryItem: Map<string, DemoVariant>
  customers: DemoShopifyCustomer[]
  customersById: Map<string, DemoShopifyCustomer>
  orders: DemoOrder[]
  ordersById: Map<string, DemoOrder>
  draftOrders: DemoDraftOrder[]
  draftOrdersById: Map<string, DemoDraftOrder>
}

// ── geography ────────────────────────────────────────────────────────────────
// One plausible postal identity per country in the world file. Street numbers
// vary per customer; the city and the postcode are real-shaped for the country
// so an address never reads as filler.

interface Place {
  country: string
  city: string
  zip: string
  street: string
  province: string | null
  provinceCode: string | null
  dial: string
}

const PLACES: Record<string, Place> = {
  FR: {
    country: "France",
    city: "Lyon",
    zip: "69003",
    street: "rue Garibaldi",
    province: null,
    provinceCode: null,
    dial: "+33 4 72",
  },
  DE: {
    country: "Germany",
    city: "Leipzig",
    zip: "04109",
    street: "Karl-Liebknecht-Strasse",
    province: null,
    provinceCode: null,
    dial: "+49 341",
  },
  GB: {
    country: "United Kingdom",
    city: "Manchester",
    zip: "M1 5AN",
    street: "Oxford Road",
    province: "England",
    provinceCode: "ENG",
    dial: "+44 161",
  },
  NL: {
    country: "Netherlands",
    city: "Utrecht",
    zip: "3511 LN",
    street: "Oudegracht",
    province: null,
    provinceCode: null,
    dial: "+31 30",
  },
  JP: {
    country: "Japan",
    city: "Yokohama",
    zip: "231-0023",
    street: "Yamashitacho",
    province: "Kanagawa",
    provinceCode: "14",
    dial: "+81 45",
  },
  SE: {
    country: "Sweden",
    city: "Gothenburg",
    zip: "411 18",
    street: "Vasagatan",
    province: null,
    provinceCode: null,
    dial: "+46 31",
  },
  NO: {
    country: "Norway",
    city: "Bergen",
    zip: "5003",
    street: "Strandgaten",
    province: null,
    provinceCode: null,
    dial: "+47 55",
  },
  DK: {
    country: "Denmark",
    city: "Aarhus",
    zip: "8000",
    street: "Vestergade",
    province: null,
    provinceCode: null,
    dial: "+45 86",
  },
  PL: {
    country: "Poland",
    city: "Krakow",
    zip: "31-042",
    street: "Grodzka",
    province: null,
    provinceCode: null,
    dial: "+48 12",
  },
  BG: {
    country: "Bulgaria",
    city: "Plovdiv",
    zip: "4000",
    street: "Knyaz Alexander I",
    province: null,
    provinceCode: null,
    dial: "+359 32",
  },
  US: {
    country: "United States",
    city: "Portland",
    zip: "97209",
    street: "NW Everett St",
    province: "Oregon",
    provinceCode: "OR",
    dial: "+1 503",
  },
  CA: {
    country: "Canada",
    city: "Montreal",
    zip: "H2T 1S4",
    street: "Rue Saint-Denis",
    province: "Quebec",
    provinceCode: "QC",
    dial: "+1 514",
  },
  PT: {
    country: "Portugal",
    city: "Porto",
    zip: "4050-262",
    street: "Rua da Boavista",
    province: null,
    provinceCode: null,
    dial: "+351 22",
  },
  AT: {
    country: "Austria",
    city: "Graz",
    zip: "8010",
    street: "Herrengasse",
    province: null,
    provinceCode: null,
    dial: "+43 316",
  },
  IE: {
    country: "Ireland",
    city: "Galway",
    zip: "H91 X2P3",
    street: "Shop Street",
    province: null,
    provinceCode: null,
    dial: "+353 91",
  },
  BR: {
    country: "Brazil",
    city: "Curitiba",
    zip: "80020-320",
    street: "Rua XV de Novembro",
    province: "Parana",
    provinceCode: "PR",
    dial: "+55 41",
  },
}

const FALLBACK_PLACE: Place = PLACES.FR as Place

function addressFor(
  countryCode: string,
  name: string,
  company: string | null,
  streetNumber: number,
  phoneTail: number,
): DemoAddress {
  const place = PLACES[countryCode] ?? FALLBACK_PLACE
  return {
    name,
    company,
    address1: `${streetNumber} ${place.street}`,
    address2: null,
    city: place.city,
    province: place.province,
    provinceCode: place.provinceCode,
    zip: place.zip,
    country: place.country,
    countryCode,
    phone: `${place.dial} ${String(phoneTail).padStart(6, "0")}`,
  }
}

// ── catalog ──────────────────────────────────────────────────────────────────

/** Customs codes per tier. Two codes, because the catalog has two tiers. */
const HS_CODES: Record<string, string> = { flagship: "8543709099", accessory: "8473301000" }

function buildProducts(anchorMs: number, catalog: DemoSku[]): DemoProduct[] {
  const next = rng(0x5ea1_c0de)
  return catalog.map((sku, i) => {
    const productNumeric = 8_100_000 + i
    // The seeded Boxtal catalog keys its shipping profiles by this id too
    // (apps/api/src/seed/world/fiction.ts demoShopifyVariantGid).
    const variantNumeric = DEMO_SHOPIFY_VARIANT_BASE + i
    const productId = `gid://shopify/Product/${productNumeric}`
    const variantId = `gid://shopify/ProductVariant/${variantNumeric}`
    const inventoryItemId = `gid://shopify/InventoryItem/${8_300_000 + i}`
    // Flagships are deeper stocked than accessories, and two accessories sit
    // under the low-inventory threshold so the Home attention list is not empty.
    const base =
      sku.tier === "flagship" ? 12 + Math.floor(next() * 40) : 40 + Math.floor(next() * 120)
    const quantity = i === 8 ? 3 : i === 10 ? 1 : base
    const variant: DemoVariant = {
      id: variantId,
      numericId: variantNumeric,
      sku: sku.sku,
      title: "Default Title",
      displayName: `${sku.title} - Default Title`,
      priceMinor: sku.priceMinor,
      inventoryQuantity: quantity,
      inventoryItemId,
      hsCode: HS_CODES[sku.tier] ?? HS_CODES.accessory!,
      originCountry: "FR",
      productId,
      productTitle: sku.title,
      weightKg: sku.weightKg,
    }
    return {
      id: productId,
      numericId: productNumeric,
      title: sku.title,
      vendor: DEMO_WORLD.company.name,
      status: "ACTIVE",
      productType: sku.tier === "flagship" ? "Recorder" : "Accessory",
      description: sku.description,
      createdAt: isoAt(anchorMs, 400 - i * 7, 9, 0),
      totalInventory: quantity,
      variants: [variant],
    }
  })
}

// ── customers ────────────────────────────────────────────────────────────────

function splitName(name: string): { first: string | null; last: string | null } {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 0) return { first: null, last: null }
  if (parts.length === 1) return { first: parts[0] ?? null, last: null }
  return { first: parts[0] ?? null, last: parts.slice(1).join(" ") }
}

function buildCustomers(anchorMs: number): DemoShopifyCustomer[] {
  const out: DemoShopifyCustomer[] = []
  let n = 0
  // Dealers first: they are the accounts that carry volume, and the demo's
  // dealer stories (quotes, payment terms, a partial shipment) hang off them.
  for (const dealer of DEMO_WORLD.dealers) {
    const numericId = 7_100_000 + n
    const email = `orders@${dealer.key.replace(/[^a-z0-9]+/g, "")}.example`
    out.push({
      id: `gid://shopify/Customer/${numericId}`,
      numericId,
      email,
      firstName: null,
      lastName: dealer.name,
      displayName: dealer.name,
      phone: null,
      tags: ["dealer", dealer.isVip ? "vip" : "standard"],
      createdAt: isoAt(anchorMs, 700 - n * 11, 10, 15),
      address: addressFor(dealer.country, dealer.name, dealer.name, 12 + n * 3, 100000 + n),
      kind: "dealer",
      countryCode: dealer.country,
    })
    n += 1
  }
  for (const person of DEMO_WORLD.customers as DemoCustomer[]) {
    const numericId = 7_100_000 + n
    const { first, last } = splitName(person.name)
    out.push({
      id: `gid://shopify/Customer/${numericId}`,
      numericId,
      email: person.email,
      firstName: first,
      lastName: last,
      displayName: person.name,
      phone: null,
      tags: person.isVip ? ["vip"] : [],
      createdAt: isoAt(anchorMs, 620 - n * 9, 14, 30),
      address: addressFor(person.country, person.name, null, 4 + n * 2, 200000 + n),
      kind: "person",
      countryCode: person.country,
    })
    n += 1
  }
  return out
}

// ── orders ───────────────────────────────────────────────────────────────────

const CARRIERS = ["Colissimo", "DHL Express", "UPS Standard", "Chronopost"] as const
const RETURN_REASONS = [
  "DEFECTIVE",
  "NOT_AS_DESCRIBED",
  "SIZE_TOO_LARGE",
  "UNWANTED",
  "OTHER",
] as const
const CANCEL_REASONS = ["CUSTOMER", "DECLINED", "INVENTORY"] as const

/**
 * The status mix, as counts. It is spelled out rather than sampled so the
 * distribution is a fact the test can assert, not a property of the seed.
 *
 * `unfulfilled` and `partial` are the shipping worklist: together they are what
 * Boxtal's `to_prepare_list` scans, so there are enough of them for the operator
 * screen to look like a working desk rather than a demo stub.
 */
const STATUS_PLAN = [
  { status: "unfulfilled", count: 28 },
  { status: "partial", count: 9 },
  { status: "fulfilled", count: 42 },
  { status: "refunded", count: 8 },
  { status: "cancelled", count: 5 },
  { status: "onhold", count: 4 },
] as const

const TOTAL_ORDERS = STATUS_PLAN.reduce((sum, s) => sum + s.count, 0)

interface PlannedOrder {
  kind: (typeof STATUS_PLAN)[number]["status"]
  daysAgo: number
  createdAt: string
}

/**
 * Lay the order book out over time before any of it is priced.
 *
 * Unfulfilled and on-hold orders sit in the last 30 days (older than that is not
 * a backlog, it is a data problem), partially fulfilled ones in the last 20, and
 * the settled history stretches back six months. Every unfulfilled order is at
 * least a day old so Home's "past SLA" probe, which asks for
 * `created_at < now - 24h`, has something to show.
 */
function planOrders(anchorMs: number): PlannedOrder[] {
  const next = rng(0x07d3_b00c)
  const planned: PlannedOrder[] = []
  for (const { status, count } of STATUS_PLAN) {
    for (let i = 0; i < count; i++) {
      const daysAgo =
        status === "unfulfilled"
          ? 1 + Math.floor(next() * 29)
          : status === "onhold"
            ? 2 + Math.floor(next() * 18)
            : status === "partial"
              ? 1 + Math.floor(next() * 19)
              : 5 + Math.floor(next() * 175)
      const hour = 8 + Math.floor(next() * 10)
      const minute = Math.floor(next() * 60)
      planned.push({ kind: status, daysAgo, createdAt: isoAt(anchorMs, daysAgo, hour, minute) })
    }
  }
  // Newest first, to the minute. It is the order every Shopify read returns
  // them in AND the order the order numbers are then assigned in: a store whose
  // #1050 predates its #1049 is not a store anybody recognises.
  planned.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return planned
}

// ── the book ─────────────────────────────────────────────────────────────────

function buildLocations(): DemoLocation[] {
  return [
    {
      id: "gid://shopify/Location/9100001",
      name: "Paris Workshop",
      isActive: true,
      city: "Paris",
      country: "France",
      countryCode: "FR",
    },
    {
      id: "gid://shopify/Location/9100002",
      name: "Rotterdam Hub",
      isActive: true,
      city: "Rotterdam",
      country: "Netherlands",
      countryCode: "NL",
    },
  ]
}

/** Money is a sum of its parts, in one place, so nothing can disagree. */
function priceOrder(
  lineItems: DemoLineItem[],
  shippingMinor: number,
): { subtotalMinor: number; totalMinor: number } {
  const subtotalMinor = lineItems.reduce((sum, li) => sum + li.unitMinor * li.quantity, 0)
  return { subtotalMinor, totalMinor: subtotalMinor + shippingMinor }
}

function buildLineItems(
  next: () => number,
  products: DemoProduct[],
  orderId: string,
  count: number,
  dealer: boolean,
): DemoLineItem[] {
  const flagships = products.filter((p) => p.productType === "Recorder")
  const accessories = products.filter((p) => p.productType === "Accessory")
  const items: DemoLineItem[] = []
  const used = new Set<string>()
  for (let i = 0; i < count; i++) {
    // A basket opens on a recorder and fills out with accessories, which is what
    // the real one does and what makes an average order value believable.
    const from = i === 0 ? flagships : next() < 0.35 ? flagships : accessories
    let product = pick(next, from)
    for (let guard = 0; used.has(product.id) && guard < 8; guard++) product = pick(next, from)
    if (used.has(product.id)) continue
    used.add(product.id)
    const variant = product.variants[0] as DemoVariant
    const quantity = dealer
      ? product.productType === "Recorder"
        ? 2 + Math.floor(next() * 6)
        : 4 + Math.floor(next() * 12)
      : 1 + (next() < 0.2 ? 1 : 0)
    items.push({
      id: `${orderId}/LineItem/${i + 1}`,
      title: product.title,
      sku: variant.sku,
      quantity,
      unitMinor: variant.priceMinor,
      variantId: variant.id,
      productId: product.id,
    })
  }
  return items
}

function buildOrders(
  anchorMs: number,
  products: DemoProduct[],
  customers: DemoShopifyCustomer[],
  locations: DemoLocation[],
): DemoOrder[] {
  const next = rng(0x0b00_4b1e)
  const planned = planOrders(anchorMs)
  const orders: DemoOrder[] = []
  const dealers = customers.filter((c) => c.kind === "dealer")
  const people = customers.filter((c) => c.kind === "person")

  planned.forEach((plan, index) => {
    // Order numbers run oldest to newest, the way a real store's do, so #1001
    // is the oldest and the newest carries the highest number.
    const sequence = TOTAL_ORDERS - index
    const numericId = 6_100_000 + sequence
    const id = `gid://shopify/Order/${numericId}`
    const isDealer = next() < 0.3
    const customer = isDealer ? pick(next, dealers) : pick(next, people)
    const lineCount = isDealer ? 2 + Math.floor(next() * 3) : 1 + Math.floor(next() * 3)
    const lineItems = buildLineItems(next, products, id, lineCount, isDealer)
    // Dealers ship on their own account; direct customers pay carriage unless
    // the basket clears 500 euro, which is the store's published rule.
    const provisional = lineItems.reduce((sum, li) => sum + li.unitMinor * li.quantity, 0)
    const shippingMinor = isDealer ? 0 : provisional >= 50_000 ? 0 : 1_490
    const { subtotalMinor, totalMinor } = priceOrder(lineItems, shippingMinor)
    const createdAt = plan.createdAt
    const location = pick(next, locations)

    const tags: string[] = []
    if (isDealer) tags.push("dealer")
    if (customer.tags.includes("vip")) tags.push("vip")
    if (plan.kind === "onhold") tags.push("payment-review")

    const order: DemoOrder = {
      id,
      numericId,
      name: `#${1000 + sequence}`,
      email: customer.email,
      customerId: customer.id,
      createdAt,
      processedAt: createdAt,
      tags,
      note: plan.kind === "onhold" ? "Payment under review by finance." : null,
      financialStatus: "PAID",
      fulfillmentStatus: "UNFULFILLED",
      cancelledAt: null,
      cancelReason: null,
      closed: false,
      lineItems,
      shippingTitle: shippingMinor > 0 ? "Standard shipping" : "Free shipping",
      shippingMinor,
      subtotalMinor,
      totalMinor,
      shippingAddress: {
        ...customer.address,
        name: customer.displayName,
        company: customer.kind === "dealer" ? customer.displayName : null,
      },
      fulfillments: [],
      refunds: [],
      returns: [],
      locationId: location.id,
    }

    applyStatus(order, plan, next, anchorMs)
    orders.push(order)
  })

  return orders
}

/** Turn a planned status into the fields, fulfillments, refunds and returns it implies. */
function applyStatus(
  order: DemoOrder,
  plan: PlannedOrder,
  next: () => number,
  anchorMs: number,
): void {
  const shipDaysAgo = Math.max(0, plan.daysAgo - 1 - Math.floor(next() * 3))
  const track = (): DemoFulfillment => ({
    id: `${order.id}/Fulfillment/${order.fulfillments.length + 1}`,
    status: "SUCCESS",
    createdAt: isoAt(anchorMs, shipDaysAgo, 16, 20),
    carrier: pick(next, CARRIERS),
    trackingNumber: `RA${String(order.numericId).slice(-7)}${order.fulfillments.length + 1}FR`,
    trackingUrl: `https://tracking.${DEMO_SHOP_DOMAIN}/${order.numericId}`,
    lineItemIds: [],
  })

  switch (plan.kind) {
    case "unfulfilled":
      break
    case "onhold":
      order.fulfillmentStatus = "ON_HOLD"
      order.financialStatus = "PENDING"
      break
    case "partial": {
      order.fulfillmentStatus = "PARTIALLY_FULFILLED"
      const f = track()
      f.lineItemIds = [order.lineItems[0]!.id]
      order.fulfillments.push(f)
      break
    }
    case "fulfilled": {
      order.fulfillmentStatus = "FULFILLED"
      const f = track()
      f.lineItemIds = order.lineItems.map((li) => li.id)
      order.fulfillments.push(f)
      // A minority of shipped orders have a return moving through the desk.
      if (next() < 0.14) {
        const li = order.lineItems[0] as DemoLineItem
        order.returns.push({
          id: `${order.id}/Return/1`,
          name: `${order.name}-R1`,
          status: next() < 0.5 ? "REQUESTED" : "OPEN",
          requestedAt: isoAt(anchorMs, Math.max(0, shipDaysAgo - 4), 11, 5),
          totalQuantity: 1,
          reason: pick(next, RETURN_REASONS),
          lineItemId: li.id,
        })
      }
      break
    }
    case "refunded": {
      order.fulfillmentStatus = "FULFILLED"
      const f = track()
      f.lineItemIds = order.lineItems.map((li) => li.id)
      order.fulfillments.push(f)
      const li = order.lineItems[0] as DemoLineItem
      // A refund returns whole line items, never an arbitrary slice, so the
      // refunded figure can always be recomputed from the basket.
      const refundedMinor = li.unitMinor * li.quantity
      const full = refundedMinor >= order.totalMinor - order.shippingMinor
      order.refunds.push({
        id: `${order.id}/Refund/1`,
        note: full
          ? "Returned unopened, refunded in full."
          : "Partial refund for one returned item.",
        createdAt: isoAt(anchorMs, Math.max(0, shipDaysAgo - 6), 15, 40),
        amountMinor: refundedMinor,
      })
      order.financialStatus = full ? "REFUNDED" : "PARTIALLY_REFUNDED"
      order.returns.push({
        id: `${order.id}/Return/1`,
        name: `${order.name}-R1`,
        status: "CLOSED",
        requestedAt: isoAt(anchorMs, Math.max(0, shipDaysAgo - 8), 9, 30),
        totalQuantity: li.quantity,
        reason: pick(next, RETURN_REASONS),
        lineItemId: li.id,
      })
      break
    }
    case "cancelled":
      order.cancelledAt = isoAt(anchorMs, Math.max(0, plan.daysAgo - 1), 12, 0)
      order.cancelReason = pick(next, CANCEL_REASONS)
      order.financialStatus = "VOIDED"
      order.closed = true
      break
  }
}

// ── draft orders (this product's quotes) ─────────────────────────────────────

function buildDraftOrders(
  anchorMs: number,
  products: DemoProduct[],
  customers: DemoShopifyCustomer[],
  orders: DemoOrder[],
): DemoDraftOrder[] {
  const next = rng(0x0d2a_f700)
  const dealers = customers.filter((c) => c.kind === "dealer")
  const people = customers.filter((c) => c.kind === "person")
  const drafts: DemoDraftOrder[] = []
  // Fourteen quotes: nine still open on a desk, five already turned into the
  // orders above, so "quote to order" is a story the demo can actually walk.
  for (let i = 0; i < 14; i++) {
    const numericId = 5_100_000 + i
    const id = `gid://shopify/DraftOrder/${numericId}`
    const isDealer = i % 2 === 0
    const customer = isDealer ? pick(next, dealers) : pick(next, people)
    const lineItems = buildLineItems(next, products, id, 1 + Math.floor(next() * 3), isDealer)
    const shippingMinor = isDealer ? 0 : 1_490
    const { subtotalMinor, totalMinor } = priceOrder(lineItems, shippingMinor)
    const daysAgo = 2 + i * 4
    const completed = i >= 9
    const linked = completed ? orders[(i * 7) % orders.length] : undefined
    drafts.push({
      id,
      numericId,
      name: `D${100 + i}`,
      status: completed ? "COMPLETED" : "OPEN",
      tags: isDealer ? ["dealer", "quote"] : ["quote"],
      createdAt: isoAt(anchorMs, daysAgo, 10, 10),
      updatedAt: isoAt(anchorMs, Math.max(0, daysAgo - 1), 16, 45),
      customerId: customer.id,
      email: customer.email,
      note: isDealer ? "Volume quote, thirty day payment terms." : "Quote requested by email.",
      lineItems,
      shippingTitle: shippingMinor > 0 ? "Standard shipping" : "Free shipping",
      shippingMinor,
      subtotalMinor,
      totalMinor,
      orderId: linked?.id ?? null,
      orderName: linked?.name ?? null,
    })
  }
  return drafts
}

// ── the fixed customer and her order ─────────────────────────────────────────

/**
 * `DEMO_FIXED_CUSTOMER`, as the store lists her. Built apart from
 * `buildCustomers` and never handed to the seeded generators, so every
 * generated order and quote keeps the customer it had.
 */
function buildFixedCustomer(anchorMs: number): DemoShopifyCustomer {
  const person = DEMO_FIXED_CUSTOMER
  const numericId = 7_190_001
  const { first, last } = splitName(person.name)
  return {
    id: `gid://shopify/Customer/${numericId}`,
    numericId,
    email: person.email,
    firstName: first,
    lastName: last,
    displayName: person.name,
    phone: null,
    tags: person.isVip ? ["vip"] : [],
    createdAt: isoAt(anchorMs, 240, 9, 45),
    address: addressFor(person.country, person.name, null, 27, 290001),
    kind: "person",
    countryCode: person.country,
  }
}

/** `DEMO_FIXED_ORDER`: paid and shipped, nothing refunded. */
function buildFixedOrder(
  anchorMs: number,
  products: DemoProduct[],
  customer: DemoShopifyCustomer,
  locations: DemoLocation[],
): DemoOrder {
  const spec = DEMO_FIXED_ORDER
  const id = `gid://shopify/Order/${spec.numericId}`
  const product = products.find((p) => p.variants.some((v) => v.sku === spec.sku))
  const variant = product?.variants.find((v) => v.sku === spec.sku)
  const location = locations[0]
  if (!product || !variant || !location) {
    throw new Error(`demo store: the fixed order's SKU ${spec.sku} or a location is missing`)
  }
  const lineItems: DemoLineItem[] = [
    {
      id: `${id}/LineItem/1`,
      title: product.title,
      sku: variant.sku,
      quantity: spec.quantity,
      unitMinor: variant.priceMinor,
      variantId: variant.id,
      productId: product.id,
    },
  ]
  const shippingMinor = 1_490
  const { subtotalMinor, totalMinor } = priceOrder(lineItems, shippingMinor)
  const createdAt = isoAt(anchorMs, spec.daysAgo, 10, 40)
  return {
    id,
    numericId: spec.numericId,
    name: spec.name,
    email: customer.email,
    customerId: customer.id,
    createdAt,
    processedAt: createdAt,
    tags: [],
    note: null,
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    cancelledAt: null,
    cancelReason: null,
    closed: false,
    lineItems,
    shippingTitle: "Standard shipping",
    shippingMinor,
    subtotalMinor,
    totalMinor,
    shippingAddress: { ...customer.address, name: customer.displayName, company: null },
    fulfillments: [
      {
        id: `${id}/Fulfillment/1`,
        status: "SUCCESS",
        createdAt: isoAt(anchorMs, spec.daysAgo - 1, 16, 20),
        carrier: "Colissimo",
        trackingNumber: `RA${String(spec.numericId).slice(-7)}1FR`,
        trackingUrl: `https://tracking.${DEMO_SHOP_DOMAIN}/${spec.numericId}`,
        lineItemIds: lineItems.map((li) => li.id),
      },
    ],
    refunds: [],
    returns: [],
    locationId: location.id,
  }
}

// ── assembly + cache ─────────────────────────────────────────────────────────

let cached: DemoShopifyBook | null = null

/**
 * The book for `now`'s UTC day, built once and reused.
 *
 * Rebuilt when the day rolls over, so a long-lived demo box keeps showing a
 * store whose newest order is from this week rather than from the day it was
 * deployed. A page walk started just before midnight and finished just after
 * therefore reads two books; the cost is a cursor landing one order out, which
 * is exactly what a real store does when an order arrives mid-walk.
 */
export function demoShopifyBook(now: number = Date.now()): DemoShopifyBook {
  const anchorMs = dayAnchor(now)
  if (cached && cached.anchorMs === anchorMs) return cached

  const locations = buildLocations()
  const products = buildProducts(anchorMs, DEMO_WORLD.catalog)
  const generatedCustomers = buildCustomers(anchorMs)
  const generatedOrders = buildOrders(anchorMs, products, generatedCustomers, locations)
  const draftOrders = buildDraftOrders(anchorMs, products, generatedCustomers, generatedOrders)
  // The fixed customer and her order join after the seeded generators ran, so
  // they move no generated order or quote.
  const fixedCustomer = buildFixedCustomer(anchorMs)
  const customers = [...generatedCustomers, fixedCustomer]
  const orders = [
    ...generatedOrders,
    buildFixedOrder(anchorMs, products, fixedCustomer, locations),
  ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))

  const variantsById = new Map<string, DemoVariant>()
  const variantsByInventoryItem = new Map<string, DemoVariant>()
  for (const product of products) {
    for (const variant of product.variants) {
      variantsById.set(variant.id, variant)
      variantsByInventoryItem.set(variant.inventoryItemId, variant)
    }
  }

  cached = {
    anchorMs,
    shopDomain: DEMO_SHOP_DOMAIN,
    currency: CURRENCY,
    locations,
    products,
    variantsById,
    variantsByInventoryItem,
    customers,
    customersById: new Map(customers.map((c) => [c.id, c])),
    orders,
    ordersById: new Map(orders.map((o) => [o.id, o])),
    draftOrders,
    draftOrdersById: new Map(draftOrders.map((d) => [d.id, d])),
  }
  return cached
}

/**
 * How many orders the store's seeded generator makes (6100001 upward). The
 * fixed order (`DEMO_FIXED_ORDER`) comes on top. Asserted by the fixture test.
 */
export const DEMO_ORDER_COUNT = TOTAL_ORDERS

/** Drop the cached book. Used by the tests that move the clock. */
export const DemoShopifyFixturesTestAccess = {
  reset(): void {
    cached = null
  },
}
