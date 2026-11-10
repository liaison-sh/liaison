// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B2B draft orders: the company location's catalog prices the lines, and the guard refuses, before
// any approval is staged, a B2B draft without the company location, a discount or custom price
// without a priceException, and a catalog line whose variant has no fixed B2B price. Non-B2B drafts
// keep the old behaviour (a lower per-unit price becomes a percentage discount).
//
// The fake Shopify answers by GraphQL operation, so a test states what the store holds rather than
// the order of the reads.

import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { summarizeDraftOrderCreate, summarizeDraftOrdersUpdate } from "../summarizers"
import { normalizeDraftOrderInput } from "./draft-order-input"
import { draft_orders_create, draft_orders_create_preflight, draft_orders_update_preflight } from "./draft-orders"
import { companies_get, companies_search, companiesQueryString } from "../companies"
import { parsePriceException, PRICE_EXCEPTION_ATTRIBUTE } from "./draft-order-b2b"

const COMPANY = "gid://shopify/Company/1"
const LOCATION = "gid://shopify/CompanyLocation/11"
const OTHER_LOCATION = "gid://shopify/CompanyLocation/12"
const CONTACT = "gid://shopify/CompanyContact/21"
const CONTACT_CUSTOMER = "gid://shopify/Customer/31"
const CONSUMER = "gid://shopify/Customer/32"
const VARIANT = "gid://shopify/ProductVariant/41"
const VARIANT_2 = "gid://shopify/ProductVariant/42"
const PRICE_LIST = "gid://shopify/PriceList/51"
const B2B_PRICE_LIST = "gid://shopify/PriceList/52"
const REGION_PRICE_LIST = "gid://shopify/PriceList/53"
const PC = { companyId: COMPANY, companyLocationId: LOCATION, companyContactId: CONTACT }

interface Store {
  /** Customers: id → company contact profiles. */
  customers?: Record<string, unknown[]>
  /** Role assignments of the contact (location ids). */
  contactRoles?: string[]
  /** Variants with a FIXED price in the location's price list. */
  fixedPriced?: string[]
  /** Variant list prices (for the consumer lower-price rewrite). */
  listPrices?: Record<string, string>
  /** Variants with a FIXED price, per price list id (overrides fixedPriced). */
  fixedByList?: Record<string, string[]>
  catalogsFail?: boolean
  /** The location's directly assigned catalogs (Plus); default one ACTIVE "Wholesale" catalog. */
  directCatalogs?: unknown[]
  /** The store's markets; default none. */
  markets?: FakeMarket[]
  /** The markets list says there is another page but gives no cursor (a truncated read). */
  marketsTruncated?: boolean
  draftBuyer?: unknown
}

interface FakeMarket {
  id: string
  name: string
  status?: string
  /** The company-locations condition; null for a region or retail market. */
  companyLocations: null | { level: "ALL" | "SPECIFIED"; ids: string[] }
  catalogs: unknown[]
}

const DIRECT_CATALOG = {
  id: "gid://shopify/CompanyLocationCatalog/61",
  title: "Wholesale",
  status: "ACTIVE",
  priceList: { id: PRICE_LIST, name: "Wholesale EUR", currency: "EUR" },
}
const B2B_MARKET: FakeMarket = {
  id: "gid://shopify/Market/71",
  name: "Trade buyers",
  companyLocations: { level: "SPECIFIED", ids: [LOCATION] },
  catalogs: [{ id: "gid://shopify/MarketCatalog/81", title: "Trade catalog", status: "ACTIVE", priceList: { id: B2B_PRICE_LIST, name: "Trade EUR", currency: "EUR" } }],
}
const REGION_MARKET: FakeMarket = {
  id: "gid://shopify/Market/72",
  name: "Europe",
  companyLocations: null,
  catalogs: [{ id: "gid://shopify/MarketCatalog/82", title: "Catalog for Europe", status: "ACTIVE", priceList: { id: REGION_PRICE_LIST, name: "Europe EUR", currency: "EUR" } }],
}

