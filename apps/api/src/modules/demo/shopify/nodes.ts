// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Fixture records projected into Shopify Admin GraphQL nodes.
//
// Each builder returns a SUPERSET of every selection set the bundled app asks
// for that entity. Over-returning is free (the client reads the fields its own
// query named and ignores the rest) and it means one shape per entity instead
// of one per query, so a new selection in the app cannot silently read
// `undefined` off a node built for a different call site.
import {
  type DemoDraftOrder,
  type DemoLineItem,
  type DemoLocation,
  type DemoOrder,
  type DemoProduct,
  type DemoShopifyBook,
  type DemoShopifyCustomer,
  type DemoVariant,
  money,
} from "./fixtures"
import { type DemoCreatedDiscount, patchedCustomerTags } from "./overlay"
import { DEMO_SHOP_NAME } from "./sentinel"

const CURRENCY = "EUR"

function moneyBag(minor: number) {
  const amount = { amount: money(minor), currencyCode: CURRENCY }
  return { presentmentMoney: { ...amount }, shopMoney: { ...amount } }
}

function addressNode(address: DemoOrder["shippingAddress"]) {
  return {
    name: address.name,
    company: address.company,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    province: address.province,
    provinceCode: address.provinceCode,
    zip: address.zip,
    country: address.country,
    countryCode: address.countryCode,
    countryCodeV2: address.countryCode,
    phone: address.phone,
  }
}

function lineItemNode(item: DemoLineItem, variant: DemoVariant | undefined) {
  const unit = moneyBag(item.unitMinor)
  return {
    id: item.id,
    name: item.title,
    title: item.title,
    sku: item.sku,
    custom: false,
    taxable: true,
    requiresShipping: true,
    quantity: item.quantity,
    variant: {
      id: item.variantId,
      title: variant?.title ?? "Default Title",
      sku: item.sku,
      product: { id: item.productId },
    },
    originalUnitPriceSet: unit,
    discountedUnitPriceAfterAllDiscountsSet: unit,
    discountedTotalSet: moneyBag(item.unitMinor * item.quantity),
    appliedDiscount: null,
  }
}

function customerSummary(customer: DemoShopifyCustomer | undefined, orgId: string) {
  if (!customer) return null
  return {
    id: customer.id,
    email: customer.email,
    firstName: customer.firstName,
    lastName: customer.lastName,
    displayName: customer.displayName,
    phone: customer.address.phone,
    tags: patchedCustomerTags(orgId, customer.id) ?? customer.tags,
    defaultAddress: addressNode({ ...customer.address, company: customer.address.company }),
  }
}

export function orderNode(order: DemoOrder, book: DemoShopifyBook, orgId: string) {
  const customer = book.customersById.get(order.customerId)
  const refundedMinor = order.refunds.reduce((sum, r) => sum + r.amountMinor, 0)
  return {
    id: order.id,
    legacyResourceId: String(order.numericId),
    name: order.name,
    email: order.email,
    note: order.note,
    poNumber: null,
    createdAt: order.createdAt,
    processedAt: order.processedAt,
    updatedAt: order.processedAt,
    tags: order.tags,
    displayFinancialStatus: order.financialStatus,
    displayFulfillmentStatus: order.fulfillmentStatus,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    closed: order.closed,
    currencyCode: CURRENCY,
    currentTotalPriceSet: moneyBag(order.totalMinor - refundedMinor),
    originalTotalPriceSet: moneyBag(order.totalMinor),
    subtotalPriceSet: moneyBag(order.subtotalMinor),
    totalRefundedSet: moneyBag(refundedMinor),
    shippingAddress: addressNode(order.shippingAddress),
    billingAddress: addressNode(order.shippingAddress),
    customer: customerSummary(customer, orgId),
    market: { name: order.shippingAddress.country },
    lineItems: {
      edges: order.lineItems.map((item) => ({
        node: lineItemNode(item, book.variantsById.get(item.variantId)),
      })),
      nodes: order.lineItems.map((item) =>
        lineItemNode(item, book.variantsById.get(item.variantId)),
      ),
    },
    shippingLine: order.shippingTitle
      ? {
          title: order.shippingTitle,
          originalPriceSet: moneyBag(order.shippingMinor),
          discountedPriceSet: moneyBag(order.shippingMinor),
        }
      : null,
    fulfillments: order.fulfillments.map((f) => ({
      id: f.id,
      status: f.status,
      createdAt: f.createdAt,
      trackingInfo: [{ company: f.carrier, number: f.trackingNumber, url: f.trackingUrl }],
    })),
    refunds: order.refunds.map((r) => ({
      id: r.id,
      note: r.note,
      createdAt: r.createdAt,
      totalRefundedSet: moneyBag(r.amountMinor),
    })),
    returns: {
      edges: order.returns.map((r) => ({
        node: { id: r.id, name: r.name, status: r.status, totalQuantity: r.totalQuantity },
      })),
    },
    fulfillmentOrders: fulfillmentOrdersFor(order),
  }
}

