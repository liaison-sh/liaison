// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe invoice past its last automatic retry: nothing issues it but a person's click, every
// path that issues shares one check of what the sale already has, and Home says what waits for
// whom. In-memory store; two real transactions and the whole recovery run on Postgres in the api
// integration suite (stripe-parked-invoices.test.ts).
import { describe, expect, test } from "bun:test"
import { DEAD_LETTER_CAP } from "../deferred"
import { deferredRetryJobHandler } from "./deferred-dispatch"
import { reconcileStripePayments } from "./reconcile-stripe-payments"
import { onStripeInvoiceFinalized } from "./stripe-invoice-finalized"
import { onStripeInvoiceClosed, onStripeInvoicePaid } from "./stripe-invoice-paid"
import {
  creditNotes,
  type Emitted,
  finalized,
  invoices,
  parks,
  stripeCtx,
  stripeDb,
} from "./stripe-money.testkit"
import {
  invoiceFromStripePayment,
  invoiceFromStripePaymentPreflight,
  onStripePaymentUnmatched,
  onStripeSaleDecided,
  paymentLinkToInvoice,
  paymentLinkToInvoicePreflight,
} from "./stripe-payment-unmatched"
import { onStripeRefundCreated } from "./stripe-refund-created"

type Any = any
type Db = ReturnType<typeof stripeDb>

const buyer = finalized().customer
const INCOMPLETE = { name: "Lumen Studio", email: "billing@lumen.example", country: "FR" }
const noAddress = (over: Any = {}) => finalized({ customer: INCOMPLETE, ...over })
const complete = { customer_id: "cus_1", contact_id: null, customer: buyer }
const PAID = { charge_id: "ch_1", status: "paid", paid_at: "2026-11-15T10:00:00Z" }

interface Answers {
  /** The customers as the mirror holds them. */
  buyers?: Any[]
  /** The Stripe invoice as Stripe answers for it now; null: Stripe cannot be read. */
  invoice?: Any
  /** A charge as Stripe answers for it now. */
  payment?: Any
  /** The invoices' statuses in the mirror. */
  statuses?: Record<string, string>
  candidates?: Any[]
}
/** The Stripe app, as invoicing calls it. */
const stripeApp = (a: Answers, calls: Array<{ tool: string; params: Any }> = []) =>
  (async (tool: string, params: Any) => {
    calls.push({ tool, params })
    const done = (result: Any) => ({ status: "completed", result })
    if (tool === "stripe:reconcile_candidates") {
      const asked = params.buyers ?? []
      return done({
        invoices: a.candidates ?? [],
        refunds: [],
        buyers: (a.buyers ?? []).filter((b) => asked.includes(b.customer_id)),
      })
    }
    if (tool === "stripe:waiting_state")
      return done({
        buyers: (a.buyers ?? []).filter((b) => params.customers.includes(b.customer_id)),
        invoices: Object.entries(a.statuses ?? {})
          .filter(([id]) => params.invoices.includes(id))
          .map(([id, status]) => ({ stripe_invoice_id: id, status })),
      })
    if (tool === "stripe:invoice_payload" && a.invoice)
      return done({
        invoice: typeof a.invoice === "function" ? a.invoice(params.stripeInvoiceId) : a.invoice,
      })
    if (tool === "stripe:payment_payload" && a.payment) return done({ payment: a.payment })
    return { status: "error", error: { code: "stripe_unavailable", message: "no answer" } }
  }) as never

const sweep = (ctx: Any, hour: number) =>
  deferredRetryJobHandler(undefined, ctx, { now: new Date(Date.UTC(2030, 0, 1, hour)) })

/** Park the invoice and let every automatic retry pass while Stripe still lacks the buyer. */
async function exhausted(db: Db, payload: Any = noAddress()) {
  const ctx = stripeCtx(db, { executeTool: stripeApp({ invoice: payload }) })
  await onStripeInvoiceFinalized({ data: payload }, ctx)
  for (let i = 0; i < 12; i++) await sweep(ctx, i * 2)
  expect(parks(db)[0]?.retry_count).toBe(DEAD_LETTER_CAP)
  return ctx
}

/** `n` invoices already past their last retry, as an earlier version left them (no Home line). */
async function backlog(db: Db, n: number, over: (i: number) => Any = () => ({})) {
  for (let i = 0; i < n; i++) {
    const o = over(i)
    await db.insert("deferred_events", {
      event_id: `stripe:in_${i}`,
      event_payload_json: {
        ...noAddress({ stripe_invoice_id: `in_${i}`, customer_id: o.customer_id ?? "cus_1" }),
        kind: "stripe_invoice",
      },
      status: o.status ?? "awaiting_data",
      reason: "awaiting_data",
      blocked_on: {
        kind: "stripe_invoice",
        stripe_invoice_id: `in_${i}`,
        customer_id: o.customer_id ?? "cus_1",
      },
      retry_count: o.retry_count ?? DEAD_LETTER_CAP,
      retried_at: new Date(Date.UTC(2029, 0, 1)).toISOString(),
      created_at: new Date(Date.UTC(2026, 10, 2)).toISOString(),
    })
  }
}

/** A sale a person invoiced by hand: an issued invoice with no Stripe key. */
async function handInvoice(db: Db) {
  const ctx = stripeCtx(db)
  const r: Any = await onStripeInvoiceFinalized(
    { data: finalized({ stripe_invoice_id: "in_hand" }) },
    ctx,
  )
  await db.update("documents", r.document_id, { external_ref: null, external_refs: {} })
  for (const s of db.__all("stripe_sales")) await db.delete("stripe_sales", String(s.id))
  return r.document_id as string
}
const asPerson = (ctx: Any) => ({ ...ctx, getUserId: async () => "u-1" })
const numbersTaken = (db: Db) => [...db.__sequences.values()].reduce((s, n) => s + n, 0)
const needsPerson = (e: Emitted[]) =>
  e.filter((x) => x.entity === "stripe_invoice" && x.action === "needs_person") as Any[]
const grouped = (e: Emitted[]) =>
  e.filter((x) => x.entity === "stripe_invoice" && x.action === "many_need_person") as Any[]
const openParks = (db: Db) =>
  parks(db).filter((p) => p.status !== "resolved") as Array<Record<string, Any>>

