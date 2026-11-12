// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PURE row logic for the order prep grid.
//
// Every button state on a prep row is a decidable function of the row, and it lives here rather
// than inside PrepGrid.tsx for two reasons. First, it is testable without mounting Solid. Second,
// and more importantly, `mutationPlan` below is the enforceable form of the rule the whole rework
// exists for: a ROW ACTION PATCHES ONE ROW, it never re-lists the grid. The old grid ended every
// mutation in `await refetch()`, which re-ran the whole worklist read (and, before the rework, one
// shipment-draft resolution per row), which is why ticking the validated checkbox felt like a page
// reload. The table is data, so a test can fail the moment a new action is wired to a refetch.
//
// No Solid import, no kit import, no host import: this module is plain data in, plain data out.

import { currencyExponent } from "../money"

// ── row shapes (mirror prep.ts's PrepRow / PrepListResult over the wire) ─────

export interface PrepOffer {
  carrier: string
  service: string
  offer_code: string
  price_ht_minor: number
  price_ttc_minor: number
  currency: string
  delivery_date: string | null
  eta_business_days: number | null
  is_pickup_point: boolean
}

export interface PrepQuoteView {
  cheapest: PrepOffer | null
  alternates: PrepOffer[]
  /** Every cached offer, cheapest first: the offer dropdown's option list. */
  offers: PrepOffer[]
  selected_offer_code: string | null
  selected: PrepOffer | null
  quoted_at: string | null
  stale: boolean
}

export type PrepRowState = "ready" | "needs_fix" | "quote_missing" | "not_synced" | "needs_document"
export type PrepCategory = "sale" | "repair" | "gift" | "return"
export type PrepStatus = "to_prepare" | "validated" | "on_hold"
export type PrepInvoiceState =
  | "issued"
  | "pending_approval"
  | "generating"
  | "missing"
  | "not_available"
export type AnchorKind = "invoice" | "proforma"

export interface PrepParcel {
  length: number
  width: number
  height: number
  weight: number
}

export interface PrepInvoiceView {
  state: PrepInvoiceState
  document_id: string | null
  number: string | null
  approval_id: string | null
  kind: AnchorKind | null
}

export interface PrepShipmentView {
  id: string
  has_label: boolean
  tracking_number: string | null
  order_status: string | null
  created_at: string | null
}

export interface PrepRecipientView {
  name?: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  street?: string | null
  city?: string | null
  postalCode?: string | null
  countryIsoCode?: string | null
  state?: string | null
  complete: boolean
  /** Names of the fields a label buy still needs, e.g. ["email", "phone"]. Empty when complete.
   *  Backend-computed (prep.ts's missingRecipientFields) so the tooltip never drifts from what
   *  actually gates `complete`. */
  missing_fields?: string[]
}

export interface PrepRow {
  order_key: string
  document_ref: string | null
  anchor_kind: AnchorKind | null
  invoice_ref: string
  order_name: string | null
  order_created_at: string | null
  customer: string
  destination: string
  order_tags: string[]
  products: string
  grand_total_minor: number | null
  currency: string | null
  /** What the customer paid for shipping on the Shopify order, in the order's currency. Optional:
   *  a row cached by an older build has neither field. */
  customer_shipping_minor?: number | null
  customer_shipping_currency?: string | null
  parcels: PrepParcel[]
  package_count: number
  category: PrepCategory
  status: PrepStatus
  status_note: string | null
  staff_note: string | null
  quote: PrepQuoteView
  state: PrepRowState
  reason?: string
  excluded: boolean
  validated: boolean
  invoice: PrepInvoiceView
  shipment: PrepShipmentView | null
  recipient: PrepRecipientView | null
  /** A person typed or corrected the recipient's place on this row (prep.ts). */
  recipient_edited?: true
  partially_shipped?: boolean
  remaining_units?: number
  recipient_phone_issue?: string
  /** Present once the customer has a verified delivery address (prep.ts PrepRow.address_check). */
  address_check?: PrepAddressCheck
}

