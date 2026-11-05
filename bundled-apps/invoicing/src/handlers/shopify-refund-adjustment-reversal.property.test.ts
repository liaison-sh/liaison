// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Permanent property guard for `buildAdjustmentReversalItems` (promoted from a
// throwaway 2900-case adversarial fuzz harness that found a real defect: the
// forward net/tax split could OVERSHOOT a rate group's allocated gross, so the
// zero-tax "Rounding adjustment" sweep line came out with a POSITIVE
// unit_price_minor on a document whose lines must only ever credit).
//
// This is a fixed, deterministic grid (never `Math.random`), not a randomized
// fuzzer, so a failure reproduces exactly by re-running this file. It sweeps
// 1-5 original lines, tax rates 0/550/1000/2000 bp (plus mixed-rate
// invoices), remainders of 1 minor unit, remainders equal to the full total,
// prime-ish amounts that force rounding, and a zero-decimal-currency-shaped
// case (large integer amounts, no fractional minor unit -- the function is
// currency-agnostic so this exercises the same arithmetic path JPY would).
//
// Both required invariants are asserted on EVERY generated case:
//   a. sum(net + tax) over emitted lines === -remainingGrossMinor, exactly, in bigint.
//   b. no emitted line has a positive unit_price_minor -- a reversal only ever credits.
// Plus invariant c: the "Rounding adjustment" line is omitted whenever the
// other lines already reconstruct the target exactly (residual zero).

import { describe, expect, test } from "bun:test"
import { lineSubtotal, lineTax } from "../money"
import { buildAdjustmentReversalItems, type ReversalSourceLine } from "./shopify-refund-created"

/** Sum of (subtotal + tax) an emitted item set actually produces, using the
 *  SAME engine helpers the real issuance pipeline uses to derive tax from a
 *  line's net amount and rate -- this is what a document's grand_total_minor
 *  would land on if these items were issued as-is. */
function actualGrossOf(items: Array<Record<string, unknown>>): bigint {
  let total = 0n
  for (const it of items) {
    const subtotal = lineSubtotal({
      quantity: it.quantity as string,
      unit_price_minor: it.unit_price_minor as bigint,
    })
    const tax = lineTax({
      subtotal_minor: subtotal,
      tax_rate_bp: it.tax_rate_bp_override as number,
    })
    total += subtotal + tax
  }
  return total
}

function assertBothInvariants(
  items: Array<Record<string, unknown>>,
  remainingGrossMinor: bigint,
): void {
  // Invariant a: exact reconstruction, in bigint.
  expect(actualGrossOf(items)).toBe(-remainingGrossMinor)

  // Invariant b: never a positive line on a reversal.
  for (const it of items) {
    expect(it.unit_price_minor as bigint <= 0n).toBe(true)
  }

  // Invariant c: the rounding-adjustment sweep line is only emitted when the
  // OTHER lines don't already reconstruct the target exactly.
  const nonRounding = items.filter((it) => it.description !== "Rounding adjustment")
  const roundingLines = items.filter((it) => it.description === "Rounding adjustment")
  expect(roundingLines.length <= 1).toBe(true)
  if (actualGrossOf(nonRounding) === -remainingGrossMinor) {
    expect(roundingLines).toHaveLength(0)
  }
}

// ── Deterministic scenario grid ───────────────────────────────────────────

interface Scenario {
  name: string
  lines: ReversalSourceLine[]
}

