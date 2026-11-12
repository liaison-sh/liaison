// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E5 — Agent read tools tests. Exercises the same generic-CRUD
// surface the bridge exposes (Path B from the E2E debrief — no semantic mocks).

import { describe, expect, test } from "bun:test"
import { createMockDb as createBridgeMockDb } from "@liaison/test-helpers/mock-db"
import {
  deferredList,
  documentsGet,
  documentsSearch,
  exportDocuments,
  hsCodesLookup,
  pendingApprovalsList,
  READS_MAX_LIMIT,
  type ReadsCtx,
  type ReadsFetch,
  settingsShopMappingList,
  vatValidate,
  viewerAccess,
} from "./reads"
import { createMockDb } from "./test-db"

interface SearchObservation {
  where?: Record<string, unknown>
  search?: { fields: string[]; query: string }
  limit?: number
  offset?: number
}

function makeCtx(opts?: {
  documents?: Array<Record<string, unknown>>
  document_lines?: Array<Record<string, unknown>>
  hs_codes?: Array<Record<string, unknown>>
  approvals?: Array<Record<string, unknown>>
  issuer_profiles?: Array<Record<string, unknown>>
}): {
  ctx: ReadsCtx
  observe: { lastSearch: SearchObservation | null; lastApprovalsPrefix: string | null }
} {
  const db = createMockDb({
    seed: {
      documents: opts?.documents ?? [],
      document_lines: opts?.document_lines ?? [],
      hs_code_library: opts?.hs_codes ?? [],
      issuer_profiles: opts?.issuer_profiles ?? [],
    },
  })
  const observe = {
    lastSearch: null as SearchObservation | null,
    lastApprovalsPrefix: null as string | null,
  }
  const approvals = opts?.approvals ?? []
  const ctx: ReadsCtx = {
    db: {
      async findMany(entity, opts) {
        if (entity === "documents") {
          observe.lastSearch = {
            where: opts?.where,
            search: opts?.search,
            limit: opts?.limit,
            offset: opts?.offset,
          }
        }
        return db.findMany(entity, opts)
      },
      async findOne(entity, id) {
        return db.findOne(entity, id)
      },
      async count(entity, opts) {
        if (entity === "documents") {
          observe.lastSearch = { where: opts?.where }
        }
        return db.count(entity, opts)
      },
    },
    kernel: {
      async listApprovals(toolNamePrefix, limit) {
        observe.lastApprovalsPrefix = toolNamePrefix ?? null
        const cap = Math.max(1, Math.min(limit ?? 50, 200))
        const filtered = toolNamePrefix
          ? approvals.filter((a) =>
              String(a.toolName ?? a.tool_name ?? "").startsWith(toolNamePrefix),
            )
          : approvals
        return filtered.slice(0, cap)
      },
    },
  }
  return { ctx, observe }
}

const sampleDocs: Array<Record<string, unknown>> = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    type: "invoice",
    number: "INV-2026-0001",
    status: "issued",
    payment_status: "unpaid",
    counterparty_contact_id: "contact-1",
    currency: "EUR",
    grand_total_minor: "12000",
    issued_at: "2026-05-15",
    due_at: "2026-06-14",
    tax_treatment: "eu_domestic",
    incoterm: "DAP",
    issuer_profile_id: "issuer-1",
    pdf_file_id: "file-1",
    pdf_status: "ready",
    subtotal_minor: "10000",
    tax_total_minor: "2000",
    external_refs: {},
    lifecycle_log: [{ event: "issued" }],
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    type: "quote",
    number: "QUO-2026-0001",
    status: "draft",
    payment_status: "unpaid",
    counterparty_contact_id: "contact-2",
    currency: "EUR",
    grand_total_minor: "50000",
    issued_at: null,
    due_at: null,
    tax_treatment: null,
    incoterm: "DAP",
    issuer_profile_id: "issuer-1",
    pdf_file_id: null,
    pdf_status: null,
    subtotal_minor: "0",
    tax_total_minor: "0",
    external_refs: {},
    lifecycle_log: [],
  },
]

