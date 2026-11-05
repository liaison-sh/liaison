// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, desc, eq, isNull } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { mcpConnections, messages } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { insertThreadWithParticipants } from "~/modules/threads/thread"

/**
 * Lazily provisions the single discussion/approval thread for an MCP
 * connection. Only invoked on the first gated call (read-only connections
 * never get a threadId). Single-thread guarantee under a self-race: the
 * guarded UPDATE ... WHERE thread_id IS NULL claims the slot; a loser re-reads
 * the winner's threadId.
 */
export async function ensureConnectionThread(
  connectionId: string,
  orgId: string,
  ownerUserId: string,
): Promise<string> {
  const [conn] = await withSystemDb("mcp-conn-thread-load", (db) =>
    db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId)),
  )
  if (!conn) throw new Error("mcp connection not found")
  if (conn.threadId) return conn.threadId

  // Create the thread (type "approval", consistent with the approval anchors
  // execute-tool.ts creates). Hidden from every sidebar list: it is the row an
  // approval and its turn messages hang off, not a conversation anyone opens.
  const { thread } = await withPrivilegedDb(orgId, "mcp-conn-thread-create", (tx) =>
    insertThreadWithParticipants(tx, {
      orgId,
      userId: ownerUserId,
      participantIds: [ownerUserId],
      title: "MCP connection",
      isPinned: false,
      hiddenFromList: true,
      createdFrom: { app: "kernel", entityType: "mcp_connection", entityId: connectionId },
      type: "approval",
    }),
  )

  const [claimed] = await withSystemDb("mcp-conn-thread-claim", (db) =>
    db
      .update(mcpConnections)
      .set({ threadId: thread.id })
      .where(and(eq(mcpConnections.id, connectionId), isNull(mcpConnections.threadId)))
      .returning(),
  )
  if (claimed?.threadId) return claimed.threadId

  // Lost the race — another concurrent call already set the threadId.
  const [fresh] = await withSystemDb("mcp-conn-thread-reread", (db) =>
    db
      .select({ threadId: mcpConnections.threadId })
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId)),
  )
  if (!fresh?.threadId) {
    // Extremely unlikely; surface explicitly rather than returning a wrong id.
    throw new Error("mcp connection thread not set after claim race")
  }
  // The thread we created is now orphaned (cheap; an empty approval thread).
  return fresh.threadId
}

/**
 * The message an MCP turn hangs under, or null when the connection thread holds
 * none yet.
 *
 * An external client's turn has no triggering message of its own: nothing in an
 * MCP request is a row in the room. What the room does hold is the last thing a
 * PERSON or the system put in it at the top level (a question, an approval
 * line), and that is the turn a question asked now belongs to. Anchoring to it
 * is what makes consecutive asks on one connection ONE exchange the per root cap
 * can count, instead of a fresh root every time that no cap ever reaches.
 *
 * Agent authored rows are excluded deliberately: an agent's own question is a
 * relay link, and anchoring the next question to it would read as a chain of
 * agents passing the question on, which is not what happened.
 */
export async function connectionThreadTurnMessageId(
  orgId: string,
  threadId: string,
): Promise<string | undefined> {
  const [row] = await withPrivilegedDb(orgId, "mcp-conn-thread-turn", (tx) =>
    tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.orgId, orgId),
          eq(messages.threadId, threadId),
          isNull(messages.parentMessageId),
          isNull(messages.authorAgentId),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1),
  )
  return row?.id
}

/** How long a connection must be quiet before its next handshake counts as a new conversation. */
export const CONNECTION_IDLE_RESET_SECONDS = 4 * 60 * 60
const activityKey = (connectionId: string) => `mcp:active:${connectionId}`

/** Does this JSON-RPC body carry the `initialize` handshake? A batch counts when any message does. */
export function isSessionStart(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body]
  return msgs.some(
    (m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === "initialize",
  )
}

/**
 * The untrusted-content mark of a connection's thread, per request. The transport is stateless,
 * so nothing in a request tells a new client conversation from a reconnect of one whose context
 * still holds outside text: a handshake alone never clears the mark. A handshake after the
 * connection was quiet for {@link CONNECTION_IDLE_RESET_SECONDS} does: a conversation that went
 * silent that long has ended, and its client starts fresh. Every request (tool calls included)
 * restarts the quiet period, so a call in flight or a live conversation keeps its mark.
 */
export async function noteConnectionRequest(
  connectionId: string,
  orgId: string,
  body: unknown,
): Promise<void> {
  const key = activityKey(connectionId)
  const wasActive = (await redis.exists(key)) === 1
  await redis.set(key, "1", "EX", CONNECTION_IDLE_RESET_SECONDS)
  if (wasActive || !isSessionStart(body)) return
  const [conn] = await withSystemDb("mcp-conn-idle-reset", (db) =>
    db
      .select({ threadId: mcpConnections.threadId })
      .from(mcpConnections)
      .where(and(eq(mcpConnections.id, connectionId), eq(mcpConnections.orgId, orgId))),
  )
  if (!conn?.threadId) return
  const { clearTaintFlag } = await import("~/modules/agent/scopes/taint")
  await clearTaintFlag(conn.threadId, orgId)
}
