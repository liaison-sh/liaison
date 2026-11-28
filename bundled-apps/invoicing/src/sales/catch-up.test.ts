// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The catch-up of a Stripe revenue stream: the preview lists every sale of the window oldest first,
// with what it would become, and writes nothing; the run needs a person's approval, issues in
// sale-date order (numbers follow the sale dates), credits each refund, skips what is already
// invoiced, holds a sale whose own data blocks it and goes on, stops at a cause every sale
// shares, and skips the sales a person excluded until they are included again.
import { describe, expect, test } from "bun:test"
import type { Sale } from "@liaison/app-sdk/contracts"
import { ISSUER_ROW } from "../__tests__/credit-note-fixtures"
import {
  CONTACT,
  creditNotes,
  invoices,
  parks,
  stripeCtx,
  stripeDb,
} from "../handlers/stripe-money.testkit"
import type { MockDb } from "../test-db"
import {
  type CatchUpCtx,
  revenueStreamCatchUp,
  revenueStreamCatchUpPreview,
  revenueStreamPreviewPdfs,
} from "./catch-up"
import { rerunStreamSale } from "./issue-sale"

const STREAM = {
  id: "stream-hub",
  provider_app: "stripe",
  source_ref: null,
  label: "Hub",
  issuer_profile_id: ISSUER_ROW.id,
  mode: "review",
  issue_from: "2026-11-26T00:00:00.000Z",
  mail: "none",
}

function sale(n: number, soldAt: string, over: Partial<Sale> = {}): Sale {
  return {
    external_id: `pi_${n}`,
    refs: { charge_id: `ch_${n}`, checkout_session_id: `cs_${n}` },
    sold_at: soldAt,
    paid: { status: "paid", payment_ref: `ch_${n}` },
    currency: "EUR",
    buyer: {
      email: `buyer${n}@example.de`,
      name: `Buyer ${n}`,
      kind: "individual",
      billing: { line1: "Hauptstr. 1", postcode: "10115", city: "Berlin", country: "DE" },
      tax_evidence: { billing_country: "DE", card_country: "DE" },
    },
    lines: [
      {
        description: "Sound pack",
        quantity: "1",
        unit_price_minor: "2000",
        kind: "service",
        tax: { rate_bp: 1900, amount_minor: "380", reported_by_source: true },
      },
    ],
    totals: { total_minor: "2380", subtotal_minor: "2000", tax_minor: "380" },
    ...over,
  }
}

function ctxOf(db: MockDb, sales: Sale[], approved: boolean): CatchUpCtx {
  const base = stripeCtx(db)
  const ctx: CatchUpCtx = {
    ...base,
    approval: approved
      ? { approvalRequestId: "apr-1", approvalDeciderId: "owner-1", toolName: "x" }
      : null,
    requestApproval: async () => ({ approval_id: "never" }),
    resolveContact: async () => ({ id: CONTACT }),
    contracts: {
      async call<T>(_c: string, op: string, params: Record<string, unknown>) {
        const result =
          op === "sales_list"
            ? { sales, next: null }
            : (() => {
                const s = sales.find((x) => x.external_id === params.external_id)
                return s ? { found: true, sale: s } : { found: false }
              })()
        return { status: "completed" as const, result: result as T, provider: "stripe" }
      },
    },
  }
  return ctx
}

const WINDOW = {
  streamId: STREAM.id,
  paidFrom: "2026-11-01T00:00:00.000Z",
  paidTo: "2026-11-27T00:00:00.000Z",
}

async function seeded(): Promise<MockDb> {
  const db = stripeDb("liaison")
  await db.insert("revenue_streams", STREAM)
  return db
}

