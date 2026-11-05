// SPDX-License-Identifier: FSL-1.1-ALv2
//
// IS THE USER ALREADY IN THIS CONVERSATION? The one question a device push for
// a message has to ask before it interrupts (Messenger, Slack, WhatsApp): a
// person reading the thread on any client is not buzzed on another one.
//
// Two signals, both from infrastructure that already exists:
//   1. VIEWING. Each realtime connection reports, in the shared notify presence
//      registry (infra/websocket.ts, TTL 60 s), the ids on its screen and
//      whether its window is visible and focused. A focused client showing the
//      thread, touched within `THREAD_VIEWING_IDLE_MS`, means the user is
//      reading it.
//   2. RECENT INTERACTION. Posting or typing in a thread stamps it for
//      `THREAD_INTERACTION_WINDOW_MS`. Within that window, a focused client
//      the user touched within the same window means they are still at the
//      keyboard (Slack's "active on desktop" rule), even if the thread itself
//      is not the one on screen any more.
//
// "Thread" here is the router's presence key: the thread id for a message the
// channel shows, the ROOT message id for a reply that lives only in its reply
// thread. Clients report the roots of open reply panes alongside thread ids,
// so a channel on screen never stands in for a reply thread that is not.
//
// A phone that is locked or backgrounded reports itself hidden, a desktop
// window behind another app reports itself unfocused, and a client from before
// the report reports nothing: none of them suppresses, so the push goes out as
// before. Every read fails open (push), because a missed notification is worse
// than a redundant one.

import { type NotifyPresenceEntry, readNotifyPresence } from "~/infra/websocket"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ module: "thread-activity" })

/** A focused client showing the thread suppresses only if touched this recently. */
export const THREAD_VIEWING_IDLE_MS = 10 * 60_000

/**
 * A focused client showing a computer session holds its notices back only if
 * touched this recently (S13): shorter than a thread's, since a session runs
 * on its own while the person may have walked away.
 */
export const SESSION_VIEWING_IDLE_MS = 2 * 60_000

/** How long posting or typing in a thread counts as being active in it. */
export const THREAD_INTERACTION_WINDOW_MS = 2 * 60_000

const interactionKey = (orgId: string, userId: string, threadId: string) =>
  `notify:thread-interaction:${orgId}:${userId}:${threadId}`

/**
 * The decision, pure. `lastInteractionAt` is when the user last posted or typed
 * in the thread (null: not within the window).
 */
export function isActiveInThread(
  entries: readonly NotifyPresenceEntry[],
  threadId: string,
  lastInteractionAt: number | null,
  now: number,
): boolean {
  if (isViewingThread(entries, threadId, now)) return true
  for (const e of entries) {
    if (!e.viewing?.focused) continue
    const idle = now - e.lastActiveAt
    if (
      lastInteractionAt !== null &&
      now - lastInteractionAt <= THREAD_INTERACTION_WINDOW_MS &&
      idle <= THREAD_INTERACTION_WINDOW_MS
    ) {
      return true
    }
  }
  return false
}

/**
 * Signal 1 alone: is the thread on screen on a focused client, touched within
 * `THREAD_VIEWING_IDLE_MS`? The router asks only this for an item marked
 * `presenceViewingOnly` (an agent's finished answer to the person who asked).
 */
export function isViewingThread(
  entries: readonly NotifyPresenceEntry[],
  threadId: string,
  now: number,
): boolean {
  return entries.some(
    (e) =>
      e.viewing?.focused === true &&
      e.viewing.threadIds.includes(threadId) &&
      now - e.lastActiveAt <= THREAD_VIEWING_IDLE_MS,
  )
}

/** Production reader of `isViewingThread`. Fails open (false: the push goes out). */
export async function loadViewingThread(
  orgId: string,
  userId: string,
  threadId: string,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    return isViewingThread(await readNotifyPresence(redis, orgId, userId), threadId, now)
  } catch (err) {
    log.warn({ err, threadId }, "thread presence unreadable; the push goes out")
    return false
  }
}

/**
 * Is a computer session on screen? A focused client whose viewing report
 * lists the session id (clients report session tabs alongside threads,
 * web notifications/thread-on-screen.ts), touched within
 * `SESSION_VIEWING_IDLE_MS`. No interaction rule: typing in a session does
 * not stand in for watching it.
 */
export function isViewingSession(
  entries: readonly NotifyPresenceEntry[],
  sessionId: string,
  now: number,
): boolean {
  return entries.some(
    (e) =>
      e.viewing?.focused === true &&
      e.viewing.threadIds.includes(sessionId) &&
      now - e.lastActiveAt <= SESSION_VIEWING_IDLE_MS,
  )
}

/** Production reader of `isViewingSession`. Fails open (false: the notice goes out). */
export async function loadViewingSession(
  orgId: string,
  userId: string,
  sessionId: string,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    return isViewingSession(await readNotifyPresence(redis, orgId, userId), sessionId, now)
  } catch (err) {
    log.warn({ err, sessionId }, "session presence unreadable; the notice goes out")
    return false
  }
}

/** Stamp the user's activity in a thread (a post, a typing frame). Never throws. */
export async function recordThreadInteraction(
  orgId: string,
  userId: string,
  threadId: string,
  now: number = Date.now(),
): Promise<void> {
  try {
    await redis.set(
      interactionKey(orgId, userId, threadId),
      String(now),
      "PX",
      THREAD_INTERACTION_WINDOW_MS,
    )
  } catch (err) {
    log.warn({ err, threadId }, "thread interaction stamp failed")
  }
}

/**
 * Production reader: the user's live presence entries and their last
 * interaction with the thread, then the decision. Fails open (false).
 */
export async function loadActiveInThread(
  orgId: string,
  userId: string,
  threadId: string,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const [entries, stamp] = await Promise.all([
      readNotifyPresence(redis, orgId, userId),
      redis.get(interactionKey(orgId, userId, threadId)),
    ])
    const at = stamp === null ? null : Number(stamp)
    return isActiveInThread(entries, threadId, Number.isFinite(at) ? at : null, now)
  } catch (err) {
    log.warn({ err, threadId }, "thread activity unreadable; the push goes out")
    return false
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ThreadActivityTestAccess = {
  /** Forget a user's interaction stamp for a thread. */
  async clear(orgId: string, userId: string, threadId: string): Promise<void> {
    await redis.del(interactionKey(orgId, userId, threadId))
  },
}
