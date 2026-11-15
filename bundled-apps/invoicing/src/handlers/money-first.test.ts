// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Money first: a card payment from the customer of a billing plan whose advance has no invoice
// yet gives one Home line asking which it is. Draft the advance invoice, or not an advance (issue
// or link it as any unmatched payment). Neither answer issues anything by itself, and either takes
// the line down.
import { describe, expect, test } from "bun:test"
import manifest from "../../app.manifest.json"
import { harness, PROJECT, QUOTE, withPlan } from "../__tests__/billing-plan-fixtures"
import { advanceDraftCreate } from "../mutations/advances"
import { billingPlanGet } from "../mutations/billing-plan"
import type { StripeCtx } from "./stripe-invoice-finalized"
import { CONTACT, finalized, invoices, parks, stripeCtx, stripeDb } from "./stripe-money.testkit"
import { invoiceFromStripePayment, onStripePaymentUnmatched } from "./stripe-payment-unmatched"

type Row = Record<string, unknown>

const payment = (id: string, contactId: string | null = CONTACT) => ({
  charge_id: id,
  contact_id: contactId,
  amount_minor: "1536000",
  currency: "eur",
  created: "2026-11-12",
  customer: finalized().customer,
})

const translation = (
  manifest.attention as unknown as { translations: Array<Row & { event: string }> }
).translations.find((t) => t.event === "stripe_payment:advance_received")

/** A plan's advance waiting on CONTACT's quote, in a Stripe-connected org. */
async function waitingAdvance(db: ReturnType<typeof stripeDb>) {
  const quote = crypto.randomUUID()
  await db.insert("documents", {
    id: quote,
    type: "quote",
    status: "accepted",
    currency: "EUR",
    counterparty_contact_id: CONTACT,
  })
  const step = crypto.randomUUID()
  await db.insert("billing_steps", {
    id: step,
    billing_project_id: PROJECT,
    position: 1,
    kind: "advance",
    label: "Advance 20%",
    amount_minor: 1_280_000n,
    currency: "EUR",
    quote_document_id: quote,
    state: "planned",
  })
  return step
}

describe("money received before any invoice", () => {
  test("money received gives one line with its two answers and issues nothing", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    const step = await waitingAdvance(db)
    await onStripePaymentUnmatched(payment("ch_adv"), ctx)
    expect(ctx.emitted.map((e) => `${e.entity}:${e.action}`)).toEqual([
      "stripe_payment:advance_received",
    ])
    expect(ctx.emitted[0]?.entityId).toBe("ch_adv")
    expect(ctx.emitted[0]?.data).toMatchObject({
      step_id: step,
      project_id: PROJECT,
      received_on: "2026-11-12",
      resolved: false,
    })
    expect(String(translation?.summary)).toContain("Draft the advance invoice")
    expect(String(translation?.summary)).toContain("not an advance")
    expect(translation?.resolveWhen).toEqual({ field: "resolved", equals: true })
    // Nothing issued, nothing drafted.
    expect(invoices(db)).toHaveLength(0)
    expect(db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(0)

    // Not an advance: invoiced as any unmatched payment, by a person; the line goes with its park.
    const r = await invoiceFromStripePayment(
      {
        ...ctx,
        approval: {
          approvalRequestId: "a1",
          approvalDeciderId: "u1",
          toolName: "invoicing:invoice_from_stripe_payment",
        },
      },
      { chargeId: "ch_adv", vatRateBp: 2000 },
    )
    expect(r).toMatchObject({ status: "completed" })
    expect(ctx.emitted.at(-1)).toMatchObject({
      entity: "stripe_payment",
      action: "advance_received",
      entityId: "ch_adv",
      data: { resolved: true },
    })
  })

  test("a payment from a customer with no waiting advance keeps the unmatched line, and it goes once invoiced", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await waitingAdvance(db)
    await onStripePaymentUnmatched(payment("ch_other", null), ctx)
    expect(ctx.emitted.map((e) => e.action)).toEqual(["unmatched"])
    await invoiceFromStripePayment(
      {
        ...ctx,
        approval: {
          approvalRequestId: "a2",
          approvalDeciderId: "u1",
          toolName: "invoicing:invoice_from_stripe_payment",
        },
      },
      { chargeId: "ch_other", vatRateBp: 2000 },
    )
    expect(ctx.emitted.at(-1)).toMatchObject({ action: "unmatched", data: { resolved: true } })
  })

  test("drafting the advance answers the line and takes no number", async () => {
    const h = harness()
    await withPlan(h)
    await h.db.update("documents", QUOTE, { counterparty_contact_id: CONTACT })
    await h.db.insert("stripe_streams", {
      id: "st-1",
      issuer_profile_id: "iss-1",
      issuer: "liaison",
      stripe_connected: true,
      created_at: "2026-01-01",
    })
    const emitted: Row[] = []
    const ctx = { ...h.ctx, emit: async (e: Row) => void emitted.push(e) }
    await onStripePaymentUnmatched(payment("ch_plan"), ctx as unknown as StripeCtx)
    expect(emitted.map((e) => e.action)).toEqual(["advance_received"])

    const plan = await billingPlanGet(h.ctx, { projectId: PROJECT })
    if (plan.status !== "completed") throw new Error("no plan")
    const step = plan.steps.find((s) => s.kind === "advance") as { id: string }
    const res = await advanceDraftCreate(ctx as typeof h.ctx, {
      projectId: PROJECT,
      stepId: step.id,
      receivedOn: "2026-11-12",
    })
    expect(res.status).toBe("completed")
    expect(parks(h.db).every((p) => p.status === "resolved")).toBe(true)
    expect(emitted.filter((e) => e.action === "advance_received").at(-1)).toMatchObject({
      entityId: "ch_plan",
      data: { resolved: true },
    })
    // A draft, no number; its issue approval is the project's one item now.
    const drafts = h.db.__all("documents").filter((d) => d.invoice_role === "advance")
    expect(drafts.map((d) => [d.status, d.number ?? null])).toEqual([["draft", null]])
    expect(h.approvals).toHaveLength(1)
  })
})
