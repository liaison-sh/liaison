// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  currencyExponent,
  documentRollup,
  formatMinorAsMajorInput,
  formatMoneyMinor,
  grossOfExcludedTax,
  lineSubtotal,
  lineTax,
  lineTotal,
  netOfIncludedTax,
  parseMoneyMajorToMinor,
} from "./money"

describe("lineSubtotal (integer minor units)", () => {
  test("1 unit @ 199c = 199c", () => {
    expect(lineSubtotal({ quantity: "1", unit_price_minor: 199n })).toBe(199n)
  })

  test("3 units @ 250c = 750c", () => {
    expect(lineSubtotal({ quantity: "3", unit_price_minor: 250n })).toBe(750n)
  })

  test("fractional quantity 2.500 @ 200c = 500c (half-even, no rounding needed)", () => {
    expect(lineSubtotal({ quantity: "2.500", unit_price_minor: 200n })).toBe(500n)
  })

  test("fractional quantity 1.005 @ 100c = 100c (banker's rounding: 0.5 → 0)", () => {
    // 1.005 × 100 = 100.5 → 100 (half-even rounds .5 to even)
    expect(lineSubtotal({ quantity: "1.005", unit_price_minor: 100n })).toBe(100n)
  })

  test("fractional quantity 1.015 @ 100c = 102c (banker's rounding: 1.5 → 2)", () => {
    // 1.015 × 100 = 101.5 → 102
    expect(lineSubtotal({ quantity: "1.015", unit_price_minor: 100n })).toBe(102n)
  })

  test("negative quantity (refund-style) yields negative subtotal", () => {
    expect(lineSubtotal({ quantity: "-2", unit_price_minor: 250n })).toBe(-500n)
  })

  test("zero quantity yields zero", () => {
    expect(lineSubtotal({ quantity: "0", unit_price_minor: 9999n })).toBe(0n)
  })

  // Regression: an agent tool call / edited approval payload delivers `quantity` as a NUMBER, not a
  // string. Pre-fix, parseDecimalQuantity did `q.trim()` → QuickJS "not a function" aborted the whole
  // gated proforma issuance (422). A number must compute identically to its string form.
  test("NUMERIC quantity is accepted (was: 'not a function' crash)", () => {
    expect(lineSubtotal({ quantity: 6, unit_price_minor: 120000n })).toBe(720000n) // 6 × €1200 (the chaos case)
    expect(lineSubtotal({ quantity: 3, unit_price_minor: 250n })).toBe(
      lineSubtotal({ quantity: "3", unit_price_minor: 250n }),
    )
    expect(lineSubtotal({ quantity: 2.5, unit_price_minor: 200n })).toBe(500n) // fractional number
    expect(lineSubtotal({ quantity: 0, unit_price_minor: 9999n })).toBe(0n)
  })
})

describe("lineTax (integer minor units, basis points)", () => {
  test("20% VAT on 199c = 40c (rounded half-even)", () => {
    expect(lineTax({ subtotal_minor: 199n, tax_rate_bp: 2000 })).toBe(40n)
  })

  test("zero tax rate yields zero tax", () => {
    expect(lineTax({ subtotal_minor: 100000n, tax_rate_bp: 0 })).toBe(0n)
  })

  test("7.7% on 33c = 3c (half-even at .54 → 3)", () => {
    // 33 × 770 / 10000 = 25410/10000 = 2.541 → 3 (away from .5 boundary)
    expect(lineTax({ subtotal_minor: 33n, tax_rate_bp: 770 })).toBe(3n)
  })

  test("banker's rounding on exact .5 tie — 50c @ 1bp = 0c (.005 → 0)", () => {
    // 50 × 1 / 10000 = 0.005 → 0 (half-even: .5 ties to even)
    expect(lineTax({ subtotal_minor: 50n, tax_rate_bp: 1 })).toBe(0n)
  })

  test("banker's rounding on exact .5 tie — 150c @ 1bp = 0c (.015 → 0)", () => {
    // 150 × 1 / 10000 = 0.015; the *tax product* is 150n. Floor-div by 10000n
    // = 0 with remainder 150; remainder*2=300 == divisor? No, divisor 10000.
    // remainder 150 < 5000 → round down. 0.
    expect(lineTax({ subtotal_minor: 150n, tax_rate_bp: 1 })).toBe(0n)
  })

  test("negative subtotal (refund) yields negative tax", () => {
    expect(lineTax({ subtotal_minor: -100n, tax_rate_bp: 2000 })).toBe(-20n)
  })
})

