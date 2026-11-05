// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "550e8400-e29b-41d4-a716-446655442200"
const USER = "550e8400-e29b-41d4-a716-446655442201"
const ROLE_ID = "550e8400-e29b-41d4-a716-446655442202"
let token: string
let headers: Record<string, string>

async function createProjectViaApi(): Promise<{ projectId: string; statusIds: string[] }> {
  const r = await app.request("/api/projects", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `Status Project ${Date.now()}-${Math.random()}` }),
  })
  if (r.status !== 200) throw new Error(`failed to create project: ${r.status}`)
  const body = (await r.json()) as {
    data: { id: string; statuses: Array<{ id: string; order: number; label: string }> }
  }
  return {
    projectId: body.data.id,
    statusIds: body.data.statuses
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((s) => s.id),
  }
}

async function seedTaskInStatus(projectId: string, statusId: string): Promise<string> {
  const threadId = (
    extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (gen_random_uuid(), ${ORG}::uuid, ${`task-thread-${Math.random()}`}, 'thread', ${USER}::uuid)
        RETURNING id
      `),
    )[0] as { id: string }
  ).id
  const numberRow = extractRows<{ number: number }>(
    await db.execute(drizzleSql`
      UPDATE app_projects.projects
      SET next_task_number = next_task_number + 1
      WHERE id = ${projectId}::uuid
      RETURNING next_task_number - 1 AS number
    `),
  )[0]
  const taskRow = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.tasks
        (id, org_id, project_id, status_id, number, title, position, thread_id, created_by)
      VALUES (
        gen_random_uuid(),
        ${ORG}::uuid,
        ${projectId}::uuid,
        ${statusId}::uuid,
        ${numberRow!.number},
        'seeded task',
        1000,
        ${threadId}::uuid,
        ${USER}::uuid
      )
      RETURNING id
    `),
  )[0]
  return taskRow!.id
}

async function archiveProject(projectId: string): Promise<void> {
  await db.execute(drizzleSql`
    UPDATE app_projects.projects
    SET archived_at = now()
    WHERE id = ${projectId}::uuid
  `)
}