function answerMarkets(store: Store, query: string, variables: Record<string, unknown>): unknown {
  const markets = store.markets ?? []
  if (query.includes("B2bMarketsList")) {
    return {
      markets: {
        nodes: markets.map((m) => ({
          id: m.id,
          name: m.name,
          status: m.status ?? "ACTIVE",
          conditions: { companyLocationsCondition: m.companyLocations ? { applicationLevel: m.companyLocations.level } : null },
        })),
        pageInfo: { hasNextPage: store.marketsTruncated === true, endCursor: null },
      },
    }
  }
  const m = markets.find((x) => x.id === variables.id)
  if (!m) return { market: null }
  return {
    market: {
      id: m.id,
      name: m.name,
      status: m.status ?? "ACTIVE",
      conditions: {
        companyLocationsCondition: m.companyLocations
          ? {
              applicationLevel: m.companyLocations.level,
              companyLocations: { nodes: m.companyLocations.ids.map((id) => ({ id })), pageInfo: { hasNextPage: false, endCursor: null } },
            }
          : null,
      },
      catalogs: { nodes: m.catalogs, pageInfo: { hasNextPage: false } },
    },
  }
}

function makeCtx(store: Store) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const answer = (query: string, variables: Record<string, unknown>): unknown => {
    if (query.includes("B2bCustomerCompanies")) {
      const id = String(variables.id)
      return { customer: { id, companyContactProfiles: store.customers?.[id] ?? [] } }
    }
    if (query.includes("B2bPurchasingCompany")) {
      return {
        companyContact: {
          id: CONTACT,
          company: { id: COMPANY, name: "Example Trading Co" },
          customer: { id: CONTACT_CUSTOMER, email: "buyer@example-trading.com", firstName: "Sam", lastName: "Buyer", taxExempt: false },
          roleAssignments: { nodes: (store.contactRoles ?? [LOCATION]).map((id) => ({ companyLocation: { id } })) },
        },
        companyLocation: {
          id: variables.locationId,
          name: "Head office",
          company: { id: COMPANY, name: "Example Trading Co" },
          taxSettings: { taxExempt: false, taxRegistrationId: "XX123" },
          shippingAddress: { address1: "1 Market Street", city: "Springfield", zip: "12345", countryCode: "DE", companyName: "Example Trading Co", recipient: "Sam Buyer" },
          billingAddress: null,
        },
      }
    }
    if (query.includes("B2bLocationCatalogs")) {
      if (store.catalogsFail) throw new Error("access denied")
      return {
        companyLocation: {
          id: variables.id,
          catalogs: { nodes: store.directCatalogs ?? [DIRECT_CATALOG], pageInfo: { hasNextPage: false } },
        },
      }
    }
    if (query.includes("B2bMarketsList") || query.includes("B2bMarketCatalogs")) return answerMarkets(store, query, variables)
    if (query.includes("B2bFixedCatalogPrices")) {
      const fixed = store.fixedByList ?? { [PRICE_LIST]: store.fixedPriced ?? [] }
      const data: Record<string, unknown> = {}
      const lists = [...query.matchAll(/(pl\d+): priceList\(id: "([^"]+)"\)/g)]
      lists.forEach((l, i) => {
        const segment = query.slice(l.index, lists[i + 1]?.index ?? query.length)
        const out: Record<string, unknown> = { id: l[2] }
        for (const m of segment.matchAll(/(v\d+): prices\(first: 1, originType: FIXED, query: "variant_id:(\d+)"\)/g)) {
          const gid = `gid://shopify/ProductVariant/${m[2]}`
          out[m[1] as string] = { nodes: (fixed[l[2] as string] ?? []).includes(gid) ? [{ variant: { id: gid } }] : [] }
        }
        data[l[1] as string] = out
      })
      return data
    }
    if (query.includes("B2bDraftBuyer")) return { draftOrder: store.draftBuyer ?? null }
    if (query.includes("requiresShipping")) {
      return { nodes: (variables.ids as string[]).map((id) => ({ id, inventoryItem: { requiresShipping: true } })) }
    }
    if (query.includes("... on ProductVariant { price }")) {
      return { node: { price: store.listPrices?.[String(variables.id)] ?? null } }
    }
    if (query.includes("title product { title }")) return { node: { title: "Default Title", product: { title: "Studio Monitor" } } }
    if (query.includes("shop{ currencyCode }")) return { shop: { currencyCode: "EUR" } }
    if (query.includes("draftOrderCreate")) {
      return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1" }, userErrors: [] } }
    }
    return {}
  }
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string) =>
        entity === "install_metadata"
          ? [{ id: "i1", shopDomain: "demo.myshopify.com", connectionId: "ca1", apiVersion: "2026-04" }]
          : [],
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit: async () => undefined,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [{ id: "ca1", ownerType: "org", ownerId: null, identifier: "demo.myshopify.com", displayName: null }],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as { query: string; variables?: Record<string, unknown> }
      calls.push({ query: body.query, variables: body.variables ?? {} })
      try {
        return { status: 200, headers: {}, body: JSON.stringify({ data: answer(body.query, body.variables ?? {}) }) }
      } catch (err) {
        return { status: 200, headers: {}, body: JSON.stringify({ errors: [{ message: (err as Error).message }] }) }
      }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    config: { get: async () => null },
  } as unknown as AppContext
  return { ctx, calls }
}

