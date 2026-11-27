// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The catch-up of a Stripe revenue stream: the preview lists every sale of the window oldest first,
// with what it would become, and writes nothing; the run needs a person's approval, issues in
// sale-date order (numbers follow the sale dates), credits each refund, skips what is already
// invoiced, and stops at the first sale it cannot issue, leaving the later ones unissued.
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
import { type CatchUpCtx, revenueStreamCatchUp, revenueStreamCatchUpPreview } from "./catch-up"

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
    expect(((out.sales[2]?.blockers ?? []) as string[]).join(" ")).toContain("USD")
    expect(JSON.stringify(db.__all("documents")) + JSON.stringify(parks(db))).toBe(before)
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

  test("the run stops at the first sale it cannot issue and leaves the later ones unissued", async () => {
    const db = await seeded()
    const sales = [
      sale(1, "2026-11-05T10:00:00.000Z"),
      sale(2, "2026-11-12T10:00:00.000Z", {
        buyer: { email: "noaddress@example.de", name: "No Address", billing: { country: "DE" } },
      }),
      sale(3, "2026-11-20T10:00:00.000Z"),
    ]
    const out = (await revenueStreamCatchUp(ctxOf(db, sales, true), WINDOW)) as {
      stopped: boolean
      notIssued: string[]
      steps: Array<Record<string, unknown>>
    }
    expect(out.stopped).toBe(true)
    expect(out.steps.map((s) => [s.external_id, s.outcome])).toEqual([
      ["pi_1", "issued"],
      ["pi_2", "stopped"],
    ])
    expect(out.notIssued).toEqual(["pi_3"])
    expect(invoices(db).map((d) => d.external_ref)).toEqual(["stripe:pi_1:software"])
  })
})
