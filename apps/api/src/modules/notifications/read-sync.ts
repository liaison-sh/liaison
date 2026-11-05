// SPDX-License-Identifier: FSL-1.1-ALv2
//
// RULE 5, READ ONCE, READ EVERYWHERE: the phone's side.
//
// Every read mark the server stores ends with a `read_state` frame
// (threads/read-state-broadcast.ts). The person's open apps (web, desktop, the
// phone in the foreground) hear it over their socket: their lists, their badge
// and their shown notifications follow at once (web
// modules/notifications/desktop.ts withdraws the banners of what was read). A
// phone in the background hears nothing, so its icon kept the number of the
// last push until the next message arrived.
//
// This consumer closes that gap: a read schedules one badge sync per person a
// moment later (reads in a burst, such as opening a channel then its replies,
// coalesce into one), which sends each of the person's iPhones the new badge
// in a badge-only push (`sendBadgeSync`: no banner, no sound). The delivered
// banners themselves are withdrawn by the phone on its next foreground
// (apps/mobile push-client.ts asks `GET /notifications/badge` which
// conversations are still unread).

//
// Reads are not the only way the badge drops. Another approver decides an
// approval the person was asked to decide, a message of a direct conversation
// is deleted, the person leaves a conversation, an access request is granted
// or denied: each of those events schedules the same sync for the people whose
// count it can lower (`badgeSyncTargets`), from the events already on the bus.
//
// Jobs of neighbouring windows can finish out of order. Each job carries its
// window and every schedule records the person's newest one; a job whose
// window a newer one has superseded computes nothing and sends nothing, so the
// count that lands last is the newest.

import { type AppEvent, onEvent } from "~/infra/events/event-bus"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import {
  computeBadgeCount,
  directThreadMembers,
  scopeRequestHolders,
} from "~/modules/push/badge-count"
import { loadTokens } from "~/modules/push/fanout-consumer"
import { sendBadgeSync } from "~/modules/push/sender"
import type { PushSendResult, PushTokenRow } from "~/modules/push/types"
import { READ_STATE_ENTITY } from "~/modules/threads/read-state-broadcast"

const log = rootLogger.child({ module: "notifications-read-sync" })

export const BADGE_SYNC_JOB = "notify-badge-sync"

/** How long after a read the sync goes out: reads in a burst share one push. */
export const BADGE_SYNC_DELAY_MS = 2_000

/** Read-state changes that can move the badge. */
const BADGE_MOVING_KINDS = new Set(["thread", "reply_thread", "thread_state", "attention"])

/** The most people one event schedules a sync for: the badge is a nudge, not a broadcast. */
const BADGE_SYNC_AUDIENCE_MAX = 50

/** How long the newest window is remembered: well past any job's delay and retries. */
const LATEST_WINDOW_TTL_MS = 10 * 60_000

export interface BadgeSyncJob {
  orgId: string
  userId: string
  /** The window it was scheduled in (`now / BADGE_SYNC_DELAY_MS`). */
  window?: number
}

export interface BadgeSyncEnqueueOptions {
  jobId: string
  delay: number
  attempts: number
  backoff: { type: "exponential"; delay: number }
}

/** Who else an event can lower the badge of, read from the database. */
export interface BadgeSyncAudience {
  /** The people of a direct conversation (empty for any other thread). */
  directThreadMembers: (orgId: string, threadId: string) => Promise<string[]>
  /** The people an access request was put to (their `scope_request` rows). */
  scopeRequestHolders: (orgId: string, requestId: string) => Promise<string[]>
}

export interface ReadSyncDeps extends BadgeSyncAudience {
  now: () => number
  enqueue: (job: BadgeSyncJob, opts: BadgeSyncEnqueueOptions) => Promise<void>
  /** Records the job's window as the person's newest. */
  markLatest: (job: Required<BadgeSyncJob>) => Promise<void>
  /** The person's newest scheduled window, or null when none is known. */
  latest: (orgId: string, userId: string) => Promise<number | null>
  loadTokens: (orgId: string, userId: string) => Promise<PushTokenRow[]>
  badgeCount: (userId: string, orgId: string) => Promise<number>
  send: (token: PushTokenRow, count: number) => Promise<PushSendResult>
}

const latestKey = (orgId: string, userId: string) => `notify:badge-sync:latest:${orgId}:${userId}`

const defaultDeps: ReadSyncDeps = {
  now: () => Date.now(),
  enqueue: async (job, opts) => {
    await enqueueAppJob("kernel", BADGE_SYNC_JOB, job, opts)
  },
  markLatest: async (job) => {
    await redis.set(
      latestKey(job.orgId, job.userId),
      String(job.window),
      "PX",
      LATEST_WINDOW_TTL_MS,
    )
  },
  latest: async (orgId, userId) => {
    const raw = await redis.get(latestKey(orgId, userId))
    const value = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(value) ? value : null
  },
  loadTokens: (orgId, userId) => loadTokens(orgId, [userId]),
  badgeCount: (userId, orgId) => computeBadgeCount(userId, orgId),
  send: (token, count) => sendBadgeSync(token, count),
  directThreadMembers: (orgId, threadId) =>
    directThreadMembers(orgId, threadId, BADGE_SYNC_AUDIENCE_MAX),
  scopeRequestHolders: (orgId, requestId) =>
    scopeRequestHolders(orgId, requestId, BADGE_SYNC_AUDIENCE_MAX),
}

