// SPDX-License-Identifier: FSL-1.1-ALv2
// `kernel/message:create` says, as a flat field an exact-match binding reads (a
// guided tour's "bring an agent in" beat), whether the message @-mentions an
// agent: `mentionsAgent: true` for `@[Name](agent:<id>)`, false for a plain
// message or one mentioning only people.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { sendMessage } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let actor: UserContext

const SCOPES = ["kernel:threads:write", "kernel:threads:read"]

beforeAll(async () => {
  await acquireTestLock()
  orgId = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Mentions Agent Evt', ${`mentions-agent-evt-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )[0]!.id
  userId = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`mae-${Date.now()}@test.com`}, 'Commenter', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )[0]!.id
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
})

afterAll(async () => {
  await releaseTestLock()
})

async function messageEventData(messageId: string): Promise<Record<string, unknown>> {
  const rows = extractRows<{ payload: { data: Record<string, unknown> } }>(
    await db.execute(drizzleSql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'kernel'
        AND payload->>'entity' = 'message' AND payload->>'action' = 'create'
        AND payload->>'entityId' = ${messageId}
    `),
  )
  expect(rows).toHaveLength(1)
  return rows[0]!.payload.data
}

async function plainThread(): Promise<string> {
  const threadId = randomUUID()
  await db.execute(drizzleSql`
    INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}::uuid, ${orgId}::uuid, ${`mae-${threadId.slice(0, 8)}`}, 'thread', ${userId}::uuid)
  `)
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid)
  `)
  return threadId
}

async function send(content: string): Promise<Record<string, unknown>> {
  const threadId = await plainThread()
  const msg = (await withRlsContext(actor, (tx) =>
    sendMessage(tx, { orgId, userId, threadId, content, requiredScopes: [] }),
  )) as { id: string }
  return messageEventData(msg.id)
}

describe("kernel/message:create says whether it mentions an agent", () => {
  it("a plain message: mentionsAgent false", async () => {
    expect((await send("hello there")).mentionsAgent).toBe(false)
  })

  it("a message mentioning only a person: mentionsAgent false", async () => {
    expect((await send(`thanks @[Commenter](user:${userId})`)).mentionsAgent).toBe(false)
  })

  it("an @agent message: mentionsAgent true", async () => {
    expect(
      (await send(`@[Helper](agent:${randomUUID()}) can you sum this up?`)).mentionsAgent,
    ).toBe(true)
  })
})
