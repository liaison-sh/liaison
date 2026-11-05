// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The WRITE half: mutations a visitor performs on the demo store.
//
// Each one lands in the per-org overlay (overlay.ts) and is visible on the very
// next read, so the demo can show a label bought and the order leaving the
// worklist, a refund appearing on an order, a quote turning into an order, a
// new discount code in the discounts list. None of them reaches Shopify: this
// module never touches the network, and the
// egress interception it sits behind has already decided that a demo org's
// Shopify traffic is answered here or refused.
//
// A mutation that is NOT modelled is refused, in Shopify's own userErrors
// channel, with the demo message. Refusing is deliberate: the alternative, a
// success envelope over a write that changed nothing, teaches the visitor that
// the product lies to them.
import {
  type DemoDraftOrder,
  type DemoFulfillment,
  type DemoLineItem,
  type DemoOrder,
  demoShopifyBook,
  money,
} from "./fixtures"
import { demoDiscountCodes, demoDiscountNode } from "./nodes"
import {
  addBulkCodes,
  addCreatedDraft,
  addDiscount,
  bulkCodeJobCount,
  createdDraftsFor,
  customerPatch,
  type DemoCreatedDiscount,
  DemoOverlayFullError,
  discountsFor,
  draftPatch,
  orderPatch,
  withDraftPatch,
  withOrderPatch,
  worldOrdersFor,
} from "./overlay"

/**
 * The time a write stamps on what it creates. A replica replaying the shared
 * write log (replica.ts) pins it to the original write's time, so every
 * process holds the same record.
 */
let pinnedWriteTime: Date | null = null

function writeTime(): Date {
  return pinnedWriteTime ?? new Date()
}

/** Run `fn` (synchronous) with every write stamped at `at`. */
export function atDemoWriteTime<T>(at: Date, fn: () => T): T {
  const previous = pinnedWriteTime
  pinnedWriteTime = at
  try {
    return fn()
  } finally {
    pinnedWriteTime = previous
  }
}

export interface WriteContext {
  orgId: string
  variables: Record<string, unknown>
  /** The message an unmodelled or impossible write is refused with. */
  refusal: string
}

type WriteHandler = (ctx: WriteContext) => unknown

function userError(message: string, field: string[] | null = null) {
  return { field, message }
}

function gidNumeric(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  return raw.match(/(\d+)\s*$/)?.[1] ?? null
}

/**
 * The order behind a reference. Callers hand this an order gid, a bare order
 * number, or a derived child id such as a fulfilment order's
 * `gid://shopify/Order/<n>/FulfillmentOrder/1`, so the ORDER segment is read
 * first and only then the trailing number.
 */
function findOrder(orgId: string, raw: unknown): DemoOrder | undefined {
  const embedded = typeof raw === "string" ? raw.match(/\/Order\/(\d+)/) : null
  const numeric = embedded ? embedded[1] : gidNumeric(raw)
  // The scenario's live orders too: a write on the order that just arrived finds it.
  const found = [...worldOrdersFor(orgId), ...demoShopifyBook().orders].find(
    (order) => order.id === raw || String(order.numericId) === numeric,
  )
  return found ? withOrderPatch(orgId, found) : undefined
}

/** A quote by gid or number: the book's, or one this org created. Unpatched. */
function findDraft(orgId: string, raw: unknown): DemoDraftOrder | undefined {
  const numeric = gidNumeric(raw)
  return [...demoShopifyBook().draftOrders, ...createdDraftsFor(orgId)].find(
    (d) => d.id === raw || String(d.numericId) === numeric,
  )
}

/** Which entity a bare gid points at, so `tagsAdd` can patch the right record. */
function entityOf(raw: unknown): "order" | "customer" | "draft" | null {
  if (typeof raw !== "string") return null
  if (raw.includes("/Order/")) return "order"
  if (raw.includes("/Customer/")) return "customer"
  if (raw.includes("/DraftOrder/")) return "draft"
  return null
}

function tagStrings(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t)).filter((t) => t !== "")
  if (typeof raw === "string" && raw !== "") return raw.split(",").map((t) => t.trim())
  return []
}