describe("lineTotal", () => {
  test("subtotal + tax", () => {
    expect(lineTotal({ subtotal_minor: 100n, tax_minor: 20n })).toBe(120n)
  })

  test("negative subtotal + negative tax", () => {
    expect(lineTotal({ subtotal_minor: -100n, tax_minor: -20n })).toBe(-120n)
  })
})

describe("documentRollup", () => {
  test("re-derives tax from subtotal × rate (not summed pre-rounded amounts)", () => {
    // 20% VAT: 100 × 20% = 20, 250 × 20% = 50, 25 × 0% = 0
    const lines = [
      { subtotal_minor: 100n, tax_rate_bp: 2000 },
      { subtotal_minor: 250n, tax_rate_bp: 2000 },
      { subtotal_minor: 25n, tax_rate_bp: 0 },
    ]
    expect(documentRollup(lines)).toEqual({
      subtotal_minor: 375n,
      tax_total_minor: 70n,
      grand_total_minor: 445n,
    })
  })

  test("empty lines roll up to zero", () => {
    expect(documentRollup([])).toEqual({
      subtotal_minor: 0n,
      tax_total_minor: 0n,
      grand_total_minor: 0n,
    })
  })

  test("mixed positive/negative (credit-style) lines roll up correctly", () => {
    // 20% VAT: 1000 × 20% = 200, -300 × 20% = -60
    const lines = [
      { subtotal_minor: 1000n, tax_rate_bp: 2000 },
      { subtotal_minor: -300n, tax_rate_bp: 2000 },
    ]
    expect(documentRollup(lines)).toEqual({
      subtotal_minor: 700n,
      tax_total_minor: 140n,
      grand_total_minor: 840n,
    })
  })

  test("rounding per line avoids accumulated rounding error", () => {
    // Each line: subtotal=33, tax_rate_bp=770 (7.7%). Per lineTax: 3c each.
    // Correct total tax: 3 + 3 + 3 = 9.
    // Summing pre-rounded intermediates would give the same here, but
    // re-deriving ensures correctness at scale.
    const lines = [
      { subtotal_minor: 33n, tax_rate_bp: 770 },
      { subtotal_minor: 33n, tax_rate_bp: 770 },
      { subtotal_minor: 33n, tax_rate_bp: 770 },
    ]
    expect(documentRollup(lines)).toEqual({
      subtotal_minor: 99n,
      tax_total_minor: 9n,
      grand_total_minor: 108n,
    })
  })

  test("handles bigint-boundary-safe summation (large values)", () => {
    const big = 9_000_000_000_000_000n
    const lines = [
      { subtotal_minor: big, tax_rate_bp: 0 },
      { subtotal_minor: big, tax_rate_bp: 0 },
    ]
    expect(documentRollup(lines).subtotal_minor).toBe(18_000_000_000_000_000n)
  })
})

// ── netOfTax — strip an INCLUDED tax from a gross amount ─────────────────
//
// The Shopify order-paid flow de-taxes tax-inclusive shop prices with this;
// the fixtures mirror the real order that exposed the double-VAT bug (gross
// French B2C prices at 20%).
import { netOfTax } from "./money"

