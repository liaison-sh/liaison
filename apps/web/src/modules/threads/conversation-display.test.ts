// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  conversationDisplayName,
  conversationKind,
  type DisplayableConversation,
  isPersonToPersonConversation,
  resolvedParticipants,
} from "~/modules/threads/conversation-display"

const me = { id: "me", name: "Me", avatarUrl: null, participantType: "user" as const }
const alice = { id: "alice", name: "Alice", avatarUrl: null, participantType: "user" as const }
const bob = { id: "bob", name: "Bob", avatarUrl: null, participantType: "user" as const }
const agent = { id: "ag", name: "Data", avatarUrl: null, participantType: "agent" as const }

function room(over: Partial<DisplayableConversation>): DisplayableConversation {
  return { title: null, type: "thread", discoverable: false, participants: [me, alice], ...over }
}

describe("isPersonToPersonConversation", () => {
  it("a DM with a colleague is person to person, with or without an invoked agent", () => {
    expect(isPersonToPersonConversation(room({}), "me")).toBe(true)
    expect(isPersonToPersonConversation(room({ participants: [me, alice, agent] }), "me")).toBe(
      true,
    )
    expect(
      isPersonToPersonConversation(room({ participants: [me, alice, bob, agent] }), "me"),
    ).toBe(true)
  })

  it("an agent chat is not, whoever sits in it", () => {
    expect(isPersonToPersonConversation(room({ type: "agent_chat" }), "me")).toBe(false)
    expect(
      isPersonToPersonConversation(
        room({ type: "agent_chat", participants: [me, alice, agent] }),
        "me",
      ),
    ).toBe(false)
  })

  it("a 1:1 with an agent is not, even untitled", () => {
    expect(isPersonToPersonConversation(room({ participants: [me, agent] }), "me")).toBe(false)
  })

  it("a channel is not, public or private", () => {
    expect(
      isPersonToPersonConversation(
        room({ title: "Engineering", participants: [me, alice, agent] }),
        "me",
      ),
    ).toBe(false)
    expect(isPersonToPersonConversation(room({ title: "Eng", discoverable: true }), "me")).toBe(
      false,
    )
  })

  it("an untitled room with only agents besides me is not", () => {
    const agent2 = { ...agent, id: "ag2", name: "Finance" }
    expect(isPersonToPersonConversation(room({ participants: [me, agent, agent2] }), "me")).toBe(
      false,
    )
  })
})

// D23a (2026-10-12): a people DM in which someone @mentioned an agent is still
// the DM with that person, so every list names it after the person, as the DM
// lookup (findExistingPeopleDm, createThread) treats it. The same shared rule
// (conversationIdentitySeats in @liaison/shared) decides both.
describe("D23a: a DM with an agent seated by an @mention", () => {
  const mentioned = { ...agent, agentId: "ag", seatOrigin: "mention" }
  const added = { ...agent, agentId: "ag", seatOrigin: null }

  it("is named and marked after the other person, not 'Alice, Data'", () => {
    const dm = room({ participants: [me, alice, mentioned] })
    expect(conversationDisplayName(dm, "me")).toBe("Alice")
    expect(conversationKind(dm, "me")).toEqual({ group: "dm", namedBy: "people" })
    expect(resolvedParticipants(dm).map((p) => p.id)).toEqual(["me", "alice"])
  })

  it("an agent added on purpose still names the group", () => {
    const group = room({ participants: [me, alice, added] })
    expect(conversationDisplayName(group, "me")).toBe("Alice, Data")
  })

  it("a guest seat is not part of the name either", () => {
    const dm = room({ participants: [me, alice, { ...agent, agentId: "ag", role: "guest" }] })
    expect(conversationDisplayName(dm, "me")).toBe("Alice")
  })

  it("a 1:1 agent DM keeps its agent even if the seat came from a mention", () => {
    const solo = room({ participants: [me, mentioned] })
    expect(resolvedParticipants(solo).map((p) => p.id)).toEqual(["me", "ag"])
  })
})