const SCENARIOS: Scenario[] = [
  // 1 line, each single rate in the required set.
  {
    name: "1 line, 0bp",
    lines: [{ unit_price_minor: 199900n, quantity: "3", tax_rate_bp: 0 }],
  },
  {
    name: "1 line, 550bp",
    lines: [{ unit_price_minor: 45011n, quantity: "2", tax_rate_bp: 550 }],
  },
  {
    name: "1 line, 1000bp",
    lines: [{ unit_price_minor: 87777n, quantity: "1", tax_rate_bp: 1000 }],
  },
  {
    name: "1 line, 2000bp (the pinned minimal repro group)",
    lines: [{ unit_price_minor: 748209n, quantity: "2", tax_rate_bp: 2000 }],
  },
  // 2 lines, mixed rates.
  {
    name: "2 lines, mixed 550/2000bp",
    lines: [
      { unit_price_minor: 12345n, quantity: "1", tax_rate_bp: 550 },
      { unit_price_minor: 67890n, quantity: "3", tax_rate_bp: 2000 },
    ],
  },
  // 3 lines, mixed rates including 0.
  {
    name: "3 lines, mixed 0/1000/2000bp",
    lines: [
      { unit_price_minor: 5000n, quantity: "1", tax_rate_bp: 0 },
      { unit_price_minor: 33333n, quantity: "2", tax_rate_bp: 1000 },
      { unit_price_minor: 99999n, quantity: "1", tax_rate_bp: 2000 },
    ],
  },
  // 4 lines, all four required rates, one with a fractional quantity.
  {
    name: "4 lines, one of each required rate, fractional quantity",
    lines: [
      { unit_price_minor: 10101n, quantity: "1", tax_rate_bp: 0 },
      { unit_price_minor: 20202n, quantity: "2.500", tax_rate_bp: 550 },
      { unit_price_minor: 30303n, quantity: "1", tax_rate_bp: 1000 },
      { unit_price_minor: 40404n, quantity: "3", tax_rate_bp: 2000 },
    ],
  },
  // 5 lines, repeating rates, prime-ish amounts that force rounding.
  {
    name: "5 lines, prime-ish amounts, repeating rates",
    lines: [
      { unit_price_minor: 99991n, quantity: "7", tax_rate_bp: 550 },
      { unit_price_minor: 10007n, quantity: "3", tax_rate_bp: 2000 },
      { unit_price_minor: 100003n, quantity: "1", tax_rate_bp: 1000 },
      { unit_price_minor: 7919n, quantity: "5", tax_rate_bp: 550 },
      { unit_price_minor: 1n, quantity: "1", tax_rate_bp: 2000 },
    ],
  },
  // Zero-decimal-currency-shaped: large integer amounts, no fractional minor
  // unit anywhere -- the function is currency-agnostic (it never reads a
  // currency code), so this exercises the identical arithmetic a JPY invoice
  // would hit, just at JPY's native "1 minor unit = 1 yen" scale.
  {
    name: "zero-decimal-currency-shaped amounts (JPY-like)",
    lines: [
      { unit_price_minor: 2500000n, quantity: "3", tax_rate_bp: 1000 },
      { unit_price_minor: 999999n, quantity: "1", tax_rate_bp: 2000 },
    ],
  },
  // Single 0bp line -- the one rate whose forward split is a bijection, used
  // to pin invariant c (an exactly-reconstructing case must never grow a
  // "Rounding adjustment" line).
  {
    name: "1 line, 0bp, full total (exact reconstruction pins invariant c)",
    lines: [{ unit_price_minor: 424242n, quantity: "1", tax_rate_bp: 0 }],
  },
  // ── Negative-line scenarios (discounts / adjustments) ──────────────────
  // A negative line at a rate that ALSO has a positive line: the rate group's
  // net gross stays positive, so the rate survives the allocation, just at a
  // reduced share.
  {
    name: "negative discount line offset by a positive line at the same rate",
    lines: [
      { unit_price_minor: 100000n, quantity: "1", tax_rate_bp: 2000 },
      { unit_price_minor: -20000n, quantity: "1", tax_rate_bp: 2000 },
    ],
  },
  // A negative line at a rate with NO offsetting positive line at that same
  // rate -- the defect's exact mechanism: that rate group's gross is
  // strictly negative and must be excluded from the allocation entirely.
  {
    name: "negative line at a rate with no offsetting positive line at that rate",
    lines: [
      { unit_price_minor: 100000n, quantity: "1", tax_rate_bp: 2000 },
      { unit_price_minor: -3000n, quantity: "1", tax_rate_bp: 0 },
    ],
  },
  // A larger negative line than the positive lines at OTHER rates combined,
  // plus a positive line at the negative line's own rate too small to bring
  // that group back to positive -- a net-negative rate group, mixed in with
  // otherwise-positive groups.
  {
    name: "net-negative rate group mixed with positive groups",
    lines: [
      { unit_price_minor: 100000n, quantity: "1", tax_rate_bp: 2000 },
      { unit_price_minor: -100000n, quantity: "1", tax_rate_bp: 1000 },
      { unit_price_minor: 50000n, quantity: "1", tax_rate_bp: 2000 },
    ],
  },
  // Several negative lines at several different rates, each rate's own group
  // net-negative, alongside a single positive group carrying the whole
  // allocation.
  {
    name: "multiple net-negative rate groups plus one positive group",
    lines: [
      { unit_price_minor: 200000n, quantity: "1", tax_rate_bp: 550 },
      { unit_price_minor: -50000n, quantity: "1", tax_rate_bp: 1000 },
      { unit_price_minor: -30000n, quantity: "1", tax_rate_bp: 2000 },
      { unit_price_minor: -1000n, quantity: "1", tax_rate_bp: 0 },
    ],
  },
]

function totalGrossOf(lines: ReversalSourceLine[]): bigint {
  let total = 0n
  for (const l of lines) {
    const subtotal = lineSubtotal({ quantity: l.quantity, unit_price_minor: l.unit_price_minor })
    total += subtotal + lineTax({ subtotal_minor: subtotal, tax_rate_bp: l.tax_rate_bp })
  }
  return total
}

/** Remainders to try against a scenario's total gross: 1 minor unit, the full
 *  total, one minor unit short of the full total (the pinned repro shape),
 *  roughly a third and roughly two-sevenths of the total (prime-ish
 *  fractions that force rounding), and the total itself minus a prime. */
function remaindersFor(totalGross: bigint): bigint[] {
  const candidates = [
    1n,
    totalGross,
    totalGross > 0n ? totalGross - 1n : 0n,
    (totalGross * 1n) / 3n,
    (totalGross * 2n) / 7n,
    totalGross > 97n ? totalGross - 97n : totalGross,
  ]
  // Dedupe and drop negatives (a degenerate tiny total could make a
  // subtraction go negative before the guard above catches it).
  return [...new Set(candidates)].filter((r) => r >= 0n)
}

