// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH AGENT A CONVERSATION IS WITH, when it is with exactly one.
//
// The runtime control (ThreadRuntimeSlot) and the send path (message-store)
// both ask it: the control to decide whether "This machine" is on offer at all,
// the send path to decide which agent's turn must run on this machine. One
// predicate, in a module with no component in it, so the store can ask without
// importing the control.

import { classifyConversation, soleAgentCounterpart } from "@liaison/shared"

export interface RuntimeSlotParticipant {
  id: string
  name: string
  participantType?: "user" | "agent"
  agentId?: string | null
}

/**
 * THE CLASSIFIER'S OWN PREDICATE, not a restatement of it (P6d-FX7, SK-8):
 * exactly one OTHER seat, and it an agent (`soleAgentCounterpart`,
 * packages/shared). A titled ten person channel with one agent in it is a
 * CHANNEL to the sidebar, and "run this on my machine" belongs to none of the
 * people in it.
 *
 * Null for everything else, including a seat the directory cannot name an
 * agent id for: that is a seat no shell can start a session against.
 */
export function dmAgentSeat(source: {
  threadId: string
  title: string | null
  /** `kernel.threads.type`; absent reads as a plain thread. */
  threadType?: string
  currentUserId: string
  participants: RuntimeSlotParticipant[]
}): { id: string; name: string } | null {
  const facts = {
    title: source.title,
    type: source.threadType ?? "thread",
    discoverable: false,
    participants: source.participants.map((p) => ({
      id: p.id,
      participantType: p.participantType === "agent" ? ("agent" as const) : ("user" as const),
    })),
    currentUserId: source.currentUserId,
  }
  // Only a conversation the sidebar shows as a DM (A35 amended 2026-10-12): a
  // titled channel with one person and one agent is still a channel.
  if (classifyConversation(facts).group !== "dm") return null
  const seat = soleAgentCounterpart(facts)
  if (!seat) return null
  const participant = source.participants.find((p) => p.id === seat.id)
  const agentId = participant?.agentId
  if (!participant || typeof agentId !== "string" || agentId.length === 0) return null
  return { id: agentId, name: participant.name }
}
