// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The refund cards: the pending approval with the refundable remainder, the other ways it can go, and the
// confirm that says what an action does before it does it.
import { describe, expect, it } from "bun:test"
import type { PaymentItem } from "./customers-model"
import { RefundCard } from "./RefundCards"
import { type RefundApproval, refundCardView, refundsOf, retryConfirm } from "./refund-model"

const payment = (over: Partial<PaymentItem> = {}): PaymentItem => ({
  id: "ch_3QOmbre1014",
  customerId: "cus_a",
  invoiceId: "in_1",
  amountMinor: 17880,
  refundedMinor: 0,
  currency: "eur",
  status: "succeeded",
  failureCode: null,
  disputed: false,
  at: "2026-10-14T10:00:00Z",
  card: { brand: "mastercard", last4: "5108", exp: "07/27" },
  ...over,
})
const approval = (over: Partial<RefundApproval> = {}): RefundApproval => ({ id: "ap1", toolName: "stripe:refunds_create", status: "pending", payload: { chargeId: "ch_3QOmbre1014" }, ...over })

describe("refund cards", () => {
  it('"Try again" asks a confirm stating the amount and card', () => {
    const v = refundCardView(approval({ error: "Your Stripe balance is too low to cover it today." }), payment(), "en")
    expect(v.state).toBe("refused")
    const retry = v.actions.find((a) => a.id === "retry")
    expect(retry?.confirm).toBeTruthy()
    expect(retry?.confirm).toContain("€178.80")
    expect(retry?.confirm).toContain("Mastercard 5108")
    expect(retry?.confirm).toBe(retryConfirm("€178.80", "Mastercard 5108, 07/27"))
    // A refused refund names no credit note and says nothing was lost.
    expect(v.note).toContain("Stripe balance")
    expect(typeof RefundCard).toBe("function")
  })

  it("shows the pending approval and what is still refundable", () => {
    const v = refundCardView(approval(), payment({ refundedMinor: 8940 }), "en")
    expect(v.state).toBe("pending")
    expect(v.remainder).toBe("€89.40")
    expect(v.remainderMinor).toBe(8940)
    expect(v.actions.map((a) => a.id)).toEqual(["edit", "approve", "reject"])
    // Edited down to a part: the amount asked is the payload's.
    const part = refundCardView(approval({ payload: { chargeId: "ch_3QOmbre1014", amountMinor: 8940 }, editing: true }), payment(), "en")
    expect(part.state).toBe("editing")
    expect(part.amount).toBe("€89.40")
    expect(part.actions.map((a) => a.id)).toEqual(["approve", "reject"])
  })

  it("a charge already refunded in full offers the credit note, with a confirm that says what it asks", () => {
    const v = refundCardView(approval(), payment({ refundedMinor: 17880 }), "en")
    expect(v.state).toBe("already_refunded")
    expect(v.canApprove).toBe(false)
    const note = v.actions.find((a) => a.id === "credit_note")
    expect(note?.label).toBe("Issue the credit note for it")
    expect(note?.confirm).toContain("€178.80")
    expect(note?.confirm).toContain("nothing is issued until a person approves")
  })

  it("holds Approve while the key is revoked and only matches this customer's charges", () => {
    expect(refundCardView(approval(), payment(), "en", true).canApprove).toBe(false)
    const mine = refundsOf([approval(), approval({ id: "ap2", payload: { chargeId: "ch_other" } }), approval({ id: "ap3", toolName: "stripe:subscription_cancel" })], [payment()])
    expect(mine.map((m) => m.approval.id)).toEqual(["ap1"])
  })
})
