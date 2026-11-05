// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's customer shipping email policy, and the B2B order recognition it needs. Every fulfilment
// path (an agent's call, an approval card, Boxtal's packed tick or carrier scan) funnels through
// the fulfilment handlers, which decide Shopify's `notifyCustomer` HERE, server side:
//
//   customerShippingEmail   who gets Shopify's shipping (and tracking-update) email
//   (unset) / "caller"      the caller's own flag (Shopify's default is no email)
//   "retail_only"           retail (consumer) orders only, whatever the caller passed; a B2B
//                           buyer never gets it
//   "all"                   every order
//   "none"                  no order
//
// An order is B2B when its purchasing entity is a Shopify B2B company, or when a line item's sku
// ends with one of the org's `b2bSkuSuffixes` (comma separated, case-insensitive). Under
// "retail_only" a fact that cannot be read means NO email (fail closed: better a missed retail
// email than one to a B2B buyer), and the result says so.
//
// Under "retail_only" and "all" a customer gets exactly ONE shipping email per fulfilment, and it
// carries the tracking: a create emails only when it carries a tracking number, and a tracking
// update emails only when it gives an untracked fulfilment its first number. A later number
// change, or a carrier / url edit, never emails again. `customerNotificationFor` is that rule, in
// one place: the handlers apply it at execution and the approval cards word their subtitle from it.

/** `kernel.apps.config` key holding the org's B2B sku suffixes (manifest `configKeys`). */
export const B2B_SKU_SUFFIXES_CONFIG_KEY = "b2bSkuSuffixes"
/** `kernel.apps.config` key holding the org's customer shipping email policy. */
export const SHIPPING_EMAIL_POLICY_CONFIG_KEY = "customerShippingEmail"

export const SHIPPING_EMAIL_POLICIES = ["caller", "retail_only", "all", "none"] as const
export type ShippingEmailPolicy = (typeof SHIPPING_EMAIL_POLICIES)[number]

/**
 * GraphQL selection on an `Order` that carries the B2B signals. Same `purchasingEntity` fragment the
 * order reads already use (a consumer order answers `{}`).
 */
export const ORDER_B2B_SIGNALS_SELECTION =
  "purchasingEntity { ... on PurchasingCompany { company { name } } } lineItems(first: 250) { nodes { sku } }"

export interface OrderB2bSignals {
  purchasingEntity?: { company?: { name?: string | null } | null } | null
  lineItems?: { nodes?: Array<{ sku?: string | null } | null> | null } | null
}

export type B2bReason = "b2b_company_buyer" | "b2b_sku_suffix"

/** Read the policy value; anything unknown (or unset) is the caller's own flag. */
export function parseShippingEmailPolicy(value: unknown): ShippingEmailPolicy {
  return typeof value === "string" && (SHIPPING_EMAIL_POLICIES as readonly string[]).includes(value)
    ? (value as ShippingEmailPolicy)
    : "caller"
}

/** Parse the suffix config value: a comma-separated string (or a string array). */
export function parseSkuSuffixes(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : []
  return raw
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
}

function companyReason(order: OrderB2bSignals | null | undefined): B2bReason | null {
  return order?.purchasingEntity?.company ? "b2b_company_buyer" : null
}

function skuReason(order: OrderB2bSignals | null | undefined, suffixes: string[]): B2bReason | null {
  if (suffixes.length === 0) return null
  const skus = (order?.lineItems?.nodes ?? [])
    .map((n) => n?.sku?.trim().toLowerCase())
    .filter((s): s is string => typeof s === "string" && s.length > 0)
  return skus.some((sku) => suffixes.some((suffix) => sku.endsWith(suffix))) ? "b2b_sku_suffix" : null
}

/** The B2B verdict a read carries for the approval card (`b2bOrder`). */
export type B2bVerdict = { b2b: true; reason: B2bReason } | { b2b: false; reason: null }

/** Is this order B2B? Null when it cannot be decided (the org's suffixes could not be read). */
export async function b2bVerdict(
  order: OrderB2bSignals | null | undefined,
  readSuffixes: () => Promise<unknown>,
): Promise<B2bVerdict | null> {
  const company = companyReason(order)
  if (company) return { b2b: true, reason: company }
  let raw: unknown
  try {
    raw = await readSuffixes()
  } catch {
    return null
  }
  const sku = skuReason(order, parseSkuSuffixes(raw))
  return sku ? { b2b: true, reason: sku } : { b2b: false, reason: null }
}

/** Read the org's policy; null when the setting cannot be read. */
export async function readShippingEmailPolicy(
  readPolicy: () => Promise<unknown>,
): Promise<ShippingEmailPolicy | null> {
  try {
    return parseShippingEmailPolicy(await readPolicy())
  } catch {
    return null
  }
}

export type CustomerNotificationReason =
  | B2bReason
  | "retail_order"
  | "policy_all"
  | "policy_none"
  | "no_tracking"
  | "already_notified"
  | "undecided_fail_closed"

export interface CustomerNotification {
  notified: boolean
  reason: CustomerNotificationReason
  message: string
}