/** One side of the address comparison, as address-check.ts sends it. */
export interface PrepAddress {
  id?: string
  name?: string | null
  company?: string | null
  street?: string | null
  city?: string | null
  postalCode?: string | null
  countryIsoCode?: string | null
  state?: string | null
  phone?: string | null
  verified_at?: string | null
  verified_by_name?: string | null
  verification_source?: string | null
}

export type PrepAddressPick = "order" | "verified"

export interface PrepAddressCheck {
  state: "match" | "differs" | "no_verified" | "verified_only"
  used: {
    source: string
    address_id?: string
    verified_at?: string | null
    verified_by_name?: string | null
    verification_source?: string | null
  } | null
  order_address: PrepAddress | null
  verified_address: PrepAddress | null
  choice?: { pick: PrepAddressPick; chosen_at: string | null }
}

/** The row's order address and the verified one differ and both are known: the chip shows, with
 *  the two side by side and a pick. */
export function addressDiffers(row: Pick<PrepRow, "address_check">): boolean {
  const c = row.address_check
  return Boolean(c && c.state === "differs" && c.order_address && c.verified_address)
}

/** The two differ and nobody has picked yet: the row is held. */
export function addressPickNeeded(row: Pick<PrepRow, "address_check">): boolean {
  return addressDiffers(row) && !row.address_check?.choice
}

export interface PrepListResult {
  rows: PrepRow[]
  total: number
  last_sync_at: string | null
  truncated: boolean
  last_sync_error: string | null
  invoicing_available: boolean
}

// ── the refetch rule ─────────────────────────────────────────────────────────

/**
 * How each grid action updates the view.
 *
 * `patch` re-reads ONE row (`prep_list {order_keys:[key]}`) and merges it in place, leaving every
 * other row object referentially identical so its DOM is untouched. `refetch` re-runs the whole
 * list read, and is legitimate ONLY for the three actions whose effect is on the LIST itself: Pull
 * orders (the scan), Refresh stale (many rows at once) and the Show excluded toggle (a different
 * row set). Anything a single row does belongs in the `patch` half.
 */
export const mutationPlan = {
  set_status: "patch",
  set_note: "patch",
  set_category: "patch",
  set_package: "patch",
  select_offer: "patch",
  quote: "patch",
  ship: "patch",
  check_documents: "patch",
  exclude: "patch",
  restore: "patch",
  add_shipment: "patch",
  address_choice: "patch",
  pull_orders: "refetch",
  refresh_stale: "refetch",
  toggle_excluded: "refetch",
} as const satisfies Record<string, "patch" | "refetch">

export type PrepMutation = keyof typeof mutationPlan

// ── The refetch rule, as a mechanism rather than a promise ───────────────────

export interface RunMutationDeps {
  setRowBusy?: (key: string, busy: boolean) => void
  setRowError?: (key: string, message: string | null) => void
  /** Re-reads the whole worklist. Called ONLY for the three `refetch` actions. Solid's own
   *  `refetch` return type is not a plain `Promise`, so this is deliberately loose; the value is
   *  never used, only awaited. */
  refetch: () => unknown
  /** Re-reads and patches ONE row. Called for every `patch` action that has a row. */
  patchRow: (orderKey: string) => Promise<void>
}

/**
 * Builds `runMutation`: every grid mutation goes through the function this returns, and
 * `mutationPlan` (not the caller) decides whether the effect is a one-row patch or a whole-list
 * refetch. This is the MECHANISM behind the rework's headline claim, factored out of PrepGrid so
 * it can be driven directly in a test with a stubbed `refetch`/`patchRow`, instead of trusting that
 * every caller happened to wire itself correctly.
 */
