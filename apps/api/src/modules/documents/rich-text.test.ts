// SPDX-License-Identifier: FSL-1.1-ALv2
//
// rich_text templates (rich-text.ts): the body schema, placeholders resolved
// from own record properties only, a missing value printed as a grey
// "[<label>]" run, list blocks one line per row with pagination and the row
// cap, images only through the resolver given, and byte-stable output.

import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import type { DrawCommand } from "@liaison/shared"
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib"
import { extractPdfText } from "../pdf/pdf-text"
import { MAX_PAGES } from "../pdf/replay"
import {
  layoutRichText,
  parseRichTextBody,
  RICH_TEXT_MAX_LIST_ROWS,
  RichTextError,
  renderRichText,
  richTextPlaceholderPaths,
} from "./rich-text"

const LABELS: Record<string, string> = {
  tracking_number: "Tracking number",
  name: "Name",
  "lines.sku": "SKU",
}
const labelOf = (path: string) => {
  const shape = path
    .split(".")
    .filter((s) => !/^\d+$/.test(s))
    .join(".")
  return Object.hasOwn(LABELS, shape) ? (LABELS[shape] ?? path) : path
}

// A 1x1 PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
)
const OWN_IMAGE = "11111111-1111-4111-8111-111111111111"
const FOREIGN_IMAGE = "22222222-2222-4222-8222-222222222222"

const noImages = async () => null

function texts(commands: DrawCommand[]): Array<Extract<DrawCommand, { op: "drawText" }>> {
  return commands.filter((c): c is Extract<DrawCommand, { op: "drawText" }> => c.op === "drawText")
}

function imageXObjects(doc: PDFDocument): number {
  let n = 0
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))
      n += 1
  }
  return n
}

function withoutDates(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("latin1")
    .replace(/\/CreationDate\s*\([^)]*\)/g, "")
    .replace(/\/ModDate\s*\([^)]*\)/g, "")
}

describe("body schema", () => {
  it("accepts every block kind and the page settings", () => {
    const body = {
      page: { size: "Letter", margins: { top: 40, left: 50 }, fontSize: 11 },
      blocks: [
        { type: "heading", text: "Thank you, {{name}}", level: 2 },
        { type: "paragraph", text: "Tracking {{ tracking_number }}" },
        { type: "list", from: "lines", line: "{{sku}} x {{qty}}" },
        { type: "image", fileId: OWN_IMAGE, width: 120, align: "right" },
        { type: "spacer", height: 24 },
      ],
    }
    expect(parseRichTextBody(body)).toEqual(body as never)
    expect(parseRichTextBody({ blocks: [] })).toEqual({ blocks: [] })
  })

  it("refuses bad bodies with the offending path", () => {
    const bad: unknown[] = [
      { blocks: [{ type: "script", text: "x" }] },
      { page: { fontSize: 20 }, blocks: [] },
      { page: { size: "A3" }, blocks: [] },
      { blocks: Array.from({ length: 201 }, () => ({ type: "spacer", height: 1 })) },
      { blocks: [{ type: "paragraph", text: "x".repeat(20_001) }] },
      { blocks: [{ type: "paragraph", text: "Hello {{name | upper}}" }] },
      { blocks: [{ type: "paragraph", text: "Hello {{name}" }] },
      { blocks: [{ type: "list", from: "lines[0]", line: "x" }] },
      { blocks: [{ type: "paragraph", text: "x", extra: true }] },
      { blocks: [], extra: 1 },
    ]
    for (const body of bad) {
      expect(() => parseRichTextBody(body)).toThrow(RichTextError)
    }
    try {
      parseRichTextBody({ blocks: [{ type: "paragraph", text: "{{a b}}" }] })
    } catch (err) {
      expect((err as RichTextError).code).toBe("body_invalid")
      expect((err as Error).message).toContain("blocks.0.text")
    }
  })
})

