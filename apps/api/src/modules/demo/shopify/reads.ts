// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Answering the READ half of the Shopify Admin GraphQL surface from fixtures.
//
// Dispatch is on the OPERATION NAME, not on a GraphQL parse. Every query the
// bundled app sends is a named operation it wrote itself (`query OrdersSearch`,
// `query DraftOrderGet`, ...), so the name is an exact, stable key, and the node
// builders return a superset of every selection set. Parsing the document would
// buy field-level precision the client does not need and would turn a new
// selection in the app into a demo outage.
//
// An operation this file does not know returns a GraphQL ERROR naming the demo,
// never an empty page. A visitor must be able to tell "the demo does not model
// this" from "your store has no orders", and so must whoever reads the log.
import { type DemoOrder, type DemoShopifyBook, demoShopifyBook, money } from "./fixtures"
import {
  customerNode,
  demoDiscountCodes,
  demoDiscountNode,
  demoDiscountStatus,
  draftOrderNode,
  fulfillmentOrdersFor,
  locationNode,
  orderNode,
  productNode,
  shopNode,
  variantNode,
} from "./nodes"
import {
  bulkCodeJob,
  createdDraftsFor,
  discountsFor,
  hasOverlay,
  withDraftPatch,
  withOrderPatch,
  worldOrdersFor,
} from "./overlay"
import { type FieldResolver, matchesShopifySearch } from "./search"

export interface ReadContext {
  orgId: string
  book: DemoShopifyBook
  variables: Record<string, unknown>
  document: string
}

// ── pagination ───────────────────────────────────────────────────────────────

function encodeCursor(index: number): string {
  return Buffer.from(`demo:${index}`, "utf8").toString("base64")
}

function decodeCursor(raw: unknown): number {
  if (typeof raw !== "string" || raw === "") return -1
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8")
    const match = decoded.match(/^demo:(\d+)$/)
    return match ? Number(match[1]) : -1
  } catch {
    return -1
  }
}

interface Page<T> {
  items: T[]
  pageInfo: {
    hasNextPage: boolean
    hasPreviousPage: boolean
    endCursor: string | null
    startCursor: string | null
  }
  cursors: string[]
}

function paginate<T>(all: T[], variables: Record<string, unknown>): Page<T> {
  const requested = Number(variables.first)
  const first =
    Number.isFinite(requested) && requested > 0 ? Math.min(250, Math.floor(requested)) : 50
  const start = decodeCursor(variables.after) + 1
  const items = all.slice(start, start + first)
  const cursors = items.map((_, i) => encodeCursor(start + i))
  return {
    items,
    cursors,
    pageInfo: {
      hasNextPage: start + first < all.length,
      hasPreviousPage: start > 0,
      endCursor: cursors.length > 0 ? (cursors[cursors.length - 1] as string) : null,
      startCursor: cursors[0] ?? null,
    },
  }
}

function connection<T>(all: T[], variables: Record<string, unknown>, build: (item: T) => unknown) {
  const page = paginate(all, variables)
  const nodes = page.items.map(build)
  return {
    edges: nodes.map((node, i) => ({ cursor: page.cursors[i] as string, node })),
    nodes,
    pageInfo: page.pageInfo,
  }
}

// ── the org's view of the book ───────────────────────────────────────────────

/** Orders as this org sees them: newest first, with any writes laid over. */
function ordersFor(ctx: ReadContext): DemoOrder[] {
  if (!hasOverlay(ctx.orgId)) return ctx.book.orders
  return [...worldOrdersFor(ctx.orgId), ...ctx.book.orders].map((order) =>
    withOrderPatch(ctx.orgId, order),
  )
}

// ── field resolvers (what a search query may filter on) ──────────────────────

/** The query vocabulary Shopify's `fulfillment_status:` accepts, per display status. */
const FULFILLMENT_TERMS: Record<string, string[]> = {
  UNFULFILLED: ["unfulfilled", "unshipped"],
  PARTIALLY_FULFILLED: ["partial", "unshipped"],
  FULFILLED: ["fulfilled", "shipped"],
  ON_HOLD: ["on_hold"],
  SCHEDULED: ["scheduled"],
}

