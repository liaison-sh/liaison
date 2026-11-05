// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PrepGrid: the order prep dashboard, and the one screen the logistics operator works from.
//
// ONE ROW PER OPEN SHOPIFY ORDER (not per issued invoice, which is what it used to be, and which
// made an un-invoiced order structurally invisible). Every action the row needs is on the row:
// status, category, the shipping document, packages, quote, ship, label, exclude.
//
// Two costs the rework removes, both of which read to the operator as "the page reloads when I
// tick a box":
//   * the list read resolved one shipment draft PER ROW. It now resolves none: the grid renders
//     from caches and a row that has never been synced says so.
//   * every row action ended in a whole-list refetch. Each one now re-reads ITS OWN row
//     (prep_list {order_keys}) and patches it in place, so no other row's DOM is touched.
// Which action does which is `mutationPlan` in prep-row-logic.ts, and `runMutation` is the only
// path a mutation takes, so the rule is enforced rather than remembered.
//
// kit.tsx primitives only; no kernel ui imports; no @solidjs/router; explicit props (no {...rest}
// spreads onto host elements, per the bundling rule). No dash punctuation in operator copy.
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
} from "solid-js"
import { accessToken, app, fetch as hostFetch, navigate } from "@liaison/host"
import { AddShipmentPanel } from "./AddShipmentPanel"
import { AddressDiffersChip, AddressDiffersFold } from "./AddressDiffers"
import {
  type ApprovalRow,
  SHIP_APPROVALS_PATH,
  approvalCardText,
  decideBody,
  decidePath,
  decisionNote,
  pendingShipApprovalsByDraft,
  shipApprovalForRow,
  shipOutcome,
} from "./ship-approval"
import { CaretIcon, CarrierLogo, PrinterIcon } from "./icon"
import { loadFileInto, openPreparingTab } from "./file-open"
import { productChipLabel, resolveProductCodes, shortProductCode } from "./product-codes"
import { compareCountry, countryName, countryOptions } from "./country"
import {
  decodeOrgIdFromToken,
  evictShippedRowFromCache,
  loadPrepCache,
  resolveLocalStorage,
  savePrepCache,
} from "./prep-cache"
import {
  EXIT_TRANSITION_MS,
  gridViewState,
  planPrepListOpen,
  reconcileExitingRows,
  rowIsInteractive,
} from "./prep-view-state"
import {
  addressDiffers,
  CATEGORY_SHORT_LABELS,
  canShip,
  categoryFullLabel,
  categoryLockReason,
  createRunMutation,
  invoiceControlState,
  LABEL_LABELS,
  labelState,
  mergeRows,
  type PrepCategory,
  type PrepInvoiceState,
  type PrepListResult,
  type PrepOffer,
  type PrepParcel,
  type PollTickState,
  type PrepQuoteView,
  type PrepAddressPick,
  type PrepRow,
  type PrepStatus,
  pollTick,
  quoteButtonState,
  rowTintClass,
  shipDisabledReason,
  shipParams,
  STATUS_LABELS,
} from "./prep-row-logic"
import {
  Badge,
  Button,
  currencyExponent,
  cx,
  EmptyState,
  formatMoneyMinor,
  inputClass,
  PageHeader,
  Th,
} from "./kit"

// ── Row + tool-response shapes ──────────────────────────────────────────────
//
// They live in prep-row-logic.ts (the pure module) rather than here, so a test can get the row
// shape and every button-state function without importing this component. Re-exported so the
// existing `from "./PrepGrid"` import sites keep working.
export type {
  AnchorKind,
  PrepCategory,
  PrepInvoiceState,
  PrepInvoiceView,
  PrepListResult,
  PrepOffer,
  PrepParcel,
  PrepQuoteView,
  PrepRecipientView,
  PrepRow,
  PrepRowState,
  PrepShipmentView,
  PrepStatus,
} from "./prep-row-logic"

// Money helpers (currency-exponent aware) now live in kit.tsx — the single
// money system for the boxtal UI package. Re-exported here so existing
// imports from "./PrepGrid" (PrepGrid.test.ts) keep working.
export { currencyExponent, formatMoneyMinor } from "./kit"

// ── Pure helpers (unit-tested in PrepGrid.test.ts) ──────────────────────────

/** Deterministic, sorted list of product tokens across all rows, for the
 *  product filter chip bar — derived from each row's "1xES, 1xET2" summary. */
export function productsSummaryList(rows: PrepRow[]): string[] {
  const set = new Set<string>()
  for (const row of rows) {
    for (const part of row.products.split(",")) {
      const trimmed = part.trim()
      // Strip a leading quantity prefix like "2x" to get the bare token.
      // Strip a leading quantity prefix — both "2x" and the invoicing decimal
      // form "01.000x" (the old \d+x regex missed the decimals, so every
      // token kept its prefix and never deduped).
      const token = trimmed.replace(/^\d+(?:[.,]\d+)?\s*x/i, "").trim()
      if (token && token !== "-") set.add(token)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b))
}

/** Compact human label for a product-filter token. Free-text invoice lines
 *  carry whole customs descriptions ("Tessera 2 — Portable audio field recorder
 *  for location sound. …") and Shopify GIDs — as raw filter options they
 *  filled the screen. Cut at the description separator, name GID variants,
 *  and hard-cap the length. */
export function productLabel(token: string): string {
  const gid = token.match(/^gid:\/\/shopify\/ProductVariant\/(\d+)$/)
  if (gid) return `Variant …${(gid[1] ?? "").slice(-6)}`
  const name = (token.split(/\s+—\s+|\s+-\s+/)[0] ?? token).trim()
  return name.length > 36 ? `${name.slice(0, 35)}…` : name
}

export interface PrepFilterInput {
  search: string
  country: string
  tag: string
  product: string
  includeExcluded: boolean
}

/** Client-side filter predicate — mirrors prep_list's own server-side
 *  matchesFilters so a locally-cached page can be re-filtered without a
 *  round trip while the operator types (the actual authoritative filtering
 *  still happens server-side on the next prep_list call with these params). */