describe("placeholders", () => {
  it('prints a missing tracking number as a grey "[Tracking number]", never null or undefined', async () => {
    const body = parseRichTextBody({
      blocks: [
        {
          type: "paragraph",
          text: "Dear {{name}}, your parcel {{tracking_number}} is on its way.",
        },
        { type: "paragraph", text: "Carrier: {{carrier}}" },
      ],
    })
    const record = { name: "Acme Łukawski", tracking_number: null }
    const { commands, blanks } = layoutRichText(body, record, labelOf)
    const drawn = texts(commands)
    const grey = drawn.filter((c) => c.color?.r === 0.55)
    expect(grey.map((c) => c.text.trim())).toEqual(["[Tracking number]", "[carrier]"])
    expect(drawn.filter((c) => !c.color).some((c) => c.text.includes("Acme Łukawski"))).toBe(true)
    expect(blanks).toEqual([
      { path: "tracking_number", label: "Tracking number" },
      { path: "carrier", label: "carrier" },
    ])

    const out = await renderRichText({ body, record, labelOf, resolveImage: noImages })
    const text = await extractPdfText(out.bytes)
    expect(text).toContain("[Tracking number]")
    expect(text).toContain("Acme Łukawski")
    expect(text).not.toContain("null")
    expect(text).not.toContain("undefined")
  })

  it("never walks the prototype: {{constructor}} and {{__proto__.x}} print as blanks", () => {
    const body = parseRichTextBody({
      blocks: [
        {
          type: "paragraph",
          text: "a {{constructor}} b {{__proto__.x}} c {{name.constructor.name}} d {{lines.length}}",
        },
      ],
    })
    // A parsed record can carry an OWN "__proto__" key: still never read.
    const record = JSON.parse('{"name":"N","lines":[1],"__proto__":{"x":"leak"}}') as Record<
      string,
      unknown
    >
    const { commands } = layoutRichText(body, record, labelOf)
    const all = texts(commands)
      .map((c) => c.text)
      .join("")
    expect(all).not.toContain("leak")
    expect(all).not.toContain("function")
    expect(all).not.toContain("Object")
    expect(all).not.toContain("String")
    const grey = texts(commands)
      .filter((c) => c.color)
      .map((c) => c.text.trim())
    expect(grey).toEqual([
      "[constructor]",
      "[__proto__.x]",
      "[name.constructor.name]",
      "[lines.length]",
    ])
  })

  it("prints numbers, booleans and Unicode values; blank strings are blanks", () => {
    const body = parseRichTextBody({
      blocks: [{ type: "paragraph", text: "{{n}} {{ok}} {{jp}} {{empty}}" }],
    })
    const { commands } = layoutRichText(
      body,
      { n: 12.5, ok: true, jp: "株式会社", empty: "  " },
      labelOf,
    )
    const all = texts(commands)
      .map((c) => c.text)
      .join("")
    expect(all).toBe("12.5 Yes 株式会社 [empty]")
  })
})

describe("list blocks", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ sku: `SKU-${String(i + 1).padStart(3, "0")}`, qty: 1 }))

  it("prints one line per row, paths relative to the row, and paginates 300 rows", async () => {
    const body = parseRichTextBody({
      blocks: [
        { type: "heading", text: "Packing list" },
        { type: "list", from: "lines", line: "{{sku}} x {{qty}} {{hs}}" },
      ],
    })
    const record = { lines: rows(300) }
    const { commands, pageCount, blanks } = layoutRichText(body, record, labelOf)
    expect(pageCount).toBeGreaterThan(1)
    expect(pageCount).toBeLessThanOrEqual(MAX_PAGES)
    const lines = texts(commands).filter((c) => !c.color && c.text.startsWith("SKU-"))
    expect(lines).toHaveLength(300)
    // Every line stays inside the page's bottom margin.
    for (const c of texts(commands)) expect(c.y).toBeGreaterThanOrEqual(56 - 1)
    // A field missing on every row is one blank.
    expect(blanks).toEqual([{ path: "lines.0.hs", label: "lines.0.hs" }])

    const out = await renderRichText({ body, record, labelOf, resolveImage: noImages })
    const doc = await PDFDocument.load(out.bytes)
    expect(doc.getPageCount()).toBe(pageCount)
    const text = await extractPdfText(out.bytes)
    expect(text).toContain("SKU-001")
    expect(text).toContain("SKU-300")
  })

  it(`refuses more than ${RICH_TEXT_MAX_LIST_ROWS} rows with too_many_rows, never truncating`, () => {
    const body = parseRichTextBody({ blocks: [{ type: "list", from: "lines", line: "{{sku}}" }] })
    let caught: unknown
    try {
      layoutRichText(body, { lines: rows(RICH_TEXT_MAX_LIST_ROWS + 1) }, labelOf)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RichTextError)
    expect((caught as RichTextError).code).toBe("too_many_rows")
  })

  it("a missing list prints its grey label", () => {
    const body = parseRichTextBody({ blocks: [{ type: "list", from: "lines", line: "{{sku}}" }] })
    const { commands } = layoutRichText(body, {}, labelOf)
    expect(texts(commands).map((c) => c.text)).toEqual(["[lines]"])
  })
})