function returnTerms(order: DemoOrder): string[] {
  if (order.returns.length === 0) return ["no_return"]
  const terms = new Set<string>()
  for (const item of order.returns) {
    if (item.status === "REQUESTED") terms.add("return_requested")
    else if (item.status === "OPEN") terms.add("in_progress")
    else if (item.status === "CLOSED") terms.add("returned")
    else terms.add("in_progress")
  }
  return [...terms]
}

function orderResolver(
  order: DemoOrder,
  ctx: ReadContext,
): { resolve: FieldResolver; text: string } {
  const customer = ctx.book.customersById.get(order.customerId)
  const skus = order.lineItems.map((li) => li.sku)
  const text = [order.name, order.email ?? "", customer?.displayName ?? "", ...skus, ...order.tags]
    .join(" ")
    .toLowerCase()
  const fields: Record<string, () => FieldValueLike> = {
    id: () => order.numericId,
    order_id: () => order.numericId,
    name: () => order.name,
    email: () => order.email,
    status: () => (order.cancelledAt ? "cancelled" : order.closed ? "closed" : "open"),
    financial_status: () => order.financialStatus.toLowerCase(),
    fulfillment_status: () =>
      FULFILLMENT_TERMS[order.fulfillmentStatus] ?? [order.fulfillmentStatus.toLowerCase()],
    return_status: () => returnTerms(order),
    created_at: () => order.createdAt,
    processed_at: () => order.processedAt,
    updated_at: () => order.processedAt,
    tag: () => order.tags,
    sku: () => skus,
    customer_id: () => (customer ? customer.numericId : null),
    country: () => order.shippingAddress.countryCode,
    total_price: () => order.totalMinor / 100,
    cancelled_at: () => order.cancelledAt,
  }
  return { resolve: (field) => fields[field]?.(), text }
}

type FieldValueLike = string | number | boolean | null | readonly string[]

// ── operation handlers ───────────────────────────────────────────────────────

type Handler = (ctx: ReadContext) => unknown

function searchOrders(ctx: ReadContext, extra?: (order: DemoOrder) => boolean): DemoOrder[] {
  const query = typeof ctx.variables.query === "string" ? ctx.variables.query : null
  return ordersFor(ctx).filter((order) => {
    if (extra && !extra(order)) return false
    const { resolve, text } = orderResolver(order, ctx)
    return matchesShopifySearch(query, resolve, text)
  })
}

const ordersSearch: Handler = (ctx) => {
  const matched = searchOrders(ctx)
  return {
    ordersCount: { count: matched.length },
    orders: connection(matched, ctx.variables, (order) => orderNode(order, ctx.book, ctx.orgId)),
  }
}

const orderGet: Handler = (ctx) => {
  const order = findOrder(ctx)
  return { order: order ? orderNode(order, ctx.book, ctx.orgId) : null }
}

function findOrder(ctx: ReadContext): DemoOrder | undefined {
  const raw = ctx.variables.id
  if (typeof raw !== "string") return undefined
  const numeric = raw.match(/(\d+)\s*$/)?.[1]
  const found = [...worldOrdersFor(ctx.orgId), ...ctx.book.orders].find(
    (order) => order.id === raw || String(order.numericId) === numeric,
  )
  return found ? withOrderPatch(ctx.orgId, found) : undefined
}

