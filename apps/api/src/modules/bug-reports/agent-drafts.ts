// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bug report an agent prepared for the Liaison team, waiting for its
// reporter's click. On a server that sends bug reports only to the Liaison team
// (`bugReportsTeamOnly`), `kernel:report_bug` never sends anything itself: an
// agent writes the report freely, and a prompt-injected page or mail read in
// the same turn could make it carry org data out. So the tool builds the exact
// payload (the reporter's email included, no client logs, the operator's server
// errors), stores it here under the reporter (Redis, 24 h, key scoped to the
// org and user, so no one else can read or send it), and answers its digest.
// The reporter sees the payload on a card (under the tool call in Liaison, or
// in Report a bug for a call from another client) and only their click, a
// signed-in request, queues it. This is not an approval: nobody else decides.
//
// A send is refused when the payload no longer matches the digest the card
// showed, when the team-only switch went off, or after 5 sends an hour by the
// same reporter (a send that could not be queued does not count). One reporter
// has at most 10 drafts waiting and prepares at most 20 an hour, so a looping
// agent cannot fill Redis.

import { randomUUID } from "node:crypto"
import { redis } from "~/lib/redis"
import type { BugReportForwardData } from "~/modules/liaison-team/bug-report-payload"
import {
  BugReportForwardError,
  buildBugReportForward,
  enqueueBugReportForward,
  type ForwardForm,
} from "~/modules/liaison-team/bug-report-payload"
import type { ForwardSnapshot } from "~/modules/liaison-team/snapshot"

const TTL_SECONDS = 24 * 3600
/** Forwards one reporter may confirm per hour. */
export const AGENT_FORWARDS_PER_HOUR = 5
/** Drafts one reporter may have waiting for a click at once. */
export const AGENT_DRAFTS_OPEN_MAX = 10
/** Drafts one reporter may prepare per hour. */
export const AGENT_DRAFTS_PER_HOUR = 20
const HOUR_MS = 3600_000

interface StoredDraft {
  form: ForwardForm
  snapshot: ForwardSnapshot
  reporterEmail: string
  digest: string
  createdAt: string
  sentMessageId?: string
}

/** What the card shows. */
export interface AgentBugReportDraft {
  draftId: string
  data: BugReportForwardData
  digest: string
  createdAt: string
  /** Set once the reporter sent it: the message id the Liaison team receives. */
  sentMessageId: string | null
}

const draftKey = (orgId: string, userId: string, draftId: string) =>
  `bug-report:draft:${orgId}:${userId}:${draftId}`
const sentKey = (orgId: string, userId: string, draftId: string) =>
  `bug-report:draft-sent:${orgId}:${userId}:${draftId}`
const indexKey = (orgId: string, userId: string) => `bug-report:drafts:${orgId}:${userId}`
const createdKey = (orgId: string, userId: string) => `bug-report:drafts-created:${orgId}:${userId}`
const forwardsKey = (orgId: string, userId: string) =>
  `bug-report:agent-forwards:${orgId}:${userId}`

/**
 * Take one place in a sliding one-hour window (a sorted set of timestamps):
 * the place is added first and given back when the window is over `limit`, so
 * two concurrent callers never both pass the last place. Returns the member to
 * give back with `releasePlace` when the action it pays for fails.
 */
async function takePlace(key: string, limit: number): Promise<string | null> {
  const now = Date.now()
  const member = `${now}:${randomUUID()}`
  const res = await redis
    .multi()
    .zremrangebyscore(key, 0, now - HOUR_MS)
    .zadd(key, now, member)
    .zcard(key)
    .expire(key, Math.ceil(HOUR_MS / 1000) + 5)
    .exec()
  const count = Number(res?.[2]?.[1] ?? Number.POSITIVE_INFINITY)
  if (count > limit) {
    await redis.zrem(key, member)
    return null
  }
  return member
}

async function releasePlace(key: string, member: string): Promise<void> {
  await redis.zrem(key, member)
}

function build(draft: StoredDraft) {
  return buildBugReportForward({
    form: draft.form,
    snapshot: draft.snapshot,
    includeEmail: true,
    reporterEmail: draft.reporterEmail,
    attachmentIndexes: [],
  })
}

async function readStored(
  orgId: string,
  userId: string,
  draftId: string,
): Promise<StoredDraft | null> {
  const raw = await redis.get(draftKey(orgId, userId, draftId))
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as StoredDraft
    if (typeof v.digest !== "string" || typeof v.form?.description !== "string") return null
    return v
  } catch {
    return null
  }
}

function view(draftId: string, draft: StoredDraft): AgentBugReportDraft {
  const built = build(draft)
  return {
    draftId,
    data: built.data,
    digest: built.digest,
    createdAt: draft.createdAt,
    sentMessageId: draft.sentMessageId ?? null,
  }
}

/**
 * Store one prepared report for `userId`; returns what the card shows. Throws
 * `DRAFT_LIMIT_REACHED` past 10 waiting drafts or 20 prepared in an hour.
 */
