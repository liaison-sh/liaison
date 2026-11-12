// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The data dev-store-seed.ts writes into a Shopify dev store: base products and customers, the
// scenario catalog (SKU'd products, named customers, a fulfilled order with tracking), per-location
// inventory levels and the second location's name and address.
//
// The default is fiction (the Kestrel field recorder line). A deployment that seeds its own store
// with its own catalog points LIAISON_SHOPIFY_DEV_STORE_CATALOG at a module (absolute, or relative
// to the working directory) whose `catalog` (or default) export has this shape. The variable, once
// set, must name a loadable module: a missing file or a malformed export stops the seed.

import { existsSync } from "node:fs"
import path from "node:path"

export interface BaseProductSpec {
  externalId: string
  title: string
  basePriceEur: string
}

export interface BaseCustomerSpec {
  externalId: string
  firstName: string
  lastName: string
  email: string
}

export interface CatalogProductSpec {
  externalId: string
  title: string
  sku: string
  priceEur: string
}

export interface CatalogCustomerSpec {
  externalId: string
  firstName: string
  lastName: string
  email: string
  city: string
  provinceCode?: string // omit for countries without provinces/states (DE, GB, …)
  countryCode: string
  zip: string
  address1: string
  company?: string // dealer/company name (on the address) — for B2B dealer customers
  extraTags?: string[] // e.g. ["dealer"] / ["edu"] so customers_search/segments can find them
}

/** A fulfilled historical order WITH a tracking number (order status + tracking lookups). */
export interface FulfilledOrderSpec {
  externalId: string
  customerExternalId: string
  productExternalId: string
  carrier: string
  trackingNumber: string
  trackingUrl: string
}

/** Tracked on-hand levels of one catalog SKU at the primary and the secondary location. */
export interface InventoryTarget {
  productExternalId: string
  sku: string
  primaryQty: number
  secondaryQty: number
}

export interface SecondaryLocationSpec {
  name: string
  address: { address1: string; city: string; countryCode: string; zip: string }
}

export interface DevStoreCatalog {
  products: BaseProductSpec[]
  customers: BaseCustomerSpec[]
  catalogProducts: CatalogProductSpec[]
  catalogCustomers: CatalogCustomerSpec[]
  fulfilledOrders: FulfilledOrderSpec[]
  inventory: InventoryTarget[]
  secondaryLocation: SecondaryLocationSpec
}

/** Below this on-hand total a seeded SKU counts as low stock (logged, and read by stock checks). */
export const LOW_STOCK_THRESHOLD = 10