const customersSearch: Handler = (ctx) => {
  const query = typeof ctx.variables.query === "string" ? ctx.variables.query : null
  const orders = ordersFor(ctx)
  const matched = ctx.book.customers.filter((customer) => {
    const text =
      `${customer.displayName} ${customer.email} ${customer.tags.join(" ")}`.toLowerCase()
    const fields: Record<string, FieldValueLike> = {
      id: customer.numericId,
      customer_id: customer.numericId,
      email: customer.email,
      first_name: customer.firstName,
      last_name: customer.lastName,
      phone: customer.address.phone,
      tag: customer.tags,
      country: customer.countryCode,
      created_at: customer.createdAt,
    }
    return matchesShopifySearch(query, (field) => fields[field], text)
  })
  return {
    customersCount: { count: matched.length },
    customers: connection(matched, ctx.variables, (customer) =>
      customerNode(customer, ctx.book, ctx.orgId, orders),
    ),
  }
}

const productsSearch: Handler = (ctx) => {
  const query = typeof ctx.variables.query === "string" ? ctx.variables.query : null
  const matched = ctx.book.products.filter((product) => {
    const skus = product.variants.map((v) => v.sku)
    const text = `${product.title} ${product.vendor} ${skus.join(" ")}`.toLowerCase()
    const fields: Record<string, FieldValueLike> = {
      id: product.numericId,
      title: product.title,
      vendor: product.vendor,
      status: product.status.toLowerCase(),
      product_type: product.productType,
      sku: skus,
      created_at: product.createdAt,
      inventory_total: product.totalInventory,
    }
    return matchesShopifySearch(query, (field) => fields[field], text)
  })
  return { products: connection(matched, ctx.variables, productNode) }
}

function allVariants(ctx: ReadContext) {
  return ctx.book.products.flatMap((product) =>
    product.variants.map((variant) => ({ variant, product })),
  )
}

function matchVariants(ctx: ReadContext, query: string | null) {
  return allVariants(ctx).filter(({ variant, product }) => {
    const text = `${variant.displayName} ${variant.sku}`.toLowerCase()
    const fields: Record<string, FieldValueLike> = {
      id: variant.numericId,
      sku: variant.sku,
      title: variant.title,
      product_type: product.productType,
      inventory_quantity: variant.inventoryQuantity,
      price: variant.priceMinor / 100,
      vendor: product.vendor,
    }
    return matchesShopifySearch(query, (field) => fields[field], text)
  })
}

const variantsSearch: Handler = (ctx) => {
  const query = typeof ctx.variables.query === "string" ? ctx.variables.query : null
  const matched = matchVariants(ctx, query)
  return {
    productVariants: connection(matched, ctx.variables, ({ variant, product }) =>
      variantNode(variant, product),
    ),
  }
}

/**
 * Home's low-inventory probe carries its filter INSIDE the document rather than
 * as a variable, so it is read from the document text, not from `variables`.
 */
const lowInventory: Handler = (ctx) => {
  const inline = ctx.document.match(/query:\s*"([^"]*)"/)?.[1] ?? "inventory_quantity:<=5"
  const matched = matchVariants(ctx, inline)
  return {
    productVariants: connection(matched, ctx.variables, ({ variant, product }) =>
      variantNode(variant, product),
    ),
  }
}

const draftOrdersList: Handler = (ctx) => {
  const query = typeof ctx.variables.query === "string" ? ctx.variables.query : null
  // Newest first, as Shopify lists them: the quotes this org created, then the book's.
  const matched = [...[...createdDraftsFor(ctx.orgId)].reverse(), ...ctx.book.draftOrders]
    .map((draft) => withDraftPatch(ctx.orgId, draft))
    .filter((draft) => {
      const customer = ctx.book.customersById.get(draft.customerId)
      const text = `${draft.name} ${draft.email} ${customer?.displayName ?? ""}`.toLowerCase()
      const fields: Record<string, FieldValueLike> = {
        id: draft.numericId,
        name: draft.name,
        status: draft.status.toLowerCase(),
        email: draft.email,
        tag: draft.tags,
        created_at: draft.createdAt,
        updated_at: draft.updatedAt,
        customer_id: customer?.numericId ?? null,
      }
      return matchesShopifySearch(query, (field) => fields[field], text)
    })
  return {
    draftOrders: connection(matched, ctx.variables, (draft) =>
      draftOrderNode(draft, ctx.book, ctx.orgId),
    ),
  }
}

