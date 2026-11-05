// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { desc, sql as drizzleSql, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { threadReferences } from "~/db/schema/kernel"
import { listBacklinks, listRecentReferences } from "~/modules/threads/reference"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let threadId: string

async function ensureParticipant(): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid, 'owner')
    ON CONFLICT DO NOTHING
  `)
}

async function insertReference(
  app: string,
  entityType: string,
  entityId: string,
  visitedAt: Date,
): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_references
      (thread_id, org_id, app, entity_type, entity_id, added_by, last_visited_at, created_at)
    VALUES (${threadId}::uuid, ${orgId}::uuid, ${app}, ${entityType}, ${entityId}::uuid,
            ${userId}::uuid, ${visitedAt.toISOString()}::timestamptz, ${visitedAt.toISOString()}::timestamptz)
    ON CONFLICT (thread_id, app, entity_type, entity_id) DO UPDATE SET last_visited_at = EXCLUDED.last_visited_at
  `)
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `refs-int-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'RefInt Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`refint-${Date.now()}@test.com`}, 'RefInt User',
              'active', 'hash', 1, 1) RETURNING id
    `),
  )
  userId = u!.id
  const [t] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`refint-thread-${Date.now()}`}, 'thread', ${userId}::uuid)
      RETURNING id
    `),
  )
  threadId = t!.id
  await ensureParticipant()

  // 7 references with increasing lastVisitedAt — only top-5 most recent should appear
  const base = Date.now()
  for (let i = 0; i < 7; i++) {
    await insertReference(
      "kernel",
      "thread",
      `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
      new Date(base + i * 1000),
    )
  }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("threads.references.integration", () => {
  it("threads.references.top-five-display-contract", async () => {
    const items = await withPrivilegedDb(orgId, "test-refs-list", async (tx) =>
      listRecentReferences(tx as unknown as RlsClient, { orgId, userId, threadId }),
    )
    expect(items).toHaveLength(5)
    for (const item of items) {
      expect(typeof item.tabType).toBe("string")
      expect(typeof item.label).toBe("string")
      expect(typeof item.icon).toBe("string")
      expect(typeof item.lastVisitedAt).toBe("string")
    }
    // Most-recent first
    const sortedDesc = [...items]
      .map((i) => new Date(i.lastVisitedAt).getTime())
      .every((t, idx, arr) => idx === 0 || arr[idx - 1]! >= t)
    expect(sortedDesc).toBe(true)
  })

  it("threads.backlinks.excludes-agent-chat-threads", async () => {
    // A shared thread and a private 1:1 assistant chat (`agent_chat`) both
    // reference the SAME entity. The public backlinks panel must surface only
    // the shared thread -- the agent chat's incidental "recently viewed" refs
    // (which power the assistant's own context strip) must never leak here.
    const entityId = "11111111-1111-1111-1111-111111111111"
    const mkThread = async (type: string): Promise<string> => {
      const [row] = extractRows<{ id: string }>(
        await db.execute(drizzleSql`
          INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bl-${type}-${Date.now()}-${Math.random()}`},
                  ${type}, ${userId}::uuid)
          RETURNING id
        `),
      )
      const id = row!.id
      await db.execute(drizzleSql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${id}::uuid, ${userId}::uuid, ${orgId}::uuid, 'owner')
        ON CONFLICT DO NOTHING
      `)
      await db.execute(drizzleSql`
        INSERT INTO kernel.thread_references
          (thread_id, org_id, app, entity_type, entity_id, added_by, last_visited_at, created_at)
        VALUES (${id}::uuid, ${orgId}::uuid, 'tickets', 'ticket', ${entityId}::uuid,
                ${userId}::uuid, now(), now())
      `)
      return id
    }
    const sharedThreadId = await mkThread("thread")
    const agentChatId = await mkThread("agent_chat")

    const rows = await withPrivilegedDb(orgId, "test-backlinks-filter", async (tx) =>
      listBacklinks(tx as unknown as RlsClient, {
        orgId,
        userId,
        app: "tickets",
        entityType: "ticket",
        entityId,
      }),
    )
    const ids = rows.map((r) => r.threadId)
    expect(ids).toContain(sharedThreadId)
    expect(ids).not.toContain(agentChatId)
  })

  it("agent.context.references-top-five", async () => {
    // Build the real agent context and inspect what reaches the runtime.
    const { assembleContext, systemPartsToText } = await import("~/modules/agent/context/context")
    const result = await assembleContext({
      threadId,
      orgId,
      actor: {
        actorType: "user",
        userId,
        orgId,
        scopes: ["*"],
        dimensionGrants: {},
      },
    })
    // Referenced entities ride the EPHEMERAL <runtime-context> tail message, not
    // the system block: the system prompt must stay byte-identical across turns
    // or the providers' prefix caches miss on every request. So read the tail.
    const tail = result.messages.at(-1)
    expect(typeof tail?.content).toBe("string")
    const tailText = tail?.content as string
    expect(tailText).toContain("<runtime-context")
    expect(tailText).toContain("Referenced entities")
    // The five newest entityIds (suffixes 2..6) must appear; older ones (0, 1) must not.
    expect(tailText).toContain("00000000-0000-0000-0000-000000000006")
    expect(tailText).toContain("00000000-0000-0000-0000-000000000002")
    expect(tailText).not.toContain("00000000-0000-0000-0000-000000000000")
    expect(tailText).not.toContain("00000000-0000-0000-0000-000000000001")
    // ...and the cacheable system block carries none of it.
    const promptText = systemPartsToText(result.system)
    expect(promptText).not.toContain("00000000-0000-0000-0000-000000000006")

    // Sanity: the underlying query also returns only 5 rows.
    const rows = await withPrivilegedDb(orgId, "test-agent-context-refs", async (tx) =>
      tx
        .select()
        .from(threadReferences)
        .where(eq(threadReferences.threadId, threadId))
        .orderBy(desc(threadReferences.lastVisitedAt))
        .limit(5),
    )
    expect(rows).toHaveLength(5)
  })
})