export const FICTION_CATALOG: DevStoreCatalog = {
  products: [
    {
      externalId: "liaison-seed-prod-001",
      title: "Kestrel Pocket Recorder",
      basePriceEur: "299.00",
    },
    { externalId: "liaison-seed-prod-002", title: "Foam Windscreen", basePriceEur: "59.00" },
    { externalId: "liaison-seed-prod-003", title: "Foot Switch", basePriceEur: "89.00" },
    { externalId: "liaison-seed-prod-004", title: "Field Preamp", basePriceEur: "149.00" },
    { externalId: "liaison-seed-prod-005", title: "Cable Set", basePriceEur: "29.00" },
  ],
  customers: [
    {
      externalId: "liaison-seed-cust-001",
      firstName: "Marie",
      lastName: "Dupont",
      email: "marie@example.com",
    },
    {
      externalId: "liaison-seed-cust-002",
      firstName: "Jean",
      lastName: "Martin",
      email: "jean@example.com",
    },
    {
      externalId: "liaison-seed-cust-003",
      firstName: "Sophie",
      lastName: "Bernard",
      email: "sophie@example.com",
    },
    {
      externalId: "liaison-seed-cust-004",
      firstName: "Alex",
      lastName: "Müller",
      email: "alex@example.com",
    },
    {
      externalId: "liaison-seed-cust-005",
      firstName: "Maria",
      lastName: "Garcia",
      email: "maria@example.com",
    },
    {
      externalId: "liaison-seed-cust-006",
      firstName: "John",
      lastName: "Smith",
      email: "john@example.com",
    },
    {
      externalId: "liaison-seed-cust-007",
      firstName: "Sarah",
      lastName: "Johnson",
      email: "sarah@example.com",
    },
    {
      externalId: "liaison-seed-cust-008",
      firstName: "Michael",
      lastName: "Williams",
      email: "michael@example.com",
    },
    {
      externalId: "liaison-seed-cust-009",
      firstName: "Aki",
      lastName: "Tanaka",
      email: "aki@example.com",
    },
    {
      externalId: "liaison-seed-cust-010",
      firstName: "Hiroshi",
      lastName: "Sato",
      email: "hiroshi@example.com",
    },
  ],
  catalogProducts: [
    { externalId: "liaison-seed-prod-ks6", title: "Kestrel 6", sku: "RAL-44", priceEur: "699.00" },
    {
      externalId: "liaison-seed-prod-wnd",
      title: "Windscreen Pack",
      sku: "RAL-WND",
      priceEur: "49.00",
    },
    {
      externalId: "liaison-seed-prod-case",
      title: "Travel Case",
      sku: "RAL-CASE",
      priceEur: "129.00",
    },
    {
      externalId: "liaison-seed-prod-cbl",
      title: "XLR Cable Set",
      sku: "RAL-CBL",
      priceEur: "29.00",
    },
    {
      externalId: "liaison-seed-prod-tc",
      title: "Timecode Module",
      sku: "RAL-TC",
      priceEur: "199.00",
    },
  ],
  catalogCustomers: [
    {
      externalId: "liaison-seed-cust-mason",
      firstName: "Mason",
      lastName: "Reed",
      email: "mason.reed@example.com",
      address1: "412 Music Row",
      city: "Nashville",
      provinceCode: "TN",
      countryCode: "US",
      zip: "37203",
    },
    // B2B dealer customers: found by customers_search through the dealer name (firstName +
    // lastName) and the company on the address; tagged "dealer".
    {
      externalId: "liaison-seed-cust-tonwerk",
      firstName: "Tonwerk",
      lastName: "Audio",
      email: "orders@tonwerk.example",
      company: "Tonwerk Audio",
      address1: "Friedrichstraße 12",
      city: "Berlin",
      countryCode: "DE",
      zip: "10117",
      extraTags: ["dealer"],
    },
    {
      externalId: "liaison-seed-cust-northside",
      firstName: "Northside",
      lastName: "Audio",
      email: "buyer@northside-audio.example",
      company: "Northside Audio",
      address1: "210 Wythe Ave",
      city: "Brooklyn",
      provinceCode: "NY",
      countryCode: "US",
      zip: "11249",
      extraTags: ["dealer"],
    },
    {
      externalId: "liaison-seed-cust-rivertone",
      firstName: "Rivertone",
      lastName: "Music",
      email: "purchasing@rivertone.example",
      company: "Rivertone Music",
      address1: "88 Riverside Dr",
      city: "Austin",
      provinceCode: "TX",
      countryCode: "US",
      zip: "78701",
      extraTags: ["dealer"],
    },
    {
      externalId: "liaison-seed-cust-klangwerk",
      firstName: "Klangwerk",
      lastName: "GmbH",
      email: "einkauf@klangwerk.example",
      company: "Klangwerk GmbH",
      address1: "Musikstraße 8",
      city: "Munich",
      countryCode: "DE",
      zip: "80331",
      extraTags: ["dealer", "vip"],
    },
    {
      externalId: "liaison-seed-cust-sarah-donnelly",
      firstName: "Sarah",
      lastName: "Donnelly",
      email: "sarah.donnelly@example.com",
      company: "Manchester Music Academy",
      address1: "33 Oxford Rd",
      city: "Manchester",
      countryCode: "GB",
      zip: "M13 9PL",
      extraTags: ["edu"],
    },
  ],
  fulfilledOrders: [
    {
      externalId: "liaison-seed-order-mason-ks6",
      customerExternalId: "liaison-seed-cust-mason",
      productExternalId: "liaison-seed-prod-ks6",
      carrier: "FedEx",
      trackingNumber: "771499881234",
      trackingUrl: "https://www.fedex.com/fedextrack/?trknbr=771499881234",
    },
  ],
  // Two SKUs read clearly low (Travel Case, Timecode Module), the rest healthy.
  inventory: [
    { productExternalId: "liaison-seed-prod-ks6", sku: "RAL-44", primaryQty: 60, secondaryQty: 40 },
    {
      productExternalId: "liaison-seed-prod-wnd",
      sku: "RAL-WND",
      primaryQty: 50,
      secondaryQty: 30,
    },
    {
      productExternalId: "liaison-seed-prod-case",
      sku: "RAL-CASE",
      primaryQty: 4,
      secondaryQty: 0,
    },
    { productExternalId: "liaison-seed-prod-tc", sku: "RAL-TC", primaryQty: 9, secondaryQty: 0 },
    {
      productExternalId: "liaison-seed-prod-cbl",
      sku: "RAL-CBL",
      primaryQty: 40,
      secondaryQty: 20,
    },
  ],
  secondaryLocation: {
    name: "Lyon",
    address: { address1: "8 Rue des Micros", city: "Lyon", countryCode: "FR", zip: "69002" },
  },
}

