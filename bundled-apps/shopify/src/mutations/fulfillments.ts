// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: fulfillments (create, tracking update, cancel) and the
// tracking and partial-line normalisation they share.

import type { AppContext } from "@liaison/app-sdk"
import {
  type CustomerNotification,
  ORDER_B2B_SIGNALS_SELECTION,
  type OrderB2bSignals,
  decideCustomerNotification,
  trackingNumbersOf,
} from "../lib/b2b"
import { getShopifyClient } from "../lib/get-client"
import {
  type PreflightResult,
  makeMutationError,
  preflightRefusal,
  runMutation,
  requireTargetId,
  readGatedTarget,
  assertTargetState,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Fulfillments
// ─────────────────────────────────────────────────────────────────────────

const FULFILLMENT_CREATE = `
  mutation FulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { number url company } }
      userErrors { field message }
    }
  }
`

// Shopify's `FulfillmentTrackingInput` has EXACTLY these fields: `company`, `number`, `numbers`, `url`,
// `urls`. But the natural word for the shipping company is "carrier" (it's what Boxtal/the manifest use),
// and an agent reliably passes `trackingInfo: { carrier, trackingNumber, trackingUrl }` — none of which are
// valid Shopify field names, so `fulfillmentCreateV2` 422s ("Field is not defined on FulfillmentTrackingInput
// … trackingInfo.carrier") and the GATED action EXECUTES-to-error → verdict-override non-green. This is the
// SAME "normalize weak-model mistakes at the handler" pattern as refunds_create's line-item re-resolution:
// we map the natural-but-wrong aliases onto the real schema and DROP unknown keys, so the write succeeds.
// An already-correct `{ company, number, url }` passes through unchanged. Returns undefined for an
// empty/absent input so callers can spread it conditionally.
const TRACKING_FIELD_ALIASES: Record<string, "company" | "number" | "numbers" | "url" | "urls"> = {
  company: "company",
  carrier: "company",
  carrierName: "company",
  number: "number",
  trackingNumber: "number",
  tracking_number: "number",
  numbers: "numbers",
  trackingNumbers: "numbers",
  url: "url",
  trackingUrl: "url",
  tracking_url: "url",
  urls: "urls",
  trackingUrls: "urls",
}

// Placeholder/sentinel strings a weak model emits when it has NO real tracking yet (it is staging a
// shipment, not reporting a delivered one). Forwarding any of these 422s `fulfillmentCreateV2`: a `url`
// of "N/A" fails Shopify's URL validation ("Invalid url 'N/A', missing scheme") and a bare "N/A" number
// is meaningless. We treat them as "no value" and DROP them — the fulfillment is created without tracking
// (the correct outcome when the operator has not bought a label yet) instead of executing-to-error and
// forcing the gated action non-green. Matches the handler's existing "normalize weak-model mistakes"
// contract (alias-map + drop-unknown-keys). Case/space-insensitive.
const TRACKING_PLACEHOLDER_VALUES = new Set([
  "",
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "tbd",
  "tba",
  "unknown",
  "pending",
  "-",
  // copy-lint: exempt sentinel list of junk tracking values a model may pass, matched literally
  "—",
])

function isTrackingPlaceholder(value: unknown): boolean {
  return typeof value === "string" && TRACKING_PLACEHOLDER_VALUES.has(value.trim().toLowerCase())
}

// A tracking `url` MUST be an absolute http(s) URL — Shopify rejects anything without a scheme. A weak
// model often passes a bare placeholder or a host-only string; drop it rather than 422 the whole write.
function isValidTrackingUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const u = new URL(value.trim())
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

export function normalizeTrackingInfo(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined
  const src = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(src)) {
    if (value === undefined || value === null) continue
    const canonical = TRACKING_FIELD_ALIASES[key]
    if (!canonical) continue // DROP unknown keys (the 422 trap) rather than forward them to Shopify
    // First writer for a canonical field wins (don't let `carrier` clobber an explicit `company`); for the
    // array fields (numbers/urls) coerce a lone string into a single-element array.
    if (out[canonical] !== undefined) continue
    // DROP placeholder/sentinel scalars ("N/A", "", "none", …) — they are not real tracking data and a
    // url placeholder 422s the write. Also drop a url that is not a real absolute http(s) URL.
    if ((canonical === "url" || canonical === "company" || canonical === "number") && isTrackingPlaceholder(value)) {
      continue
    }
    if (canonical === "url" && !isValidTrackingUrl(value)) continue
    if ((canonical === "numbers" || canonical === "urls") && typeof value === "string") {
      // Single-string array form — same placeholder/url validation before wrapping.
      if (isTrackingPlaceholder(value)) continue
      if (canonical === "urls" && !isValidTrackingUrl(value)) continue
      out[canonical] = [value]
    } else if (Array.isArray(value)) {
      // Filter placeholders / invalid urls out of an array; drop the field entirely if nothing survives.
      const cleaned = value.filter((v) => {
        if (isTrackingPlaceholder(v)) return false
        if (canonical === "urls" && !isValidTrackingUrl(v)) return false
        return true
      })
      if (cleaned.length > 0) out[canonical] = cleaned
    } else {
      out[canonical] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The gid prefix Shopify's GraphQL `Order` node is addressed by. */
const ORDER_GID_PREFIX = "gid://shopify/Order/"

/**
 * Normalize an order reference into the gid form the GraphQL `order(id: ID!)` lookup resolves.
 *
 * Callers legitimately HOLD the bare numeric id: that is the shape Shopify's REST webhooks deliver
 * and the shape it is persisted in (invoicing's `documents.shopify_order_id`, boxtal's `prep_meta`).
 * Handing that numeric id straight to `ID!` is rejected outright by Shopify with "Variable $id of
 * type ID! was provided invalid value", which took down auto fulfillment in prod for every parcel:
 * the caller's log-and-continue swallowed it, so the only symptom was a shipped parcel whose order
 * stayed unfulfilled and a customer who never got a tracking mail. Normalizing here, at the one
 * place every fulfillment path funnels through, means no caller can rediscover the trap.
 *
 * A bare run of digits is wrapped; anything already in gid form (or any shape we do not recognize)
 * passes through untouched, so a future reference style is not mangled.
 */
function toOrderGid(ref: string): string {
  return /^\d+$/.test(ref) ? `${ORDER_GID_PREFIX}${ref}` : ref
}

// `fulfillmentCreateV2` requires `lineItemsByFulfillmentOrder` (built from the order's OPEN fulfillment
// orders), NOT an `orderId` — but an agent (and a human) naturally think "fulfill THIS ORDER" and pass an
// orderId. Resolve the order's open fulfillment orders here so the caller doesn't need to know the
// fulfillmentOrder indirection; an explicit `lineItemsByFulfillmentOrder` is still honored verbatim.
const ORDER_FULFILLMENT_ORDERS = `
  query OrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      ${ORDER_B2B_SIGNALS_SELECTION}
      fulfillmentOrders(first: 25, query: "status:open") { nodes { id status } }
    }
  }
`

// The partial-fulfillment resolver needs the FO LINE ITEMS too (ids + remaining quantities), not just
// the FO ids — a separate, richer query so the wholesale path keeps its lean one.
const ORDER_FULFILLMENT_ORDERS_WITH_LINES = `
  query OrderFulfillmentOrdersWithLines($id: ID!) {
    order(id: $id) {
      id
      ${ORDER_B2B_SIGNALS_SELECTION}
      fulfillmentOrders(first: 25, query: "status:open") {
        nodes {
          id status
          lineItems(first: 100) {
            nodes {
              id remainingQuantity
              lineItem { id sku }
            }
          }
        }
      }
    }
  }
`

interface RequestedFulfillmentLine {
  sku?: unknown
  orderLineItemId?: unknown
  quantity?: unknown
}

interface OpenFoWithLines {
  id: string
  lineItems?: {
    nodes?: Array<{
      id: string
      remainingQuantity?: number | null
      lineItem?: { id?: string | null; sku?: string | null } | null
    }>
  }
}

// Map friendly `lineItems` ({sku|orderLineItemId, quantity}) onto Shopify's
// lineItemsByFulfillmentOrder, splitting a line's quantity across fulfillment orders when needed.
// Strict: unknown sku, ambiguous sku, or over-remaining quantity all THROW — no partial guessing.
function buildPartialLineItemsByFulfillmentOrder(
  requested: RequestedFulfillmentLine[],
  openFOs: OpenFoWithLines[],
): Array<{ fulfillmentOrderId: string; fulfillmentOrderLineItems: Array<{ id: string; quantity: number }> }> {
  // Flatten every open FO line once, preserving FO order for deterministic splitting.
  const foLines = openFOs.flatMap((fo) =>
    (fo.lineItems?.nodes ?? []).map((li) => ({
      foId: fo.id,
      foLineItemId: li.id,
      remaining: typeof li.remainingQuantity === "number" ? li.remainingQuantity : 0,
      orderLineItemId: li.lineItem?.id ?? null,
      sku: li.lineItem?.sku ?? null,
    })),
  )
  // fo id -> accumulated {id, quantity} entries
  const perFo = new Map<string, Array<{ id: string; quantity: number }>>()
  for (const line of requested) {
    const quantity = line.quantity
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
      throw makeMutationError("BAD_PARAM", "Each lineItems entry needs a positive integer `quantity`.")
    }
    const sku = typeof line.sku === "string" && line.sku.length > 0 ? line.sku : null
    const orderLineItemId =
      typeof line.orderLineItemId === "string" && line.orderLineItemId.length > 0 ? line.orderLineItemId : null
    if (!sku && !orderLineItemId) {
      throw makeMutationError("BAD_PARAM", "Each lineItems entry needs a `sku` or an `orderLineItemId`.")
    }
    let matches: typeof foLines
    if (orderLineItemId) {
      matches = foLines.filter((l) => l.orderLineItemId === orderLineItemId)
      if (matches.length === 0) {
        throw makeMutationError(
          "LINE_ITEM_NOT_FOUND",
          `Order line item ${orderLineItemId} does not match any open fulfillment order line item on this order. Call fulfillment_orders_get to see what is still fulfillable.`,
        )
      }
    } else {
      matches = foLines.filter((l) => l.sku === sku)
      if (matches.length === 0) {
        throw makeMutationError(
          "SKU_NOT_FOUND",
          `SKU ${sku} does not match any open fulfillment order line item on this order. Call fulfillment_orders_get to see what is still fulfillable.`,
        )
      }
      const distinctOrderLines = new Set(matches.map((l) => l.orderLineItemId ?? l.foLineItemId))
      if (distinctOrderLines.size > 1) {
        throw makeMutationError(
          "SKU_AMBIGUOUS",
          `SKU ${sku} matches ${distinctOrderLines.size} different order line items on this order. Pass an explicit orderLineItemId instead (see fulfillment_orders_get).`,
        )
      }
    }
    const remainingTotal = matches.reduce((sum, l) => sum + l.remaining, 0)
    if (quantity > remainingTotal) {
      const label = sku ?? orderLineItemId
      throw makeMutationError(
        "QUANTITY_EXCEEDS_REMAINING",
        `Requested quantity ${quantity} for ${label} exceeds the remaining unfulfilled quantity (${remainingTotal}).`,
      )
    }
    // Greedy split across FOs in order.
    let toAllocate = quantity
    for (const match of matches) {
      if (toAllocate <= 0) break
      if (match.remaining <= 0) continue
      const take = Math.min(match.remaining, toAllocate)
      toAllocate -= take
      const bucket = perFo.get(match.foId) ?? []
      bucket.push({ id: match.foLineItemId, quantity: take })
      perFo.set(match.foId, bucket)
    }
  }
  // Emit in the order the FOs were returned by Shopify.
  return openFOs
    .filter((fo) => perFo.has(fo.id))
    .map((fo) => ({ fulfillmentOrderId: fo.id, fulfillmentOrderLineItems: perFo.get(fo.id) ?? [] }))
}

// ─────────────────────────────────────────────────────────────────────────
//  Customer shipping email: the org's policy decides (lib/b2b.ts)
// ─────────────────────────────────────────────────────────────────────────

const FULFILLMENT_ORDER_B2B_SIGNALS = `
  query FulfillmentOrderB2bSignals($id: ID!) {
    fulfillmentOrder(id: $id) { id order { id ${ORDER_B2B_SIGNALS_SELECTION} } }
  }
`

const FULFILLMENT_B2B_SIGNALS = `
  query FulfillmentB2bSignals($id: ID!) {
    fulfillment(id: $id) { id trackingInfo { number } order { id ${ORDER_B2B_SIGNALS_SELECTION} } }
  }
`

/** Anything but an absent or explicit false asks Shopify to email the customer. */
function asksToNotify(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false
}

async function orderOfFulfillmentOrder(ctx: AppContext, entry: unknown): Promise<OrderB2bSignals | null> {
  const id = entry && typeof entry === "object" ? (entry as { fulfillmentOrderId?: unknown }).fulfillmentOrderId : undefined
  if (typeof id !== "string" || id.length === 0) return null
  const client = await getShopifyClient(ctx)
  const data = await client.query<{ fulfillmentOrder?: { order?: OrderB2bSignals | null } | null }>(
    FULFILLMENT_ORDER_B2B_SIGNALS,
    { id },
  )
  return data.fulfillmentOrder?.order ?? null
}

interface FulfillmentWithOrder {
  trackingInfo?: Array<{ number?: string | null } | null> | null
  order?: OrderB2bSignals | null
}

async function fulfillmentWithOrder(ctx: AppContext, fulfillmentId: unknown): Promise<FulfillmentWithOrder | null> {
  if (typeof fulfillmentId !== "string" || fulfillmentId.length === 0) return null
  const client = await getShopifyClient(ctx)
  const data = await client.query<{ fulfillment?: FulfillmentWithOrder | null }>(FULFILLMENT_B2B_SIGNALS, {
    id: fulfillmentId,
  })
  return data.fulfillment ?? null
}

/** runMutation options that put the policy's decision on the tool result. */
function notificationNotice(
  notice: CustomerNotification | null,
): { transformNode?: (node: Record<string, unknown>) => Record<string, unknown> } {
  if (!notice) return {}
  return { transformNode: (node) => ({ ...node, customerNotification: notice }) }
}

/**
 * Build the Shopify `FulfillmentV2Input` a fulfillments_create call resolves to. READ ONLY: it only
 * reads the order's open fulfillment orders. Shared by the handler and its stage-time preflight so the
 * "no OPEN fulfillment orders" / missing-orderId refusals can never drift between the two.
 */
async function buildFulfillmentInput(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{
  fulfillment: Record<string, unknown>
  /** The order's B2B signals when the build already read them (the orderId paths). */
  order: OrderB2bSignals | null | undefined
}> {
  const provided = ((params.fulfillment ?? params) ?? {}) as Record<string, unknown>
  const preBuilt = provided.lineItemsByFulfillmentOrder
  const requestedLines = (provided.lineItems ?? params.lineItems) as unknown
  let fulfillment: Record<string, unknown>
  let order: OrderB2bSignals | null | undefined
  if (Array.isArray(preBuilt) && preBuilt.length > 0) {
    // Caller already supplied the Shopify-shaped lineItemsByFulfillmentOrder — pass through, but STILL
    // normalize trackingInfo (a `carrier`/`trackingNumber` alias here 422s the same as in the resolved
    // path).
    const normalizedTracking = normalizeTrackingInfo(provided.trackingInfo)
    fulfillment = {
      ...provided,
      ...(normalizedTracking ? { trackingInfo: normalizedTracking } : {}),
    }
    if (provided.trackingInfo !== undefined && !normalizedTracking) delete fulfillment.trackingInfo
  } else if (Array.isArray(requestedLines) && requestedLines.length > 0) {
    // Truthful PARTIAL fulfillment: friendly `lineItems` ({sku|orderLineItemId, quantity}) resolved
    // against the order's open fulfillment orders — only the named quantities ship, the rest stays
    // unfulfilled on Shopify.
    const orderId = provided.orderId ?? params.orderId
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw makeMutationError("BAD_PARAM", "Provide `orderId` alongside `lineItems` for a partial fulfillment.")
    }
    const client = await getShopifyClient(ctx)
    const data = await client.query<{
      order?: ({ fulfillmentOrders?: { nodes?: OpenFoWithLines[] } } & OrderB2bSignals) | null
    }>(ORDER_FULFILLMENT_ORDERS_WITH_LINES, { id: toOrderGid(orderId) })
    order = data.order
    const openFOs = (data.order?.fulfillmentOrders?.nodes ?? []).filter((n) => n?.id)
    if (openFOs.length === 0) {
      throw makeMutationError(
        "NO_FULFILLABLE_ITEMS",
        "Order has no OPEN fulfillment orders to fulfill (already fulfilled, cancelled, or not found).",
      )
    }
    const lineItemsByFulfillmentOrder = buildPartialLineItemsByFulfillmentOrder(
      requestedLines as RequestedFulfillmentLine[],
      openFOs,
    )
    const normalizedTracking = normalizeTrackingInfo(provided.trackingInfo)
    fulfillment = {
      lineItemsByFulfillmentOrder,
      ...(normalizedTracking ? { trackingInfo: normalizedTracking } : {}),
      ...(provided.notifyCustomer !== undefined ? { notifyCustomer: provided.notifyCustomer } : {}),
    }
  } else {
    // Resolve from an orderId (the param a caller actually has). Accept it on either the `fulfillment`
    // object or the top-level params.
    const orderId = provided.orderId ?? params.orderId
    if (typeof orderId !== "string" || orderId.length === 0) {
      throw makeMutationError(
        "BAD_PARAM",
        "Provide `orderId` (to fulfill all open line items) or `fulfillment.lineItemsByFulfillmentOrder`.",
      )
    }
    const client = await getShopifyClient(ctx)
    const data = await client.query<{
      order?:
        | ({ fulfillmentOrders?: { nodes?: Array<{ id: string; status?: string | null }> } } & OrderB2bSignals)
        | null
    }>(ORDER_FULFILLMENT_ORDERS, { id: toOrderGid(orderId) })
    order = data.order
    const openFulfillmentOrders = (data.order?.fulfillmentOrders?.nodes ?? []).filter((n) => n?.id)
    if (openFulfillmentOrders.length === 0) {
      throw makeMutationError(
        "NO_FULFILLABLE_ITEMS",
        "Order has no OPEN fulfillment orders to fulfill (already fulfilled, cancelled, or not found).",
      )
    }
    const normalizedTracking = normalizeTrackingInfo(provided.trackingInfo)
    fulfillment = {
      lineItemsByFulfillmentOrder: openFulfillmentOrders.map((fo) => ({ fulfillmentOrderId: fo.id })),
      ...(normalizedTracking ? { trackingInfo: normalizedTracking } : {}),
      ...(provided.notifyCustomer !== undefined ? { notifyCustomer: provided.notifyCustomer } : {}),
    }
  }
  return { fulfillment, order }
}

/**
 * STAGE-TIME preflight for the gated `fulfillments_create` (manifest `preflight`). A gated call must
 * not be parked for a human when the data it needs is missing: no orderId and no prebuilt
 * lineItemsByFulfillmentOrder, or an order with nothing open to fulfill. The handler keeps its own
 * copy of these guards, because an order CAN legitimately be fulfilled or cancelled between staging
 * and the approve: this is an early refusal, not a replacement.
 */
export async function fulfillments_create_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    await buildFulfillmentInput(params, ctx)
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function fulfillments_create(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const { fulfillment, order } = await buildFulfillmentInput(params, ctx)
  // Whether Shopify emails the customer is the org's policy, decided here for every path (an
  // agent, an approval card, Boxtal's packed tick and carrier scan): the tracking rides on this
  // same create, so the email carries it.
  const preBuilt = fulfillment.lineItemsByFulfillmentOrder
  const decision = await decideCustomerNotification({
    readConfig: (key) => ctx.config.get(key),
    callerAsksToNotify: asksToNotify(fulfillment.notifyCustomer),
    loadOrder: async () =>
      order !== undefined ? order : Array.isArray(preBuilt) ? orderOfFulfillmentOrder(ctx, preBuilt[0]) : null,
    // The one shipping email goes out with the first tracking number: a create without one sends none.
    tracking: async () => ({
      write: "create",
      hasNumber: trackingNumbersOf(normalizeTrackingInfo(fulfillment.trackingInfo)).length > 0,
    }),
  })
  if (decision.notify !== undefined) fulfillment.notifyCustomer = decision.notify
  return runMutation(ctx, {
    query: FULFILLMENT_CREATE,
    variables: { fulfillment },
    dataKey: "fulfillmentCreateV2",
    eventEntity: "fulfillment",
    eventAction: "created",
    entityIdPath: "fulfillment.id",
    ...notificationNotice(decision.notice),
  })
}

const FULFILLMENT_TRACKING_UPDATE = `
  mutation FulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
    fulfillmentTrackingInfoUpdateV2(fulfillmentId: $fulfillmentId, trackingInfoInput: $trackingInfoInput, notifyCustomer: $notifyCustomer) {
      fulfillment { id status trackingInfo { number url company } }
      userErrors { field message }
    }
  }
`

/**
 * §3.2 / §3.3 — update a fulfillment's tracking info (number, carrier, URL).
 * Gated: it can trigger a customer shipping-update email.
 */
export async function fulfillments_update_tracking(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  if (!params.fulfillmentId) throw makeMutationError("BAD_PARAM", "fulfillmentId is required")
  if (!params.trackingInfoInput || typeof params.trackingInfoInput !== "object") {
    throw makeMutationError("BAD_PARAM", "trackingInfoInput is required")
  }
  // Normalize the `carrier`/`trackingNumber` aliases onto the real FulfillmentTrackingInput shape (same
  // 422 trap as fulfillments_create — see normalizeTrackingInfo).
  const trackingInfoInput = normalizeTrackingInfo(params.trackingInfoInput)
  if (!trackingInfoInput) {
    throw makeMutationError(
      "BAD_PARAM",
      "trackingInfoInput has no recognized fields (use company/number/url, or the carrier/trackingNumber/trackingUrl aliases).",
    )
  }
  const callerNotify = params.notifyCustomer ?? false
  // The same policy as a fulfilment create, and the same one email per fulfilment: only the update
  // that gives an untracked fulfilment its first number emails. One read of the fulfilment serves
  // both the order's B2B signals and its current tracking, and happens only when a fact needs it.
  let current: Promise<FulfillmentWithOrder | null> | null = null
  const readCurrent = () => {
    current ??= fulfillmentWithOrder(ctx, params.fulfillmentId)
    return current
  }
  const setsNumber = trackingNumbersOf(trackingInfoInput).length > 0
  const applied = await decideCustomerNotification({
    readConfig: (key) => ctx.config.get(key),
    callerAsksToNotify: asksToNotify(callerNotify),
    loadOrder: async () => (await readCurrent())?.order ?? null,
    tracking: async () => {
      if (!setsNumber) return { write: "update", setsNumber, hadNumber: false }
      const fulfillment = await readCurrent()
      return {
        write: "update",
        setsNumber,
        hadNumber: fulfillment ? trackingNumbersOf({ numbers: (fulfillment.trackingInfo ?? []).map((t) => t?.number) }).length > 0 : null,
      }
    },
  })
  return runMutation(ctx, {
    query: FULFILLMENT_TRACKING_UPDATE,
    variables: {
      fulfillmentId: params.fulfillmentId,
      trackingInfoInput,
      notifyCustomer: applied.notify ?? callerNotify,
    },
    dataKey: "fulfillmentTrackingInfoUpdateV2",
    eventEntity: "fulfillment",
    eventAction: "tracking_updated",
    entityIdPath: "fulfillment.id",
    ...notificationNotice(applied.notice),
  })
}

const FULFILLMENT_CANCEL = `
  mutation FulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment { id status }
      userErrors { field message }
    }
  }
`

// A fulfillment that is already CANCELLED cannot be cancelled again, and Shopify says so only after
// the approve. The status is knowable at staging. SUCCESS and the in-flight states stay cancellable.
const FULFILLMENT_STATES_CANCELLABLE = ["OPEN", "PENDING", "SUCCESS", "ERROR", "FAILURE"] as const

/**
 * STAGE-TIME preflight for the gated `fulfillments_cancel` (manifest `preflight`). Cancelling a
 * fulfillment notifies the customer and unwinds the shipment, so an id that resolves to nothing, or
 * to a fulfillment already cancelled, must not reach the approval card. A fulfillment cancelled by
 * someone else between staging and the approve is a genuine race and stays with the handler.
 */
export async function fulfillments_cancel_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = requireTargetId(params, "id")
    const node = await readGatedTarget(ctx, id, "Fulfillment", "fulfillments_cancel")
    assertTargetState(node, FULFILLMENT_STATES_CANCELLABLE, "fulfillments_cancel", "fulfillment", "cancelled")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function fulfillments_cancel(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  if (!params.id) throw makeMutationError("BAD_PARAM", "id is required")
  return runMutation(ctx, {
    query: FULFILLMENT_CANCEL,
    variables: { id: params.id },
    dataKey: "fulfillmentCancel",
    eventEntity: "fulfillment",
    eventAction: "cancelled",
    entityIdPath: "fulfillment.id",
  })
}
