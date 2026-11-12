// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Carrier WORDMARKS -- the data behind the collapsed carrier control in the
// prep grid's total cell.
//
// The offer picker used to be a ~140px `<select>` rendering "Chronopost
// Chrono..." under a price line that also spelled the carrier out in words.
// Between them they set the width of the whole Total column, and Total is one
// of the columns that have to fit before the sticky Actions cell (see
// gestalt/charters/boxtal-prep-grid.md). The owner's call was to collapse the
// selector to the carrier's LOGO alone.
//
// The first pass at that drew 2-3 letter abbreviations on a brand-coloured
// badge (`CHR` for Chronopost), which is not a logo and is LESS recognisable
// than the carrier's name. These brands ARE wordmarks: the name set in the
// brand's own colours is both the recognisable form AND the compact one, so
// that is what a mark is now -- the carrier's NAME, its foreground colour(s),
// and the ground it sits on. Two-tone brands (FedEx's purple "Fed" + orange
// "Ex", Chronopost's blue + green) carry a second segment.
//
// A mark is DATA, not a hand-drawn per-carrier component: `CarrierLogo`
// (src/ui/icon.tsx) is the only renderer, so every mark gets its name onto
// `title` + `aria-label` by construction, and a pure test can assert the
// property without a DOM. The app is sandboxed: everything here is inline SVG,
// there is no image URL and no fetch.
//
// WIDTH is declared, not measured at runtime: the renderer sets `textLength`
// with `lengthAdjust="spacingAndGlyphs"`, so the wordmark is condensed to
// exactly `width` regardless of the platform font's metrics. That is what keeps
// the Total column's width a fact rather than a hope, and it is why the oracle
// can assert the cap from data.
//
// An unknown carrier has NO mark. It falls back to its short text name rather
// than to a generic glyph, because a parcel handed to an unnamable carrier is
// exactly the thing an operator must be able to read.

import { CARRIER_BRANDS, resolveCarrierBrand } from "../carriers"

/** Hard cap on a mark's rendered width at the row's small type, in px. The
 *  Total column pays for it, and it is the column the 2026-09-08 pass took
 *  33px out of; nothing here may quietly grow past this. */
export const MARK_MAX_WIDTH = 46

/** Reference height a mark is authored at (the renderer scales `width` with the
 *  caller's `height`, so every mark keeps the same height on the row). */
export const MARK_HEIGHT = 14

export interface CarrierMark {
  /** Canonical brand key (CARRIER_BRANDS.key). */
  brand: string
  /** ACCESSIBLE NAME. Goes on the svg's `title` + `aria-label`, verbatim. */
  name: string
  /** The wordmark's first (or only) segment: real letters, the brand's name. */
  text: string
  /** Second segment of a two-tone wordmark ("Ex" of FedEx), drawn in `fg2`. */
  text2?: string
  /** Brand colour of `text`. */
  fg: string
  /** Brand colour of `text2`, when there is one. */
  fg2?: string
  /** The ground the wordmark sits on. Explicit in both themes: the mark paints
   *  its own background so a brand colour never lands on the theme's. */
  bg: string
  /** Declared rendered width at MARK_HEIGHT, in px. <= MARK_MAX_WIDTH. */
  width: number
}

/**
 * One wordmark per brand this org's Boxtal account actually surfaces
 * (CARRIER_BRANDS). Not a copy of any carrier's logo FILE (no artwork is
 * vendored): the brand's name, in the brand's colours, on the brand's ground,
 * which is what a wordmark logo is anyway at 14px. The `carrier-mark.test.ts`
 * oracle fails if a brand is added to CARRIER_BRANDS without a mark here.
 */
