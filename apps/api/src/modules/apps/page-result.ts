// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A PAGE TELLS THE CONVERSATION IT WAS OPENED FROM WHAT HAPPENED.
//
// An agent's tool answers a page handle (`ctx.pages.link`, app-pages.ts) and
// ends its turn ("pick the files there"). When a route of that page answers
// with a `pageResult` (`{ summary, data? }`), the conversation gets what a
// completed connect card gets (secret-requests/announce.ts):
//
//  1. A system line (`metadata.type = 'app-page-result'`) with the summary and
//     the data, posted as the person, readable only by people who hold the
//     page's scope. The agent's transcript replays it as an event, the app's
//     words fenced as outside text (system-event-replay.ts).
//  2. ONE turn of the agent that showed the page, off that line, so it carries
//     on with what the person asked for.
//
// Where the page came from is never read from the browser or the app: the
// platform binds the run's own conversation and agent into the handle when the
// app mints it (pages bridge), and the binding travels handle -> link -> page
// session. A page opened from Settings or a panel has no origin and posts
// nowhere. Best effort: a failure is logged, never turned into a failed route.

import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { appsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { type FollowUpTurnPayload, runFollowUpTurn } from "~/modules/secret-requests/announce"
import { sendMessage } from "~/modules/threads/message"

/** The job that runs the agent's turn off a page-result line. */
export const APP_PAGE_RESULT_TURN_JOB = "app-page-result-turn"
/** A summary's length, at most. */
export const PAGE_RESULT_SUMMARY_MAX = 500
/** A result's data, as JSON, at most. */
export const PAGE_RESULT_DATA_MAX_BYTES = 8 * 1024
const TURN_CLAIM_TTL_SECONDS = 24 * 60 * 60
const turnKey = (messageId: string) => `app-page-result:turn:${messageId}`

/** The conversation a page was opened from: bound by the platform, never by the app. */
export interface PageOrigin {
  threadId: string
  agentId: string | null
}

export interface PageResult {
  summary: string
  data?: Record<string, unknown>
}

/**
 * A route answer's `pageResult`, checked: a summary (1 to 500 characters) and,
 * optionally, a JSON object of at most 8 KiB. Null when absent or malformed.
 */
export function parsePageResult(raw: unknown): PageResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const summary = typeof r.summary === "string" ? r.summary.trim() : ""
  if (!summary || summary.length > PAGE_RESULT_SUMMARY_MAX) return null
  if (r.data === undefined) return { summary }
  if (!r.data || typeof r.data !== "object" || Array.isArray(r.data)) return null
  if (Buffer.byteLength(JSON.stringify(r.data), "utf8") > PAGE_RESULT_DATA_MAX_BYTES) return null
  return { summary, data: r.data as Record<string, unknown> }
}

/**
 * Post the result line in the conversation the page came from, as the page's
 * person, and enqueue the turn of the agent that showed it.
 */
export async function announcePageResult(input: {
  /** The page's person, as they are now (their scopes post the line). */
  actor: ActorContext
  userId: string
  app: string
  page: string
  /** The page's scope: who may read the line. */
  scope: string
  origin: PageOrigin
  result: PageResult
}): Promise<{ messageId: string | null; turnEnqueued: boolean }> {
  const { actor, app, page, origin, result } = input
  const { userId } = input
  const orgId = actor.orgId as string
  try {
    const message = await withRlsContext(actor, (tx) =>
      sendMessage(tx, {
        requiredScopes: [input.scope],
        orgId,
        userId,
        threadId: origin.threadId,
        content: result.summary,
        authorType: "system",
        agentId: origin.agentId,
        metadata: {
          type: "app-page-result",
          app,
          page,
          summary: result.summary,
          ...(result.data ? { data: result.data } : {}),
          agentId: origin.agentId,
        },
      }),
    )
    if (!message) {
      log.warn(
        { orgId, app, threadId: origin.threadId },
        "page result not posted: the person is not in the conversation",
      )
      return { messageId: null, turnEnqueued: false }
    }
    if (!origin.agentId) return { messageId: message.id, turnEnqueued: false }
    const payload: FollowUpTurnPayload = {
      orgId,
      threadId: origin.threadId,
      messageId: message.id,
      requesterId: userId,
      agentId: origin.agentId,
    }
    try {
      // attempts: 1: the turn spends credits and posts a reply, so a retry
      // after a partial run would answer twice.
      await enqueueAppJob("kernel", APP_PAGE_RESULT_TURN_JOB, payload, {
        jobId: `${APP_PAGE_RESULT_TURN_JOB}:${message.id}`,
        attempts: 1,
      })
    } catch (err) {
      // The line is posted: the agent reads it on the person's next message.
      log.error(
        { err, orgId, app, threadId: origin.threadId, messageId: message.id },
        "page result posted, but the agent's turn was not enqueued",
      )
      return { messageId: message.id, turnEnqueued: false }
    }
    return { messageId: message.id, turnEnqueued: true }
  } catch (err) {
    log.error({ err, orgId, app, page }, "failed to post a page result in its conversation")
    return { messageId: null, turnEnqueued: false }
  }
}

/** The agent's turn off a page-result line: once per line (a Redis claim). */
export async function runPageResultTurn(payload: FollowUpTurnPayload): Promise<boolean> {
  return runFollowUpTurn(payload, async () => {
    const claimed = await redis.set(
      turnKey(payload.messageId),
      "1",
      "EX",
      TURN_CLAIM_TTL_SECONDS,
      "NX",
    )
    return claimed === "OK"
  })
}
