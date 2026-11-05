// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH SEATS MAKE A ROOM "THE DM" BETWEEN TWO PEOPLE (D23a, 2026-10-12).
//
// D23 made the DM lookup return only a room seating exactly the two people.
// But when a PERSON @mentions an agent in their DM, the agent gets a member
// seat, so every DM where anyone ever mentioned an agent stopped being "the
// DM": "Message X" opened a fresh empty 1:1 and the history stayed behind.
// Refined rule: the DM is identified by its two people. An agent seated by an
// @mention (a person's or an agent's) does not change that, nor does a GUEST
// seat (an agent answering one question, unseated after). Only a member added
// on purpose ("Add people", an agent invite, the agent a chat was created
// with) makes the room a group conversation.
//
// ONE rule for both readers: the API's find-or-create (`createThread` dedupe,
// apps/api threads/thread.ts, which states it in SQL with these constants) and
// the web's "you already talk here" (`findExistingPeopleDm`, dm-dedupe.ts).

/** `thread_participants.role` of an agent seated for one turn only. */
export const AGENT_GUEST_SEAT_ROLE = "guest"

/** `thread_participants.seat_origin` of an agent seated by an @mention. */
export const MENTION_SEAT_ORIGIN = "mention"

export interface DmIdentitySeat {
  participantType: "user" | "agent"
  /** `thread_participants.role`; absent reads as a plain member. */
  role?: string | null
  /** `thread_participants.seat_origin`; absent reads as an explicit add. */
  seatOrigin?: string | null
}

/**
 * True when this seat makes the room something other than the DM between its
 * people: an agent added on purpose. A person's seat is judged by the people
 * count, not here.
 */
export function seatMakesGroupOfDm(seat: DmIdentitySeat): boolean {
  if (seat.participantType !== "agent") return false
  if (seat.role === AGENT_GUEST_SEAT_ROLE) return false
  return seat.seatOrigin !== MENTION_SEAT_ORIGIN
}

/**
 * The seats that NAME a conversation and decide what it is, for every list
 * (sidebar row and mark, phone list, tab, dock) and the sidebar's twin key.
 * In a room with two or more people, a seat that does not make it a group
 * (an agent an @mention seated, a guest seat) is left out, so "Alice" stays
 * "Alice" after someone asked @data something in the DM, exactly as the DM
 * lookup treats that room. A room with one person keeps every seat: a 1:1
 * with an agent is named by that agent however it was seated.
 */
export function conversationIdentitySeats<T extends DmIdentitySeat>(seats: readonly T[]): T[] {
  const people = seats.filter((s) => s.participantType !== "agent").length
  if (people < 2) return [...seats]
  return seats.filter((s) => s.participantType !== "agent" || seatMakesGroupOfDm(s))
}