/**
 * Fulfilment orders, derived rather than stored: one per order, assigned to the
 * order's location, with `remainingQuantity` counting down as fulfilments are
 * created. That derivation is what keeps a partial shipment honest after the
 * write overlay adds a fulfilment.
 */
export function fulfillmentOrdersFor(order: DemoOrder) {
  const shipped = new Map<string, number>()
  for (const fulfillment of order.fulfillments) {
    for (const lineItemId of fulfillment.lineItemIds) {
      const item = order.lineItems.find((li) => li.id === lineItemId)
      shipped.set(lineItemId, (shipped.get(lineItemId) ?? 0) + (item?.quantity ?? 0))
    }
  }
  const lineItems = order.lineItems.map((item, i) => ({
    id: `${order.id}/FulfillmentOrderLineItem/${i + 1}`,
    totalQuantity: item.quantity,
    remainingQuantity: Math.max(0, item.quantity - (shipped.get(item.id) ?? 0)),
    lineItem: { id: item.id, sku: item.sku, title: item.title },
  }))
  const remaining = lineItems.reduce((sum, li) => sum + li.remainingQuantity, 0)
  const node = {
    id: `${order.id}/FulfillmentOrder/1`,
    status: order.cancelledAt ? "CANCELLED" : remaining === 0 ? "CLOSED" : "OPEN",
    assignedLocation: { name: "Paris Workshop" },
    lineItems: { nodes: lineItems, edges: lineItems.map((node) => ({ node })) },
  }
  return { nodes: [node], edges: [{ node }] }
}

export function customerNode(
  customer: DemoShopifyCustomer,
  book: DemoShopifyBook,
  orgId: string,
  orders: DemoOrder[],
) {
  const mine = orders.filter((o) => o.customerId === customer.id)
  const spentMinor = mine
    .filter((o) => o.cancelledAt === null)
    .reduce((sum, o) => sum + o.totalMinor, 0)
  return {
    id: customer.id,
    legacyResourceId: String(customer.numericId),
    email: customer.email,
    phone: customer.address.phone,
    firstName: customer.firstName,
    lastName: customer.lastName,
    displayName: customer.displayName,
    tags: patchedCustomerTags(orgId, customer.id) ?? customer.tags,
    createdAt: customer.createdAt,
    defaultAddress: addressNode({ ...customer.address }),
    numberOfOrders: String(mine.length),
    amountSpent: { amount: money(spentMinor), currencyCode: CURRENCY },
    orders: {
      edges: mine.slice(0, 3).map((order) => ({
        node: {
          name: order.name,
          lineItems: {
            edges: order.lineItems.slice(0, 3).map((item) => ({
              node: { title: item.title, quantity: item.quantity },
            })),
          },
        },
      })),
    },
    ...(book.customersById.has(customer.id) ? {} : {}),
  }
}

export function variantNode(variant: DemoVariant, product: DemoProduct | undefined) {
  return {
    id: variant.id,
    legacyResourceId: String(variant.numericId),
    sku: variant.sku,
    title: variant.title,
    displayName: variant.displayName,
    price: money(variant.priceMinor),
    inventoryQuantity: variant.inventoryQuantity,
    inventoryItem: {
      id: variant.inventoryItemId,
      harmonizedSystemCode: variant.hsCode,
      countryCodeOfOrigin: variant.originCountry,
    },
    product: product
      ? {
          id: product.id,
          title: product.title,
          productType: product.productType,
          customsDescription: { value: product.description },
        }
      : null,
  }
}

export function productNode(product: DemoProduct) {
  return {
    id: product.id,
    legacyResourceId: String(product.numericId),
    title: product.title,
    vendor: product.vendor,
    status: product.status,
    productType: product.productType,
    description: product.description,
    totalInventory: product.totalInventory,
    createdAt: product.createdAt,
    customsDescription: { value: product.description },
    variants: {
      edges: product.variants.map((variant) => ({ node: variantNode(variant, product) })),
      nodes: product.variants.map((variant) => variantNode(variant, product)),
    },
  }
}