const companyInput = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
  purchasingEntity: { purchasingCompany: PC },
  lineItems: lines,
  ...extra,
})

const companyProfile = {
  id: CONTACT,
  company: { id: COMPANY, name: "Example Trading Co" },
  roleAssignments: { nodes: [{ companyLocation: { id: LOCATION, name: "Head office" } }] },
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (err) {
    return { code: (err as { code: string }).code, message: (err as Error).message }
  }
  throw new Error("expected a refusal")
}

describe("B2B draft orders: company drafts priced by the catalog", () => {
  it("a company draft with plain lines passes untouched: no discount, no price, company location's addresses", async () => {
    const { ctx, calls } = makeCtx({ fixedPriced: [VARIANT] })
    const out = await normalizeDraftOrderInput(companyInput([{ variantId: VARIANT, quantity: 3 }]), ctx, {
      promoteWholeOrderDiscount: true,
      enforceBuyerIdentity: true,
    })
    expect(out.purchasingEntity).toEqual({ purchasingCompany: PC })
    expect(out.lineItems).toEqual([{ variantId: VARIANT, quantity: 3 }])
    expect(out.appliedDiscount).toBeUndefined()
    expect(out.shippingAddress).toMatchObject({ address1: "1 Market Street", city: "Springfield", countryCode: "DE", firstName: "Sam", lastName: "Buyer" })
    expect(calls.some((c) => c.query.includes("B2bFixedCatalogPrices"))).toBe(true)
  })

  it("a B2B customer without purchasingCompany is refused, naming the company and its locations", async () => {
    const { ctx } = makeCtx({ customers: { [CONTACT_CUSTOMER]: [companyProfile] } })
    const err = await refusal(
      normalizeDraftOrderInput({ purchasingEntity: { customerId: CONTACT_CUSTOMER }, lineItems: [{ variantId: VARIANT, quantity: 1 }] }, ctx),
    )
    expect(err.code).toBe("B2B_COMPANY_REQUIRED")
    expect(err.message).toContain("Example Trading Co")
    expect(err.message).toContain(LOCATION)
    expect(err.message).toContain(CONTACT)
  })

  it("the preflight refuses it before an approval is staged", async () => {
    const { ctx } = makeCtx({ customers: { [CONTACT_CUSTOMER]: [companyProfile] } })
    const out = await draft_orders_create_preflight(
      { input: { customerId: CONTACT_CUSTOMER, lineItems: [{ variantId: VARIANT, quantity: 1 }] } },
      ctx,
    )
    expect(out).toMatchObject({ error: { code: "B2B_COMPANY_REQUIRED" } })
  })

  it("a line discount on a B2B draft is refused", async () => {
    const { ctx } = makeCtx({ fixedPriced: [VARIANT] })
    const err = await refusal(
      normalizeDraftOrderInput(
        companyInput([{ variantId: VARIANT, quantity: 1, appliedDiscount: { value: 10, valueType: "PERCENTAGE" } }]),
        ctx,
      ),
    )
    expect(err.code).toBe("B2B_PRICE_NOT_CATALOG")
    expect(err.message).toContain("line 1 (appliedDiscount)")
  })

  it("an order-level discount and a lower per-unit price on a B2B draft are refused, never turned into a discount", async () => {
    const { ctx, calls } = makeCtx({ fixedPriced: [VARIANT], listPrices: { [VARIANT]: "100.00" } })
    const err = await refusal(
      normalizeDraftOrderInput(
        companyInput([{ variantId: VARIANT, quantity: 1, price: 80 }], { appliedDiscount: { value: 5, valueType: "PERCENTAGE" } }),
        ctx,
      ),
    )
    expect(err.code).toBe("B2B_PRICE_NOT_CATALOG")
    expect(err.message).toContain("line 1 (price)")
    expect(err.message).toContain("order-level appliedDiscount")
    // Refused before any price lookup: no list price was read to build a discount.
    expect(calls.some((c) => c.query.includes("... on ProductVariant { price }"))).toBe(false)
  })

  it("a custom price (originalUnitPriceWithCurrency) or a priceOverride without a reason is refused", async () => {
    const { ctx } = makeCtx({})
    const err = await refusal(
      normalizeDraftOrderInput(
        companyInput([
          { title: "Service", quantity: 1, originalUnitPriceWithCurrency: { amount: "50.00", currencyCode: "EUR" } },
          { variantId: VARIANT, quantity: 1, priceOverride: { amount: "10.00", currencyCode: "EUR" } },
        ]),
        ctx,
      ),
    )
    expect(err.code).toBe("B2B_PRICE_NOT_CATALOG")
    expect(err.message).toContain("line 1 (originalUnitPriceWithCurrency)")
    expect(err.message).toContain("line 2 (priceOverride)")
  })

  it("a priceOverride with a reason passes, sets the unit price with no discount, and carries the attribute", async () => {
    const { ctx } = makeCtx({ fixedPriced: [] })
    const out = await normalizeDraftOrderInput(
      companyInput([
        {
          variantId: VARIANT,
          quantity: 1,
          priceOverride: { amount: "0.00", currencyCode: "EUR" },
          priceException: { reason: "warranty_replacement", note: "RMA 1001" },
        },
      ]),
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]!
    expect(line.priceOverride).toEqual({ amount: "0.00", currencyCode: "EUR" })
    expect(line.appliedDiscount).toBeUndefined()
    expect(line.priceException).toBeUndefined()
    expect(line.customAttributes).toEqual([{ key: PRICE_EXCEPTION_ATTRIBUTE, value: "warranty_replacement: RMA 1001" }])
  })

  it("an excepted per-unit price on a B2B line becomes its priceOverride, not a discount", async () => {
    const { ctx } = makeCtx({ listPrices: { [VARIANT]: "100.00" } })
    const out = await normalizeDraftOrderInput(
      companyInput([{ variantId: VARIANT, quantity: 2, price: 60, priceException: { reason: "demo_unit" } }]),
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]!
    expect(line.variantId).toBe(VARIANT)
    expect(line.priceOverride).toEqual({ amount: "60", currencyCode: "EUR" })
    expect(line.appliedDiscount).toBeUndefined()
    expect(line.customAttributes).toEqual([{ key: PRICE_EXCEPTION_ATTRIBUTE, value: "demo_unit" }])
  })

  it("an unknown priceException reason is refused", async () => {
    expect(() => parsePriceException({ reason: "because" }, "line 1")).toThrow(/demo_unit, warranty_replacement, gift, approved_agreement/)
  })

  it("a contact with no role at the location is refused before staging", async () => {
    const { ctx } = makeCtx({ contactRoles: [OTHER_LOCATION] })
    const err = await refusal(normalizeDraftOrderInput(companyInput([{ variantId: VARIANT, quantity: 1 }]), ctx))
    expect(err.code).toBe("B2B_CONTACT_NO_ROLE")
  })

  it("a catalog line whose variant has no fixed B2B price is refused, naming the variant and the catalog", async () => {
    const { ctx } = makeCtx({ fixedPriced: [VARIANT] })
    const err = await refusal(
      normalizeDraftOrderInput(
        companyInput([
          { variantId: VARIANT, quantity: 1 },
          { variantId: VARIANT_2, quantity: 1 },
        ]),
        ctx,
      ),
    )
    expect(err.code).toBe("B2B_NO_CATALOG_PRICE")
    expect(err.message).toContain("line 2: no B2B price set for Studio Monitor")
    expect(err.message).toContain(VARIANT_2)
    expect(err.message).toContain("Wholesale (price list Wholesale EUR)")
    expect(err.message).not.toContain(`for Studio Monitor (${VARIANT})`)
  })

  describe("catalogs reached through a B2B market (every plan) and assigned directly (Plus)", () => {
    const plain = () => companyInput([{ variantId: VARIANT, quantity: 1 }])

    it("a catalog of a B2B market that lists the location prices the line", async () => {
      const { ctx } = makeCtx({ directCatalogs: [], markets: [B2B_MARKET], fixedByList: { [B2B_PRICE_LIST]: [VARIANT] } })
      const out = await normalizeDraftOrderInput(plain(), ctx)
      expect((out.lineItems as Array<Record<string, unknown>>)[0]).toMatchObject({ variantId: VARIANT, quantity: 1 })
    })

    it("a B2B market whose condition applies to ALL company locations counts", async () => {
      const { ctx } = makeCtx({
        directCatalogs: [],
        markets: [{ ...B2B_MARKET, companyLocations: { level: "ALL", ids: [] } }],
        fixedByList: { [B2B_PRICE_LIST]: [VARIANT] },
      })
      await normalizeDraftOrderInput(plain(), ctx)
    })

    it("a region market's catalog with a fixed price does not count: still refused", async () => {
      const { ctx } = makeCtx({
        directCatalogs: [],
        markets: [REGION_MARKET, { ...B2B_MARKET, companyLocations: { level: "SPECIFIED", ids: [OTHER_LOCATION] } }],
        fixedByList: { [REGION_PRICE_LIST]: [VARIANT], [B2B_PRICE_LIST]: [VARIANT] },
      })
      const err = await refusal(normalizeDraftOrderInput(plain(), ctx))
      expect(err.code).toBe("B2B_NO_CATALOG_PRICE")
      expect(err.message).toContain("no active catalog applies to Head office")
    })

    it("a draft B2B market does not count", async () => {
      const { ctx } = makeCtx({
        directCatalogs: [],
        markets: [{ ...B2B_MARKET, status: "DRAFT" }],
        fixedByList: { [B2B_PRICE_LIST]: [VARIANT] },
      })
      expect((await refusal(normalizeDraftOrderInput(plain(), ctx))).code).toBe("B2B_NO_CATALOG_PRICE")
    })

    it("a directly assigned catalog prices the line", async () => {
      const { ctx } = makeCtx({ markets: [REGION_MARKET], fixedByList: { [PRICE_LIST]: [VARIANT] } })
      await normalizeDraftOrderInput(plain(), ctx)
    })

    it("no catalog at all is refused", async () => {
      const { ctx } = makeCtx({ directCatalogs: [], markets: [] })
      const err = await refusal(normalizeDraftOrderInput(plain(), ctx))
      expect(err.code).toBe("B2B_NO_CATALOG_PRICE")
      expect(err.message).toContain("no active catalog applies to Head office")
    })

    it("a market catalog without the variant's fixed price is refused, naming the market", async () => {
      const { ctx } = makeCtx({ directCatalogs: [], markets: [B2B_MARKET], fixedByList: {} })
      const err = await refusal(normalizeDraftOrderInput(plain(), ctx))
      expect(err.code).toBe("B2B_NO_CATALOG_PRICE")
      expect(err.message).toContain("Trade catalog (price list Trade EUR) via market Trade buyers")
    })

    it("a truncated markets list fails closed", async () => {
      const { ctx } = makeCtx({ markets: [B2B_MARKET], marketsTruncated: true, fixedByList: { [PRICE_LIST]: [VARIANT] } })
      expect((await refusal(normalizeDraftOrderInput(plain(), ctx))).code).toBe("B2B_CATALOG_UNREADABLE")
    })
  })

  it("an unreadable catalog fails closed", async () => {
    const { ctx } = makeCtx({ catalogsFail: true })
    const err = await refusal(normalizeDraftOrderInput(companyInput([{ variantId: VARIANT, quantity: 1 }]), ctx))
    expect(err.code).toBe("B2B_CATALOG_UNREADABLE")
  })

  it("an update adding a discount to an existing company draft is refused by its preflight", async () => {
    const { ctx } = makeCtx({
      draftBuyer: {
        id: "gid://shopify/DraftOrder/9",
        purchasingEntity: { __typename: "PurchasingCompany", company: { id: COMPANY, name: "Example Trading Co" }, location: { id: LOCATION, name: "Head office" } },
        customer: { id: CONTACT_CUSTOMER },
      },
    })
    const out = await draft_orders_update_preflight(
      { id: "gid://shopify/DraftOrder/9", input: { appliedDiscount: { value: 10, valueType: "PERCENTAGE" } } },
      ctx,
    )
    expect(out).toMatchObject({ error: { code: "B2B_PRICE_NOT_CATALOG" } })
  })

  it("the gated create sends purchasingCompany alone (no customerId) with plain lines", async () => {
    const { ctx, calls } = makeCtx({ fixedPriced: [VARIANT] })
    await draft_orders_create({ input: companyInput([{ variantId: VARIANT, quantity: 2 }]) }, ctx)
    const create = calls.find((c) => c.query.includes("draftOrderCreate"))!
    const input = create.variables.input as Record<string, unknown>
    expect(input.purchasingEntity).toEqual({ purchasingCompany: PC })
    expect(input.lineItems).toEqual([{ variantId: VARIANT, quantity: 2 }])
  })
})

