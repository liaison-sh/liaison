// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression: a non-creator org member could not open a task's detail view.
// Task discussion threads are created with ONLY their creator as a participant,
// and the kernel `threads_select` / `messages_select` RLS is participant-gated.
// So a second member opening a task created by someone else 404'd on the thread
// fetch, and the whole task-detail tab error-boundaried ("an error is displayed
// on open"). Fix: reading a task the caller can see (projects are org-visible,
// not per-project-membership) lazily enrolls the viewer as a participant of the
// task's thread, restoring read + comment. These tests fail without that
// enrollment (getThread/listMessages return null for the second member).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, getTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { listMessages, sendMessage } from "~/modules/threads/message"
import { getThread } from "~/modules/threads/thread"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:read",
  "kernel:threads:write",
]

let orgId: string
let creator: UserContext
let member: UserContext

async function makeUser(label: string): Promise<string> {
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${label}-${Date.now()}-${Math.random()}@test.com`},
              ${label}, 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  return user!.id
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `task-thread-viewer-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Task Thread Viewer Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const ctx = (userId: string): UserContext => ({
    actorType: "user",
    userId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  })
  creator = ctx(await makeUser("Creator"))
  member = ctx(await makeUser("Member"))
})

afterAll(async () => {
  await releaseTestLock()
})

async function makeTaskAsCreator(): Promise<{ taskId: string; threadId: string }> {
  return withRlsContext(creator, async (tx) => {
    const project = await createProject({ tx, orgId, actor: creator, input: { name: "P" } })
    const statusId = project.statuses.find((s) => !s.terminal)!.id
    const task = await createTask({
      tx,
      orgId,
      actor: creator,
      input: { projectId: project.id, statusId, title: "Shared task" },
    })
    return { taskId: task.id, threadId: task.threadId }
  })
}

describe("projects.task-detail.viewer-thread-access", () => {
  it("projects.task-detail.non-creator-blocked-before-open", async () => {
    // Baseline: before opening (no enrollment), the member is NOT a participant,
    // so the participant-gated thread read returns null. This is the exact
    // condition that made the detail tab error out.
    const { threadId } = await makeTaskAsCreator()
    const thread = await withRlsContext(member, async (tx) =>
      getThread(tx, { orgId, userId: member.userId, threadId }),
    )
    expect(thread).toBeNull()
  })

  it("projects.task-detail.open-enrolls-viewer-as-participant", async () => {
    const { taskId, threadId } = await makeTaskAsCreator()

    // Member opens the task via the same read path the detail view uses.
    const detail = await withRlsContext(member, async (tx) =>
      getTask({ tx, orgId, taskId, viewerId: member.userId }),
    )
    expect(detail.id).toBe(taskId)

    // Now the participant-gated thread read succeeds for the member.
    const thread = await withRlsContext(member, async (tx) =>
      getThread(tx, { orgId, userId: member.userId, threadId }),
    )
    expect(thread).not.toBeNull()
    expect(thread?.id).toBe(threadId)

    // And they can read the thread's messages.
    const msgs = await withRlsContext(member, async (tx) =>
      listMessages(tx, { orgId, userId: member.userId, threadId, limit: 50 }),
    )
    expect(msgs).not.toBeNull()
  })

  it("projects.task-detail.opened-viewer-can-comment", async () => {
    const { taskId, threadId } = await makeTaskAsCreator()
    await withRlsContext(member, async (tx) =>
      getTask({ tx, orgId, taskId, viewerId: member.userId }),
    )

    // sendMessage returns null for a non-participant; after enrollment it posts.
    const sent = await withRlsContext(member, async (tx) =>
      sendMessage(tx, {
        orgId,
        userId: member.userId,
        threadId,
        content: "member comment",
        requiredScopes: [],
      }),
    )
    expect(sent).not.toBeNull()

    const msgs = await withRlsContext(member, async (tx) =>
      listMessages(tx, { orgId, userId: member.userId, threadId, limit: 50 }),
    )
    const contents = (msgs?.messages ?? []).map((m: { content: string | null }) => m.content)
    expect(contents).toContain("member comment")
  })

  it("projects.task-detail.enrollment-is-idempotent", async () => {
    const { taskId, threadId } = await makeTaskAsCreator()
    await withRlsContext(member, async (tx) =>
      getTask({ tx, orgId, taskId, viewerId: member.userId }),
    )
    // Opening again must not throw or duplicate participant rows.
    await withRlsContext(member, async (tx) =>
      getTask({ tx, orgId, taskId, viewerId: member.userId }),
    )
    const [{ count }] = extractRows<{ count: string }>(
      await db.execute(drizzleSql`
        SELECT COUNT(*)::text AS count FROM kernel.thread_participants
        WHERE thread_id = ${threadId}::uuid AND user_id = ${member.userId}::uuid
      `),
    )
    expect(Number(count)).toBe(1)
  })

  it("projects.task-detail.enrollment-announces-the-new-participant", async () => {
    // Live delivery of the discussion is gated on the socket's thread
    // membership, which the server learns from `participant:add`. An
    // enrollment that queued no event left the viewer's open socket deaf to
    // every later comment in the thread (an agent's reply showed only after a
    // reload). Announce the first enrollment, and only that one.
    const { taskId, threadId } = await makeTaskAsCreator()
    const announced = async (): Promise<Array<Record<string, unknown>>> =>
      extractRows<{ payload: Record<string, unknown> }>(
        await db.execute(drizzleSql`
          SELECT payload FROM kernel.pending_events
          WHERE org_id = ${orgId}::uuid
            AND payload->>'entity' = 'participant'
            AND payload->'data'->>'threadId' = ${threadId}
            AND payload->'data'->>'userId' = ${member.userId}
        `),
      ).map((r) => r.payload)

    await withRlsContext(member, async (tx) =>
      getTask({ tx, orgId, taskId, viewerId: member.userId }),
    )
    const first = await announced()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      app: "kernel",
      action: "add",
      entityId: threadId,
      data: { threadId, userId: member.userId, userName: "Member" },
    })

    // Opening it again is no new membership, so no second announcement.
    await withRlsContext(member, async (tx) =>
      getTask({ tx, orgId, taskId, viewerId: member.userId }),
    )
    expect(await announced()).toHaveLength(1)
  })
})