export async function createAgentDraft(
  orgId: string,
  userId: string,
  args: { form: ForwardForm; snapshot: ForwardSnapshot; reporterEmail: string },
): Promise<AgentBugReportDraft> {
  if ((await listPendingAgentDrafts(orgId, userId)).length >= AGENT_DRAFTS_OPEN_MAX) {
    throw new AgentDraftError(
      `${AGENT_DRAFTS_OPEN_MAX} prepared reports are already waiting for the user: they send or drop those first, or use the Report a bug form`,
      429,
      "DRAFT_LIMIT_REACHED",
    )
  }
  if ((await takePlace(createdKey(orgId, userId), AGENT_DRAFTS_PER_HOUR)) === null) {
    throw new AgentDraftError(
      `At most ${AGENT_DRAFTS_PER_HOUR} reports can be prepared an hour: try again later, or use the Report a bug form`,
      429,
      "DRAFT_LIMIT_REACHED",
    )
  }
  const draftId = randomUUID()
  const stored: StoredDraft = {
    form: args.form,
    snapshot: args.snapshot,
    reporterEmail: args.reporterEmail,
    digest: "",
    createdAt: new Date().toISOString(),
  }
  stored.digest = build(stored).digest
  await redis.set(draftKey(orgId, userId, draftId), JSON.stringify(stored), "EX", TTL_SECONDS)
  await redis.sadd(indexKey(orgId, userId), draftId)
  await redis.expire(indexKey(orgId, userId), TTL_SECONDS)
  return view(draftId, stored)
}

/** The reporter's own draft, or null (expired, or someone else's). */
export async function readAgentDraft(
  orgId: string,
  userId: string,
  draftId: string,
): Promise<AgentBugReportDraft | null> {
  const stored = await readStored(orgId, userId, draftId)
  return stored ? view(draftId, stored) : null
}

/** The reporter's drafts still waiting for a click, newest first. */
export async function listPendingAgentDrafts(
  orgId: string,
  userId: string,
): Promise<AgentBugReportDraft[]> {
  const ids = await redis.smembers(indexKey(orgId, userId))
  const out: AgentBugReportDraft[] = []
  for (const id of ids) {
    const stored = await readStored(orgId, userId, id)
    if (!stored) {
      await redis.srem(indexKey(orgId, userId), id)
      continue
    }
    if (!stored.sentMessageId) out.push(view(id, stored))
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export class AgentDraftError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 429,
    readonly code:
      | "DRAFT_NOT_FOUND"
      | "DRAFT_ALREADY_SENT"
      | "FORWARD_RATE_LIMITED"
      | "DRAFT_LIMIT_REACHED",
  ) {
    super(message)
    this.name = "AgentDraftError"
  }
}

/**
 * The reporter's click: queue the draft exactly as the card showed it
 * (`digest`). Team-only must still be on, checked again under the outbox lock.
 */
export async function sendAgentDraft(
  orgId: string,
  userId: string,
  draftId: string,
  digest: string,
): Promise<{ forwarded: "queued"; messageId: string }> {
  const stored = await readStored(orgId, userId, draftId)
  if (!stored) {
    throw new AgentDraftError("This report has expired", 404, "DRAFT_NOT_FOUND")
  }
  if (stored.sentMessageId) {
    throw new AgentDraftError("This report was already sent", 409, "DRAFT_ALREADY_SENT")
  }
  const built = build(stored)
  if (built.digest !== digest || built.digest !== stored.digest) {
    throw new BugReportForwardError(
      "The report changed since it was shown: check it and send again",
      409,
      "FORWARD_PAYLOAD_CHANGED",
      view(draftId, stored),
    )
  }
  const claimed = await redis.set(sentKey(orgId, userId, draftId), "1", "EX", TTL_SECONDS, "NX")
  if (claimed !== "OK") {
    throw new AgentDraftError("This report was already sent", 409, "DRAFT_ALREADY_SENT")
  }
  // The place is given back below when nothing was queued: only a queued
  // report counts against the hourly cap.
  const place = await takePlace(forwardsKey(orgId, userId), AGENT_FORWARDS_PER_HOUR)
  if (place === null) {
    await redis.del(sentKey(orgId, userId, draftId))
    throw new AgentDraftError(
      `At most ${AGENT_FORWARDS_PER_HOUR} prepared reports can be sent an hour: try again later, or use the Report a bug form`,
      429,
      "FORWARD_RATE_LIMITED",
    )
  }
  let queued: Awaited<ReturnType<typeof enqueueBugReportForward>>
  try {
    queued = await enqueueBugReportForward(built.data, [], new Date(), { teamOnly: { orgId } })
  } catch (err) {
    await redis.del(sentKey(orgId, userId, draftId))
    await releasePlace(forwardsKey(orgId, userId), place)
    throw err
  }
  if (queued.status === "unavailable") {
    await redis.del(sentKey(orgId, userId, draftId))
    await releasePlace(forwardsKey(orgId, userId), place)
    throw new BugReportForwardError(
      "Sending bug reports to the Liaison team is not available on this server",
      409,
      "FORWARDING_UNAVAILABLE",
    )
  }
  const sent: StoredDraft = { ...stored, sentMessageId: queued.messageId }
  await redis.set(draftKey(orgId, userId, draftId), JSON.stringify(sent), "KEEPTTL")
  await redis.srem(indexKey(orgId, userId), draftId)
  return { forwarded: "queued", messageId: queued.messageId }
}
