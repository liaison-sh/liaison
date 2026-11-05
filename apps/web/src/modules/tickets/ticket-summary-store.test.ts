// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-summary-store", () => {
  beforeEach(() => {
    vi.resetModules()
    localStorage.clear()
  })

  it("summaries are COLLAPSED by default; toggleSummary expands and re-collapses", async () => {
    const { toggleSummary, isCollapsed, resetTicketSummaryStore } = await import(
      "~/modules/tickets/ticket-summary-store"
    )
    resetTicketSummaryStore()
    expect(isCollapsed("t1")).toBe(true)
    toggleSummary("t1")
    expect(isCollapsed("t1")).toBe(false)
    toggleSummary("t1")
    expect(isCollapsed("t1")).toBe(true)
  })

  it("handleTicketSummaryEvent reflects backend status into the store", async () => {
    const { handleTicketSummaryEvent, ticketSummaryStore, resetTicketSummaryStore } = await import(
      "~/modules/tickets/ticket-summary-store"
    )
    resetTicketSummaryStore()
    handleTicketSummaryEvent({
      ticketId: "t9",
      status: "generating",
      error: null,
    })
    expect(ticketSummaryStore.statusByTicketId.t9).toBe("generating")
    handleTicketSummaryEvent({
      ticketId: "t9",
      status: "error",
      error: "boom",
    })
    expect(ticketSummaryStore.statusByTicketId.t9).toBe("error")
  })

  it("persists collapsed state under a user-scoped LRU key", async () => {
    const { toggleSummary, isCollapsed, resetTicketSummaryStore } = await import(
      "~/modules/tickets/ticket-summary-store"
    )
    resetTicketSummaryStore()
    toggleSummary("t1")
    expect(isCollapsed("t1")).toBe(false)
    expect(localStorage.getItem("tickets.summaryCollapsed.anonymous")).toContain("t1")

    resetTicketSummaryStore()
    expect(isCollapsed("t1")).toBe(false)
  })

  it("caps persisted collapse entries at 200", async () => {
    const { toggleSummary, resetTicketSummaryStore } = await import(
      "~/modules/tickets/ticket-summary-store"
    )
    resetTicketSummaryStore()
    for (let i = 0; i < 205; i++) toggleSummary(`t${i}`)
    const raw = localStorage.getItem("tickets.summaryCollapsed.anonymous")
    expect(Object.keys(JSON.parse(raw ?? "{}"))).toHaveLength(200)
  })
})