function currentTags(ctx: WriteContext, id: string): string[] | null {
  const book = demoShopifyBook()
  switch (entityOf(id)) {
    case "order": {
      const order = findOrder(ctx.orgId, id)
      return order ? [...order.tags] : null
    }
    case "customer": {
      const customer = book.customersById.get(id)
      if (!customer) return null
      const patched = customerPatch(ctx.orgId, id).tags
      return patched ? [...patched] : [...customer.tags]
    }
    case "draft": {
      const draft = findDraft(ctx.orgId, id)
      return draft ? [...withDraftPatch(ctx.orgId, draft).tags] : null
    }
    default:
      return null
  }
}

function writeTags(ctx: WriteContext, id: string, tags: string[]): void {
  switch (entityOf(id)) {
    case "order":
      orderPatch(ctx.orgId, id).tags = tags
      break
    case "customer":
      customerPatch(ctx.orgId, id).tags = tags
      break
    case "draft":
      draftPatch(ctx.orgId, id).tags = tags
      break
  }
}

function applyTags(ctx: WriteContext, add: boolean): unknown {
  const id = ctx.variables.id
  if (typeof id !== "string") {
    return { node: null, userErrors: [userError("id is required", ["id"])] }
  }
  const existing = currentTags(ctx, id)
  if (existing === null) {
    return { node: null, userErrors: [userError(`${id} was not found in the demo store`, ["id"])] }
  }
  const requested = tagStrings(ctx.variables.tags)
  const next = add
    ? [...existing, ...requested.filter((tag) => !existing.includes(tag))]
    : existing.filter((tag) => !requested.includes(tag))
  writeTags(ctx, id, next)
  return { node: { id }, userErrors: [] }
}

/** `orderUpdate`, which backs both `order_note_set` and `order_update`. */
const orderUpdate: WriteHandler = (ctx) => {
  const input = (ctx.variables.input ?? {}) as Record<string, unknown>
  const order = findOrder(ctx.orgId, input.id)
  if (!order) {
    return { order: null, userErrors: [userError("order not found in the demo store", ["id"])] }
  }
  const patch = orderPatch(ctx.orgId, order.id)
  if ("note" in input) patch.note = input.note === null ? null : String(input.note)
  if ("email" in input) patch.email = input.email === null ? null : String(input.email)
  if ("tags" in input) patch.tags = tagStrings(input.tags)
  const updated = withOrderPatch(ctx.orgId, order)
  return {
    order: { id: updated.id, name: updated.name, note: updated.note, tags: updated.tags },
    userErrors: [],
  }
}

const orderCancel: WriteHandler = (ctx) => {
  const order = findOrder(ctx.orgId, ctx.variables.orderId)
  if (!order) {
    return { job: null, userErrors: [userError("order not found in the demo store", ["orderId"])] }
  }
  if (order.cancelledAt) {
    return { job: null, userErrors: [userError("this order is already cancelled", ["orderId"])] }
  }
  const patch = orderPatch(ctx.orgId, order.id)
  patch.cancelledAt = writeTime().toISOString()
  patch.cancelReason = String(ctx.variables.reason ?? "OTHER")
  patch.closed = true
  if (ctx.variables.refund === true) {
    patch.financialStatus = "REFUNDED"
    patch.addedRefunds = [
      ...(patch.addedRefunds ?? []),
      {
        id: `${order.id}/Refund/cancel`,
        note: "Refunded on cancellation.",
        createdAt: writeTime().toISOString(),
        amountMinor: order.totalMinor,
      },
    ]
  } else {
    patch.financialStatus = "VOIDED"
  }
  return { job: { id: `gid://shopify/Job/${order.numericId}` }, userErrors: [] }
}

/**
 * Create a fulfilment. The demo accepts the WHOLE requested fulfilment order,
 * which is what Boxtal's ship action asks for, and recomputes the order's
 * display status from what is left: a partial batch leaves the order
 * PARTIALLY_FULFILLED and on the worklist, the last batch takes it off.
 */
