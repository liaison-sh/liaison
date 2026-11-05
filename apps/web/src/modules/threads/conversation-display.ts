// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a conversation is GROUPED and NAMED, for every surface that lists them:
// the Home sidebar and the Home landing list (the phone tier's conversation
// list) both read from here, so the two can never disagree about whether
// "Q2 Marketing Plan" is a channel or about what an agent DM is called.
//
// The rule itself lives in `@liaison/shared` (`classifyConversation`), shared
// with the API's DM shape so A35 is one rule and not two. This file is the
// thin web-side adapter: it resolves agent seats through the live agent
// directory first, so an agent DM is named by the agent's CURRENT name rather
// than by whatever the thread row froze at creation.

import {
  type ConversationFacts,
  type ConversationKind,
  classifyConversation,
  conversationIdentitySeats,
  otherSeats,
  soleAgentCounterpart,
} from "@liaison/shared"
import { resolveParticipantDisplay } from "~/modules/threads/agent-directory"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { threadDisplayName } from "~/modules/threads/thread-store"

/** The minimum a row has to carry to be classified and named. */
export interface DisplayableConversation {
  title: string | null
  type?: string
  discoverable?: boolean
  participants: Array<{
    id: string
    name: string
    avatarUrl: string | null
    participantType?: "user" | "agent"
    agentId?: string | null
    role?: string
    seatOrigin?: string | null
  }>
}

export type ResolvedParticipant = ReturnType<typeof resolveParticipantDisplay>

/**
 * The seats that name and mark the row, with agent names and avatars resolved
 * from the live directory. D23a: an agent an @mention seated in a people DM is
 * not one of them (conversationIdentitySeats, the rule the DM lookup applies),
 * so the DM with Alice reads "Alice" on every list, not "Alice, Data".
 */
export function resolvedParticipants(thread: DisplayableConversation): ResolvedParticipant[] {
  return conversationIdentitySeats(
    thread.participants.map((p) => ({
      ...p,
      participantType: p.participantType === "agent" ? ("agent" as const) : ("user" as const),
    })),
  ).map(resolveParticipantDisplay)
}

export function conversationFacts(
  thread: DisplayableConversation,
  currentUserId: string,
): ConversationFacts {
  return {
    title: thread.title,
    type: thread.type ?? "thread",
    discoverable: thread.discoverable ?? false,
    participants: resolvedParticipants(thread).map((p) => ({
      id: p.id,
      participantType: p.participantType === "agent" ? "agent" : "user",
    })),
    currentUserId,
  }
}

export function conversationKind(
  thread: DisplayableConversation,
  currentUserId: string,
): ConversationKind {
  return classifyConversation(conversationFacts(thread, currentUserId))
}

export function isChannel(thread: DisplayableConversation, currentUserId: string): boolean {
  return conversationKind(thread, currentUserId).group === "channel"
}

/**
 * A conversation between PEOPLE: a DM or group DM with at least one other
 * human in it, which is neither a channel nor an agent chat. An agent invoked
 * into it is a guest, not the counterpart, so the conversation's model choice
 * lives in its actions menu ("Invoked model") instead of on the composer,
 * where a model pill made a chat with a colleague read like a chat with a bot.
 */
export function isPersonToPersonConversation(
  thread: DisplayableConversation,
  currentUserId: string,
): boolean {
  if (thread.type === "agent_chat") return false
  const kind = conversationKind(thread, currentUserId)
  if (kind.group !== "dm" || kind.namedBy !== "people") return false
  return otherSeats(conversationFacts(thread, currentUserId)).some(
    (seat) => seat.participantType === "user",
  )
}

/** The agent that NAMES this row, resolved to a display seat, or null. */
export function namingAgentSeat(
  thread: DisplayableConversation,
  currentUserId: string,
): ResolvedParticipant | null {
  const seat = soleAgentCounterpart(conversationFacts(thread, currentUserId))
  if (!seat) return null
  return resolvedParticipants(thread).find((p) => p.id === seat.id) ?? null
}

/**
 * The name the row shows. A channel is its title; a DM with people is the
 * other participants' first names; a 1:1 with an agent is the agent, even when
 * an `agent_chat` row carries its auto-title. A titled plain room is a channel
 * by its title whoever sits in it (A35 amended 2026-10-12). Nothing is renamed
 * in the database: this is presentation only.
 */
export function conversationDisplayName(
  thread: DisplayableConversation,
  currentUserId: string,
): string {
  const kind = conversationKind(thread, currentUserId)
  if (kind.group === "dm" && kind.namedBy === "agent") {
    const agent = namingAgentSeat(thread, currentUserId)
    if (agent?.name) return localizeAgentName(agent.name)
  }
  const participants = resolvedParticipants(thread)
  if (kind.group === "dm") {
    // An untitled-SHAPE row: name it by its people even when the row has a
    // title, so a titled room that A35 calls a DM does not fall back to it.
    return threadDisplayName({ title: null, participants }, currentUserId)
  }
  return threadDisplayName({ title: thread.title, participants }, currentUserId)
}
