// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The finished session posts back into its conversation (S60, D36b).
 *
 * A `dispatch` session (started by `run_on_my_computer` from a conversation)
 * that ends `done` by its own signal (`mark_done`, or Atelier's `complete`)
 * posts one agent message into the thread that dispatched it, under the
 * session's card: a fixed localized lead line, the session's own words
 * (clipped and stripped by `sessionWords`, fenced as session data), and the
 * pull request link the node verified (an `https:` one, fenced the same way). So the agent
 * and the person see the result without opening the card.
 *
 * Nothing is posted for a change the owner caused (Mark done, Stop: D19), for
 * `needs_you`, `failed` or `stopped`, nor for an app session (no source
 * thread).
 *
 * Once per session end (A38): before writing, one atomic claim stores the
 * end being posted (`posted_back_ended_at = ended_at`); a transition that
 * finds that end already claimed writes nothing. A session reopened and
 * ended again has a new `ended_at` and posts again. A crash between the claim
 * and the post loses that post (logged), never doubles it.
 *
 * Untrusted content: the post is an AGENT-authored message, which main's
 * untrusted-content rule already treats as outside text wherever it matters
 * (an agent's thread post is an external trigger for routines, and the taint
 * mark covers a turn, not the thread's life), and the session's words inside
 * it are fenced `<session-data>` with every angle bracket neutralised.
 *
 * Subscribed to the status hook by `registerNodeSessionPostBack`; never
 * throws into it (log and drop, as the notifier).
 */
import type { ShippedLocale } from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents, messages, nodeJobs, nodeSessions, nodes } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { persistAgentTurn } from "~/modules/agent/runtime/persist-agent-turn"
import { serverT } from "~/modules/i18n/server-i18n"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { recipientLocale } from "~/modules/push/fanout-consumer"
import { sessionWords } from "~/modules/push/node-session-notify"
import { fence } from "./agent-tools"
import type { NodeSessionRow } from "./store"
import { onSessionStatus, type SessionStatusChange } from "./waiting-hook"

const log = rootLogger.child({ module: "node-session-post-back" })

/** The metadata kind of a post-back message. */
export const NODE_SESSION_RESULT_KIND = "node_session_result"

/** An `https:` URL, else null (anything else is never linked). */
function httpsUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    return new URL(raw).protocol === "https:" ? raw : null
  } catch {
    return null
  }
}

/**
 * W2-D8: the words with a link label the URL removal left dangling at their
 * end ("… 3/3 passing. PR:"): the link itself is the post's own PR line.
 * Only a label with its colon: a sentence that ends on the word ("Fixed the
 * broken link") is the session's own and kept whole.
 */
function withoutDanglingLinkLabel(words: string): string {
  return words.replace(/\s*\b(?:PR|MR|pull request|merge request|link|url)\s*:\s*$/i, "").trim()
}

/** W2-D8: the title's own end punctuation, so the line never ends "..". */
function titleForLine(title: string): string {
  return title.replace(/[\s.!?…:;,]+$/u, "") || title
}

/** The post's text, in the owner's locale (see the module comment). */
export function postBackContent(
  locale: ShippedLocale,
  input: { nodeName: string | null; title: string; summary: string | null; prUrl: string | null },
): string {
  const title = titleForLine(input.title)
  const lines = [
    input.nodeName
      ? serverT(locale, "kernel.nodeSessions.postBack.done", {
          node: input.nodeName,
          title,
        })
      : serverT(locale, "kernel.nodeSessions.postBack.doneNoNode", { title }),
  ]
  const words = input.summary ? withoutDanglingLinkLabel(sessionWords(input.summary)) : ""
  if (words) {
    lines.push(serverT(locale, "kernel.nodeSessions.postBack.sessionSays", { text: fence(words) }))
  }
  const url = httpsUrl(input.prUrl)
  // The link is the session's too: fenced like its words (D43).
  if (url) lines.push(serverT(locale, "kernel.nodeSessions.postBack.pr", { url: fence(url) }))
  return lines.join("\n")
}

/** Whether this status change is one S60 posts for. */
function postsBack(row: NodeSessionRow, change: SessionStatusChange): boolean {
  return (
    change.to === "done" &&
    change.cause !== "owner" &&
    change.cause !== "follow" &&
    row.source === "dispatch" &&
    !!row.sourceThreadId
  )
}

/**
 * Handle one status change (see the module comment). Never throws.
 */
