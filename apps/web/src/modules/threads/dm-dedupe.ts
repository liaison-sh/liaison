// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One row per counterpart in Direct messages.
//
// A DM is IDENTIFIED by who is in it: the viewer plus one counterpart. The
// product's own find-or-create reads it that way (`createOrGetAgentDm`), so
// two rooms with the same counterpart are the same conversation stored twice,
// and the list showed them as two rows with identical names, identical avatars
// and nothing to choose between them (the demo seed minted a look-alike the
// service's natural key could not see, which is how two "Support Desk" and two
// "Liaison" rows reached the sidebar).
//
// Whatever mints a stray twin next time, the list must not offer it as a
// choice. The most recently active room wins, because that is the one the
// viewer is actually talking in; the rest are hidden, not deleted, so nothing
// is lost and the history stays reachable by id.
import { conversationIdentitySeats, seatMakesGroupOfDm } from "@liaison/shared"
import type { Thread } from "~/modules/threads/thread-store"

type DmThread = Pick<Thread, "id" | "participants" | "updatedAt" | "unreadCount">

/** Who this conversation is WITH: every seat that is not the viewer, by agent
 *  id when the seat is an agent's. Empty when the room has no counterpart,
 *  which is never a twin of anything and is left alone. */
export function dmCounterpartKey(thread: DmThread, currentUserId: string): string | null {
  // D23a: keyed by the seats that name the row (a mention-seated agent in a
  // people DM is not one), so the DM and the lookup agree on which room it is.
  const others = conversationIdentitySeats(thread.participants)
    .filter((p) => p.id !== currentUserId)
    .map((p) => `${p.participantType === "agent" ? "agent" : "user"}:${p.agentId ?? p.id}`)
  if (others.length === 0) return null
  return [...new Set(others)].sort().join("|")
}

/** Most recent first, so the survivor of a duplicate pair is the room the
 *  viewer last used. Deterministic on a tie (equal timestamps happen: both
 *  rooms were written by the same seed run). */
function moreRecent(a: DmThread, b: DmThread): DmThread {
  const at = Date.parse(a.updatedAt ?? "") || 0
  const bt = Date.parse(b.updatedAt ?? "") || 0
  if (at !== bt) return at > bt ? a : b
  if ((a.unreadCount ?? 0) !== (b.unreadCount ?? 0)) {
    return (a.unreadCount ?? 0) > (b.unreadCount ?? 0) ? a : b
  }
  return a.id < b.id ? a : b
}

/**
 * The ids of the DM rows worth showing: one per counterpart set. Returned as a
 * set rather than a filtered list because the sidebar splits DMs into pin
 * tiers and has to apply the SAME decision to each tier: deduping tier by tier
 * would leave a pinned twin beside its unpinned original.
 */
export function visibleDmIds(threads: DmThread[], currentUserId: string): Set<string> {
  const winners = new Map<string, DmThread>()
  const keep = new Set<string>()
  for (const t of threads) {
    const key = dmCounterpartKey(t, currentUserId)
    if (!key) {
      keep.add(t.id)
      continue
    }
    const held = winners.get(key)
    winners.set(key, held ? moreRecent(held, t) : t)
  }
  for (const t of winners.values()) keep.add(t.id)
  return keep
}

type DmCandidate = DmThread &
  Pick<Thread, "title"> &
  Partial<Pick<Thread, "type" | "createdFrom" | "isPinned">>

/**
 * The DM the viewer already has with exactly these PEOPLE, or undefined.
 *
 * The same rule the API applies when it dedupes an untitled room on create
 * (`createThread` in apps/api threads/thread.ts): the people other than the
 * viewer are exactly `userIds`, and no agent was added on purpose
 * (`seatMakesGroupOfDm`, D23a 2026-10-12: an agent an @mention seated keeps
 * the DM, an agent added with "Add people" makes it a group). The
 * "new message" picker asks this so it can say "you already talk here" before
 * the member presses anything, instead of the server silently landing them in
 * the old room. Most recently active wins when the store holds twins.
 */
export function findExistingPeopleDm<T extends DmCandidate>(
  threads: T[],
  currentUserId: string,
  userIds: string[],
): T | undefined {
  if (userIds.length === 0) return undefined
  const wanted = [...new Set(userIds)].sort().join("|")
  let best: T | undefined
  for (const t of threads) {
    if (t.title) continue
    if (t.type && t.type !== "thread") continue
    // Entity-anchored rooms (a ticket's, an approval's) and the org's pinned
    // furniture are never the DM the API would dedupe into.
    if (t.createdFrom || t.isPinned) continue
    // D23a: the same rule as the API dedupe. An agent added on purpose makes
    // the room a group; one an @mention seated, or a guest seat, does not.
    if (t.participants.some(seatMakesGroupOfDm)) continue
    const humans = t.participants
      .filter((p) => p.participantType !== "agent" && p.id !== currentUserId)
      .map((p) => p.id)
    if ([...new Set(humans)].sort().join("|") !== wanted) continue
    best = best ? (moreRecent(best, t) as T) : t
  }
  return best
}
