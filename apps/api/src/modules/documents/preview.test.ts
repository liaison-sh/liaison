// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pure half of the template preview (preview.ts): the SAMPLE record built
// from a record type's declared fields, the paths a body reads, and the paths
// its record type does not declare.

import { describe, expect, it } from "bun:test"
import type { PrintDeclaration } from "~/modules/apps/app-registries"
import { sampleRecordFor, templatePaths, unknownFieldsOf } from "./preview"

const DECLARATION: PrintDeclaration = {
  recordTool: "record_get",
  idParam: "id",
  label: "Shipment",
  fields: [
    { path: "order.customer.name", label: "Customer", type: "string" },
    { path: "shipped_on", label: "Ship date", type: "date" },
    { path: "insured", label: "Insured", type: "boolean" },
    { path: "lines.sku", label: "SKU", type: "string", repeat: "lines" },
    { path: "lines.quantity", label: "Quantity", type: "number", repeat: "lines" },
  ],
}

describe("sample records", () => {
  it("gives every declared field a made-up value named after its label", () => {
    const sample = sampleRecordFor(DECLARATION)
    expect(sample).toMatchObject({
      order: { customer: { name: "Sample Customer" } },
      insured: true,
      lines: [
        { sku: "Sample SKU", quantity: 1 },
        { sku: "Sample SKU 2", quantity: 2 },
      ],
    })
    expect(sample.shipped_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("fills as many rows as asked, and never writes through the prototype", () => {
    expect((sampleRecordFor(DECLARATION, () => 3).lines as unknown[]).length).toBe(3)
    const hostile = sampleRecordFor({
      fields: [{ path: "__proto__.polluted", label: "x", type: "string" }],
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.hasOwn(hostile, "__proto__")).toBe(true)
  })
})

describe("template paths", () => {
  const body = {
    blocks: [
      { type: "heading", text: "Dear {{order.customer.name}}" },
      { type: "paragraph", text: "Shipped {{shipped_on}}, ref {{order_ref}}" },
      { type: "list", from: "lines", line: "{{quantity}} x {{sku}} ({{hts}})" },
    ],
  }

  it("lists placeholders, list sources and row paths with the list prefix", () => {
    expect(templatePaths({ kind: "rich_text", body, mapping: {} })).toEqual([
      "order.customer.name",
      "shipped_on",
      "order_ref",
      "lines",
      "lines.quantity",
      "lines.sku",
      "lines.hts",
    ])
    expect(
      templatePaths({ kind: "pdf_form", body: null, mapping: { a: { path: "lines.0.sku" } } }),
    ).toEqual(["lines.0.sku"])
  })

  it("reports exactly the paths the record type does not declare", () => {
    const paths = templatePaths({ kind: "rich_text", body, mapping: {} })
    expect(unknownFieldsOf(paths, DECLARATION)).toEqual([
      { path: "order_ref" },
      { path: "lines.hts" },
    ])
    expect(unknownFieldsOf(["lines.0.sku"], DECLARATION)).toEqual([])
    expect(unknownFieldsOf(["x"], null)).toEqual([{ path: "x" }])
  })
})
