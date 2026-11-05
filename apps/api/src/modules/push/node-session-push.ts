// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The node session push (P4, spec C9; round 2 S12-S16): one push to the
 * owner's devices when a session needs them, is done or failed. The notifier
 * (node-session-notify.ts) decides when; this module says what and sends it.
 *
 * Push text never carries model output (S16): a fixed phrase per kind, and for
 * a wait opened by a request, that request's type and tool name.
 *
 * Its text is built from the open request's TYPE and, for a permission, its
 * tool NAME only (P-D2). Nothing here accepts a tool input, a path, a command
 * or a question's text: the request shape below has no field for one, and the
 * caller passes the tool name, never the event payload. `waiting_reason` is
 * never used either, because for a question it holds the question's header,
 * which is tool input.
 *
 * The session TITLE (the prompt's first line) follows the scope rule of
 * push/redact.ts: a session whose job carries source scopes, or an agent_tag
 * run (another person's prompt), pushes no title at all, only a generic line;
 * an unreadable job fails closed the same way. Any other title is shown as the
 * web shows it: every absolute local path relativized (`relativizePaths`).
 */
import { relativizePaths, type ShippedLocale } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { nodeJobs } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { serverT } from "~/modules/i18n/server-i18n"
import { onSessionStatus } from "~/modules/node-sessions/waiting-hook"
import {
  mutedSessionDecision,
  notificationIdFor,
  type RouterDecision,
  type RouterItem,
  resolveChannels,
} from "~/modules/notifications/router"
import {
  deliverPayloadToUser,
  type PushFanoutDeps,
  recipientLocale,
} from "~/modules/push/fanout-consumer"
import { notifyNodeSessionStatus } from "~/modules/push/node-session-notify"
import { attentionSettleKey, PUSH_BODY_MAX } from "~/modules/push/redact"

const log = rootLogger.child({ module: "node-session-push" })

/** The deep link a session push opens (apps/mobile deep-link.ts `SESSION_LINK_PREFIX`). */
export const NODE_SESSION_LINK_PREFIX = "liaison://session/"

/** The request that opened the wait, reduced to what a push may say. */
export interface NodeSessionPushRequest {
  type: "permission_request" | "question" | "plan_request"
  /** The tool's NAME (for example `Bash`), never its input. */
  tool: string | null
}

/**
 * A tool name is printed only when it looks like a name. Anything else (a
 * command, a path, spaces) becomes "a tool": a name that carries input never
 * reaches a lock screen.
 */
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/

/** What a notice is about: the session needs its owner, is done, or failed. */
export type NodeSessionNoticeKind = "needs_you" | "done" | "failed"

export interface NodeSessionNotice {
  kind: NodeSessionNoticeKind
  /** A wait opened by a request: the push names the request's type (and tool). */
  request?: NodeSessionPushRequest
}

const TITLE_KEY: Record<NodeSessionNoticeKind, string> = {
  needs_you: "kernel.nodeSessions.push.title",
  done: "kernel.nodeSessions.push.titleDone",
  failed: "kernel.nodeSessions.push.titleFailed",
}

/** The fixed phrase of a notice, with the session title (S16). */
const PHRASE_KEY: Record<NodeSessionNoticeKind, string> = {
  needs_you: "kernel.nodeSessions.push.needsYou",
  done: "kernel.nodeSessions.push.done",
  failed: "kernel.nodeSessions.push.failed",
}

/** The redacted line of a notice: nothing about the session. */
const GENERIC_KEY: Record<NodeSessionNoticeKind, string> = {
  needs_you: "kernel.nodeSessions.push.generic",
  done: "kernel.nodeSessions.push.genericDone",
  failed: "kernel.nodeSessions.push.genericFailed",
}

const BODY_KEY: Record<NodeSessionPushRequest["type"], string> = {
  permission_request: "kernel.nodeSessions.push.permission",
  question: "kernel.nodeSessions.push.question",
  plan_request: "kernel.nodeSessions.push.plan",
}

/** The longest prefix of `text` (whole code points) of at most `max` UTF-16 units. */
function cutAtCodePoint(text: string, max: number): string {
  let out = ""
  for (const ch of text) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out
}

/**
 * `sessionTitle` null: the redacted push (a scoped or agent_tag session), a
 * generic line that says nothing about the session or its request.
 */
export function nodeSessionPushText(
  locale: ShippedLocale,
  input: { sessionTitle: string | null; notice: NodeSessionNotice },
): { title: string; body: string } {
  const { kind, request } = input.notice
  const title = serverT(locale, TITLE_KEY[kind])
  if (input.sessionTitle === null) {
    return { title, body: serverT(locale, GENERIC_KEY[kind]) }
  }
  const sessionTitle = input.sessionTitle
  let render: (title: string) => string
  if (kind === "needs_you" && request) {
    const tool =
      request.tool && TOOL_NAME.test(request.tool)
        ? request.tool
        : serverT(locale, "kernel.nodeSessions.push.toolFallback")
    render = (title) => serverT(locale, BODY_KEY[request.type], { title, tool })
  } else {
    render = (title) => serverT(locale, PHRASE_KEY[kind], { title })
  }
  let body = render(sessionTitle)
  if (body.length > PUSH_BODY_MAX) {
    // Only the session title is cut, at a code point: the rest is the fixed wording.
    const room = Math.max(1, PUSH_BODY_MAX - render("").length)
    body = render(`${cutAtCodePoint(sessionTitle, room - 1)}…`)
  }
  return { title, body }
}

/**
 * The request that opened a wait, as the waiting hook hands it over (the P3
 * seam `onSessionWaiting(row, request)`): ids, the request's type and the
 * tool's name. Never the event payload.
 */
export interface NodeSessionWaitingRequest extends NodeSessionPushRequest {
  requestId: string
  /** The seq of the request event that took `pending_count` from 0 to 1. */
  eventSeq: number
}

/** The session columns a push reads. */
export interface NodeSessionPushRow {
  id: string
  orgId: string
  ownerUserId: string
  title: string
  source: "dispatch" | "app" | "routine" | "agent_tag" | "import"
  /** The run's job, whose source scopes decide whether the title may be shown. */
  jobId: string | null
  folderName: string | null
  repo: string | null
  /** The owner muted the session (S14): no push, computer notification or email. */
  muted?: boolean
}

export interface NodeSessionPushDeps extends PushFanoutDeps {
  /** The job's `source_required_scopes`; null when unreadable. Injected in tests. */
  jobScopes?: (orgId: string, jobId: string) => Promise<string[] | null>
}

/**
 * The sound window (S15). A session on screen on any device holds its push
 * back (the router's session presence, S13); beyond that, to bound the noise,
 * a session sounds at most once per window: a later push in the window is
 * silent and replaces the banner (same collapse id).
 */
export const NODE_SESSION_SOUND_WINDOW_S = 60

/** True when this push may sound: the first in the session's window. Fails open. */
async function takeSoundSlot(sessionId: string): Promise<boolean> {
  try {
    const set = await redis.set(
      `push:node-session:sounded:${sessionId}`,
      "1",
      "EX",
      NODE_SESSION_SOUND_WINDOW_S,
      "NX",
    )
    return set === "OK"
  } catch (err) {
    log.warn({ err, sessionId }, "node session sound window unreadable; the push sounds")
    return true
  }
}

async function readJobScopes(orgId: string, jobId: string): Promise<string[] | null> {
  const [job] = await withPrivilegedDb(orgId, "node-session-push:job-scopes", (tx) =>
    tx
      .select({ scopes: nodeJobs.sourceRequiredScopes })
      .from(nodeJobs)
      .where(and(eq(nodeJobs.id, jobId), eq(nodeJobs.orgId, orgId)))
      .limit(1),
  )
  return job && Array.isArray(job.scopes) ? job.scopes : null
}

/**
 * The title a push may show, or null for the redacted push: an agent_tag run
 * (another person's prompt), a job with source scopes, or a job that cannot
 * be read (fail closed, as push/redact.ts does).
 */
export async function pushableTitle(
  row: NodeSessionPushRow,
  deps: NodeSessionPushDeps,
): Promise<string | null> {
  if (row.source === "agent_tag" || !row.jobId) return null
  const scopes = await (deps.jobScopes ?? readJobScopes)(row.orgId, row.jobId)
  if (!Array.isArray(scopes) || scopes.length > 0) return null
  return relativizePaths(row.title, {
    sessionId: row.id,
    folderName: row.folderName,
    repo: row.repo,
  })
}

/** The router item of a session notice: its group, urgency and on-screen key (S12, S13). */
export function nodeSessionRouterItem(sessionId: string, kind: NodeSessionNoticeKind): RouterItem {
  return {
    kind: `node_session_${kind}`,
    app: "kernel",
    entityType: "node_session",
    entityId: sessionId,
    // Done is news; needs-you and failed block the person's work.
    isUrgent: kind !== "done",
    presenceKey: sessionId,
    sessionPresence: true,
  }
}

/**
 * Send one routed session push. `notifyId` names the transition, so a re-run
 * for the same transition is one send per device; `collapseId` = the session
 * id replaces the previous banner. Sounds at most once per session per
 * NODE_SESSION_SOUND_WINDOW_S. Returns the devices addressed. Never throws.
 */
export async function sendNodeSessionPush(
  decision: RouterDecision,
  row: NodeSessionPushRow,
  text: { title: string; body: string },
  notifyId: string,
  deps: NodeSessionPushDeps = {},
): Promise<number> {
  try {
    if (!decision.channels.push.deliver) return 0
    const silent = !(await takeSoundSlot(row.id))
    return await deliverPayloadToUser(
      decision,
      notifyId,
      (badgeCount) => ({
        type: "node_session",
        sessionId: row.id,
        deepLink: `${NODE_SESSION_LINK_PREFIX}${row.id}`,
        badgeCount,
        title: text.title,
        body: text.body,
        collapseId: row.id,
        // Rule 5: withdrawn on the phone once the session's notices are read.
        settle: attentionSettleKey("kernel", "node_session", row.id),
        notificationId: notificationIdFor(row.ownerUserId, notifyId),
        ...(silent ? { silent: true } : {}),
      }),
      deps,
    )
  } catch (err) {
    log.error({ err, sessionId: row.id, notifyId }, "Node session push failed")
    return 0
  }
}

/**
 * Push "a session needs you" for a wait a request opened, routed on its own:
 * the session notice group `session_needs_you`, held back while the session
 * is on screen, off when the session is muted. The notifier
 * (node-session-notify.ts) does the same with the attention row and the
 * computer notification; this is the push alone. Never throws.
 */
export async function pushNodeSessionWaiting(
  row: NodeSessionPushRow,
  request: NodeSessionWaitingRequest,
  deps: NodeSessionPushDeps = {},
): Promise<number> {
  const notifyId = nodeSessionNotifyId(row.id, "needs_you", request.eventSeq)
  try {
    const routed = await (deps.route ?? resolveChannels)(
      { userId: row.ownerUserId, orgId: row.orgId },
      nodeSessionRouterItem(row.id, "needs_you"),
    )
    const decision = row.muted ? mutedSessionDecision(routed) : routed
    if (!decision.channels.push.deliver) return 0
    const locale = await recipientLocale(row.orgId, row.ownerUserId)
    const text = nodeSessionPushText(locale, {
      sessionTitle: await pushableTitle(row, deps),
      notice: { kind: "needs_you", request: { type: request.type, tool: request.tool } },
    })
    return await sendNodeSessionPush(decision, row, text, notifyId, deps)
  } catch (err) {
    log.error({ err, sessionId: row.id, notifyId }, "Node session push failed")
    return 0
  }
}

/** The idempotency key of one notice: the session, the kind and the transition. */
export function nodeSessionNotifyId(
  sessionId: string,
  kind: NodeSessionNoticeKind,
  transition: number | string,
): string {
  return `node_session:${sessionId}:${kind}:${transition}`
}

let pushDeps: NodeSessionPushDeps = {}
let unsubscribe: (() => void) | null = null

/**
 * Subscribe the session notifier to the status hook, once: every session
 * entering needs-you, done or failed gets one notice, and every other move
 * reads the earlier ones (node-session-notify.ts). Called at boot by
 * `registerEventSubscribers`. A second call keeps the one subscription (and
 * swaps the deps when given), so this process never notifies a transition
 * twice. Returns the unsubscribe.
 */
export function registerNodeSessionPush(deps?: NodeSessionPushDeps): () => void {
  if (deps) pushDeps = deps
  if (!unsubscribe) {
    const off = onSessionStatus((row, change) => notifyNodeSessionStatus(row, change, pushDeps))
    unsubscribe = () => {
      off()
      unsubscribe = null
    }
  }
  return unsubscribe
}

/** Tests: swap the wire under the boot subscription without subscribing. */
export const NodeSessionPushTestAccess = {
  setDeps(deps: NodeSessionPushDeps): void {
    pushDeps = deps
  },
}
