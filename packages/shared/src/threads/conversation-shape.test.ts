// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type ConversationFacts,
  type ConversationKind,
  classifyConversation,
  isChannelShape,
  isDirectMessageShape,
  soleAgentCounterpart,
} from "./conversation-shape"

const ME = "user-me"

function facts(over: Partial<ConversationFacts>): ConversationFacts {
  return {
    title: null,
    type: "thread",
    discoverable: false,
    participants: [{ id: ME, participantType: "user" }],
    currentUserId: ME,
    ...over,
  }
}

const human = (id: string): { id: string; participantType: "user" } => ({
  id,
  participantType: "user",
})
const agent = (id: string): { id: string; participantType: "agent" } => ({
  id,
  participantType: "agent",
})

/** The fixture set the sidebar, the phone Home list and the DM shape all
 *  answer the same way. One row per rule in A35 plus the mock's refinement. */
const FIXTURES: Array<{ name: string; facts: ConversationFacts; kind: ConversationKind }> = [
  {
    name: "a titled discoverable room is a public channel",
    facts: facts({
      title: "General",
      discoverable: true,
      participants: [human(ME), human("u2")],
    }),
    kind: { group: "channel", visibility: "public" },
  },
  {
    name: "a titled non discoverable room is a private channel",
    facts: facts({
      title: "Q2 Marketing Plan",
      discoverable: false,
      participants: [human(ME), human("u2"), human("u3")],
    }),
    kind: { group: "channel", visibility: "private" },
  },
  {
    name: "an untitled room of people is a DM named by its people",
    facts: facts({ participants: [human(ME), human("u2"), human("u3")] }),
    kind: { group: "dm", namedBy: "people" },
  },
  {
    name: "an untitled 1:1 with a person is a DM named by its people",
    facts: facts({ participants: [human(ME), human("u2")] }),
    kind: { group: "dm", namedBy: "people" },
  },
  {
    name: "an untitled 1:1 with an agent is a DM named by the agent",
    facts: facts({ participants: [human(ME), agent("a1")] }),
    kind: { group: "dm", namedBy: "agent" },
  },
  {
    // Walk on demo (2026-10-12): "s11-cloud-walk", a channel the user created
    // and then seated their Personal agent in, read as the "Personal agent" DM
    // and, deduped by counterpart, hid the real one. A room created as a
    // channel (a title on a plain thread) stays a channel by its title,
    // whatever its membership; only a room created as a DM is a DM.
    name: "a TITLED room whose only other seat is an agent is a channel by its title",
    facts: facts({ title: "s11-cloud-walk", participants: [human(ME), agent("a1")] }),
    kind: { group: "channel", visibility: "private" },
  },
  {
    name: "a titled discoverable room whose only other seat is an agent is a public channel",
    facts: facts({
      title: "d20-routine-walk",
      discoverable: true,
      participants: [human(ME), agent("a1")],
    }),
    kind: { group: "channel", visibility: "public" },
  },
  {
    name: "an agent_chat is a DM whatever its title says",
    facts: facts({
      title: "Local session walk",
      type: "agent_chat",
      participants: [human(ME), agent("a1")],
    }),
    kind: { group: "dm", namedBy: "agent" },
  },
  {
    name: "a titled room with several agents and people is a channel, not an agent DM",
    facts: facts({
      title: "Release checklist",
      participants: [human(ME), human("u2"), agent("a1"), agent("a2")],
    }),
    kind: { group: "channel", visibility: "private" },
  },
  {
    // Walk on demo (2026-10-12, S27/S31): a routine that hands work to @support
    // seats that agent in its output thread, which then read as a DM with
    // "Support Desk" (header, tab, Direct messages) and, deduped by counterpart,
    // hid the owner's real Support Desk DM.
    name: "a routine's output thread is a channel by its title even with one agent seated",
    facts: facts({
      title: "walk-s27-handoff",
      type: "routine",
      participants: [human(ME), agent("a1")],
    }),
    kind: { group: "channel", visibility: "private" },
  },
  {
    name: "an untitled room with two agents is named by its people, not by one agent",
    facts: facts({ participants: [human(ME), agent("a1"), agent("a2")] }),
    kind: { group: "dm", namedBy: "people" },
  },
]

describe("classifyConversation fixture set (A35)", () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      expect(classifyConversation(f.facts)).toEqual(f.kind)
    })
  }

  it("isChannelShape and isDirectMessageShape partition every fixture", () => {
    for (const f of FIXTURES) {
      expect(isChannelShape(f.facts)).toBe(f.kind.group === "channel")
      expect(isDirectMessageShape(f.facts)).toBe(f.kind.group === "dm")
    }
  })

  it("a discoverable room the viewer has not joined still classifies from its seats", () => {
    // The viewer is in none of the seats, so "the others" is everybody.
    const f = facts({
      title: "Growth",
      discoverable: true,
      participants: [human("u2"), human("u3")],
    })
    expect(classifyConversation(f)).toEqual({ group: "channel", visibility: "public" })
  })

  it("a room of one agent the viewer is not seated in is an agent DM", () => {
    const f = facts({ currentUserId: ME, participants: [agent("a1")] })
    expect(soleAgentCounterpart(f)?.id).toBe("a1")
    expect(classifyConversation(f)).toEqual({ group: "dm", namedBy: "agent" })
  })

  it("a room with only the viewer in it is a DM, never a channel", () => {
    expect(classifyConversation(facts({}))).toEqual({ group: "dm", namedBy: "people" })
  })
})