describe("past its last automatic retry, an invoice is issued by a person only", () => {
  test("a completed buyer issues nothing: not the safety job, the sweep, nor a paid event", async () => {
    const db = stripeDb()
    await exhausted(db)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({
        buyers: [complete],
        invoice: finalized(),
        candidates: [finalized()],
      }),
    })
    for (let i = 0; i < 4; i++) {
      await reconcileStripePayments(ctx)
      await sweep(ctx, 48 + i * 2)
    }
    await onStripeInvoiceFinalized({ data: finalized() }, ctx)
    await onStripeInvoicePaid({ data: finalized(PAID) }, ctx)
    await sweep(ctx, 24 * 60)
    expect(invoices(db)).toHaveLength(0)
    expect(numbersTaken(db)).toBe(0)
    expect(openParks(db)).toHaveLength(1)
    expect(openParks(db)[0]).toMatchObject({ status: "awaiting_data", retry_count: 10 })

    expect(
      await invoiceFromStripePayment(asPerson(ctx), { stripeInvoiceId: "in_1" }),
    ).toMatchObject({ status: "completed" })
    expect(invoices(db)).toHaveLength(1)
    expect(openParks(db)).toHaveLength(0)
  })

  test("under the cap the retry still issues as soon as the buyer is complete", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db, { executeTool: stripeApp({ invoice: noAddress() }) })
    await onStripeInvoiceFinalized({ data: noAddress() }, ctx)
    for (let i = 0; i < 9; i++) await sweep(ctx, i * 2)
    expect(parks(db)[0]?.retry_count).toBe(9)
    await sweep(stripeCtx(db, { executeTool: stripeApp({ invoice: finalized() }) }), 40)
    expect(invoices(db)).toHaveLength(1)
  })

  test("one that waited for the issuer is not issued by itself either once the issuer is set", async () => {
    const db = stripeDb()
    const issuer = db.__all("issuer_profiles")[0] as Any
    await db.delete("issuer_profiles", issuer.id)
    const ctx = stripeCtx(db, { executeTool: stripeApp({ invoice: finalized() }) })
    await onStripeInvoiceFinalized({ data: finalized() }, ctx)
    for (let i = 0; i < 12; i++) await sweep(ctx, i * 2)
    await reconcileStripePayments(ctx)
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("issuer profile is missing")
    await db.insert("issuer_profiles", issuer)
    await reconcileStripePayments(ctx)
    await sweep(ctx, 48)
    expect(invoices(db)).toHaveLength(0)
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("Issue it")
    expect((await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })).status).toBe(
      "completed",
    )
  })

  test("a click with Stripe unreadable refuses and takes no number, whatever the park holds", async () => {
    const db = stripeDb()
    await exhausted(db)
    // The park holds a complete buyer and the invoice as it stood then (open): it may be void now.
    await db.update("deferred_events", String(parks(db)[0]?.id), {
      event_payload_json: { ...finalized(), kind: "stripe_invoice" },
    })
    const ctx = stripeCtx(db, { executeTool: stripeApp({ buyers: [complete] }) })
    await reconcileStripePayments(ctx)
    await sweep(ctx, 48)
    expect(await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })).toMatchObject({
      status: "error",
      error: { code: "stripe_unreadable" },
    })
    expect(invoices(db)).toHaveLength(0)
    expect(numbersTaken(db)).toBe(0)
    expect(openParks(db)).toHaveLength(1)
  })

  test("a retry under the cap with Stripe unreadable waits too: a stored invoice is never issued", async () => {
    const db = stripeDb()
    const issuer = db.__all("issuer_profiles")[0] as Any
    await db.delete("issuer_profiles", issuer.id)
    await onStripeInvoiceFinalized({ data: finalized() }, stripeCtx(db))
    await db.insert("issuer_profiles", issuer)
    await sweep(stripeCtx(db, { executeTool: stripeApp({}) }), 2)
    expect(invoices(db)).toHaveLength(0)
    await sweep(stripeCtx(db, { executeTool: stripeApp({ invoice: finalized() }) }), 4)
    expect(invoices(db)).toHaveLength(1)
  })

  test("a click on an invoice voided in Stripe, its event missed, refuses with that reason and drops it", async () => {
    const db = stripeDb()
    await exhausted(db)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ invoice: finalized({ status: "void" }) }),
    })
    const r: Any = await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
    expect(r.status).toBe("error")
    expect(r.error.message).toContain("voided or written off in Stripe")
    expect(openParks(db)).toHaveLength(0)
    expect(numbersTaken(db)).toBe(0)
    expect(needsPerson(ctx.emitted).at(-1)).toMatchObject({ data: { resolved: true } })
  })

  test("a click issues an invoice paid since (its event missed) as paid, never as it was parked", async () => {
    const db = stripeDb()
    await exhausted(db)
    const ctx = stripeCtx(db, { executeTool: stripeApp({ invoice: finalized(PAID) }) })
    await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
    expect(invoices(db)[0]).toMatchObject({ payment_status: "paid" })
  })

  test("a refused click leaves nothing that issues later, and the next one reads Stripe again", async () => {
    const db = stripeDb("undecided")
    const open = stripeCtx(db, { executeTool: stripeApp({ invoice: noAddress() }) })
    await onStripeInvoiceFinalized({ data: noAddress() }, open)
    await db.update("stripe_streams", "st-1", {
      issuer: "liaison",
      decided_at: new Date().toISOString(),
    })
    const refused: Any = await invoiceFromStripePayment(open, { stripeInvoiceId: "in_1" })
    expect(refused.error.message).toContain("customer_address_missing")
    expect(openParks(db).map((p) => p.blocked_on.kind)).toEqual(["stripe_issuer_undecided"])
    const ctx = stripeCtx(db, { executeTool: stripeApp({ invoice: finalized() }) })
    for (let i = 0; i < 5; i++) {
      await reconcileStripePayments(ctx)
      await sweep(ctx, i * 2)
    }
    expect(invoices(db)).toHaveLength(0)
    expect((await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })).status).toBe(
      "completed",
    )
  })

  test("a click refused by the e-invoicing gate keeps the invoice with the person", async () => {
    const db = stripeDb()
    await exhausted(db)
    await db.update("issuer_profiles", "iss-1", {})
    const business = finalized({ customer: { ...buyer, vat_id: "FR68900000001" } as Any })
    const { seedConfirmedIdentity } = await import("../einvoicing/test-fixtures")
    const { CONTACT } = await import("./stripe-money.testkit")
    await seedConfirmedIdentity(db, {
      contact_id: CONTACT,
      siren: "900000001",
      name: "Lumen Studio SAS",
      postcode: "69001",
      city: "Lyon",
    })
    const ctx = stripeCtx(db, { executeTool: stripeApp({ invoice: business, buyers: [complete] }) })
    const r: Any = await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
    expect(r.status).toBe("error")
    expect(openParks(db)).toHaveLength(1)
    expect(openParks(db)[0]).toMatchObject({
      retry_count: 10,
      blocked_on: { kind: "stripe_invoice" },
    })
    // The safety job keeps saying what the click was refused for.
    await reconcileStripePayments(ctx)
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("refused")
    await sweep(ctx, 400)
    expect(invoices(db)).toHaveLength(0)
  })
})