const fulfillmentCreate: WriteHandler = (ctx) => {
  const input = (ctx.variables.fulfillment ?? {}) as Record<string, unknown>
  const groups = Array.isArray(input.lineItemsByFulfillmentOrder)
    ? (input.lineItemsByFulfillmentOrder as Array<Record<string, unknown>>)
    : []
  const firstGroupId = groups[0]?.fulfillmentOrderId
  const order = findOrder(ctx.orgId, firstGroupId)
  if (!order) {
    return {
      fulfillment: null,
      userErrors: [
        userError("no open fulfillment order for that order in the demo store", ["fulfillment"]),
      ],
    }
  }
  const tracking = (input.trackingInfo ?? {}) as Record<string, unknown>
  // Which lines ship: the ones named, or every line still owed when the caller
  // named none (Shopify's own "fulfil the whole fulfilment order" default).
  const named = groups.flatMap((group) =>
    Array.isArray(group.fulfillmentOrderLineItems)
      ? (group.fulfillmentOrderLineItems as Array<Record<string, unknown>>)
      : [],
  )
  const remaining = remainingLineIds(order)
  const shipping =
    named.length === 0
      ? remaining
      : named
          .map((line) => lineIdForFulfillmentOrderLine(order, line.id))
          .filter((id): id is string => id !== null && remaining.includes(id))
  if (shipping.length === 0) {
    return {
      fulfillment: null,
      userErrors: [userError("every line on this order has already shipped", ["fulfillment"])],
    }
  }
  const fulfillment: DemoFulfillment = {
    id: `${order.id}/Fulfillment/demo-${order.fulfillments.length + 1}`,
    status: "SUCCESS",
    createdAt: writeTime().toISOString(),
    carrier: String(tracking.company ?? "Colissimo"),
    trackingNumber: String(tracking.number ?? `RA${order.numericId}D`),
    trackingUrl: String(
      tracking.url ?? `https://tracking.${demoShopifyBook().shopDomain}/${order.numericId}`,
    ),
    lineItemIds: shipping,
  }
  const patch = orderPatch(ctx.orgId, order.id)
  patch.addedFulfillments = [...(patch.addedFulfillments ?? []), fulfillment]
  const stillOwed = remaining.filter((id) => !shipping.includes(id))
  patch.fulfillmentStatus = stillOwed.length === 0 ? "FULFILLED" : "PARTIALLY_FULFILLED"
  return {
    fulfillment: {
      id: fulfillment.id,
      status: fulfillment.status,
      trackingInfo: [
        {
          number: fulfillment.trackingNumber,
          url: fulfillment.trackingUrl,
          company: fulfillment.carrier,
        },
      ],
    },
    userErrors: [],
  }
}

function remainingLineIds(order: DemoOrder): string[] {
  const shipped = new Set(order.fulfillments.flatMap((f) => f.lineItemIds))
  return order.lineItems.map((li) => li.id).filter((id) => !shipped.has(id))
}

/** Fulfilment-order line ids are derived (`<order>/FulfillmentOrderLineItem/<n>`). */
function lineIdForFulfillmentOrderLine(order: DemoOrder, raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const index = Number(raw.match(/FulfillmentOrderLineItem\/(\d+)$/)?.[1])
  if (Number.isFinite(index)) return order.lineItems[index - 1]?.id ?? null
  return order.lineItems.find((li) => li.id === raw)?.id ?? null
}

