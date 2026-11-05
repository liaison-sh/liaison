// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The computer session notices (round 2, S12-S16): a session that needs its
 * owner, is done or failed tells them once, on the channels their grid and
 * the router allow, and every other move of the session reads the notices
 * it made earlier.
 *
 * Subscribed to the status hook (`onSessionStatus`) by
 * `registerNodeSessionPush`. On every status change of a session:
 *   0. the session's unread notice rows of the other kinds are read (all
 *      three when it enters queued, running, paused or stopped);
 *   1. a change the owner caused (Mark done, Stop, a message) ends there: no
 *      notice on any channel and no new row (D19);
 *   2. entering the needs-you group (`waiting` or `needs_you`), `done` or
 *      `failed`: one attention row (upsert per kind), and when that row is
 *      new, one push and one computer notification. A muted session keeps
 *      the row only (S14); a session on screen holds push and computer back
 *      (the router's session presence, S13).
 *
 * Only the owner is ever told, and model-written text (the mark_done
 * summary, the needs-you reason, the last-message fallback) never reaches a
 * push, a computer notification or an email: those carry the session title
 * under the push redaction rule and a fixed phrase (S16). The attention row's
 * body (metadata.body, the in-app feed only) may quote it, bounded by
 * `sessionWords` and labelled as the session's words.
 */
import type { NodeSessionStatus, ShippedLocale } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { defaultInsertAttentionRow } from "~/modules/attention/translator"
import { serverT } from "~/modules/i18n/server-i18n"
import type { NodeSessionRow } from "~/modules/node-sessions/store"
import type { SessionStatusChange } from "~/modules/node-sessions/waiting-hook"
import { recordDeliveries, routerSuppressionRecords } from "~/modules/notifications/delivery-log"
import { onDesktopDecision } from "~/modules/notifications/desktop-hook"
import { attentionRoute, emailEnqueue } from "~/modules/notifications/dispatch"
import { mutedSessionDecision, resolveChannels } from "~/modules/notifications/router"
import { recipientLocale } from "~/modules/push/fanout-consumer"
import {
  type NodeSessionNotice,
  type NodeSessionNoticeKind,
  type NodeSessionPushDeps,
  nodeSessionNotifyId,
  nodeSessionPushText,
  nodeSessionRouterItem,
  pushableTitle,
  sendNodeSessionPush,
} from "~/modules/push/node-session-push"

const K = sql.raw(schemaRef("kernel"))
const log = rootLogger.child({ module: "node-session-notify" })

const NOTICE_KINDS: readonly NodeSessionNoticeKind[] = ["needs_you", "done", "failed"]

/** The attention kind of a notice (groups.ts `NODE_SESSION_NOTICE_KINDS`). */
const attentionKind = (kind: NodeSessionNoticeKind) => `node_session_${kind}`

/** The urgency of each notice's attention row (urgent ones ignore quiet time). */
const URGENCY: Record<NodeSessionNoticeKind, number> = { needs_you: 80, done: 50, failed: 80 }

/** The web tab a notice opens (web notifications/thread-on-screen.ts `SESSION_TAB_TYPE`). */
const SESSION_TAB_TYPE = "kernel:session"

/** The most model-written characters a notice quotes. */
export const SESSION_WORDS_MAX = 300

/** The notice a status entered, or null for a status that tells nobody. */
function noticeKindOf(to: NodeSessionStatus): NodeSessionNoticeKind | null {
  if (to === "waiting" || to === "needs_you") return "needs_you"
  if (to === "done") return "done"
  if (to === "failed") return "failed"
  return null
}

/** The longest prefix of `text` (whole code points) of at most `max` UTF-16 units. */
function clipAtCodePoint(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ""
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out}…`
}

/**
 * Model-written text made safe to quote (S16, A11): images dropped, links
 * reduced to their text, HTML tags, Markdown emphasis and code marks removed,
 * every URL removed (nothing renders as a link), control characters turned to
 * spaces, whitespace collapsed, clipped to SESSION_WORDS_MAX characters.
 * Empty when nothing readable is left.
 */
export function sessionWords(text: string): string {
  const plain = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ")
    .replace(/\b(?:javascript|data|vbscript|mailto|file):\S*/gi, " ")
    .replace(/\bwww\.\S+/gi, " ")
    .replace(/(\*\*|__|~~|`+)/g, "")
    .replace(/(^|\s)#{1,6}\s/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  return clipAtCodePoint(plain, SESSION_WORDS_MAX)
}

/**
 * The in-app body of a notice: the fixed line, then the session's own words
 * under the "The session says:" label when it left any.
 */