const MESSAGES: Record<CustomerNotificationReason, string> = {
  b2b_company_buyer:
    "Shopify did not email the customer: this is a B2B order (its buyer is a Shopify B2B company), and B2B buyers never get Shopify's shipping email.",
  b2b_sku_suffix:
    "Shopify did not email the customer: this is a B2B order (a line item's sku carries the store's B2B suffix), and B2B buyers never get Shopify's shipping email.",
  retail_order:
    "Shopify emailed the customer with the tracking: this is a retail order and the store's shipping email policy is retail orders only.",
  policy_all: "Shopify emailed the customer: the store's shipping email policy is every order.",
  policy_none: "Shopify did not email the customer: the store's shipping email policy is no shipping emails.",
  no_tracking:
    "Shopify did not email the customer: there is no tracking number yet. The customer gets one shipping email per fulfillment, sent with its first tracking number.",
  already_notified:
    "Shopify did not email the customer again: this fulfillment already had a tracking number, and the customer gets one shipping email per fulfillment, sent with its first tracking number.",
  undecided_fail_closed:
    "Shopify did not email the customer: the order or the store's shipping email settings could not be read, and a shipping email is only sent when the order is known to qualify.",
}

function notice(notified: boolean, reason: CustomerNotificationReason): CustomerNotification {
  return { notified, reason, message: MESSAGES[reason] }
}

/** The tracking facts of one fulfilment write. */
export type TrackingFacts =
  /** A create: does it carry a tracking number? */
  | { write: "create"; hasNumber: boolean }
  /**
   * A tracking update: does it set a number, and did the fulfilment already have one before
   * (null when that could not be read)?
   */
  | { write: "update"; setsNumber: boolean; hadNumber: boolean | null }

export interface NotificationDecision {
  /** Shopify's `notifyCustomer`; undefined when the caller's own flag stands (no policy). */
  notify: boolean | undefined
  notice: CustomerNotification | null
}

/** The tracking numbers a (normalized) Shopify `FulfillmentTrackingInput` carries. */
export function trackingNumbersOf(info: Record<string, unknown> | null | undefined): string[] {
  if (!info) return []
  const numbers = [info.number, ...(Array.isArray(info.numbers) ? info.numbers : [])]
  return numbers.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
}

/**
 * THE rule, pure: the org's policy, the order's B2B verdict and the write's tracking facts decide
 * Shopify's email. `policy` null = the setting is unreadable; `verdict` null = the order is not
 * known to be retail or B2B (only consulted under retail_only); `tracking` is called only when the
 * policy would email, and a null `hadNumber` fails closed.
 */
export function customerNotificationFor(args: {
  policy: ShippingEmailPolicy | null
  verdict: B2bVerdict | null
  callerAsksToNotify: boolean
  tracking: TrackingFacts
}): NotificationDecision {
  const { policy, verdict, tracking } = args
  if (policy === null) {
    // The policy itself is unreadable: never send an email nobody can vouch for.
    return args.callerAsksToNotify
      ? { notify: false, notice: notice(false, "undecided_fail_closed") }
      : { notify: undefined, notice: null }
  }
  if (policy === "caller") return { notify: undefined, notice: null }
  if (policy === "none") return { notify: false, notice: notice(false, "policy_none") }
  let emailed: CustomerNotificationReason = "policy_all"
  if (policy === "retail_only") {
    if (verdict === null) return { notify: false, notice: notice(false, "undecided_fail_closed") }
    if (verdict.b2b) return { notify: false, notice: notice(false, verdict.reason) }
    emailed = "retail_order"
  }
  // One shipping email per fulfilment, with its first tracking number.
  if (tracking.write === "create") {
    if (!tracking.hasNumber) return { notify: false, notice: notice(false, "no_tracking") }
  } else {
    if (!tracking.setsNumber) return { notify: false, notice: notice(false, "no_tracking") }
    if (tracking.hadNumber === null) return { notify: false, notice: notice(false, "undecided_fail_closed") }
    if (tracking.hadNumber) return { notify: false, notice: notice(false, "already_notified") }
  }
  return { notify: true, notice: notice(true, emailed) }
}

/**
 * Decide Shopify's `notifyCustomer` for one fulfilment write at execution: reads the policy, then
 * (retail_only only) the order and the suffix setting, then the write's tracking facts, and applies
 * `customerNotificationFor`. `loadOrder` may throw or return null, which fails closed; so does a
 * `tracking` that throws.
 */
export async function decideCustomerNotification(args: {
  readConfig: (key: string) => Promise<unknown>
  callerAsksToNotify: boolean
  loadOrder: () => Promise<OrderB2bSignals | null | undefined>
  tracking: () => Promise<TrackingFacts>
}): Promise<NotificationDecision> {
  const policy = await readShippingEmailPolicy(() => args.readConfig(SHIPPING_EMAIL_POLICY_CONFIG_KEY))
  let verdict: B2bVerdict | null = null
  if (policy === "retail_only") {
    let order: OrderB2bSignals | null | undefined
    try {
      order = await args.loadOrder()
    } catch {
      order = null
    }
    verdict = order ? await b2bVerdict(order, () => args.readConfig(B2B_SKU_SUFFIXES_CONFIG_KEY)) : null
  }
  const base = { policy, verdict, callerAsksToNotify: args.callerAsksToNotify }
  // The tracking facts matter only when the policy would email (a create's are free; an update's
  // may need a read of the fulfilment, so ask for them only then).
  const wouldEmail = customerNotificationFor({ ...base, tracking: { write: "create", hasNumber: true } })
  if (wouldEmail.notify !== true) return wouldEmail
  let tracking: TrackingFacts
  try {
    tracking = await args.tracking()
  } catch {
    tracking = { write: "update", setsNumber: true, hadNumber: null }
  }
  return customerNotificationFor({ ...base, tracking })
}