function findDraft(ctx: ReadContext) {
  const raw = ctx.variables.id
  const numeric = typeof raw === "string" ? raw.match(/(\d+)\s*$/)?.[1] : undefined
  return [...ctx.book.draftOrders, ...createdDraftsFor(ctx.orgId)].find(
    (draft) => draft.id === raw || String(draft.numericId) === numeric,
  )
}

const draftOrderGet: Handler = (ctx) => {
  const found = findDraft(ctx)
  return {
    draftOrder: found
      ? draftOrderNode(withDraftPatch(ctx.orgId, found), ctx.book, ctx.orgId)
      : null,
  }
}

const pendingReturns: Handler = (ctx) => {
  const open = ordersFor(ctx).flatMap((order) =>
    order.returns
      .filter((item) => item.status === "REQUESTED" || item.status === "OPEN")
      .map((item) => ({ order, item })),
  )
  open.sort((a, b) => b.item.requestedAt.localeCompare(a.item.requestedAt))
  return {
    returns: connection(open, ctx.variables, ({ order, item }) => ({
      id: item.id,
      name: item.name,
      status: item.status,
      requestedAt: item.requestedAt,
      totalQuantity: item.totalQuantity,
      order: { id: order.id, name: order.name, tags: order.tags },
      returnLineItems: {
        edges: [{ node: { returnReason: item.reason, quantity: item.totalQuantity } }],
      },
    })),
  }
}

const returnsByOrders: Handler = (ctx) => {
  const matched = searchOrders(ctx)
  return {
    orders: connection(matched, ctx.variables, (order) => ({
      id: order.id,
      name: order.name,
      tags: order.tags,
      returns: {
        edges: order.returns.map((item) => ({
          node: {
            id: item.id,
            name: item.name,
            status: item.status,
            totalQuantity: item.totalQuantity,
          },
        })),
      },
    })),
  }
}

const returnsByOrderId: Handler = (ctx) => {
  const order = findOrder(ctx)
  return {
    order: order
      ? {
          id: order.id,
          name: order.name,
          tags: order.tags,
          returns: {
            edges: order.returns.map((item) => ({
              node: {
                id: item.id,
                name: item.name,
                status: item.status,
                totalQuantity: item.totalQuantity,
              },
            })),
          },
        }
      : null,
  }
}

const inventoryLevels: Handler = (ctx) => {
  const raw = ctx.variables.id
  const variant = typeof raw === "string" ? ctx.book.variantsByInventoryItem.get(raw) : undefined
  if (!variant) return { inventoryItem: null }
  // The stock splits across the two locations, deterministically and exactly:
  // the hub holds a third, the workshop the rest, and they sum to the variant's
  // own `inventoryQuantity` so the two reads can never disagree.
  const hub = Math.floor(variant.inventoryQuantity / 3)
  const split = [
    {
      location: ctx.book.locations[0] as { id: string; name: string },
      quantity: variant.inventoryQuantity - hub,
    },
    { location: ctx.book.locations[1] as { id: string; name: string }, quantity: hub },
  ]
  const levels = split.map((entry, i) => ({
    id: `${variant.inventoryItemId}/Level/${i + 1}`,
    location: { id: entry.location.id, name: entry.location.name },
    quantities: [
      { name: "available", quantity: entry.quantity },
      { name: "on_hand", quantity: entry.quantity },
      { name: "committed", quantity: 0 },
    ],
  }))
  return {
    inventoryItem: {
      id: variant.inventoryItemId,
      sku: variant.sku,
      inventoryLevels: connection(levels, ctx.variables, (level) => level),
    },
  }
}

const inventoryLevelAt: Handler = (ctx) => {
  const raw = ctx.variables.id
  const variant = typeof raw === "string" ? ctx.book.variantsByInventoryItem.get(raw) : undefined
  if (!variant) return { inventoryItem: null }
  const names = Array.isArray(ctx.variables.names) ? (ctx.variables.names as string[]) : ["on_hand"]
  return {
    inventoryItem: {
      id: variant.inventoryItemId,
      inventoryLevel: {
        quantities: names.map((name) => ({ name, quantity: variant.inventoryQuantity })),
      },
    },
  }
}

