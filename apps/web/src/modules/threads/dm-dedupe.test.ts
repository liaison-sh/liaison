// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo box listed two "Support Desk" rows and two "Liaison" rows under
// Direct messages, identical in name and avatar. A DM is identified by its
// counterpart, so two rooms with the same counterpart are one conversation
// stored twice and the list must offer exactly one of them.
import { describe, expect, it } from "vitest"
import { dmCounterpartKey, findExistingPeopleDm, visibleDmIds } from "~/modules/threads/dm-dedupe"

function dm(id: string, agentId: string, updatedAt: string, unreadCount = 0) {
  return {
    id,
    updatedAt,
    unreadCount,
    participants: [
      { id: "u1", name: "Owner", avatarUrl: null, participantType: "user" as const, agentId: null },
      {
        id: `seat-${agentId}`,
        name: "Support Desk",
        avatarUrl: null,
        participantType: "agent" as const,
        agentId,
      },
    ],
  }
}

describe("visibleDmIds", () => {
  it("keeps one row per agent counterpart, the most recently active one", () => {
    const rows = [
      dm("seeded", "agent-support", "2026-09-10T10:00:00.000Z"),
      dm("product", "agent-support", "2026-09-16T10:00:00.000Z"),
      dm("liaison-a", "agent-liaison", "2026-09-16T09:00:00.000Z"),
      dm("liaison-b", "agent-liaison", "2026-09-11T09:00:00.000Z"),
    ]
    const keep = visibleDmIds(rows, "u1")
    expect([...keep].sort()).toEqual(["liaison-a", "product"])
  })

  it("is deterministic when two twins carry the same timestamp", () => {
    const rows = [
      dm("bbb", "agent-support", "2026-09-16T10:00:00.000Z"),
      dm("aaa", "agent-support", "2026-09-16T10:00:00.000Z"),
    ]
    expect([...visibleDmIds(rows, "u1")]).toEqual(["aaa"])
    expect([...visibleDmIds([...rows].reverse(), "u1")]).toEqual(["aaa"])
  })

  it("leaves distinct counterparts alone", () => {
    const rows = [
      dm("a", "agent-support", "2026-09-16T10:00:00.000Z"),
      dm("b", "agent-liaison", "2026-09-16T10:00:00.000Z"),
    ]
    expect(visibleDmIds(rows, "u1").size).toBe(2)
  })

  it("never collapses a room that has no counterpart", () => {
    const solo = {
      id: "solo",
      updatedAt: "2026-09-16T10:00:00.000Z",
      unreadCount: 0,
      participants: [
        {
          id: "u1",
          name: "Owner",
          avatarUrl: null,
          participantType: "user" as const,
          agentId: null,
        },
      ],
    }
    const solo2 = { ...solo, id: "solo-2" }
    expect(visibleDmIds([solo, solo2], "u1").size).toBe(2)
    expect(dmCounterpartKey(solo, "u1")).toBeNull()
  })

  it("D23a: a people DM with an agent an @mention seated keys as the DM with that person", () => {
    const person = {
      id: "alice",
      name: "Alice",
      avatarUrl: null,
      participantType: "user" as const,
      agentId: null,
    }
    const me = {
      id: "u1",
      name: "Owner",
      avatarUrl: null,
      participantType: "user" as const,
      agentId: null,
    }
    const bot = {
      id: "bot",
      name: "Data",
      avatarUrl: null,
      participantType: "agent" as const,
      agentId: "bot",
    }
    const base = { updatedAt: "2026-09-16T10:00:00.000Z", unreadCount: 0 }
    const pure = { ...base, id: "pure", participants: [me, person] }
    const mentioned = {
      ...base,
      id: "m",
      participants: [me, person, { ...bot, seatOrigin: "mention" }],
    }
    const added = { ...base, id: "a", participants: [me, person, { ...bot, seatOrigin: null }] }
    expect(dmCounterpartKey(mentioned, "u1")).toEqual(dmCounterpartKey(pure, "u1"))
    expect(dmCounterpartKey(added, "u1")).not.toEqual(dmCounterpartKey(pure, "u1"))
  })

  it("keys an agent DM by the AGENT, not by its seat row", () => {
    const a = dm("a", "agent-support", "2026-09-16T10:00:00.000Z")
    const b = dm("b", "agent-support", "2026-09-15T10:00:00.000Z")
    b.participants[1]!.id = "seat-other-row"
    expect(dmCounterpartKey(a, "u1")).toEqual(dmCounterpartKey(b, "u1"))
  })
})