describe("one sale, one invoice, by either key", () => {
  /** in_1 past its retries, its charge ch_1 invoiced by hand and linked. */
  async function linkedByHand(db: Db, over: Answers = {}) {
    const doc = await handInvoice(db)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ payment: { charge_id: "ch_1", invoice_id: "in_1" }, ...over }),
    })
    const r: Any = await paymentLinkToInvoice(asPerson(ctx), { chargeId: "ch_1", documentId: doc })
    expect(r.status).toBe("completed")
    return { doc, ctx }
  }
  const now = { buyers: [complete], invoice: finalized(PAID), candidates: [finalized(PAID)] }

  test("linking a charge by hand closes its Stripe invoice's park and line, and nothing issues it again", async () => {
    const db = stripeDb()
    await exhausted(db, noAddress(PAID))
    const { ctx: linker } = await linkedByHand(db, { payment: undefined })
    expect(openParks(db)).toHaveLength(0)
    expect(needsPerson(linker.emitted).at(-1)).toMatchObject({ data: { resolved: true } })
    const before = numbersTaken(db)
    const ctx = stripeCtx(db, { executeTool: stripeApp(now) })
    await reconcileStripePayments(ctx)
    await sweep(ctx, 48)
    expect(invoices(db)).toHaveLength(1)
    expect(numbersTaken(db)).toBe(before)
  })

  test("the same when the park never knew its charge: Stripe says which invoice the charge paid", async () => {
    const db = stripeDb()
    await exhausted(db, noAddress())
    await linkedByHand(db)
    expect(openParks(db)).toHaveLength(0)
    // The event that comes later names no charge either.
    const r = await onStripeInvoiceFinalized({ data: finalized() }, stripeCtx(db))
    expect(r).toMatchObject({ status: "skipped", reason: "duplicate_document" })
    expect(invoices(db)).toHaveLength(1)
  })

  /** A charge linked before this check existed: the link is only on the document. */
  async function oldLink(db: Db, field: "ref" | "refs") {
    const doc = await handInvoice(db)
    await db.update("documents", doc, {
      external_ref: field === "ref" ? "stripe:ch_1" : "import:9",
      external_refs: { stripe_charge_id: "ch_1" },
    })
  }
  for (const field of ["ref", "refs"] as const) {
    const paths: Record<string, (db: Db) => Promise<unknown>> = {
      "the finalized event": (db) =>
        onStripeInvoiceFinalized({ data: finalized(PAID) }, stripeCtx(db)),
      "the paid event": (db) => onStripeInvoicePaid({ data: finalized(PAID) }, stripeCtx(db)),
      "a retry under the cap": async (db) => {
        await onStripeInvoiceFinalized({ data: noAddress() }, stripeCtx(db))
        await sweep(stripeCtx(db, { executeTool: stripeApp(now) }), 2)
      },
      "the safety job": (db) =>
        reconcileStripePayments(stripeCtx(db, { executeTool: stripeApp(now) })),
      "a person's click": async (db) => {
        await backlog(db, 2)
        const ctx = stripeCtx(db, { executeTool: stripeApp(now) })
        const r: Any = await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
        expect(r).toMatchObject({ status: "error", error: { code: "already_invoiced" } })
        expect(r.error.message).toContain("INV-")
      },
      "the threshold card": async (db) => {
        await db.update("issuer_profiles", "iss-1", { invoice_approval_threshold_minor: "100" })
        const ctx = stripeCtx(db, {
          executeTool: stripeApp(now),
          requestApproval: (async () => ({ approval_id: "ap-1" })) as never,
        })
        await onStripeInvoiceFinalized({ data: finalized() }, ctx)
        expect(openParks(db).map((p) => p.blocked_on.kind)).toEqual(["stripe_invoice_approval"])
        expect(await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })).toMatchObject({
          status: "error",
          error: { code: "already_invoiced" },
        })
      },
    }
    for (const [name, run] of Object.entries(paths)) {
      test(`${name} refuses a charge linked by its ${field === "ref" ? "key" : "reference"} and closes the park`, async () => {
        const db = stripeDb()
        await oldLink(db, field)
        const before = numbersTaken(db)
        await run(db)
        expect(invoices(db)).toHaveLength(1)
        expect(numbersTaken(db)).toBe(before)
        expect(openParks(db).filter((p) => p.event_id === "stripe:in_1")).toHaveLength(0)
        // And it stays so: the partial row the safety job reads of a paid invoice parks nothing.
        await reconcileStripePayments(
          stripeCtx(db, {
            executeTool: stripeApp({
              candidates: [
                {
                  stripe_invoice_id: "in_1",
                  status: "paid",
                  total_minor: "12000",
                  currency: "eur",
                },
              ],
            }),
          }),
        )
        expect(openParks(db).filter((p) => p.event_id === "stripe:in_1")).toHaveLength(0)
      })
    }
  }

  test("a charge whose Stripe invoice is already issued is neither issued nor linked again", async () => {
    const db = stripeDb()
    await onStripePaymentUnmatched(
      {
        data: {
          charge_id: "ch_1",
          amount_minor: "12000",
          currency: "eur",
          created: "2026-11-15T10:00:00Z",
          customer: buyer,
        },
      },
      stripeCtx(db),
    )
    await onStripeInvoiceFinalized({ data: finalized(PAID) }, stripeCtx(db))
    const n = numbersTaken(db)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({
        payment: {
          charge_id: "ch_1",
          invoice_id: "in_1",
          status: "succeeded",
          amount_minor: "12000",
          currency: "eur",
          customer: buyer,
        },
      }),
    })
    const click: Any = await invoiceFromStripePayment(ctx, { chargeId: "ch_1", vatRateBp: 2000 })
    expect(click.error.code).toBe("already_invoiced")
    const other = await handInvoice(stripeDb())
    expect(other).toBeTruthy()
    const link: Any = await paymentLinkToInvoicePreflight(ctx, {
      chargeId: "ch_1",
      documentId: String(invoices(db)[0]?.id),
    })
    expect(link.error.code).toBe("already_linked")
    expect(numbersTaken(db)).toBe(n)
    expect(openParks(db).filter((p) => p.event_id === "stripe:ch_1")).toHaveLength(0)
  })

  test("issuing claims both keys of the sale, so a second issue under the other key cannot commit", async () => {
    const db = stripeDb()
    await onStripeInvoiceFinalized({ data: finalized(PAID) }, stripeCtx(db))
    expect(
      db
        .__all("stripe_sales")
        .map((s) => s.key)
        .sort(),
    ).toEqual(["stripe:ch_1", "stripe:in_1"])
  })

  test("a loser of the race on a key issues nothing, and says who has it", async () => {
    const db = stripeDb()
    await exhausted(db)
    const doc = await handInvoice(db)
    const ctx = stripeCtx(db, { executeTool: stripeApp({ invoice: finalized() }) })
    const before = numbersTaken(db)
    // The other transaction commits between this one's check and its batch.
    const batch = db.batch.bind(db)
    ;(db as Any).batch = async (spec: Any) => {
      if (spec.sequence) {
        await db.insert("stripe_sales", { key: "stripe:in_1", document_id: doc })
        throw new Error(
          'duplicate key value violates unique constraint "stripe_sales_key_key" (23505)',
        )
      }
      return batch(spec)
    }
    const r: Any = await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
    expect(r).toMatchObject({ status: "error", error: { code: "already_invoiced" } })
    expect(invoices(db)).toHaveLength(1)
    expect(numbersTaken(db)).toBe(before)
    expect(openParks(db)).toHaveLength(0)
  })
})