describe("non-B2B drafts are unchanged", () => {
  it("a consumer's lower per-unit price still becomes a percentage discount off the list price", async () => {
    const { ctx } = makeCtx({ listPrices: { [VARIANT]: "100.00" } })
    const out = await normalizeDraftOrderInput(
      { purchasingEntity: { customerId: CONSUMER }, lineItems: [{ variantId: VARIANT, quantity: 1, price: 80 }] },
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]!
    expect(line.appliedDiscount).toEqual({ valueType: "PERCENTAGE", value: 20, title: "Discount" })
    expect(line.priceOverride).toBeUndefined()
    expect(out.purchasingEntity).toEqual({ customerId: CONSUMER })
  })

  it("a consumer's line discount passes through, and no B2B catalog is read", async () => {
    const { ctx, calls } = makeCtx({})
    const out = await normalizeDraftOrderInput(
      {
        purchasingEntity: { customerId: CONSUMER },
        lineItems: [{ variantId: VARIANT, quantity: 1, appliedDiscount: { value: 10, valueType: "PERCENTAGE", title: "Promo" } }],
      },
      ctx,
    )
    expect((out.lineItems as Array<Record<string, unknown>>)[0]!.appliedDiscount).toMatchObject({ value: 10 })
    expect(calls.some((c) => c.query.includes("B2bLocationCatalogs"))).toBe(false)
  })

  it("a priceOverride still needs a reason on a consumer draft", async () => {
    const { ctx } = makeCtx({})
    const err = await refusal(
      normalizeDraftOrderInput(
        { purchasingEntity: { customerId: CONSUMER }, lineItems: [{ variantId: VARIANT, quantity: 1, priceOverride: { amount: "5.00" } }] },
        ctx,
      ),
    )
    expect(err.code).toBe("PRICE_EXCEPTION_REQUIRED")
  })
})