export function matchesPrepFilter(row: PrepRow, f: PrepFilterInput): boolean {
  if (!f.includeExcluded && row.excluded) return false
  if (f.country && row.destination.trim().toUpperCase() !== f.country.trim().toUpperCase()) return false
  if (f.tag && !row.order_tags.some((t) => t.toLowerCase() === f.tag.toLowerCase())) return false
  if (f.product && !row.products.toLowerCase().includes(f.product.toLowerCase())) return false
  if (f.search) {
    const q = f.search.toLowerCase()
    const haystack = `${row.invoice_ref} ${row.order_name ?? ""} ${row.customer} ${row.destination}`.toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

/** Formats one offer for the shipping-estimate cell / popover row, e.g.
 *  "Chronopost 18: 12.40 EUR". */
export function formatOffer(offer: PrepOffer): string {
  return `${offer.carrier}: ${formatMoneyMinor(offer.price_ht_minor, offer.currency)}`
}

/** One offer's label in the row's offer dropdown: carrier + service, price HT, ETA, and a
 *  relay/home tag. Plain-text (an <option> holds no markup); no dash punctuation. e.g.
 *  "UPS Express: 18.00 EUR, 1d, Home" or "Mondial Relay Point Relais: 5.40 EUR, 2d, Relay". */
export function formatOfferOption(offer: PrepOffer): string {
  const head = offer.service ? `${offer.carrier} ${offer.service}` : offer.carrier
  const tail: string[] = [formatMoneyMinor(offer.price_ht_minor, offer.currency)]
  if (offer.eta_business_days != null) tail.push(`${offer.eta_business_days}d`)
  tail.push(offer.is_pickup_point ? "Relay" : "Home")
  return `${head}: ${tail.join(", ")}`
}

/** The offer a row will STAGE: the operator's chosen offer, else the cheapest. */
export function effectiveOffer(quote: PrepQuoteView): PrepOffer | null {
  return quote.selected ?? quote.cheapest
}

/** The compact human label for a row's parcel count, e.g. "2 packages". */
export function packageCountLabel(count: number): string {
  return `${count} package${count === 1 ? "" : "s"}`
}

// ── Package editing (dims + weight + how many identical cartons) ───────────
//
// The operator edits a row's carton LOCALLY: nothing is persisted and no quote
// is fetched until they press the row's "Refresh quote" button. Committing on
// blur (the previous behaviour) fired one live Boxtal quote per field left, so
// typing 40 x 30 x 20 cost three quotes and there was no way to change several
// values as one edit. `packageDraftChanged` is what makes the button appear.

/** One carton's own dimensions and weight. */
export interface CartonDraft {
  length: number
  width: number
  height: number
  weight: number
}

/**
 * The row's whole parcel set, one entry per carton.
 *
 * This used to be a SINGLE carton plus a count, which silently misrepresented
 * every mixed shipment: the editor seeded from `parcels[0]` only, and picking a
 * count re-sent that one carton N times. A real row like INV-2026-3357 (one
 * 58x38x42 at 20.5kg plus three 46x33x4 at 0.8kg) would have been flattened to
 * four 20.5kg cartons on the next edit -- a wrong quote and a wrong label, with
 * nothing on screen to show the other three cartons had been overwritten.
 * `shipment_draft_set_package` has always accepted an array of cartons
 * (SetPackageOverride), so only this editor was the limit.
 */
export interface PackageDraft {
  cartons: CartonDraft[]
}

/** Default ceiling of the package-count dropdown; a row already carrying more
 *  parcels stretches it (packageCountOptions) so its real count is selectable. */
const PACKAGE_COUNT_MAX = 10

/*
 * NO STICKY ACTIONS EDGE (removed 2026-09-08, owner's call: "the weird shadow between the actions
 * columns and documents is useless").
 *
 * A 2px left rule plus a leftward box shadow existed to make an OPAQUE overlay legible: back then
 * the Actions cell was pinned at every width, so it really was painted over ~184px of a column
 * that had nowhere else to go, and an unmarked edge read as a hard content edge. That is no longer
 * the geometry. The Actions column now UN-PINS as soon as the table overflows its container (see
 * `actionsSticky`), so at the only widths where it IS pinned the table fits and there is nothing
 * behind it. A shadow that says "this rides over content" when nothing is under it is a lie, and a
 * 2px rule at that one boundary reads as a column division the data does not have (no other column
 * in this grid carries a vertical rule). So: no border and no shadow -- only the opaque ground,
 * which is still what keeps the cell readable in the instant before the ResizeObserver un-pins it.
 */

const ZERO_CARTON: CartonDraft = { length: 0, width: 0, height: 0, weight: 0 }

function cartonOf(p: PrepParcel): CartonDraft {
  return { length: p.length, width: p.width, height: p.height, weight: p.weight }
}

function sameCarton(a: CartonDraft, b: CartonDraft): boolean {
  return (
    a.length === b.length && a.width === b.width && a.height === b.height && a.weight === b.weight
  )
}

/**
 * Seed the editable draft from what is persisted on the row: one carton per
 * resolved parcel, in order. A row with no resolved parcel starts as ONE zeroed
 * carton (invalid until filled) -- "zero packages" is never a shippable choice.
 * When `package_count` claims more parcels than the row actually resolved (a
 * uniform multi-carton row persisted via `quantity`), the last carton is
 * repeated to reach the stated count, which is exactly what the backend
 * expansion does.
 */
export function packageDraftOf(row: PrepRow): PackageDraft {
  const resolved = row.parcels.map(cartonOf)
  const stated = Math.max(1, row.package_count || resolved.length || 1)
  if (resolved.length === 0) {
    return { cartons: Array.from({ length: stated }, () => ({ ...ZERO_CARTON })) }
  }
  const cartons = resolved.slice(0, stated)
  const last = resolved[resolved.length - 1]!
  while (cartons.length < stated) cartons.push({ ...last })
  return { cartons }
}

/** True when the draft differs from the row's persisted parcel set — the single
 *  trigger for the per-row "Refresh quote" button. Editing a value back to its
 *  original clears it again, so the button never lingers over a no-op. */
export function packageDraftChanged(row: PrepRow, draft: PackageDraft): boolean {
  const base = packageDraftOf(row)
  if (base.cartons.length !== draft.cartons.length) return true
  return base.cartons.some((c, i) => !sameCarton(c, draft.cartons[i]!))
}

/** A draft is submittable only when it has at least one carton and every figure
 *  on EVERY carton is a positive number — an emptied field reads back as NaN and
 *  must not reach set_package. */
export function packageDraftValid(draft: PackageDraft): boolean {
  if (draft.cartons.length === 0) return false
  return draft.cartons.every((c) =>
    [c.length, c.width, c.height, c.weight].every((n) => Number.isFinite(n) && n > 0),
  )
}

/** True when every carton in the set is identical (the common case: N copies of
 *  one box). Drives the compact `quantity` wire shape below. */
export function packageDraftIsUniform(draft: PackageDraft): boolean {
  const first = draft.cartons[0]
  if (!first) return true
  return draft.cartons.every((c) => sameCarton(c, first))
}

/**
 * The `shipment_draft_set_package` override for a draft.
 *   • one carton            -> the bare dims
 *   • N identical cartons   -> dims + `quantity: N` (the tool expands them)
 *   • a MIXED set           -> an array, one entry per carton
 * The first two shapes are byte-identical to what this editor sent before, so a
 * uniform row's wire format does not change; only the mixed case is new.
 */
export function packageOverridePayload(
  draft: PackageDraft,
): CartonDraft | (CartonDraft & { quantity?: number }) | CartonDraft[] {
  const cartons = draft.cartons
  const first = cartons[0]
  if (!first) return []
  if (cartons.length === 1) return { ...first }
  if (packageDraftIsUniform(draft)) return { ...first, quantity: cartons.length }
  return cartons.map((c) => ({ ...c }))
}

/**
 * Resize a draft to `next` cartons WITHOUT destroying per-carton edits: growing
 * clones the last carton (a sensible default for "one more of the same"),
 * shrinking drops from the end. The old behaviour replaced the whole set with
 * copies of carton #1, which is precisely how a mixed shipment lost its other
 * cartons.
 */
export function setCartonCount(draft: PackageDraft, next: number): PackageDraft {
  const target = Math.max(1, Math.floor(next) || 1)
  const cartons = draft.cartons.slice(0, target)
  const seed = draft.cartons[draft.cartons.length - 1] ?? ZERO_CARTON
  while (cartons.length < target) cartons.push({ ...seed })
  return { cartons }
}

/** Replace one carton's figures, leaving every sibling untouched. */
export function setCarton(draft: PackageDraft, index: number, patch: Partial<CartonDraft>): PackageDraft {
  return {
    cartons: draft.cartons.map((c, i) => (i === index ? { ...c, ...patch } : c)),
  }
}


// ── Sorting (ticket-10221) ─────────────────────────────────────────────────
// The grid had no sort at all: rows arrived in whatever order prep_list
// returned, so "work through today's orders by number" meant scrolling and
// remembering. Everything needed is already on the row, so this costs no fetch.

export type PrepSortKey = "order" | "client" | "country" | "total"
export interface PrepSort {
  key: PrepSortKey
  dir: "asc" | "desc"
}

/** Order NAME sorts by its numeric part when it has one ("#3362"), so #99 comes
 *  before #100 instead of after it the way a plain string compare would put it.
 *  A row with no order name sorts last in either direction: it is not a hole in
 *  the sequence, it is a row that has no place in it. */
export function orderSortValue(row: PrepRow): { num: number | null; text: string } {
  const name = row.order_name ?? ""
  const m = name.match(/(\d+)/)
  return { num: m ? Number(m[1]) : null, text: name || row.invoice_ref || "" }
}

export function comparePrepRows(a: PrepRow, b: PrepRow, sort: PrepSort): number {
  const flip = sort.dir === "asc" ? 1 : -1
  if (sort.key === "client") return flip * a.customer.localeCompare(b.customer)
  // Ties keep the server order (Array.prototype.sort is stable), so one country's rows stay in
  // the order they were listed.
  if (sort.key === "country") return compareCountry(a.destination, b.destination, sort.dir)
  if (sort.key === "total") {
    // A row with no total sorts last in BOTH directions -- an unpriced row is
    // not "cheapest", it is unknown, and burying it under the cheap end would
    // read as a fact it does not carry.
    const av = a.grand_total_minor, bv = b.grand_total_minor
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    return flip * (av - bv)
  }
  const x = orderSortValue(a), y = orderSortValue(b)
  if (x.num == null && y.num == null) return flip * x.text.localeCompare(y.text)
  if (x.num == null) return 1
  if (y.num == null) return -1
  return flip * (x.num - y.num)
}

export function sortPrepRows(rows: PrepRow[], sort: PrepSort | null): PrepRow[] {
  if (!sort) return rows
  return [...rows].sort((a, b) => comparePrepRows(a, b, sort))
}

/** Click cycling: a fresh column starts ascending, the same column flips, and a
 *  third click clears back to the server order rather than trapping the operator
 *  in a sort they cannot leave. */
export function nextSort(current: PrepSort | null, key: PrepSortKey): PrepSort | null {
  if (!current || current.key !== key) return { key, dir: "asc" }
  if (current.dir === "asc") return { key, dir: "desc" }
  return null
}

/** Option values for the package-count dropdown, always starting at 1 and
 *  always able to show the row's current count. */
export function packageCountOptions(current: number): number[] {
  const max = Math.max(PACKAGE_COUNT_MAX, Math.floor(current) || 1)
  return Array.from({ length: max }, (_, i) => i + 1)
}

/** Compact one-line description of a carton, for the collapsed summary. */
export function cartonLabel(c: CartonDraft): string {
  return `${c.length}x${c.width}x${c.height} cm, ${c.weight} kg`
}

/**
 * The dense one-line summary the Total cell's third line shows at rest: enough
 * for the operator to see what ships without opening a single row. A uniform set reads
 * "2x 58x36x7cm 1.8kg" (dims and weight of the one carton shape, times the
 * count); a mixed set names how many cartons differ rather than picking one to
 * represent the rest, which is the same "never collapse to the first carton's
 * figures" rule the wire payload already follows.
 */
export function packageSummaryLine(draft: PackageDraft): string {
  const cartons = draft.cartons
  const first = cartons[0]
  if (!first) return "0 packages"
  if (packageDraftIsUniform(draft)) {
    const dims = `${first.length}x${first.width}x${first.height}cm`
    const weight = `${first.weight}kg`
    return cartons.length === 1 ? `${dims} ${weight}` : `${cartons.length}x ${dims} ${weight}`
  }
  return `mixed (${cartons.length})`
}

/** The full per-carton breakdown, for the summary line's `title` tooltip: the
 *  detail the compact line does not have room for, one carton per segment. */
export function packageDetailTitle(draft: PackageDraft): string {
  return draft.cartons.map((c, i) => `#${i + 1} ${cartonLabel(c)}`).join(" / ")
}

/** Rows whose cached quote needs a re-sync: stale (inputs changed since the
 *  quote) or missing entirely. Excluded rows are skipped (they are out of the
 *  worklist) and needs_fix rows too (a re-quote cannot succeed until the
 *  blocking defect is cleared, so syncing them is wasted API calls). Feeds the
 *  "Refresh stale" header button. */
export function staleQuoteRefs(rows: PrepRow[]): string[] {
  return rows
    .filter((row) => !row.excluded && row.state !== "needs_fix" && (row.quote.stale || row.state === "quote_missing"))
    .map((row) => row.document_ref)
    .filter((ref): ref is string => ref != null)
}

// The operator's three choices. `return` stays in the tool's enum for the returns pipeline but is
// deliberately not offered here: a return is created by the returns flow, not by re-labelling a row.
const CATEGORY_OPTIONS: ReadonlyArray<{ value: PrepCategory; label: string }> = [
  { value: "sale", label: CATEGORY_SHORT_LABELS.sale },
  { value: "repair", label: CATEGORY_SHORT_LABELS.repair },
  { value: "gift", label: CATEGORY_SHORT_LABELS.gift },
]

const STATUS_OPTIONS: ReadonlyArray<{ value: PrepStatus; label: string }> = [
  { value: "to_prepare", label: STATUS_LABELS.to_prepare },
  { value: "validated", label: STATUS_LABELS.validated },
  { value: "on_hold", label: STATUS_LABELS.on_hold },
]

/** Human-readable "last synced" copy for the Pull orders button area. No
 *  dash punctuation: comma-separated clauses instead. */
export function lastSyncLabel(lastSyncAt: string | null): string {
  if (!lastSyncAt) return "Never synced"
  const d = new Date(lastSyncAt)
  if (Number.isNaN(d.getTime())) return "Never synced"
  return `Last synced ${d.toLocaleString()}`
}

// Only `include_excluded` is a server-side param now (the search/country/tag/product filters are
// applied client-side below via matchesPrepFilter over the already-fetched rows). The list read is
// FREE: it resolves no shipment drafts, which is what makes it cheap enough to be the grid's only
// whole-list read. Every ROW action instead re-reads its own row (fetchPrepRows below).
/** Context the two cache layers need: the memory cache is keyed by includeExcluded alone (one
 *  tab, one org for its whole life), the persisted one additionally needs the org id and the
 *  actual storage backend -- resolved once per PrepGrid mount and threaded through here rather
 *  than re-read on every call. */
interface PrepCacheCtx {
  orgId: string | null
  storage: ReturnType<typeof resolveLocalStorage>
}

async function fetchPrepList(
  params: { includeExcluded: boolean },
  cacheCtx: PrepCacheCtx,
): Promise<PrepListResult> {
  const res = await app.invokeTool<PrepListResult>("prep_list", {
    include_excluded: params.includeExcluded,
  })
  const value: PrepListResult = {
    rows: res.rows ?? [],
    total: res.total ?? 0,
    last_sync_at: res.last_sync_at ?? null,
    truncated: res.truncated ?? false,
    last_sync_error: res.last_sync_error ?? null,
    invoicing_available: res.invoicing_available ?? true,
  }
  prepListCache = { key: String(params.includeExcluded), value }
  savePrepCache(cacheCtx.storage, cacheCtx.orgId, params.includeExcluded, value, Date.now())
  return value
}

/** The ROW-SCOPED read: the whole point of the rework. One or a handful of rows, read live and
 *  patched into the list in place, so a status change re-renders one row instead of the grid. */
async function fetchPrepRows(orderKeys: string[]): Promise<PrepRow[]> {
  const res = await app.invokeTool<{ rows: PrepRow[] }>("prep_list", { order_keys: orderKeys })
  return res.rows ?? []
}

// Module-level stale-while-revalidate cache: the tab is destroyed when the
// operator navigates away, so a return visit remounted onto a blank grid and
// re-ran the prep_list from scratch. A revisit now renders the last fetched
// worklist instantly while a background refetch replaces it.
let prepListCache: { key: string; value: PrepListResult } | null = null

const InboxIcon: Component = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </svg>
)

// ── Row-state badge (ready / needs fix / quote missing) ─────────────────────
// A recipient-phone issue overrides the visual state: shipping this row is doomed
// to a carrier rejection until the contact phone is fixed, whatever the quote says.
/**
 * Reasons a re-check can plausibly clear on its own, because the blocking value
 * is DERIVED at draft time rather than typed by a human. The customs EUR amount
 * is the case that motivated this: it is read off the linked Shopify order's own
 * rate, so a row blocked while that lookup was broken clears the moment the row
 * is resolved again -- no data entry required. A missing weight or HS code, by
 * contrast, needs a catalog edit first, so offering "Recheck" there would just
 * promise something the button cannot deliver.
 */
const RECHECKABLE_REASONS: ReadonlySet<string> = new Set([
  "Customs value needs a manual EUR amount",
  "Missing customs value",
])

export function reasonIsRecheckable(reason: string | undefined): boolean {
  return reason !== undefined && RECHECKABLE_REASONS.has(reason)
}

// ── Shipping estimate cell: effective (chosen) offer + an offer picker dropdown ──
const ShippingEstimateCell: Component<{
  row: PrepRow
  testid: string
  busy: boolean
  onSelect: (offerCode: string) => void
}> = (props) => {
  const quote = () => props.row.quote
  const offers = () => quote().offers
  // The offer the row will STAGE: the operator's choice, else the cheapest.
  const shown = () => quote().selected ?? quote().cheapest
  const stale = () => quote().stale
  // The <select> reflects the persisted choice, falling back to the cheapest so the picker always
  // shows what staging would use.
  const selectedValue = () => quote().selected_offer_code ?? quote().cheapest?.offer_code ?? ""

  return (
    <div class="inline-flex flex-col items-end gap-0.5" data-testid={props.testid}>
      <Show
        when={shown()}
        fallback={
          <span class="text-[12px] text-text-tertiary" data-testid={`${props.testid}-missing`}>
            No quote yet
          </span>
        }
      >
        {(offer) => (
          <div class="flex items-center gap-1">
            {/* nowrap + shrink-0: the shipping price is a MONEY VALUE and was being broken
                across two lines by the flex row ("7.80" over "EUR", visible on every quoted row
                of the 2026-09-08 captures). A number split at its currency is not a number
                anyone reads at a glance, and the column already has the width for it. */}
            <span class="shrink-0 whitespace-nowrap font-mono tabular-nums text-text">
              {formatMoneyMinor(offer().price_ht_minor, offer().currency)}
            </span>
            {/* The carrier COLLAPSED to its mark, and that mark IS the offer
                picker: the real <select> sits transparently on top of it at the
                same size, so the row keeps a native, keyboard-operable,
                screen-reader-named control while costing ~26px instead of the
                carrier spelled out plus a 140px dropdown. The focus ring is
                drawn by the wrapper because the control itself is invisible.

                AFFORDANCE (2026-09-08). The first cut of that collapse was a
                wordmark with an invisible select on top and nothing else, so
                the cheapest control on the row looked exactly like a static
                logo: no caret, no border, no hover ground, no pointer cursor.
                The owner read it as decoration. It now carries all four -- a
                caret glyph that says a list opens, a border and a ground that
                appear on hover (of the WRAPPER, via `group/offer`, so hovering
                the wordmark counts), and `cursor-pointer` on the whole trigger.
                The caret is aria-hidden and role-less: the wordmark keeps the
                only `role="img"` in the cell, so the control's accessible name
                and the grid's oracle are both untouched. */}
            <span
              class={cx(
                "group/offer relative inline-flex items-center gap-0.5 rounded-md border border-transparent px-0.5 transition-colors",
                offers().length > 0
                  ? "cursor-pointer hover:border-border hover:bg-surface-hover focus-within:border-accent-border focus-within:ring-2 focus-within:ring-accent-tint"
                  : "",
              )}
              data-testid={`${props.testid}-offer-trigger`}
            >
              <CarrierLogo carrier={offer().carrier} />
              <Show when={offers().length > 0}>
                <CaretIcon class="shrink-0 text-text-tertiary transition-colors group-hover/offer:text-text" />
                <select
                  class="absolute inset-0 h-full w-full cursor-pointer appearance-none border-0 bg-transparent p-0 text-[10.5px] opacity-0 disabled:cursor-not-allowed"
                  data-testid={`${props.testid}-offer-select`}
                  value={selectedValue()}
                  disabled={props.busy}
                  title="Choose which offer to ship this order with"
                  aria-label={`Carrier and offer: ${formatOfferOption(offer())}. Choose which offer to ship this order with.`}
                  onChange={(e) => props.onSelect(e.currentTarget.value)}
                >
                  <For each={offers()}>
                    {(o) => <option value={o.offer_code}>{formatOfferOption(o)}</option>}
                  </For>
                </select>
              </Show>
            </span>
            <Badge
              tone={offer().is_pickup_point ? "warning" : "neutral"}
              class="!px-1"
              testid={`${props.testid}-mode`}
            >
              {offer().is_pickup_point ? "Relay" : "Home"}
            </Badge>
            <Show when={stale()}>
              <Badge tone="warning" testid={`${props.testid}-stale`}>
                Stale
              </Badge>
            </Show>
          </div>
        )}
      </Show>
      {/* No quote yet, but offers exist (a stale set with neither a chosen nor a
          cheapest offer): keep the picker reachable as a plain select. */}
      <Show when={!shown() && offers().length > 0}>
        <select
          class={cx(inputClass, "!w-[110px] px-1 py-1 text-[10.5px]")}
          data-testid={`${props.testid}-offer-select`}
          value={selectedValue()}
          disabled={props.busy}
          title="Choose which offer to ship this order with"
          aria-label="Choose which offer to ship this order with"
          onChange={(e) => props.onSelect(e.currentTarget.value)}
        >
          <For each={offers()}>
            {(o) => <option value={o.offer_code}>{formatOfferOption(o)}</option>}
          </For>
        </select>
      </Show>
    </div>
  )
}

/**
 * A numeric field that does not fight the operator's keystrokes.
 *
 * The dims/weight cells used to be `<input type="number">` bound straight to the
 * numeric model: every keystroke ran `Number(el.value)` back into the signal,
 * and the signal then wrote itself back onto the element. That round-trip
 * destroys any input the browser cannot parse YET. A number input reports
 * `value === ""` for a half-typed decimal ("0.", "1."), so typing "0.5" went
 * 0. -> "" -> Number("") = 0 -> the field was rewritten to "0", and the "5"
 * landed on that: 5 kg instead of 0.5. `Number()` also normalises a trailing
 * zero away, so "4.0" collapsed to "4" mid-typing (ticket-10220, ticket-10196).
 *
 * So: hold the RAW text while the field has focus and only parse it, never
 * write back over it. On blur the raw text is dropped and the field re-renders
 * from the model, which is what makes an out-of-band change (a resync, a
 * package-count change) still show up. `type="text"` + `inputmode="decimal"` is
 * deliberate: it is the only way to see what was actually typed, and it still
 * brings up the numeric keypad on touch.
 */
const NumberField: Component<{
  value: number
  onValue: (n: number) => void
  disabled?: boolean
  class?: string
  ariaLabel: string
  testid: string
}> = (props) => {
  const [raw, setRaw] = createSignal<string | null>(null)
  const shown = (): string => raw() ?? String(props.value)
  return (
    <input
      type="text"
      inputmode="decimal"
      class={props.class}
      value={shown()}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      data-testid={props.testid}
      onInput={(e) => {
        const text = e.currentTarget.value
        setRaw(text)
        const n = parseNumericInput(text)
        if (n !== null) props.onValue(n)
      }}
      onBlur={() => setRaw(null)}
    />
  )
}

/** Parse what the operator typed, or null when it is not (yet) a number. A
 *  comma is accepted as the decimal separator: this is a French-keyboard shop
 *  and the numeric keypad's separator is a comma. */
export function parseNumericInput(text: string): number | null {
  const t = text.trim().replace(",", ".")
  if (t === "" || !/^\d*\.?\d*$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// ── Package cell: dims + weight + package count, committed on demand ───────
//
// Edits stay local until the operator presses "Refresh quote": that one button
// persists the carton via set_package AND re-quotes the row. Nothing here talks
// to Boxtal on blur.
const PackageCell: Component<{
  row: PrepRow
  busy: boolean
  onCommit: (draft: PackageDraft) => void
}> = (props) => {
  const persisted = () => packageDraftOf(props.row)
  const [draft, setDraft] = createSignal<PackageDraft>(persisted())
  // EVERY row starts COLLAPSED to the dense summary line (packageSummaryLine).
  // This cell no longer owns a column: it is the third line of the Total cell's
  // stack (money, shipping estimate, cartons), because a standalone Packages
  // column could not fit before the sticky Actions cell at all -- measured at
  // 1440x900 with the agent panel open, 316px of the grid's 1128px of content
  // overflowed an 812px viewport and the column rendered entirely under the
  // sticky cell or past the right edge. The summary line carries what a
  // scannable read needs (dims, weight, count, "mixed" when the cartons
  // differ) and the full per-carton breakdown is one hover away via its
  // `title`. The toggle still opens the per-carton editor by hand for anyone
  // who needs to change a dimension.
  const [expanded, setExpanded] = createSignal(false)

  const cartons = () => draft().cartons
  const count = () => cartons().length
  const dirty = createMemo(() => packageDraftChanged(props.row, draft()))
  const valid = createMemo(() => packageDraftValid(draft()))

  const patchCarton = (index: number, patch: Partial<CartonDraft>): void => {
    setDraft((d) => setCarton(d, index, patch))
  }

  const changeCount = (next: number): void => {
    setDraft((d) => setCartonCount(d, next))
    // Growing a uniform set is still uniform, so the compact row stays honest;
    // but any set of 2+ is worth opening so the operator can see what they got.
    if (next > 1) setExpanded(true)
  }

  // A clean row still re-quotes: persisting an unchanged carton is a no-op on
  // the server and the resync that follows is the whole point of the press.
  const commit = () => {
    if (!valid()) return
    props.onCommit(draft())
  }

  const ref = props.row.order_key

  return (
    <div class="flex flex-col items-end gap-1">
      <div class="flex items-center gap-1">
        {/* Collapsed summary of the whole set: ONE dense line at rest so it
            fits as a line of the Total cell, e.g. "2x 58x36x7cm 1.8kg" for a
            uniform set or "mixed (3)" once the cartons differ.
            The full per-carton breakdown (packageDetailTitle) rides the
            native `title` tooltip rather than taking column width. */}
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-sm px-1 py-1 text-left text-[11px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
          aria-expanded={expanded()}
          data-testid={`boxtal-prep-package-toggle-${ref}`}
          title={expanded() ? "Hide the per-package detail" : packageDetailTitle(draft())}
          onClick={() => setExpanded((v) => !v)}
        >
          <span
            aria-hidden="true"
            class="font-mono text-[10px] text-text-tertiary transition-transform duration-150"
            classList={{ "rotate-90": expanded() }}
          >
            ›
          </span>
          <span class="font-mono" data-testid={`boxtal-prep-package-summary-${ref}`}>
            {packageSummaryLine(draft())}
          </span>
        </button>
      </div>

      {/* The count select and the commit button only cost column width while
          the row is open for editing, so they move in with the per-carton
          list rather than sitting on the collapsed line. */}
      <Show when={expanded()}>
        <div class="flex items-center gap-1 pl-4">
          {/* How many cartons ship. Growing clones the LAST carton rather than
              replacing the set with copies of the first, so a mixed shipment
              keeps every carton it already had. */}
          <select
            class={cx(inputClass, "!w-28 px-1 py-1")}
            value={String(count())}
            disabled={props.busy}
            aria-label="Number of packages"
            title="How many cartons ship together"
            data-testid={`boxtal-prep-package-count-${ref}`}
            onChange={(e) => changeCount(Number(e.currentTarget.value))}
          >
            <For each={packageCountOptions(persisted().cartons.length)}>
              {(n) => <option value={String(n)}>{packageCountLabel(n)}</option>}
            </For>
          </select>

          {/* Always present while expanded. It used to appear only once the
              carton had CHANGED, which made re-quoting an unchanged row
              impossible: an operator who just wants a fresh price (a stale
              quote, a carrier that has since re-rated the route) had no
              control to press, and the only way to get one was to edit a
              dimension and edit it back (ticket-10222). Primary while there
              are unsaved edits, quiet otherwise. */}
          <Button
            variant={dirty() ? "primary" : "secondary"}
            class="ml-2 whitespace-nowrap px-2 py-1 text-[11.5px]"
            disabled={props.busy || !valid()}
            title={
              !valid()
                ? "Every dimension and weight, on every package, must be greater than zero"
                : dirty()
                  ? "Save these packages and get a fresh quote"
                  : "Get a fresh quote for this row"
            }
            testid={`boxtal-prep-refresh-quote-${ref}`}
            onClick={commit}
          >
            {props.busy ? "Quoting…" : dirty() ? "Refresh quote" : "Quote"}
          </Button>
        </div>
      </Show>

      {/* One editable line per carton. Each owns its own dims and weight, which
          is what a real multi-box shipment needs (a 20 kg master carton plus
          three 0.8 kg accessory boxes is the normal shape, not the exception). */}
      <Show when={expanded()}>
        <div class="flex flex-col gap-1 pl-4" data-testid={`boxtal-prep-package-list-${ref}`}>
          {/* <Index>, NOT <For>. <For> keys rows by object REFERENCE, and patchCarton
              builds a NEW carton object on every keystroke -- so the edited row's
              DOM subtree was destroyed and rebuilt on each character, the focused
              <input> was replaced by a fresh element, and every keystroke after
              the first landed on nothing. Typing "40" left "4"; typing "0.5" left
              "0" (prod, verified on the deployed build 2026-08-27). <Index> keys
              by POSITION and hands the item as an accessor, so the input element
              survives its own value changing. The carton list is a fixed-position
              set of editable fields, which is exactly what <Index> is for. */}
          <Index each={cartons()}>
            {(carton, i) => (
              <div class="flex items-center gap-1" data-testid={`boxtal-prep-package-${ref}-${i}`}>
                <span class="w-10 shrink-0 text-[10px] text-text-tertiary">#{i + 1}</span>
                <NumberField
                  class={cx(inputClass, "!w-14 px-1.5 py-1 text-right")}
                  value={carton().length}
                  disabled={props.busy}
                  ariaLabel={`Package ${i + 1} length in cm`}
                  testid={`boxtal-prep-length-${ref}-${i}`}
                  onValue={(n) => patchCarton(i, { length: n })}
                />
                <span class="text-text-tertiary">x</span>
                <NumberField
                  class={cx(inputClass, "!w-14 px-1.5 py-1 text-right")}
                  value={carton().width}
                  disabled={props.busy}
                  ariaLabel={`Package ${i + 1} width in cm`}
                  testid={`boxtal-prep-width-${ref}-${i}`}
                  onValue={(n) => patchCarton(i, { width: n })}
                />
                <span class="text-text-tertiary">x</span>
                <NumberField
                  class={cx(inputClass, "!w-14 px-1.5 py-1 text-right")}
                  value={carton().height}
                  disabled={props.busy}
                  ariaLabel={`Package ${i + 1} height in cm`}
                  testid={`boxtal-prep-height-${ref}-${i}`}
                  onValue={(n) => patchCarton(i, { height: n })}
                />
                <span class="ml-1 text-[10px] text-text-tertiary">cm</span>
                {/* Tenths of a kg: real parcels are not whole numbers
                    (ticket-10196), and typing one now survives (ticket-10220). */}
                <NumberField
                  class={cx(inputClass, "ml-2 !w-16 px-1.5 py-1 text-right")}
                  value={carton().weight}
                  disabled={props.busy}
                  ariaLabel={`Package ${i + 1} weight in kg`}
                  testid={`boxtal-prep-weight-${ref}-${i}`}
                  onValue={(n) => patchCarton(i, { weight: n })}
                />
                <span class="text-[10px] text-text-tertiary">kg</span>
              </div>
            )}
          </Index>
        </div>
      </Show>
    </div>
  )
}


/** Normalize what the operator typed into what the tool stores: trimmed, empty is null. */
export function noteFromInput(raw: string): string | null {
  const trimmed = raw.trim()
  return trimmed === "" ? null : trimmed
}

/** True when the typed text would change the stored note (so a blur with no edit saves nothing). */
export function noteChanged(current: string | null, raw: string): boolean {
  return (current ?? "") !== (noteFromInput(raw) ?? "")
}

/** The Shopify staff note, edited in place. ALWAYS a visible field (placeholder "Staff note"),
 *  never a click-to-reveal line: the first cut hid it as a 10px italic "Add note" under the order
 *  date and the operator could not find it. One row at rest, three while focused; saves on blur
 *  and on Cmd/Ctrl+Enter, Escape puts the row's value back. An order-less row has no order note. */
const NoteCell: Component<{
  row: PrepRow
  busy: boolean
  onSave: (note: string | null) => void
}> = (props) => {
  const [focused, setFocused] = createSignal(false)
  const current = () => props.row.staff_note ?? ""
  const commit = (el: HTMLTextAreaElement): void => {
    setFocused(false)
    if (!noteChanged(props.row.staff_note, el.value)) return
    props.onSave(noteFromInput(el.value))
  }
  return (
    <Show when={props.row.order_key.startsWith("so:")}>
      <textarea
        class={cx(
          inputClass,
          "mt-1 !w-[150px] min-w-[150px] resize-none px-1.5 py-0.5 text-[11px] leading-[1.3]",
          current() && !focused() ? "border-accent-border bg-accent-tint" : "",
        )}
        rows={focused() ? 3 : 1}
        value={current()}
        placeholder="Staff note"
        aria-label="Shopify staff note"
        title={current() || "Internal note on the Shopify order (what Shopify admin shows as the order note). Saved when you leave the field."}
        disabled={props.busy}
        data-testid={`boxtal-prep-note-${props.row.order_key}`}
        onFocus={() => setFocused(true)}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.currentTarget.value = current()
            e.currentTarget.blur()
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
    </Show>
  )
}

/** A sortable column header. The arrow is rendered ALWAYS on the active column
 *  and only on hover elsewhere, so the header row does not change width when the
 *  cursor crosses it -- the same layout-shift trap that made the Home approval
 *  buttons resize under the cursor (ticket-10226). */
/**
 * The prep grid is a comparison table, so at phone width it declares which
 * columns survive rather than collapsing to cards (spec-responsive.md). The
 * ones that do not survive stay in the DOM and are revealed by the row's own
 * phone expand, so no cell markup is duplicated for a second layout.
 */
export interface PrepGridColumn {
  key: string
  header: string
  survivesPhone?: boolean
}

export const PREP_GRID_COLUMNS: PrepGridColumn[] = [
  { key: "status", header: "Status" },
  { key: "order", header: "Order", survivesPhone: true },
  { key: "client", header: "Client", survivesPhone: true },
  { key: "country", header: "Country" },
  { key: "products", header: "Products" },
  { key: "total", header: "Total" },
  { key: "category", header: "Category" },
  { key: "document", header: "Document" },
  { key: "actions", header: "Actions", survivesPhone: true },
]

const SortTh: Component<{
  label: string
  sortKey: PrepSortKey
  active: PrepSort | null
  right?: boolean
  class?: string
  onSort: (k: PrepSortKey) => void
}> = (props) => {
  const on = () => props.active?.key === props.sortKey
  return (
    <Th
      right={props.right}
      pad="tight"
      class={cx("sticky top-0 z-10 border-b border-border bg-bg", props.class)}
    >
      <button
        type="button"
        class="group/sort inline-flex items-center gap-1 uppercase tracking-wider hover:text-text"
        classList={{ "text-text": on(), "flex-row-reverse": props.right }}
        data-testid={`boxtal-prep-sort-${props.sortKey}`}
        data-active={on() ? props.active!.dir : undefined}
        title={`Sort by ${props.label.toLowerCase()}`}
        onClick={() => props.onSort(props.sortKey)}
      >
        <span>{props.label}</span>
        {/* Dimmed at rest, never invisible. The first cut hid this at
            opacity-0 until hover, which makes a sortable column look exactly
            like a fixed one: nobody discovers a control they cannot see. That
            is the same defect as ticket-10174 on the Home rows, which was fixed
            three commits ago -- and I reintroduced it here. Caught by looking at
            the rendered grid rather than at the class list. */}
        <span
          aria-hidden="true"
          class="font-mono text-[9px] transition-opacity"
          classList={{ "opacity-100": on(), "opacity-40 group-hover/sort:opacity-100": !on() }}
        >
          {on() && props.active!.dir === "desc" ? "\u25BC" : "\u25B2"}
        </span>
      </button>
    </Th>
  )
}

// ── Row cells: invoice, quote, ship, label ──────────────────────────────────

const InvoiceCell: Component<{
  row: PrepRow
  busy: boolean
  onDownload: () => void
}> = (props) => {
  const c = () => invoiceControlState(props.row)
  const testid = () => `boxtal-prep-invoice-${props.row.order_key}`
  return (
    <div class="flex items-center gap-0.5" data-testid={testid()} data-state={c().state}>
      <span title={c().tooltip}>
        {/* nowrap: the pill's text is the document NUMBER, and a number broken
            across two lines at its own hyphen ("INV-2026-" / "3493") is not a
            number an operator can cross-check at a glance. */}
        <Badge
          class="whitespace-nowrap !px-1"
          tone={c().state === "issued" ? "success" : c().state === "missing" ? "muted" : "warning"}
          testid={`${testid()}-pill`}
        >
          {c().label}
        </Badge>
      </span>
      <Show when={c().canDownload}>
        <Button
          variant="ghost"
          class="!px-1 py-0.5 text-[11px]"
          disabled={props.busy}
          title="Open the document as a PDF"
          ariaLabel="Download the shipping document"
          testid={`boxtal-prep-invoice-download-${props.row.order_key}`}
          onClick={() => props.onDownload()}
        >
          PDF
        </Button>
      </Show>
      <Show when={c().showApprovalsLink}>
        <Button
          variant="ghost"
          class="!px-1 py-0.5 text-[11px]"
          title="Open the Approvals tab"
          testid={`boxtal-prep-invoice-approvals-${props.row.order_key}`}
          onClick={() => navigate("/approvals")}
        >
          Approvals
        </Button>
      </Show>
    </div>
  )
}

const QuoteCell: Component<{ row: PrepRow; busy: boolean; onQuote: () => void }> = (props) => {
  const q = () => quoteButtonState(props.row)
  return (
    <Button
      variant="secondary"
      class="whitespace-nowrap px-1.5 py-1 text-[11.5px]"
      disabled={props.busy || q().disabled}
      title={q().tooltip}
      testid={`boxtal-prep-quote-${props.row.order_key}`}
      onClick={() => props.onQuote()}
    >
      {props.busy ? "Working" : q().label}
    </Button>
  )
}

const ShipCell: Component<{
  row: PrepRow
  busy: boolean
  error: string | null
  /** This session parked the purchase and its requester may not decide it. */
  pending: boolean
  /** The pending label purchase for this row, from the boxtal approvals feed. */
  approval: ApprovalRow | null
  note: string | null
  onShip: () => void
  onDecide: (decision: "approve" | "deny") => void
}> = (props) => {
  const blocked = () => shipDisabledReason(props.row)
  const [open, setOpen] = createSignal(false)
  const card = () => (props.approval ? approvalCardText(props.approval) : null)
  return (
    <div class="flex flex-col items-end gap-1">
      <Show
        when={props.approval}
        fallback={
          <Show
            when={!props.pending}
            fallback={
              <span title="Sent for approval. No label is bought until someone who can approve label purchases approves it.">
                <Badge tone="warning" testid={`boxtal-prep-ship-pending-${props.row.order_key}`}>
                  Pending approval
                </Badge>
              </span>
            }
          >
            <Button
              variant="primary"
              class="whitespace-nowrap px-1.5 py-1 text-[11.5px]"
              disabled={props.busy || !canShip(props.row)}
              title={blocked() ?? "Buy the label for this parcel"}
              testid={`boxtal-prep-ship-${props.row.order_key}`}
              onClick={() => props.onShip()}
            >
              {props.busy ? "Working" : "Ship"}
            </Button>
          </Show>
        }
      >
        {/* A label purchase waiting for a decision, decided HERE: what is bought is on the card. */}
        <div
          class="flex max-w-[260px] flex-col items-end gap-1 text-right"
          data-testid={`boxtal-prep-ship-approval-${props.row.order_key}`}
        >
          <button
            type="button"
            class="text-[11px] font-medium text-warning underline-offset-2 hover:underline"
            aria-expanded={open()}
            data-testid={`boxtal-prep-ship-approval-toggle-${props.row.order_key}`}
            onClick={() => setOpen(!open())}
          >
            {open() ? "Hide what is bought" : "Label waiting for approval"}
          </button>
          <Show when={open()}>
            <div
              class="rounded-md border border-border bg-surface px-2 py-1 text-left text-[11px] text-text-secondary"
              data-testid={`boxtal-prep-ship-approval-card-${props.row.order_key}`}
            >
              <div class="font-medium text-text">{card()!.title}</div>
              <For each={card()!.lines}>{(line) => <div>{line}</div>}</For>
              <Show when={card()!.requester}>
                <div class="mt-1 text-text-tertiary">Asked by {card()!.requester}</div>
              </Show>
            </div>
          </Show>
          <div class="flex gap-1">
            <Button
              variant="ghost"
              class="whitespace-nowrap px-1.5 py-1 text-[11.5px]"
              disabled={props.busy}
              title="Decline: no label is bought"
              testid={`boxtal-prep-ship-decline-${props.row.order_key}`}
              onClick={() => props.onDecide("deny")}
            >
              Decline
            </Button>
            <Button
              variant="primary"
              class="whitespace-nowrap px-1.5 py-1 text-[11.5px]"
              disabled={props.busy}
              title={card()!.title}
              testid={`boxtal-prep-ship-approve-${props.row.order_key}`}
              onClick={() => props.onDecide("approve")}
            >
              {props.busy ? "Working" : "Approve and buy"}
            </Button>
          </div>
        </div>
      </Show>
      <Show when={props.note}>
        <span
          class="max-w-[180px] text-right text-[11px] text-text-secondary"
          data-testid={`boxtal-prep-ship-note-${props.row.order_key}`}
        >
          {props.note}
        </span>
      </Show>
      <Show when={props.error}>
        <span
          class="max-w-[180px] text-right text-[11px] text-error"
          data-testid={`boxtal-prep-ship-error-${props.row.order_key}`}
        >
          {props.error}
        </span>
      </Show>
    </div>
  )
}

/** Full wording for the icon-only Label button, per label state. */
function labelButtonTitle(state: ReturnType<typeof labelState>): string {
  if (state === "ready") return "Label: open the carrier label"
  if (state === "check_documents")
    return "Check documents: the label has not arrived. Ask Boxtal for this shipment's documents again."
  return "Label: no label yet, this row has not been shipped."
}

const LabelCell: Component<{
  row: PrepRow
  busy: boolean
  onPrint: () => void
  onCheckDocuments: () => void
}> = (props) => {
  const state = () => labelState(props.row)
  return (
    <Show
      when={state() !== "waiting"}
      fallback={
        <Badge tone="muted" testid={`boxtal-prep-label-${props.row.order_key}`}>
          {LABEL_LABELS.waiting}
        </Badge>
      }
    >
      <Button
        variant={state() === "ready" ? "secondary" : "ghost"}
        class={cx("whitespace-nowrap py-1", state() === "check_documents" ? "px-2 text-[11.5px]" : "!px-1")}
        disabled={props.busy || state() === "disabled"}
        title={labelButtonTitle(state())}
        ariaLabel={LABEL_LABELS[state()]}
        testid={`boxtal-prep-label-${props.row.order_key}`}
        onClick={() => (state() === "ready" ? props.onPrint() : props.onCheckDocuments())}
      >
        {/* ICON ONLY for the two states whose word is just "Label". Quote and
            Ship keep their words (they are the two an operator hunts for), but
            Label's word cost the sticky Actions cell width it did not have, and
            that cell's width is what pushed the Document column underneath it.
            The wording is on `title` and `aria-label`, so hover and a screen
            reader still get the full sentence, and the `data-testid` is
            unchanged. `check_documents` KEEPS its words: it is an exception the
            operator has to notice without hovering, and it is rare enough that
            its width is not what the default view pays for. */}
        <Show when={state() === "check_documents"} fallback={<PrinterIcon />}>
          {LABEL_LABELS.check_documents}
        </Show>
      </Button>
    </Show>
  )
}

// ── The grid ─────────────────────────────────────────────────────────────
export const PrepGrid: Component = () => {
  const [search, setSearch] = createSignal("")
  const [country, setCountry] = createSignal("")
  const [tag, setTag] = createSignal("")
  const [product, setProduct] = createSignal("")
  const [includeExcluded, setIncludeExcluded] = createSignal(false)
  const [busyKeys, setBusyKeys] = createSignal<Set<string>>(new Set())
  const [rowErrors, setRowErrors] = createSignal<Record<string, string>>({})
  const [pendingShips, setPendingShips] = createSignal<Set<string>>(new Set())
  // Pending label purchases by draft id (= the row's document_ref), read from the boxtal approvals
  // feed, so a purchase waiting for a decision is decided on its own row.
  const [shipApprovals, setShipApprovals] = createSignal<Map<string, ApprovalRow>>(new Map())
  const [shipNotes, setShipNotes] = createSignal<Record<string, string>>({})
  const setShipNote = (orderKey: string, note: string | null): void => {
    setShipNotes((prev) => {
      const next = { ...prev }
      if (note) next[orderKey] = note
      else delete next[orderKey]
      return next
    })
  }
  let shipApprovalsLoadedAt = 0
  const loadShipApprovals = async (force = false): Promise<void> => {
    const now = Date.now()
    if (!force && now - shipApprovalsLoadedAt < 5000) return
    shipApprovalsLoadedAt = now
    try {
      const rows = await hostFetch<ApprovalRow[]>(SHIP_APPROVALS_PATH)
      setShipApprovals(pendingShipApprovalsByDraft(Array.isArray(rows) ? rows : []))
    } catch {
      // The grid works without it: the purchase is still in the approvals queue.
    }
  }
  const [pulling, setPulling] = createSignal(false)
  const [refreshingStale, setRefreshingStale] = createSignal(false)
  const [addOpen, setAddOpen] = createSignal(false)

  // Cache identity for this mount: the org id comes out of the access token (never verified here,
  // this is a local performance cache, not an authorization decision -- see prep-cache.ts), and
  // `storage` falls back to an inert no-op when localStorage is unreachable (private mode, a
  // locked-down embed), so every call site below can persist without its own null-check.
  const cacheCtx: PrepCacheCtx = { orgId: decodeOrgIdFromToken(accessToken()), storage: resolveLocalStorage() }

  // Stale-while-revalidate: cache-first paint, live read ALWAYS follows (planPrepListOpen.refreshNow
  // is a constant `true` -- see prep-view-state.ts -- specifically because the previous cache here
  // served once per mount and then sat there for the life of the tab, which is the bug this whole
  // rework replaces: a hard reload used to lose the cache entirely AND a warm one used to stop
  // refreshing after its first paint). `refreshing`/`refreshFailed` drive the banner
  // (gridViewState); `served` still guards "only the FIRST call this mount gets the cache-first
  // treatment" -- a later dependency change (includeExcluded toggling) or an explicit refetch call
  // goes straight to a live read and does not serve cache, which is deliberately unchanged
  // (ticket-10223). The generation guard stops an older in-flight read from putting a stale
  // worklist back on screen once a newer one has landed.
  const [refreshing, setRefreshing] = createSignal(false)
  const [refreshFailed, setRefreshFailed] = createSignal(false)
  let applyFresh: (v: PrepListResult) => void = () => {}
  let served = false
  let generation = 0

  const runBackgroundRefresh = (gen: number): void => {
    setRefreshing(true)
    void fetchPrepList({ includeExcluded: includeExcluded() }, cacheCtx)
      .then((fresh) => {
        if (gen !== generation) return // superseded by a newer read
        applyFresh(fresh)
        setRefreshFailed(false)
      })
      .catch(() => {
        if (gen === generation) setRefreshFailed(true)
      })
      .finally(() => {
        if (gen === generation) setRefreshing(false)
      })
  }

  const [result, { refetch, mutate }] = app.createResource<PrepListResult>(() => {
    const key = String(includeExcluded())
    const gen = ++generation
    if (!served) {
      served = true
      const memCached = prepListCache && prepListCache.key === key ? prepListCache.value : null
      const persisted = memCached ? null : loadPrepCache(cacheCtx.storage, cacheCtx.orgId, includeExcluded())
      const plan = planPrepListOpen(memCached ?? persisted?.value ?? null)
      if (plan.paint) {
        prepListCache = { key, value: plan.paint }
        runBackgroundRefresh(gen)
        return plan.paint
      }
    }
    setRefreshing(true)
    setRefreshFailed(false)
    return fetchPrepList({ includeExcluded: includeExcluded() }, cacheCtx)
      .then((v) => {
        if (gen === generation) setRefreshing(false)
        return v
      })
      .catch((err) => {
        if (gen === generation) {
          setRefreshing(false)
          setRefreshFailed(true)
        }
        throw err
      })
  })
  applyFresh = (v) => (mutate as (v: PrepListResult) => void)(v)
  // `.latest` (not the accessor call) so a failed refresh keeps serving the last known rows
  // instead of throwing: calling `result()` re-throws once `result.error` is set, which is exactly
  // the "wipe the table on any failure" bug this rework removes. Cast: HostResource's TS shape
  // omits `.latest`, but the runtime object is a real Solid resource (host-sdk/src/index.ts), and
  // `.latest` is the same escape hatch already used elsewhere (TicketConversationStream.tsx).
  const latestResult = (): PrepListResult | undefined =>
    (result as unknown as { latest?: PrepListResult }).latest
  const fetchedRows = (): PrepRow[] => latestResult()?.rows ?? []
  const lastSyncAt = (): string | null => latestResult()?.last_sync_at ?? null
  const loadFailed = (): boolean => Boolean(result.error) || refreshFailed()
  // Re-read the pending label purchases whenever the worklist arrives (throttled in the loader), so
  // a purchase an agent staged meanwhile shows up on its row.
  createEffect(() => {
    if (latestResult()) void loadShipApprovals()
  })

  /**
   * Merge freshly read rows into the resource IN PLACE.
   *
   * Every other row object stays referentially identical, so <For> leaves its DOM untouched: this
   * is what makes a row action re-render one row instead of the grid.
   */
  const patchRows = (fresh: PrepRow[], requestedKeys: string[]): void => {
    // `.latest` (via latestResult), not `result()`: a row action can land while an explicit
    // refetch's own error is still set (Pull orders / Refresh stale failed but the operator ticked
    // a status on an unrelated row in the meantime), and `result()` throws once `.error` is set.
    const current = latestResult()
    if (!current) return
    const rows = mergeRows(current.rows, fresh, requestedKeys)
    const value: PrepListResult = { ...current, rows, total: rows.length }
    prepListCache = { key: String(includeExcluded()), value }
    savePrepCache(cacheCtx.storage, cacheCtx.orgId, includeExcluded(), value, Date.now())
    ;(mutate as (v: PrepListResult) => void)(value)
  }

  // Per-row patch fencing: each key's ticket is bumped every time a NEW read for that row starts
  // (a poll tick or a mutation's own reconcile read), and a read only applies if it is still the
  // freshest ticket outstanding when it resolves. Without this, a poll read issued a moment before
  // the operator changes a row can resolve AFTER the mutation's own patch and silently put the
  // pre-mutation row back on screen.
  const patchTickets = new Map<string, number>()
  const patchRow = async (orderKey: string): Promise<void> => {
    const ticket = (patchTickets.get(orderKey) ?? 0) + 1
    patchTickets.set(orderKey, ticket)
    const fresh = await fetchPrepRows([orderKey])
    if (patchTickets.get(orderKey) !== ticket) return // superseded by a newer read for this row
    patchRows(fresh, [orderKey])
  }

  // Batched sibling of patchRow: one prep_list call for several rows instead of one call per row.
  // Used by the poll tick, where several rows can come due on the same 1s tick after a bulk ship;
  // one call per row there fanned N concurrent scoped reads out across the sandbox worker pool.
  const patchRowsBatch = async (orderKeys: string[]): Promise<void> => {
    if (orderKeys.length === 0) return
    const tickets = orderKeys.map((key) => {
      const ticket = (patchTickets.get(key) ?? 0) + 1
      patchTickets.set(key, ticket)
      return [key, ticket] as const
    })
    const fresh = await fetchPrepRows(orderKeys)
    const stillCurrent = new Set(tickets.filter(([key, ticket]) => patchTickets.get(key) === ticket).map(([key]) => key))
    if (stillCurrent.size === 0) return // every row in this batch was superseded by a newer read
    patchRows(fresh.filter((row) => stillCurrent.has(row.order_key)), [...stillCurrent])
  }

  const isBusy = (key: string): boolean => busyKeys().has(key)
  const setRowBusy = (key: string, busy: boolean): void => {
    setBusyKeys((prev) => {
      const next = new Set(prev)
      if (busy) next.add(key)
      else next.delete(key)
      return next
    })
  }
  const setRowError = (key: string, message: string | null): void => {
    setRowErrors((prev) => {
      const next = { ...prev }
      if (message) next[key] = message
      else delete next[key]
      return next
    })
  }

  /**
   * THE refetch rule, enforced rather than remembered.
   *
   * Every mutation goes through here and the plan table decides what happens afterwards: a row
   * action patches its own row, and only the three list-level actions re-read the whole worklist.
   * Adding a row action wired to a refetch means adding it to `mutationPlan` as a refetch, which
   * `prep-row-logic.test.ts` fails on. The mechanism itself lives in prep-row-logic.ts
   * (`createRunMutation`) so it can be driven directly in a test with a stubbed refetch/patchRow.
   */
  const runMutation = createRunMutation({ setRowBusy, setRowError, refetch, patchRow })

  const [sort, setSort] = createSignal<PrepSort | null>(null)
  const onSort = (k: PrepSortKey): void => {
    setSort((cur) => nextSort(cur, k))
  }
  // Derived from the resource value, so an untouched row object keeps its identity through the
  // filter and the sort (both produce a new ARRAY, never new row objects).
  const rows = createMemo(() =>
    sortPrepRows(
      fetchedRows().filter((row) =>
        matchesPrepFilter(row, {
          search: search(),
          country: country(),
          tag: tag(),
          product: product(),
          includeExcluded: includeExcluded(),
        }),
      ),
      sort(),
    ),
  )

  const productChips = createMemo(() => productsSummaryList(fetchedRows()))

  // The refresh banner + empty-state decision: fetchedRows() (unfiltered -- whether the cache/live
  // read has ANY row at all) rather than rows() (post client-side filter), because a filter that
  // hides every row is not the same situation as a refresh that has not landed yet.
  const viewState = createMemo(() =>
    gridViewState({
      hasRows: fetchedRows().length > 0,
      refreshing: refreshing(),
      failed: loadFailed(),
      lastSyncAt: lastSyncAt(),
    }),
  )

  // Row exit transition (mirrors TicketsInbox, apps/web/src/modules/tickets/TicketsInbox.tsx):
  // a refresh that drops or reorders rows must not reflow the table under the operator's pointer.
  // The pure merge/cancel decision is `reconcileExitingRows` (prep-view-state.ts); everything here
  // is the side effect that decision needs (a timer) and the signals the render reads.
  const [exitingKeys, setExitingKeys] = createSignal<Set<string>>(new Set())
  const [displayRows, setDisplayRows] = createSignal<PrepRow[]>([])
  let prevDisplay: PrepRow[] = []
  const exitTimeoutsByKey = new Map<string, ReturnType<typeof setTimeout>>()
  onCleanup(() => {
    for (const t of exitTimeoutsByKey.values()) clearTimeout(t)
  })
  createEffect(() => {
    const current = rows()
    const { merged, toExit, toCancel } = reconcileExitingRows(current, prevDisplay, exitingKeys())
    if (toExit.length > 0 || toCancel.length > 0) {
      setExitingKeys((prev) => {
        const next = new Set(prev)
        for (const key of toCancel) next.delete(key)
        for (const key of toExit) next.add(key)
        return next
      })
      for (const key of toCancel) {
        const t = exitTimeoutsByKey.get(key)
        if (t !== undefined) {
          clearTimeout(t)
          exitTimeoutsByKey.delete(key)
        }
      }
      for (const key of toExit) {
        const t = setTimeout(() => {
          exitTimeoutsByKey.delete(key)
          setExitingKeys((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
          prevDisplay = prevDisplay.filter((r) => r.order_key !== key)
          setDisplayRows(prevDisplay)
        }, EXIT_TRANSITION_MS)
        exitTimeoutsByKey.set(key, t)
      }
    }
    prevDisplay = merged
    setDisplayRows(merged)
  })

  // ACTIONS STICKINESS, decided by the SCROLL CONTAINER, not by the window.
  //
  // The Actions cell is pinned to the right edge and opaque, which is right
  // while the table fits: it marks the edge and keeps Ship reachable. It is
  // WRONG once the table is wider than its container, because then the pinned
  // cell is painted over in-flow content that has nowhere else to go: measured
  // at 1440x900 with the agent panel open, the Document column ended at x
  // 1008.6 against a sticky edge at x 900.6, so 108px of the document number
  // and the Approvals link behind it were under an opaque cell at rest. No
  // column trim absorbs that; the seven remaining columns are already at their
  // content minimums.
  //
  // So below the width where the table fits, Actions becomes a NORMAL last
  // column and the grid scrolls, which is what a table does and which still
  // reaches every action (the charter's rule is that Actions stays REACHABLE,
  // not that it is always pinned). The trigger is `scrollWidth > clientWidth`
  // on the container itself, watched with a ResizeObserver: the agent panel
  // changes this container's width WITHOUT changing the window's, so a
  // viewport-keyed media query would read the wrong number. (A container query
  // would also work, but the app's classes have to exist in the host's compiled
  // Tailwind, and this rule has to survive there.)
  const [scroller, setScroller] = createSignal<HTMLDivElement | null>(null)
  const [actionsSticky, setActionsSticky] = createSignal(true)
  const measureSticky = () => {
    const el = scroller()
    if (!el) return
    setActionsSticky(el.scrollWidth <= el.clientWidth)
  }
  createEffect(() => {
    const el = scroller()
    if (!el || typeof ResizeObserver === "undefined") return
    measureSticky()
    const ro = new ResizeObserver(() => measureSticky())
    ro.observe(el)
    const table = el.querySelector("table")
    if (table) ro.observe(table)
    onCleanup(() => ro.disconnect())
  })
  // Content can change the table's width without changing the container's, and
  // a row count change is the cheapest signal that it did.
  createEffect(() => {
    rows().length
    queueMicrotask(measureSticky)
  })

  // Rows with something genuinely in flight (a label being produced, a PDF rendering) re-read
  // THEMSELVES on a timer, each on ITS OWN cadence and deadline: `pollPlan` names a different
  // intervalMs per reason (5s label, 3s invoice_pdf) and a timeoutMs neither self-enforces. A
  // single fixed-interval tick would ignore both, so a 1s tick tracks, per row, when it first
  // started needing a poll and only actually re-reads it once the plan's own intervalMs has
  // elapsed since the last read, dropping the row once the plan's own timeoutMs is exceeded.
  const pollStarted = new Map<string, PollTickState>()
  const pollTimer = setInterval(() => {
    const now = Date.now()
    const { dueLabelKeys, dueInvoicePdfKeys, timedOutKeys } = pollTick(fetchedRows(), pollStarted, now, isBusy)
    for (const { key, reason } of timedOutKeys) {
      // Deadline reached. Say what happened instead of leaving a spinner that never resolves.
      if (reason === "invoice_pdf" && pendingPdf.has(key)) {
        finishPdf(key, "The document PDF is taking longer than a minute to render. Try again shortly.")
      }
    }
    // The invoice_pdf wait is resolved by re-asking for the FILE: a row re-read cannot see it (the
    // backend never emits `generating`), so patching the row here would just clear the spinner
    // without ever delivering the PDF. Each one is its own call, not batched.
    for (const key of dueInvoicePdfKeys) void retryInvoicePdf(key).catch(() => {})
    // Label rows due on this tick share ONE batched row re-read instead of one call each: several
    // rows can come due on the same tick after a bulk ship, and one call per row there fanned N
    // concurrent scoped reads out across the sandbox worker pool.
    if (dueLabelKeys.length > 0) void patchRowsBatch(dueLabelKeys).catch(() => {})
  }, 1000)
  onCleanup(() => clearInterval(pollTimer))

  const pullOrders = async (): Promise<void> => {
    if (pulling()) return
    setPulling(true)
    try {
      await runMutation("pull_orders", null, async () => {
        await app.invokeTool("prep_sync", {})
      })
    } finally {
      setPulling(false)
    }
  }

  // Scoped counterpart to pullOrders: re-quotes ONLY the rows whose cached quote is stale or
  // missing, so clearing a couple of stale prices does not re-sync the whole worklist.
  const staleRefs = createMemo(() => staleQuoteRefs(fetchedRows()))
  const refreshStale = async (): Promise<void> => {
    const refs = staleRefs()
    if (refreshingStale() || refs.length === 0) return
    setRefreshingStale(true)
    try {
      await runMutation("refresh_stale", null, async () => {
        await app.invokeTool("prep_sync", { document_refs: refs })
      })
    } finally {
      setRefreshingStale(false)
    }
  }

  const quoteRow = (row: PrepRow): Promise<void> =>
    runMutation("quote", row.order_key, async () => {
      if (!row.document_ref) return
      await app.invokeTool("prep_sync", { document_refs: [row.document_ref] })
    })

  // A person's pick between the order's address and the verified one (the Address differs fold).
  // The tool is gated with no auto-approve: this click by a person IS the decision.
  const pickAddress = (row: PrepRow, pick: PrepAddressPick): Promise<void> =>
    runMutation("address_choice", row.order_key, async () => {
      if (!row.document_ref) return
      await app.invokeTool("prep_set_address_choice", {
        document_ref: row.document_ref,
        choice: pick,
        ...(pick === "verified" && row.address_check?.verified_address?.id
          ? { address_id: row.address_check.verified_address.id }
          : {}),
      })
    })

  const selectOffer = (row: PrepRow, offerCode: string): Promise<void> =>
    runMutation("select_offer", row.order_key, async () => {
      if (!row.document_ref) return
      await app.invokeTool("prep_select_offer", { document_ref: row.document_ref, offer_code: offerCode })
    })

  // Status applies OPTIMISTICALLY: the row tint and the select's own value must not lag a whole
  // round trip behind the click. `patchRows` flips it locally before the tool call, and the
  // post-call `patchRow` inside runMutation overwrites it with the authoritative row; on failure
  // the tool call's own catch below puts the previous row straight back.
  const setStatus = (row: PrepRow, status: PrepStatus): Promise<void> => {
    const previous = row
    patchRows([{ ...row, status, validated: status === "validated" }], [row.order_key])
    return runMutation("set_status", row.order_key, async () => {
      try {
        await app.invokeTool("prep_set_status", { order_key: row.order_key, status })
      } catch (err) {
        patchRows([previous], [row.order_key])
        throw err
      }
    })
  }

  // The Shopify order's internal staff note. Saved with a compare-and-set on the note the row
  // showed when the edit started, so an edit made in Shopify admin meanwhile is surfaced on the
  // row (and re-read by patchRow) instead of overwritten. The textarea is uncontrolled while the
  // operator types; the authoritative value comes back with the post-call row patch.
  const setNote = (row: PrepRow, note: string | null): Promise<void> =>
    runMutation("set_note", row.order_key, async () => {
      const res = await app.invokeTool<{
        ok?: boolean
        reason?: string
        current_note?: string | null
        error?: { message: string }
      }>("prep_set_note", { order_key: row.order_key, note, expected_note: row.staff_note })
      if (res?.error?.message) {
        setRowError(row.order_key, res.error.message)
      } else if (res?.ok === false) {
        setRowError(
          row.order_key,
          `Not saved: the note was changed in Shopify meanwhile (now "${res.current_note ?? ""}"). Edit again from the fresh value.`,
        )
      }
    })

  const setCategory = (row: PrepRow, category: PrepCategory): Promise<void> =>
    runMutation("set_category", row.order_key, async () => {
      const res = await app.invokeTool<{ error?: { message: string } }>("prep_set_category", {
        order_key: row.order_key,
        category,
      })
      if (res?.error?.message) setRowError(row.order_key, res.error.message)
    })

  // Persist the operator's staged carton AND re-quote the row: the single effect of the row's
  // package button. A multi-package draft rides as `quantity`, which set_package expands.
  const setPackage = (row: PrepRow, draft: PackageDraft): Promise<void> =>
    runMutation("set_package", row.order_key, async () => {
      if (!row.document_ref) return
      await app.invokeTool("shipment_draft_set_package", {
        draft_id: row.document_ref,
        override: packageOverridePayload(draft),
      })
      await app.invokeTool("prep_sync", { document_refs: [row.document_ref] })
    })

  // Exclusion also applies optimistically: `matchesPrepFilter` hides an excluded row client-side
  // the instant `excluded` flips, so the row leaves the grid on the click rather than on the
  // response. On failure it comes straight back via the same revert as setStatus above.
  const excludeRow = (row: PrepRow): Promise<void> => {
    const previous = row
    patchRows([{ ...row, excluded: true }], [row.order_key])
    return runMutation("exclude", row.order_key, async () => {
      try {
        await app.invokeTool("prep_exclude", { order_key: row.order_key })
      } catch (err) {
        patchRows([previous], [row.order_key])
        throw err
      }
    })
  }

  const restoreRow = (row: PrepRow): Promise<void> => {
    const previous = row
    patchRows([{ ...row, excluded: false }], [row.order_key])
    return runMutation("restore", row.order_key, async () => {
      try {
        await app.invokeTool("prep_restore", { order_key: row.order_key })
      } catch (err) {
        patchRows([previous], [row.order_key])
        throw err
      }
    })
  }

  const shipRow = (row: PrepRow): Promise<void> => {
    const params = shipParams(row)
    if (!params) return Promise.resolve()
    return runMutation("ship", row.order_key, async () => {
      setShipNote(row.order_key, null)
      const outcome = shipOutcome(
        await app.invokeTool<unknown>("create_shipment", params as unknown as Record<string, unknown>),
      )
      if (outcome.kind === "pending") {
        // Parked, NOT bought: the row stays. Whoever may decide it does so on this row.
        if (!outcome.requesterCanApprove) setPendingShips((prev) => new Set(prev).add(row.order_key))
        await loadShipApprovals(true)
        return
      }
      if (outcome.kind === "error") {
        setRowError(row.order_key, outcome.message)
        return
      }
      // Shipped. Evict this row from the persisted cache right away so a reload straight after
      // never repaints it -- belt and braces only, `create_shipment` already hard-refuses a
      // duplicate shipment server-side (shipment.ts, code "duplicate").
      evictShippedRowFromCache(cacheCtx.storage, cacheCtx.orgId, row.order_key, Date.now())
    })
  }

  // The one decision for a parked label purchase, taken on its row. Approving runs the purchase
  // with the decider's authority, and everything it sets off runs under that same decision.
  const decideShip = (row: PrepRow, approval: ApprovalRow, decision: "approve" | "deny"): Promise<void> =>
    runMutation("ship", row.order_key, async () => {
      setShipNote(row.order_key, null)
      try {
        const result = await hostFetch<unknown>(decidePath(approval.id), {
          method: "POST",
          body: JSON.stringify(decideBody(approval, decision)),
        })
        setShipNote(row.order_key, decisionNote(decision, result))
        setPendingShips((prev) => {
          const next = new Set(prev)
          next.delete(row.order_key)
          return next
        })
        if (decision === "approve" && (result as { status?: unknown } | null)?.status === "approved") {
          evictShippedRowFromCache(cacheCtx.storage, cacheCtx.orgId, row.order_key, Date.now())
        }
      } catch (err) {
        setRowError(row.order_key, err instanceof Error ? err.message : "The decision did not go through.")
      } finally {
        await loadShipApprovals(true)
      }
    })

  const checkDocuments = (row: PrepRow): Promise<void> =>
    runMutation("check_documents", row.order_key, async () => {
      if (!row.shipment) return
      await app.invokeTool("get_documents", { id: row.shipment.id })
    })

  // Both file opens pre-open their tab INSIDE the click gesture, before any await: opening it after
  // the tool call is outside the gesture and the popup blocker swallows it silently.
  // A document whose PDF has not rendered yet is a WAIT, not a failure. The row enters the
  // `generating` invoice state (spinner on the pill), `pollPlan` gives that state its own cadence
  // (3s, 60s deadline) and the poll retries the SAME download until the file exists, then loads it
  // into the tab opened by the original click. The backend never emits `generating` -- deciding it
  // for every row would cost one documents_download_pdf per row, the O(rows) cost this rework
  // removed -- so it is entered here, by the interaction that actually needs the file.
  const pendingPdf = new Map<string, { win: Window | null; documentRef: string | null }>()

  const setInvoiceState = (row: PrepRow, state: PrepInvoiceState): void => {
    patchRows([{ ...row, invoice: { ...row.invoice, state } }], [row.order_key])
  }

  const requestInvoicePdf = async (orderKey: string, documentRef: string | null): Promise<
    { done: true } | { done: false; error?: string }
  > => {
    const res = await app.invokeTool<{ file_id?: string | null; generating?: boolean; error?: string }>(
      "prep_document_pdf",
      { order_key: orderKey, ...(documentRef ? { document_ref: documentRef } : {}) },
    )
    if (res?.file_id) {
      const pending = pendingPdf.get(orderKey)
      await loadFileInto(res.file_id, pending?.win ?? null, "invoice")
      return { done: true }
    }
    if (res?.generating) return { done: false }
    return { done: false, error: res?.error ?? "The document PDF could not be produced." }
  }

  const finishPdf = (orderKey: string, error?: string): void => {
    const pending = pendingPdf.get(orderKey)
    if (error) pending?.win?.close()
    pendingPdf.delete(orderKey)
    if (error) setRowError(orderKey, error)
    void patchRow(orderKey).catch(() => {})
  }

  const downloadInvoice = (row: PrepRow): void => {
    const win = openPreparingTab()
    const documentRef = row.invoice.document_id ?? null
    pendingPdf.set(row.order_key, { win, documentRef })
    setRowError(row.order_key, null)
    void (async () => {
      try {
        const res = await requestInvoicePdf(row.order_key, documentRef)
        if (res.done) {
          finishPdf(row.order_key)
          return
        }
        if (res.error) {
          finishPdf(row.order_key, res.error)
          return
        }
        // Still rendering: show it and let the poll finish the job.
        setInvoiceState(row, "generating")
      } catch (err) {
        finishPdf(row.order_key, err instanceof Error ? err.message : String(err))
      }
    })()
  }

  /** One poll attempt for a row whose PDF was still rendering when the operator asked for it. */
  const retryInvoicePdf = async (orderKey: string): Promise<void> => {
    const pending = pendingPdf.get(orderKey)
    if (!pending) return
    try {
      const res = await requestInvoicePdf(orderKey, pending.documentRef)
      if (res.done) finishPdf(orderKey)
      else if (res.error) finishPdf(orderKey, res.error)
    } catch (err) {
      finishPdf(orderKey, err instanceof Error ? err.message : String(err))
    }
  }

  const printLabel = (row: PrepRow): void => {
    const win = openPreparingTab()
    void (async () => {
      try {
        const res = await app.invokeTool<{ label?: { file_id: string } | null; label_error?: string }>(
          "print_pack",
          { shipment_id: row.shipment?.id },
        )
        if (res?.label?.file_id) await loadFileInto(res.label.file_id, win, "label")
        else {
          win?.close()
          setRowError(row.order_key, res?.label_error ?? "The label is not available yet.")
        }
      } catch (err) {
        win?.close()
        setRowError(row.order_key, err instanceof Error ? err.message : String(err))
      }
    })()
  }

  return (
    <div data-testid="boxtal-prep-grid" class="flex h-full min-h-0 flex-col">
      <PageHeader
        title="To prepare"
        count={rows().length}
        subtitle={lastSyncLabel(lastSyncAt())}
        testid="boxtal-prep-grid-header"
        actions={
          <>
            <Show when={staleRefs().length > 0}>
              <Button
                variant="ghost"
                testid="boxtal-prep-refresh-stale"
                disabled={refreshingStale() || pulling()}
                title="Re-quote only the rows whose cached estimate is stale or missing"
                onClick={() => void refreshStale()}
              >
                {refreshingStale() ? "Refreshing" : `Refresh stale (${staleRefs().length})`}
              </Button>
            </Show>
            <Button
              variant="secondary"
              testid="boxtal-prep-add-shipment"
              title="Ship something that has no Shopify order: a repaired unit going back, or a sample"
              onClick={() => setAddOpen(true)}
            >
              Add shipment
            </Button>
            <Button
              variant="primary"
              testid="boxtal-prep-pull-orders"
              disabled={pulling() || refreshingStale()}
              onClick={() => void pullOrders()}
            >
              {pulling() ? "Pulling" : "Pull orders"}
            </Button>
          </>
        }
      />

      {/* What this list is NOT showing, said out loud rather than left to be discovered. */}
      <Show when={latestResult()?.last_sync_error || latestResult()?.truncated || latestResult()?.invoicing_available === false}>
        <div
          class="mx-4 mt-3 rounded-sm border border-warning-border bg-warning-glow/40 px-3 py-2 text-[12px] text-text"
          data-testid="boxtal-prep-notice"
        >
          <Show when={latestResult()?.last_sync_error}>
            <div data-testid="boxtal-prep-sync-error">{latestResult()!.last_sync_error}</div>
          </Show>
          <Show when={latestResult()?.truncated}>
            <div data-testid="boxtal-prep-truncated">
              Showing the 250 most recently placed open orders. Older ones are not listed.
            </div>
          </Show>
          <Show when={latestResult()?.invoicing_available === false}>
            <div data-testid="boxtal-prep-no-invoicing">
              The invoicing app is not available, so no row can show its document.
            </div>
          </Show>
        </div>
      </Show>

      <Show when={addOpen()}>
        <AddShipmentPanel
          onClose={() => setAddOpen(false)}
          onCreated={(row) => {
            setAddOpen(false)
            patchRows([row], [row.order_key])
          }}
        />
      </Show>

      {/* Top bar: ONE row of compact filters. inputClass carries w-full and the simple cx() join
          cannot override it reliably (stylesheet order, not class order, wins), so each control
          sits in a SIZED wrapper and keeps its inner w-full. */}
      <div class="flex flex-wrap items-center gap-2 border-b border-border-subtle px-5 py-2">
        <div class="min-w-44 max-w-80 flex-1">
          <input
            type="search"
            placeholder="Search order, invoice, customer"
            class={inputClass}
            data-testid="boxtal-prep-search"
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
          />
        </div>
        <div class="w-24">
          <input
            type="text"
            placeholder="Tag"
            class={inputClass}
            data-testid="boxtal-prep-tag"
            value={tag()}
            onInput={(e) => setTag(e.currentTarget.value)}
          />
        </div>
        <div class="w-32">
          <select
            class={inputClass}
            data-testid="boxtal-prep-country"
            value={country()}
            onChange={(e) => setCountry(e.currentTarget.value)}
          >
            <option value="">All countries</option>
            <For each={countryOptions(fetchedRows().map((r) => r.destination))}>
              {(c) => (
                <option value={c} title={countryName(c)}>
                  {c}
                </option>
              )}
            </For>
          </select>
        </div>
        <div class="w-36">
          <select
            class={inputClass}
            data-testid="boxtal-prep-product-filter"
            value={product()}
            onChange={(e) => setProduct(e.currentTarget.value)}
          >
            <option value="">All products</option>
            {/* The option VALUE stays the raw token -- that is what prep_list's own
                server-side filter matches as a substring of `products`. Only the LABEL is
                resolved, so the dropdown reads in the same short codes the column now
                shows instead of offering `EMB-ET2-BLACK-B2B` next to a row that says
                `ET2`. */}
            <For each={productChips()}>
              {(p) => <option value={p}>{productLabel(shortProductCode(p))}</option>}
            </For>
          </select>
        </div>
        <label class="ml-auto flex items-center gap-1.5 text-[12px] text-text-secondary">
          <input
            type="checkbox"
            data-testid="boxtal-prep-show-excluded"
            checked={includeExcluded()}
            onChange={(e) => setIncludeExcluded(e.currentTarget.checked)}
          />
          Show excluded
        </label>
      </div>

      {/*
       * viewState is the ONE decision that reads result.error / refreshFailed / lastSyncAt and
       * turns them into "what does the operator see": a failed refresh with cached rows keeps the
       * table up (banner only), a failed refresh with nothing cached falls back to the existing
       * "could not load" EmptyState, and an empty cache mid-refresh gets its own loading state
       * rather than ever claiming "nothing to prepare" before a single read has actually landed.
       * The decision itself is gridViewState (prep-view-state.ts), pure and unit-tested; this is
       * only the render of its answer.
       */}
      <Show
        when={viewState().empty !== "load_error"}
        fallback={
          <EmptyState icon={<InboxIcon />} title="Couldn't load queue" testid="boxtal-prep-grid-error">
            {String(result.error?.message ?? result.error ?? "Unknown error")}
          </EmptyState>
        }
      >
        <Show when={viewState().banner} keyed>
          {(banner) => (
            <div
              class="mx-4 mt-3 flex items-center justify-between gap-3 rounded-sm border border-accent-border bg-accent-tint/40 px-3 py-2 text-[12px] text-text"
              data-testid="boxtal-prep-refresh-banner"
              data-kind={banner.kind}
            >
              <span>{banner.message}</span>
              <Button
                variant="ghost"
                class="whitespace-nowrap px-1.5 py-0.5 text-[11px]"
                disabled={refreshing()}
                testid="boxtal-prep-refresh-banner-retry"
                onClick={() => runBackgroundRefresh(++generation)}
              >
                {refreshing() ? "Refreshing" : "Refresh again"}
              </Button>
            </div>
          )}
        </Show>
        <Show
          when={viewState().empty !== "loading"}
          fallback={
            <EmptyState icon={<InboxIcon />} title="Loading the queue" testid="boxtal-prep-grid-loading">
              Nothing is cached yet. The queue is loading.
            </EmptyState>
          }
        >
        <Show
          when={rows().length > 0}
          fallback={
            <EmptyState icon={<InboxIcon />} title="Nothing to prepare" testid="boxtal-prep-grid-empty">
              Every open order is shipped or excluded.
            </EmptyState>
          }
        >
          {/* The horizontal scroller. Its own width -- not the window's -- decides
              whether the Actions column stays pinned (see actionsSticky above), and
              `data-sticky-actions` publishes that decision so the e2e can pin the rule
              at both geometries. Un-stuck, the table simply scrolls: `overflow-auto`
              gives it a real horizontal scrollbar, which is how a table this wide is
              read. */}
          <div
            class="flex-1 overflow-auto"
            data-testid="boxtal-prep-grid-scroller"
            data-sticky-actions={String(actionsSticky())}
            ref={setScroller}
          >
            <table
              data-testid="boxtal-prep-grid-table"
              class="min-w-full border-separate border-spacing-0 text-left text-[12.5px]"
            >
              <thead>
                <tr>
                  <Th
                    pad="tight"
                    class="sticky top-0 z-10 hidden border-b border-border bg-bg md:table-cell"
                  >
                    Status
                  </Th>
                  <SortTh label="Order" sortKey="order" active={sort()} onSort={onSort} />
                  <SortTh label="Client" sortKey="client" active={sort()} onSort={onSort} />
                  <SortTh
                    label="Country"
                    sortKey="country"
                    active={sort()}
                    class="hidden md:table-cell"
                    onSort={onSort}
                  />
                  <Th
                    pad="tight"
                    class="sticky top-0 z-10 hidden border-b border-border bg-bg md:table-cell"
                  >
                    Products
                  </Th>
                  <SortTh
                    label="Total"
                    sortKey="total"
                    active={sort()}
                    right
                    class="hidden md:table-cell"
                    onSort={onSort}
                  />
                  <Th
                    pad="tight"
                    class="sticky top-0 z-10 hidden border-b border-border bg-bg md:table-cell"
                  >
                    Category
                  </Th>
                  <Th
                    pad="tight"
                    class="sticky top-0 z-10 hidden border-b border-border bg-bg md:table-cell"
                  >
                    Document
                  </Th>
                  {/* ONE actions column, pinned to the right edge, so Ship stays reachable on a
                      narrow viewport instead of scrolling out of reach (the same defect as not
                      having it on the row at all). No separator of its own: it is only pinned at
                      the widths where the table FITS, so nothing is behind it to mark off. The
                      grid wrapper is horizontally scrollable (`overflow-auto` below) so anything
                      still off-screen is reachable too. */}
                  <Th
                    right
                    pad="tight"
                    class={cx("sticky top-0 z-20 border-b bg-bg", actionsSticky() ? "right-0" : "")}
                  >
                    Actions
                  </Th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border-subtle">
                <For each={displayRows()}>
                  {(row) => {
                    // A row mid-exit-transition (held on screen by reconcileExitingRows after a
                    // refresh dropped it) is busy in every sense that matters here: no action on
                    // it can do anything useful in the ~220ms before it leaves.
                    const exiting = () => exitingKeys().has(row.order_key)
                    const busy = () => isBusy(row.order_key) || !rowIsInteractive(exiting())
                    const lock = () => categoryLockReason(row)
                    // Denser than the first cut (2026-09-08): py-1.5 -> py-1 and a tight
                    // leading on every stacked cell. The row is a worklist line, not a card, and
                    // 12px of vertical padding plus default line-height spent ~24px of every row
                    // on nothing. The header padding was tightened to match (Th pad="tight"), so
                    // no column is set wider than its own content by its label's padding.
                    const cellClass = "border-b border-border-subtle px-1.5 py-1 align-middle"
                    const [phoneExpanded, setPhoneExpanded] = createSignal(false)
                    // A column the phone drops stays in the row and paints as a
                    // stacked block once the operator expands it, so the cell is
                    // written once and read at both widths.
                    const phoneCell = (key: string) =>
                      PREP_GRID_COLUMNS.find((c) => c.key === key)?.survivesPhone
                        ? ""
                        : phoneExpanded()
                          ? "block md:table-cell"
                          : "hidden md:table-cell"
                    const productCodes = createMemo(() => resolveProductCodes(row.products))
                    const [addressOpen, setAddressOpen] = createSignal(false)
                    return (
                      <>
                      <tr
                        data-testid={`boxtal-prep-row-${row.order_key}`}
                        data-status={row.status}
                        data-state={row.state}
                        data-excluded={row.excluded.toString()}
                        data-exiting={exiting() ? "true" : "false"}
                        class={cx(
                          "group transition-[opacity] duration-200 ease-in hover:bg-surface-hover",
                          exiting() ? "pointer-events-none opacity-0" : "opacity-100",
                          // The prep grid has no packed mark: packing happens at the print
                          // station, on a Ready-to-ship row, so this grid is never greyed for it.
                          rowTintClass(row.status, false),
                        )}
                      >
                        <td class={cx(cellClass, phoneCell("status"))} data-phone-column="status">
                          <select
                            class={cx(inputClass, "!w-[96px] px-1 py-0.5 text-[11px]")}
                            data-testid={`boxtal-prep-status-${row.order_key}`}
                            aria-label="Row status"
                            value={row.status}
                            disabled={busy()}
                            onChange={(e) => void setStatus(row, e.currentTarget.value as PrepStatus)}
                          >
                            <For each={STATUS_OPTIONS}>
                              {(opt) => <option value={opt.value}>{opt.label}</option>}
                            </For>
                          </select>
                          {/* The status reason (why a row is on hold, what an order-less row is
                              for) was stored but never shown; one quiet clamped line under the
                              select, full text on hover. */}
                          <Show when={row.status_note}>
                            <span
                              class="mt-0.5 block max-w-[96px] truncate text-[10.5px] leading-[1.3] text-text-tertiary"
                              title={row.status_note ?? undefined}
                              data-testid={`boxtal-prep-status-note-${row.order_key}`}
                            >
                              {row.status_note}
                            </span>
                          </Show>
                        </td>
                        <td class={cellClass}>
                          {/* Two lines, tight: the order number is the value and the date is the
                              label under it, so the label is quieter and the pair shares one
                              baseline block instead of two full line-heights. */}
                          <div class="flex flex-col leading-[1.3]">
                            <span class="whitespace-nowrap font-mono text-text">
                              {row.order_name ?? row.invoice_ref}
                            </span>
                            <span class="whitespace-nowrap font-mono text-[10.5px] tabular-nums text-text-tertiary">
                              {row.order_created_at
                                ? new Date(row.order_created_at).toLocaleDateString()
                                : ""}
                            </span>
                            {/* The Shopify staff note is the THIRD line of this cell, not a
                                column of its own: a ninth column is what put the old Packages
                                cell under the sticky Actions edge (see the PrepGrid.test pin).
                                Read-only text at rest, a textarea on click. */}
                            <NoteCell row={row} busy={busy()} onSave={(note) => void setNote(row, note)} />
                          </div>
                        </td>
                        <td class={cellClass}>
                          {/* At most two lines (2026-09-08): the name, capped and truncated, then the
                              order's tags clamped to one line. The country, which used to share
                              that second line, is its own column now. The full name and tag list
                              are on the cell's `title`, so the cap costs nothing an operator
                              cannot recover by hovering. */}
                          <div
                            class="flex max-w-[92px] flex-col leading-[1.3]"
                            title={`${row.customer}${row.order_tags.length > 0 ? ` (${row.order_tags.join(", ")})` : ""}`}
                          >
                            <span class="truncate text-text">{row.customer}</span>
                            <Show when={row.order_tags.length > 0}>
                              <span class="truncate text-[10.5px] text-text-tertiary">{row.order_tags.join(", ")}</span>
                            </Show>
                          </div>
                        </td>
                        {/* The destination country has its own column (sortable, filterable): the
                            ISO code, the country's name on hover. It used to sit under the name. */}
                        <td
                          class={cx(cellClass, "font-mono text-text-secondary", phoneCell("country"))}
                          data-phone-column="country"
                          data-testid={`boxtal-prep-country-${row.order_key}`}
                          title={countryName(row.destination)}
                        >
                          {row.destination || "-"}
                        </td>
                        <td class={cx(cellClass, "text-text-secondary", phoneCell("products"))} data-phone-column="products">
                          <span class="flex flex-wrap items-center gap-1">
                            {/* RESOLVED, MERGED, COMPACT (2026-09-08). This cell used to print
                                the row's `products` summary verbatim, and for an order with no
                                document that summary is the raw Shopify sku: a real prod row read
                                nine wrapped lines of `2xEMB-ET2-BLACK-B2B, ...` and stood three
                                times as tall as its neighbours, with the SAME product listed
                                twice as two entries. `resolveProductCodes` (product-codes.ts,
                                pure + tested) strips the B2B wrapper onto the same short codes the
                                retail rows use and merges duplicates, so that row now reads
                                `3xET2 FS HC MP 2xPS DS 2xUSBC` on two lines.
                                The quantity is dropped when it is 1 -- a column of "1x" prefixes
                                is noise -- and shown quieter than the code, which is the value.
                                The VERBATIM original summary stays on the cell's `title`, so the
                                resolution can never cost the operator information.
                                Clamped, NOT `truncate`: `truncate` adds whitespace-nowrap, which
                                took this cell OFF its wrap and made the column WIDER (measured
                                84.8px -> 112.8px). Wrapping has to survive for the cap to be a
                                cap. A summary that is not a quantity list at all (the "-"
                                placeholder, or "2 parcels") is shown verbatim.
                                And NO `block` next to `line-clamp-2`, which is why the old cap
                                never actually capped: Tailwind's line-clamp sets
                                `display:-webkit-box`, `block` overrode it, and the clamp became a
                                no-op. Measured on the dealer row before this pass: 13 wrapped
                                lines, a 275.5px row against its 93.8px neighbours. */}
                            <span
                              class="line-clamp-3 min-w-[88px] max-w-[120px] font-mono text-[10.5px] leading-[1.35]"
                              title={row.products}
                              data-testid={`boxtal-prep-products-${row.order_key}`}
                            >
                              <Show when={productCodes().length > 0} fallback={row.products}>
                                <For each={productCodes()}>
                                  {(entry) => (
                                    <span class="mr-1 inline-block whitespace-nowrap">
                                      <Show when={entry.qty !== 1}>
                                        <span class="text-text-tertiary tabular-nums">{`${entry.qty}x`}</span>
                                      </Show>
                                      <span class="text-text">{productChipLabel(entry.code)}</span>
                                    </span>
                                  )}
                                </For>
                              </Show>
                            </span>
                            <Show when={row.partially_shipped}>
                              <Badge tone="warning">{`partial: ${row.remaining_units ?? "?"} left`}</Badge>
                            </Show>
                            {/* A blocked row says WHY it is blocked. The reason is the only thing
                                that tells the operator what to fix (a missing weight, a bad
                                address, a customs value), and "Refresh stale" deliberately skips
                                needs_fix rows, so a reason derived from the order also gets a
                                Recheck that re-resolves this one row. */}
                            <Show when={row.state === "needs_fix"}>
                              <span class="inline-flex items-center gap-1">
                                <span title={row.reason ?? undefined}>
                                  <Badge tone="warning" dot testid={`boxtal-prep-reason-${row.order_key}`}>
                                    {row.reason ?? "Needs fix"}
                                  </Badge>
                                </span>
                                <Show when={reasonIsRecheckable(row.reason)}>
                                  <Button
                                    variant="ghost"
                                    class="whitespace-nowrap px-1.5 py-0.5 text-[11px]"
                                    disabled={busy()}
                                    title="Re-derive this row's customs values from the linked Shopify order"
                                    testid={`boxtal-prep-recheck-${row.order_key}`}
                                    onClick={() => void patchRow(row.order_key).catch(() => {})}
                                  >
                                    {busy() ? "Checking..." : "Recheck"}
                                  </Button>
                                </Show>
                              </span>
                            </Show>
                            {/* The order's address and the customer's verified one differ: held
                                until a person picks, in the fold the chip opens under the row. */}
                            <Show when={addressDiffers(row)}>
                              <AddressDiffersChip
                                row={row}
                                open={addressOpen()}
                                onToggle={() => setAddressOpen(!addressOpen())}
                              />
                            </Show>
                            <Show when={row.recipient_phone_issue}>
                              <span class="inline-flex items-center gap-1">
                                <span title={row.recipient_phone_issue}>
                                  <Badge tone="warning" dot>
                                    Phone invalid for destination
                                  </Badge>
                                </span>
                                {/* recipient_phone_issue is a snapshot from the last resolve, so a
                                    contact fixed elsewhere (Contacts app, Shopify) would otherwise
                                    leave Ship disabled and this badge lying until the next full
                                    prep_sync. patchRow re-resolves this ONE row live, the same call
                                    every other row action already makes, so the flag clears the
                                    moment the operator asks without waiting on a scheduled sync. */}
                                <Button
                                  variant="ghost"
                                  class="whitespace-nowrap px-1.5 py-0.5 text-[11px]"
                                  disabled={busy()}
                                  title="Recheck this recipient now that the phone may have been corrected"
                                  testid={`boxtal-prep-recheck-phone-${row.order_key}`}
                                  onClick={() => void patchRow(row.order_key).catch(() => {})}
                                >
                                  {busy() ? "Checking..." : "Recheck"}
                                </Button>
                              </span>
                            </Show>
                          </span>
                        </td>
                        <td class={cx(cellClass, "text-right", phoneCell("total"))} data-phone-column="total">
                          <div class="flex flex-col items-end gap-0.5 leading-[1.3]">
                            <span class="whitespace-nowrap font-mono tabular-nums text-text">
                              {formatMoneyMinor(row.grand_total_minor, row.currency)}
                            </span>
                            <ShippingEstimateCell
                              row={row}
                              busy={busy()}
                              onSelect={(code) => void selectOffer(row, code)}
                              testid={`boxtal-prep-estimate-${row.order_key}`}
                            />
                            {/* The carton line lives HERE, as the third line of this
                                stack, and no longer in a standalone Packages column.
                                Measured at 1440x900 with the agent panel open: the grid
                                scrolled 1128px of content through an 812px viewport, so
                                Packages started at x=1096 and had 23px of itself under
                                the opaque sticky Actions cell and the remaining 78px past
                                the right edge -- invisible at rest, and its width was
                                also what pushed the tail of the Document column under the
                                sticky cell. Tightening one cell cannot absorb 316px of
                                overflow; dropping the column can. Carrier, price and
                                cartons are read together anyway, which is why this is
                                where the line belongs. */}
                            <Show
                              when={row.document_ref}
                              fallback={
                                <span
                                  class="text-[11px] text-text-tertiary"
                                  data-testid={`boxtal-prep-packages-${row.order_key}`}
                                >
                                  {row.reason ?? "No document yet"}
                                </span>
                              }
                            >
                              <Show
                                when={row.state !== "not_synced"}
                                fallback={
                                  <span
                                    class="text-[11px] text-text-tertiary"
                                    data-testid={`boxtal-prep-packages-${row.order_key}`}
                                  >
                                    Not synced yet
                                  </span>
                                }
                              >
                                <PackageCell
                                  row={row}
                                  busy={busy()}
                                  onCommit={(draft) => void setPackage(row, draft)}
                                />
                              </Show>
                            </Show>
                          </div>
                        </td>
                        <td class={cx(cellClass, phoneCell("category"))} data-phone-column="category">
                          {/* Short option words, full wording on hover: the column sits in the
                              band the sticky Actions cell rides over, so its width is paid for
                              by the Document column next to it. */}
                          <span title={lock() ?? categoryFullLabel(row.category)}>
                            <select
                              class={cx(inputClass, "!w-[70px] px-1 py-0.5 text-[11px]")}
                              data-testid={`boxtal-prep-category-${row.order_key}`}
                              aria-label="Row category"
                              value={row.category}
                              disabled={busy() || lock() !== null}
                              onChange={(e) =>
                                void setCategory(row, e.currentTarget.value as PrepCategory)
                              }
                            >
                              <For each={CATEGORY_OPTIONS}>
                                {(opt) => <option value={opt.value}>{opt.label}</option>}
                              </For>
                            </select>
                          </span>
                        </td>
                        <td class={cx(cellClass, phoneCell("document"))} data-phone-column="document">
                          <InvoiceCell row={row} busy={busy()} onDownload={() => downloadInvoice(row)} />
                        </td>
                        <td
                          class={cx(
                            cellClass,
                            // Pinned AND OPAQUE only while the table fits. Once it does
                            // not, the opaque ground comes off with the pin, so nothing
                            // is painted over the Document column behind it.
                            actionsSticky()
                              ? "sticky right-0 z-10 bg-bg group-hover:bg-surface-hover"
                              : "",
                          )}
                        >
                          <div class="flex items-start justify-end gap-0.5">
                            {/* Phone only: reveals the columns 390 px drops, in
                                the row itself. No extra column: the grid still
                                has exactly its eight data columns. */}
                            <button
                              type="button"
                              class="min-h-11 min-w-11 rounded-md text-text-secondary md:hidden"
                              data-testid={`boxtal-prep-row-phone-expand-${row.order_key}`}
                              aria-expanded={phoneExpanded()}
                              aria-label={phoneExpanded() ? "Hide columns" : "Show columns"}
                              onClick={() => setPhoneExpanded(!phoneExpanded())}
                            >
                              {phoneExpanded() ? "\u2212" : "+"}
                            </button>
                            <QuoteCell row={row} busy={busy()} onQuote={() => void quoteRow(row)} />
                            <ShipCell
                              row={row}
                              busy={busy()}
                              error={rowErrors()[row.order_key] ?? null}
                              pending={pendingShips().has(row.order_key)}
                              approval={shipApprovalForRow(row, shipApprovals())}
                              note={shipNotes()[row.order_key] ?? null}
                              onShip={() => void shipRow(row)}
                              onDecide={(decision) => {
                                const approval = shipApprovalForRow(row, shipApprovals())
                                if (approval) void decideShip(row, approval, decision)
                              }}
                            />
                            <LabelCell
                              row={row}
                              busy={busy()}
                              onPrint={() => printLabel(row)}
                              onCheckDocuments={() => void checkDocuments(row)}
                            />
                            <Show
                              when={row.excluded}
                              fallback={
                                <Button
                                  variant="ghost"
                                  class="!px-1 py-1"
                                  testid={`boxtal-prep-exclude-${row.order_key}`}
                                  title="Hide this row from the worklist"
                                  ariaLabel="Exclude from the worklist"
                                  disabled={busy()}
                                  onClick={() => void excludeRow(row)}
                                >
                                  x
                                </Button>
                              }
                            >
                              <Button
                                variant="ghost"
                                class="px-1.5 py-1 text-[11.5px]"
                                testid={`boxtal-prep-restore-${row.order_key}`}
                                title="Put this row back in the worklist"
                                disabled={busy()}
                                onClick={() => void restoreRow(row)}
                              >
                                Restore
                              </Button>
                            </Show>
                          </div>
                        </td>
                      </tr>
                      <Show when={addressOpen() && addressDiffers(row)}>
                        <tr data-testid={`boxtal-prep-address-fold-row-${row.order_key}`}>
                          <td colSpan={PREP_GRID_COLUMNS.length} class="border-b border-border-subtle">
                            <AddressDiffersFold row={row} busy={busy()} onPick={(pick) => void pickAddress(row, pick)} />
                          </td>
                        </tr>
                      </Show>
                      </>
                    )
                  }}
                </For>
              </tbody>
            </table>
          </div>
          {/* Un-stuck, the actions sit at the END of the row instead of pinned to the
              edge, so they are reached by scrolling. This platform draws OVERLAY
              scrollbars (measured: the container's scrollbar takes 0px of height), so
              the scroll affordance is invisible until the operator already scrolls --
              say it in words instead. Only while the table actually overflows. */}
          <Show when={!actionsSticky()}>
            <div
              class="border-t border-border-subtle px-1.5 py-1 text-[11px] text-text-tertiary"
              data-testid="boxtal-prep-grid-scroll-hint"
            >
              Actions sit at the end of each row. Scroll right to reach them.
            </div>
          </Show>
        </Show>
        </Show>
      </Show>
    </div>
  )
}

export default PrepGrid
