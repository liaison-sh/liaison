// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe invoice finalized in one calendar month and issued by Liaison in a later one raises one
// Home notice, naming the number and the period. An invoice that bills a period already over, issued
// in the month Stripe finalized it, raises none: that is how arrears and cycle renewals bill.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import manifest from "../../app.manifest.json"
import { onStripeInvoiceFinalized } from "./stripe-invoice-finalized"
import { finalized, invoices, stripeCtx, stripeDb } from "./stripe-money.testkit"

const at = (iso: string) => setSystemTime(new Date(iso))
afterEach(() => setSystemTime())

async function issued(over: Parameters<typeof finalized>[0], issuer: Record<string, unknown> = {}) {
  const db = stripeDb("liaison", issuer)
  const ctx = stripeCtx(db)
  const r = await onStripeInvoiceFinalized(finalized(over), ctx)
  expect(r.status).toBe("ok")
  return { db, ctx, r, notices: ctx.emitted.filter((e) => e.action === "issued_late_period") }
}

describe("a Stripe invoice issued in a later month than Stripe finalized it", () => {
  test("raises one notice with the number, the period and both months", async () => {
    at("2026-12-10T10:00:00Z")
    const { db, ctx, notices } = await issued({ finalized_at: "2026-11-30T10:00:00Z" })
    const doc = invoices(db)[0] as { id: string; number: string }
    expect(notices).toEqual([
      {
        entity: "stripe_invoice",
        action: "issued_late_period",
        entityId: doc.id,
        data: {
          document_id: doc.id,
          number: doc.number,
          stripe_number: "ST-0001",
          period: "2026-11-01 to 2026-11-30",
          finalized_month: "2026-11",
          issued_month: "2026-12",
          resolved: false,
        },
      },
    ])
    // The same Stripe event again issues nothing and says nothing more.
    await onStripeInvoiceFinalized(finalized({ finalized_at: "2026-11-30T10:00:00Z" }), ctx)
    expect(ctx.emitted.filter((e) => e.action === "issued_late_period")).toHaveLength(1)
  })

  test("a click that issues it late raises it too, and a year's end is a later month", async () => {
    at("2027-01-02T10:00:00Z")
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized(finalized({ finalized_at: "2026-12-31T10:00:00Z" }), ctx, {
      byPerson: true,
    })
    expect(ctx.emitted.filter((e) => e.action === "issued_late_period")).toHaveLength(1)
  })

  test("with no period on the lines it names the invoice's own, and none when Stripe gave none", async () => {
    at("2026-12-10T10:00:00Z")
    const line = { description: "Pro plan", quantity: 1, unit_amount_excl_minor: "10000" }
    const lines = [{ ...line, tax_rate_bp: 2000, tax_minor: "2000" }]
    const own = await issued({ finalized_at: "2026-11-30T10:00:00Z", lines })
    expect(own.notices[0]?.data).toMatchObject({ period: "2026-11-01 to 2026-11-30" })
    const none = await issued({
      finalized_at: "2026-11-30T10:00:00Z",
      lines,
      period_start: null,
      period_end: null,
    })
    expect(none.notices[0]?.data).toMatchObject({ period: "not given by Stripe" })
  })
})

describe("a normal invoice raises none", () => {
  test("arrears: last month's period, finalized and issued on the 1st", async () => {
    at("2026-12-01T09:00:00Z")
    const { notices } = await issued({ finalized_at: "2026-12-01T08:59:00Z" })
    expect(notices).toEqual([])
  })

  test("a cycle renewal: the period ahead on its line, the one before on the invoice", async () => {
    at("2026-12-01T09:00:00Z")
    const { notices } = await issued({
      finalized_at: "2026-12-01T08:59:00Z",
      period_start: "2026-11-01",
      period_end: "2026-12-01",
      lines: [
        {
          description: "Pro plan",
          quantity: 1,
          unit_amount_excl_minor: "10000",
          tax_rate_bp: 2000,
          tax_minor: "2000",
          period_start: "2026-12-01",
          period_end: "2027-01-01",
        },
      ],
    })
    expect(notices).toEqual([])
  })

  test("issued days late in the same month", async () => {
    at("2026-11-30T10:00:00Z")
    expect((await issued({ finalized_at: "2026-11-02T10:00:00Z" })).notices).toEqual([])
  })

  test("the months are civil ones: 23:30 UTC on 30 November is December in Paris", async () => {
    at("2026-12-01T00:10:00Z")
    expect((await issued({ finalized_at: "2026-11-30T23:30:00Z" })).notices).toEqual([])
    expect((await issued({ finalized_at: "2026-11-30T22:30:00Z" })).notices).toHaveLength(1)
  })

  test("Stripe gave no finalization time", async () => {
    at("2026-12-10T10:00:00Z")
    expect((await issued({ finalized_at: null })).notices).toEqual([])
  })
})

test("the notice reaches the holders of invoicing:documents:write", () => {
  const t = manifest.attention.translations.find(
    (x) => x.event === "stripe_invoice:issued_late_period",
  )
  expect(t).toMatchObject({
    recipients: { kind: "scope_holders", scope: "invoicing:documents:write" },
  })
  expect(t?.summary).toContain("{{data.number}}")
  expect(t?.summary).toContain("{{data.period}}")
  expect(manifest.events.emits).toContain("stripe_invoice:issued_late_period")
})
