// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { isParcelLine, unresolvedLinesBlockLabel } from "./shippable-lines"

const unlinked = (description: string, extra: Record<string, unknown> = {}) => ({
  product_source: null,
  external_id: null,
  description,
  quantity: 1,
  line_kind: "goods",
  ...extra,
})

describe("isParcelLine", () => {
  it("a linked line is always a parcel line", () => {
    expect(
      isParcelLine({
        product_source: "shopify",
        external_id: "V1",
        description: "Shipping",
        line_kind: "goods",
      }),
    ).toBe(true)
    expect(
      isParcelLine({ product_source: "shopify", external_id: "V1", line_kind: "software" }),
    ).toBe(true)
  })
  it("unlinked shipping/software kinds and text lines are not parcel lines", () => {
    expect(isParcelLine(unlinked("Shipping (Express)", { line_kind: "shipping" }))).toBe(false)
    expect(isParcelLine(unlinked("Licence", { line_kind: "software" }))).toBe(false)
    expect(isParcelLine(unlinked("Note: deliver to the back door", { quantity: 0 }))).toBe(false)
  })
  it("unlinked goods lines that name a shipping charge are not parcel lines", () => {
    for (const d of [
      "Shipping",
      "shipping (DHL Express)",
      "Frais de port",
      "Livraison",
      "Versandkosten",
      "Verzendkosten",
      "Freight",
      "Postage",
      "Envío",
      "Shipping costs",
      "Shipping (Express)",
      "Shipping & handling",
      "Frais de port (Colissimo suivi)",
      "Expédition",
    ]) {
      expect(isParcelLine(unlinked(d))).toBe(false)
    }
  })
  it("a charge word followed by a product detail stays a parcel line, never skipped silently", () => {
    for (const d of [
      "Shipping - replacement unit",
      "Delivery: carry case",
      "Freight - pallet of 4 units",
      "Envío - controller",
      "Spedizione: cavo USB-C",
      "Carriage (black)",
      "Shipping (black edition)",
      "Expedition",
      "Porto",
    ]) {
      expect(isParcelLine(unlinked(d))).toBe(true)
    }
  })
  it("an unreadable quantity on an unlinked line counts as goods", () => {
    expect(isParcelLine(unlinked("Widget", { quantity: "2,0" }))).toBe(true)
    expect(isParcelLine(unlinked("Shipping", { quantity: "2,0" }))).toBe(false)
  })
  it("an unlinked real product stays a parcel line (unresolved, visible)", () => {
    for (const d of [
      "Widget Pro stand",
      "Transport case",
      "Portable stand",
      "Delivery-ready kit",
      "Shipping crate",
      "",
    ]) {
      expect(isParcelLine(unlinked(d))).toBe(true)
    }
    expect(isParcelLine(unlinked("Shipping crate", { hs_code: "441520" }))).toBe(true)
  })
})

describe("unresolvedLinesBlockLabel", () => {
  it("blocks on unresolved lines unless an operator carton covers a customs-free route", () => {
    expect(unresolvedLinesBlockLabel({ unresolved: [] })).toBe(false)
    expect(unresolvedLinesBlockLabel({ unresolved: [1] })).toBe(true)
    expect(
      unresolvedLinesBlockLabel({
        unresolved: [1],
        parcel_override: true,
        customs_required: false,
      }),
    ).toBe(false)
    expect(
      unresolvedLinesBlockLabel({ unresolved: [1], parcel_override: true, customs_required: true }),
    ).toBe(true)
  })
})