describe("a payment with no Stripe invoice is always decided by a person", () => {
  const CH = {
    charge_id: "ch_9",
    invoice_id: null,
    customer_id: "cus_1",
    contact_id: null,
    amount_minor: "12000",
    currency: "eur",
    created: "2026-11-15T10:00:00Z",
    description: null,
    customer: INCOMPLETE,
  }
  const payment = (customer: Any, over: Any = {}) => ({
    ...CH,
    customer,
    status: "succeeded",
    ...over,
  })

  test("a refused click parks nothing that issues later, at any rate", async () => {
    const db = stripeDb()
    await onStripePaymentUnmatched({ data: CH }, stripeCtx(db))
    const first = stripeCtx(db, { executeTool: stripeApp({ payment: payment(INCOMPLETE) }) })
    const r: Any = await invoiceFromStripePayment(first, { chargeId: "ch_9", vatRateBp: 2000 })
    expect(r.error.message).toContain("customer_address_missing")
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ buyers: [complete], payment: payment(buyer) }),
    })
    for (let i = 0; i < 14; i++) {
      await sweep(ctx, i * 2)
      await reconcileStripePayments(ctx)
    }
    expect(invoices(db)).toHaveLength(0)
    expect(openParks(db).map((p) => p.blocked_on.kind)).toEqual(["stripe_unmatched_payment"])
  })

  test("the next click reads the payment and its customer again, and issues at that click's rate", async () => {
    const db = stripeDb()
    await onStripePaymentUnmatched({ data: CH }, stripeCtx(db))
    const first = stripeCtx(db, { executeTool: stripeApp({ payment: payment(INCOMPLETE) }) })
    await invoiceFromStripePayment(first, { chargeId: "ch_9", vatRateBp: 2000 })
    const ctx = stripeCtx(db, { executeTool: stripeApp({ payment: payment(buyer) }) })
    expect(
      await invoiceFromStripePayment(ctx, { chargeId: "ch_9", vatRateBp: 1000 }),
    ).toMatchObject({ status: "completed" })
    expect(db.__all("document_lines").map((l) => Number(l.tax_rate_bp))).toContain(1000)
    expect(openParks(db)).toHaveLength(0)
  })

  test("a click with Stripe unreadable, or on a payment that did not succeed, refuses", async () => {
    const db = stripeDb()
    await onStripePaymentUnmatched({ data: { ...CH, customer: buyer } }, stripeCtx(db))
    const down: Any = await invoiceFromStripePayment(
      stripeCtx(db, { executeTool: stripeApp({}) }),
      { chargeId: "ch_9", vatRateBp: 2000 },
    )
    expect(down.error.code).toBe("stripe_unreadable")
    const failed: Any = await invoiceFromStripePayment(
      stripeCtx(db, { executeTool: stripeApp({ payment: payment(buyer, { status: "failed" }) }) }),
      { chargeId: "ch_9", vatRateBp: 2000 },
    )
    expect(failed.error.code).toBe("not_issued")
    expect(numbersTaken(db)).toBe(0)
  })

  test("a park an earlier version left on the payment never issues, and raises no card", async () => {
    const db = stripeDb("liaison", { invoice_approval_threshold_minor: "100" })
    await onStripePaymentUnmatched({ data: CH }, stripeCtx(db))
    const asked: Any[] = []
    for (const retry_count of [0, DEAD_LETTER_CAP]) {
      await db.insert("deferred_events", {
        event_id: "stripe:ch_9",
        event_payload_json: { ...finalized({ stripe_invoice_id: "ch_9" }), kind: "stripe_invoice" },
        status: "awaiting_data",
        reason: "customer_address_missing",
        blocked_on: { kind: "stripe_invoice", stripe_invoice_id: "ch_9", customer_id: "cus_1" },
        retry_count,
        retried_at: null,
        created_at: new Date(Date.UTC(2026, 10, 20)).toISOString(),
      })
    }
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ buyers: [complete], payment: payment(buyer) }),
      requestApproval: (async (r: Any) => {
        asked.push(r)
        return { approval_id: "a" }
      }) as never,
    })
    for (let i = 0; i < 3; i++) {
      await sweep(ctx, 48 + i * 2)
      await reconcileStripePayments(ctx)
    }
    expect(invoices(db)).toHaveLength(0)
    expect(asked).toHaveLength(0)
    expect(openParks(db).map((p) => p.blocked_on.kind)).toEqual(["stripe_unmatched_payment"])
    // The card an earlier version raised names it as an invoice: refused, with the way on.
    const card: Any = await invoiceFromStripePayment(ctx, { stripeInvoiceId: "ch_9" })
    expect(card.error.message).toContain("chargeId")
  })

  test("whichever of its parks is read first, the click finds the payment", async () => {
    const db = stripeDb()
    await db.insert("deferred_events", {
      event_id: "stripe:ch_9",
      event_payload_json: { ...finalized({ stripe_invoice_id: "ch_9" }), kind: "stripe_invoice" },
      status: "awaiting_data",
      reason: "customer_address_missing",
      blocked_on: { kind: "stripe_invoice", stripe_invoice_id: "ch_9" },
      retry_count: 3,
      retried_at: null,
      created_at: new Date(Date.UTC(2026, 10, 20)).toISOString(),
    })
    await onStripePaymentUnmatched({ data: CH }, stripeCtx(db))
    const ctx = stripeCtx(db, { executeTool: stripeApp({ payment: payment(buyer) }) })
    expect(
      await invoiceFromStripePayment(ctx, { chargeId: "ch_9", vatRateBp: 2000 }),
    ).toMatchObject({ status: "completed" })
    expect(String(invoices(db)[0]?.grand_total_minor)).toBe("12000")
  })
})

