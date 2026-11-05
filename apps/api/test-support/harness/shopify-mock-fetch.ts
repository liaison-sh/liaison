// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deep-week-sim Shopify analytics harness — server-side Shopify Admin-API mock.
//
// THE Shopify app is a REAL bundled app (bundled-apps/shopify). This mock stands
// in ONLY for the external Shopify Admin GraphQL boundary (`*.myshopify.com`) —
// never for the bundle capability itself. It lets the deep-week-sim analytics
// scenarios drive the real `analytics_query` tool end-to-end (typed enum spec →
// injection-hardened ShopifyQL builder → sandbox bridge → mock) without a live
// dev store, and lets the degrade path (ShopifyQL unavailable → bounded tally
// over `orders_search`) be exercised deterministically.
//
// Why a host-intercept mock (not a loopback HTTP mock the bundle fetches
// directly): the sandbox-fetch bridge enforces the bundle's `*.myshopify.com`
// domain allowlist + HTTPS, so a `http://127.0.0.1` mock cannot be reached
// through the real bridge. Intercepting the canonical Shopify host (exactly as
// the Pennylane mock intercepts `app.pennylane.com`) keeps the entire production
// read path real while making the external book deterministic.
//
// Modeled section-for-section on pennylane-mock-fetch.ts:
//   * matches on hostname (`*.myshopify.com`) and returns canned GraphQL
//     `Response`s keyed by the operation name parsed from the query body.
//   * delegates to the REAL `fetch` for every other host, so the Boxtal /
//     Pennylane / social suites on the same spawned server are untouched.
//   * records every Shopify request `{ url, method, headers, body, actor }`.
//   * a mutable per-server-process MODE registry (`shopifyql` / `no_shopifyql`)
//     is seeded by the `_test` mock-control route (shopify-install-routes.ts).
//     The mode is a per-process global, so Shopify-analytics scenarios MUST run
//     serially within a worker (the default for `.scenario.test.ts`).

// — recorder —

export interface ShopifyMockRecord {
  url: string
  method: string
  /** Lowercased header map (Bun normalizes header names to lowercase). */
  headers: Record<string, string>
  /** Actor marker the bridge injects when LIAISON_TEST_INJECT_ACTOR=1. */
  actor: string | null
  body: string | null
  /** Parsed GraphQL operation name (best-effort) for assertion convenience. */
  operation: string | null
  receivedAt: number
}

const records: ShopifyMockRecord[] = []

export function shopifyMockAllRequests(): ShopifyMockRecord[] {
  return [...records]
}
export function shopifyMockClearRequests(): void {
  records.length = 0
}

// — mutable per-scenario MODE registry —

/**
 * Two analytics transport verdicts:
 *   - `shopifyql`    = the connected plan exposes `shopifyqlQuery`; Analytics
 *                      returns a populated `tableData` (the authoritative aggregate).
 *   - `no_shopifyql` = the plan does NOT expose ShopifyQL; Analytics returns
 *                      `parseErrors`, so the handler degrades to a BOUNDED in-context
 *                      tally over `orders_search` (source:"bounded_tally", partial:true).
 */
export type ShopifyMockMode = "shopifyql" | "no_shopifyql"

interface ShopifyMockState {
  mode: ShopifyMockMode
}

const state: ShopifyMockState = { mode: "shopifyql" }

export function setShopifyMockMode(mode: ShopifyMockMode): void {
  state.mode = mode
}

export function resetShopifyMockMode(): void {
  state.mode = "shopifyql"
}

// — seeded order window (the bounded-tally degrade pages this via orders_search) —

interface SeededOrder {
  id: string
  name: string
  email: string
  createdAt: string
  amount: string
  currencyCode: string
}

// A small, deterministic order window. The bounded-tally degrade counts these,
// AND the meta-ads weekly-roas-digest routine tick reads them via orders_search for
// its "last 7 days" window. Because that tick computes the window from the REAL
// run-date (wall-clock "now"), the order dates must be RELATIVE to now (recent),
// not absolute — hardcoded May dates fall outside any current "last 7 days" window
// and the tick (correctly) counts zero revenue, making the runtime ROAS degenerate.
// Anchored to N-days-ago so all three sit inside both a "last 7 days" and a
// "prior calendar week" tick window regardless of which weekday the gate fires.
// Amounts unchanged (Σ = 4000.00 EUR) so the bounded-tally + analytics aggregates
// that depend on the total are untouched.
function daysAgoIso(days: number, hour = 10): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  d.setUTCHours(hour, 0, 0, 0)
  return d.toISOString()
}