export const CARRIER_MARKS: readonly CarrierMark[] = [
  // White on the UPS brown.
  { brand: "ups", name: "UPS", text: "UPS", fg: "#ffffff", bg: "#351c15", width: 26 },
  // The two-tone wordmark: purple "Fed", orange "Ex", on white.
  {
    brand: "fedex",
    name: "FedEx",
    text: "Fed",
    text2: "Ex",
    fg: "#4d148c",
    fg2: "#ff6600",
    bg: "#ffffff",
    width: 34,
  },
  // Red on the DHL yellow.
  { brand: "dhl", name: "DHL", text: "DHL", fg: "#d40511", bg: "#ffcc00", width: 26 },
  // Chronopost's blue and green, on white.
  {
    brand: "chronopost",
    name: "Chronopost",
    text: "Chrono",
    text2: "post",
    fg: "#003c7d",
    fg2: "#5fb624",
    bg: "#ffffff",
    width: 46,
  },
  // La Poste's blue on its yellow, named for the parcel product an operator
  // actually reads on the offer ("Colissimo").
  {
    brand: "laposte",
    name: "La Poste / Colissimo",
    text: "Colissimo",
    fg: "#003da5",
    bg: "#ffce00",
    width: 44,
  },
  {
    brand: "mondialrelay",
    name: "Mondial Relay",
    text: "Mondial Relay",
    fg: "#c8102e",
    bg: "#ffffff",
    width: 46,
  },
  {
    brand: "colisprive",
    name: "Colis Prive",
    text: "Colis Prive",
    fg: "#e2530f",
    bg: "#ffffff",
    width: 44,
  },
  // White on the TNT orange.
  { brand: "tnt", name: "TNT", text: "TNT", fg: "#ffffff", bg: "#ff6600", width: 26 },
  { brand: "sodexi", name: "Sodexi", text: "Sodexi", fg: "#0a5c9e", bg: "#ffffff", width: 32 },
  {
    brand: "happypost",
    name: "Happy Post",
    text: "Happy Post",
    fg: "#00706b",
    bg: "#ffffff",
    width: 44,
  },
]

const MARK_BY_BRAND = new Map<string, CarrierMark>(CARRIER_MARKS.map((m) => [m.brand, m]))

/** The whole wordmark as one string: what an operator reads off the mark. */
export function markWordmark(m: CarrierMark): string {
  return `${m.text}${m.text2 ?? ""}`
}

/** Every brand key that has a mark. Exported for the oracle. */
export function markedCarrierBrands(): string[] {
  return CARRIER_MARKS.map((m) => m.brand)
}

/**
 * The mark for a carrier as Boxtal names it ("FedEx", "Chronopost", "Colissimo
 * Domicile", ...), resolved through the SAME brand classifier the allowlist
 * uses, so a service variant under a known brand still gets its brand's mark.
 * Null when the carrier belongs to no known brand -- the caller then shows
 * `carrierShortName` instead of an unnamable glyph.
 */
export function carrierMark(carrier: string | null | undefined): CarrierMark | null {
  if (!carrier) return null
  const brand = resolveCarrierBrand(carrier)
  if (!brand) return null
  return MARK_BY_BRAND.get(brand) ?? null
}

/**
 * The fallback label for a carrier with no mark: its first word, capped, so an
 * unknown carrier still reads as a name in a cell measured in tens of pixels.
 * Never empty for a non-blank input.
 */
export function carrierShortName(carrier: string | null | undefined): string {
  const first = (carrier ?? "").trim().split(/\s+/)[0] ?? ""
  return first.length > 10 ? first.slice(0, 10) : first
}

/**
 * What the collapsed control announces and shows for a carrier: a mark when the
 * brand is known, otherwise the short text name. `name` is ALWAYS a real name --
 * that is the property the accessibility rule rests on.
 */
export function carrierDisplay(
  carrier: string | null | undefined,
): { mark: CarrierMark; name: string } | { mark: null; name: string } {
  const mark = carrierMark(carrier)
  if (mark) return { mark, name: mark.name }
  const short = carrierShortName(carrier)
  return { mark: null, name: short || "Unknown carrier" }
}

/** Guard: every enumerated brand must have a mark (used by the oracle). */
export function brandsMissingAMark(): string[] {
  return CARRIER_BRANDS.filter((b) => !MARK_BY_BRAND.has(b.key)).map((b) => b.key)
}