export function createRunMutation(deps: RunMutationDeps) {
  return async function runMutation(
    name: PrepMutation,
    orderKey: string | null,
    fn: () => Promise<void>,
  ): Promise<void> {
    // `held` is flipped BEFORE the setter runs, never after: `setRowBusy` renders synchronously
    // (it is a Solid signal write), so a render that throws inside it must still leave the release
    // below owning the flag. Nothing between here and that release can escape without clearing it.
    let held = false
    const release = (): void => {
      if (!held || !orderKey) return
      held = false
      deps.setRowBusy?.(orderKey, false)
    }
    try {
      try {
        if (orderKey) {
          held = true
          deps.setRowBusy?.(orderKey, true)
          deps.setRowError?.(orderKey, null)
        }
        await fn()
      } finally {
        // The row is busy for THE WRITE, and for nothing else.
        //
        // The reconcile read below is a background confirmation of a change that has ALREADY been
        // applied -- optimistically on screen and authoritatively in the database -- so holding the
        // row for its duration buys nothing and costs the operator the whole read: a measured local
        // run had a 3.0s `prep_set_status` followed by a 9.0s one-row re-read, i.e. a row that sat
        // disabled and labelled "Working" for 12 seconds after its status had already changed.
        // Worse, a read that never settles -- a control unmounted mid-flight (collapsing a cell
        // does exactly that), a hung request -- left the row reading "Working" forever, with no
        // path back. Releasing here, in a `finally` that only wraps the write, makes the flag's
        // lifetime equal to the write's on every path: resolve, reject, or throw from the setter.
        //
        // Safe against a double buy: `create_shipment` reserves its `document_ref` server-side
        // (`reserveCreate` in shipment.ts), so a second click inside the reconcile window is
        // rejected with a message rather than buying a second label.
        release()
      }
      if (mutationPlan[name] === "refetch") await deps.refetch()
      else if (orderKey) await deps.patchRow(orderKey)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (orderKey) deps.setRowError?.(orderKey, message)
      else throw err
    }
  }
}

// ── Ship ─────────────────────────────────────────────────────────────────────

/** Why Ship is disabled, in the order the operator has to fix them, or null when it is enabled. */
export function shipDisabledReason(row: PrepRow): string | null {
  if (row.status === "on_hold") return "This row is on hold. Set it back to To prepare to ship it."
  if (row.shipment) return "A label has already been bought for this row."
  if (row.invoice.state === "not_available") {
    return "The invoicing app is not installed, so there is no document to ship on."
  }
  if (!row.document_ref) return row.reason ?? "This row has no shipping document yet."
  if (row.invoice.state !== "issued") return "The shipping document is not issued yet."
  if (row.state === "not_synced")
    return "This row has not been synced yet. Sync it to get packages and a price."
  if (row.state === "needs_fix") return row.reason ?? "This row needs a fix before it can ship."
  if (row.quote.offers.length === 0) return "No carrier offer for this row yet. Quote it first."
  if (row.quote.stale) return "The quote is out of date since the packages changed. Re-quote it."
  if (!row.recipient || !row.recipient.complete) {
    const missing = row.recipient?.missing_fields ?? []
    return missing.length > 0
      ? `The recipient is missing its ${missing.join(", ")}, so the carrier would refuse the label.`
      : "The recipient address is incomplete, so the carrier would refuse the label."
  }
  if (row.recipient_phone_issue) return row.recipient_phone_issue
  if (addressPickNeeded(row)) {
    return "The order's address and the customer's verified address differ. Pick which one to use (Address differs)."
  }
  return null
}

export function canShip(row: PrepRow): boolean {
  return shipDisabledReason(row) === null
}

/** The offer a Ship click buys: the operator's choice, else the cheapest. */
export function shipOffer(row: PrepRow): PrepOffer | null {
  return row.quote.selected ?? row.quote.cheapest
}

/**
 * The price to hand `create_shipment`, in MAJOR units.
 *
 * The handler compares `quoted_price_ttc` against a live re-quote and formats it with toFixed(2),
 * so passing the row's minor-unit price is a 100x price oracle: every buy would look like a huge
 * price drop and pass. Exponent aware, so a JPY offer is not divided by 100.
 */