describe("images", () => {
  it("draws the template's own image and skips one the resolver does not find", async () => {
    const resolveImage = async (id: string) =>
      id === OWN_IMAGE ? { bytes: PNG, mime: "image/png" } : null
    const own = await renderRichText({
      body: { blocks: [{ type: "image", fileId: OWN_IMAGE, width: 40 }] },
      record: {},
      labelOf,
      resolveImage,
    })
    expect(imageXObjects(await PDFDocument.load(own.bytes))).toBeGreaterThan(0)

    const foreign = await renderRichText({
      body: { blocks: [{ type: "image", fileId: FOREIGN_IMAGE, width: 40 }] },
      record: {},
      labelOf,
      resolveImage,
    })
    expect(imageXObjects(await PDFDocument.load(foreign.bytes))).toBe(0)
  })
})

describe("output", () => {
  it("is byte-stable for a fixed input (the creation dates aside)", async () => {
    const input = {
      body: {
        page: { size: "A4", fontSize: 11 },
        blocks: [
          { type: "heading", text: "Declaration {{name}}" },
          { type: "paragraph", text: "Line one\nLine two {{tracking_number}} 株式会社" },
          { type: "list", from: "lines", line: "{{sku}}" },
        ],
      },
      record: { name: "N", lines: [{ sku: "A" }, { sku: "B" }] },
      labelOf,
      resolveImage: noImages,
      title: "Declaration",
    }
    const a = await renderRichText(input)
    const b = await renderRichText(input)
    const hash = (x: Uint8Array) => createHash("sha256").update(withoutDates(x)).digest("hex")
    expect(hash(a.bytes)).toBe(hash(b.bytes))
  })
})