describe("every row is reached, however many wait", () => {
  test("the 511th capped invoice's buyer is asked for, shown on Home and issued by a click", async () => {
    const db = stripeDb()
    await backlog(db, 520, (i) => ({ customer_id: `cus_${i}` }))
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({
        buyers: [{ ...complete, customer_id: "cus_510" }],
        invoice: finalized({ stripe_invoice_id: "in_510", customer_id: "cus_510" }),
      }),
    })
    await reconcileStripePayments(ctx)
    expect(grouped(ctx.emitted).at(-1).data).toMatchObject({ count: 520, ready: 1 })
    expect(grouped(ctx.emitted).at(-1).data.text).toContain("in_510")
    expect((await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_510" })).status).toBe(
      "completed",
    )
  })

  test("a row due for its retry is tried though 520 others wait in the same status", async () => {
    const db = stripeDb()
    await backlog(db, 520)
    await onStripeInvoiceFinalized(
      { data: noAddress({ stripe_invoice_id: "in_late" }) },
      stripeCtx(db),
    )
    await sweep(
      stripeCtx(db, {
        executeTool: stripeApp({ invoice: (id: string) => finalized({ stripe_invoice_id: id }) }),
      }),
      48,
    )
    expect(invoices(db).map((d) => d.external_ref)).toEqual(["stripe:in_late"])
  })

  test("duplicate parks beyond the first 500 rows are collapsed, and a revived credit note there is tried", async () => {
    const db = stripeDb()
    await backlog(db, 520, () => ({ status: "awaiting_dependency" }))
    const issued: Any = await onStripeInvoiceFinalized(
      { data: finalized({ stripe_invoice_id: "in_x" }) },
      stripeCtx(db),
    )
    expect(issued.status).toBe("ok")
    for (const retry_count of [3, DEAD_LETTER_CAP])
      await db.insert("deferred_events", {
        event_id: "stripe:re_1",
        event_payload_json: {
          kind: "stripe_credit_note",
          refund_id: "re_1",
          charge_id: "ch_x",
          invoice_id: "in_x",
          amount_minor: "12000",
        },
        status: "awaiting_dependency",
        reason: "invoice_not_issued",
        blocked_on: { kind: "stripe_credit_note", invoice_ref: "stripe:in_x", refund_id: "re_1" },
        retry_count,
        retried_at: null,
        created_at: new Date(Date.UTC(2026, 10, 20)).toISOString(),
      })
    const ctx = stripeCtx(db, { executeTool: stripeApp({}) })
    await reconcileStripePayments(ctx)
    await sweep(ctx, 48)
    expect(creditNotes(db)).toHaveLength(1)
    expect(openParks(db).filter((p) => p.event_id === "stripe:re_1")).toHaveLength(0)
  })

  test("the open park of an event with many closed ones is found, and all its parks of a kind close", async () => {
    const db = stripeDb()
    for (let i = 0; i < 60; i++)
      await db.insert("deferred_events", {
        event_id: "stripe:in_1",
        event_payload_json: {},
        status: "resolved",
        reason: "duplicate_park",
        blocked_on: { kind: "stripe_invoice", stripe_invoice_id: "in_1" },
        retry_count: 0,
        retried_at: null,
        created_at: new Date(Date.UTC(2026, 10, 1)).toISOString(),
      })
    await onStripeInvoiceFinalized({ data: noAddress() }, stripeCtx(db))
    const still = stripeCtx(db, { executeTool: stripeApp({ invoice: noAddress() }) })
    const r: Any = await invoiceFromStripePayment(still, { stripeInvoiceId: "in_1" })
    expect(r.error.message).toContain("customer_address_missing")
    // Duplicates an older version left open close with it, wherever they are among the others.
    for (const id of ["zz-1", "zz-2"])
      await db.insert("deferred_events", { ...(openParks(db)[0] as Any), id })
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized({ data: finalized({ total_minor: "99900" }) }, ctx)
    expect(openParks(db).map((p) => p.reason)).toEqual(["stripe_total_mismatch"])
    expect(needsPerson(ctx.emitted).filter((e) => e.data.resolved)).toHaveLength(3)
  })

  test("a retry that finds a tax to review waits there alone, and is not tried again", async () => {
    const db = stripeDb()
    await onStripeInvoiceFinalized({ data: noAddress() }, stripeCtx(db))
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ invoice: finalized({ total_minor: "99900" }) }),
    })
    for (let i = 0; i < 3; i++) await sweep(ctx, 2 + i * 2)
    expect(openParks(db)).toMatchObject([{ reason: "stripe_total_mismatch", retry_count: 0 }])
  })

  test("more than 50 credit notes whose invoice is there are handed back 50 at a time", async () => {
    const db = stripeDb()
    await onStripeInvoiceFinalized(
      { data: finalized({ stripe_invoice_id: "in_x" }) },
      stripeCtx(db),
    )
    for (let i = 0; i < 60; i++)
      await db.insert("deferred_events", {
        event_id: `stripe:re_${i}`,
        event_payload_json: {
          kind: "stripe_credit_note",
          refund_id: `re_${i}`,
          charge_id: "ch_x",
          invoice_id: "in_x",
          amount_minor: "1",
        },
        status: "awaiting_dependency",
        reason: "invoice_not_issued",
        blocked_on: {
          kind: "stripe_credit_note",
          invoice_ref: "stripe:in_x",
          refund_id: `re_${i}`,
        },
        retry_count: DEAD_LETTER_CAP,
        retried_at: new Date(Date.UTC(2029, 0, 1)).toISOString(),
        created_at: new Date(Date.UTC(2026, 10, 20)).toISOString(),
      })
    const ctx = stripeCtx(db, { executeTool: stripeApp({}) })
    const back = () =>
      (parks(db) as Any[]).filter(
        (p) => p.blocked_on.kind === "stripe_credit_note" && p.retry_count === 0,
      ).length
    await reconcileStripePayments(ctx)
    expect(back()).toBe(50)
    await reconcileStripePayments(ctx)
    expect(back()).toBe(60)
    // Queued behind the rows already due, so the queue never fills with them.
    const one = parks(db).find((p) => p.event_id === "stripe:re_0") as Any
    expect(Date.parse(String(one.retried_at))).toBeLessThan(Date.UTC(2029, 0, 1))
  })
})

