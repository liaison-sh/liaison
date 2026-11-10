// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recurring schedule editor: Start stays disabled while the customer is billed through a
// Stripe subscription and nobody said what this schedule bills instead; no invoice number ever
// shows before an invoice issues; the save sends exactly the fields the tools take.
import { afterEach, describe, expect, it } from "bun:test"
import {
  conflictFrom,
  defaultSchedule,
  editorActions,
  nextInvoices,
  NUMBER_LINE,
  ScheduleEditor,
  scheduleParams,
  type ScheduleDraft,
} from "./ScheduleEditor"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

const filled = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...defaultSchedule(),
  issuer_profile_id: "issuer-1",
  contact_id: "contact-1",
  lines: [{ description: "Group plan, {period}", qty: 1, unit_price_minor: 145000, vat_bp: 2000 }],
  ...over,
})

const CONFLICT = {
  status: "error",
  error: { code: "subscription_stream_conflict", message: "This customer pays the live Stripe subscription sub_1 (Group plan), which already invoices them." },
}

describe("the schedule editor", () => {
  it("Start stays disabled during an open conflict", () => {
    const conflict = conflictFrom(CONFLICT)
    expect(conflict).toEqual({ message: CONFLICT.error.message })
    // Not a conflict: any other refusal, or a success.
    expect(conflictFrom({ status: "error", error: { code: "invalid_schedule", message: "x" } })).toBeNull()
    expect(conflictFrom({ status: "completed" })).toBeNull()

    expect(editorActions(filled(), null).startDisabled).toBe(false)
    expect(editorActions(filled(), conflict).startDisabled).toBe(true)
    // Bill something else, with a line too short to say anything, still holds Start.
    expect(editorActions(filled({ billsOtherThanStripe: "abc" }), conflict).startDisabled).toBe(true)
    // What it bills instead, said by the person, lifts it, and the save carries the text.
    const said = filled({ billsOtherThanStripe: "On-site training days" })
    expect(editorActions(said, conflict).startDisabled).toBe(false)
    expect(scheduleParams(said, "active").billsOtherThanStripe).toBe("On-site training days")
    // A schedule without a customer or a line cannot start either.
    expect(editorActions(filled({ contact_id: null }), null).startDisabled).toBe(true)
    expect(editorActions(filled({ lines: [] }), null).startDisabled).toBe(true)
  })

  it("no number shows before issue", () => {
    const next = nextInvoices({ repeats: "month", billing_day: "last" }, "2026-11-10", 3)
    expect(next.map((n) => n.issueOn)).toEqual(["2026-11-30", "2026-12-31", "2027-01-31"])
    for (const n of next) expect(Object.keys(n).sort()).toEqual(["draftOn", "issueOn"])
    expect(NUMBER_LINE).toContain("Taken the moment it issues")
    expect(NUMBER_LINE).not.toMatch(/\d{3,}/)
    expect(typeof ScheduleEditor).toBe("function")
  })

  it("the save sends the fields the tools take, a card link only when paid by card link", () => {
    const p = scheduleParams(filled({ paid_by: "transfer", card_link_url: "https://pay.example/x" }), "active")
    expect(p).toMatchObject({ issuer_profile_id: "issuer-1", contact_id: "contact-1", repeats: "month", billing_day: "last", status: "active" })
    expect("card_link_url" in p).toBe(false)
    expect("billsOtherThanStripe" in p).toBe(false)
    expect(scheduleParams(filled({ paid_by: "card_link", card_link_url: "https://pay.example/x" }), "draft").card_link_url).toBe("https://pay.example/x")
  })
})