describe("revenue stream catch-up", () => {
  test("the preview lists every sale oldest first, with blockers and refunds, and writes nothing", async () => {
    const db = await seeded()
    const sales = [
      sale(3, "2026-11-20T10:00:00.000Z", {
        currency: "USD",
        buyer: {
          email: "al@example.com",
          name: "Al",
          billing: { line1: "1 Main St", postcode: "10001", city: "New York", country: "US" },
        },
        lines: [
          {
            description: "Sound pack",
            quantity: "1",
            unit_price_minor: "2000",
            kind: "service",
            tax: { rate_bp: 0, amount_minor: "0", reported_by_source: true },
          },
        ],
        totals: { total_minor: "2000", subtotal_minor: "2000", tax_minor: "0" },
      }),
      sale(1, "2026-11-05T10:00:00.000Z"),
      sale(2, "2026-11-12T10:00:00.000Z", {
        paid: { status: "refunded", payment_ref: "ch_2" },
        refunds: [{ refund_id: "re_2", amount_minor: "2380", at: "2026-11-13T10:00:00.000Z" }],
      }),
    ]
    const before = JSON.stringify(db.__all("documents")) + JSON.stringify(parks(db))
    const out = (await revenueStreamCatchUpPreview(ctxOf(db, sales, false), WINDOW)) as {
      counts: Record<string, number>
      sales: Array<Record<string, unknown>>
    }
    expect(out.counts).toMatchObject({ sales: 3, alreadyInvoiced: 0, toIssue: 3, refunds: 1 })
    expect(out.sales.map((s) => s.external_id)).toEqual(["pi_1", "pi_2", "pi_3"])
    expect(out.sales[0]).toMatchObject({
      treatment: "eu_b2c_oss",
      net_minor: "2000",
      tax_minor: "380",
      source_tax_minor: "380",
      total_minor: "2380",
      blockers: [],
    })
    expect(out.sales[1]?.refunds).toEqual([
      { refund_id: "re_2", amount_minor: "2380", at: "2026-11-13T10:00:00.000Z" },
    ])
    // A USD sale is priced in EUR at issue (the ECB rate of the issue date): no blocker here,
    // the preview says which rate it would use, or that the ECB did not answer just now.
    expect(out.sales[2]).toMatchObject({ blockers: [], fx: { currency: "USD", rate: null } })
    expect(JSON.stringify(db.__all("documents")) + JSON.stringify(parks(db))).toBe(before)
  })

  test("the preview blocks a rate that is not the treatment's, and shows each line's discount", async () => {
    const db = await seeded()
    const sales = [
      sale(1, "2026-11-05T10:00:00.000Z", {
        buyer: {
          email: "ap@example.fr",
          name: "Paul",
          legal_name: "Studio SAS",
          kind: "company",
          vat_id: "FR40303265045",
          billing: { line1: "1 rue A", postcode: "75001", city: "Paris", country: "FR" },
        },
        lines: [
          {
            description: "Sound pack",
            quantity: "1",
            unit_price_minor: "2000",
            discount_minor: "500",
            kind: "service",
            tax: { rate_bp: 0, amount_minor: "0", reported_by_source: true },
          },
        ],
        totals: { total_minor: "1500", subtotal_minor: "1500", tax_minor: "0" },
      }),
    ]
    const out = (await revenueStreamCatchUpPreview(ctxOf(db, sales, false), WINDOW)) as {
      sales: Array<{ treatment: string; lines: unknown[]; blockers: string[] }>
    }
    expect(out.sales[0]?.treatment).toBe("eu_domestic")
    expect(out.sales[0]?.lines[0]).toMatchObject({
      unit_price_minor: "2000",
      discount_minor: "500",
    })
    expect(out.sales[0]?.blockers.join(" ")).toContain("2000")
  })

  test("preview PDFs: the documents the issue would produce, unnumbered and watermarked, nothing written", async () => {
    const db = await seeded()
    const sales = [
      // A consumer in France at 20 %, no street address (a digital service).
      sale(1, "2026-11-05T10:00:00.000Z", {
        buyer: {
          email: "a@example.fr",
          name: "Alice",
          kind: "individual",
          billing: { country: "FR" },
          tax_evidence: { billing_country: "FR", card_country: "FR" },
        },
        lines: [
          {
            description: "Sound pack",
            quantity: "1",
            unit_price_minor: "6703",
            discount_minor: "6033",
            kind: "service",
            tax: { rate_bp: 2000, amount_minor: "134", reported_by_source: true },
          },
        ],
        totals: { total_minor: "804", subtotal_minor: "670", tax_minor: "134" },
      }),
      // A consumer in Switzerland: no VAT, the art. 259 B mention.
      sale(2, "2026-11-06T10:00:00.000Z", {
        buyer: {
          email: "c@example.ch",
          name: "Carla",
          kind: "individual",
          billing: { country: "CH" },
          tax_evidence: { billing_country: "CH", card_country: "CH" },
        },
        lines: [
          {
            description: "Sound pack",
            quantity: "1",
            unit_price_minor: "2793",
            kind: "service",
            tax: { rate_bp: 0, amount_minor: "0", reported_by_source: true },
          },
        ],
        totals: { total_minor: "2793", subtotal_minor: "2793", tax_minor: "0" },
      }),
      // A company with no address: it would park, and says so.
      sale(3, "2026-11-07T10:00:00.000Z", {
        buyer: {
          email: "ap@example.de",
          name: "Jan",
          legal_name: "Studio GmbH",
          kind: "company",
          billing: { country: "DE" },
        },
      }),
    ]
    const renders: Array<{ filename?: string; data: Record<string, unknown> }> = []
    const ctx = ctxOf(db, sales, false)
    ctx.pdf = {
      async render(input: { filename?: string; data: unknown }) {
        renders.push({ filename: input.filename, data: input.data as Record<string, unknown> })
        return { file_id: `file-${renders.length}`, byte_size: 1, page_count: 1 }
      },
    } as unknown as CatchUpCtx["pdf"]
    const before = JSON.stringify(db.__all("documents")) + JSON.stringify(parks(db))
    const out = (await revenueStreamPreviewPdfs(ctx, WINDOW)) as {
      sales: Array<{ external_id: string; preview?: Record<string, unknown> }>
    }
    expect(JSON.stringify(db.__all("documents")) + JSON.stringify(parks(db))).toBe(before)
    expect(db.__all("sales") ?? []).toEqual([])
    const [fr, ch, de] = out.sales
    expect(fr?.preview).toMatchObject({
      outcome: "preview",
      documents: [
        {
          pdf_file_id: "file-1",
          tax_treatment: "eu_domestic",
          subtotal_minor: "670",
          tax_total_minor: "134",
          grand_total_minor: "804",
          lines: [{ unit_price_minor: "6703", discount_minor: "6033", tax_rate_bp: 2000 }],
        },
      ],
    })
    expect(ch?.preview).toMatchObject({
      outcome: "preview",
      documents: [{ tax_treatment: "eu_export_non_eu", tax_total_minor: "0" }],
    })
    const chDocs = (ch?.preview?.documents ?? []) as Array<{ legal_mention: string }>
    expect(String(chDocs[0]?.legal_mention)).toContain("259 B")
    expect(de?.preview).toMatchObject({ outcome: "would_park", reason: "counterparty_incomplete" })
    // The render: watermarked, no number, not a file a buyer gets.
    expect(renders).toHaveLength(2)
    expect(renders[0]?.data.preview).toBe("PREVIEW, not an invoice")
    expect((renders[0]?.data.document as { number?: string } | undefined)?.number).toBe("")
    expect(renders[0]?.filename).toBe("preview-pi_1-software.pdf")
  })

  test("the run needs a person's approval", async () => {
    const db = await seeded()
    const out = await revenueStreamCatchUp(
      ctxOf(db, [sale(1, "2026-11-05T10:00:00.000Z")], false),
      WINDOW,
    )
    expect(out).toMatchObject({ status: "error", error: { code: "approval_required" } })
    expect(invoices(db)).toEqual([])
  })

  test("the run issues in sale-date order, credits the refund, and a second run issues nothing more", async () => {
    const db = await seeded()
    const sales = [
      sale(2, "2026-11-12T10:00:00.000Z", {
        paid: { status: "refunded", payment_ref: "ch_2" },
        refunds: [{ refund_id: "re_2", amount_minor: "2380", at: "2026-11-13T10:00:00.000Z" }],
      }),
      sale(1, "2026-11-05T10:00:00.000Z"),
    ]
    const out = (await revenueStreamCatchUp(ctxOf(db, sales, true), WINDOW)) as {
      stopped: boolean
      steps: Array<Record<string, unknown>>
    }
    expect(out.stopped).toBe(false)
    expect(out.steps.map((s) => [s.external_id, s.outcome])).toEqual([
      ["pi_1", "issued"],
      ["pi_2", "issued"],
    ])
    const inv = invoices(db).sort((a, b) => Number(a.number_int) - Number(b.number_int))
    expect(inv.map((d) => d.external_ref)).toEqual(["stripe:pi_1:software", "stripe:pi_2:software"])
    // Born paid: a refunded sale was paid when it was made.
    expect(inv.every((d) => d.payment_status === "paid")).toBe(true)
    const notes = creditNotes(db)
    expect(notes.map((n) => n.external_ref)).toEqual(["stripe:re_2"])
    expect(notes[0]?.original_document_id).toBe(inv[1]?.id)
    const again = (await revenueStreamCatchUp(ctxOf(db, sales, true), WINDOW)) as {
      steps: Array<Record<string, unknown>>
    }
    expect(again.steps.map((s) => s.outcome)).toEqual(["already_invoiced", "already_invoiced"])
    expect(invoices(db)).toHaveLength(2)
    expect(creditNotes(db)).toHaveLength(1)
  })

  test("a sale held by its own data waits in its park and the run goes on, numbers in sale-date order", async () => {
    const db = await seeded()
    const sales = [
      sale(1, "2026-11-05T10:00:00.000Z"),
      sale(2, "2026-11-12T10:00:00.000Z", {
        // A company with no postal address: its own data holds it.
        buyer: {
          email: "noaddress@example.de",
          name: "No Address",
          legal_name: "No Address GmbH",
          kind: "company",
          billing: { country: "DE" },
        },
      }),
      sale(3, "2026-11-20T10:00:00.000Z"),
    ]
    const preview = (await revenueStreamCatchUpPreview(ctxOf(db, sales, false), WINDOW)) as {
      counts: { held: number; stopsRun: number }
      sales: Array<{ external_id: string; run_effect: string; blockers: string[] }>
    }
    expect(preview.sales.map((r) => r.run_effect)).toEqual(["issues", "held", "issues"])
    expect(preview.counts).toMatchObject({ held: 1, stopsRun: 0 })
    const out = (await revenueStreamCatchUp(ctxOf(db, sales, true), WINDOW)) as {
      stopped: boolean
      notIssued: string[]
      held: string[]
      steps: Array<Record<string, unknown>>
    }
    expect(out.stopped).toBe(false)
    expect(out.steps.map((s) => [s.external_id, s.outcome])).toEqual([
      ["pi_1", "issued"],
      ["pi_2", "held"],
      ["pi_3", "issued"],
    ])
    expect(out.held).toEqual(["pi_2"])
    expect(out.notIssued).toEqual([])
    const inv = invoices(db).sort((a, b) => Number(a.number_int) - Number(b.number_int))
    expect(inv.map((d) => d.external_ref)).toEqual(["stripe:pi_1:software", "stripe:pi_3:software"])
    expect(Number(inv[1]?.number_int)).toBe(Number(inv[0]?.number_int) + 1)
    expect(parks(db).some((p) => p.event_id === "rs:stream-hub:pi_2")).toBe(true)
  })

  test("a cause every sale shares (the issuer's legal mentions) stops the run; the preview says so", async () => {
    const db = stripeDb("liaison", { legal_form: null, share_capital: null })
    await db.insert("revenue_streams", STREAM)
    const sales = [sale(1, "2026-11-05T10:00:00.000Z"), sale(2, "2026-11-12T10:00:00.000Z")]
    const preview = (await revenueStreamCatchUpPreview(ctxOf(db, sales, false), WINDOW)) as {
      counts: { blocked: number; stopsRun: number }
      sales: Array<{ run_effect: string; blockers: string[] }>
    }
    expect(preview.counts).toMatchObject({ blocked: 2, stopsRun: 2 })
    expect(preview.sales[0]?.blockers.join(" ")).toContain("issuer_incomplete")
    expect(preview.sales[0]?.blockers.join(" ")).toContain("legal_form, share_capital")
    expect(parks(db)).toEqual([])
    const out = (await revenueStreamCatchUp(ctxOf(db, sales, true), WINDOW)) as {
      stopped: boolean
      notIssued: string[]
      steps: Array<Record<string, unknown>>
    }
    expect(out.stopped).toBe(true)
    expect(out.steps.map((s) => [s.external_id, s.outcome, s.reason])).toEqual([
      ["pi_1", "stopped", "parked: issuer_incomplete"],
    ])
    expect(out.notIssued).toEqual(["pi_2"])
    expect(invoices(db)).toEqual([])
  })

  test("an excluded sale is recorded with its reason, skipped by every later run until reincluded", async () => {
    const db = await seeded()
    const sales = [
      sale(1, "2026-11-05T10:00:00.000Z"),
      sale(2, "2026-11-12T10:00:00.000Z"),
      sale(3, "2026-11-20T10:00:00.000Z"),
    ]
    const ctx = ctxOf(db, sales, true) as CatchUpCtx & {
      emitted: Array<{ entity: string; action: string; data?: unknown }>
    }
    const out = (await revenueStreamCatchUp(ctx, {
      ...WINDOW,
      exclude: [{ externalId: "pi_2", reason: "staff test purchase" }],
    })) as { steps: Array<Record<string, unknown>>; excluded: string[] }
    expect(out.steps.map((s) => [s.external_id, s.outcome])).toEqual([
      ["pi_1", "issued"],
      ["pi_2", "excluded"],
      ["pi_3", "issued"],
    ])
    expect(out.excluded).toEqual(["pi_2"])
    const row = db.__all("sales").find((r) => r.external_id === "pi_2")
    expect(row).toMatchObject({
      state: "excluded",
      excluded_reason: "staff test purchase",
      excluded_by: "owner-1",
    })
    expect(
      ctx.emitted.find((e) => e.entity === "sale" && e.action === "excluded")?.data,
    ).toMatchObject({
      external_id: "pi_2",
      reason: "staff test purchase",
    })
    // A later run, the preview and a park retry leave it alone.
    const again = (await revenueStreamCatchUp(ctxOf(db, sales, true), WINDOW)) as {
      steps: Array<Record<string, unknown>>
    }
    expect(again.steps.map((s) => s.outcome)).toEqual([
      "already_invoiced",
      "excluded",
      "already_invoiced",
    ])
    const preview = (await revenueStreamCatchUpPreview(ctxOf(db, sales, false), WINDOW)) as {
      sales: Array<{ external_id: string; run_effect: string; excluded: unknown }>
    }
    expect(preview.sales[1]).toMatchObject({
      run_effect: "excluded",
      excluded: { reason: "staff test purchase" },
    })
    expect(
      await rerunStreamSale({ stream_id: STREAM.id, external_id: "pi_2" }, ctxOf(db, sales, true)),
    ).toEqual({ status: "skipped", reason: "sale_excluded" })
    expect(invoices(db)).toHaveLength(2)
    // Reincluded: the next run invoices it.
    const back = (await revenueStreamCatchUp(ctxOf(db, sales, true), {
      ...WINDOW,
      reinclude: ["pi_2"],
    })) as { steps: Array<Record<string, unknown>>; reincluded: string[] }
    expect(back.reincluded).toEqual(["pi_2"])
    expect(back.steps.map((s) => s.outcome)).toEqual([
      "already_invoiced",
      "issued",
      "already_invoiced",
    ])
  })

  test("an exclusion needs a reason", async () => {
    const db = await seeded()
    const out = await revenueStreamCatchUp(ctxOf(db, [sale(1, "2026-11-05T10:00:00.000Z")], true), {
      ...WINDOW,
      exclude: [{ externalId: "pi_1", reason: "no" }],
    })
    expect(out).toMatchObject({ status: "error", error: { code: "invalid_params" } })
    expect(invoices(db)).toEqual([])
  })

  test("the preview prices a foreign currency at the ECB rate of the sale date, not today", async () => {
    const db = await seeded()
    await db.insert("fx_rates", { currency: "USD", rate_date: "2026-11-19", rate: "1.0500" })
    await db.insert("fx_rates", { currency: "USD", rate_date: "2026-11-20", rate: "1.0600" })
    const today = new Date().toISOString().slice(0, 10)
    await db.insert("fx_rates", { currency: "USD", rate_date: today, rate: "1.0900" })
    const usd = sale(3, "2026-11-20T10:00:00.000Z", {
      currency: "USD",
      buyer: {
        email: "al@example.com",
        name: "Al",
        billing: { line1: "1 Main St", postcode: "10001", city: "New York", country: "US" },
      },
      lines: [
        {
          description: "Sound pack",
          quantity: "1",
          unit_price_minor: "2000",
          kind: "service",
          tax: { rate_bp: 0, amount_minor: "0", reported_by_source: true },
        },
      ],
      totals: { total_minor: "2000", subtotal_minor: "2000", tax_minor: "0" },
    })
    const out = (await revenueStreamCatchUpPreview(ctxOf(db, [usd], false), WINDOW)) as {
      sales: Array<{ fx: unknown }>
    }
    expect(out.sales[0]?.fx).toEqual({ currency: "USD", rate: "1.0600", rate_date: "2026-11-20" })
  })

  test("preview PDFs are filed under a preview row; a sale's new preview replaces its old one, and old ones expire", async () => {
    const db = await seeded()
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString()
    await db.insert("sale_previews", {
      stream_id: STREAM.id,
      external_id: "pi_9",
      scope: "software",
      pdf_file_id: null,
      rendered_at: old,
    })
    await db.insert("sale_previews", {
      stream_id: STREAM.id,
      external_id: "pi_1",
      scope: "software",
      pdf_file_id: null,
      rendered_at: new Date().toISOString(),
    })
    const parents: unknown[] = []
    const ctx = ctxOf(db, [sale(1, "2026-11-05T10:00:00.000Z")], false)
    ctx.pdf = {
      async render(input: { parent?: unknown }) {
        parents.push(input.parent)
        return { file_id: "file-1", byte_size: 1, page_count: 1 }
      },
    } as unknown as CatchUpCtx["pdf"]
    await revenueStreamPreviewPdfs(ctx, WINDOW)
    expect(db.__all("sale_previews")).toEqual([])
    expect(parents).toHaveLength(1)
    expect(parents[0]).toMatchObject({
      entityType: "sale_preview",
      commitRow: {
        values: { stream_id: STREAM.id, external_id: "pi_1", scope: "software" },
        fileIdColumn: "pdf_file_id",
      },
    })
  })

  test("a USD sale invoiced later stores the ECB rate of its sale date; a buyer in France gets French", async () => {
    const db = stripeDb("liaison", { default_language: "en" })
    await db.insert("revenue_streams", STREAM)
    await db.insert("fx_rates", { currency: "USD", rate_date: "2026-11-20", rate: "1.0600" })
    const today = new Date().toISOString().slice(0, 10)
    await db.insert("fx_rates", { currency: "USD", rate_date: today, rate: "1.0900" })
    const pl = sale(1, "2026-11-20T10:00:00.000Z", {
      currency: "USD",
      buyer: {
        email: "buyer@example.pl",
        name: "Buyer PL",
        kind: "individual",
        billing: { line1: "ul. Testowa 1", postcode: "00-001", city: "Warszawa", country: "PL" },
        tax_evidence: { billing_country: "PL", card_country: "PL" },
      },
      lines: [
        {
          description: "Sound pack",
          quantity: "1",
          unit_price_minor: "2000",
          kind: "service",
          tax: { rate_bp: 2300, amount_minor: "460", reported_by_source: true },
        },
      ],
      totals: { total_minor: "2460", subtotal_minor: "2000", tax_minor: "460" },
    })
    const fr = sale(2, "2026-11-21T10:00:00.000Z", {
      buyer: {
        email: "a@example.fr",
        name: "Alice",
        kind: "individual",
        billing: { country: "FR" },
        tax_evidence: { billing_country: "FR", card_country: "FR" },
      },
      lines: [
        {
          description: "Sound pack",
          quantity: "1",
          unit_price_minor: "2000",
          kind: "service",
          tax: { rate_bp: 2000, amount_minor: "400", reported_by_source: true },
        },
      ],
      totals: { total_minor: "2400", subtotal_minor: "2000", tax_minor: "400" },
    })
    const out = (await revenueStreamCatchUp(ctxOf(db, [pl, fr], true), WINDOW)) as {
      steps: Array<Record<string, unknown>>
    }
    expect(out.steps.map((s) => s.outcome)).toEqual(["issued", "issued"])
    const [usd, eur] = invoices(db).sort((a, b) => Number(a.number_int) - Number(b.number_int))
    expect(usd).toMatchObject({ fx_rate: "1.0600", fx_rate_date: "2026-11-20", language: "en" })
    // 4.60 USD / 1.06 = 4.34 EUR.
    expect(String(usd?.tax_total_eur_minor)).toBe("434")
    expect(eur?.language).toBe("fr")
  })
})