describe("what Home says", () => {
  test("a new park's line follows what is missing, whatever the order", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized(
      { data: finalized({ customer: { name: "L", country: "FR" } }) },
      ctx,
    )
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("no email in Stripe")
    await onStripeInvoiceFinalized({ data: noAddress() }, ctx)
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("no billing address in Stripe")
    await onStripeInvoiceFinalized({ data: noAddress() }, ctx)
    expect(needsPerson(ctx.emitted)).toHaveLength(2)
  })

  test("a park first made for the issuer gets its line once the buyer is what it lacks", async () => {
    const db = stripeDb()
    const issuer = db.__all("issuer_profiles")[0] as Any
    await db.delete("issuer_profiles", issuer.id)
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized({ data: noAddress() }, ctx)
    expect(needsPerson(ctx.emitted)).toHaveLength(0)
    await db.insert("issuer_profiles", issuer)
    await onStripeInvoiceFinalized({ data: noAddress() }, ctx)
    expect(needsPerson(ctx.emitted)).toHaveLength(1)
  })

  test("past the cap the line says it no longer issues on its own, then that the customer is complete, and closes with the issue", async () => {
    const db = stripeDb()
    const early = await exhausted(db)
    expect(needsPerson(early.emitted)[0].data.reason).toContain("the invoice is issued")
    const waiting = stripeCtx(db, {
      executeTool: stripeApp({ buyers: [{ ...complete, customer: INCOMPLETE }] }),
    })
    await reconcileStripePayments(waiting)
    await reconcileStripePayments(waiting)
    expect(needsPerson(waiting.emitted)).toHaveLength(1)
    const id = String(parks(db)[0]?.id)
    expect(needsPerson(waiting.emitted)[0]).toMatchObject({ entityId: id })
    expect(needsPerson(waiting.emitted)[0].data.reason).toContain("then issue it")

    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ buyers: [complete], invoice: finalized() }),
    })
    await reconcileStripePayments(ctx)
    await reconcileStripePayments(ctx)
    expect(needsPerson(ctx.emitted)).toHaveLength(1)
    expect(needsPerson(ctx.emitted)[0].data.reason).toContain("is complete in Stripe now")
    // The mirror loses the address again: the line says so.
    await reconcileStripePayments(waiting)
    expect(needsPerson(waiting.emitted).at(-1).data.reason).toContain("no billing address")
    // A safety job that cannot read Stripe changes no line.
    const blind = stripeCtx(db, {
      executeTool: (async () => ({ status: "error", error: {} })) as never,
    })
    await reconcileStripePayments(blind)
    expect(needsPerson(blind.emitted)).toHaveLength(0)

    await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
    expect(needsPerson(ctx.emitted).at(-1)).toMatchObject({
      entityId: id,
      data: { resolved: true },
    })
  })

  test("a customer with an empty name counts as complete to the job and to the issue alike", async () => {
    const db = stripeDb()
    await exhausted(db)
    const b = { ...buyer, name: "" }
    const calls: Any[] = []
    const ctx = stripeCtx(db, {
      executeTool: stripeApp(
        { buyers: [{ ...complete, customer: b }], invoice: finalized({ customer: b }) },
        calls,
      ),
    })
    for (let k = 0; k < 10; k++) {
      await reconcileStripePayments(ctx)
      await sweep(ctx, 48 + k * 2)
    }
    expect(calls.filter((c) => c.tool === "stripe:invoice_payload")).toHaveLength(0)
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("is complete in Stripe now")
    expect((await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })).status).toBe(
      "completed",
    )
    expect(invoices(db)[0]).toMatchObject({ counterparty_name: "billing@lumen.example" })
  })

  test("a customer with no email is not complete, and a name alone never is", async () => {
    const db = stripeDb()
    await exhausted(db)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ buyers: [{ ...complete, customer: { ...buyer, email: null } }] }),
    })
    await reconcileStripePayments(ctx)
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("no email in Stripe")
  })

  test("an existing backlog issues nothing by itself and shows one line, whose count follows each click", async () => {
    const db = stripeDb()
    await backlog(db, 60)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({
        buyers: [complete],
        invoice: (id: string) => finalized({ stripe_invoice_id: id }),
      }),
    })
    for (let i = 0; i < 3; i++) {
      await reconcileStripePayments(ctx)
      await sweep(ctx, 48 + i * 2)
    }
    expect(invoices(db)).toHaveLength(0)
    expect(needsPerson(ctx.emitted).filter((e) => !e.data.resolved)).toHaveLength(0)
    expect(grouped(ctx.emitted)).toHaveLength(1)
    expect(grouped(ctx.emitted)[0].data).toMatchObject({ count: 60, ready: 60, resolved: false })
    for (let i = 0; i < 50; i++) await invoiceFromStripePayment(ctx, { stripeInvoiceId: `in_${i}` })
    expect(grouped(ctx.emitted).at(-1).data).toMatchObject({ count: 10, ready: 10 })
    // Few enough now: each gets its own line, the grouped one goes.
    await reconcileStripePayments(ctx)
    expect(grouped(ctx.emitted).at(-1).data).toMatchObject({ resolved: true })
    const own = needsPerson(ctx.emitted).filter((e) => !e.data.resolved)
    expect(own.map((e) => e.data.stripe_invoice_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `in_${50 + i}`),
    )
    for (let i = 50; i < 60; i++)
      await invoiceFromStripePayment(ctx, { stripeInvoiceId: `in_${i}` })
    expect(invoices(db)).toHaveLength(60)
    expect(openParks(db)).toHaveLength(0)
  })

  test("the grouped line closes when the last invoice behind it is dropped, and lines shown before it close", async () => {
    const db = stripeDb()
    await backlog(db, 10)
    const ctx = stripeCtx(db, { executeTool: stripeApp({ buyers: [complete] }) })
    await reconcileStripePayments(ctx)
    expect(needsPerson(ctx.emitted)).toHaveLength(10)
    await db.insert("deferred_events", {
      ...(parks(db)[0] as Any),
      id: undefined,
      event_id: "stripe:in_x",
      event_payload_json: { ...noAddress({ stripe_invoice_id: "in_x" }), kind: "stripe_invoice" },
      blocked_on: { kind: "stripe_invoice", stripe_invoice_id: "in_x", customer_id: "cus_1" },
    })
    await reconcileStripePayments(ctx)
    expect(needsPerson(ctx.emitted).filter((e) => e.data.resolved)).toHaveLength(10)
    expect(grouped(ctx.emitted).at(-1).data).toMatchObject({ count: 11 })
    for (const id of [...Array.from({ length: 10 }, (_, i) => `in_${i}`), "in_x"])
      await onStripeInvoiceClosed({ data: finalized({ stripe_invoice_id: id }) }, ctx, "voided")
    expect(grouped(ctx.emitted).at(-1).data).toMatchObject({ resolved: true })
    expect(openParks(db)).toHaveLength(0)
  })

  test("an invoice given up on by an earlier version gets its line too, and a bulk dead-letter stays so", async () => {
    const db = stripeDb()
    await backlog(db, 2, () => ({ status: "permanent_failure" }))
    await db.update("deferred_events", String(parks(db)[1]?.id), {
      reason: "dead-lettered: cutover",
    })
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({
        buyers: [complete],
        candidates: [finalized({ stripe_invoice_id: "in_0" })],
      }),
    })
    await reconcileStripePayments(ctx)
    expect(invoices(db)).toHaveLength(0)
    expect(needsPerson(ctx.emitted).map((e) => e.data.stripe_invoice_id)).toEqual(["in_0"])
    expect(parks(db).map((p) => p.status)).toEqual(["awaiting_data", "permanent_failure"])
  })

  test("one voided in Stripe whose event was missed is dropped by the safety job, with its line", async () => {
    const db = stripeDb()
    await exhausted(db)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ buyers: [complete], statuses: { in_1: "void" } }),
    })
    await reconcileStripePayments(ctx)
    expect(parks(db)[0]).toMatchObject({ status: "resolved", reason: "not_open_in_stripe" })
    expect(needsPerson(ctx.emitted).at(-1)).toMatchObject({ data: { resolved: true } })
  })

  test("one already invoiced under its own key is closed by the safety job, with its line", async () => {
    const db = stripeDb()
    await exhausted(db)
    const doc = await handInvoice(db)
    await db.update("documents", doc, { external_ref: "stripe:in_1" })
    const ctx = stripeCtx(db, { executeTool: stripeApp({ buyers: [complete] }) })
    await reconcileStripePayments(ctx)
    expect(parks(db)[0]).toMatchObject({ status: "resolved", reason: "already_issued" })
  })

  test("an invoice Stripe turns out to issue, or of zero, leaves the queue", async () => {
    for (const over of [{ total_minor: "0" }, { finalized_at: "2026-10-01T00:00:00Z" }]) {
      const db = stripeDb()
      await onStripeInvoiceFinalized({ data: noAddress() }, stripeCtx(db))
      await onStripeInvoiceFinalized({ data: noAddress(over) }, stripeCtx(db))
      expect(openParks(db)).toHaveLength(0)
    }
    const db = stripeDb()
    await onStripeInvoiceFinalized({ data: noAddress() }, stripeCtx(db))
    await db.update("stripe_streams", "st-1", { issuer: "stripe" })
    await onStripeInvoiceFinalized({ data: noAddress() }, stripeCtx(db))
    expect(openParks(db)).toHaveLength(0)
  })

  test("a Stripe app too old to answer for the buyers leaves the rest of the safety job working", async () => {
    const db = stripeDb()
    await exhausted(db)
    const ctx = stripeCtx(db, {
      executeTool: (async (tool: string, params: Any) => {
        if (tool === "stripe:reconcile_candidates" && !("buyers" in params))
          return {
            status: "completed",
            result: { invoices: [finalized({ stripe_invoice_id: "in_2" })], refunds: [] },
          }
        return { status: "error", error: { code: "invalid_params", message: "unknown" } }
      }) as never,
    })
    expect(await reconcileStripePayments(ctx)).toMatchObject({ issued: 1 })
  })
})

