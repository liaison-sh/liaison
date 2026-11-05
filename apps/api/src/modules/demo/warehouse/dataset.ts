// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The warehouse's book: two and a half years of commercial history for
// Resonant Audio Labs, generated rather than stored, so the repository carries
// a few hundred lines instead of a few megabytes of CSV.
//
// It is DERIVED from `apps/api/src/seed/world/fiction.ts`, exactly the way the demo Shopify
// fixtures are, so the oracle and the store and the tickets and the invoices
// are the same company: the same eleven SKUs, the same six dealers, the same
// twenty end customers, the same currency. What is added here is depth in TIME,
// which the Shopify book deliberately does not have (it models the operator's
// current queue, a few weeks wide), and that is the whole point of a warehouse:
// "returns by month for the Kestrel 10" is not a question you can ask a queue.
//
// EVERYTHING IS DETERMINISTIC. The only input is the UTC month, so two seeds in
// the same month produce identical rows and the nightly re-seed converges. The
// randomness is a seeded mulberry32, never `Math.random`.
//
// The history is not flat. It carries the shapes an analyst would look for:
//   * growth, plus a November and December peak,
//   * a firmware release (2.0.0) whose RMA rate is visibly worse than the
//     releases either side of it, which is the answer to "is 2.0.0 bad",
//   * dealers on different credit terms, some of them late right now,
//   * a ten input flagship (the Kestrel 10) that returns more often than the others,
//     mostly for one reason code.

import { createHash } from "node:crypto"
import { DEMO_CATALOG, DEMO_CUSTOMERS, DEMO_DEALERS, type DemoSku } from "~/seed/world/fiction"

// ── determinism ──────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and identical on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length) % items.length] as T
}

function between(next: () => number, lo: number, hi: number): number {
  return lo + Math.floor(next() * (hi - lo + 1))
}

// ── calendar ─────────────────────────────────────────────────────────────────

/** How many WHOLE months of history sit before the current (partial) one. */
export const HISTORY_MONTHS = 30

function monthStart(now: Date, monthsAgo: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1))
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

function addMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()))
}

function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
}

// ── row shapes ───────────────────────────────────────────────────────────────

export interface ProductRow {
  sku: string
  title: string
  tier: string
  list_price_minor: number
  currency: string
  weight_kg: number
  launched_on: string
  is_serialized: boolean
}
export interface DealerRow {
  dealer_code: string
  name: string
  country: string
  tier: string
  credit_terms_days: number
  credit_limit_minor: number
  vat_number: string | null
  onboarded_on: string
}
export interface CustomerRow {
  customer_code: string
  name: string
  email: string
  country: string
  segment: string
  first_order_on: string
}
export interface RmaReasonRow {
  reason_code: string
  label: string
  category: string
  is_hardware_fault: boolean
}
export interface OrderRow {
  order_id: string
  order_ref: string
  order_date: string
  channel: string
  customer_code: string | null
  dealer_code: string | null
  currency: string
  subtotal_minor: number
  discount_minor: number
  shipping_minor: number
  tax_minor: number
  total_minor: number
  ship_country: string
  status: string
  due_on: string | null
  paid_on: string | null
}
export interface OrderLineRow {
  line_id: string
  order_id: string
  line_no: number
  sku: string
  quantity: number
  unit_price_minor: number
  discount_minor: number
  line_total_minor: number
}
export interface RmaRow {
  rma_id: string
  rma_ref: string
  order_id: string
  sku: string
  serial_number: string | null
  reason_code: string
  firmware_version: string | null
  opened_on: string
  closed_on: string | null
  status: string
  resolution: string | null
  refund_minor: number
  ship_country: string
}
export interface InventoryMovementRow {
  movement_id: string
  sku: string
  moved_on: string
  movement_type: string
  quantity: number
  location: string
  reference: string | null
}
export interface TelemetryRow {
  report_id: string
  serial_number: string
  sku: string
  firmware_version: string
  reported_on: string
  country: string
  uptime_hours: number
  crash_count: number
  session_count: number
}
export interface WarrantyRow {
  warranty_id: string
  serial_number: string
  sku: string
  order_id: string
  plan: string
  started_on: string
  ends_on: string
  status: string
}
export interface MonthlyRevenueRow {
  month: string
  channel: string
  sku: string
  units: number
  gross_revenue_minor: number
  refunds_minor: number
  net_revenue_minor: number
  currency: string
}

