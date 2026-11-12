// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The goods/software split is deliberate and must stay invisible ON PAPER --
// nothing on either PDF may hint the other exists, or the split defeats itself
// at the border. Internally it is the opposite problem: two rows that merely
// happen to share a customer, whose numbers only LOOK adjacent until something
// else issues in between, and which any sort by date or amount scatters
// entirely.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { build as esbuild } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { renderToString } from "solid-js/web"
import { LIST_COLUMNS } from "../DocumentsList"
import {
  creditedIndicatorOf,
  type PairableRow,
  type PairedRow,
  pairLabelOf,
  pairMemberIds,
  pairSplitDocuments,
} from "./pair-split"

const doc = (id: string, order: string | null, scope: string | null) => ({
  id,
  number: `INV-${id}`,
  shopify_order_number: order,
  scope,
})

describe("pairSplitDocuments", () => {
  test("puts the two halves of one order next to each other, goods first", () => {
    // The real prod shape: another order's document sits BETWEEN the halves.
    const out = pairSplitDocuments([
      doc("3456", "#900", "goods"),
      doc("3455", "#901", "software"),
      doc("3457", "#900", "software"),
    ])
    expect(out.map((p) => p.row.id)).toEqual(["3456", "3457", "3455"])
  })

  test("keeps the pair where the FIRST half sat, so the operator's sort still governs", () => {
    const out = pairSplitDocuments([
      doc("1", null, null),
      doc("2", "#900", "software"),
      doc("3", null, null),
      doc("4", "#900", "goods"),
    ])
    // The pair takes position 2 (where its first member was), goods leading.
    expect(out.map((p) => p.row.id)).toEqual(["1", "4", "2", "3"])
  })

  test("marks both halves with a shared key and their position", () => {
    const out = pairSplitDocuments([doc("a", "#900", "goods"), doc("b", "#900", "software")])
    expect(out[0]).toMatchObject({ pairKey: "#900", position: "first" })
    expect(out[1]).toMatchObject({ pairKey: "#900", position: "last" })
  })

  test("does NOT pair a half whose partner is not in view", () => {
    // Filtered out, or not yet issued. A link to a row that is not on screen is
    // worse than no link.
    const out = pairSplitDocuments([doc("a", "#900", "goods"), doc("b", "#901", "software")])
    expect(out.every((p) => p.pairKey === null)).toBe(true)
    expect(out.map((p) => p.row.id)).toEqual(["a", "b"])
  })

  test("leaves ordinary whole-order documents completely alone", () => {
    const rows = [doc("a", "#900", null), doc("b", null, null), doc("c", "#901", null)]
    const out = pairSplitDocuments(rows)
    expect(out.map((p) => p.row.id)).toEqual(["a", "b", "c"])
    expect(out.every((p) => p.pairKey === null)).toBe(true)
  })

  test("never drops or duplicates a row", () => {
    const rows = [
      doc("1", "#900", "goods"),
      doc("2", null, null),
      doc("3", "#900", "software"),
      doc("4", "#901", "goods"),
      doc("5", "#901", "software"),
      doc("6", "#902", "goods"),
    ]
    const out = pairSplitDocuments(rows)
    expect(out).toHaveLength(rows.length)
    expect(new Set(out.map((p) => p.row.id)).size).toBe(rows.length)
  })

  test("never drops or duplicates a row: a split pair where EACH half also has its own credit note", () => {
    // The cancel automation's exact shape: one order split goods/software,
    // and a credit note issued against each half. A row already claimed by
    // the split pair must not be re-emitted as a member of its credit group.
    const rows: PairableRow[] = [
      { id: "goods-inv", number: "INV-2026-0100", shopify_order_number: "#900", scope: "goods" },
      {
        id: "software-inv",
        number: "INV-2026-0101",
        shopify_order_number: "#900",
        scope: "software",
      },
      {
        id: "goods-cn",
        number: "CN-2026-0001",
        type: "credit_note",
        original_document_id: "goods-inv",
        original_document_number: "INV-2026-0100",
        issued_at: "2026-01-05",
      },
      {
        id: "software-cn",
        number: "CN-2026-0002",
        type: "credit_note",
        original_document_id: "software-inv",
        original_document_number: "INV-2026-0101",
        issued_at: "2026-01-06",
      },
    ]
    const out = pairSplitDocuments(rows)
    expect(out).toHaveLength(rows.length)
    expect(out.map((p) => p.row.id).sort()).toEqual(rows.map((r) => r.id).sort())
  })

  test("pairMemberIds returns both halves, for downloading them together", () => {
    const out = pairSplitDocuments([
      doc("g", "#900", "goods"),
      doc("s", "#900", "software"),
      doc("x", null, null),
    ])
    expect(pairMemberIds(out, "#900")).toEqual(["g", "s"])
  })

  test("an order with no order NUMBER cannot be paired", () => {
    // The order number is the join key; without it there is nothing to pair on,
    // and pairing by customer would group unrelated orders.
    const out = pairSplitDocuments([doc("a", null, "goods"), doc("b", null, "software")])
    expect(out.every((p) => p.pairKey === null)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Credit-note grouping: a credit note groups with the invoice it credits,
// keyed on external_refs.original_document_id (not the number, not
// shopify_order_number -- credit notes exist for non-Shopify invoices too).
// ─────────────────────────────────────────────────────────────────────────

interface CreditTestRow extends PairableRow {
  status: string
  currency: string
  grand_total_minor: bigint
  counterparty_name?: string | null
  channel?: string | null
  payment_status?: string | null
  credited_by_numbers?: string[] | null
  po_number?: string | null
}

const invoiceRow = (
  over: Partial<CreditTestRow> & { id: string; number: string },
): CreditTestRow => ({
  type: "invoice",
  status: "issued",
  currency: "EUR",
  grand_total_minor: 10000n,
  counterparty_name: "Acme",
  ...over,
})

const creditNoteRow = (
  over: Partial<CreditTestRow> & {
    id: string
    number: string
    original_document_id: string
    original_document_number: string
  },
): CreditTestRow => ({
  type: "credit_note",
  status: "issued",
  currency: "EUR",
  grand_total_minor: -2000n,
  counterparty_name: "Acme",
  ...over,
})

describe("pairSplitDocuments (credit notes)", () => {
  test("groups a credit note with the invoice it credits, invoice first", () => {
    const out = pairSplitDocuments([
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05" }),
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-02-01",
      }),
    ])
    expect(out.map((p) => p.row.id)).toEqual(["inv-1", "cn-1"])
    expect(out[0]).toMatchObject({ pairKey: "inv-1", position: "first", kind: "credit" })
    expect(out[1]).toMatchObject({ pairKey: "inv-1", position: "last", kind: "credit" })
  })

  test("does NOT pair a credit note whose original invoice is not in view", () => {
    const out = pairSplitDocuments([
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-missing",
        original_document_number: "INV-2026-9999",
      }),
    ])
    expect(out).toEqual([
      { row: expect.objectContaining({ id: "cn-1" }), pairKey: null, position: null, kind: null },
    ])
  })

  test("more than one credit note against the same invoice stays contiguous, oldest credit note first", () => {
    const out = pairSplitDocuments([
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05" }),
      creditNoteRow({
        id: "cn-2",
        number: "CN-2026-0011",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-03-01",
      }),
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-02-01",
      }),
    ])
    // Fed newest credit note first; output stays oldest-first regardless.
    expect(out.map((p) => p.row.id)).toEqual(["inv-1", "cn-1", "cn-2"])
    expect(out[0]?.position).toBe("first")
    expect(out[1]?.position).toBe("middle")
    expect(out[2]?.position).toBe("last")
    expect(pairMemberIds(out, "inv-1")).toEqual(["inv-1", "cn-1", "cn-2"])
  })

  test("survives a scrambled sort: the group stays contiguous, unrelated rows undisturbed", () => {
    // The credit note arrives BEFORE its invoice, with unrelated documents
    // interleaved -- exactly what free-text search ranking or a different
    // column sort can produce.
    const out = pairSplitDocuments([
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-02-01",
      }),
      invoiceRow({ id: "other-1", number: "INV-2026-0001" }),
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05" }),
      invoiceRow({ id: "other-2", number: "INV-2026-0002" }),
    ])
    // The group is emitted where its FIRST member (the credit note) sat in
    // the incoming order -- the same "operator's sort still governs" rule the
    // split pair already uses -- and is internally ordered invoice first.
    expect(out.map((p) => p.row.id)).toEqual(["inv-1", "cn-1", "other-1", "other-2"])
    expect(out.find((p) => p.row.id === "other-1")).toMatchObject({ pairKey: null, kind: null })
    expect(out.find((p) => p.row.id === "other-2")).toMatchObject({ pairKey: null, kind: null })
  })

  test("pairLabelOf reads Credits on the credit note, Credited by on the invoice", () => {
    const out = pairSplitDocuments([
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05" }),
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-02-01",
      }),
    ])
    expect(pairLabelOf(out, "inv-1")).toBe("Credited by CN-2026-0007")
    expect(pairLabelOf(out, "cn-1")).toBe("Credits INV-2026-0042")
  })

  test("pairLabelOf counts multiple credit notes instead of naming them", () => {
    const out = pairSplitDocuments([
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05" }),
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-02-01",
      }),
      creditNoteRow({
        id: "cn-2",
        number: "CN-2026-0011",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-03-01",
      }),
    ])
    expect(pairLabelOf(out, "inv-1")).toBe("Credited by 2 credit notes")
  })

  test("pairLabelOf returns null for an unrelated or unpaired row", () => {
    const out = pairSplitDocuments([invoiceRow({ id: "inv-1", number: "INV-2026-0042" })])
    expect(pairLabelOf(out, "inv-1")).toBeNull()
    expect(pairLabelOf(out, "does-not-exist")).toBeNull()
  })

  // GAP -- a credit note against one half of a split order never groups (the split pair wins
  // the invoice row), so it used to render with no "Credits" text at all on the shape we ship
  // most. pairLabelOf now states the link from the row's own original_document_number
  // regardless of adjacency.
  test("an unpaired credit note whose invoice is not in view still says which invoice it credits", () => {
    const out = pairSplitDocuments([
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-missing",
        original_document_number: "INV-2026-9999",
      }),
    ])
    expect(pairLabelOf(out, "cn-1")).toBe("Credits INV-2026-9999")
  })

  // GAP 4 — pairLabelOf only fires when the credit note row is co-resident. creditedIndicatorOf
  // is the fallback: it reads the invoice row's OWN credited_by_numbers (server-derived from its
  // lifecycle_log), so the "credited" statement survives even when the credit note is filtered
  // out, on another page, or simply not the current view.
  describe("creditedIndicatorOf", () => {
    test("names the single credit note from the row's own data, no adjacency needed", () => {
      const row = invoiceRow({
        id: "inv-1",
        number: "INV-2026-0042",
        credited_by_numbers: ["CN-2026-0007"],
      })
      expect(creditedIndicatorOf(row)).toBe("Credited by CN-2026-0007")
    })

    test("counts multiple credit notes instead of naming them", () => {
      const row = invoiceRow({
        id: "inv-1",
        number: "INV-2026-0042",
        credited_by_numbers: ["CN-2026-0007", "CN-2026-0011"],
      })
      expect(creditedIndicatorOf(row)).toBe("Credited by 2 credit notes")
    })

    test("returns null with no credit notes recorded, and for a credit note row itself", () => {
      expect(creditedIndicatorOf(invoiceRow({ id: "inv-1", number: "INV-2026-0042" }))).toBeNull()
      expect(
        creditedIndicatorOf(
          creditNoteRow({
            id: "cn-1",
            number: "CN-2026-0007",
            original_document_id: "inv-1",
            original_document_number: "INV-2026-0042",
            credited_by_numbers: ["CN-2026-9999"],
          }),
        ),
      ).toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Rendering: look at the artifact. The real DataTable, compiled through the
// SAME esbuild + esbuild-plugin-solid pipeline `scripts/freeze-app.ts` uses
// for the real UI bundle (Bun's own JSX transform is React-style and cannot
// compile Solid JSX -- confirmed by hand: it emits `React.createElement`
// calls that throw "React is not defined" at render time), then rendered
// server-side with solid-js/web's real renderToString. No jsdom, no mocked
// DOM: the assertions below read the actual rendered HTML text.
//
// InvoicingDocumentsList itself was not renderable this way: its
// createResource load is async and the component never resolves synchronously
// under renderToString, so there is nothing to strip text from without a
// browser-grade Suspense harness. DataTable is rendered instead, with
// exactly the columns (LIST_COLUMNS, exported from DocumentsList.tsx for
// this purpose) and the same pairing/pairLabel/pairAction wiring
// DocumentsList.tsx builds.
// ─────────────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: the compiled module is loaded
// at runtime (esbuild output), so it has no static type.
let DataTable: (props: any) => unknown
const compiledDataTablePath = join(import.meta.dir, "pair-split.test.datatable.compiled.mjs")

beforeAll(async () => {
  const result = await esbuild({
    entryPoints: [join(import.meta.dir, "DataTable.tsx")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "esnext",
    // Bun does not transpile Solid JSX (see the comment above), so DataTable
    // is compiled here with the real solid toolchain -- but solid-js itself
    // stays external so this test's `renderToString` import and the compiled
    // component share the SAME module instance (component ownership,
    // signals, etc. break across two separate copies of solid-js).
    external: ["solid-js", "solid-js/web", "solid-js/store", "@liaison/host"],
    plugins: [solidPlugin({ solid: { generate: "ssr", hydratable: false } })],
  })
  const output = result.outputFiles[0]
  if (!output) throw new Error("esbuild produced no output for DataTable.tsx")
  writeFileSync(compiledDataTablePath, output.text)
  ;({ DataTable } = await import(compiledDataTablePath))
})

afterAll(() => {
  unlinkSync(compiledDataTablePath)
})

/** Strip tags from every tbody `<tr>` block (the thead's own `<tr>` is
 *  always the first one in the output and is dropped explicitly, not by a
 *  tail slice), collapsing whitespace so the assertions read the same
 *  visible text an operator would see. Every remaining `<tr>` is kept: a row
 *  that the pairing step dropped or duplicated must be visible in the count. */
function bodyRowTexts(html: string): string[] {
  return html
    .split("<tr")
    .slice(2) // [0] = everything before the first <tr>, [1] = the thead row
    .map((chunk) =>
      chunk
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
}

function renderDocumentsTable(rows: CreditTestRow[]): { html: string; rowTexts: string[] } {
  const paired = pairSplitDocuments(rows)
  // Mirrors DocumentsList.tsx line 128 exactly: the table renders the PAIRED
  // and reordered rows, never the raw input order. Feeding DataTable the raw
  // `rows` here would never exercise the reordering -- or a duplicate/dropped
  // row from a pairing bug -- that the real component's list is built from.
  const orderedRows = paired.map((p) => p.row)
  const pairing = (r: CreditTestRow) => {
    const hit = paired.find((p) => p.row.id === r.id)
    return hit?.pairKey ? { key: hit.pairKey, position: hit.position } : null
  }
  // Mirrors DocumentsList.tsx's wiring: the co-resident adjacency label wins when present,
  // otherwise fall back to the row's own lifecycle_log-derived indicator.
  const pairLabel = (r: CreditTestRow) => pairLabelOf(paired, r.id) ?? creditedIndicatorOf(r)
  const pairAction = (key: string) =>
    pairMemberIds(paired, key).length > 2 ? "All PDFs" : "Both PDFs"
  const html = renderToString(() =>
    DataTable({
      columns: LIST_COLUMNS,
      rows: orderedRows,
      emptyState: "No documents.",
      testid: "invoicing-documents-table",
      pairing,
      pairLabel,
      pairAction,
    }),
  )
  return { html, rowTexts: bodyRowTexts(html) }
}

describe("DataTable rendering (real component, real solid-js/web SSR)", () => {
  test("the credit note's rendered text names the invoice, and vice versa, in document order", () => {
    const rows = [
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05" }),
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-02-01",
      }),
    ]
    const { rowTexts } = renderDocumentsTable(rows)
    expect(rowTexts).toHaveLength(2)
    // The credit note's number reads immediately after the invoice's, in
    // document order -- not scattered by whatever the operator sorted by.
    expect(rowTexts[0]).toContain("INV-2026-0042")
    expect(rowTexts[1]).toContain("CN-2026-0007")
    // The affordance is TEXT a human reads, not a class or an attribute.
    expect(rowTexts[0]).toContain("Credited by CN-2026-0007")
    expect(rowTexts[1]).toContain("Credits INV-2026-0042")
  })

  test("two credit notes against one invoice render as three contiguous rows", () => {
    const rows = [
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05" }),
      creditNoteRow({
        id: "cn-1",
        number: "CN-2026-0007",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-02-01",
      }),
      creditNoteRow({
        id: "cn-2",
        number: "CN-2026-0011",
        original_document_id: "inv-1",
        original_document_number: "INV-2026-0042",
        issued_at: "2026-03-01",
      }),
    ]
    const { rowTexts } = renderDocumentsTable(rows)
    expect(rowTexts).toHaveLength(3)
    expect(rowTexts[0]).toContain("INV-2026-0042")
    expect(rowTexts[0]).toContain("Credited by 2 credit notes")
    expect(rowTexts[1]).toContain("CN-2026-0007")
    expect(rowTexts[1]).toContain("Credits INV-2026-0042")
    expect(rowTexts[2]).toContain("CN-2026-0011")
    expect(rowTexts[2]).toContain("Credits INV-2026-0042")
    // The download action reads "All PDFs" once a group has 3+ members.
    expect(rowTexts[0]).toContain("All PDFs")
  })

  test("a split pair still renders Both PDFs (unchanged 2-member behavior)", () => {
    const rows = [
      invoiceRow({
        id: "g",
        number: "INV-2026-0100",
        scope: "goods",
        shopify_order_number: "#900",
      }),
      invoiceRow({
        id: "s",
        number: "INV-2026-0101",
        scope: "software",
        shopify_order_number: "#900",
      }),
    ]
    const { rowTexts } = renderDocumentsTable(rows)
    expect(rowTexts).toHaveLength(2)
    expect(rowTexts[0]).toContain("Both PDFs")
    expect(rowTexts[1]).not.toContain("PDFs")
  })

  // GAP -- the SPLIT-order shape we ship most: goods + software halves, with a credit note
  // against one half. The credit note loses its group to the split pair (which wins the
  // invoice row), so before the fix pairLabelOf found no co-resident credit group and the
  // credit note rendered with NO "Credits" text at all -- the exact link the product owner
  // asked for, invisible on the order shape that matters most.
  test("a credit note in a split order still says which invoice it credits", () => {
    const rows = [
      invoiceRow({
        id: "goods-inv",
        number: "INV-2026-0100",
        scope: "goods",
        shopify_order_number: "#900",
      }),
      invoiceRow({
        id: "software-inv",
        number: "INV-2026-0101",
        scope: "software",
        shopify_order_number: "#900",
      }),
      creditNoteRow({
        id: "goods-cn",
        number: "CN-2026-0001",
        original_document_id: "goods-inv",
        original_document_number: "INV-2026-0100",
        issued_at: "2026-01-05",
      }),
    ]
    const { rowTexts } = renderDocumentsTable(rows)
    expect(rowTexts).toHaveLength(3)
    const cnRowText = rowTexts.find((t) => t.includes("CN-2026-0001"))
    expect(cnRowText).toBeDefined()
    // Before the fix: no "Credits" text anywhere in this row.
    expect(cnRowText).toContain("Credits INV-2026-0100")
  })

  // GAP 4 — the credit note is NOT in this view (a different tab, a different page, filtered
  // out): pairLabelOf finds no co-resident group, so before the fix the invoice row shows no
  // credited text at all. After the fix, the row's own credited_by_numbers still surfaces it.
  test("an invoice reads as credited even when the credit note is not in view", () => {
    const rows = [
      invoiceRow({
        id: "inv-1",
        number: "INV-2026-0042",
        credited_by_numbers: ["CN-2026-0007"],
      }),
    ]
    const { rowTexts } = renderDocumentsTable(rows)
    expect(rowTexts).toHaveLength(1)
    expect(rowTexts[0]).toContain("INV-2026-0042")
    expect(rowTexts[0]).toContain("Credited by CN-2026-0007")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Column width: the customer's PO number is an opaque identifier the
// operator matches CHARACTER BY CHARACTER against their own paperwork. A PO
// number cut to "PO-2026-0009..." is not a shorter PO number, it is a wrong
// one, exactly like a truncated amount -- so the column asks for its content
// width and never wraps, and the identity column absorbs what is left.
// ─────────────────────────────────────────────────────────────────────────

/** Everything between `<tag` and its matching `</tag>`, per occurrence. */
function elementChunks(html: string, tag: "th" | "td"): string[] {
  return html
    .split(`<${tag}`)
    .slice(1)
    .map((chunk) => {
      const end = chunk.indexOf(`</${tag}>`)
      return end === -1 ? chunk : chunk.slice(0, end)
    })
}

describe("DataTable rendering: the PO number column is never truncated", () => {
  const PO = "PO-2026-000998877"

  test("the PO number header and cell take their content width and never wrap", () => {
    const { html } = renderDocumentsTable([
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05", po_number: PO }),
    ])

    const poHeader = elementChunks(html, "th").find((chunk) => chunk.includes("PO number"))
    expect(poHeader, "the list renders a PO number header").toBeDefined()
    expect(poHeader).toContain("w-px")
    expect(poHeader).toContain("whitespace-nowrap")

    const poCell = elementChunks(html, "td").find((chunk) => chunk.includes(PO))
    expect(poCell, "the PO number reaches the rendered cell whole").toBeDefined()
    expect(poCell).toContain("w-px")
    expect(poCell).toContain("whitespace-nowrap")
    // The whole value, not an elided prefix.
    expect(poCell).toContain(PO)
  })

  test("the identity column still absorbs the remaining width", () => {
    const { html } = renderDocumentsTable([
      invoiceRow({ id: "inv-1", number: "INV-2026-0042", issued_at: "2026-01-05", po_number: PO }),
    ])
    const numberHeader = elementChunks(html, "th").find((chunk) => chunk.includes("Number"))
    expect(numberHeader).toBeDefined()
    expect(numberHeader).not.toContain("w-px")
  })
})