export function nodeSessionNoticeBody(
  locale: ShippedLocale,
  line: string,
  modelText: string | null,
): string {
  const words = modelText ? sessionWords(modelText) : ""
  if (!words) return line
  return `${line}\n${serverT(locale, "kernel.nodeSessions.notice.sessionSays", { text: words })}`
}

/**
 * Read the session's unread notice rows of `kinds` (one UPDATE, the owner's
 * rows only). Never throws.
 */
async function readNotices(row: NodeSessionRow, kinds: readonly NodeSessionNoticeKind[]) {
  if (kinds.length === 0) return
  const list = sql.join(
    kinds.map((k) => sql`${attentionKind(k)}`),
    sql`, `,
  )
  try {
    await withPrivilegedDb(row.orgId, "node-session-notify:read", (tx) =>
      tx.execute(sql`
        UPDATE ${K}.attention_events
           SET read_at = now()
         WHERE org_id = ${row.orgId}
           AND user_id = ${row.ownerUserId}
           AND app = 'kernel'
           AND entity_type = 'node_session'
           AND entity_id = ${row.id}
           AND kind IN (${list})
           AND read_at IS NULL`),
    )
  } catch (err) {
    log.warn({ err, sessionId: row.id }, "session notices could not be read")
  }
}

/** Which transition a notice is: its request event, else the session's end, else its sequence. */
function transitionKey(row: NodeSessionRow, change: SessionStatusChange): number {
  if (change.becameWaiting) return change.becameWaiting.eventSeq
  if (change.to !== "waiting" && row.endedAt) return row.endedAt.getTime()
  return row.lastSeq
}

export interface NodeSessionNotifyDeps extends NodeSessionPushDeps {
  now?: () => Date
}

/**
 * Handle one status change of a session (see the module comment). Never
 * throws: a notice is not worth failing the path that moved the session.
 */
export async function notifyNodeSessionStatus(
  row: NodeSessionRow,
  change: SessionStatusChange,
  deps: NodeSessionNotifyDeps = {},
): Promise<void> {
  const kind = noticeKindOf(change.to)
  await readNotices(
    row,
    NOTICE_KINDS.filter((k) => k !== kind),
  )
  if (!kind || change.cause === "owner" || change.cause === "follow") return

  const notifyId = nodeSessionNotifyId(row.id, kind, transitionKey(row, change))
  try {
    const at = (deps.now ?? (() => new Date()))()
    const routed = await (deps.route ?? resolveChannels)(
      { userId: row.ownerUserId, orgId: row.orgId },
      nodeSessionRouterItem(row.id, kind),
    )
    const decision = row.muted ? mutedSessionDecision(routed) : routed
    if (!decision.channels.in_app.deliver) return

    const locale = await recipientLocale(row.orgId, row.ownerUserId)
    const notice: NodeSessionNotice = change.becameWaiting
      ? {
          kind,
          request: { type: change.becameWaiting.type, tool: change.becameWaiting.tool },
        }
      : { kind }
    const text = nodeSessionPushText(locale, {
      sessionTitle: await pushableTitle(row, deps),
      notice,
    })
    const email = emailEnqueue(decision, at)
    const stored = await defaultInsertAttentionRow({
      orgId: row.orgId,
      userId: row.ownerUserId,
      app: "kernel",
      entityType: "node_session",
      entityId: row.id,
      kind: attentionKind(kind),
      urgency: URGENCY[kind],
      // The feed line and the digest email's line: title and fixed phrase only.
      summary: text.body,
      actorId: null,
      actorType: "system",
      metadata: {
        ...(decision.channels.in_app.quiet ? { quiet: true } : {}),
        link: { tabType: SESSION_TAB_TYPE, entityId: row.id },
        body: nodeSessionNoticeBody(
          locale,
          text.body,
          kind === "failed" ? null : row.resultSummary,
        ),
      },
      occurredAt: at,
      isUrgent: kind !== "done",
      digestState: email.digestState,
      digestEligibleAt: email.digestEligibleAt,
    })
    // The same notice again (a re-fired transition, or a session still in the
    // state an unread row already announces) updates its row and says nothing.
    if (!stored.inserted) return

    // W1-D8: what the router held back (on screen S13, muted S14, grid, quiet
    // time) is logged as fanout-consumer.ts logs it, before anything is sent.
    await recordDeliveries(routerSuppressionRecords(decision, notifyId))
    await sendNodeSessionPush(decision, row, text, notifyId, deps)
    await onDesktopDecision(decision, {
      notifyId,
      title: text.title,
      body: text.body,
      route: attentionRoute({ app: "kernel", entityType: "node_session", entityId: row.id }),
    })
  } catch (err) {
    log.error({ err, sessionId: row.id, notifyId }, "session notice failed")
  }
}