const SEEDED_ORDERS: SeededOrder[] = [
  {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    email: "dealer-a@northwind-audio.test",
    createdAt: daysAgoIso(2, 10),
    amount: "1200.00",
    currencyCode: "EUR",
  },
  {
    id: "gid://shopify/Order/1002",
    name: "#1002",
    email: "dealer-b@cascade-synths.test",
    createdAt: daysAgoIso(4, 14),
    amount: "800.00",
    currencyCode: "EUR",
  },
  {
    id: "gid://shopify/Order/1003",
    name: "#1003",
    email: "dealer-c@boutique-modular.test",
    createdAt: daysAgoIso(6, 9),
    amount: "2000.00",
    currencyCode: "EUR",
  },
]

// — seedable OPEN orders (the boxtal prep grid's order-driven worklist) —
//
// The legacy SEEDED_ORDERS above are all FULFILLED and carry no address or line items, because the
// analytics harness only ever counted their money. The prep grid is a worklist of OPEN UNFULFILLED
// orders and reads the ship-to address and the line items off them, so a scenario has to be able to
// put a real open order in the store. Seeded orders are ADDITIVE: the analytics fixtures keep
// answering exactly as before when nothing is seeded.

export interface SeedableOrderInput {
  id?: string
  name: string
  email?: string | null
  /** The CUSTOMER's name (distinct from the ship-to name). Split into firstName/lastName the way a
   *  real order hit carries them. Defaults to the shipping address name. */
  customerName?: string | null
  createdAt?: string
  amount?: string
  currencyCode?: string
  tags?: string[]
  financialStatus?: string
  fulfillmentStatus?: string
  cancelledAt?: string | null
  cancelReason?: string | null
  shippingAddress?: {
    name?: string | null
    address1?: string | null
    address2?: string | null
    city?: string | null
    province?: string | null
    provinceCode?: string | null
    zip?: string | null
    country?: string | null
    countryCode?: string | null
    phone?: string | null
  } | null
  lineItems?: Array<{
    id?: string
    title?: string
    quantity?: number
    sku?: string | null
    variantId?: string | null
    unitAmount?: string
  }>
}

interface SeededOpenOrder extends SeedableOrderInput {
  id: string
  createdAt: string
  amount: string
  currencyCode: string
  financialStatus: string
  fulfillmentStatus: string
}

const seededOpenOrders: SeededOpenOrder[] = []
let seededOrderSeq = 0

/** Put orders in the mock store. Returns the gids they were stored under. */
export function seedShopifyMockOrders(orders: SeedableOrderInput[]): string[] {
  const ids: string[] = []
  for (const o of orders) {
    seededOrderSeq += 1
    const id = o.id ?? `gid://shopify/Order/${7000000 + seededOrderSeq}`
    const row: SeededOpenOrder = {
      ...o,
      id,
      createdAt: o.createdAt ?? daysAgoIso(1, 9),
      amount: o.amount ?? "699.00",
      currencyCode: o.currencyCode ?? "EUR",
      financialStatus: o.financialStatus ?? "PAID",
      fulfillmentStatus: o.fulfillmentStatus ?? "UNFULFILLED",
    }
    const existing = seededOpenOrders.findIndex((s) => s.id === id || s.name === row.name)
    if (existing >= 0) seededOpenOrders[existing] = row
    else seededOpenOrders.push(row)
    ids.push(id)
  }
  return ids
}

export function clearShopifyMockOrders(): void {
  seededOpenOrders.length = 0
  seededOrderSeq = 0
}

export function shopifyMockSeededOrders(): SeededOpenOrder[] {
  return [...seededOpenOrders]
}

function moneySet(amount: string, currencyCode: string) {
  return {
    presentmentMoney: { amount, currencyCode },
    shopMoney: { amount, currencyCode },
  }
}