/** Fail loudly on a catalog whose references do not line up (an order or inventory row naming a
 *  product or customer the catalog does not seed). Exported for tests. */
export function assertCatalogConsistent(catalog: DevStoreCatalog): void {
  const lists: Array<keyof DevStoreCatalog> = [
    "products",
    "customers",
    "catalogProducts",
    "catalogCustomers",
    "fulfilledOrders",
    "inventory",
  ]
  for (const key of lists) {
    if (!Array.isArray(catalog[key]))
      throw new Error(`dev-store catalog: "${key}" must be an array`)
  }
  if (catalog.products.length === 0 || catalog.customers.length === 0) {
    throw new Error("dev-store catalog: products and customers must not be empty")
  }
  if (!catalog.secondaryLocation?.name)
    throw new Error("dev-store catalog: secondaryLocation.name is required")
  const productIds = new Set(catalog.catalogProducts.map((p) => p.externalId))
  const customerIds = new Set(catalog.catalogCustomers.map((c) => c.externalId))
  for (const o of catalog.fulfilledOrders) {
    if (!productIds.has(o.productExternalId)) {
      throw new Error(
        `dev-store catalog: order ${o.externalId} names unknown product ${o.productExternalId}`,
      )
    }
    if (!customerIds.has(o.customerExternalId)) {
      throw new Error(
        `dev-store catalog: order ${o.externalId} names unknown customer ${o.customerExternalId}`,
      )
    }
  }
  for (const t of catalog.inventory) {
    if (!productIds.has(t.productExternalId)) {
      throw new Error(
        `dev-store catalog: inventory ${t.sku} names unknown product ${t.productExternalId}`,
      )
    }
  }
}

/** The catalog to seed: the module LIAISON_SHOPIFY_DEV_STORE_CATALOG names, else the fiction. */
export async function loadDevStoreCatalog(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DevStoreCatalog> {
  const file = env.LIAISON_SHOPIFY_DEV_STORE_CATALOG?.trim()
  if (!file) return FICTION_CATALOG
  const abs = path.resolve(file)
  if (!existsSync(abs)) throw new Error(`LIAISON_SHOPIFY_DEV_STORE_CATALOG: no such file ${abs}`)
  const mod = (await import(abs)) as { catalog?: DevStoreCatalog; default?: DevStoreCatalog }
  const catalog = mod.catalog ?? mod.default
  if (!catalog)
    throw new Error(`LIAISON_SHOPIFY_DEV_STORE_CATALOG: ${abs} exports no \`catalog\` or default`)
  assertCatalogConsistent(catalog)
  return catalog
}
