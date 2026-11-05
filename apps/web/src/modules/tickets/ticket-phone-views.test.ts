// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T10. The chip row and the row pills, pinned as derivations.
import { describe, expect, it } from "vitest"
import {
  SLA_RISK_WINDOW_MS,
  TICKET_PHONE_VIEWS,
  TICKET_PILL_LABEL_KEY,
  TICKET_SLA_LABEL_KEY,
  ticketPhonePills,
  ticketSlaState,
  ticketViewChips,
} from "~/modules/tickets/ticket-phone-views"

const NOW = Date.parse("2026-09-15T12:00:00.000Z")
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe("ticketViewChips", () => {
  it("offers one chip per saved view the store knows", () => {
    const chips = ticketViewChips({})
    expect(chips.map((c) => c.id)).toEqual(TICKET_PHONE_VIEWS.map((v) => v.id))
  })

  it("carries the store's count for each counted view", () => {
    const chips = ticketViewChips({
      "needs-attention": 4,
      "awaiting-customer": 0,
      closed: 31,
      "all-open": 61,
    })
    const byId = Object.fromEntries(chips.map((c) => [c.id, c.count]))
    expect(byId["needs-attention"]).toBe(4)
    expect(byId["awaiting-customer"]).toBe(0)
    expect(byId.closed).toBe(31)
    // `all-open` is the open count of the view, the same number the desktop
    // sidebar shows, never an unread total.
    expect(byId["all-open"]).toBe(61)
  })

  it("leaves a view the store has not counted without a number", () => {
    const chips = ticketViewChips({ closed: 2 })
    const byId = Object.fromEntries(chips.map((c) => [c.id, c.count]))
    expect(byId["follow-ups"]).toBeUndefined()
    expect(byId["all-open"]).toBeUndefined()
    expect(byId.closed).toBe(2)
  })
})

describe("ticketPhonePills", () => {
  const base = {
    status: "open",
    firstResponseAt: null,
    slaDeadline: null,
    lastInboundAt: null,
    lastOutboundAt: null,
  }

  it("flags SLA risk only while the deadline is inside the window and unanswered", () => {
    expect(
      ticketPhonePills(
        { ...base, slaDeadline: iso(SLA_RISK_WINDOW_MS - 60_000) },
        { hasAgentDraft: false, now: NOW },
      ),
    ).toContain("sla")
    expect(
      ticketPhonePills(
        { ...base, slaDeadline: iso(SLA_RISK_WINDOW_MS + 60_000) },
        { hasAgentDraft: false, now: NOW },
      ),
    ).not.toContain("sla")
    // Already answered: the clock stopped, so the row is not at risk.
    expect(
      ticketPhonePills(
        { ...base, slaDeadline: iso(-5_000), firstResponseAt: iso(-60_000) },
        { hasAgentDraft: false, now: NOW },
      ),
    ).not.toContain("sla")
  })

  it("says waiting on us when the customer wrote last", () => {
    expect(
      ticketPhonePills(
        { ...base, lastInboundAt: iso(-60_000), lastOutboundAt: iso(-600_000) },
        { hasAgentDraft: false, now: NOW },
      ),
    ).toContain("waiting")
    expect(
      ticketPhonePills(
        { ...base, lastInboundAt: iso(-600_000), lastOutboundAt: iso(-60_000) },
        { hasAgentDraft: false, now: NOW },
      ),
    ).not.toContain("waiting")
  })

  it("says draft ready only when an agent draft exists", () => {
    expect(ticketPhonePills(base, { hasAgentDraft: true, now: NOW })).toContain("draft")
    expect(ticketPhonePills(base, { hasAgentDraft: false, now: NOW })).not.toContain("draft")
  })

  it("says replied while the ball is in the customer's court", () => {
    expect(
      ticketPhonePills(
        { ...base, status: "awaiting_customer" },
        { hasAgentDraft: false, now: NOW },
      ),
    ).toEqual(["replied"])
  })

  it("carries every state that holds at once, costliest first", () => {
    expect(
      ticketPhonePills(
        {
          status: "open",
          firstResponseAt: null,
          slaDeadline: iso(10 * 60_000),
          lastInboundAt: iso(-60_000),
          lastOutboundAt: null,
        },
        { hasAgentDraft: true, now: NOW },
      ),
    ).toEqual(["sla", "waiting", "draft"])
  })
})

// The desktop row said "SLA breached" while the phone card said "Risque SLA"
// for the same ticket. One state, one set of words, on both.
describe("one SLA vocabulary", () => {
  const NOW_MS = Date.parse("2026-09-22T12:00:00Z")
  const at = (ms: number) => new Date(NOW_MS + ms).toISOString()

  it("a passed deadline is breached, a close one is at risk, an answered one is neither", () => {
    expect(ticketSlaState({ slaDeadline: at(-60_000) }, NOW_MS)).toBe("breached")
    expect(ticketSlaState({ slaDeadline: at(10 * 60_000) }, NOW_MS)).toBe("approaching")
    expect(ticketSlaState({ slaDeadline: at(3 * 3_600_000) }, NOW_MS)).toBeNull()
    expect(
      ticketSlaState({ slaDeadline: at(-60_000), firstResponseAt: at(-120_000) }, NOW_MS),
    ).toBeNull()
    expect(ticketSlaState({ slaBreachedAt: at(-5_000) }, NOW_MS)).toBe("breached")
  })

  it("the phone's sla pill and the desktop chip share their label keys", () => {
    expect(TICKET_SLA_LABEL_KEY.breached).toBe("kernel.ticketsSlaBreached")
    expect(TICKET_SLA_LABEL_KEY.approaching).toBe(TICKET_PILL_LABEL_KEY.sla)
  })
})
