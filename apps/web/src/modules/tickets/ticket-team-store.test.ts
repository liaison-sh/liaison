// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-team-store", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("loadTeams populates the live team set via tickets:teams.list", async () => {
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:teams.list") {
        return [
          { team: "Support EU", openCount: 4, totalCount: 9 },
          { team: "Support US", openCount: 0, totalCount: 2 },
        ]
      }
      return null
    })
    const api = { post } as any
    const { loadTeams, ticketTeamStore } = await import("~/modules/tickets/ticket-team-store")
    await loadTeams(api)
    expect(ticketTeamStore.teams).toHaveLength(2)
    expect(ticketTeamStore.teams[0]).toEqual({ team: "Support EU", openCount: 4, totalCount: 9 })
    expect(ticketTeamStore.loaded).toBe(true)
  })

  it("a desk with no teams loads to an EMPTY list, not an unloaded one", async () => {
    // The distinction drives the UI: `loaded && teams.length === 0` is how the
    // filter bar knows to hide the control rather than show a menu that will
    // never fill in.
    const post = vi.fn().mockResolvedValue([])
    const { loadTeams, ticketTeamStore } = await import("~/modules/tickets/ticket-team-store")
    await loadTeams({ post } as any)
    expect(ticketTeamStore.teams).toEqual([])
    expect(ticketTeamStore.loaded).toBe(true)
  })

  it("a failed call leaves the store unloaded instead of asserting an empty desk", async () => {
    const post = vi.fn().mockRejectedValue(new Error("boom"))
    const { loadTeams, ticketTeamStore } = await import("~/modules/tickets/ticket-team-store")
    await expect(loadTeams({ post } as any)).rejects.toThrow()
    // Claiming "this org has no teams" because a request failed would hide the
    // filter permanently on a transient error.
    expect(ticketTeamStore.loaded).toBe(false)
    expect(ticketTeamStore.loading).toBe(false)
  })

  it("a non-array payload is treated as empty rather than crashing the bar", async () => {
    const post = vi.fn().mockResolvedValue({ error: { code: "nope" } })
    const { loadTeams, ticketTeamStore } = await import("~/modules/tickets/ticket-team-store")
    await loadTeams({ post } as any)
    expect(ticketTeamStore.teams).toEqual([])
  })

  it("a team:rename event renames the row in place and keeps the list sorted", async () => {
    const post = vi.fn().mockResolvedValue([
      { team: "Aardvark", openCount: 1, totalCount: 1 },
      { team: "Old", openCount: 2, totalCount: 5 },
    ])
    const { loadTeams, handleTeamEvent, ticketTeamStore } = await import(
      "~/modules/tickets/ticket-team-store"
    )
    await loadTeams({ post } as any)
    handleTeamEvent("rename", { from: "Old", to: "Zulu" })
    expect(ticketTeamStore.teams.map((t) => t.team)).toEqual(["Aardvark", "Zulu"])
    expect(ticketTeamStore.teams[1]!.openCount).toBe(2)
  })

  it("a rename ONTO an existing team collapses the two rows and sums their counts", async () => {
    const post = vi.fn().mockResolvedValue([
      { team: "Okabé", openCount: 1, totalCount: 3 },
      { team: "SGM - Okabé", openCount: 2, totalCount: 4 },
    ])
    const { loadTeams, handleTeamEvent, ticketTeamStore } = await import(
      "~/modules/tickets/ticket-team-store"
    )
    await loadTeams({ post } as any)
    handleTeamEvent("rename", { from: "Okabé", to: "SGM - Okabé" })
    // Leaving both rows would offer a label that now matches zero tickets.
    expect(ticketTeamStore.teams).toEqual([{ team: "SGM - Okabé", openCount: 3, totalCount: 7 }])
  })

  it("ignores a rename for a team it never loaded", async () => {
    const post = vi.fn().mockResolvedValue([{ team: "Alpha", openCount: 1, totalCount: 1 }])
    const { loadTeams, handleTeamEvent, ticketTeamStore } = await import(
      "~/modules/tickets/ticket-team-store"
    )
    await loadTeams({ post } as any)
    handleTeamEvent("rename", { from: "Ghost", to: "Phantom" })
    expect(ticketTeamStore.teams).toEqual([{ team: "Alpha", openCount: 1, totalCount: 1 }])
  })
})