describe("conditions, tables, repeats and missing-value words", () => {
  const record = {
    invoice: { number: "INV-1" },
    phone: null,
    lines: [
      { sku: "A-1", name: "Alpha", qty: 2, attributes: { metal: "aluminium", smelt: "Atlantis" } },
      { sku: "B-2", name: "Beta", qty: 1, attributes: { metal: "steel", smelt: "" } },
      { sku: "C-3", name: "Gamma", qty: 1, attributes: {} },
    ],
  }

  it("prints a block only when its conditions hold, * reading any row", () => {
    const body = parseRichTextBody({
      blocks: [
        {
          type: "paragraph",
          text: "has steel",
          when: { path: "lines.*.attributes.metal", equals: "steel" },
        },
        {
          type: "paragraph",
          text: "has copper",
          when: { path: "lines.*.attributes.metal", equals: "copper" },
        },
        { type: "paragraph", text: "no phone", when: { path: "phone", is: "absent" } },
        {
          type: "paragraph",
          text: "both",
          when: [{ path: "invoice.number" }, { path: "lines.*.sku", in: ["b-2", "z"] }],
        },
      ],
    })
    const drawn = texts(layoutRichText(body, record, labelOf).commands).map((c) => c.text.trim())
    expect(drawn).toEqual(["has steel", "no phone", "both"])
  })

  it("{{path ?? words}} prints the words grey and lists the blank; {{path ??}} prints nothing", () => {
    const body = parseRichTextBody({
      blocks: [
        { type: "paragraph", text: "Phone: {{phone ??}}." },
        {
          type: "list",
          from: "lines",
          where: { path: "attributes.metal" },
          line: "{{name}} smelt: {{attributes.smelt ?? not confirmed by the supplier}} ({{invoice.number}})",
        },
      ],
    })
    const { commands, blanks } = layoutRichText(body, record, labelOf)
    const drawn = texts(commands)
    const all = drawn.map((c) => c.text).join("|")
    expect(all).toContain("Phone: ")
    expect(all).toContain("Atlantis")
    expect(all).not.toContain("Gamma")
    const grey = drawn.filter((c) => c.color?.r === 0.55).map((c) => c.text.trim())
    expect(grey.join(" ")).toBe("not confirmed by the supplier")
    expect(blanks.map((b) => b.path)).toEqual(["lines.1.attributes.smelt"])
    // A row's path falls back to the record root: the invoice number prints on every row.
    expect(drawn.filter((c) => c.text.includes("INV-1")).length).toBe(2)
  })

  it("lays out a table over a list and a fixed table inside a repeat", async () => {
    const body = parseRichTextBody({
      blocks: [
        {
          type: "table",
          from: "lines",
          columns: [
            { header: "SKU", text: "{{sku}}", width: 1 },
            { header: "Article", text: "{{name}}", width: 3 },
            { header: "Qty", text: "{{qty}}", width: 1 },
          ],
        },
        {
          type: "repeat",
          from: "lines",
          where: { path: "attributes.metal" },
          blocks: [
            { type: "heading", level: 3, text: "{{name}}" },
            {
              type: "table",
              columns: [{ width: 2, bold: true }, { width: 3 }],
              rows: [
                ["Metal", "{{attributes.metal}}"],
                ["Country of smelt", "{{attributes.smelt ?? not confirmed}}"],
                {
                  cells: ["Steel only", "yes"],
                  when: { path: "attributes.metal", equals: "steel" },
                },
              ],
            },
          ],
        },
      ],
    })
    const { commands } = layoutRichText(body, record, labelOf)
    expect(commands.some((c) => c.op === "drawRectangle")).toBe(true)
    const drawn = texts(commands).map((c) => c.text)
    expect(drawn.filter((t) => t === "Steel only").length).toBe(1)
    expect(drawn.filter((t) => t === "Metal").length).toBe(2)
    const out = await renderRichText({ body, record, labelOf, resolveImage: noImages })
    const text = await extractPdfText(out.bytes)
    for (const want of ["SKU", "Alpha", "Gamma", "Country of smelt", "Atlantis", "not confirmed"]) {
      expect(text).toContain(want)
    }
  })

  it("refuses a table with both or neither of from and rows, and a malformed condition", () => {
    const bad: unknown[] = [
      { blocks: [{ type: "table", columns: [{ text: "x" }] }] },
      { blocks: [{ type: "table", columns: [{ text: "x" }], from: "lines", rows: [["x"]] }] },
      { blocks: [{ type: "table", columns: [{}, {}], rows: [["only one"]] }] },
      { blocks: [{ type: "paragraph", text: "x", when: { path: "a..b" } }] },
      {
        blocks: [{ type: "paragraph", text: "x", when: { path: "a", is: "present", equals: "b" } }],
      },
      {
        blocks: [
          { type: "repeat", from: "lines", blocks: [{ type: "repeat", from: "x", blocks: [] }] },
        ],
      },
    ]
    for (const body of bad) expect(() => parseRichTextBody(body)).toThrow(RichTextError)
  })
})

