// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boxtal UI kit: the shared primitive set from @liaison/app-ui/kit plus the
// Boxtal-only surfaces (money and weight formatting, shipping status badges,
// document labels, the shared worklist columns).
//
// Principles: quiet surfaces, one accent, generous spacing, tabular figures,
// status as tinted badges (never raw enum text), real form controls. Restraint
// over decoration.
//
// Bundling rule: explicit props only, NO `{...rest}` spread onto a host
// element. A spread makes Solid's DOM compiler emit a `mergeProps` import from
// `solid-js/web` that the freeze bundler can't resolve, so the UI bundle fails
// to load. Every primitive below lists its props.
import { Badge, type BadgeTone, cx, Th } from "@liaison/app-ui/kit"
import { type Component, Show } from "solid-js"

export {
  Badge,
  type BadgeTone,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  inputClass,
  PageHeader,
  SectionLabel,
  Segmented,
  Th,
} from "@liaison/app-ui/kit"


// ── Money / weight ───────────────────────────────────────────────────────────
export function formatMoney(
  value: number | string | null | undefined,
  currency?: string,
): string {
  if (value === null || value === undefined || value === "") return "-"
  const n = Number(value)
  if (!Number.isFinite(n)) return "-"
  const grouped = n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return currency ? `${grouped} ${currency}` : grouped
}

// ── Minor-unit money (currency-exponent aware — never a hardcoded /100) ──
// Single source of truth for the boxtal UI package: zero-decimal currencies
// (e.g. JPY) have NO fractional unit, so their minor unit IS their major unit.
// Mirrors invoicing/src/money.ts (bundled apps can't share code across the
// purity boundary) and the boxtal backend's src/money.ts.
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "BIF", "CLP", "DJF", "GNF", "HUF", "ISK", "JPY", "KMF", "KRW", "PYG",
  "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
])

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

export function formatMoneyMinor(
  minor: number | string | null | undefined,
  currency: string | null | undefined,
): string {
  if (minor === null || minor === undefined || !currency) return "-"
  const n = typeof minor === "number" ? minor : Number(minor)
  if (!Number.isFinite(n)) return "-"
  const negative = n < 0
  const abs = Math.abs(Math.round(n))
  const exp = currencyExponent(currency)
  if (exp === 0) {
    return `${negative ? "-" : ""}${abs} ${currency}`
  }
  const scale = 10 ** exp
  const major = Math.floor(abs / scale)
  const minorDigits = String(abs % scale).padStart(exp, "0")
  return `${negative ? "-" : ""}${major}.${minorDigits} ${currency}`
}

export const Money: Component<{
  value: number | string | null | undefined
  currency?: string
  emphasis?: boolean
  class?: string
}> = (props) => (
  <span
    class={cx(
      "font-mono tabular-nums whitespace-nowrap",
      props.emphasis ? "text-text font-medium" : "text-text",
      props.class,
    )}
  >
    {formatMoney(props.value)}
    <Show when={props.currency}>
      <span class="ml-1 text-text-tertiary">{props.currency}</span>
    </Show>
  </span>
)

export function formatWeight(kg: number | null | undefined): string {
  if (kg === null || kg === undefined || !Number.isFinite(Number(kg))) return "-"
  const n = Number(kg)
  return n >= 1 ? `${n.toFixed(n % 1 === 0 ? 0 : 1)} kg` : `${Math.round(n * 1000)} g`
}

const humanize = (s: string): string =>
  s.replace(/_/g, " ").replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())

// ── Shipping status → tone (single source of truth) ──────────────────────────
// Order status: the administrative/label-readiness lifecycle.
const ORDER_TONE: Record<string, BadgeTone> = {
  PENDING: "warning",
  REQUESTED: "accent",
  CONFIRMED: "success",
  CANCELLED: "error",
}
// Tracking status: the parcel's physical journey.
const TRACKING_TONE: Record<string, BadgeTone> = {
  ANNOUNCED: "muted",
  SHIPPED: "accent",
  IN_TRANSIT: "accent",
  OUT_FOR_DELIVERY: "accent",
  REACHED_DELIVERY_PICKUP_POINT: "accent",
  DELIVERED: "success",
  FAILED_ATTEMPT: "warning",
  RETURNED: "warning",
  EXCEPTION: "error",
}