const refundCreate: WriteHandler = (ctx) => {
  const input = (ctx.variables.input ?? {}) as Record<string, unknown>
  const order = findOrder(ctx.orgId, input.orderId)
  if (!order) {
    return {
      refund: null,
      userErrors: [userError("order not found in the demo store", ["orderId"])],
    }
  }
  const alreadyMinor = order.refunds.reduce((sum, r) => sum + r.amountMinor, 0)
  const refundableMinor = order.totalMinor - alreadyMinor
  if (refundableMinor <= 0) {
    return {
      refund: null,
      userErrors: [userError("this order has already been refunded in full", ["orderId"])],
    }
  }
  const requestedMinor = requestedRefundMinor(input)
  const amountMinor =
    requestedMinor === null ? refundableMinor : Math.min(requestedMinor, refundableMinor)
  if (amountMinor <= 0) {
    return {
      refund: null,
      userErrors: [userError("a refund must be for more than zero", ["input"])],
    }
  }
  const patch = orderPatch(ctx.orgId, order.id)
  patch.addedRefunds = [
    ...(patch.addedRefunds ?? []),
    {
      id: `${order.id}/Refund/demo-${order.refunds.length + 1}`,
      note: typeof input.note === "string" ? input.note : null,
      createdAt: writeTime().toISOString(),
      amountMinor,
    },
  ]
  patch.financialStatus =
    alreadyMinor + amountMinor >= order.totalMinor ? "REFUNDED" : "PARTIALLY_REFUNDED"
  return {
    refund: {
      id: patch.addedRefunds[patch.addedRefunds.length - 1]!.id,
      note: typeof input.note === "string" ? input.note : null,
      totalRefundedSet: {
        presentmentMoney: { amount: money(amountMinor), currencyCode: "EUR" },
        shopMoney: { amount: money(amountMinor), currencyCode: "EUR" },
      },
    },
    userErrors: [],
  }
}

/** The refund amount the caller asked for, from whichever field it used. */
function requestedRefundMinor(input: Record<string, unknown>): number | null {
  const transactions = Array.isArray(input.transactions)
    ? (input.transactions as Array<Record<string, unknown>>)
    : []
  let minor = 0
  for (const transaction of transactions) {
    const amount = Number(transaction.amount)
    if (Number.isFinite(amount)) minor += Math.round(amount * 100)
  }
  return minor > 0 ? minor : null
}

/** Numeric part of a created quote's gid: above the book's 14 (5_100_000..), distinct per org. */
const CREATED_DRAFT_ID_BASE = 5_200_000

function minorOf(raw: unknown): number | null {
  const amount =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).amount : (raw as unknown)
  const n = Number(amount)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null
}

/**
 * `draftOrderCreate`: a quote in the org's store. What a shop-linked invoicing
 * profile makes for every quote it issues, so the demo's quotes work end to end.
 * A line names a catalog variant (its list price unless one is given) or is a
 * custom line (title and price). Refuses what Shopify refuses: no lines, an
 * unknown variant, a custom line without a title or price.
 */