const marketsFor = (ctx: ReadContext) => {
  const byCountry = new Map<string, string>()
  for (const customer of ctx.book.customers)
    byCountry.set(customer.countryCode, customer.address.country)
  return [...byCountry.entries()].map(([code, name], i) => ({
    id: `gid://shopify/Market/${9_200_000 + i}`,
    name,
    handle: code.toLowerCase(),
    enabled: true,
    currencySettings: { baseCurrency: { currencyCode: "EUR" } },
    regions: {
      edges: [{ node: { id: `gid://shopify/MarketRegion/${9_300_000 + i}`, name, code } }],
    },
  }))
}

/**
 * The book has no discounts: the list holds exactly the codes this org has
 * created, newest first, as Shopify lists them.
 */
const discountsSearch: Handler = (ctx) => {
  const query = typeof ctx.variables.query === "string" ? ctx.variables.query : null
  const matched = [...discountsFor(ctx.orgId)].reverse().filter((discount) => {
    const fields: Record<string, FieldValueLike> = {
      code: demoDiscountCodes(discount),
      title: discount.title,
      status: demoDiscountStatus(discount).toLowerCase(),
      starts_at: discount.startsAt,
      ends_at: discount.endsAt,
      created_at: discount.createdAt,
    }
    const text = `${demoDiscountCodes(discount).join(" ")} ${discount.title}`.toLowerCase()
    return matchesShopifySearch(query, (field) => fields[field], text)
  })
  return { codeDiscountNodes: connection(matched, ctx.variables, (d) => demoDiscountNode(d)) }
}

