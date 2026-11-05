// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-draft-store", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") localStorage.clear()
    vi.resetModules()
  })

  it("[SC15] saveDraft persists per (userId, ticketId, kind) and getDraft retrieves it", async () => {
    const { saveDraft, getDraft, resetTicketDraftStore } = await import(
      "~/modules/tickets/ticket-draft-store"
    )
    resetTicketDraftStore()
    saveDraft("u1", "t1", "reply", "Hello world")
    saveDraft("u2", "t1", "reply", "Other user")
    saveDraft("u1", "t1", "note", "Internal note")
    expect(getDraft("u1", "t1", "reply")).toBe("Hello world")
    expect(getDraft("u2", "t1", "reply")).toBe("Other user")
    expect(getDraft("u1", "t1", "note")).toBe("Internal note")
    expect(localStorage.getItem("tickets.draft.u1.t1.reply")).toContain("Hello world")
  })

  it("clearDraft removes a draft entry", async () => {
    const { saveDraft, clearDraft, getDraft } = await import("~/modules/tickets/ticket-draft-store")
    saveDraft("u1", "t2", "reply", "Body")
    clearDraft("u1", "t2", "reply")
    expect(getDraft("u1", "t2", "reply")).toBe("")
  })

  it("survives reload via localStorage round-trip", async () => {
    const { saveDraft } = await import("~/modules/tickets/ticket-draft-store")
    saveDraft("u1", "t3", "reply", "Persistent")
    vi.resetModules()
    const reloaded = await import("~/modules/tickets/ticket-draft-store")
    expect(reloaded.getDraft("u1", "t3", "reply")).toBe("Persistent")
  })

  it("saveDraftPayload stores rejected approval payload JSON under exact key", async () => {
    const { saveDraftPayload, getDraft } = await import("~/modules/tickets/ticket-draft-store")
    saveDraftPayload("u1", "t4", "reply", {
      textBody: "Rejected body",
      htmlBody: "<p>Rejected body</p>",
      followup: { at: "2026-05-06T10:00", reason: "Check" },
    })
    expect(getDraft("u1", "t4", "reply")).toBe("Rejected body")
    expect(JSON.parse(localStorage.getItem("tickets.draft.u1.t4.reply")!)).toMatchObject({
      textBody: "Rejected body",
      followup: { reason: "Check" },
    })
  })
})