/** The person a read-state frame is about, when the read can move their badge. */
export function badgeSyncFor(event: AppEvent): BadgeSyncJob | null {
  if (event.app !== "kernel" || event.entity !== READ_STATE_ENTITY) return null
  const data = event.data as Record<string, unknown> | undefined
  const userId = data?.forUserId
  if (typeof userId !== "string" || typeof event.orgId !== "string") return null
  if (typeof data?.kind !== "string" || !BADGE_MOVING_KINDS.has(data.kind)) return null
  return { orgId: event.orgId, userId }
}

const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

/**
 * Everyone whose badge this event can lower: the reader of a read, the people
 * an approval asked once it is decided, the members of a direct conversation
 * a message left, the person who left a conversation, the people an access
 * request was put to once it is resolved. Empty for any other event.
 */
export async function badgeSyncTargets(
  event: AppEvent,
  audience: BadgeSyncAudience = defaultDeps,
): Promise<BadgeSyncJob[]> {
  const read = badgeSyncFor(event)
  if (read) return [read]
  const orgId = event.orgId
  if (event.app !== "kernel" || typeof orgId !== "string") return []
  const data = (event.data ?? {}) as Record<string, unknown>
  let people: string[] = []
  if (event.entity === "approval_request" && event.action === "update") {
    if (typeof data.status === "string" && data.status !== "pending") {
      people = [
        ...ids(data.notifyUserIds),
        ...(typeof data.resourceOwnerId === "string" ? [data.resourceOwnerId] : []),
      ]
    }
  } else if (event.entity === "message" && event.action === "delete") {
    if (typeof data.threadId === "string") {
      people = await audience.directThreadMembers(orgId, data.threadId)
    }
  } else if (event.entity === "participant" && event.action === "remove") {
    if (typeof data.userId === "string") people = [data.userId]
  } else if (event.entity === "scope_request" && event.action === "update") {
    const requestId = typeof event.entityId === "string" ? event.entityId : null
    if (requestId && (data.status === "approved" || data.status === "denied")) {
      people = await audience.scopeRequestHolders(orgId, requestId)
    }
  }
  return [...new Set(people)].slice(0, BADGE_SYNC_AUDIENCE_MAX).map((userId) => ({ orgId, userId }))
}

/** One job per person per window: a second schedule inside it is the same job. */
async function scheduleBadgeSync(job: BadgeSyncJob, deps: ReadSyncDeps): Promise<void> {
  const window = Math.floor(deps.now() / BADGE_SYNC_DELAY_MS)
  const windowed = { orgId: job.orgId, userId: job.userId, window }
  await deps.markLatest(windowed)
  await deps.enqueue(windowed, {
    jobId: `badge-sync:${job.orgId}:${job.userId}:${window}`,
    delay: BADGE_SYNC_DELAY_MS,
    attempts: 2,
    backoff: { type: "exponential", delay: 2_000 },
  })
}

/** The bus handler: an event that can lower a badge schedules each such person's sync. Never throws. */
export async function handleBadgeEvent(
  event: AppEvent,
  partial: Partial<ReadSyncDeps> = {},
): Promise<void> {
  const deps = { ...defaultDeps, ...partial }
  let jobs: BadgeSyncJob[] = []
  try {
    jobs = await badgeSyncTargets(event, deps)
  } catch (err) {
    log.warn({ err, entity: event.entity }, "badge sync audience unavailable")
    return
  }
  for (const job of jobs) {
    try {
      await scheduleBadgeSync(job, deps)
    } catch (err) {
      log.warn({ err, userId: job.userId }, "badge sync schedule failed")
    }
  }
}

/** The job: the person's badge, now, to each of their iPhones. Returns how many accepted it. */
export async function runBadgeSync(
  job: BadgeSyncJob,
  partial: Partial<ReadSyncDeps> = {},
): Promise<number> {
  const deps = { ...defaultDeps, ...partial }
  // A newer window is queued: it sends the newer count, this one sends nothing.
  const superseded = async () => {
    if (typeof job.window !== "number") return false
    const latest = await deps.latest(job.orgId, job.userId)
    return latest !== null && latest > job.window
  }
  if (await superseded()) return 0
  const tokens = (await deps.loadTokens(job.orgId, job.userId)).filter((t) => t.platform === "ios")
  if (tokens.length === 0) return 0
  const count = await deps.badgeCount(job.userId, job.orgId)
  // Counted at send time; checked again, since a newer job may have been
  // scheduled while this one counted.
  if (await superseded()) return 0
  let sent = 0
  for (const token of tokens) {
    try {
      const result = await deps.send(token, count)
      if (result.kind === "sent") sent += 1
    } catch (err) {
      log.warn({ err, userId: job.userId }, "badge sync push failed")
    }
  }
  return sent
}

let registered = false

/** Subscribes the badge sync to read-state frames and the other badge-lowering events, once per process. */
export function registerReadSyncConsumer(): void {
  if (registered) return
  registered = true
  onEvent((event) => handleBadgeEvent(event), {
    delivery: "once",
    name: "notifications-badge-sync",
  })
}
