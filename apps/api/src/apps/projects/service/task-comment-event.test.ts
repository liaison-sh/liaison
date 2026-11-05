// SPDX-License-Identifier: FSL-1.1-ALv2
// A task comment is a message in the task's own discussion thread, announced as
// `kernel/message:create` like any other. The frame now names where its thread
// came from (`threadOrigin: "projects:task"`, from the thread's `created_from`)
// and the thread's type, flat fields an exact-match binding (a guided tour
// beat) can tell a task comment apart by. A plain thread's message says
// `threadOrigin: null`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { postTaskComment } from "~/apps/projects/service/task-comment"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { sendMessage } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let actor: UserContext

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

beforeAll(async () => {
  await acquireTestLock()
  orgId = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Task Comment Evt', ${`task-comment-evt-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )[0]!.id
  userId = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`tce-${Date.now()}@test.com`}, 'Commenter', 'active', 'hash', 1, 1)
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

describe("kernel/message:create names its thread's origin", () => {
  it("a task comment carries threadOrigin projects:task", async () => {
    const posted = await withRlsContext(actor, async (tx) => {
      const p = await createProject({
        tx,
        orgId,
        actor,
        input: {
          name: `tce-${randomUUID().slice(0, 8)}`,
          key: `T${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
        },
      })
      const t = await createTask({
        tx,
        orgId,
        actor,
        input: { projectId: p.id, statusId: p.statuses[0]!.id, title: "Commented task" },
      })
      const comment = await postTaskComment(tx, {
        orgId,
        userId,
        taskId: t.id,
        body: "Looks good",
        requiredScopes: [],
      })
      return { ...comment, taskId: t.id }
    })
    expect(posted.messageId).toBeTruthy()
    const data = await messageEventData(posted.messageId!)
    expect(data.threadOrigin).toBe("projects:task")
    // The task it belongs to, so its notifications name it and open on it.
    expect(data.threadAnchor).toEqual({
      app: "projects",
      entityType: "task",
      entityId: posted.taskId,
    })
    expect(data.threadType).toBe("thread")
  })

  it("a plain thread's message carries threadOrigin null", async () => {
    const threadId = randomUUID()
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}::uuid, ${orgId}::uuid, ${`tce-${threadId.slice(0, 8)}`}, 'thread', ${userId}::uuid)
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid)
    `)
    const msg = (await withRlsContext(actor, (tx) =>
      sendMessage(tx, { orgId, userId, threadId, content: "hello", requiredScopes: [] }),
    )) as { id: string }
    const data = await messageEventData(msg.id)
    expect("threadOrigin" in data).toBe(true)
    expect(data.threadOrigin).toBeNull()
    expect(data.threadAnchor).toBeNull()
  })
})
