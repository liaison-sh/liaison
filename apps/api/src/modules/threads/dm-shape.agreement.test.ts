// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A35 says the sidebar and the DM shape rule agree. This is the test that
// makes that a fact rather than a sentence: the same fixtures through
// `isDmShapedThread` (the dedupe guard and the push fanout) and through
// `classifyConversation` (the Home sidebar and the phone Home list).
//
// The two answer different questions, so the agreement is scoped and the
// divergences are asserted rather than left to be rediscovered:
//   - AGREE, on a plain human room: title -> channel, no title -> DM.
//   - AGREE, on a titled room whose only other seat is an agent: a CHANNEL to
//     both (2026-10-12, A35 amended). It was a DM to both under the old rule 1
//     ("a title makes a channel unless the only other participant is an
//     agent"), so a channel a user made and seated their agent in took the
//     agent DM's slot and hid the real DM. Only an `agent_chat` (a room made
//     as a DM) is an agent DM now. The push fanout keeps notifying that room's
//     one human on its own terms (fanout-consumer.ts `isDirectRoom`).
//   - DIVERGE, on an `agent_chat`: presentation calls it a DM (it is a 1:1
//     with an agent), the shape rule refuses it because an agent chat is
//     never a dedupe target and its fanout is not "everybody in the room".
//   - DIVERGE, on a pinned or entity anchored room: presentation still has to
//     draw it somewhere, the shape rule refuses it for the same reasons.

import { describe, expect, it } from "bun:test"
import { type ConversationFacts, classifyConversation } from "@liaison/shared"
import { type DmShapeFacts, isDmShapedThread } from "./dm-shape"

const ME = "user-me"

interface Fixture {
  name: string
  shape: DmShapeFacts
  presentation: ConversationFacts
  /** Whether the two rules are expected to give the same verdict. */
  agrees: boolean
}

function plainShape(over: Partial<DmShapeFacts>): DmShapeFacts {
  return {
    type: "thread",
    isPinned: false,
    createdFrom: null,
    humanCount: 2,
    agentCount: 0,
    title: null,
    ...over,
  }
}

function plainPresentation(over: Partial<ConversationFacts>): ConversationFacts {
  return {
    title: null,
    type: "thread",
    discoverable: false,
    participants: [
      { id: ME, participantType: "user" },
      { id: "u2", participantType: "user" },
    ],
    currentUserId: ME,
    ...over,
  }
}

const FIXTURES: Fixture[] = [
  {
    name: "an untitled two person room",
    shape: plainShape({}),
    presentation: plainPresentation({}),
    agrees: true,
  },
  {
    name: "an untitled five person room",
    shape: plainShape({ humanCount: 5 }),
    presentation: plainPresentation({
      participants: ["u2", "u3", "u4", "u5"]
        .map((id) => ({ id, participantType: "user" as const }))
        .concat([{ id: ME, participantType: "user" as const }]),
    }),
    agrees: true,
  },
  {
    name: "a titled private room",
    shape: plainShape({ title: "Q2 Marketing Plan" }),
    presentation: plainPresentation({ title: "Q2 Marketing Plan" }),
    agrees: true,
  },
  {
    name: "a titled discoverable channel",
    shape: plainShape({ title: "General" }),
    presentation: plainPresentation({ title: "General", discoverable: true }),
    agrees: true,
  },
  {
    // 2026-10-12: "s11-cloud-walk", a channel the user made and then seated
    // their Personal agent in. A channel by its title to both rules.
    name: "a titled room whose only other seat is an agent",
    shape: plainShape({ title: "s11-cloud-walk", humanCount: 1, agentCount: 1 }),
    presentation: plainPresentation({
      title: "s11-cloud-walk",
      participants: [
        { id: ME, participantType: "user" },
        { id: "a1", participantType: "agent" },
      ],
    }),
    agrees: true,
  },
  {
    name: "a titled room with a second human in it is a channel to both rules",
    shape: plainShape({ title: "Q2 Marketing Plan", humanCount: 2, agentCount: 1 }),
    presentation: plainPresentation({
      title: "Q2 Marketing Plan",
      participants: [
        { id: ME, participantType: "user" },
        { id: "u2", participantType: "user" },
        { id: "a1", participantType: "agent" },
      ],
    }),
    agrees: true,
  },
  {
    name: "an agent_chat",
    shape: plainShape({ type: "agent_chat", humanCount: 1, agentCount: 1 }),
    presentation: plainPresentation({
      type: "agent_chat",
      participants: [
        { id: ME, participantType: "user" },
        { id: "a1", participantType: "agent" },
      ],
    }),
    agrees: false,
  },
  {
    name: "a pinned workspace room",
    shape: plainShape({ isPinned: true }),
    presentation: plainPresentation({}),
    agrees: false,
  },
  {
    name: "a room anchored to a ticket",
    shape: plainShape({ createdFrom: { app: "tickets", entityType: "ticket", entityId: "t1" } }),
    presentation: plainPresentation({}),
    agrees: false,
  },
]

describe("dm-shape and the sidebar classifier agree on plain human rooms (A35)", () => {
  for (const f of FIXTURES) {
    it(`${f.name}: ${f.agrees ? "both rules agree" : "the documented divergence holds"}`, () => {
      const byShape = isDmShapedThread(f.shape)
      const byPresentation = classifyConversation(f.presentation).group === "dm"
      if (f.agrees) {
        expect(byShape).toBe(byPresentation)
      } else {
        expect(byShape).not.toBe(byPresentation)
      }
    })
  }

  it("a titled room whose only other seat is an agent is a channel to both rules", () => {
    const f = FIXTURES.find((x) => x.name === "a titled room whose only other seat is an agent")
    if (!f) throw new Error("fixture missing")
    expect(isDmShapedThread(f.shape)).toBe(false)
    expect(classifyConversation(f.presentation)).toEqual({
      group: "channel",
      visibility: "private",
    })
  })

  it("no plain human room is a DM to one rule and a channel to the other", () => {
    for (const f of FIXTURES.filter((x) => x.agrees)) {
      expect(isDmShapedThread(f.shape)).toBe(classifyConversation(f.presentation).group === "dm")
    }
  })
})