describe("computed values: arithmetic, sum and fixed", () => {
  const record = {
    invoice: { number: "INV-1" },
    totals: { value: 300 },
    lines: [
      {
        sku: "SKU-A",
        quantity: 2,
        value: 200,
        attributes: { weight_kg: "0.82", metal: "aluminium" },
      },
      { sku: "SKU-B", quantity: 2, value: 25.2, attributes: { weight_kg: "1.95", metal: "steel" } },
      {
        sku: "SKU-C",
        quantity: 3,
        value: 74.8,
        attributes: { metal: "none", weight_kg: "about 1 kg" },
      },
    ],
  }
  const drawnOf = (text: string, from?: string) => {
    const body = parseRichTextBody({
      blocks: [from ? { type: "list", from, line: text } : { type: "paragraph", text }],
    })
    const { commands, blanks } = layoutRichText(body, record, labelOf)
    const drawn = texts(commands)
    return {
      all: drawn.map((c) => c.text).join(""),
      grey: drawn.filter((c) => c.color?.r === 0.55).map((c) => c.text.trim()),
      blanks: blanks.map((b) => b.path),
    }
  }

  it("multiplies a row's quantity by a per-unit fact and formats it", () => {
    const out = drawnOf(
      "{{sku}} for the {{quantity}} units shipped: {{quantity * attributes.weight_kg | fixed:3}} kg;",
      "lines",
    )
    expect(out.all).toContain("SKU-A for the 2 units shipped: 1.640 kg;")
    expect(out.all).toContain("SKU-B for the 2 units shipped: 3.900 kg;")
  })

  it("a missing or non-numeric operand is a missing value: ?? words apply and the blank is listed", () => {
    const out = drawnOf("{{quantity * attributes.weight_kg | fixed:3 ?? not confirmed}};", "lines")
    expect(out.grey).toEqual(["not confirmed"])
    expect(out.blanks).toEqual(["lines.2.attributes.weight_kg"])
    const bare = drawnOf("{{quantity * attributes.density}};", "lines")
    expect(bare.blanks).toEqual(["lines.0.attributes.density"])
    expect(bare.all).toContain("[lines.0.attributes.density]")
  })

  it("sums over a list, keeps rows by a condition, and computes a percent", () => {
    const out = drawnOf(
      'Steel share: {{sum(lines, value, attributes.metal = "steel") / totals.value * 100 | fixed:1}} percent. Units: {{sum(lines, quantity)}}. Mix: {{(1 + 2) * -2 / 4}}.',
    )
    expect(out.all).toContain("Steel share: 8.4 percent.")
    expect(out.all).toContain("Units: 7.")
    expect(out.all).toContain("Mix: -1.5.")
    expect(out.blanks).toEqual([])
  })

  it("division by zero is a missing value, never Infinity or NaN", () => {
    const out = drawnOf(
      '{{totals.value / 0 ?? n/a}} {{sum(lines, value, sku = "none") / sum(lines, value, sku = "none")}}',
    )
    expect(out.all).not.toContain("Infinity")
    expect(out.all).not.toContain("NaN")
    expect(out.grey.join(" ")).toContain("n/a")
    expect(out.blanks).toContain("totals.value / 0")
  })

  it("fixed on a plain path formats a number; an untouched path prints as before", () => {
    expect(drawnOf("{{totals.value | fixed:2}} {{invoice.number}}").all).toContain("300.00 INV-1")
  })

  it("atLeast and atMost compare a number: a row prints only for two units or more", () => {
    const body = parseRichTextBody({
      blocks: [
        {
          type: "list",
          from: "lines",
          where: { path: "quantity", atLeast: 3 },
          line: "{{sku}} three or more;",
        },
        {
          type: "list",
          from: "lines",
          where: [
            { path: "quantity", atLeast: 2 },
            { path: "quantity", atMost: 2 },
          ],
          line: "{{sku}} exactly two;",
        },
        {
          type: "paragraph",
          text: "weight",
          when: { path: "lines.*.attributes.weight_kg", atLeast: 1 },
        },
        { type: "paragraph", text: "never", when: { path: "invoice.number", atLeast: 0 } },
      ],
    })
    const all = texts(layoutRichText(body, record, labelOf).commands)
      .map((c) => c.text)
      .join("")
    expect(all).toContain("SKU-C three or more;")
    expect(all).toContain("SKU-A exactly two;SKU-B exactly two;")
    expect(all).toContain("weight")
    expect(all).not.toContain("never")
    expect(() =>
      parseRichTextBody({
        blocks: [{ type: "paragraph", text: "x", when: { path: "a", atLeast: 1, equals: "b" } }],
      }),
    ).toThrow(RichTextError)
  })

  it("reports the paths an expression reads", () => {
    const body = parseRichTextBody({
      blocks: [
        {
          type: "paragraph",
          text: '{{sum(lines, quantity * attributes.weight_kg, attributes.metal = "steel") / totals.value}}',
        },
      ],
    })
    expect(richTextPlaceholderPaths(body)).toEqual([
      "lines",
      "lines.quantity",
      "lines.attributes.weight_kg",
      "lines.attributes.metal",
      "totals.value",
    ])
  })

  it("refuses malformed expressions, unknown filters and functions", () => {
    for (const text of [
      "{{quantity *}}",
      "{{(quantity}}",
      "{{quantity | round:2}}",
      "{{quantity | fixed:9}}",
      "{{max(lines, quantity)}}",
      "{{sum(lines, sum(lines, quantity))}}",
      "{{quantity; 1}}",
      "{{a b}}",
      "{{sum(lines, value, metal = steel)}}",
    ]) {
      expect(() => parseRichTextBody({ blocks: [{ type: "paragraph", text }] }), text).toThrow(
        RichTextError,
      )
    }
  })
})
