// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Put the org's OWNER inside the world the other layers just wrote.
//
// The owner is the one account a demo org can be signed into: the person who
// registered (and is therefore the CEO of the company they were handed), or the
// App Review account on the reserved org. `seed-org.ts` creates them as the
// org's `admin`, which is every scope there is. That is not enough on its own,
// because two of the surfaces that make the workspace worth opening are not
// scope-gated:
//
//   THREADS    visibility is participant-gated in RLS (`threads_select`), not
//              scope-gated. An account that is not a participant opens onto an
//              empty Chats list no matter what it is allowed to read.
//   APPROVALS  `listApprovals` returns only items the caller is notified about
//              AND holds the approve scope for, so an admin who is on nobody's
//              notify list has an empty approval queue.
//
// So this joins the owner to every seeded conversation and adds them to the
// notify set of every approval still waiting for a decision. It also writes
// the owner's read state: on the reserved org only the newest few of those
// conversations arrive unread, on a visitor's none. It runs LAST, after the support layer, because
// it is other people's data that it attaches to.
//
// Idempotent, like every other demo seeder: the participant rows collide on
// their unique index and the notify-set update checks before it appends.
//
// This file used to seed two accounts of its own, a shared `guest` and a
// reviewer, both on a published password. Both are gone: there is no least
// rights door to publish (the visitor owns the org and can make one themselves)
// and the reviewer is now simply the reserved org's owner, created by the same
// path as anybody else's.

// The writes are the people factories' (`seed/factories/people/membership.ts`,
// `read-state.ts`); this layer decides who is joined and what stays unread.

import { broadcastReadState, type ReadStateChange } from "~/modules/threads/read-state-broadcast"
import { demoId } from "~/seed/context"
import {
  joinPendingApprovals,
  joinThreads,
  threadsToJoin,
} from "~/seed/factories/people/membership"
import { markAppBacklogRead, writeConversationReadState } from "~/seed/factories/people/read-state"
import type { SeedDemoOrgResult } from "./seed-org"
import { MAIL_TOUR_CONVERSATION } from "./seed-support"

/**
 * How many conversations the reserved org's owner finds unread after a seed:
 * the most recent few, one new message each. Everything else is read. A
 * visitor finds none: the seeded world is background, and what is new to them
 * is what their scenarios bring in live.
 */
export const DEMO_UNREAD_CONVERSATIONS = 3

export interface SeedDemoAccountsResult {
  /** Null when the org was seeded with no owner (the reset probe). */
  ownerUserId: string | null
  /** Conversations the owner was joined to. */
  threadCount: number
  /** Pending approvals the owner was added to the notify set of. */
  approvalCount: number
  /** Conversations left unread for the owner (reserved orgs only, else 0). */
  unreadCount: number
}

/** Tells a person's devices that a read mark moved (`broadcastReadState`). */
export type ReadStateBroadcast = (
  orgId: string,
  userId: string,
  change: ReadStateChange,
) => Promise<void>

/** Attach the org's owner to the world the earlier layers wrote. */
export async function seedDemoAccounts(
  org: SeedDemoOrgResult,
  opts: { log?: (msg: string) => void; broadcast?: ReadStateBroadcast } = {},
): Promise<SeedDemoAccountsResult> {
  const log = opts.log ?? (() => {})
  const ownerUserId = org.ownerUserId
  if (!ownerUserId) {
    log("accounts: no owner on this org, nothing to attach")
    return { ownerUserId: null, threadCount: 0, approvalCount: 0, unreadCount: 0 }
  }
  const threadIds = await threadsToJoin(org.orgId, ownerUserId)
  const threadCount = await joinThreads(org.orgId, ownerUserId, threadIds)
  const approvalCount = await joinPendingApprovals(org.orgId, ownerUserId)
  // The reserved org's owner is the App Review account, and it opens onto the
  // few newest conversations unread rather than all of them. A visitor opens
  // onto none: the seeded conversations are background they never saw arrive.
  const unread = await writeConversationReadState(
    org.orgId,
    ownerUserId,
    org.variant === "reserved" ? DEMO_UNREAD_CONVERSATIONS : 0,
  )
  const unreadCount = unread.length
  if (org.variant === "visitor") {
    // A visitor's seeded mail and tickets are background they never saw
    // arrive: all read, so what shows as new is what a scenario brings in
    // live. One conversation stays unread: the one the Mail tour opens, the
    // newest still waiting on an answer (walk D49).
    const read = await markAppBacklogRead(
      org.orgId,
      ownerUserId,
      demoId(org.orgId, "mail-conversation", MAIL_TOUR_CONVERSATION),
    )
    log(`accounts: ${read} seeded tickets and mail conversations arrive read`)
  }
  // The owner may already have the workspace open (a visitor's seed runs behind
  // the signup response): their page counted the seed's messages as they
  // landed, and the marks above were written straight into the tables. Each
  // conversation's mark, and the attention feed, reach their devices now
  // (walk D23: the first view showed 6 unread chats the seed had read).
  const broadcast = opts.broadcast ?? broadcastReadState
  const kept = new Set(unread)
  for (const threadId of threadIds) {
    await broadcast(org.orgId, ownerUserId, {
      kind: "thread",
      threadId,
      unreadCount: kept.has(threadId) ? 1 : 0,
    })
  }
  if (org.variant === "visitor") await broadcast(org.orgId, ownerUserId, { kind: "attention" })
  log(
    `accounts: owner joined to ${threadCount} conversations (${unreadCount} left unread) and ` +
      `${approvalCount} approvals to decide`,
  )
  return { ownerUserId, threadCount, approvalCount, unreadCount }
}