const READ_HANDLERS: Record<string, Handler> = {
  OrdersSearch: ordersSearch,
  UnfulfilledOrders: ordersSearch,
  Unfulfilled: (ctx) => ({
    orders: connection(searchOrders(ctx), ctx.variables, (order) =>
      orderNode(order, ctx.book, ctx.orgId),
    ),
  }),
  RecentOrders: (ctx) => ({
    orders: connection(ordersFor(ctx), ctx.variables, (order) =>
      orderNode(order, ctx.book, ctx.orgId),
    ),
  }),
  OrderGet: orderGet,
  OrderDetail: orderGet,
  // `orders_get` handed an order's number or name: the order behind that name.
  OrderByName: (ctx) => ({
    orders: connection(searchOrders(ctx), ctx.variables, (order) => ({
      id: order.id,
      name: order.name,
    })),
  }),
  OrderNoteGet: (ctx) => {
    const order = findOrder(ctx)
    return { order: order ? { id: order.id, note: order.note } : null }
  },
  OrderFulfillmentOrders: (ctx) => fulfillmentOrdersOnly(ctx),
  OrderFulfillmentOrdersGet: (ctx) => fulfillmentOrdersOnly(ctx),
  OrderFulfillmentOrdersWithLines: (ctx) => fulfillmentOrdersOnly(ctx),
  RefundOrderContext: orderGet,
  CustomersSearch: customersSearch,
  CustomerGet: (ctx) => customerById(ctx),
  CustomerById: (ctx) => customerById(ctx),
  CustomerSegmentMembers: () => ({
    customerSegmentMembers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }),
  RepeatRate: (ctx) => ({
    customers: connection(ctx.book.customers, ctx.variables, (customer) => ({
      id: customer.id,
      displayName: customer.displayName,
      numberOfOrders: String(
        ctx.book.orders.filter((order) => order.customerId === customer.id).length,
      ),
    })),
  }),
  ProductsSearch: productsSearch,
  ProductGet: (ctx) => productById(ctx),
  ProductMergeRead: (ctx) => productById(ctx),
  VariantsSearch: variantsSearch,
  VariantGet: (ctx) => variantById(ctx),
  VariantProduct: (ctx) => variantById(ctx),
  LowInventory: lowInventory,
  InventoryValue: (ctx) => ({
    productVariants: connection(allVariants(ctx), ctx.variables, ({ variant, product }) =>
      variantNode(variant, product),
    ),
  }),
  InventoryLevels: inventoryLevels,
  InvLevelNamed: inventoryLevelAt,
  InvLevelOnHand: inventoryLevelAt,
  LocationsList: (ctx) => ({
    locations: connection(ctx.book.locations, ctx.variables, locationNode),
  }),
  DraftOrdersList: draftOrdersList,
  DraftOrderGet: draftOrderGet,
  /**
   * The B2B guard on a draft order asks whether its buyer is a company contact. The demo store
   * models consumers and companies' people as plain customers, with no B2B company, so the real
   * answer for every one of them is "no company": an empty list of contact profiles.
   */
  B2bCustomerCompanies: (ctx) => {
    const { customer } = customerById(ctx)
    return { customer: customer ? { id: customer.id, companyContactProfiles: [] } : null }
  },
  B2bDraftBuyer: (ctx) => {
    const found = findDraft(ctx)
    if (!found) return { draftOrder: null }
    const customer = ctx.book.customersById.get(found.customerId)
    return {
      draftOrder: {
        id: found.id,
        purchasingEntity: customer ? { __typename: "Customer", id: customer.id } : null,
        customer: customer ? { id: customer.id } : null,
      },
    }
  },
  PendingReturns: pendingReturns,
  ReturnsByOrders: returnsByOrders,
  ReturnsByOrderId: returnsByOrderId,
  MarketsList: (ctx) => ({
    markets: connection(marketsFor(ctx), ctx.variables, (market) => market),
  }),
  MarketGet: (ctx) => ({ market: marketsFor(ctx)[0] ?? null }),
  StaffMembersProbe: () => ({ staffMembers: { edges: [] } }),
  StaffMembersAll: () => ({
    staffMembers: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }),
  WebhookSubscriptionList: () => ({
    webhookSubscriptions: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }),
  MetafieldsList: () => ({
    order: { metafields: emptyConnection() },
    product: { metafields: emptyConnection() },
    customer: { metafields: emptyConnection() },
    productVariant: { metafields: emptyConnection() },
  }),
  AbandonedCheckouts: () => ({
    abandonedCheckouts: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  }),
  DiscountsSearch: discountsSearch,
  DiscountNodeCodes: (ctx) => {
    const found = discountsFor(ctx.orgId).find((d) => d.id === ctx.variables.id)
    const first = Number(ctx.variables.first)
    return {
      codeDiscountNode: found
        ? demoDiscountNode(found, Number.isFinite(first) && first > 0 ? Math.floor(first) : 1)
        : null,
    }
  },
  DiscountBulkCreationStatus: (ctx) => {
    const job = bulkCodeJob(ctx.orgId, String(ctx.variables.id ?? ""))
    return {
      discountRedeemCodeBulkCreation: job
        ? {
            id: job.id,
            done: true,
            codesCount: job.codesCount,
            importedCount: job.importedCount,
            failedCount: job.failedCount,
          }
        : null,
    }
  },
  CurrentBulkOp: () => ({ currentBulkOperation: null }),
  UrlRedirectsByPath: () => ({ urlRedirects: emptyConnection() }),
  RefundGet: (ctx) => {
    const raw = String(ctx.variables.id ?? "")
    for (const order of ordersFor(ctx)) {
      const refund = order.refunds.find((r) => r.id === raw)
      if (refund) {
        return {
          refund: {
            id: refund.id,
            note: refund.note,
            createdAt: refund.createdAt,
            totalRefundedSet: {
              presentmentMoney: { amount: money(refund.amountMinor), currencyCode: "EUR" },
              shopMoney: { amount: money(refund.amountMinor), currencyCode: "EUR" },
            },
            order: { id: order.id, name: order.name },
          },
        }
      }
    }
    return { refund: null }
  },
  FulfillmentGet: (ctx) => {
    const raw = String(ctx.variables.id ?? "")
    for (const order of ordersFor(ctx)) {
      const fulfillment = order.fulfillments.find((f) => f.id === raw)
      if (fulfillment) {
        return {
          fulfillment: {
            id: fulfillment.id,
            status: fulfillment.status,
            createdAt: fulfillment.createdAt,
            trackingInfo: [
              {
                company: fulfillment.carrier,
                number: fulfillment.trackingNumber,
                url: fulfillment.trackingUrl,
              },
            ],
            order: { id: order.id, name: order.name, tags: order.tags },
            fulfillmentLineItems: {
              edges: fulfillment.lineItemIds.map((id) => ({
                node: {
                  id,
                  quantity: order.lineItems.find((li) => li.id === id)?.quantity ?? 1,
                },
              })),
            },
          },
        }
      }
    }
    return { fulfillment: null }
  },
  /**
   * ShopifyQL is not modelled. Answering `parseErrors` is not a cop-out: it is
   * the REAL answer for a store whose plan has no ShopifyQL, and it drives
   * `analytics_query` down its own degrade path, a bounded tally over
   * `orders_search`, which this provider does answer in full. So the demo's
   * analytics numbers are computed from the same order book the operator can
   * see, and they add up.
   */
  Analytics: () => ({
    shopifyqlQuery: {
      tableData: null,
      parseErrors: [{ code: "UNSUPPORTED", message: "ShopifyQL is not available on this plan" }],
    },
  }),
}