export interface DemoWarehouseDataset {
  products: ProductRow[]
  dealers: DealerRow[]
  customers: CustomerRow[]
  rma_reasons: RmaReasonRow[]
  orders: OrderRow[]
  order_lines: OrderLineRow[]
  rmas: RmaRow[]
  inventory_movements: InventoryMovementRow[]
  device_telemetry: TelemetryRow[]
  warranties: WarrantyRow[]
  monthly_revenue: MonthlyRevenueRow[]
}

// ── the fixed vocabulary ─────────────────────────────────────────────────────

const CURRENCY = "EUR"
const WAREHOUSE_LOCATION = "PARIS-01"

const RMA_REASONS: RmaReasonRow[] = [
  {
    reason_code: "DOA",
    label: "Dead on arrival",
    category: "hardware",
    is_hardware_fault: true,
  },
  {
    reason_code: "PREAMP_NOISE",
    label: "Input 3 noise floor rises after warm up",
    category: "hardware",
    is_hardware_fault: true,
  },
  {
    reason_code: "SD_WRITE",
    label: "SD card write errors on long takes",
    category: "hardware",
    is_hardware_fault: true,
  },
  {
    reason_code: "FW_CRASH",
    label: "Firmware freeze under load",
    category: "firmware",
    is_hardware_fault: false,
  },
  {
    reason_code: "TC_DRIFT",
    label: "Timecode drifts against the camera",
    category: "firmware",
    is_hardware_fault: false,
  },
  {
    reason_code: "SHIP_DAMAGE",
    label: "Damaged in transit",
    category: "logistics",
    is_hardware_fault: false,
  },
  {
    reason_code: "WRONG_ITEM",
    label: "Wrong item shipped",
    category: "logistics",
    is_hardware_fault: false,
  },
  {
    reason_code: "CHANGED_MIND",
    label: "Returned within the cooling off period",
    category: "commercial",
    is_hardware_fault: false,
  },
]

/** Firmware releases, oldest first, each with the month offset it shipped in. */
const FIRMWARE_TIMELINE: { version: string; monthsAgo: number; rmaBias: number }[] = [
  { version: "1.2.0", monthsAgo: 30, rmaBias: 1.0 },
  { version: "1.3.1", monthsAgo: 24, rmaBias: 0.8 },
  { version: "1.4.0", monthsAgo: 17, rmaBias: 0.7 },
  // The bad one. Shipped wide, pulled the RMA rate up for a quarter, and is the
  // answer to the question a visitor is most likely to ask an oracle.
  { version: "2.0.0", monthsAgo: 11, rmaBias: 2.4 },
  { version: "2.1.2", monthsAgo: 7, rmaBias: 0.9 },
  { version: "2.2.0", monthsAgo: 3, rmaBias: 0.6 },
]

function firmwareAt(monthsAgo: number): { version: string; rmaBias: number } {
  let chosen = FIRMWARE_TIMELINE[0] as { version: string; rmaBias: number }
  for (const fw of FIRMWARE_TIMELINE) {
    if (fw.monthsAgo >= monthsAgo) chosen = fw
  }
  return chosen
}

/** Seasonality: November and December carry the year. */
function seasonFactor(month: Date): number {
  const m = month.getUTCMonth()
  if (m === 10 || m === 11) return 1.75
  if (m === 0 || m === 6) return 0.7
  return 1
}

const DEALER_TERMS: Record<string, { terms: number; limitMinor: number; tier: string }> = {
  "eu-de": { terms: 45, limitMinor: 6_000_000, tier: "gold" },
  "us-ca": { terms: 30, limitMinor: 3_500_000, tier: "silver" },
  "uk-ldn": { terms: 45, limitMinor: 5_000_000, tier: "gold" },
  "jp-tky": { terms: 60, limitMinor: 4_000_000, tier: "silver" },
  "nl-ams": { terms: 30, limitMinor: 2_000_000, tier: "bronze" },
  "fr-lyo": { terms: 30, limitMinor: 4_500_000, tier: "gold" },
}

