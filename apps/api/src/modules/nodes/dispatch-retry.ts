// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "START AGAIN" ON A BLOCKED DISPATCH (owner-only, any device).
 *
 * When run_on_my_computer was refused because a folder was not shared, it
 * posted one `node_dispatch_blocked` card in the conversation. Once the owner
 * shared the folder (from the card's "Fix it", on any device), the card's
 * "Start again" dispatches the same request once more, as the same agent, in
 * the same conversation, at the same visibility (the card's own required
 * scopes): exactly what the agent would have done.
 *
 *   POST /api/nodes/dispatch-blocked/:messageId/retry
 *     201 {sessionId}                 started (the card is claimed first, atomically)
 *     200 {sessionId, already: true}  another tap already started it
 *     409 {code: still_not_shared | refused | in_progress, reason?}
 *     404 not_found                   not a blocked card of yours
 *
 * The card is claimed (`retriedSessionId: "pending"`, set only where none is)
 * before anything is dispatched, so two taps never start two sessions; a
 * dispatch that does not start releases the claim.
 */
import { and, eq, isNull, sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { messages } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { assertUnrestrictedSession } from "~/modules/auth/session-ceiling"
import { NODE_CREDENTIAL_HEADER } from "./credentials"
import { handleRunOnMyComputer } from "./run-on-my-computer"

const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  error: { code, message, ...extra },
})

interface BlockedMeta {
  kind: "node_dispatch_blocked"
  ownerUserId: string
  name: string
  field: "folder" | "repo"
  task: string
  model?: string
  agentId: string
  retriedSessionId?: string
}

function blocked(meta: unknown): BlockedMeta | null {
  const m = meta as Partial<BlockedMeta> | null
  if (m?.kind !== "node_dispatch_blocked") return null
  if (
    typeof m.ownerUserId !== "string" ||
    typeof m.name !== "string" ||
    typeof m.task !== "string" ||
    typeof m.agentId !== "string" ||
    (m.field !== "folder" && m.field !== "repo")
  ) {
    return null
  }
  return m as BlockedMeta
}

/** The card's mark while one tap is starting it again. */
const PENDING = "pending"

export const dispatchRetryRoutes = new Hono<AppEnv>()

dispatchRetryRoutes.post(
  "/dispatch-blocked/:messageId/retry",
  zValidator("param", z.object({ messageId: z.string().uuid() })),
  async (c) => {
    if (c.req.header(NODE_CREDENTIAL_HEADER) !== undefined) {
      return c.json(err("node_credential_refused", "Start it again in the app."), 403)
    }
    assertUnrestrictedSession(c, "start a session on your computer")
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const messageId = c.req.valid("param").messageId
    // The card as the caller can read it (their own conversation's RLS).
    const card = await withRequestRls(c, async (tx) => {
      const [row] = await tx
        .select({
          threadId: messages.threadId,
          metadata: messages.metadata,
          requiredScopes: messages.requiredScopes,
        })
        .from(messages)
        .where(
          and(eq(messages.id, messageId), eq(messages.orgId, orgId), isNull(messages.deletedAt)),
        )
        .limit(1)
      return row ?? null
    })
    const meta = blocked(card?.metadata)
    if (!card || !meta || meta.ownerUserId !== userId) {
      return c.json(err("not_found", "No such card of yours."), 404)
    }
    const startedBefore = (id: string) =>
      success(c, { sessionId: id, already: true }, undefined, 200)
    if (meta.retriedSessionId && meta.retriedSessionId !== PENDING) {
      return startedBefore(meta.retriedSessionId)
    }
    // Claimed atomically: only one tap dispatches.
    const claimed = await withPrivilegedDb(orgId, "node-dispatch-retry-claim", (tx) =>
      tx
        .update(messages)
        .set({
          metadata: sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ retriedSessionId: PENDING })}::jsonb`,
        })
        .where(
          and(
            eq(messages.id, messageId),
            eq(messages.orgId, orgId),
            sql`${messages.metadata}->>'retriedSessionId' IS NULL`,
          ),
        )
        .returning({ id: messages.id }),
    )
    if (claimed.length === 0) {
      // Another tap holds it: answer its session once it has one.
      for (let i = 0; i < 80; i++) {
        const id = await markOf(orgId, messageId)
        if (id && id !== PENDING) return startedBefore(id)
        if (!id) break
        await new Promise((r) => setTimeout(r, 100))
      }
      return c.json(err("in_progress", "It is being started again."), 409)
    }
    let answer: Awaited<ReturnType<typeof handleRunOnMyComputer>>
    try {
      answer = await withRequestRls(c, (tx) =>
        handleRunOnMyComputer(
          {
            task: meta.task,
            ...(meta.field === "folder" ? { folder: meta.name } : { repo: meta.name }),
            ...(meta.model ? { model: meta.model } : {}),
          },
          {
            userId,
            orgId,
            db: tx,
            agentExecutionThreadId: card.threadId,
            scopes: card.requiredScopes,
            actingAgentId: meta.agentId,
            retry: true,
          },
        ),
      )
    } catch (error) {
      await setMark(orgId, messageId, null)
      throw error
    }
    if (answer.status !== "started" || !answer.sessionId) {
      await setMark(orgId, messageId, null)
      return c.json(
        err(
          answer.reason === "folder_unresolved" ? "still_not_shared" : "refused",
          "It did not start.",
          { reason: answer.reason ?? null },
        ),
        409,
      )
    }
    await setMark(orgId, messageId, answer.sessionId)
    return success(c, { sessionId: answer.sessionId }, undefined, 201)
  },
)

/** The card's mark: a session id, PENDING, or null. */
async function markOf(orgId: string, messageId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "node-dispatch-retry-read", (tx) =>
    tx
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)))
      .limit(1),
  )
  const id = (row?.metadata as { retriedSessionId?: unknown } | null)?.retriedSessionId
  return typeof id === "string" ? id : null
}

/** Sets the card's mark to a session id, or releases it (null). */
async function setMark(orgId: string, messageId: string, sessionId: string | null): Promise<void> {
  await withPrivilegedDb(orgId, "node-dispatch-retry-mark", (tx) =>
    tx
      .update(messages)
      .set({
        metadata:
          sessionId === null
            ? sql`coalesce(${messages.metadata}, '{}'::jsonb) - 'retriedSessionId'`
            : sql`coalesce(${messages.metadata}, '{}'::jsonb) || ${JSON.stringify({ retriedSessionId: sessionId })}::jsonb`,
      })
      .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId))),
  )
}