describe("the threshold card", () => {
  const over = { invoice_approval_threshold_minor: "100" }
  const asking = { requestApproval: (async () => ({ approval_id: "ap-1" })) as never }

  test("issues what it showed, though a redelivered event carried another buyer, with the payment as it is now", async () => {
    const db = stripeDb("liaison", over)
    const ctx = stripeCtx(db, {
      ...asking,
      executeTool: stripeApp({
        invoice: finalized({ ...PAID, customer: { ...buyer, name: "Another Buyer" } as Any }),
      }),
    })
    await onStripeInvoiceFinalized({ data: finalized() }, ctx)
    const other = { ...buyer, name: "Another Buyer" } as Any
    await onStripeInvoicePaid({ data: finalized({ ...PAID, customer: other }) }, ctx)
    await onStripeInvoiceFinalized({ data: noAddress() }, ctx)
    expect(openParks(db)).toHaveLength(1)
    expect((await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })).status).toBe(
      "completed",
    )
    expect(invoices(db)[0]).toMatchObject({
      counterparty_name: "Lumen Studio",
      payment_status: "paid",
    })
  })

  test("refuses a void, an unreadable and a changed invoice, and takes no number", async () => {
    for (const [invoice, words] of [
      [finalized({ status: "void" }), "voided"],
      [undefined, "could not be read"],
      [finalized({ total_minor: "24000" }), "changed"],
    ] as const) {
      const db = stripeDb("liaison", over)
      const ctx = stripeCtx(db, { ...asking, executeTool: stripeApp({ invoice }) })
      await onStripeInvoiceFinalized({ data: finalized() }, ctx)
      const r: Any = await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
      expect(r.status).toBe("error")
      expect(r.error.message).toContain(words)
      expect(numbersTaken(db)).toBe(0)
    }
  })
})