describe("buildAdjustmentReversalItems property guard", () => {
  for (const scenario of SCENARIOS) {
    const totalGross = totalGrossOf(scenario.lines)
    for (const remainder of remaindersFor(totalGross)) {
      test(`${scenario.name} | remainder ${remainder.toString()}`, () => {
        const items = buildAdjustmentReversalItems(scenario.lines, remainder, "goods")
        assertBothInvariants(items, remainder)
      })
    }
  }

  // The exact minimal repro from the adversarial review, pinned by name so
  // this specific regression can never silently come back: a single
  // original line (unit_price_minor=748209, quantity=2, tax_rate_bp=2000)
  // whose full gross is 1795702, reversed for 1795701 (one minor unit less
  // than the full total) -- the forward split used to overshoot its single
  // rate group by exactly 1, so the "Rounding adjustment" sweep line came
  // out at unit_price_minor: +1, a positive line on a credit note.
  test("minimal repro: single 2000bp line, remainder one minor unit short of full gross", () => {
    const originalLines: ReversalSourceLine[] = [
      { unit_price_minor: 748209n, quantity: 2, tax_rate_bp: 2000 },
    ]
    const remainingGrossMinor = 1795701n
    expect(totalGrossOf(originalLines)).toBe(1795702n)

    const items = buildAdjustmentReversalItems(originalLines, remainingGrossMinor, "goods")

    for (const it of items) {
      expect(it.unit_price_minor as bigint <= 0n).toBe(true)
    }
    assertBothInvariants(items, remainingGrossMinor)
  })

  // Counter-case 1 from the adversarial review: a NEGATIVE rate group (a
  // discount line at a rate with no offsetting positive line) used to survive
  // the allocation and turn a floored net negative, which the reversal then
  // emitted as a POSITIVE unit_price_minor. Pinned by name so this exact
  // regression is guarded: 100.00 at 2000bp (gross 12000) and -30.00 at 0bp
  // (gross -3000), reversed for a remaining gross of 500 minor units.
  test("counter-case 1: negative 0bp group excluded, no positive line emitted", () => {
    const originalLines: ReversalSourceLine[] = [
      { unit_price_minor: 10000n, quantity: "1", tax_rate_bp: 2000 },
      { unit_price_minor: -3000n, quantity: "1", tax_rate_bp: 0 },
    ]
    const remainingGrossMinor = 500n

    const items = buildAdjustmentReversalItems(originalLines, remainingGrossMinor, "goods")

    expect(items).toEqual([
      expect.objectContaining({ unit_price_minor: -416n, tax_rate_bp_override: 2000 }),
      expect.objectContaining({ unit_price_minor: -1n, tax_rate_bp_override: 0 }),
    ])
    assertBothInvariants(items, remainingGrossMinor)
  })

  // Counter-case 2 from the adversarial review: a net-negative 1000bp group
  // (a -100.00 line at 1000bp outweighing nothing else at that rate) used to
  // pull a floored net past zero and emit a POSITIVE reversal line. Pinned by
  // name: 100.00 at 2000bp, -100.00 at 1000bp, 50.00 at 2000bp, reversed for
  // a remaining gross of 300 minor units.
  test("counter-case 2: net-negative 1000bp group excluded, no positive line emitted", () => {
    const originalLines: ReversalSourceLine[] = [
      { unit_price_minor: 10000n, quantity: "1", tax_rate_bp: 2000 },
      { unit_price_minor: -10000n, quantity: "1", tax_rate_bp: 1000 },
      { unit_price_minor: 5000n, quantity: "1", tax_rate_bp: 2000 },
    ]
    const remainingGrossMinor = 300n

    const items = buildAdjustmentReversalItems(originalLines, remainingGrossMinor, "goods")

    expect(items).toEqual([expect.objectContaining({ unit_price_minor: -250n, tax_rate_bp_override: 2000 })])
    assertBothInvariants(items, remainingGrossMinor)
  })

  // Net-negative-invoice edge: excluding every negative rate group can leave
  // NO positive group at all. Must not divide by zero and must not emit a
  // positive line -- falls back to a single 0-tax reversal line for the
  // whole remaining amount.
  test("all rate groups non-positive: falls back to a single 0-tax line, no division by zero", () => {
    const originalLines: ReversalSourceLine[] = [
      { unit_price_minor: -10000n, quantity: "1", tax_rate_bp: 2000 },
      { unit_price_minor: -5000n, quantity: "1", tax_rate_bp: 1000 },
    ]
    const remainingGrossMinor = 700n

    const items = buildAdjustmentReversalItems(originalLines, remainingGrossMinor, "goods")

    expect(items).toEqual([
      expect.objectContaining({ unit_price_minor: -700n, tax_rate_bp_override: 0 }),
    ])
    assertBothInvariants(items, remainingGrossMinor)
  })
})