describe("documentsSearch (E5)", () => {
  test("ids filter: only the named documents, malformed ids dropped, none valid reads nothing", async () => {
    // The bridge's `{ in: [...] }` semantics (a set lookup), as db_findMany applies them.
    const db = createBridgeMockDb(
      { seed: { documents: sampleDocs } },
      { bridgeWhereOperators: true },
    )
    const reads: string[] = []
    const ctx: ReadsCtx = {
      ...makeCtx().ctx,
      db: {
        ...db,
        async findMany(entity, opts) {
          reads.push(entity)
          return db.findMany(entity, opts)
        },
      },
    }
    const rows = await documentsSearch(ctx, {
      ids: ["00000000-0000-4000-8000-000000000001", "not-a-uuid"],
    })
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000001"])
    // countOnly never puts where.id on db_count (the bridge refuses it there).
    expect(
      await documentsSearch(ctx, {
        ids: ["00000000-0000-4000-8000-000000000001"],
        countOnly: true,
      }),
    ).toEqual({
      totalCount: 1,
    })
    reads.length = 0
    expect(await documentsSearch(ctx, { ids: ["nope"] })).toEqual([])
    expect(reads).toEqual([])
  })

  test("empty filters → returns first page", async () => {
    const { ctx } = makeCtx({ documents: sampleDocs })
    const rows = await documentsSearch(ctx)
    expect(rows).toHaveLength(2)
  })

  test("filter by type=invoice", async () => {
    const { ctx } = makeCtx({ documents: sampleDocs })
    const rows = await documentsSearch(ctx, { type: "invoice" })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("00000000-0000-4000-8000-000000000001")
  })

  test("countOnly returns a server count over the filter, not the page (sweep countdown)", async () => {
    const { ctx, observe } = makeCtx({ documents: sampleDocs })
    // 1 invoice, 1 quote in sampleDocs → count by type tracks the filter.
    const all = await documentsSearch(ctx, { countOnly: true })
    expect(all).toEqual({ totalCount: 2 })
    const invoices = await documentsSearch(ctx, { type: "invoice", countOnly: true })
    expect(invoices).toEqual({ totalCount: 1 })
    // The count is computed from the SAME structured where the page uses.
    expect(observe.lastSearch?.where).toEqual({ type: "invoice" })
  })

  test("free-text query matches counterparty_name, not just the number (BL-248)", async () => {
    // Regression: documentsSearch.query searched ONLY the `number` field, so a
    // weak model handed a customer reference ("Claudine Moreau") got [] and
    // concluded "no invoice on file" — instead of resolving a contactId first.
    // The query must now match the stored counterparty_name so the by-customer
    // retrieval is reachable WITHOUT guessing the contactId-first path.
    const claudineInvoice = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000003",
      number: "EMB-2026-00164",
      counterparty_name: "Claudine Moreau",
    }
    const { ctx, observe } = makeCtx({ documents: [...sampleDocs, claudineInvoice] })
    const rows = await documentsSearch(ctx, { query: "Moreau" })
    // The name, and the address and email a person is often named in on a company's invoice.
    expect(observe.lastSearch?.search?.fields).toEqual([
      "number",
      "counterparty_name",
      "buyer_legal_name",
      "counterparty_address",
      "counterparty_email",
      "counterparty_shipping_name",
      "counterparty_shipping_address",
      "shopify_order_id",
      "shopify_order_number",
      "po_number",
      "notes",
    ])
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000003"])
  })

  test("free-text query matches shopify_order_id — the by-order-reference invoice lookup (l712)", async () => {
    // Regression: a fulfillment routine joining a Shopify order to its issued invoice naturally searches
    // documents_search by the ORDER reference (e.g. "#2357"). When the query matched only number +
    // counterparty_name, that returned [] even though the invoice existed → the tick concluded "no invoice
    // on file" and prepared NOTHING (the order-check-prepare-shipment runtime-gate failure). The query now
    // also matches the stored shopify_order_id so the by-order lookup resolves the invoice.
    const orderRefInvoice = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000004",
      number: "EMB-2026-08201",
      counterparty_name: "Sylvain Mercier",
      shopify_order_id: "#2357",
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, orderRefInvoice] })
    const rows = await documentsSearch(ctx, { query: "#2357" })
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000004"])
  })

  test("free-text query matches shopify_order_number — searching the HUMAN order name finds the invoice", async () => {
    // shopify_order_id holds the NUMERIC order id ("12768069779622"), but everyone
    // -- customer, operator, and the agent quoting them -- searches the order NAME
    // ("#1149"). Matching only the numeric id meant an order-name search returned []
    // on a document that plainly bills that order.
    const orderNameInvoice = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000009",
      number: "EMB-2026-08444",
      shopify_order_id: "12768069779622",
      shopify_order_number: "#1149",
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, orderNameInvoice] })
    const rows = await documentsSearch(ctx, { query: "#1149" })
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000009"])
    expect(rows[0]?.shopify_order_number).toBe("#1149")
  })

  test("shopify_order_number falls back to external_refs for documents issued before the column existed", async () => {
    // The CSV importer and the pre-0.9.0 order-paid flow recorded the reference on
    // external_refs only. Reading through to it keeps those documents showing their
    // order in the list and detail view. (Free-text SEARCH still needs the column --
    // that is what the one-off backfill is for.)
    const legacy = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000010",
      number: "EMB-2026-02677",
      shopify_order_id: "12768069779622",
      external_refs: { shopify_order_number: "#2677" },
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, legacy] })
    const rows = await documentsSearch(ctx)
    const row = rows.find((r) => r.id === "00000000-0000-4000-8000-000000000010")
    expect(row?.shopify_order_number).toBe("#2677")
  })

  // red: drop "po_number" from documentsSearch's `search.fields` array -> a customer's PO
  // number pasted into the ordinary search box returns nothing, even though the invoice,
  // quote, proforma and credit note carrying it are plainly on file.
  test("free-text query matches po_number — an exact PO string finds the document", async () => {
    const poInvoice = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000011",
      number: "EMB-2026-09000",
      po_number: "PO-4471",
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, poInvoice] })
    const rows = await documentsSearch(ctx, { query: "PO-4471" })
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000011"])
    expect(rows[0]?.po_number).toBe("PO-4471")
  })

  // red: drop "notes" from documentsSearch's `search.fields` array -> a document findable ONLY
  // by the contract reference someone typed into its notes stops coming back at all.
  test("free-text query matches notes — substring, case insensitive", async () => {
    const notedInvoice = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000013",
      number: "EMB-2026-09002",
      notes: "Contract FR-2026-118, delivery in 2 batches",
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, notedInvoice] })
    const rows = await documentsSearch(ctx, { query: "FR-2026-118" })
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000013"])
    expect(rows[0]?.notes).toBe("Contract FR-2026-118, delivery in 2 batches")
    const lower = await documentsSearch(ctx, { query: "delivery in 2 batches" })
    expect(lower.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000013"])
  })

  test("free-text query matches po_number PARTIALLY and CASE INSENSITIVELY, same as the order number", async () => {
    // A customer writes "PO-4471"; an operator searching just "4471" (any case) must meet
    // them in the middle -- same substring/case-insensitive rule shopify_order_number gets.
    const poInvoice = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000012",
      number: "EMB-2026-09001",
      po_number: "PO-4471",
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, poInvoice] })
    const partial = await documentsSearch(ctx, { query: "4471" })
    expect(partial.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000012"])
    const lower = await documentsSearch(ctx, { query: "po-4471" })
    expect(lower.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-000000000012"])
  })

  test("free-text query matching a PO number finds the quote, the invoice, the proforma and a credit note sharing it", async () => {
    const shared = "PO-9900"
    const docs = [
      {
        ...sampleDocs[0],
        id: "00000000-0000-4000-8000-000000000021",
        type: "quote",
        number: "QUO-2026-0900",
        po_number: shared,
      },
      {
        ...sampleDocs[0],
        id: "00000000-0000-4000-8000-000000000022",
        type: "invoice",
        number: "INV-2026-0900",
        po_number: shared,
      },
      {
        ...sampleDocs[0],
        id: "00000000-0000-4000-8000-000000000023",
        type: "proforma",
        number: "PRO-2026-0900",
        po_number: shared,
      },
      {
        ...sampleDocs[0],
        id: "00000000-0000-4000-8000-000000000024",
        type: "credit_note",
        number: "CN-2026-0900",
        po_number: shared,
      },
      // A different document must NOT match.
      {
        ...sampleDocs[0],
        id: "00000000-0000-4000-8000-000000000025",
        type: "invoice",
        number: "INV-2026-0901",
        po_number: "PO-0000",
      },
    ]
    const { ctx } = makeCtx({ documents: docs })
    const rows = await documentsSearch(ctx, { query: shared })
    expect(rows.map((r) => r.id).sort()).toEqual([
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024",
    ])
  })

  test("po_number falls back to external_refs for documents written before the column existed", async () => {
    const legacy = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000013",
      number: "EMB-2026-09002",
      external_refs: { po_number: "PO-LEGACY" },
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, legacy] })
    const rows = await documentsSearch(ctx)
    const row = rows.find((r) => r.id === "00000000-0000-4000-8000-000000000013")
    expect(row?.po_number).toBe("PO-LEGACY")
  })

  test("original_document_id comes from the column when external_refs carries nothing", async () => {
    const cn = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000014",
      number: "CN-2026-00001",
      type: "credit_note",
      original_document_id: "00000000-0000-4000-8000-000000000001",
      external_refs: {},
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, cn] })
    const rows = await documentsSearch(ctx)
    const row = rows.find((r) => r.id === "00000000-0000-4000-8000-000000000014")
    expect(row?.original_document_id).toBe("00000000-0000-4000-8000-000000000001")
  })

  test("the column wins over a stale external_refs link", async () => {
    const cn = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000015",
      number: "CN-2026-00002",
      type: "credit_note",
      original_document_id: "00000000-0000-4000-8000-000000000001",
      external_refs: { original_document_id: "00000000-0000-4000-8000-0000000000ff" },
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, cn] })
    const rows = await documentsSearch(ctx)
    const row = rows.find((r) => r.id === "00000000-0000-4000-8000-000000000015")
    expect(row?.original_document_id).toBe("00000000-0000-4000-8000-000000000001")
  })

  test("channel is derived from shopify_order_id (Shopify-reconciled vs Manual)", async () => {
    // Regression: the documents-list Channel column + Shopify/Manual filter always
    // showed "manual" because the header never derived `channel`. A reconciled
    // document carries a top-level shopify_order_id → "shopify"; a hand-created one
    // → "manual".
    const reconciled = {
      ...sampleDocs[0],
      id: "00000000-0000-4000-8000-000000000005",
      number: "INV-2026-0099",
      shopify_order_id: "12777551495334",
    }
    const { ctx } = makeCtx({ documents: [...sampleDocs, reconciled] })
    const rows = await documentsSearch(ctx)
    const manual = rows.find((r) => r.id === "00000000-0000-4000-8000-000000000001")
    const shopify = rows.find((r) => r.id === "00000000-0000-4000-8000-000000000005")
    expect(manual?.channel).toBe("manual")
    expect(shopify?.channel).toBe("shopify")
  })

  test("limit cap is enforced — request > READS_MAX_LIMIT is clamped", async () => {
    const { ctx, observe } = makeCtx({ documents: sampleDocs })
    await documentsSearch(ctx, { limit: 9999 })
    expect(observe.lastSearch?.limit).toBe(READS_MAX_LIMIT)
  })

  test("non-positive limit falls back to the default", async () => {
    const { ctx, observe } = makeCtx({ documents: sampleDocs })
    await documentsSearch(ctx, { limit: 0 })
    expect(observe.lastSearch?.limit).toBe(50)
  })

  test("query, contact, treatment, and date_range round-trip", async () => {
    const { ctx, observe } = makeCtx({ documents: sampleDocs })
    await documentsSearch(ctx, {
      query: "  INV  ",
      contact: "  contact-1  ",
      date_range: { from: "2026-05-01", to: "2026-05-31" },
      treatment: "eu_domestic",
    })
    expect(observe.lastSearch?.search?.query).toBe("INV")
    expect(observe.lastSearch?.where?.counterparty_contact_id).toBe("contact-1")
    expect(observe.lastSearch?.where?.tax_treatment).toBe("eu_domestic")
  })

  test("date_range filters client-side (issued_at outside range excluded)", async () => {
    const { ctx } = makeCtx({ documents: sampleDocs })
    const rows = await documentsSearch(ctx, {
      date_range: { from: "2026-05-01", to: "2026-05-31" },
    })
    // doc-1 has issued_at=2026-05-15 → in range; doc-2 has issued_at=null → out.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("00000000-0000-4000-8000-000000000001")
  })

  test("date_range reaches a period older than the newest page of documents", async () => {
    // The range used to filter ONE over-fetched page of the newest rows (3x the limit), so a
    // month with 200 newer documents after it came back empty.
    const newer = Array.from({ length: 200 }, (_, i) => ({
      ...sampleDocs[0],
      id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`,
      number: `INV-2026-${1000 + i}`,
      number_int: 1000 + i,
      issued_at: `2026-09-${String(1 + (i % 28)).padStart(2, "0")} 00:00:00+00`,
    }))
    const older = [1, 2, 3].map((n) => ({
      ...sampleDocs[0],
      id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
      number: `INV-2026-090${n}`,
      number_int: 900 + n,
      issued_at: `2026-03-1${n} 00:00:00+00`,
    }))
    const { ctx } = makeCtx({ documents: [...newer, ...older] })
    const rows = await documentsSearch(ctx, {
      date_range: { from: "2026-03-01", to: "2026-03-31" },
    })
    expect(rows.map((r) => r.number)).toEqual(["INV-2026-0903", "INV-2026-0902", "INV-2026-0901"])
    const oldestFirst = await documentsSearch(ctx, {
      date_range: { from: "2026-03-01", to: "2026-03-31" },
      sort: "oldest",
    })
    expect(oldestFirst.map((r) => r.number)).toEqual([
      "INV-2026-0901",
      "INV-2026-0902",
      "INV-2026-0903",
    ])
  })

  test("sort orders by issue date, then by number inside one day", async () => {
    const docs = [
      { n: 12, day: "2026-09-02" },
      { n: 10, day: "2026-09-01" },
      { n: 14, day: "2026-09-02" },
      { n: 13, day: "2026-09-02" },
      { n: 11, day: "2026-09-01" },
    ].map(({ n, day }) => ({
      ...sampleDocs[0],
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      number: `INV-2026-00${n}`,
      number_int: n,
      issued_at: `${day} 00:00:00+00`,
    }))
    const { ctx } = makeCtx({ documents: docs })
    const newest = await documentsSearch(ctx)
    expect(newest.map((r) => r.number)).toEqual([
      "INV-2026-0014",
      "INV-2026-0013",
      "INV-2026-0012",
      "INV-2026-0011",
      "INV-2026-0010",
    ])
    const oldest = await documentsSearch(ctx, { sort: "oldest" })
    expect(oldest.map((r) => r.number)).toEqual([
      "INV-2026-0010",
      "INV-2026-0011",
      "INV-2026-0012",
      "INV-2026-0013",
      "INV-2026-0014",
    ])
  })

  test("date_range with a TIMESTAMP issued_at is inclusive on the boundary day", async () => {
    // Prod returns issued_at as a full timestamp ("2026-05-15 00:00:00+00"),
    // not a bare date. A raw string compare made `to` EXCLUDE the boundary day
    // (single-day ranges returned nothing). The filter must compare on the date
    // portion only.
    const tsDocs = [
      {
        ...sampleDocs[0],
        id: "00000000-0000-4000-8000-0000000000aa",
        issued_at: "2026-05-15 00:00:00+00",
      },
    ]
    const { ctx } = makeCtx({ documents: tsDocs })
    const rows = await documentsSearch(ctx, {
      date_range: { from: "2026-05-15", to: "2026-05-15" },
    })
    expect(rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-0000000000aa"])
  })
})

describe("documentsGet (E5)", () => {
  test("returns full document with lines", async () => {
    const { ctx } = makeCtx({
      documents: sampleDocs,
      document_lines: [
        {
          id: "line-1",
          document_id: "00000000-0000-4000-8000-000000000001",
          position: 1,
          description: "Widget",
          quantity: "1",
          unit_price_minor: "10000",
          tax_rate_bp: 2000,
          subtotal_minor: "10000",
          tax_minor: "2000",
          total_minor: "12000",
          hs_code: null,
          country_of_origin: null,
        },
      ],
    })
    const result = await documentsGet(ctx, { id: "00000000-0000-4000-8000-000000000001" })
    expect(result).not.toBeNull()
    expect(result!.lines).toHaveLength(1)
    expect(result!.tax_treatment).toBe("eu_domestic")
    // Money fields cross the kernel JSON bridge as strings by design (reads.ts
    // coerces `bigint` columns to strings so the tool-result envelope is
    // JSON-safe — BigInt would crash serialization). The static type says
    // `bigint`, but the runtime value is the decimal string — assert via
    // `String(...)` so it holds regardless of the boundary representation.
    expect(String(result!.grand_total_minor)).toBe("12000")
  })

  // red: drop the po_number field from toDocumentHeader -> documents_get can no longer show
  // an operator where a document's PO reference came from without a raw DB query.
  test("returns po_number", async () => {
    const withPo = { ...sampleDocs[0], po_number: "PO-4471" }
    const { ctx } = makeCtx({ documents: [withPo] })
    const result = await documentsGet(ctx, { id: "00000000-0000-4000-8000-000000000001" })
    expect(result?.po_number).toBe("PO-4471")
  })

  // The Editor reopens a draft with its e-invoicing fields; a missing one would be saved back as
  // null by the next drafts_update, and the regime line reads the recorded regime.
  test("returns the e-invoicing columns (customer type, operation type, billing, regime)", async () => {
    const doc = {
      ...sampleDocs[0],
      customer_kind: "business",
      operation_category: "goods",
      billing_line1: "1 rue Imaginaire",
      billing_postcode: "75001",
      billing_city: "Paris",
      billing_country_code: "FR",
      regime: "e_invoice",
      regime_reasons: [{ code: "fr_business_with_siren", en: "e", fr: "f" }],
    }
    const { ctx } = makeCtx({ documents: [doc] })
    const result = await documentsGet(ctx, { id: "00000000-0000-4000-8000-000000000001" })
    expect(result?.customer_kind).toBe("business")
    expect(result?.operation_category).toBe("goods")
    expect(result?.billing_line1).toBe("1 rue Imaginaire")
    expect(result?.billing_postcode).toBe("75001")
    expect(result?.billing_city).toBe("Paris")
    expect(result?.billing_country_code).toBe("FR")
    expect(result?.regime).toBe("e_invoice")
    expect(result?.regime_reasons).toEqual([{ code: "fr_business_with_siren", en: "e", fr: "f" }])
    const bare = await documentsGet(makeCtx({ documents: sampleDocs }).ctx, {
      id: "00000000-0000-4000-8000-000000000001",
    })
    expect(bare?.customer_kind).toBeNull()
    expect(bare?.regime_reasons).toEqual([])
  })

  test("projects the full customs snapshot on each line (Boxtal hand-off join key)", async () => {
    const { ctx } = makeCtx({
      documents: sampleDocs,
      document_lines: [
        {
          id: "line-1",
          document_id: "00000000-0000-4000-8000-000000000001",
          position: 1,
          description: "Touchpad",
          quantity: "1",
          unit_price_minor: "10000",
          tax_rate_bp: 2000,
          subtotal_minor: "10000",
          tax_minor: "2000",
          total_minor: "12000",
          hs_code: "851762",
          country_of_origin: "FR",
          customs_description: "Tessera touchpad",
          product_source: "shopify",
          external_id: "gid://shopify/ProductVariant/123",
        },
        {
          // hand-typed line: no catalog join key
          id: "line-2",
          document_id: "00000000-0000-4000-8000-000000000001",
          position: 2,
          description: "Hand-typed service",
          quantity: "1",
          unit_price_minor: "5000",
          tax_rate_bp: 0,
          subtotal_minor: "5000",
          tax_minor: "0",
          total_minor: "5000",
          hs_code: null,
          country_of_origin: null,
          customs_description: null,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const result = await documentsGet(ctx, { id: "00000000-0000-4000-8000-000000000001" })
    expect(result).not.toBeNull()
    const [line1, line2] = result!.lines
    expect(line1!.hs_code).toBe("851762")
    expect(line1!.country_of_origin).toBe("FR")
    expect(line1!.customs_description).toBe("Tessera touchpad")
    expect(line1!.product_source).toBe("shopify")
    expect(line1!.external_id).toBe("gid://shopify/ProductVariant/123")
    // hand-typed line round-trips the customs join key as null
    expect(line2!.customs_description).toBeNull()
    expect(line2!.product_source).toBeNull()
    expect(line2!.external_id).toBeNull()
  })

  test("missing id → returns null", async () => {
    const { ctx } = makeCtx({})
    const result = await documentsGet(ctx, { id: "nope" })
    expect(result).toBeNull()
  })

  test("a foreign id (Shopify GID) → clean null, never a pg 22P02 crash (BL-129)", async () => {
    // A weak model confusing a draft quote with an invoicing document passes the Shopify DraftOrder
    // GID; the uuid column would 22P02 and the gated handler crash (handler_ambiguous / EXECUTED-FAIL).
    // Must short-circuit to not-found BEFORE the db query.
    const { ctx } = makeCtx({ documents: sampleDocs })
    expect(await documentsGet(ctx, { id: "gid://shopify/DraftOrder/1642610262182" })).toBeNull()
  })

  test("empty id arg → throws", async () => {
    const { ctx } = makeCtx({})
    await expect(documentsGet(ctx, { id: "" })).rejects.toThrow()
  })
})

describe("hsCodesLookup (E5)", () => {
  test("substring match, limit-capped", async () => {
    const { ctx } = makeCtx({
      hs_codes: [
        { code: "847130", description: "Laptops", last_used_at: null },
        { code: "847141", description: "Other ADP", last_used_at: null },
        { code: "999999", description: "Misc", last_used_at: null },
      ],
    })
    const result = await hsCodesLookup(ctx, { query: "8471" })
    expect(result).toHaveLength(2)
  })

  test("empty query → empty list", async () => {
    const { ctx } = makeCtx({})
    const result = await hsCodesLookup(ctx, { query: "  " })
    expect(result).toHaveLength(0)
  })
})

describe("pendingApprovalsList (E5)", () => {
  test("filter to invoicing: prefix; cap applied", async () => {
    const { ctx, observe } = makeCtx({
      approvals: [
        {
          id: "a-1",
          toolName: "invoicing:invoice.issue",
          summary: { headline: "issue X" },
          createdAt: new Date().toISOString(),
          requestedBy: "u-1",
        },
        {
          id: "a-2",
          toolName: "mail:compose",
          summary: { headline: "send Y" },
          createdAt: new Date().toISOString(),
          requestedBy: "u-1",
        },
      ],
    })
    const result = await pendingApprovalsList(ctx, { limit: 10 })
    expect(result).toHaveLength(1)
    expect(result[0]!.tool_name).toBe("invoicing:invoice.issue")
    expect(observe.lastApprovalsPrefix).toBe("invoicing:")
  })

  test("requested_by_user_id is the requester's id, summary is its title", async () => {
    const { ctx } = makeCtx({
      approvals: [
        {
          id: "a-1",
          toolName: "invoicing:invoice.issue",
          summary: { title: "Issue invoice F-2026-0042", lines: [] },
          createdAt: new Date().toISOString(),
          // The kernel's ApprovalRequestSummary carries the requester as `{ id }`.
          requestedBy: { id: "u-42" },
        },
      ],
    })
    const [row] = await pendingApprovalsList(ctx, { limit: 10 })
    expect(row!.requested_by_user_id).toBe("u-42")
    expect(row!.summary).toBe("Issue invoice F-2026-0042")
  })
})

describe("vatValidate (VIES)", () => {
  // Minimal db/kernel stubs — the VAT read only egresses via ctx.fetch and never
  // touches the CRUD bridge or the approvals affordance.
  function makeViesCtx(fetchImpl: ReadsFetch): {
    ctx: ReadsCtx
    calls: string[]
    optsCalls: Array<
      { method?: string; headers?: Record<string, string>; body?: string } | undefined
    >
  } {
    const calls: string[] = []
    const optsCalls: Array<
      { method?: string; headers?: Record<string, string>; body?: string } | undefined
    > = []
    const ctx: ReadsCtx = {
      db: {
        async findMany() {
          return []
        },
        async findOne() {
          return null
        },
        async count() {
          return 0
        },
      },
      kernel: {
        async listApprovals() {
          return []
        },
      },
      fetch: async (url, opts) => {
        calls.push(url)
        optsCalls.push(opts)
        return fetchImpl(url, opts)
      },
    }
    return { ctx, calls, optsCalls }
  }

  test("200 OK → isValid:true with name; strips the country prefix from the REST path", async () => {
    const { ctx, calls, optsCalls } = makeViesCtx(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({ isValid: true, name: "Tonwerk Audio GmbH" }),
    }))
    const result = await vatValidate(ctx, { country_code: "DE", vat_number: "DE000000000" })
    expect(result.isValid).toBe(true)
    expect(result.name).toBe("Tonwerk Audio GmbH")
    expect(result.source).toBe("vies_rest")
    // The prefix must be stripped: the path carries the bare number, not DE000000000.
    expect(calls).toHaveLength(1)
    expect(calls[0]!).toContain("/ms/DE/vat/000000000")
    expect(calls[0]!).not.toContain("/vat/DE000000000")
    // CONTRACT GUARD: ctx.fetch MUST be called with a non-primitive opts object — the QuickJS
    // bridge marshaller only JSON-parses the host string return when a non-primitive arg is
    // passed; a url-only call leaks the raw envelope string → `http_undefined` (the l62 bug).
    expect(typeof optsCalls[0]).toBe("object")
    expect(optsCalls[0]).not.toBeNull()
  })

  test("string envelope (QuickJS marshaller leak) → still parsed → isValid:true", async () => {
    // Reproduces the executor `__wrap` behaviour: the host returns the envelope as a JSON STRING.
    // Without the defensive parse this fails with `http_undefined`; with it, the result is honoured.
    const { ctx } = makeViesCtx(
      async () =>
        JSON.stringify({
          status: 200,
          headers: {},
          body: JSON.stringify({
            isValid: true,
            name: "Tonwerk Audio GmbH",
            requestDate: "2026-06-09",
          }),
        }) satisfies string,
    )
    const result = await vatValidate(ctx, { country_code: "DE", vat_number: "000000000" })
    expect(result.isValid).toBe(true)
    expect(result.name).toBe("Tonwerk Audio GmbH")
    expect(result.requestDate).toBe("2026-06-09")
    expect(result.error).toBeUndefined()
  })

  test("non-200 → isValid:false with an error, no throw", async () => {
    const { ctx } = makeViesCtx(async () => ({ status: 503, headers: {}, body: "" }))
    const result = await vatValidate(ctx, { country_code: "DE", vat_number: "000000000" })
    expect(result.isValid).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain("503")
  })

  test("fetch throws → isValid:false with a network error (no throw escapes)", async () => {
    const { ctx } = makeViesCtx(async () => {
      throw new Error("boom")
    })
    const result = await vatValidate(ctx, { country_code: "DE", vat_number: "000000000" })
    expect(result.isValid).toBe(false)
    expect(result.error).toContain("network_error")
  })

  test("VIES_LIVE=0 → deterministic mock: known number valid, unknown invalid", async () => {
    const prev = process.env.VIES_LIVE
    process.env.VIES_LIVE = "0"
    try {
      // The mock path must not egress — pass a fetch that fails the test if called.
      const { ctx, calls } = makeViesCtx(async () => {
        throw new Error("mock path must not hit the network")
      })
      const known = await vatValidate(ctx, { country_code: "DE", vat_number: "DE000000000" })
      expect(known.isValid).toBe(true)
      expect(known.name).toBe("Tonwerk Audio GmbH")
      expect(known.source).toBe("vies_mock")

      const unknown = await vatValidate(ctx, { country_code: "DE", vat_number: "999999999" })
      expect(unknown.isValid).toBe(false)
      expect(unknown.source).toBe("vies_mock")

      expect(calls).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.VIES_LIVE
      else process.env.VIES_LIVE = prev
    }
  })

  // reverse-charge-vat-mismatch-detection (l596): the GB number must validate as a VALID *GB*
  // registration under the deterministic mock — so the agent gets isValid:true and must STILL reason
  // that a GB registration cannot anchor an intra-EU reverse charge to a DE ship-to (a country check
  // the validity bit alone does not encode). If this entry regressed to invalid, the scenario would
  // degenerate into a trivial "invalid number" catch and lose the valid-but-wrong-country teaching.
  test("VIES_LIVE=0 → GB923456789 is a VALID GB registration (valid-but-wrong-country fixture)", async () => {
    const prev = process.env.VIES_LIVE
    process.env.VIES_LIVE = "0"
    try {
      const { ctx, calls } = makeViesCtx(async () => {
        throw new Error("mock path must not hit the network")
      })
      const gb = await vatValidate(ctx, { country_code: "GB", vat_number: "GB923456789" })
      expect(gb.isValid).toBe(true)
      expect(gb.countryCode).toBe("GB")
      expect(gb.name).toBe("Klangwerk Audio Ltd")
      expect(gb.source).toBe("vies_mock")
      expect(calls).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.VIES_LIVE
      else process.env.VIES_LIVE = prev
    }
  })

  // verify-dealer-vat-numbers-from-web-partial: the agent validates BOTH dealers' stored DE VAT numbers.
  // Tonwerk (DE000000000) is covered above; Klangwerk GmbH (DE298765432) must ALSO resolve to a VALID DE
  // registration with its registered name under the deterministic mock — without this entry the second
  // dealer would come back isValid:false and the scenario could no longer report "both system-validated".
  test("VIES_LIVE=0 → DE298765432 is a VALID DE registration for Klangwerk GmbH (two-dealer fixture)", async () => {
    const prev = process.env.VIES_LIVE
    process.env.VIES_LIVE = "0"
    try {
      const { ctx, calls } = makeViesCtx(async () => {
        throw new Error("mock path must not hit the network")
      })
      const de = await vatValidate(ctx, { country_code: "DE", vat_number: "DE298765432" })
      expect(de.isValid).toBe(true)
      expect(de.countryCode).toBe("DE")
      expect(de.name).toBe("Klangwerk GmbH")
      expect(de.source).toBe("vies_mock")
      expect(calls).toHaveLength(0)
    } finally {
      if (prev === undefined) delete process.env.VIES_LIVE
      else process.env.VIES_LIVE = prev
    }
  })
})

describe("exportDocuments (BL-188 — full-RLS-set data export for the kernel export tool)", () => {
  const docs: Array<Record<string, unknown>> = [
    {
      id: "00000000-0000-4000-8000-0000000000d1",
      number: "INV-2026-0001",
      type: "invoice",
      status: "issued",
      counterparty_name: "Acme GmbH",
      counterparty_country: "DE",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "1900",
      grand_total_minor: "11900",
      tax_treatment: "domestic",
      issued_at: "2026-05-01",
      due_at: "2026-05-31",
      created_at: "2026-05-01",
    },
    {
      id: "00000000-0000-4000-8000-0000000000d2",
      number: "INV-2026-0002",
      type: "invoice",
      status: "issued",
      counterparty_name: "Béta, S.A.",
      counterparty_country: "FR",
      currency: "EUR",
      subtotal_minor: "5000",
      tax_total_minor: "0",
      grand_total_minor: "5000",
      tax_treatment: "export",
      issued_at: "2026-06-01",
      due_at: "2026-06-30",
      created_at: "2026-06-01",
    },
  ]

  test("serializes documents to CSV — header + one row per doc, comma-bearing cells quoted", async () => {
    const { ctx } = makeCtx({ documents: docs })
    const csv = (await exportDocuments(ctx, { format: "csv" })) as string
    const lines = csv.trim().split("\n")
    expect(lines[0]).toBe(
      "id,number,type,status,counterpartyName,counterpartyCountry,currency,subtotalMinor,taxTotalMinor,grandTotalMinor,taxTreatment,issuedAt,dueAt,createdAt,shopifyOrderNumber,notes",
    )
    expect(lines).toHaveLength(3) // header + 2 docs (no READS_MAX_LIMIT clamp — the full set)
    expect(lines[1]).toContain("INV-2026-0001")
    expect(csv).toContain('"Béta, S.A."') // the comma in the counterparty name is RFC-4180 escaped
  })

  test("returns JSON rows projected to the declared export columns", async () => {
    const { ctx } = makeCtx({ documents: docs })
    const rows = (await exportDocuments(ctx, { format: "json" })) as Array<Record<string, string>>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      id: "00000000-0000-4000-8000-0000000000d1",
      number: "INV-2026-0001",
      counterpartyName: "Acme GmbH",
      grandTotalMinor: "11900",
      taxTreatment: "domestic",
    })
  })

  test("applies the created_at date-range filter", async () => {
    const { ctx } = makeCtx({ documents: docs })
    const rows = (await exportDocuments(ctx, {
      format: "json",
      dateRange: { from: "2026-05-15" },
    })) as Array<Record<string, string>>
    expect(rows).toHaveLength(1) // only d2 (created 2026-06-01) is >= 2026-05-15
    expect(rows[0]!.number).toBe("INV-2026-0002")
  })

  test("empty doc set yields a header-only CSV (valid empty export, not a crash)", async () => {
    const { ctx } = makeCtx({ documents: [] })
    const csv = (await exportDocuments(ctx, { format: "csv" })) as string
    expect(csv.trim().split("\n")).toHaveLength(1) // header only
  })
})

describe("settingsShopMappingList", () => {
  // Regression: the earlier stub returned a hardcoded [] ("mapping table absent"),
  // so the Settings page said "No shops mapped yet" on orgs whose issuer profile
  // carried a live shopify_shop_id mapping. The mapping IS issuer_profiles.shopify_shop_id.
  test("returns issuer-profile-backed mappings, skipping unmapped profiles", async () => {
    const { ctx } = makeCtx({
      issuer_profiles: [
        { id: "prof-1", legal_name: "FABRIKAM", shopify_shop_id: "fabrikam.myshopify.com" },
        { id: "prof-2", legal_name: "No Shop SARL", shopify_shop_id: null },
        { id: "prof-3", legal_name: "Empty Shop", shopify_shop_id: "" },
      ],
    })
    const res = await settingsShopMappingList(ctx)
    expect(res.items).toHaveLength(1)
    expect(res.items[0]).toMatchObject({
      shop_url: "fabrikam.myshopify.com",
      issuer_profile_id: "prof-1",
      issuer_legal_name: "FABRIKAM",
    })
  })
})

describe("shipment_ref exposure (per-shipment proformas)", () => {
  const shipDoc: Record<string, unknown> = {
    id: "00000000-0000-4000-8000-000000000077",
    type: "proforma",
    number: "PRO-2026-0007",
    status: "issued",
    payment_status: "unpaid",
    currency: "EUR",
    grand_total_minor: "5000",
    shopify_order_id: "gid://shopify/Order/7001",
    shipment_ref: "batch-2",
    external_refs: {},
    lifecycle_log: [],
  }

  test("documents_get surfaces shipment_ref so a batch's proforma is findable", async () => {
    const { ctx } = makeCtx({ documents: [shipDoc] })
    const result = await documentsGet(ctx, { id: "00000000-0000-4000-8000-000000000077" })
    expect(result).not.toBeNull()
    expect((result as unknown as { shipment_ref: string | null }).shipment_ref).toBe("batch-2")
  })

  test("documents_search surfaces shipment_ref (null for legacy rows)", async () => {
    const { ctx } = makeCtx({ documents: [shipDoc, sampleDocs[0]!] })
    const rows = await documentsSearch(ctx)
    const byId = new Map(rows.map((d) => [d.id, d]))
    expect(
      (byId.get("00000000-0000-4000-8000-000000000077") as { shipment_ref: string | null })
        .shipment_ref,
    ).toBe("batch-2")
    expect(
      (byId.get("00000000-0000-4000-8000-000000000001") as { shipment_ref: string | null })
        .shipment_ref,
    ).toBeNull()
  })
})

describe("deferredList names the order each park is about", () => {
  test("a customer_email_missing park carries its order number, id and blocker", async () => {
    // An order with no customer email parks before any invoice exists. The list used to return
    // only the row id, status and reason, so neither the operator nor the agent could tell WHICH
    // order was waiting and the order looked like it had simply never reached invoicing.
    const db = createMockDb({
      seed: {
        deferred_events: [
          {
            id: "00000000-0000-4000-8000-00000000d001",
            event_id: "13160775254347",
            event_payload_json: { id: "13160775254347", order_number: "#3427" },
            status: "awaiting_data",
            reason: "customer_email_missing",
            blocked_on: { kind: "customer_email", customer_id: "gid://shopify/Customer/1" },
            retry_count: 2,
          },
        ],
      },
    })
    const ctx = { db } as unknown as ReadsCtx
    const { items } = await deferredList(ctx)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      reason: "customer_email_missing",
      order_id: "13160775254347",
      order_number: "#3427",
      blocked_on: { kind: "customer_email" },
    })
  })
})

describe("deferredList fills a missing order number from the same order's other park", () => {
  test("an older duplicate park with no order_number reads it from its refreshed sibling", async () => {
    const db = createMockDb({
      seed: {
        deferred_events: [
          {
            id: "00000000-0000-4000-8000-00000000d101",
            event_id: "12966079070539",
            event_payload_json: { id: "12966079070539" },
            status: "resolved",
            reason: "duplicate_park",
            blocked_on: { kind: "customer_email" },
            retry_count: 0,
          },
          {
            id: "00000000-0000-4000-8000-00000000d102",
            event_id: "12966079070539",
            event_payload_json: { id: "12966079070539", order_number: "#3280" },
            status: "resolved",
            reason: "order_cancelled",
            blocked_on: { kind: "customer_email" },
            retry_count: 1,
          },
        ],
      },
    })
    const { items } = await deferredList({ db } as unknown as ReadsCtx)
    expect(items.map((i) => i.order_number)).toEqual(["#3280", "#3280"])
  })
})

describe("viewerAccess", () => {
  test("answers each flag from the caller's scopes", async () => {
    const { ctx } = makeCtx()
    const held = new Set(["invoicing:documents:read", "invoicing:settings:read"])
    const res = await viewerAccess({ ...ctx, hasScope: async (s: string) => held.has(s) })
    expect(res).toEqual({ documents_write: false, settings_read: true, approve: false })
  })

  test("a ctx without hasScope, or one that throws, grants nothing", async () => {
    const { ctx } = makeCtx()
    expect(await viewerAccess(ctx)).toEqual({
      documents_write: false,
      settings_read: false,
      approve: false,
    })
    const throwing = {
      ...ctx,
      hasScope: async () => {
        throw new Error("bridge down")
      },
    }
    expect(await viewerAccess(throwing)).toEqual({
      documents_write: false,
      settings_read: false,
      approve: false,
    })
  })
})