describe("approval card for a company draft", () => {
  it("shows the company, the location and each line's price basis", async () => {
    const s = await summarizeDraftOrderCreate(
      {
        input: companyInput([
          { variantId: VARIANT, quantity: 2 },
          { variantId: VARIANT_2, quantity: 1, priceOverride: { amount: "0.00", currencyCode: "EUR" }, priceException: { reason: "gift", note: "trade show" } },
        ]),
      },
      undefined,
      {
        connectionIdentifier: null,
        context: {
          variants: [
            { id: VARIANT, title: "Studio Monitor", price: "100.00" },
            { id: VARIANT_2, title: "Cable", price: "10.00" },
          ],
          company: { id: COMPANY, name: "Example Trading Co", locationId: LOCATION, locationName: "Head office" },
        },
      },
    )
    expect(s.lines).toContain("Company: Example Trading Co")
    expect(s.lines).toContain("Location: Head office (prices from this location's B2B catalog)")
    expect(s.lines).toContain("2× Studio Monitor: catalog price")
    expect(s.lines).toContain("1× Cable: price exception (gift: trade show), unit price 0.00")
    expect(s.lines.some((l) => l.startsWith("Projected total"))).toBe(false)
  })
})

describe("approval card for a company draft update", () => {
  it("names the existing draft's company and location and each line's basis", async () => {
    const s = await summarizeDraftOrdersUpdate(
      { id: "gid://shopify/DraftOrder/9", input: { lineItems: [{ variantId: VARIANT, quantity: 4 }] } },
      undefined,
      {
        connectionIdentifier: null,
        context: { draftOrder: { purchasingCompany: { companyName: "Example Trading Co", locationName: "Head office" } } },
      },
    )
    expect(s.lines).toContain("Company: Example Trading Co")
    expect(s.lines).toContain("4x 41: catalog price")
  })
})