export function draftOrderNode(draft: DemoDraftOrder, book: DemoShopifyBook, orgId: string) {
  const customer = book.customersById.get(draft.customerId)
  const taxMinor = 0
  return {
    id: draft.id,
    legacyResourceId: String(draft.numericId),
    name: draft.name,
    status: draft.status,
    tags: draft.tags,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    email: draft.email,
    note2: draft.note,
    poNumber: null,
    taxExempt: false,
    taxesIncluded: true,
    currencyCode: CURRENCY,
    totalPriceSet: moneyBag(draft.totalMinor),
    subtotalPriceSet: moneyBag(draft.subtotalMinor),
    totalTaxSet: moneyBag(taxMinor),
    appliedDiscount: null,
    order: draft.orderId ? { id: draft.orderId, name: draft.orderName, poNumber: null } : null,
    shippingLine: { title: draft.shippingTitle, originalPriceSet: moneyBag(draft.shippingMinor) },
    taxLines: [],
    billingAddress: customer ? addressNode({ ...customer.address }) : null,
    shippingAddress: customer ? addressNode({ ...customer.address }) : null,
    customer: customerSummary(customer, orgId),
    lineItems: {
      edges: draft.lineItems.map((item) => ({
        node: lineItemNode(item, book.variantsById.get(item.variantId)),
      })),
    },
  }
}

export function locationNode(location: DemoLocation) {
  return {
    id: location.id,
    name: location.name,
    isActive: location.isActive,
    address: {
      city: location.city,
      country: location.country,
      countryCode: location.countryCode,
    },
  }
}

export function shopNode(shopDomain: string) {
  return {
    id: "gid://shopify/Shop/9000001",
    name: DEMO_SHOP_NAME,
    myshopifyDomain: shopDomain,
    email: "sales@resonantaudiolabs.example",
    currencyCode: CURRENCY,
    ianaTimezone: "Europe/Paris",
    plan: { displayName: "Demo" },
    billingAddress: {
      city: "Paris",
      country: "France",
      countryCodeV2: "FR",
      zip: "75011",
      address1: "14 rue des Ateliers",
    },
  }
}

// ── discounts ────────────────────────────────────────────────────────────────

/**
 * The status Shopify reports for a code discount: SCHEDULED until it starts,
 * EXPIRED once it has ended, ACTIVE in between. Computed on every read, so a
 * code created to start next week reads SCHEDULED, as it would on a real store.
 */
export function demoDiscountStatus(discount: DemoCreatedDiscount, now = Date.now()): string {
  if (Date.parse(discount.startsAt) > now) return "SCHEDULED"
  if (discount.endsAt !== null && Date.parse(discount.endsAt) <= now) return "EXPIRED"
  return "ACTIVE"
}

/** Every redeem code a created discount carries: its own, then the bulk-added ones. */
export function demoDiscountCodes(discount: DemoCreatedDiscount): string[] {
  return [discount.code, ...discount.extraCodes]
}

/**
 * A `DiscountCodeNode` with a superset of every selection the bundled app
 * sends. `codesFirst` bounds the `codes` connection as `codes(first:)` does.
 */
export function demoDiscountNode(discount: DemoCreatedDiscount, codesFirst = 1): unknown {
  const all = demoDiscountCodes(discount)
  const codeNodes = all
    .slice(0, Math.max(1, Math.min(250, codesFirst)))
    .map((code, i) => ({ id: `${discount.id}/DiscountRedeemCode/${i + 1}`, code }))
  const summary =
    discount.percentage !== null
      ? `${Math.round(discount.percentage * 100)}% off entire order`
      : discount.amountMinor !== null
        ? `€${money(discount.amountMinor)} off entire order`
        : "Discount on entire order"
  return {
    id: discount.id,
    codeDiscount: {
      __typename: "DiscountCodeBasic",
      title: discount.title,
      status: demoDiscountStatus(discount),
      summary,
      startsAt: discount.startsAt,
      endsAt: discount.endsAt,
      createdAt: discount.createdAt,
      usageLimit: discount.usageLimit,
      appliesOncePerCustomer: discount.appliesOncePerCustomer,
      asyncUsageCount: 0,
      codesCount: { count: all.length },
      codes: {
        nodes: codeNodes,
        edges: codeNodes.map((node) => ({ node })),
        pageInfo: { hasNextPage: codeNodes.length < all.length, endCursor: null },
      },
    },
  }
}
