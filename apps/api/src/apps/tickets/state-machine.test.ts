// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { type CurrentTicketState, validateTransition } from "./state-machine"

const baseOpen: CurrentTicketState = {
  status: "open",
  closedReason: null,
  mergedIntoTicketId: null,
  convertedToMailConversationId: null,
  firstResponseAt: null,
}

describe("state machine 7.2 transitions", () => {
  it("inbound on awaiting_followup → status=open + emit reopened + slaAction=resume", () => {
    const r = validateTransition({ ...baseOpen, status: "awaiting_followup" }, { kind: "inbound" })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.effects).toMatchObject({
        status: "open",
        emit: ["status", "reopened"],
        slaAction: "resume",
      })
  })

  it("inbound on non-terminal closed (resolved) → reopen", () => {
    const r = validateTransition(
      { ...baseOpen, status: "closed", closedReason: "resolved" },
      { kind: "inbound" },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.effects.emit).toContain("reopened")
  })

  it("inbound on already-open ticket → status only, no reopened", () => {
    const r = validateTransition(baseOpen, { kind: "inbound" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects.emit).toEqual(["status"])
      expect(r.effects.slaAction).toBe("none")
    }
  })

  it("inbound on merged ticket rejected with merged_ticket", () => {
    const r = validateTransition({ ...baseOpen, mergedIntoTicketId: "X" }, { kind: "inbound" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("merged_ticket")
  })

  it("inbound on converted ticket rejected with converted_ticket", () => {
    const r = validateTransition(
      { ...baseOpen, convertedToMailConversationId: "X" },
      { kind: "inbound" },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("converted_ticket")
  })

  it("inbound on terminally-closed (merged) is rejected", () => {
    const r = validateTransition(
      { ...baseOpen, status: "closed", closedReason: "merged" },
      { kind: "inbound" },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("invalid_transition")
  })

  it("inbound when first_response_at already set → no slaAction resume", () => {
    const r = validateTransition(
      {
        ...baseOpen,
        status: "awaiting_customer",
        firstResponseAt: new Date().toISOString(),
      },
      { kind: "inbound" },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.effects.slaAction).toBe("none")
  })

  it("inbound on awaiting_customer → status only, no reopened", () => {
    const r = validateTransition(
      {
        ...baseOpen,
        status: "awaiting_customer",
      },
      { kind: "inbound" },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects.status).toBe("open")
      expect(r.effects.emit).toEqual(["status"])
    }
  })

  it("close on open → status=closed + closed_reason set + slaAction=satisfy when first_response is null", () => {
    const r = validateTransition(baseOpen, { kind: "close", closedReason: "resolved" })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.effects).toMatchObject({
        status: "closed",
        closedReason: "resolved",
        slaAction: "satisfy",
      })
  })

  it("close already-closed → invalid_transition", () => {
    const r = validateTransition(
      { ...baseOpen, status: "closed", closedReason: "resolved" },
      { kind: "close", closedReason: "resolved" },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("invalid_transition")
  })

  it("nudge → no status change; emit empty", () => {
    const r = validateTransition({ ...baseOpen, status: "awaiting_customer" }, { kind: "nudge" })
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.effects).toMatchObject({
        status: "awaiting_customer",
        slaAction: "none",
        emit: [],
      })
  })

  it("reply satisfies first response, hands open ticket to the customer, emits status hook", () => {
    const r = validateTransition(baseOpen, { kind: "reply" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects.status).toBe("awaiting_customer")
      expect(r.effects.slaAction).toBe("satisfy")
      expect(r.effects.emit).toEqual(["status"])
    }
  })

  it("reply preserves awaiting_followup (scheduled follow-up survives a synced reply)", () => {
    const r = validateTransition({ ...baseOpen, status: "awaiting_followup" }, { kind: "reply" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.effects.status).toBe("awaiting_followup")
  })

  it("reply does not satisfy SLA after first response", () => {
    const r = validateTransition(
      { ...baseOpen, firstResponseAt: new Date().toISOString() },
      { kind: "reply" },
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.effects.slaAction).toBe("none")
  })

  it("convertToMail from open transitions to closed with closed_reason=converted_to_mail", () => {
    const mailConversationId = "11111111-1111-1111-1111-111111111111"
    const r = validateTransition(baseOpen, { kind: "convertToMail", mailConversationId })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects.status).toBe("closed")
      expect(r.effects.closedReason).toBe("converted_to_mail")
      expect(r.effects.convertedToMailConversationId).toBe(mailConversationId)
      expect(r.effects.emit).toEqual(["status", "converted"])
      expect(r.effects.slaAction).toBe("pause")
    }
  })

  it("convertToMail rejects merged ticket", () => {
    const r = validateTransition(
      { ...baseOpen, mergedIntoTicketId: "ffffffff-ffff-ffff-ffff-ffffffffffff" },
      { kind: "convertToMail", mailConversationId: "11111111-1111-1111-1111-111111111111" },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("merged_ticket")
  })

  it("convertToMail on already-converted ticket is idempotent (returns ok with no events)", () => {
    const same = "11111111-1111-1111-1111-111111111111"
    const r = validateTransition(
      {
        ...baseOpen,
        status: "closed",
        closedReason: "converted_to_mail",
        convertedToMailConversationId: same,
      },
      { kind: "convertToMail", mailConversationId: same },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects.emit).toEqual([])
      expect(r.effects.convertedToMailConversationId).toBe(same)
    }
  })

  it("convertToMail rejects when ticket already converted to a different mail conversation", () => {
    const r = validateTransition(
      {
        ...baseOpen,
        status: "closed",
        closedReason: "converted_to_mail",
        convertedToMailConversationId: "22222222-2222-2222-2222-222222222222",
      },
      { kind: "convertToMail", mailConversationId: "11111111-1111-1111-1111-111111111111" },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("converted_ticket")
  })

  it("setStatus to open on a non terminally closed ticket reopens instead of failing", () => {
    const r = validateTransition(
      { ...baseOpen, status: "closed", closedReason: "resolved" },
      { kind: "setStatus", intended: "open" },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects).toMatchObject({
        status: "open",
        closedReason: null,
        followupAt: null,
        followupReason: null,
        followupTrigger: null,
        emit: ["reopened"],
        timelineActionLabel: "manual_reopen",
      })
    }
  })

  it("setStatus to open on a terminally closed (merged) ticket still fails", () => {
    const r = validateTransition(
      { ...baseOpen, status: "closed", closedReason: "merged", mergedIntoTicketId: "t-target" },
      { kind: "setStatus", intended: "open" },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("invalid_transition")
  })

  it("inbound on a closed ticket that still carries a followup clears followup_at", () => {
    const r = validateTransition(
      { ...baseOpen, status: "closed", closedReason: "resolved" },
      { kind: "inbound" },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects.followupAt).toBe(null)
      expect(r.effects.followupReason).toBe(null)
      expect(r.effects.followupTrigger).toBe(null)
    }
  })

  it("reopen clears a scheduled followup", () => {
    const r = validateTransition(
      { ...baseOpen, status: "closed", closedReason: "resolved" },
      { kind: "reopen" },
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.effects.followupAt).toBe(null)
      expect(r.effects.followupReason).toBe(null)
      expect(r.effects.followupTrigger).toBe(null)
    }
  })
})