describe("projects.status", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}::uuid, 'Status Test Org', 'status-test-org')
      ON CONFLICT (id) DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (${USER}::uuid, ${ORG}::uuid, 'status-test@test.com', 'Status User', 'active', 'hash', 1, 1)
      ON CONFLICT (id) DO NOTHING
    `)
    await db.execute(drizzleSql`
      INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE_ID}::uuid, ${ORG}::uuid, 'status-member', 'Status route role')
      ON CONFLICT (id) DO NOTHING
    `)
    for (const scope of [
      "projects:projects:read",
      "projects:projects:write",
      "projects:tasks:read",
      "projects:tasks:write",
    ]) {
      await db.execute(drizzleSql`
        INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE_ID}::uuid, ${scope})
        ON CONFLICT DO NOTHING
      `)
    }
    await db.execute(drizzleSql`
      INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER}::uuid, ${ROLE_ID}::uuid, ${ORG}::uuid)
      ON CONFLICT DO NOTHING
    `)
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "Status User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: [
          "projects:projects:read",
          "projects:projects:write",
          "projects:tasks:read",
          "projects:tasks:write",
        ],
      },
      env.JWT_SECRET,
    )
    headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("projects.status.add-update-reorder", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const addRes = await app.request(`/api/projects/${projectId}/statuses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Review" }),
    })
    expect(addRes.status).toBe(200)
    const added = ((await addRes.json()) as { data: { id: string; order: number } }).data
    expect(added.order).toBe(5)

    const patchRes = await app.request(`/api/projects/${projectId}/statuses/${added.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ label: "QA Review", terminal: false }),
    })
    expect(patchRes.status).toBe(200)
    expect(((await patchRes.json()) as { data: { label: string } }).data.label).toBe("QA Review")

    const reorderRes = await app.request(`/api/projects/${projectId}/statuses/reorder`, {
      method: "POST",
      headers,
      body: JSON.stringify({ orderedStatusIds: [added.id, ...statusIds] }),
    })
    expect(reorderRes.status).toBe(200)
    const reordered = ((await reorderRes.json()) as { data: Array<{ id: string; order: number }> })
      .data
    expect(reordered[0]?.id).toBe(added.id)
    expect(reordered[0]?.order).toBe(0)
  })

  it("projects.status.add-after-status-id-inserts-at-requested-position", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const addRes = await app.request(`/api/projects/${projectId}/statuses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Review", afterStatusId: statusIds[0] }),
    })
    expect(addRes.status).toBe(200)
    const added = ((await addRes.json()) as { data: { id: string; order: number } }).data
    expect(added.order).toBe(1)

    const detailRes = await app.request(`/api/projects/${projectId}`, { headers })
    expect(detailRes.status).toBe(200)
    const statuses = (
      (await detailRes.json()) as { data: { statuses: Array<{ id: string; order: number }> } }
    ).data.statuses
      .slice()
      .sort((a, b) => a.order - b.order)
    expect(statuses.map((s) => s.id)).toEqual([
      statusIds[0],
      added.id,
      statusIds[1],
      statusIds[2],
      statusIds[3],
      statusIds[4],
    ])
  })

  it("projects.status.reorder-mismatch-and-last-status", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const bad = await app.request(`/api/projects/${projectId}/statuses/reorder`, {
      method: "POST",
      headers,
      body: JSON.stringify({ orderedStatusIds: [] }),
    })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "status_order_invalid",
    )

    // Delete all but one status using the empty-status delete path so we can
    // assert `last_status` triggers when only one remains.
    for (let i = 1; i < statusIds.length; i++) {
      const r = await app.request(`/api/projects/${projectId}/statuses/${statusIds[i]}`, {
        method: "DELETE",
        headers,
      })
      expect(r.status).toBe(200)
    }
    const last = await app.request(`/api/projects/${projectId}/statuses/${statusIds[0]}`, {
      method: "DELETE",
      headers,
    })
    expect(last.status).toBe(400)
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe("last_status")
  })

  it("projects.status.delete-in-use", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const busyStatusId = statusIds[0]!
    const taskIds = [
      await seedTaskInStatus(projectId, busyStatusId),
      await seedTaskInStatus(projectId, busyStatusId),
    ]
    const r = await app.request(`/api/projects/${projectId}/statuses/${busyStatusId}`, {
      method: "DELETE",
      headers,
    })
    expect(r.status).toBe(409)
    const body = (await r.json()) as {
      error: { code: string; details: { count: number; taskIds: string[] } }
    }
    expect(body.error.code).toBe("status_in_use")
    expect(body.error.details.count).toBe(2)
    expect(body.error.details.taskIds.length).toBe(2)
    expect(body.error.details.taskIds.length).toBeLessThanOrEqual(50)
    for (const id of taskIds) expect(body.error.details.taskIds).toContain(id)
  })

  it("projects.status.delete-wrong-project-does-not-leak-task-ids", async () => {
    const projectA = await createProjectViaApi()
    const projectB = await createProjectViaApi()
    const busyStatusId = projectB.statusIds[0]!
    const taskId = await seedTaskInStatus(projectB.projectId, busyStatusId)

    const r = await app.request(`/api/projects/${projectA.projectId}/statuses/${busyStatusId}`, {
      method: "DELETE",
      headers,
    })
    expect(r.status).toBe(404)
    const body = (await r.json()) as { error: { code: string; details?: unknown; message: string } }
    expect(body.error.code).toBe("not_found")
    expect(JSON.stringify(body)).not.toContain(taskId)
  })

  it("projects.status.migrate-then-delete", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const busyStatusId = statusIds[0]!
    const targetStatusId = statusIds[1]!
    await seedTaskInStatus(projectId, busyStatusId)
    await seedTaskInStatus(projectId, busyStatusId)

    const m = await app.request(`/api/projects/${projectId}/statuses/${busyStatusId}/migrate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targetStatusId }),
    })
    expect(m.status).toBe(200)
    const moved = ((await m.json()) as { data: { movedCount: number } }).data
    expect(moved.movedCount).toBe(2)

    const d = await app.request(`/api/projects/${projectId}/statuses/${busyStatusId}`, {
      method: "DELETE",
      headers,
    })
    expect(d.status).toBe(200)
    expect((await d.json()) as { data: { deleted: true } }).toEqual({ data: { deleted: true } })
  })

  it("projects.status.migrate-updates-completed-at-for-terminal-statuses", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const openStatusId = statusIds[0]!
    const terminalStatusId = statusIds[3]!
    const taskId = await seedTaskInStatus(projectId, openStatusId)

    const toTerminal = await app.request(
      `/api/projects/${projectId}/statuses/${openStatusId}/migrate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ targetStatusId: terminalStatusId }),
      },
    )
    expect(toTerminal.status).toBe(200)
    let taskRows = extractRows<{ completed_at: Date | string | null }>(
      await db.execute(drizzleSql`
        SELECT completed_at FROM app_projects.tasks WHERE id = ${taskId}::uuid
      `),
    )
    expect(taskRows[0]?.completed_at).toBeTruthy()

    const fromTerminal = await app.request(
      `/api/projects/${projectId}/statuses/${terminalStatusId}/migrate`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ targetStatusId: openStatusId }),
      },
    )
    expect(fromTerminal.status).toBe(200)
    taskRows = extractRows<{ completed_at: Date | string | null }>(
      await db.execute(drizzleSql`
        SELECT completed_at FROM app_projects.tasks WHERE id = ${taskId}::uuid
      `),
    )
    expect(taskRows[0]?.completed_at).toBeNull()
  })

  it("projects.status.same-target-rejected", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const busyStatusId = statusIds[0]!
    await seedTaskInStatus(projectId, busyStatusId)
    const r = await app.request(`/api/projects/${projectId}/statuses/${busyStatusId}/migrate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ targetStatusId: busyStatusId }),
    })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("same_status")
  })

  it("projects.http.tasks-and-statuses", async () => {
    const { projectId, statusIds } = await createProjectViaApi()
    const openStatusId = statusIds[0]!

    const t1Res = await app.request(`/api/projects/${projectId}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "parent task", statusId: openStatusId }),
    })
    expect(t1Res.status).toBe(200)
    const t1 = ((await t1Res.json()) as { data: { id: string } }).data

    const t2Res = await app.request(`/api/projects/${projectId}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "child task", statusId: openStatusId }),
    })
    expect(t2Res.status).toBe(200)
    const t2 = ((await t2Res.json()) as { data: { id: string } }).data

    const moveRes = await app.request(`/api/projects/${projectId}/tasks/${t2.id}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parentTaskId: t1.id }),
    })
    expect(moveRes.status).toBe(200)
    const moved = ((await moveRes.json()) as { data: { parentTaskId: string | null } }).data
    expect(moved.parentTaskId).toBe(t1.id)

    const cycleRes = await app.request(`/api/projects/${projectId}/tasks/${t1.id}/move`, {
      method: "POST",
      headers,
      body: JSON.stringify({ parentTaskId: t2.id }),
    })
    expect(cycleRes.status).toBe(400)
    expect(((await cycleRes.json()) as { error: { code: string } }).error.code).toBe(
      "task_cycle_detected",
    )

    const listRes = await app.request(`/api/projects/${projectId}/tasks`, {
      headers,
    })
    expect(listRes.status).toBe(200)
    const list = (
      (await listRes.json()) as {
        data: { items: Array<{ id: string }> }
      }
    ).data.items
    expect(list.length).toBe(2)
  })

  it("projects.status.archived-project-mutations-rejected", async () => {
    const { projectId } = await createProjectViaApi()
    await archiveProject(projectId)
    const r = await app.request(`/api/projects/${projectId}/statuses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ label: "Later" }),
    })
    expect(r.status).toBe(409)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("project_archived")
  })
})
