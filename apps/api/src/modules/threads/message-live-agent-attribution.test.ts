// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIVE ATTRIBUTION. A message that arrives over the socket must name the agent
// that spoke, exactly as a refetch names it. The row already carried
// `authorAgentId` (FX4), but the event's `authorName` was resolved as
// `agentAuthorLabel ?? "Liaison"` while the list read resolved
// `agentAuthorLabel ?? <the agent's display name> ?? "Liaison"`. The middle
// term was missing, so every agent reply streamed in labelled "Liaison" (the
// personal agent's own display name, which is why the viewer read it as their
// own agent answering) and only became "Support Desk" on reload, and two agents
// in one room were both "Liaison" until reload.
//
// The assertion is parity: the queued event and `listMessages` must agree on
// the name for the same row.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents, threadParticipants, threads } from "~/db/schema/kernel"
import { listMessages, sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("the live message event names the agent that spoke", () => {
  let orgId: string
  let userId: string
  let threadId: string
  let supportAgentId: string
  let financeAgentId: string

  const actor = (): UserContext => ({
    actorType: "user",
    userId,
    orgId,
    scopes: ["kernel:threads:read", "kernel:threads:write"],
    dimensionGrants: {},
  })

  /** The `message:create` the send actually queued, read back out of the outbox. */
  async function queuedCreate(messageId: string): Promise<any> {
    const rows = await sql<{ payload: any }[]>`
      SELECT payload FROM kernel.pending_events
      WHERE payload->>'app' = 'kernel'
        AND payload->>'entity' = 'message'
        AND payload->>'action' = 'create'
        AND payload->>'entityId' = ${messageId}
      ORDER BY seq DESC LIMIT 1`
    if (rows.length === 0) throw new Error(`no queued message:create for ${messageId}`)
    return rows[0].payload.data
  }

  /** What a refetch would show for that row. */
  async function refetchedName(messageId: string): Promise<string> {
    const page = await withRlsContext(actor(), (tx) =>
      listMessages(tx, { orgId, userId, threadId, limit: 50 }),
    )
    const row = page?.messages.find((m: { id: string }) => m.id === messageId)
    if (!row) throw new Error(`message ${messageId} not visible on refetch`)
    return row.authorName
  }

  async function postAsAgent(
    content: string,
    agentId: string,
    agentAuthorLabel?: string,
  ): Promise<string> {
    const sent = await withPrivilegedDb(orgId, "test-mlaa-send", (tx) =>
      sendMessage(tx as never, {
        orgId,
        userId,
        threadId,
        content,
        authorType: "agent",
        agentId,
        agentAuthorLabel,
        requiredScopes: [],
      }),
    )
    if (!sent) throw new Error("agent message was not persisted")
    return sent.id
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    const user = await minimal.person(orgId)
    userId = user.id
    await withPrivilegedDb(orgId, "test-mlaa-seed", async (tx) => {
      const [support] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "role",
          handle: `@mlaa-support-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Support Desk",
        })
        .returning({ id: agents.id })
      supportAgentId = support.id
      const [finance] = await tx
        .insert(agents)
        .values({
          orgId,
          kind: "role",
          handle: `@mlaa-finance-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Finance Desk",
        })
        .returning({ id: agents.id })
      financeAgentId = finance.id
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `mlaa-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy: userId,
        })
        .returning({ id: threads.id })
      threadId = t.id
      await tx.insert(threadParticipants).values({ threadId, userId, orgId })
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${orgId}`
    await releaseTestLock()
  })

  it("an agent reply streams in under the acting agent's name, not the generic one", async () => {
    const id = await postAsAgent("PONG", supportAgentId)
    const data = await queuedCreate(id)
    expect(data.authorAgentId).toBe(supportAgentId)
    expect(data.authorName).toBe("Support Desk")
    expect(data.authorName).not.toBe("Liaison")
    // Parity with the reload that used to be the only way to see the real name.
    expect(data.authorName).toBe(await refetchedName(id))
  })

  it("two agents in one room each stream in under their own name", async () => {
    const supportId = await postAsAgent("support here", supportAgentId)
    const financeId = await postAsAgent("finance here", financeAgentId)
    expect((await queuedCreate(supportId)).authorName).toBe("Support Desk")
    expect((await queuedCreate(financeId)).authorName).toBe("Finance Desk")
    expect(await refetchedName(financeId)).toBe("Finance Desk")
  })

  it("a persisted attribution label still wins over the agent's display name", async () => {
    const id = await postAsAgent("digest", supportAgentId, "Routine daily-digest")
    expect((await queuedCreate(id)).authorName).toBe("Routine daily-digest")
    expect(await refetchedName(id)).toBe("Routine daily-digest")
  })

  /**
   * A RENAME REACHES THE TURNS THE AGENT ALREADY WROTE.
   *
   * Every agent post persists the agent's display name into
   * `metadata.agentAuthorLabel`, and that copy used to win the read outright.
   * Migration 0100 renamed the default personal agent from "Liaison" to
   * "Personal agent" and the rows written before it went on saying "Liaison",
   * so one DM showed the same agent under two names depending on when each
   * turn was written. An owner renaming their own agent did the same thing.
   */
  it("a renamed agent's older turns are read under the new name", async () => {
    const id = await postAsAgent("before the rename", financeAgentId, "Finance Desk")
    expect(await refetchedName(id)).toBe("Finance Desk")

    await withPrivilegedDb(orgId, "test-mlaa-rename", (tx) =>
      tx
        .update(agents)
        .set({ displayName: "Operations Desk" })
        .where(eq(agents.id, financeAgentId)),
    )
    try {
      expect(await refetchedName(id)).toBe("Operations Desk")
      // And the run attribution is still the one thing a rename cannot move:
      // "Routine daily-digest" names the run, not the speaker.
      const routineId = await postAsAgent("digest", financeAgentId, "Routine daily-digest")
      expect(await refetchedName(routineId)).toBe("Routine daily-digest")
    } finally {
      await withPrivilegedDb(orgId, "test-mlaa-rename-undo", (tx) =>
        tx.update(agents).set({ displayName: "Finance Desk" }).where(eq(agents.id, financeAgentId)),
      )
    }
  })

  it("a human message is unaffected and still carries the member's own name", async () => {
    const sent = await withRlsContext(actor(), (tx) =>
      sendMessage(tx, { orgId, userId, threadId, content: "hello", requiredScopes: [] }),
    )
    const data = await queuedCreate(sent!.id)
    expect(data.authorType).toBe("user")
    expect(data.authorAgentId).toBeNull()
    expect(data.authorName).not.toBe("Liaison")
    expect(data.authorName).toBe(await refetchedName(sent!.id))
  })
})