const draftOrderCreate: WriteHandler = (ctx) => {
  const book = demoShopifyBook()
  const input = (ctx.variables.input ?? {}) as Record<string, unknown>
  const rawLines = Array.isArray(input.lineItems)
    ? (input.lineItems as Array<Record<string, unknown>>)
    : []
  if (rawLines.length === 0) {
    return {
      draftOrder: null,
      userErrors: [userError("Add at least 1 product", ["input", "lineItems"])],
    }
  }
  const created = createdDraftsFor(ctx.orgId)
  const numericId = CREATED_DRAFT_ID_BASE + created.length
  const id = `gid://shopify/DraftOrder/${numericId}`
  const lineItems: DemoLineItem[] = []
  for (const [index, line] of rawLines.entries()) {
    const quantity = Math.trunc(Number(line?.quantity ?? 1))
    const field = ["input", "lineItems", String(index)]
    if (!Number.isFinite(quantity) || quantity < 1) {
      return { draftOrder: null, userErrors: [userError("Quantity must be at least 1", field)] }
    }
    const price = minorOf(line.originalUnitPriceWithCurrency ?? line.originalUnitPrice)
    const variant =
      typeof line.variantId === "string" ? book.variantsById.get(line.variantId) : undefined
    if (typeof line.variantId === "string" && !variant) {
      return { draftOrder: null, userErrors: [userError("Variant does not exist", field)] }
    }
    const title = typeof line.title === "string" ? line.title.trim() : ""
    if (!variant && (title === "" || price === null)) {
      return {
        draftOrder: null,
        userErrors: [userError("A custom line needs a title and a price", field)],
      }
    }
    lineItems.push({
      id: `gid://shopify/DraftOrderLineItem/${numericId}${String(index + 1).padStart(2, "0")}`,
      title: variant ? variant.displayName : title,
      sku: variant?.sku ?? (typeof line.sku === "string" ? line.sku : ""),
      quantity,
      unitMinor: price ?? variant?.priceMinor ?? 0,
      variantId: variant?.id ?? "",
      productId: variant?.productId ?? "",
    })
  }
  const purchasing = (input.purchasingEntity ?? {}) as Record<string, unknown>
  const customer =
    typeof purchasing.customerId === "string"
      ? book.customersById.get(purchasing.customerId)
      : undefined
  const shipping = (input.shippingLine ?? {}) as Record<string, unknown>
  const shippingMinor = minorOf(shipping.priceWithCurrency ?? shipping.price) ?? 0
  const subtotalMinor = lineItems.reduce((sum, li) => sum + li.unitMinor * li.quantity, 0)
  const at = writeTime().toISOString()
  const draft: DemoDraftOrder = {
    id,
    numericId,
    name: `D${200 + created.length}`,
    status: "OPEN",
    tags: tagStrings(input.tags),
    createdAt: at,
    updatedAt: at,
    customerId: customer?.id ?? "",
    email: typeof input.email === "string" ? input.email : (customer?.email ?? ""),
    note: typeof input.note === "string" ? input.note : null,
    lineItems,
    shippingTitle: typeof shipping.title === "string" ? shipping.title : "Free shipping",
    shippingMinor,
    subtotalMinor,
    totalMinor: subtotalMinor + shippingMinor,
    orderId: null,
    orderName: null,
  }
  addCreatedDraft(ctx.orgId, draft)
  return {
    draftOrder: {
      id,
      name: draft.name,
      status: draft.status,
      poNumber: typeof input.poNumber === "string" ? input.poNumber : null,
      totalPriceSet: {
        presentmentMoney: { amount: money(draft.totalMinor), currencyCode: "EUR" },
        shopMoney: { amount: money(draft.totalMinor), currencyCode: "EUR" },
      },
    },
    userErrors: [],
  }
}

const draftOrderComplete: WriteHandler = (ctx) => {
  const draft = findDraft(ctx.orgId, ctx.variables.id)
  if (!draft) {
    return {
      draftOrder: null,
      userErrors: [userError("quote not found in the demo store", ["id"])],
    }
  }
  const current = withDraftPatch(ctx.orgId, draft)
  if (current.status === "COMPLETED") {
    return {
      draftOrder: null,
      userErrors: [userError("this quote has already been turned into an order", ["id"])],
    }
  }
  // Completing a quote in the demo links it to an order NUMBER the store does
  // not otherwise hand out, so a completed quote never collides with a fixture
  // order and the link is legible as "this came from that quote".
  // A quote this org created counts on from 1000, past every book quote.
  const seq =
    draft.numericId >= CREATED_DRAFT_ID_BASE
      ? 1000 + draft.numericId - CREATED_DRAFT_ID_BASE
      : draft.numericId - 5_100_000
  const orderName = `#${9000 + seq}`
  const orderId = `gid://shopify/Order/${6_900_000 + seq}`
  const patch = draftPatch(ctx.orgId, draft.id)
  patch.status = "COMPLETED"
  patch.orderId = orderId
  patch.orderName = orderName
  return {
    draftOrder: {
      id: draft.id,
      name: draft.name,
      status: "COMPLETED",
      poNumber: null,
      order: { id: orderId, name: orderName, poNumber: null },
    },
    userErrors: [],
  }
}