export function quotedPriceMajor(offer: Pick<PrepOffer, "price_ttc_minor" | "currency">): number {
  return offer.price_ttc_minor / 10 ** currencyExponent(offer.currency)
}

export interface CreateShipmentParams {
  draft_id: string
  offer_code: string
  quoted_price_ttc: number
  quoted_currency: string
  recipient_phone?: string
  recipient_address?: {
    name: string
    email?: string
    street: string
    city: string
    postalCode: string
    countryIsoCode: string
    company?: string
  }
}

/** The exact `create_shipment` body a Ship click sends, or null when the row cannot ship. The
 *  recipient address goes along only when a person edited it on the row: the address shown is
 *  otherwise the server's own resolution (the order's ship-to, a picked or verified address),
 *  and resending it would turn it into an address "typed in the call". */
export function shipParams(row: PrepRow): CreateShipmentParams | null {
  const offer = shipOffer(row)
  if (!offer || !row.document_ref) return null
  const r = row.recipient
  return {
    draft_id: row.document_ref,
    offer_code: offer.offer_code,
    quoted_price_ttc: quotedPriceMajor(offer),
    quoted_currency: offer.currency,
    ...(r?.phone ? { recipient_phone: r.phone } : {}),
    ...(row.recipient_edited &&
    r &&
    r.name &&
    r.street &&
    r.city &&
    r.postalCode &&
    r.countryIsoCode
      ? {
          recipient_address: {
            name: r.name,
            street: r.street,
            city: r.city,
            postalCode: r.postalCode,
            countryIsoCode: r.countryIsoCode,
            ...(r.email ? { email: r.email } : {}),
            ...(r.company ? { company: r.company } : {}),
          },
        }
      : {}),
  }
}

// ── Label ────────────────────────────────────────────────────────────────────

/** How long a bought shipment may go without a label document before the row offers a re-check. */
export const LABEL_WAIT_MS = 5 * 60 * 1000

export type LabelState = "disabled" | "waiting" | "check_documents" | "ready"

/**
 * Label is enabled ONLY once Boxtal has actually produced the label PDF. A bought shipment is not
 * a printable label, and a button that opens nothing is worse than a disabled one, so the wait is
 * shown honestly and turns into an action after five minutes rather than spinning forever.
 */
export function labelState(row: PrepRow, now: number = Date.now()): LabelState {
  const s = row.shipment
  if (!s) return "disabled"
  if (s.has_label) return "ready"
  const started = s.created_at ? Date.parse(s.created_at) : Number.NaN
  if (Number.isFinite(started) && now - started >= LABEL_WAIT_MS) return "check_documents"
  return "waiting"
}

export const LABEL_LABELS: Record<LabelState, string> = {
  disabled: "Label",
  waiting: "Label on its way",
  check_documents: "Check documents",
  ready: "Label",
}

// ── Invoice control ──────────────────────────────────────────────────────────

export interface InvoiceControl {
  state: PrepInvoiceState
  label: string
  /** Shown on hover; empty when the label says it all. */
  tooltip: string
  canDownload: boolean
  /** True when the row should offer a link to the Approvals tab instead of a download. */
  showApprovalsLink: boolean
}

export const NO_INVOICE_TOOLTIP =
  "Invoices are issued automatically at order creation. Check Approvals if the order was above the invoice threshold."

