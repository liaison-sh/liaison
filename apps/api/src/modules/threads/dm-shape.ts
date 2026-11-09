// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What makes a thread a DM, in one place.
//
// `kernel.threads.type` has no "dm" value: a DM is a SHAPE, and the shape is
// whatever `createThread` silently dedupes as one conversation between the
// same people (thread.ts). Anything that has to answer "is this a DM" has to
// answer it the same way, or two parts of the product disagree about the same
// row. The push fanout is the second caller: a room it reads as a DM notifies
// everybody in it without a mention, and a room it reads as a channel notifies
// the mentioned only, so a narrower predicate there means a thread whose
// messages reach nobody.
//
// The facts are passed in because the two callers hold them differently: one
// has the CREATE parameters and no row yet, the other has the row plus two
// counts. Neither reads the database here.

export interface PlainThreadFacts {
  /** `kernel.threads.type`, or the type the create call asked for. */
  type: string
  /** Pinned threads are workspace furniture, never a conversation. */
  isPinned: boolean
  /**
   * Anchored to an entity (a ticket, an approval, a mail conversation). Only
   * this anchors a thread. Entity REFERENCES do not: they are context a
   * conversation carries, so a DM that mentions an order is still the one DM
   * between those people, deduped into on create and notified as a DM.
   */
  createdFrom: unknown
  /** The HUMAN parties. An agent seat is a member, never a party. */
  humanCount: number
}

export interface DmShapeFacts extends PlainThreadFacts {
  /** A title makes it a channel (A35, amended 2026-10-12). */
  title: string | null
  /**
   * AGENT seats in the room. Required rather than optional (P6d-FX7, SK-3):
   * the rule below cannot be answered without it, and a caller that could
   * leave it out is a caller that silently gets the old answer.
   */
  agentCount: number
}

/**
 * A thread between people, not anchored to an entity. Entity-anchored threads
 * are legitimately one per entity and are never deduped or guarded.
 */
export function isPlainThreadShape(facts: PlainThreadFacts): boolean {
  if (facts.type === "agent_chat" || facts.type === "approval") return false
  if (facts.humanCount < 1) return false
  if (facts.isPinned) return false
  return !facts.createdFrom
}

/**
 * An UNTITLED plain thread. Deliberately no bound on how many people are in
 * it: `createThread` puts none there, so an untitled thread between three
 * people is one room whose every message is addressed to everybody in it,
 * exactly like the two-person case.
 *
 * WHAT THAT COSTS, SINCE THE PUSH FANOUT ALSO CALLS THIS. Every human in the
 * room is notified of every message in it, with no mention required: a room of
 * five is four notifications per message, a room of fifty is forty nine. That
 * is the price of one predicate rather than two that disagree, and it is
 * pinned by name in modules/push/fanout-consumer.test.ts ("an untitled room of
 * five humans pushes the other four"), so narrowing it here fails there rather
 * than showing up as silence on somebody's handset.
 */
export function isDmShapedThread(facts: DmShapeFacts): boolean {
  if (!isPlainThreadShape(facts)) return false
  // A titled room is a channel, whatever its membership (A35, amended
  // 2026-10-12). It used to be a DM here too when its only other seat was an
  // agent (P6d-FX7, SK-3), mirroring the sidebar's old rule 1; both rules now
  // read a title as a channel, so the agent page lists such a room among the
  // agent's channels. The push fanout keeps notifying that room's one human
  // of every message on its own terms (`isDirectRoom` in fanout-consumer.ts).
  return !facts.title
}