describe("findExistingPeopleDm", () => {
  const seat = (id: string, type: "user" | "agent" = "user") => ({
    id,
    name: id,
    avatarUrl: null,
    participantType: type,
    agentId: type === "agent" ? id : null,
  })
  const room = (
    id: string,
    people: string[],
    extra: Partial<{ title: string | null; updatedAt: string; createdFrom: unknown }> = {},
  ) => ({
    id,
    title: extra.title ?? null,
    type: "thread" as const,
    createdFrom: (extra.createdFrom ?? null) as never,
    isPinned: false,
    updatedAt: extra.updatedAt ?? "2026-09-16T10:00:00.000Z",
    unreadCount: 0,
    participants: [seat("me"), ...people.map((p) => seat(p))],
  })

  it("finds the DM with exactly these people, in any order", () => {
    const rows = [room("alice", ["alice"]), room("group", ["bob", "alice"])]
    expect(findExistingPeopleDm(rows, "me", ["alice"])?.id).toBe("alice")
    expect(findExistingPeopleDm(rows, "me", ["alice", "bob"])?.id).toBe("group")
  })

  it("does not match a superset, a channel or an entity room", () => {
    const rows = [
      room("group", ["alice", "bob"]),
      room("chan", ["alice"], { title: "eng" }),
      room("ticket", ["alice"], { createdFrom: { app: "tickets" } }),
    ]
    expect(findExistingPeopleDm(rows, "me", ["alice"])).toBeUndefined()
  })

  it("D23: a room that also seats an agent is a group, not the DM, like the API dedupe", () => {
    const withAgent = {
      ...room("a", ["alice"]),
      participants: [...room("a", ["alice"]).participants, seat("bot", "agent")],
    }
    expect(findExistingPeopleDm([withAgent], "me", ["alice"])).toBeUndefined()
    const pure = room("pure", ["alice"], { updatedAt: "2026-09-01T10:00:00.000Z" })
    expect(findExistingPeopleDm([withAgent, pure], "me", ["alice"])?.id).toBe("pure")
  })

  // D23a (2026-10-12): a person's @mention seats the agent for good, and that
  // must not turn their DM into a group: the same rule as the API dedupe
  // (seatMakesGroupOfDm in @liaison/shared).
  it("D23a: an agent seated by an @mention, or a guest seat, keeps the DM", () => {
    const base = room("a", ["alice"])
    const mentioned = {
      ...base,
      participants: [...base.participants, { ...seat("bot", "agent"), seatOrigin: "mention" }],
    }
    expect(findExistingPeopleDm([mentioned], "me", ["alice"])?.id).toBe("a")
    const guest = {
      ...room("g", ["alice"]),
      participants: [...base.participants, { ...seat("bot", "agent"), role: "guest" }],
    }
    expect(findExistingPeopleDm([guest], "me", ["alice"])?.id).toBe("g")
    // An agent added on purpose still makes it a group.
    const added = {
      ...room("x", ["alice"]),
      participants: [...base.participants, { ...seat("bot", "agent"), seatOrigin: null }],
    }
    expect(findExistingPeopleDm([added], "me", ["alice"])).toBeUndefined()
  })

  it("prefers the most recently active twin", () => {
    const rows = [
      room("old", ["alice"], { updatedAt: "2026-09-01T10:00:00.000Z" }),
      room("new", ["alice"], { updatedAt: "2026-09-20T10:00:00.000Z" }),
    ]
    expect(findExistingPeopleDm(rows, "me", ["alice"])?.id).toBe("new")
  })
})