export function invoiceControlState(row: PrepRow): InvoiceControl {
  const inv = row.invoice
  if (inv.state === "not_available") {
    return {
      state: inv.state,
      label: "Not available",
      tooltip: "The invoicing app is not installed, so this row has no document.",
      canDownload: false,
      showApprovalsLink: false,
    }
  }
  if (inv.state === "issued") {
    const kind = inv.kind === "proforma" ? "Proforma" : "Issued"
    // The NUMBER alone, because the number is the thing an operator cross-checks
    // against the parcel and the state is already carried by the pill's tone. The
    // state word rode in front of it until 2026-09-08 and cost ~55px of a column
    // that renders under the opaque sticky Actions cell, so what the operator
    // actually read was the fragment "Iss 20:". The full wording lives on the
    // `title` instead -- shorter cell, same information on hover.
    return {
      state: inv.state,
      label: inv.number ? inv.number : kind,
      tooltip: inv.number ? `${kind} ${inv.number}` : kind,
      canDownload: true,
      showApprovalsLink: false,
    }
  }
  if (inv.state === "pending_approval") {
    return {
      state: inv.state,
      label: "Pending",
      tooltip:
        "Pending approval: the proforma for this row is waiting for an approval before it can be issued.",
      canDownload: false,
      showApprovalsLink: true,
    }
  }
  if (inv.state === "generating") {
    return {
      state: inv.state,
      label: "Generating",
      tooltip: "The PDF is still rendering. It will be downloadable in a moment.",
      canDownload: false,
      showApprovalsLink: false,
    }
  }
  return {
    state: "missing",
    label: "No invoice",
    tooltip: `No invoice yet. ${NO_INVOICE_TOOLTIP}`,
    canDownload: false,
    showApprovalsLink: true,
  }
}

// ── Quote ────────────────────────────────────────────────────────────────────

export interface QuoteButtonState {
  /** The button's word: what a click will do. */
  label: string
  disabled: boolean
  tone: "neutral" | "warn" | "danger"
  tooltip: string
}

export function quoteButtonState(row: PrepRow): QuoteButtonState {
  if (row.state === "needs_document") {
    return {
      label: "Quote",
      disabled: true,
      tone: "neutral",
      tooltip: row.reason ?? "This row has no shipping document to quote from.",
    }
  }
  if (row.state === "not_synced") {
    return {
      label: "Sync",
      disabled: false,
      tone: "neutral",
      tooltip: "Resolve the packages and get a price.",
    }
  }
  if (row.state === "needs_fix") {
    return {
      label: "Re-quote",
      disabled: false,
      tone: "danger",
      tooltip: row.reason ?? "This row needs a fix.",
    }
  }
  if (row.quote.offers.length === 0) {
    return {
      label: "No offers",
      disabled: false,
      tone: "danger",
      tooltip: "No carrier quoted this parcel. Try again.",
    }
  }
  if (row.quote.stale) {
    return {
      label: "Re-quote",
      disabled: false,
      tone: "warn",
      tooltip: "The packages changed since this price was quoted.",
    }
  }
  return { label: "Quote", disabled: false, tone: "neutral", tooltip: "" }
}

// ── Status tint ──────────────────────────────────────────────────────────────

/**
 * The whole ROW is tinted, not one cell: an operator scanning the grid reads state by row colour.
 *
 * `packed` is the Ready-to-ship bench mark (the parcel is boxed and waiting for pickup). A packed
 * row greys out so the rows still to do stand out from the ones already done.
 *
 * PRECEDENCE: on_hold RED beats packed grey, always. A held parcel must never look done, whatever
 * anyone ticked on the bench: greying it would hide the one row on the screen that must not go out.
 */
export function rowTintClass(
  status: PrepStatus | null | undefined,
  packed?: boolean | null,
): string {
  // ON HOLD IS RED, not a quiet grey. A held parcel is the one row on the screen that must not be
  // packed, and the previous muted treatment (opacity-60 on a grey ground) read as "de-emphasised"
  // rather than "stop": it was indistinguishable at a glance from a row that simply had less to
  // say. Requested explicitly in ticket-10505 with a mock-up.
  if (status === "on_hold") return "bg-error-glow/40 border-l-2 border-l-error"
  // Done, and quiet about it: a light grey ground plus muted text, so the eye lands on the rows
  // that still need work (ticket-10507, ticket-10522).
  if (packed === true)
    return "bg-surface-hover/60 text-text-tertiary border-l-2 border-l-border-strong"
  if (status === "validated") return "bg-success/5 border-l-2 border-l-success"
  return "border-l-2 border-l-transparent"
}