export function orderStatusMeta(status: string | null | undefined): { tone: BadgeTone; label: string } {
  if (!status) return { tone: "muted", label: "-" }
  return { tone: ORDER_TONE[status] ?? "neutral", label: humanize(status) }
}
export function trackingStatusMeta(status: string | null | undefined): { tone: BadgeTone; label: string } {
  if (!status) return { tone: "muted", label: "Not shipped" }
  return { tone: TRACKING_TONE[status] ?? "neutral", label: humanize(status) }
}

// `whitespace-nowrap`: a status badge is an atom. Left to wrap it broke
// "In transit" over two lines inside a squeezed column and read as blank.
export const OrderStatusBadge: Component<{ status: string | null | undefined; testid?: string }> = (props) => {
  const m = () => orderStatusMeta(props.status)
  return (
    <Badge tone={m().tone} dot testid={props.testid} variant={m().tone} class="whitespace-nowrap">
      {m().label}
    </Badge>
  )
}
export const TrackingStatusBadge: Component<{ status: string | null | undefined; testid?: string }> = (props) => {
  const m = () => trackingStatusMeta(props.status)
  return (
    <Badge tone={m().tone} dot testid={props.testid} variant={m().tone} class="whitespace-nowrap">
      {m().label}
    </Badge>
  )
}

// Document type → quiet label (LABEL / CN23 / PROFORMA / VOUCHER).
const DOC_LABEL: Record<string, string> = {
  LABEL: "Shipping label",
  CN23: "CN23 customs",
  PROFORMA: "Pro-forma invoice",
  VOUCHER: "Carrier voucher",
}
export function documentTypeLabel(type: string): string {
  return DOC_LABEL[type] ?? humanize(type)
}

// ── The shared worklist columns ──────────────────────────────────────────────
//
// Every Boxtal worklist (Ready to ship, Returns, and the prep grid it hands over from) shows the
// SAME facts about a parcel: when the label was requested, which order it belongs to, whether it
// is a sale or a repair, how many units, how heavy, how many cartons and what size. They used to
// be spread across whichever list happened to implement them, so an operator lost sight of the
// cartons and the category the moment the label was bought. One definition here, three tables.
//
// Rendered as bare <th>/<td> fragments so each table keeps its own sticky-header and padding
// classes; the ORDER of the cells matches the order of the headers and must stay that way.

/** Date only. A dash (never "Invalid Date") for anything unparseable. */
export function formatQueueDate(iso: string | null | undefined): string {
  if (!iso) return "-"
  const d = parseQueueTimestamp(iso)
  return d ? d.toLocaleDateString() : "-"
}

/** Date + time to the minute: same-day rows are ordered by TIME in these queues, so the day alone
 *  would make the sort look arbitrary. */
export function formatQueueTimestamp(iso: string | null | undefined): string {
  if (!iso) return "-"
  const d = parseQueueTimestamp(iso)
  if (!d) return "-"
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
}

/** A Postgres timestamp arrives as "2026-09-14 13:42:39.878342+00": a SPACE separator and a
 *  two-digit zone offset, neither valid ISO 8601, so every browser parses it as Invalid Date.
 *  Normalize both before parsing, or these columns are all dashes. */
function parseQueueTimestamp(iso: string): Date | null {
  const d = new Date(iso.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"))
  return Number.isNaN(d.getTime()) ? null : d
}

/** "30x20x10, 59x38x16" — the cartons this parcel actually is. */
export function formatQueueParcels(
  parcels: Array<{ length: number; width: number; height: number }> | null | undefined,
): string {
  if (!parcels || parcels.length === 0) return "-"
  return parcels.map((p) => `${p.length}x${p.width}x${p.height}`).join(", ")
}

const CATEGORY_TONE: Record<string, BadgeTone> = {
  sale: "neutral",
  repair: "warning",
  gift: "accent",
  sample: "muted",
}

/** sale / repair / gift / sample. Muted "-" when the row predates the snapshot. */
export const CategoryBadge: Component<{ category: string | null | undefined; testid?: string }> = (
  props,
) => (
  <Show when={props.category} fallback={<span class="text-text-tertiary">{"-"}</span>}>
    <Badge tone={CATEGORY_TONE[props.category!] ?? "neutral"} testid={props.testid}>
      {props.category}
    </Badge>
  </Show>
)