describe("companies_search / companies_get", () => {
  it("builds Shopify's search string from a name or a raw query", () => {
    expect(companiesQueryString({ name: "Example" })).toBe("name:Example*")
    expect(companiesQueryString({ name: "Example Trading" })).toBe('name:"Example Trading"')
    expect(companiesQueryString({ query: "external_id:7" })).toBe("external_id:7")
  })

  const companyNode = {
    id: COMPANY,
    name: "Example Trading Co",
    externalId: null,
    note: null,
    mainContact: { id: CONTACT },
    locations: {
      nodes: [
        {
          id: LOCATION,
          name: "Head office",
          taxSettings: { taxExempt: true, taxRegistrationId: "XX123" },
          shippingAddress: { address1: "1 Market Street", city: "Springfield", countryCode: "DE" },
          billingAddress: null,
          catalogs: { nodes: [{ id: "gid://shopify/CompanyLocationCatalog/61", title: "Wholesale", status: "ACTIVE", priceList: { id: PRICE_LIST, name: "Wholesale EUR", currency: "EUR" } }] },
        },
      ],
    },
    contacts: {
      nodes: [
        {
          id: CONTACT,
          title: "Buyer",
          isMainContact: true,
          customer: { id: CONTACT_CUSTOMER, email: "buyer@example-trading.com", firstName: "Sam", lastName: "Buyer" },
          roleAssignments: { nodes: [{ role: { name: "Ordering only" }, companyLocation: { id: LOCATION, name: "Head office" } }] },
        },
      ],
    },
  }

  function readCtx(failCatalogs: boolean) {
    const queries: string[] = []
    const ctx = {
      ...makeCtx({}).ctx,
      fetch: async (_url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { query: string; variables?: Record<string, unknown> }
        queries.push(body.query)
        if (body.query.includes("B2bMarket")) {
          const data = answerMarkets({ markets: [B2B_MARKET, REGION_MARKET] }, body.query, body.variables ?? {})
          return { status: 200, headers: {}, body: JSON.stringify({ data }) }
        }
        if (failCatalogs && body.query.includes("catalogs(")) {
          return { status: 200, headers: {}, body: JSON.stringify({ errors: [{ message: "Access denied for catalogs" }] }) }
        }
        const node = body.query.includes("catalogs(") ? companyNode : { ...companyNode, locations: { nodes: [{ ...companyNode.locations.nodes[0], catalogs: undefined }] } }
        const data = body.query.includes("CompaniesSearch")
          ? { companies: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } }
          : { company: node }
        return { status: 200, headers: {}, body: JSON.stringify({ data }) }
      },
    } as unknown as AppContext
    return { ctx, queries }
  }

  it("returns locations (addresses, tax, catalogs) and contacts with roles per location", async () => {
    const { ctx } = readCtx(false)
    const out = await companies_search({ name: "Example" }, ctx)
    expect(out.catalogsReadable).toBe(true)
    const c = out.results[0]!
    expect(c.locations[0]).toMatchObject({
      id: LOCATION,
      taxExempt: true,
      taxRegistrationId: "XX123",
      catalogs: [
        { title: "Wholesale", priceList: { id: PRICE_LIST, currency: "EUR" }, source: "direct" },
        { title: "Trade catalog", priceList: { id: B2B_PRICE_LIST, currency: "EUR" }, source: "market:Trade buyers" },
      ],
    })
    // A region market's catalog never shows as one that applies to the location.
    expect(c.locations[0]!.catalogs).toHaveLength(2)
    expect(c.contacts[0]).toMatchObject({ id: CONTACT, customer: { id: CONTACT_CUSTOMER }, roles: [{ locationId: LOCATION, role: "Ordering only" }] })
  })

  it("falls back to no catalogs when they cannot be read", async () => {
    const { ctx, queries } = readCtx(true)
    const out = await companies_get({ id: COMPANY }, ctx)
    expect(out.catalogsReadable).toBe(false)
    expect(out.locations[0]!.catalogs).toBeNull()
    expect(queries).toHaveLength(2)
  })

  it("companies_get shows the market catalogs too, and a failed markets read makes every list null", async () => {
    const { ctx } = readCtx(false)
    const out = await companies_get({ id: COMPANY }, ctx)
    expect(out.catalogsReadable).toBe(true)
    expect(out.locations[0]!.catalogs?.map((c) => c.source)).toEqual(["direct", "market:Trade buyers"])
    const broken = {
      ...ctx,
      fetch: async (url: string, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? "{}") as { query: string }
        if (body.query.includes("B2bMarketsList")) {
          return { status: 200, headers: {}, body: JSON.stringify({ errors: [{ message: "Access denied for markets" }] }) }
        }
        return (ctx as unknown as { fetch: (u: string, i?: { body?: string }) => Promise<unknown> }).fetch(url, init)
      },
    } as unknown as AppContext
    const failed = await companies_get({ id: COMPANY }, broken)
    expect(failed.catalogsReadable).toBe(false)
    expect(failed.locations[0]!.catalogs).toBeNull()
  })
})