export const STATUS_LABELS: Record<PrepStatus, string> = {
  to_prepare: "To prepare",
  validated: "Validated",
  on_hold: "On hold",
}

export const CATEGORY_LABELS: Record<Exclude<PrepCategory, "return">, string> = {
  sale: "Sale",
  repair: "Return after repair",
  gift: "Sample",
}

/**
 * Short forms for the prep grid's category select ONLY. The select sits in the
 * band the opaque sticky Actions cell rides over at 1440x900 with the agent
 * panel open, so the full "Return after repair" was paying 56px of column for a
 * phrase the operator can get from the control's `title`. Every other surface
 * (the Add shipment panel, agent-facing copy) keeps CATEGORY_LABELS.
 */
export const CATEGORY_SHORT_LABELS: Record<Exclude<PrepCategory, "return">, string> = {
  sale: "Sale",
  repair: "Repair",
  gift: "Sample",
}

/** Full wording for a row's category, for the select's `title`. */
export function categoryFullLabel(category: PrepCategory): string {
  return category === "return" ? "Return" : CATEGORY_LABELS[category]
}

/** The category select is locked while the row's document cannot change under it. */
export function categoryLockReason(row: PrepRow): string | null {
  if (row.invoice.state === "pending_approval") {
    return "The proforma for this row is waiting for approval, so its category cannot change yet."
  }
  if (row.shipment) {
    return "A label has already been bought against this row's document, so its category cannot change."
  }
  return null
}

// ── Row merging (the one-row patch) ──────────────────────────────────────────

/**
 * Merge freshly read rows into the current list BY IDENTITY.
 *
 * Every row object the patch did not touch comes back as the SAME object reference, so Solid's
 * `<For>` (keyed on the row object) leaves its DOM alone: that is what makes a status change
 * re-render one row instead of the grid. A key that was asked for and came back absent is dropped,
 * which is how an excluded or fulfilled row leaves without a whole-list read.
 */
export function mergeRows(
  current: PrepRow[],
  fresh: PrepRow[],
  requestedKeys?: string[],
): PrepRow[] {
  const byKey = new Map(fresh.map((r) => [r.order_key, r]))
  const asked = new Set(requestedKeys ?? fresh.map((r) => r.order_key))
  const out: PrepRow[] = []
  for (const row of current) {
    const next = byKey.get(row.order_key)
    if (next) {
      // A re-read that changed nothing keeps the row's object, so its DOM stays put.
      out.push(sameRowData(row, next) ? row : next)
      byKey.delete(row.order_key)
      continue
    }
    if (asked.has(row.order_key)) continue // asked for, came back gone
    out.push(row)
  }
  // A key that was not in the list at all (a brand new row, e.g. Add shipment) joins at the top.
  for (const added of byKey.values()) out.unshift(added)
  return out
}

/** Whether two reads of one row carry the same data. Rows are plain JSON from the same tool, so
 *  their serialisations compare equal exactly when nothing on the row changed. */
