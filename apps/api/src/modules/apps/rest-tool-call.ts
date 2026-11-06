// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE PLACE A REST REQUEST BECOMES A PERSON'S CLICK.
//
// Every REST route that runs a tool takes its provenance from here. On a normal
// session the request is a browser action: origin "human-ui", the person's click
// is the decision (execute-tool.ts, isDirectHumanCall).
//
// A restricted session (device flow, modules/auth/session-ceiling.ts) is a
// program holding a capped token. Nothing proves a person is behind its call, so
// it is judged as an MCP client's: gates park, outside-text taint and the host
// rules apply. Taint is judged per thread, and an MCP connection has one thread
// its reads mark. Here that is one hidden thread per sign-in, which a refresh
// keeps: the caller neither chooses it nor can shed its mark by naming another
// thread or none, so a thread it names is not used.
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import type { Context } from "hono"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { sessions, threads } from "~/db/schema/kernel"
import type { ToolOrigin } from "~/modules/apps/execute-tool"
import { insertThreadWithParticipants } from "~/modules/threads/thread"

export interface RestToolCall {
  origin: ToolOrigin
  threadId?: string | undefined
}

/** How a REST route runs a tool for this request. `requestedThreadId` is the body's. */
export async function restToolCall(
  c: Context<AppEnv>,
  requestedThreadId?: unknown,
): Promise<RestToolCall> {
  if (c.get("sessionRestricted") === true) {
    return { origin: "mcp", threadId: await restrictedSessionThread(c) }
  }
  return {
    origin: "human-ui",
    threadId: typeof requestedThreadId === "string" ? requestedThreadId : undefined,
  }
}

/**
 * The sign-in's hidden thread, created on its first tool call. A token rotates its
 * session row on refresh, the family stays. A token with no session row (an operator
 * CLI's) falls back to its user. The id derives from the key, so concurrent first calls
 * meet on the primary key and agree on one thread.
 */
async function restrictedSessionThread(c: Context<AppEnv>): Promise<string> {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const sessionId = c.get("sessionId")
  let key: string = userId
  if (sessionId) {
    const [session] = await withSystemDb("restricted-session-family", (db) =>
      db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, sessionId)),
    )
    key = session?.familyId ?? sessionId
  }
  const threadId = anchorThreadId(orgId, key)

  const exists = async () => {
    const [row] = await withPrivilegedDb(orgId, "restricted-session-thread-read", (tx) =>
      tx
        .select({ id: threads.id })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId))),
    )
    return row !== undefined
  }
  if (await exists()) return threadId
  try {
    await withPrivilegedDb(orgId, "restricted-session-thread-create", (tx) =>
      insertThreadWithParticipants(tx, {
        id: threadId,
        orgId,
        userId,
        participantIds: [userId],
        title: "Device sign-in",
        isPinned: false,
        // The row an approval hangs off and taint marks, not a conversation anyone opens.
        hiddenFromList: true,
        createdFrom: { app: "kernel", entityType: "restricted_session", entityId: key },
        type: "approval",
      }),
    )
  } catch (err) {
    // Lost the race to a concurrent first call: its thread is this one.
    if (!(await exists())) throw err
  }
  return threadId
}

/** A UUID-shaped id derived from the org and the sign-in. */
function anchorThreadId(orgId: string, key: string): string {
  const hex = createHash("sha256").update(`restricted-session-thread:${orgId}:${key}`).digest("hex")
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