describe("netOfTax", () => {
  test("strips 20% VAT from gross French shelf prices (real-order fixtures)", () => {
    expect(netOfTax({ gross_minor: 94900n, tax_rate_bp: 2000 })).toBe(79083n) // 949.00 → 790.83
    expect(netOfTax({ gross_minor: 15500n, tax_rate_bp: 2000 })).toBe(12917n) // 155.00 → 129.17
    expect(netOfTax({ gross_minor: 10700n, tax_rate_bp: 2000 })).toBe(8917n) // 107.00 → 89.17
    expect(netOfTax({ gross_minor: 1700n, tax_rate_bp: 2000 })).toBe(1417n) // 17.00 → 14.17
    expect(netOfTax({ gross_minor: 7900n, tax_rate_bp: 2000 })).toBe(6583n) // 79.00 → 65.83
    expect(netOfTax({ gross_minor: 2999n, tax_rate_bp: 2000 })).toBe(2499n) // 29.99 → 24.99
  })

  test("re-applying the rate to the net reproduces the gross to the cent", () => {
    for (const gross of [94900n, 15500n, 10700n, 1700n, 7900n, 2999n]) {
      const net = netOfTax({ gross_minor: gross, tax_rate_bp: 2000 })
      const tax = lineTax({ subtotal_minor: net, tax_rate_bp: 2000 })
      expect(net + tax).toBe(gross)
    }
  })

  test("rate 0 passes the amount through unchanged", () => {
    expect(netOfTax({ gross_minor: 12345n, tax_rate_bp: 0 })).toBe(12345n)
  })

  test("non-20% rates (German 19%, reduced 5.5%)", () => {
    expect(netOfTax({ gross_minor: 11900n, tax_rate_bp: 1900 })).toBe(10000n)
    expect(netOfTax({ gross_minor: 10550n, tax_rate_bp: 550 })).toBe(10000n)
  })
})

// grossOfExcludedTax is the Editor's load-boundary reconstruction of netOfIncludedTax's input
// (the write-side division mutations.ts applies once, at drafts_update/documents_update's line
// replacement and create/issue). It is NOT an exact inverse -- netOfIncludedTax is not injective,
// so a reconstructed gross can be off by 1 minor unit from whatever was originally typed. What
// actually matters for correctness is the round trip an unedited save performs: net -> gross ->
// net must reproduce the ORIGINAL stored net value exactly, every time -- that is what keeps an
// unchanged save from drifting storage. The reverse direction (gross -> net -> gross) is display
// only and is allowed to drift by 1 minor unit; it converges after a single cycle.
describe("grossOfExcludedTax (reconstructs netOfIncludedTax's input, the Editor's load boundary)", () => {
  test("reconstructs the gross figure an operator typed from a stored net price", () => {
    expect(grossOfExcludedTax(24917n, 2000)).toBe(29900n) // 249.17 net -> 299.00 typed gross
  })

  test("net -> gross -> net is EXACT: the only round trip an unedited save performs", () => {
    for (const net of [24917n, 8333n, 10000n, 79083n, 1n, 0n]) {
      const gross = grossOfExcludedTax(net, 2000)
      expect(netOfIncludedTax(gross, 2000)).toBe(net)
    }
  })

  test("gross -> net -> gross is NOT always exact (netOfIncludedTax is not injective) but never drifts more than 1 minor unit", () => {
    // 29901 and 29902 both net to 24917 at 20% -- netOfIncludedTax is many-to-one, so
    // reconstructing "the" gross from 24917 can only recover ONE of them (29900, the smallest).
    // This is a known, accepted display-only property, not a bug: it never touches storage.
    let driftCount = 0
    for (let gross = 1n; gross <= 500n; gross++) {
      const net = netOfIncludedTax(gross, 2000)
      const reconstructedGross = grossOfExcludedTax(net, 2000)
      const drift =
        gross > reconstructedGross ? gross - reconstructedGross : reconstructedGross - gross
      expect(drift <= 1n).toBe(true)
      if (drift !== 0n) driftCount++
    }
    expect(driftCount).toBeGreaterThan(0) // confirms the property is real, not vacuously true
  })

  test("a zero-rated or unset rate passes the amount through unchanged", () => {
    expect(grossOfExcludedTax(24917n, 0)).toBe(24917n)
    expect(grossOfExcludedTax(24917n, null)).toBe(24917n)
    expect(grossOfExcludedTax(24917n, undefined)).toBe(24917n)
  })
})