function seededOrderNode(o: SeededOpenOrder, detailed: boolean) {
  const addr = o.shippingAddress ?? null
  const address = addr
    ? {
        name: addr.name ?? null,
        address1: addr.address1 ?? null,
        address2: addr.address2 ?? null,
        city: addr.city ?? null,
        province: addr.province ?? null,
        provinceCode: addr.provinceCode ?? null,
        zip: addr.zip ?? null,
        country: addr.country ?? null,
        countryCode: addr.countryCode ?? null,
        phone: addr.phone ?? null,
      }
    : null
  const [customerFirst, ...customerRest] = String(o.customerName ?? addr?.name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const customerLast = customerRest.length > 0 ? customerRest.join(" ") : null
  const lineItemEdges = (o.lineItems ?? []).map((li, i) => ({
    node: {
      id: li.id ?? `${o.id}/line/${i + 1}`,
      title: li.title ?? "Item",
      quantity: li.quantity ?? 1,
      variant: {
        id: li.variantId ?? `gid://shopify/ProductVariant/${900000 + i}`,
        title: li.title ?? "Default",
        sku: li.sku ?? null,
      },
      ...(detailed
        ? {
            originalUnitPriceSet: {
              presentmentMoney: { amount: li.unitAmount ?? "699.00", currencyCode: o.currencyCode },
            },
            discountedUnitPriceAfterAllDiscountsSet: {
              presentmentMoney: { amount: li.unitAmount ?? "699.00", currencyCode: o.currencyCode },
            },
          }
        : {}),
    },
  }))
  const base = {
    id: o.id,
    name: o.name,
    email: o.email ?? null,
    createdAt: o.createdAt,
    processedAt: o.createdAt,
    tags: o.tags ?? [],
    displayFinancialStatus: o.financialStatus,
    displayFulfillmentStatus: o.fulfillmentStatus,
    cancelledAt: o.cancelledAt ?? null,
    cancelReason: o.cancelReason ?? null,
    currentTotalPriceSet: moneySet(o.amount, o.currencyCode),
    originalTotalPriceSet: moneySet(o.amount, o.currencyCode),
    shippingAddress: address,
    customer: {
      id: `${o.id}/cust`,
      email: o.email ?? null,
      firstName: customerFirst ?? null,
      lastName: customerLast,
      phone: address?.phone ?? null,
      defaultAddress: address,
    },
    lineItems: { edges: lineItemEdges },
  }
  if (!detailed) return base
  return {
    ...base,
    shippingLine: null,
    fulfillments: [],
    refunds: [],
    returns: { edges: [] },
  }
}

/**
 * Apply the ONLY query terms this mock understands. Everything else in the query string is ignored
 * rather than silently dropping orders, so a scenario that filters on something unmodelled sees its
 * orders and can say so, instead of debugging an empty grid.
 */
function matchesOrderQuery(o: SeededOpenOrder, query: string): boolean {
  if (!query) return true
  if (/fulfillment_status:unfulfilled/.test(query) && o.fulfillmentStatus === "FULFILLED")
    return false
  if (/fulfillment_status:fulfilled/.test(query) && o.fulfillmentStatus !== "FULFILLED")
    return false
  if (/status:open/.test(query) && o.cancelledAt) return false
  const byName = query.match(/name:(#?[\w-]+)/)
  if (byName) {
    const wanted = byName[1]!.startsWith("#") ? byName[1]! : `#${byName[1]!}`
    if (o.name !== wanted) return false
  }
  return true
}

function numericOrderIdOf(gid: string): string {
  const m = String(gid).match(/(\d+)\s*$/)
  return m ? m[1]! : String(gid)
}

// The seeded ShopifyQL aggregate the `Analytics` operation returns under the
// `shopifyql` mode. `total_sales` for the May window = 4000.00; grouped by
// billing_region (market) it splits FR / DE.
const ANALYTICS_TABLE_BY_MARKET = {
  columns: [{ name: "billing_region" }, { name: "total_sales" }],
  rowData: [
    ["France", "2400.00"],
    ["Germany", "1600.00"],
  ],
}

const ANALYTICS_TABLE_TOTAL = {
  columns: [{ name: "total_sales" }],
  rowData: [["4000.00"]],
}

// — response helpers —

function jsonResponse(body: unknown, httpStatus = 200): Response {
  return new Response(JSON.stringify(body), {
    status: httpStatus,
    headers: { "content-type": "application/json" },
  })
}

const THROTTLE_EXT = {
  cost: {
    actualQueryCost: 1,
    throttleStatus: { currentlyAvailable: 1999, maximumAvailable: 2000, restoreRate: 100 },
  },
}

/** Best-effort GraphQL operation-name parse from the request body. */
function parseOperation(body: string | null): string | null {
  if (!body) return null
  let query: unknown
  try {
    const parsed = JSON.parse(body) as { operationName?: string; query?: string }
    if (typeof parsed.operationName === "string" && parsed.operationName.length > 0) {
      return parsed.operationName
    }
    query = parsed.query
  } catch {
    return null
  }
  if (typeof query !== "string") return null
  const m = query.match(/(?:query|mutation)\s+(\w+)/)
  return m?.[1] ?? null
}

/** One GraphQL variable off the request body, or null. The mock only ever needs a couple. */
function readGraphqlVariable(body: string | null, name: string): string | null {
  if (!body) return null
  try {
    const parsed = JSON.parse(body) as { variables?: Record<string, unknown> }
    const v = parsed.variables?.[name]
    return typeof v === "string" ? v : null
  } catch {
    return null
  }
}

/** The `ids` variable of a `nodes(ids:)` query, or none. */
function readGraphqlIds(body: string | null): string[] {
  if (!body) return []
  try {
    const parsed = JSON.parse(body) as { variables?: Record<string, unknown> }
    const v = parsed.variables?.ids
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** Detect a market (billing_region) group in the assembled ShopifyQL string. */
function bodyHasMarketGroup(body: string | null): boolean {
  return body != null && body.includes("billing_region")
}

// — host predicate + install gate —

/** Hosts the Shopify mock serves canned bytes for (the bridge calls it directly). */
export function shopifyMockHandlesHost(hostname: string): boolean {
  return hostname.endsWith(".myshopify.com")
}

/**
 * The e2e server installs the Shopify Admin-API mock UNLESS live mode is
 * explicitly opted in. `SHOPIFY_E2E_LIVE === "1"` bypasses the mock so every
 * Shopify-host outbound call reaches the real sandbox via the production
 * `fetchWithPinnedHost` path (the live dev store). Any other value keeps the
 * deterministic mock — the CI default.
 */
export function shouldInstallShopifyMock(
  env: { SHOPIFY_E2E_LIVE?: string | undefined; [key: string]: string | undefined } = process.env,
): boolean {
  return env.SHOPIFY_E2E_LIVE !== "1"
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

export function makeShopifyMockFetch(realFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    let host: string
    try {
      host = new URL(url).hostname
    } catch {
      return realFetch(input, init)
    }

    if (!shopifyMockHandlesHost(host)) {
      // Not a Shopify host — defer to the real fetch (keeps Boxtal / Pennylane /
      // social scenarios on the same spawned server working unchanged).
      return realFetch(input, init)
    }

    const method = (init?.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    }
    const body = typeof init?.body === "string" ? init.body : null
    const operation = parseOperation(body)
    records.push({
      url,
      method,
      headers,
      actor: headers["x-liaison-actor"] ?? null,
      body,
      operation,
      receivedAt: Date.now(),
    })

    const path = new URL(url).pathname

    // OAuth token exchange (unused under real-token install, kept for parity).
    if (path === "/admin/oauth/access_token") {
      return jsonResponse({ access_token: "mock-offline-token", scope: "read_orders" })
    }

    // GraphQL Admin endpoint — `/admin/api/<version>/graphql.json`.
    if (path.includes("/graphql.json") || path.endsWith("/graphql")) {
      // — Analytics (ShopifyQL aggregate) —
      if (operation === "Analytics") {
        if (state.mode === "no_shopifyql") {
          // ShopifyQL not available on this plan → parseErrors drives the degrade.
          return jsonResponse({
            data: {
              shopifyqlQuery: {
                tableData: null,
                parseErrors: [
                  { code: "UNSUPPORTED", message: "shopifyqlQuery is not available on this plan" },
                ],
              },
            },
            extensions: THROTTLE_EXT,
          })
        }
        const tableData = bodyHasMarketGroup(body)
          ? ANALYTICS_TABLE_BY_MARKET
          : ANALYTICS_TABLE_TOTAL
        return jsonResponse({
          data: { shopifyqlQuery: { tableData, parseErrors: [] } },
          extensions: THROTTLE_EXT,
        })
      }

      // — OrdersSearch (the bounded-tally degrade pages this; the boxtal prep grid scans it) —
      if (operation === "OrdersSearch") {
        const query = readGraphqlVariable(body, "query")
        const legacy = SEEDED_ORDERS.map((o) => ({
          node: {
            id: o.id,
            name: o.name,
            email: o.email,
            createdAt: o.createdAt,
            tags: [],
            displayFinancialStatus: "PAID",
            displayFulfillmentStatus: "FULFILLED",
            cancelledAt: null,
            cancelReason: null,
            currentTotalPriceSet: {
              presentmentMoney: { amount: o.amount, currencyCode: o.currencyCode },
              shopMoney: { amount: o.amount, currencyCode: o.currencyCode },
            },
            customer: { id: `${o.id}/cust`, email: o.email, firstName: null, lastName: null },
          },
        }))
        // The legacy window is FULFILLED and named #1001..#1003, so it is filtered by the same
        // matcher rather than by a special case: an unfulfilled-only or name-scoped query drops it,
        // and the analytics fixtures (which pass no terms at all) see exactly what they always saw.
        const legacyEdges = legacy.filter((e) =>
          matchesOrderQuery(
            {
              id: e.node.id,
              name: e.node.name,
              createdAt: e.node.createdAt,
              amount: "0",
              currencyCode: "EUR",
              financialStatus: "PAID",
              fulfillmentStatus: "FULFILLED",
              cancelledAt: null,
            },
            query ?? "",
          ),
        )
        const seededEdges = seededOpenOrders
          .filter((o) => matchesOrderQuery(o, query ?? ""))
          .map((o) => ({ node: seededOrderNode(o, false) }))
        const edges = [...seededEdges, ...legacyEdges]
        return jsonResponse({
          data: {
            ordersCount: { count: edges.length },
            orders: { edges, pageInfo: { hasNextPage: false, endCursor: null } },
          },
          extensions: THROTTLE_EXT,
        })
      }

      // — OrderGet: the single-order read `orders_get` sends (richer than a search hit) —
      if (operation === "OrderGet" || operation === "OrderDetail") {
        const wanted = readGraphqlVariable(body, "id")
        const found = wanted
          ? seededOpenOrders.find((o) => numericOrderIdOf(o.id) === numericOrderIdOf(wanted))
          : undefined
        return jsonResponse({
          data: { order: found ? seededOrderNode(found, true) : null },
          extensions: THROTTLE_EXT,
        })
      }

      // — Variant lookup by id (`variants_brief`: an anonymous `nodes(ids:)` query) —
      // Answered from the seeded orders' line items, the variants this store has sold: id, sku,
      // title and product title, the fields the real query selects. An id the store does not
      // know is a null node, as Shopify answers it.
      if (!operation && body?.includes("nodes(ids:") && body.includes("ProductVariant")) {
        const ids = readGraphqlIds(body)
        const known = new Map<string, { sku: string | null; title: string }>()
        for (const o of seededOpenOrders) {
          ;(o.lineItems ?? []).forEach((li, i) => {
            const id = li.variantId ?? `gid://shopify/ProductVariant/${900000 + i}`
            known.set(id, { sku: li.sku ?? null, title: li.title ?? "Item" })
          })
        }
        const nodes = ids.map((id) => {
          const v = known.get(id)
          return v
            ? {
                id,
                title: "Default Title",
                sku: v.sku,
                price: "0.00",
                product: { title: v.title },
                inventoryItem: { requiresShipping: true },
              }
            : null
        })
        return jsonResponse({ data: { nodes }, extensions: THROTTLE_EXT })
      }

      // — default `shop` health-check / connection probe —
      return jsonResponse({
        data: {
          shop: {
            id: "gid://shopify/Shop/1",
            name: "Mock Dev Store",
            myshopifyDomain: host,
          },
        },
        extensions: THROTTLE_EXT,
      })
    }

    // Unhandled Shopify path — 404 with an inspectable body.
    return jsonResponse({ mock: "shopify", unhandled: path, method }, 404)
  }) as typeof fetch
}