const fulfillmentTrackingUpdate: WriteHandler = (ctx) => {
  const id = String(ctx.variables.fulfillmentId ?? "")
  const info = (ctx.variables.trackingInfoInput ?? {}) as Record<string, unknown>
  for (const order of demoShopifyBook().orders) {
    const patched = withOrderPatch(ctx.orgId, order)
    const existing = patched.fulfillments.find((f) => f.id === id)
    if (!existing) continue
    const patch = orderPatch(ctx.orgId, order.id)
    const updated: DemoFulfillment = {
      ...existing,
      carrier: String(info.company ?? existing.carrier),
      trackingNumber: String(info.number ?? existing.trackingNumber),
      trackingUrl: String(info.url ?? existing.trackingUrl),
    }
    patch.addedFulfillments = [
      ...(patch.addedFulfillments ?? []).filter((f) => f.id !== id),
      updated,
    ]
    return {
      fulfillment: {
        id: updated.id,
        status: updated.status,
        trackingInfo: [
          { number: updated.trackingNumber, url: updated.trackingUrl, company: updated.carrier },
        ],
      },
      userErrors: [],
    }
  }
  return {
    fulfillment: null,
    userErrors: [userError("fulfillment not found in the demo store", ["fulfillmentId"])],
  }
}

/** Numeric part of a created discount's gid: Shopify-sized, distinct per org. */
const DISCOUNT_ID_BASE = 1_290_000_000_000