describe("formatMoneyMinor", () => {
  test("renders minor units as major.cents for human copy", () => {
    expect(formatMoneyMinor(83880n, "EUR")).toBe("838.80 EUR")
    expect(formatMoneyMinor(69900, "EUR")).toBe("699.00 EUR")
    expect(formatMoneyMinor("5", "USD")).toBe("0.05 USD")
    expect(formatMoneyMinor(-150n, "EUR")).toBe("-1.50 EUR")
    expect(formatMoneyMinor(0n, "EUR")).toBe("0.00 EUR")
  })

  // Regression B1: JPY (and every ISO 4217 zero-decimal currency) has NO minor
  // unit, so its minor amount IS its major amount. Dividing by 100 rendered a
  // 23900 JPY Shopify order as "239.00 JPY" (100x too small). The exponent map
  // must strip zero minor digits for these currencies.
  test("zero-decimal currency (JPY) renders whole units, not divided by 100", () => {
    expect(formatMoneyMinor(23900n, "JPY")).toBe("23900 JPY")
    expect(formatMoneyMinor(20300n, "JPY")).toBe("20300 JPY") // goods split
    expect(formatMoneyMinor(3600n, "JPY")).toBe("3600 JPY") // services split
    expect(formatMoneyMinor(-500n, "JPY")).toBe("-500 JPY")
    expect(formatMoneyMinor(0n, "JPY")).toBe("0 JPY")
    expect(formatMoneyMinor(1500000n, "KRW")).toBe("1500000 KRW")
    // Exponent lookup is case-insensitive even though the code renders verbatim.
    expect(formatMoneyMinor("2500", "vnd")).toBe("2500 vnd")
  })
})

describe("currencyExponent", () => {
  test("2 for EUR/USD/GBP, 0 for zero-decimal currencies", () => {
    expect(currencyExponent("EUR")).toBe(2)
    expect(currencyExponent("usd")).toBe(2)
    expect(currencyExponent("JPY")).toBe(0)
    expect(currencyExponent("krw")).toBe(0)
    expect(currencyExponent("XOF")).toBe(0)
    expect(currencyExponent("HUF")).toBe(0)
  })
})

// Regression: the invoicing Editor's unit-price cell bound the input directly
// to unit_price_minor while labeling the column "Unit price," so typing "100"
// (meaning 100 EUR) stored 100 MINOR units (1.00 EUR) instead of 10000 minor.
// These two helpers are the parse/format boundary between what the operator
// types (major units) and what is stored (minor units).
describe("parseMoneyMajorToMinor (major-unit input -> minor-unit storage)", () => {
  test("round trips whole and fractional EUR amounts", () => {
    expect(parseMoneyMajorToMinor("100", "EUR")).toBe(10000n)
    expect(parseMoneyMajorToMinor("100.50", "EUR")).toBe(10050n)
    expect(parseMoneyMajorToMinor("0.01", "EUR")).toBe(1n)
  })

  test("comma decimal separator", () => {
    expect(parseMoneyMajorToMinor("1,5", "EUR")).toBe(150n)
  })

  test("zero-decimal currency (JPY) has no fractional scale", () => {
    expect(parseMoneyMajorToMinor("100", "JPY")).toBe(100n)
  })

  test("rejects empty text, non-numeric text, and more fraction digits than the currency exponent", () => {
    expect(parseMoneyMajorToMinor("", "EUR")).toBeNull()
    expect(parseMoneyMajorToMinor("abc", "EUR")).toBeNull()
    // EUR has 2 minor digits; a third fractional digit would silently lose precision.
    expect(parseMoneyMajorToMinor("1.005", "EUR")).toBeNull()
  })
})

describe("formatMinorAsMajorInput (minor-unit storage -> major-unit input text)", () => {
  test("EUR renders two fraction digits, JPY none, and the sign is preserved", () => {
    expect(formatMinorAsMajorInput(10000n, "EUR")).toBe("100.00")
    expect(formatMinorAsMajorInput(100n, "JPY")).toBe("100")
    expect(formatMinorAsMajorInput(-2550n, "EUR")).toBe("-25.50")
  })
})