export async function postBackSessionResult(
  row: NodeSessionRow,
  change: SessionStatusChange,
): Promise<void> {
  if (!postsBack(row, change)) return
  const threadId = row.sourceThreadId as string
  try {
    // The reply scope is the job's (A18: what the dispatching turn had read,
    // joined by every later turn that steered it); no job, no known scope.
    if (!row.jobId) {
      log.warn({ sessionId: row.id }, "post-back skipped: the session has no job")
      return
    }
    const [job] = await withPrivilegedDb(row.orgId, "node-session-post-back:job", (tx) =>
      tx
        .select({ scopes: nodeJobs.sourceRequiredScopes })
        .from(nodeJobs)
        .where(and(eq(nodeJobs.id, row.jobId as string), eq(nodeJobs.orgId, row.orgId))),
    )
    if (!job) {
      log.warn({ sessionId: row.id }, "post-back skipped: the session's job is gone")
      return
    }

    // A38: the one claim of this end. No row: another transition posted it,
    // or the session is no longer ended done.
    const [claimed] = await withPrivilegedDb(row.orgId, "node-session-post-back:claim", (tx) =>
      tx
        .update(nodeSessions)
        .set({ postedBackEndedAt: sql`${nodeSessions.endedAt}` })
        .where(
          and(
            eq(nodeSessions.id, row.id),
            eq(nodeSessions.orgId, row.orgId),
            eq(nodeSessions.status, "done"),
            sql`${nodeSessions.endedAt} IS NOT NULL`,
            sql`${nodeSessions.postedBackEndedAt} IS DISTINCT FROM ${nodeSessions.endedAt}`,
          ),
        )
        .returning(),
    )
    if (!claimed) return

    const [card] = claimed.sourceMessageId
      ? await withPrivilegedDb(row.orgId, "node-session-post-back:card", (tx) =>
          tx
            .select({ id: messages.id, replyRootId: messages.replyRootId })
            .from(messages)
            .where(
              and(
                eq(messages.id, claimed.sourceMessageId as string),
                eq(messages.orgId, row.orgId),
              ),
            )
            .limit(1),
        )
      : []
    const [agent] = await withSystemDb("node-session-post-back:agent", (tx) =>
      tx
        .select({ displayName: agents.displayName })
        .from(agents)
        .where(and(eq(agents.id, claimed.agentId), eq(agents.orgId, row.orgId)))
        .limit(1),
    )
    const [node] = claimed.nodeId
      ? await withPrivilegedDb(row.orgId, "node-session-post-back:node", (tx) =>
          tx
            .select({ name: nodes.name })
            .from(nodes)
            .where(and(eq(nodes.id, claimed.nodeId as string), eq(nodes.orgId, row.orgId)))
            .limit(1),
        )
      : []
    const locale = await recipientLocale(row.orgId, claimed.ownerUserId)
    const prUrl = httpsUrl(claimed.prUrl)
    const content = postBackContent(locale, {
      nodeName: node?.name ?? null,
      title: claimed.title,
      summary: claimed.resultSummary,
      prUrl,
    })

    // Written as the owner, under their own RLS: the post lands only where
    // they may post, readable only by who may read what the session was
    // asked from.
    const perms = await withPrivilegedDb(row.orgId, "node-session-post-back:perms", (tx) =>
      loadEffectivePermissions(tx, claimed.ownerUserId, row.orgId),
    )
    const sent = await persistAgentTurn({
      // The computer session's result, posted back where it was asked: the end of the job.
      endsTurn: true,
      write: (fn) =>
        withRlsContext(
          {
            actorType: "user",
            userId: claimed.ownerUserId,
            orgId: row.orgId,
            scopes: perms.scopes,
            dimensionGrants: perms.dimensionGrants,
          },
          (tx) => fn(tx),
        ),
      orgId: row.orgId,
      userId: claimed.ownerUserId,
      threadId,
      content,
      agentId: claimed.agentId,
      ...(agent?.displayName ? { agentAuthorLabel: agent.displayName } : {}),
      requiredScopes: job.scopes ?? [],
      parentMessageId: card?.id ?? null,
      replyRootId: card?.replyRootId ?? null,
      metadata: {
        kind: NODE_SESSION_RESULT_KIND,
        sessionId: row.id,
        ...(prUrl ? { prUrl } : {}),
      },
    })
    if (!sent) log.warn({ sessionId: row.id }, "post-back refused by the thread's write path")
  } catch (err) {
    log.error({ err, sessionId: row.id }, "post-back failed")
  }
}

let unsubscribe: (() => void) | null = null

/**
 * Subscribe the post-back to the status hook, once (a second call keeps the
 * one subscription). Called at boot by `registerEventSubscribers`, beside the
 * session notifier. Returns the unsubscribe.
 */
export function registerNodeSessionPostBack(): () => void {
  if (!unsubscribe) {
    const off = onSessionStatus((row, change) => postBackSessionResult(row, change))
    unsubscribe = () => {
      off()
      unsubscribe = null
    }
  }
  return unsubscribe
}