const SEGMENTS = ["studio", "performer", "education", "broadcast"] as const

// ── the generator ────────────────────────────────────────────────────────────

/**
 * Build the whole warehouse for an anchor date (defaults to now). Pure: no
 * database, no clock beyond the argument, no `Math.random`.
 */
export function buildDemoWarehouseDataset(now: Date = new Date()): DemoWarehouseDataset {
  const next = rng(0x5e5ed1)
  const anchorMonth = monthStart(now, 0)
  const firstMonth = monthStart(now, HISTORY_MONTHS)

  // ── reference data ────────────────────────────────────────────────────────
  const products: ProductRow[] = DEMO_CATALOG.map((p: DemoSku, i: number) => ({
    sku: p.sku,
    title: p.title,
    tier: p.tier,
    list_price_minor: p.priceMinor,
    currency: CURRENCY,
    weight_kg: p.weightKg,
    launched_on: iso(monthStart(now, HISTORY_MONTHS + 6 - (i % 5))),
    is_serialized: p.tier === "flagship",
  }))
  const serialized = products.filter((p) => p.is_serialized)
  const accessories = products.filter((p) => !p.is_serialized)

  const dealers: DealerRow[] = DEMO_DEALERS.map((d, i) => {
    const terms = DEALER_TERMS[d.key] ?? { terms: 30, limitMinor: 2_000_000, tier: "bronze" }
    return {
      dealer_code: d.key.toUpperCase(),
      name: d.name,
      country: d.country,
      tier: terms.tier,
      credit_terms_days: terms.terms,
      credit_limit_minor: terms.limitMinor,
      vat_number: d.vat ?? null,
      onboarded_on: iso(monthStart(now, HISTORY_MONTHS + 4 - i)),
    }
  })

  const customers: CustomerRow[] = DEMO_CUSTOMERS.map((c, i) => ({
    customer_code: c.key,
    name: c.name,
    email: c.email,
    country: c.country,
    segment: c.isVip ? "studio" : (SEGMENTS[i % SEGMENTS.length] as string),
    first_order_on: iso(monthStart(now, HISTORY_MONTHS - (i % HISTORY_MONTHS))),
  }))

  // ── the order book ────────────────────────────────────────────────────────
  const orders: OrderRow[] = []
  const order_lines: OrderLineRow[] = []
  const rmas: RmaRow[] = []
  const inventory_movements: InventoryMovementRow[] = []
  const device_telemetry: TelemetryRow[] = []
  const warranties: WarrantyRow[] = []

  let orderSeq = 0
  let lineSeq = 0
  let rmaSeq = 0
  let moveSeq = 0
  let serialSeq = 0
  let telemetrySeq = 0

  for (let back = HISTORY_MONTHS; back >= 0; back--) {
    const month = monthStart(now, back)
    const elapsed = HISTORY_MONTHS - back
    const days = back === 0 ? Math.max(1, now.getUTCDate()) : daysInMonth(month)
    const partial = days / daysInMonth(month)
    // Growth: the company roughly doubles over the window.
    const growth = 1 + elapsed * 0.028
    const monthlyOrders = Math.max(
      4,
      Math.round(24 * growth * seasonFactor(month) * partial + next() * 6),
    )
    const fw = firmwareAt(back)

    // Production receipts: one batch per serialized product, per month.
    for (const p of serialized) {
      moveSeq += 1
      inventory_movements.push({
        movement_id: `MV-${String(moveSeq).padStart(6, "0")}`,
        sku: p.sku,
        moved_on: iso(addDays(month, 2)),
        movement_type: "receipt",
        quantity: between(next, 30, 70),
        location: WAREHOUSE_LOCATION,
        reference: `BATCH-${iso(month).slice(0, 7)}`,
      })
    }
    if (back % 3 === 0) {
      for (const p of accessories) {
        moveSeq += 1
        inventory_movements.push({
          movement_id: `MV-${String(moveSeq).padStart(6, "0")}`,
          sku: p.sku,
          moved_on: iso(addDays(month, 3)),
          movement_type: "receipt",
          quantity: between(next, 120, 300),
          location: WAREHOUSE_LOCATION,
          reference: `BATCH-${iso(month).slice(0, 7)}`,
        })
      }
    }

    for (let i = 0; i < monthlyOrders; i++) {
      const dayOffset = between(next, 0, days - 1)
      const orderDate = addDays(month, dayOffset)
      if (orderDate > now) continue
      const isDealer = next() < 0.32
      orderSeq += 1
      const orderId = `ORD-${String(orderSeq).padStart(6, "0")}`
      const dealer = isDealer ? pick(next, dealers) : null
      const customer = isDealer ? null : pick(next, customers)
      const shipCountry = (dealer?.country ?? customer?.country ?? "FR") as string

      // Lines: one flagship plus zero to two accessories, dealers in volume.
      const lines: OrderLineRow[] = []
      const flagship = pick(next, serialized)
      const flagQty = isDealer ? between(next, 2, 8) : between(next, 1, 2)
      const wholesale = (minor: number) => Math.round(minor * 0.55)
      const flagUnit = isDealer ? wholesale(flagship.list_price_minor) : flagship.list_price_minor
      lineSeq += 1
      lines.push({
        line_id: `LN-${String(lineSeq).padStart(7, "0")}`,
        order_id: orderId,
        line_no: 1,
        sku: flagship.sku,
        quantity: flagQty,
        unit_price_minor: flagUnit,
        discount_minor: 0,
        line_total_minor: flagUnit * flagQty,
      })
      const extraLines = between(next, 0, 2)
      for (let l = 0; l < extraLines; l++) {
        const acc = pick(next, accessories)
        if (lines.some((x) => x.sku === acc.sku)) continue
        const qty = isDealer ? between(next, 3, 12) : between(next, 1, 2)
        const unit = isDealer ? wholesale(acc.list_price_minor) : acc.list_price_minor
        lineSeq += 1
        lines.push({
          line_id: `LN-${String(lineSeq).padStart(7, "0")}`,
          order_id: orderId,
          line_no: lines.length + 1,
          sku: acc.sku,
          quantity: qty,
          unit_price_minor: unit,
          discount_minor: 0,
          line_total_minor: unit * qty,
        })
      }

      const subtotal = lines.reduce((n, l) => n + l.line_total_minor, 0)
      const discount = isDealer && dealer?.tier === "gold" ? Math.round(subtotal * 0.03) : 0
      const shipping = isDealer ? 0 : shipCountry === "FR" ? 0 : between(next, 1200, 4900)
      const taxable = subtotal - discount + shipping
      const tax = shipCountry === "FR" ? Math.round(taxable * 0.2) : 0
      const total = taxable + tax

      const terms = dealer?.credit_terms_days ?? 0
      const dueOn = isDealer ? addDays(orderDate, terms) : orderDate
      // Direct sales settle at checkout. Dealer invoices mostly settle near
      // their due date, and a slice of the recent ones have not settled at all,
      // which is what makes "who is past their terms" a real question.
      let paidOn: Date | null = orderDate
      let status = "paid"
      if (isDealer) {
        const roll = next()
        if (roll < 0.14 && back <= 4) {
          paidOn = null
          status = "awaiting_payment"
        } else if (roll < 0.24) {
          paidOn = addDays(dueOn, between(next, 3, 28))
          status = "paid_late"
        } else {
          paidOn = addDays(dueOn, -between(next, 0, 6))
          status = "paid"
        }
        if (paidOn && paidOn > now) {
          paidOn = null
          status = "awaiting_payment"
        }
      }

      orders.push({
        order_id: orderId,
        order_ref: `RAL-${iso(orderDate).slice(0, 7).replace("-", "")}-${String(orderSeq).padStart(4, "0")}`,
        order_date: iso(orderDate),
        channel: isDealer ? "dealer" : "direct",
        customer_code: customer?.customer_code ?? null,
        dealer_code: dealer?.dealer_code ?? null,
        currency: CURRENCY,
        subtotal_minor: subtotal,
        discount_minor: discount,
        shipping_minor: shipping,
        tax_minor: tax,
        total_minor: total,
        ship_country: shipCountry,
        status,
        due_on: iso(dueOn),
        paid_on: paidOn ? iso(paidOn) : null,
      })
      order_lines.push(...lines)

      for (const l of lines) {
        moveSeq += 1
        inventory_movements.push({
          movement_id: `MV-${String(moveSeq).padStart(6, "0")}`,
          sku: l.sku,
          moved_on: iso(orderDate),
          movement_type: "sale",
          quantity: -l.quantity,
          location: WAREHOUSE_LOCATION,
          reference: orderId,
        })
      }

      // Serial numbers, warranties and telemetry: every direct flagship unit is
      // registered by the person who bought it, and about a third of the units
      // a dealer takes are registered by whoever they resell them to.
      const registered = isDealer ? Math.round(flagQty * 0.34) : flagQty
      const serials: string[] = []
      for (let u = 0; u < registered; u++) {
        serialSeq += 1
        const serial = `${flagship.sku.replace("RAL-", "")}-${String(100000 + serialSeq)}`
        serials.push(serial)
        const extended = next() < 0.18
        const started = addDays(orderDate, 1)
        warranties.push({
          warranty_id: `WR-${String(serialSeq).padStart(6, "0")}`,
          serial_number: serial,
          sku: flagship.sku,
          order_id: orderId,
          plan: extended ? "extended" : "standard",
          started_on: iso(started),
          ends_on: iso(addMonths(started, extended ? 48 : 24)),
          status: addMonths(started, extended ? 48 : 24) < now ? "expired" : "active",
        })
        if (next() < 0.55) {
          telemetrySeq += 1
          const reported = addDays(orderDate, between(next, 7, 120))
          if (reported <= now) {
            const crashy = fw.rmaBias > 2
            device_telemetry.push({
              report_id: `TM-${String(telemetrySeq).padStart(6, "0")}`,
              serial_number: serial,
              sku: flagship.sku,
              firmware_version: fw.version,
              reported_on: iso(reported),
              country: shipCountry,
              uptime_hours: between(next, 20, 900),
              crash_count: crashy ? between(next, 1, 9) : between(next, 0, 2),
              session_count: between(next, 8, 260),
            })
          }
        }
      }

      // RMAs. Rate rises with the firmware bias of the month the unit shipped,
      // and the ten input body returns a little more often than the others.
      const skuBias = flagship.sku === "RAL-FLAG-02" ? 1.6 : 1
      const perUnit = 0.042 * fw.rmaBias * skuBias
      for (let u = 0; u < flagQty; u++) {
        if (next() >= perUnit) continue
        rmaSeq += 1
        const openedOn = addDays(orderDate, between(next, 4, 120))
        if (openedOn > now) continue
        const reason =
          fw.rmaBias > 2 && next() < 0.55
            ? (RMA_REASONS.find((r) => r.reason_code === "FW_CRASH") as RmaReasonRow)
            : flagship.sku === "RAL-FLAG-02" && next() < 0.45
              ? (RMA_REASONS.find((r) => r.reason_code === "PREAMP_NOISE") as RmaReasonRow)
              : pick(next, RMA_REASONS)
        const closes = next() < 0.82
        const closedOn = closes ? addDays(openedOn, between(next, 3, 35)) : null
        const closedInFuture = closedOn !== null && closedOn > now
        const refunded = closes && !closedInFuture && next() < 0.45
        rmas.push({
          rma_id: `RMA-${String(rmaSeq).padStart(5, "0")}`,
          rma_ref: `RA${String(20000 + rmaSeq)}`,
          order_id: orderId,
          sku: flagship.sku,
          serial_number: serials[u] ?? null,
          reason_code: reason.reason_code,
          firmware_version: fw.version,
          opened_on: iso(openedOn),
          closed_on: closedInFuture || !closedOn ? null : iso(closedOn),
          status: closedInFuture || !closedOn ? "open" : "closed",
          resolution: closedInFuture || !closedOn ? null : refunded ? "refund" : "replacement",
          refund_minor: refunded ? flagUnit : 0,
          ship_country: shipCountry,
        })
        if (closedOn && !closedInFuture && !refunded) {
          moveSeq += 1
          inventory_movements.push({
            movement_id: `MV-${String(moveSeq).padStart(6, "0")}`,
            sku: flagship.sku,
            moved_on: iso(closedOn),
            movement_type: "return",
            quantity: 1,
            location: WAREHOUSE_LOCATION,
            reference: `RMA-${String(rmaSeq).padStart(5, "0")}`,
          })
        }
      }
    }
  }

  // ── the mart ──────────────────────────────────────────────────────────────
  const orderById = new Map(orders.map((o) => [o.order_id, o]))
  const bucket = new Map<string, MonthlyRevenueRow>()
  const keyOf = (month: string, channel: string, sku: string) => `${month}|${channel}|${sku}`
  const monthOf = (date: string) => `${date.slice(0, 7)}-01`

  for (const line of order_lines) {
    const order = orderById.get(line.order_id)
    if (!order) continue
    const key = keyOf(monthOf(order.order_date), order.channel, line.sku)
    const row = bucket.get(key) ?? {
      month: monthOf(order.order_date),
      channel: order.channel,
      sku: line.sku,
      units: 0,
      gross_revenue_minor: 0,
      refunds_minor: 0,
      net_revenue_minor: 0,
      currency: CURRENCY,
    }
    row.units += line.quantity
    row.gross_revenue_minor += line.line_total_minor
    bucket.set(key, row)
  }
  for (const rma of rmas) {
    if (rma.refund_minor === 0 || !rma.closed_on) continue
    const order = orderById.get(rma.order_id)
    if (!order) continue
    const key = keyOf(monthOf(rma.closed_on), order.channel, rma.sku)
    const row = bucket.get(key) ?? {
      month: monthOf(rma.closed_on),
      channel: order.channel,
      sku: rma.sku,
      units: 0,
      gross_revenue_minor: 0,
      refunds_minor: 0,
      net_revenue_minor: 0,
      currency: CURRENCY,
    }
    row.refunds_minor += rma.refund_minor
    bucket.set(key, row)
  }
  const monthly_revenue = [...bucket.values()]
    .map((r) => ({ ...r, net_revenue_minor: r.gross_revenue_minor - r.refunds_minor }))
    .sort((a, b) =>
      a.month === b.month
        ? a.channel === b.channel
          ? a.sku.localeCompare(b.sku)
          : a.channel.localeCompare(b.channel)
        : a.month.localeCompare(b.month),
    )

  void firstMonth
  void anchorMonth

  return {
    products,
    dealers,
    customers,
    rma_reasons: RMA_REASONS,
    orders,
    order_lines,
    rmas,
    inventory_movements,
    device_telemetry,
    warranties,
    monthly_revenue,
  }
}

/**
 * A fingerprint of everything a build of the warehouse would load.
 *
 * The build stamp used to record the date and the row total, which answers
 * "has a warehouse of about this size been built today" and NOT "is the
 * warehouse currently in the database the one this code produces". Renaming
 * every product in the catalog changes neither number: same eleven rows in
 * `products`, same orders referencing them by SKU. So a deploy that rewrote
 * the entire range was skipped as already done, and the box kept answering
 * with the previous catalog while every other layer had moved on.
 *
 * Hashing the dataset itself removes the proxy. Any change that would alter a
 * single loaded byte, a title, a reason code, a price or a generated order,
 * changes the hash and forces the rebuild.
 *
 * `JSON.stringify` over the generated dataset is deterministic here because
 * the generator emits its tables and its object keys in a fixed order from a
 * seeded sequence: the same `now` yields the same string. It is hashed rather
 * than stored so the stamp stays one short column.
 */
export function demoWarehouseContentHash(dataset: DemoWarehouseDataset): string {
  return createHash("sha256").update(JSON.stringify(dataset)).digest("hex").slice(0, 32)
}