export function sameRowData(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * A fresh read of a whole list, reconciled against the list on screen: every row whose data did
 * not change keeps its previous object, so a keyed `<For>` keeps its DOM node (no rebuild, no
 * flash, hover and open folds intact). Order, additions and removals follow the fresh read. A
 * background refresh that replaced every object rebuilt every row of the worklist on each tick.
 */
export function keepUnchangedRows<T>(
  prev: readonly T[] | undefined,
  next: T[],
  key: (row: T) => string,
): T[] {
  if (!prev || prev.length === 0) return next
  const byKey = new Map(prev.map((r) => [key(r), r]))
  let reused = 0
  const out = next.map((row) => {
    const old = byKey.get(key(row))
    if (old !== undefined && sameRowData(old, row)) {
      reused++
      return old
    }
    return row
  })
  return reused === 0 ? next : out
}

// ── Polling ──────────────────────────────────────────────────────────────────

export interface PollPlan {
  /** Milliseconds between row re-reads, or null when the row needs no polling at all. */
  intervalMs: number | null
  /** Stop polling after this long, so a stuck row never polls forever. */
  timeoutMs: number
  reason: "label" | "invoice_pdf" | null
}

export const NO_POLL: PollPlan = { intervalMs: null, timeoutMs: 0, reason: null }

/**
 * When a row has to re-read itself on a timer, and for how long.
 *
 * Only ever after an event that is genuinely in flight: a bought shipment whose label has not
 * arrived, or a PDF still rendering. Never in the list read, and never open-ended.
 */
export function pollPlan(row: PrepRow, now: number = Date.now()): PollPlan {
  if (labelState(row, now) === "waiting")
    return { intervalMs: 5000, timeoutMs: LABEL_WAIT_MS, reason: "label" }
  if (row.invoice.state === "generating")
    return { intervalMs: 3000, timeoutMs: 60_000, reason: "invoice_pdf" }
  return NO_POLL
}

/** Per-row poll bookkeeping the tick keeps across calls: when the current poll reason was first
 *  armed, and when this row was last actually re-read. */
export interface PollTickState {
  reason: PollPlan["reason"]
  startedAt: number
  lastPolledAt: number
}

export interface PollTickResult {
  /** Keys due for a batched row re-read this tick (reason "label"). */
  dueLabelKeys: string[]
  /** Keys due for an invoice_pdf retry this tick; resolved individually by re-asking for the
   *  file, never by a row re-read (the backend never emits a "generating" row state). */
  dueInvoicePdfKeys: string[]
  /** Keys whose poll deadline (timeoutMs) was exceeded this tick, with the reason that timed out. */
  timedOutKeys: Array<{ key: string; reason: PollPlan["reason"] }>
}

/**
 * Decides, for one 1s tick, which rows are due for a poll re-read and which have timed out.
 *
 * Mutates `pollStarted` in place exactly as the poll loop in PrepGrid did inline (arms newly
 * needed rows, records lastPolledAt, drops timed-out or no-longer-live rows): extracted so the
 * decision is testable without a DOM harness, which this app does not have.
 */
export function pollTick(
  rows: PrepRow[],
  pollStarted: Map<string, PollTickState>,
  now: number,
  isBusy: (key: string) => boolean,
): PollTickResult {
  const live = new Set<string>()
  const dueLabelKeys: string[] = []
  const dueInvoicePdfKeys: string[] = []
  const timedOutKeys: Array<{ key: string; reason: PollPlan["reason"] }> = []
  for (const row of rows) {
    const plan = pollPlan(row, now)
    if (plan.intervalMs === null || plan.reason === null) continue
    const key = row.order_key
    live.add(key)
    const state = pollStarted.get(key)
    if (!state || state.reason !== plan.reason) {
      pollStarted.set(key, { reason: plan.reason, startedAt: now, lastPolledAt: 0 })
      continue // arm on this tick, poll on the next one that is due
    }
    if (now - state.startedAt > plan.timeoutMs) {
      pollStarted.delete(key)
      timedOutKeys.push({ key, reason: plan.reason })
      continue
    }
    if (now - state.lastPolledAt < plan.intervalMs) continue
    if (isBusy(key)) continue
    state.lastPolledAt = now
    if (plan.reason === "invoice_pdf") dueInvoicePdfKeys.push(key)
    else dueLabelKeys.push(key)
  }
  for (const key of [...pollStarted.keys()]) if (!live.has(key)) pollStarted.delete(key)
  return { dueLabelKeys, dueInvoicePdfKeys, timedOutKeys }
}
