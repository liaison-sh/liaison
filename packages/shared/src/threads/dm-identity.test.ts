// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  AGENT_GUEST_SEAT_ROLE,
  conversationIdentitySeats,
  MENTION_SEAT_ORIGIN,
  seatMakesGroupOfDm,
} from "./dm-identity"

describe("seatMakesGroupOfDm (D23a)", () => {
  it("a person's seat never decides it", () => {
    expect(seatMakesGroupOfDm({ participantType: "user" })).toBe(false)
  })

  it("an agent seated by an @mention keeps the DM", () => {
    expect(
      seatMakesGroupOfDm({
        participantType: "agent",
        role: "member",
        seatOrigin: MENTION_SEAT_ORIGIN,
      }),
    ).toBe(false)
  })

  it("a guest agent seat keeps the DM", () => {
    expect(seatMakesGroupOfDm({ participantType: "agent", role: AGENT_GUEST_SEAT_ROLE })).toBe(
      false,
    )
  })

  it("an agent added on purpose (or a legacy seat with no origin) makes it a group", () => {
    expect(seatMakesGroupOfDm({ participantType: "agent", role: "member", seatOrigin: null })).toBe(
      true,
    )
    expect(seatMakesGroupOfDm({ participantType: "agent" })).toBe(true)
  })
})

describe("conversationIdentitySeats (D23a)", () => {
  const me = { id: "me", participantType: "user" as const }
  const alice = { id: "alice", participantType: "user" as const }
  const mention = { id: "ag", participantType: "agent" as const, seatOrigin: MENTION_SEAT_ORIGIN }
  const added = { id: "ag2", participantType: "agent" as const, seatOrigin: null }

  it("drops a mention or guest seat from a room of people", () => {
    expect(conversationIdentitySeats([me, alice, mention]).map((s) => s.id)).toEqual([
      "me",
      "alice",
    ])
    const guest = { id: "g", participantType: "agent" as const, role: AGENT_GUEST_SEAT_ROLE }
    expect(conversationIdentitySeats([me, alice, guest]).map((s) => s.id)).toEqual(["me", "alice"])
  })

  it("keeps an agent added on purpose", () => {
    expect(conversationIdentitySeats([me, alice, added]).map((s) => s.id)).toEqual([
      "me",
      "alice",
      "ag2",
    ])
  })

  it("keeps the agent of a 1:1 with an agent, however it was seated", () => {
    expect(conversationIdentitySeats([me, mention]).map((s) => s.id)).toEqual(["me", "ag"])
  })
})