function emptyConnection() {
  return { edges: [], nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
}

function fulfillmentOrdersOnly(ctx: ReadContext) {
  const order = findOrder(ctx)
  if (!order) return { order: null }
  return {
    order: { id: order.id, name: order.name, fulfillmentOrders: fulfillmentOrdersFor(order) },
  }
}

function customerById(ctx: ReadContext) {
  const raw = ctx.variables.id
  const numeric = typeof raw === "string" ? raw.match(/(\d+)\s*$/)?.[1] : undefined
  const found = ctx.book.customers.find(
    (customer) => customer.id === raw || String(customer.numericId) === numeric,
  )
  return {
    customer: found ? customerNode(found, ctx.book, ctx.orgId, ordersFor(ctx)) : null,
  }
}

function productById(ctx: ReadContext) {
  const raw = ctx.variables.id
  const numeric = typeof raw === "string" ? raw.match(/(\d+)\s*$/)?.[1] : undefined
  const found = ctx.book.products.find(
    (product) => product.id === raw || String(product.numericId) === numeric,
  )
  return { product: found ? productNode(found) : null }
}

function variantById(ctx: ReadContext) {
  const raw = ctx.variables.id
  const numeric = typeof raw === "string" ? raw.match(/(\d+)\s*$/)?.[1] : undefined
  const entry = allVariants(ctx).find(
    ({ variant }) => variant.id === raw || String(variant.numericId) === numeric,
  )
  return { productVariant: entry ? variantNode(entry.variant, entry.product) : null }
}

/** The read handler for `operation`, or undefined when the demo does not model it. */
export function demoShopifyRead(operation: string): Handler | undefined {
  return READ_HANDLERS[operation]
}

/** Every operation the demo store answers. Pinned by the coverage test. */
export function demoShopifyReadOperations(): string[] {
  return Object.keys(READ_HANDLERS).sort()
}

/** A bare `{ shop { ... } }` probe, which several call sites send unnamed. */
export function demoShopIsRequested(document: string): boolean {
  return /(^|[\s{])shop\s*(\(|\{)/.test(document)
}

export function demoShopPayload(shopDomain: string): unknown {
  return { shop: shopNode(shopDomain) }
}

export function demoReadContext(
  orgId: string,
  variables: Record<string, unknown>,
  document: string,
): ReadContext {
  return { orgId, book: demoShopifyBook(), variables, document }
}
