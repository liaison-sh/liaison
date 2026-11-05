// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A new thread's first message goes through the same mandatory requiredScopes
// field as sendMessage, on both createThread paths (a new thread, and the DM
// path that forwards into an existing one), and its message:create event
// carries the scopes for the websocket fan-out.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { createThread } from "~/modules/threads/thread"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// The privileged handle stands in for an RLS client; its transactions record
// queued events in memory instead of writing the outbox.
const publishedEvents: any[] = []
const rlsDb = new Proxy(db, {
  get(target, prop) {
    if (prop === "transaction") {
      return (fn: (tx: any) => Promise<unknown>) =>
        target.transaction(async (tx: any) => {
          tx.queueEvent = async (event: unknown) => {
            publishedEvents.push(event)
          }
          return fn(tx)
        })
    }
    const value = Reflect.get(target, prop)
    return typeof value === "function" ? value.bind(target) : value
  },
}) as unknown as RlsClient

const ORG = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const LACKER = crypto.randomUUID()
const OWNER_AGENT = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const SCOPE = "crm:deals:read"

async function visibleIds(userId: string, scopes: string[], threadId: string): Promise<string[]> {
  return withRlsContext(
    { actorType: "user", userId, orgId: ORG, scopes, dimensionGrants: {} },
    async (tx) =>
      (
        await tx.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId))
      ).map((r) => r.id),
  )
}

describe("createThread: the initial message carries its requiredScopes", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'InitMsgScopesOrg', ${`init-msg-scopes-${tag}`})`
    for (const [id, name] of [
      [OWNER, "owner"],
      [LACKER, "lacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${`init-msg-${name}-${tag}@test.com`}, ${name}, 'active', 'x')`
    }
    // The owner's personal agent: an agent-authored row names the agent that
    // spoke (0080), and every registered user has one.
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${OWNER_AGENT}, ${ORG}, 'personal', ${`@init-msg-${tag}`}, 'Owner agent', ${OWNER})`
  })

  beforeEach(() => {
    publishedEvents.length = 0
  })

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    } finally {
      await releaseTestLock()
    }
  })

  it("a new thread's initial message is written with its scopes and hidden by RLS from a member lacking them", async () => {
    const result = await createThread(rlsDb, {
      orgId: ORG,
      userId: OWNER,
      participantIds: [LACKER],
      title: `scoped-${tag}`,
      forceCreate: true,
      initialMessage: {
        content: "quoted deal figures",
        authorType: "agent",
        agentAuthorLabel: "owner's agent",
        requiredScopes: [SCOPE],
      },
    })
    const messageId = (result as { initialMessageId?: string }).initialMessageId as string

    const [row] = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages WHERE id = ${messageId}`
    expect(row?.required_scopes).toEqual([SCOPE])
    expect(await visibleIds(OWNER, [SCOPE], result.id)).toContain(messageId)
    expect(await visibleIds(LACKER, [], result.id)).not.toContain(messageId)

    const created = publishedEvents.find(
      (e) => e.entity === "message" && e.action === "create" && e.entityId === messageId,
    )
    expect(created?.data.requiredScopes).toEqual([SCOPE])
  })

  it("an initial message without requiredScopes is refused before anything is written", async () => {
    const title = `untagged-${tag}`
    const untagged = {
      orgId: ORG,
      userId: OWNER,
      participantIds: [LACKER],
      title,
      forceCreate: true,
      initialMessage: { content: "untagged first message", authorType: "agent" },
    } as unknown as Parameters<typeof createThread>[1]

    await expect((async () => createThread(rlsDb, untagged))()).rejects.toThrow("requiredScopes")
    const rows = await sql`SELECT id FROM kernel.threads WHERE org_id = ${ORG} AND title = ${title}`
    expect(rows).toHaveLength(0)
  })

  it("the DM path forwards the initial message into the existing thread with its scopes", async () => {
    const first = await createThread(rlsDb, {
      orgId: ORG,
      userId: OWNER,
      participantIds: [LACKER],
      initialMessage: { content: "hello", requiredScopes: [] },
    })
    const again = await createThread(rlsDb, {
      orgId: ORG,
      userId: OWNER,
      participantIds: [LACKER],
      initialMessage: {
        content: "forwarded deal figures",
        authorType: "agent",
        agentAuthorLabel: "owner's agent",
        requiredScopes: [SCOPE],
      },
    })
    expect(again.deduplicated).toBe(true)
    expect(again.id).toBe(first.id)

    const [row] = await sql<{ id: string; required_scopes: string[] }[]>`
      SELECT id, required_scopes FROM kernel.messages
      WHERE thread_id = ${first.id} AND content = 'forwarded deal figures'`
    expect(row?.required_scopes).toEqual([SCOPE])
    expect(await visibleIds(LACKER, [], first.id)).not.toContain(row?.id)
  })
})