describe("a credit note that waited", () => {
  const refund = {
    charge_id: "ch_1",
    invoice_id: "in_1",
    refunds: [{ id: "re_1", amount_minor: "12000", status: "succeeded" }],
  }
  async function stalledNote(db: Db) {
    const w = await exhausted(db, noAddress({ charge_id: "ch_1" }))
    await onStripeRefundCreated({ data: refund }, w)
    for (let i = 0; i < 12; i++) await sweep(w, 100 + i * 2)
    return w
  }

  test("follows the invoice a person issued, however late, and not before", async () => {
    const db = stripeDb()
    await stalledNote(db)
    const ctx = stripeCtx(db, {
      executeTool: stripeApp({ buyers: [complete], invoice: finalized() }),
    })
    await reconcileStripePayments(ctx)
    await sweep(ctx, 200)
    expect(creditNotes(db)).toHaveLength(0)
    await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
    await reconcileStripePayments(ctx)
    await sweep(ctx, 220)
    expect(creditNotes(db).map((d) => d.external_ref)).toEqual(["stripe:re_1"])
  })

  for (const old of [false, true])
    test(`follows the invoice its charge was linked to by hand${old ? " before this version" : ""}`, async () => {
      const db = stripeDb()
      const w = await stalledNote(db)
      const doc = await handInvoice(db)
      if (old)
        await db.update("documents", doc, {
          external_ref: "import:9",
          external_refs: { stripe_charge_id: "ch_1" },
        })
      else await paymentLinkToInvoice(asPerson(w), { chargeId: "ch_1", documentId: doc })
      await reconcileStripePayments(w)
      await sweep(w, 220)
      expect(creditNotes(db).map((d) => d.external_ref)).toEqual(["stripe:re_1"])
    })
})

describe("a person holds no right to write parks", () => {
  /** A ctx whose writes to the parks change nothing, as the database answers a person. */
  const person = (db: Db, over: Answers) => {
    const ctx = stripeCtx(db, { executeTool: stripeApp(over) })
    const real = ctx.db as Any
    return {
      ...ctx,
      db: new Proxy(real, {
        get: (t, k) =>
          k === "update"
            ? async (e: string, id: string, d: Any) =>
                e === "deferred_events" ? undefined : t.update(e, id, d)
            : t[k].bind(t),
      }),
    } as typeof ctx
  }
  /** The system's handler of what the click told. */
  const deliver = async (db: Db, from: { emitted: Emitted[] }) => {
    const ctx = stripeCtx(db)
    const told = from.emitted.filter((e) => e.entity === "stripe_sale" && e.action === "decided")
    for (const e of told) await onStripeSaleDecided({ data: e.data }, ctx)
    return { ctx, told }
  }

  test("what their click issued closes the park, its duplicates' names included, through the system", async () => {
    const db = stripeDb()
    await exhausted(db)
    await onStripePaymentUnmatched(
      {
        data: {
          charge_id: "ch_1",
          amount_minor: "12000",
          currency: "eur",
          created: "2026-11-15T10:00:00Z",
          customer: buyer,
        },
      },
      stripeCtx(db),
    )
    const ctx = person(db, { invoice: finalized(PAID) })
    expect((await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })).status).toBe(
      "completed",
    )
    expect(openParks(db)).toHaveLength(2)
    const { told } = await deliver(db, ctx)
    expect(told).toHaveLength(1)
    expect(openParks(db)).toHaveLength(0)
    expect(parks(db).map((p) => p.reason)).toEqual(["issued", "issued"])
  })

  test("what refused it is on the line, and a void invoice is dropped", async () => {
    const db = stripeDb()
    await exhausted(db)
    const bad = person(db, { invoice: finalized({ total_minor: "99900" }) })
    await invoiceFromStripePayment(bad, { stripeInvoiceId: "in_1" })
    const { ctx } = await deliver(db, bad)
    expect(openParks(db)).toMatchObject([
      { reason: "stripe_total_mismatch", blocked_on: { kind: "stripe_invoice" } },
    ])
    expect(needsPerson(ctx.emitted).at(-1).data.reason).toContain("Stripe charged 999.00 EUR")
    const gone = person(db, { invoice: finalized({ status: "void" }) })
    await invoiceFromStripePayment(gone, { stripeInvoiceId: "in_1" })
    await deliver(db, gone)
    expect(parks(db)[0]).toMatchObject({ status: "resolved", reason: "not_open_in_stripe" })
  })

  test("a click on a sale invoiced meanwhile, and a payment linked, close it through the system", async () => {
    for (const way of ["click", "link"]) {
      const db = stripeDb()
      await exhausted(db, noAddress(PAID))
      const doc = await handInvoice(db)
      const ctx = person(db, { invoice: finalized(PAID) })
      if (way === "click") {
        await db.update("documents", doc, { external_ref: "stripe:ch_1" })
        await invoiceFromStripePayment(ctx, { stripeInvoiceId: "in_1" })
      } else await paymentLinkToInvoice(asPerson(ctx), { chargeId: "ch_1", documentId: doc })
      expect(openParks(db)).toHaveLength(1)
      await deliver(db, ctx)
      expect(openParks(db)).toHaveLength(0)
    }
    expect(await onStripeSaleDecided({ data: {} }, stripeCtx(stripeDb()))).toMatchObject({
      status: "skipped",
    })
  })
})

test("the stage-time check of a click writes nothing and names what already invoiced the sale", async () => {
  const db = stripeDb()
  await backlog(db, 2)
  const doc = await handInvoice(db)
  await db.update("documents", doc, { external_ref: "stripe:in_1" })
  const r: Any = await invoiceFromStripePaymentPreflight(stripeCtx(db), { stripeInvoiceId: "in_1" })
  expect(r.error.code).toBe("already_invoiced")
  expect(openParks(db)).toHaveLength(2)
})