function isoOrNull(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null
  const at = Date.parse(raw)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

/**
 * `discountCodeBasicCreate`. Takes the input the bundled app's canonicaliser
 * produced and records the code in the org's overlay, so `discounts_search`
 * lists it next. Refuses what Shopify refuses: no code, no title, a code this
 * store already has.
 */
const discountCodeBasicCreate: WriteHandler = (ctx) => {
  const input = (ctx.variables.basicCodeDiscount ?? {}) as Record<string, unknown>
  const code = typeof input.code === "string" ? input.code.trim() : ""
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (code === "") {
    return {
      codeDiscountNode: null,
      userErrors: [userError("Code can't be blank", ["basicCodeDiscount", "code"])],
    }
  }
  if (title === "") {
    return {
      codeDiscountNode: null,
      userErrors: [userError("Title can't be blank", ["basicCodeDiscount", "title"])],
    }
  }
  const existing = discountsFor(ctx.orgId)
  if (orgCodes(ctx.orgId).has(code.toLowerCase())) {
    return {
      codeDiscountNode: null,
      userErrors: [userError("Code must be unique.", ["basicCodeDiscount", "code"])],
    }
  }
  const startsAt = isoOrNull(input.startsAt) ?? writeTime().toISOString()
  const endsAt = isoOrNull(input.endsAt)
  if (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    return {
      codeDiscountNode: null,
      userErrors: [userError("Ends at must be after starts at", ["basicCodeDiscount", "endsAt"])],
    }
  }
  const gets = (input.customerGets ?? {}) as Record<string, unknown>
  const value = (gets.value ?? {}) as Record<string, unknown>
  const percentage = typeof value.percentage === "number" ? value.percentage : null
  const amount = (value.discountAmount ?? {}) as Record<string, unknown>
  const amountNumber = Number(amount.amount)
  const usageLimit = Number(input.usageLimit)
  const discount: DemoCreatedDiscount = {
    id: `gid://shopify/DiscountCodeNode/${DISCOUNT_ID_BASE + existing.length + 1}`,
    title,
    code,
    extraCodes: [],
    startsAt,
    endsAt,
    createdAt: writeTime().toISOString(),
    usageLimit: Number.isInteger(usageLimit) && usageLimit > 0 ? usageLimit : null,
    appliesOncePerCustomer: input.appliesOncePerCustomer === true,
    percentage,
    amountMinor:
      percentage === null && Number.isFinite(amountNumber) ? Math.round(amountNumber * 100) : null,
  }
  addDiscount(ctx.orgId, discount)
  return { codeDiscountNode: demoDiscountNode(discount), userErrors: [] }
}

/** Every redeem code this org's discounts carry, lowercased: Shopify codes are case-insensitive. */
function orgCodes(orgId: string): Set<string> {
  const codes = new Set<string>()
  for (const discount of discountsFor(orgId)) {
    for (const code of demoDiscountCodes(discount)) codes.add(code.toLowerCase())
  }
  return codes
}

/** Shopify's own per-call limit on `discountRedeemCodeBulkAdd`. */
const BULK_ADD_MAX = 250

/**
 * `discountRedeemCodeBulkAdd`. Shopify runs it as an async job; the demo runs
 * it at once and records the finished job, so the first status poll reads it
 * done. A code this org already has (any discount, any case) or one repeated in
 * the batch is not imported and counts in `failedCount`, as on a real store.
 */
const discountRedeemCodeBulkAdd: WriteHandler = (ctx) => {
  const discount = discountsFor(ctx.orgId).find((d) => d.id === ctx.variables.discountId)
  if (!discount) {
    return {
      bulkCreation: null,
      userErrors: [userError("Discount does not exist", ["discountId"])],
    }
  }
  const requested = Array.isArray(ctx.variables.codes)
    ? (ctx.variables.codes as Array<Record<string, unknown>>).map((entry) =>
        typeof entry?.code === "string" ? entry.code.trim() : "",
      )
    : []
  if (requested.length === 0 || requested.length > BULK_ADD_MAX) {
    return {
      bulkCreation: null,
      userErrors: [userError(`Codes must hold 1 to ${BULK_ADD_MAX} codes`, ["codes"])],
    }
  }
  const seen = orgCodes(ctx.orgId)
  const imported: string[] = []
  for (const code of requested) {
    const key = code.toLowerCase()
    if (code === "" || seen.has(key)) continue
    seen.add(key)
    imported.push(code)
  }
  const job = {
    id: `gid://shopify/DiscountRedeemCodeBulkCreation/${DISCOUNT_ID_BASE + bulkCodeJobCount(ctx.orgId) + 1}`,
    discountId: discount.id,
    codesCount: requested.length,
    importedCount: imported.length,
    failedCount: requested.length - imported.length,
  }
  addBulkCodes(ctx.orgId, discount, imported, job)
  return { bulkCreation: { id: job.id }, userErrors: [] }
}

const WRITE_HANDLERS: Record<string, WriteHandler> = {
  TagsAdd: (ctx) => applyTags(ctx, true),
  TagsRemove: (ctx) => applyTags(ctx, false),
  OrderNoteSet: orderUpdate,
  OrderUpdate: orderUpdate,
  OrderCancel: orderCancel,
  FulfillmentCreateV2: fulfillmentCreate,
  FulfillmentTrackingInfoUpdate: fulfillmentTrackingUpdate,
  RefundCreate: refundCreate,
  DraftOrderCreate: draftOrderCreate,
  DraftOrderComplete: draftOrderComplete,
  DiscountCodeBasicCreate: discountCodeBasicCreate,
  DiscountRedeemCodeBulkAdd: discountRedeemCodeBulkAdd,
}

/** The GraphQL field each modelled mutation answers under. */
const WRITE_FIELD: Record<string, string> = {
  TagsAdd: "tagsAdd",
  TagsRemove: "tagsRemove",
  OrderNoteSet: "orderUpdate",
  OrderUpdate: "orderUpdate",
  OrderCancel: "orderCancel",
  FulfillmentCreateV2: "fulfillmentCreateV2",
  FulfillmentTrackingInfoUpdate: "fulfillmentTrackingInfoUpdateV2",
  RefundCreate: "refundCreate",
  DraftOrderCreate: "draftOrderCreate",
  DraftOrderComplete: "draftOrderComplete",
  DiscountCodeBasicCreate: "discountCodeBasicCreate",
  DiscountRedeemCodeBulkAdd: "discountRedeemCodeBulkAdd",
}

/** Run a modelled mutation, or return undefined when the demo does not model it. */
export function demoShopifyWrite(
  operation: string,
  ctx: WriteContext,
): Record<string, unknown> | undefined {
  const handler = WRITE_HANDLERS[operation]
  const field = WRITE_FIELD[operation]
  if (!handler || !field) return undefined
  try {
    return { [field]: handler(ctx) }
  } catch (err) {
    if (err instanceof DemoOverlayFullError) {
      return { [field]: { userErrors: [userError(ctx.refusal)] } }
    }
    throw err
  }
}

/** Every mutation the demo store performs. Pinned by the coverage test. */
export function demoShopifyWriteOperations(): string[] {
  return Object.keys(WRITE_HANDLERS).sort()
}
