// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Task release field and the effective-release filter (S4, S15, S16).
 * Service-level integration test (real DB + RLS), modeled on
 * tasks-crossproject.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { listReleases, RELEASE_NONE } from "~/apps/projects/service/release-filter"
import { ProjectsServiceError } from "~/apps/projects/service/statuses"
import {
  createTask,
  getTask,
  listProjectTasks,
  listTasks,
  listTasksAcrossProjects,
  updateTask,
} from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let actor: UserContext

async function makeProject(name: string): Promise<{ projectId: string; statusId: string }> {
  return withRlsContext(actor, async (tx) => {
    const r = await createProject({ tx, orgId, actor, input: { name } })
    return { projectId: r.id, statusId: r.statuses.find((s) => !s.terminal)!.id }
  })
}

async function makeTask(
  projectId: string,
  opts: { release?: string | null; parentTaskId?: string; title?: string },
): Promise<{ id: string; release: string | null }> {
  return withRlsContext(actor, async (tx) => {
    const t = await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        parentTaskId: opts.parentTaskId ?? null,
        assigneeId: userId,
        title: opts.title ?? "Task",
        ...(opts.release !== undefined ? { release: opts.release } : {}),
      },
    })
    return { id: t.id, release: t.release }
  })
}

async function projectIds(projectId: string, release: string): Promise<string[]> {
  const out = await withRlsContext(actor, (tx) =>
    listProjectTasks({ tx, orgId, projectId, release }),
  )
  expect(out.totalCount).toBe(out.items.length)
  return out.items.map((t) => t.id).sort()
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-release-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Release Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`rel-${Date.now()}@release.test`}, 'Rel', 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  userId = u!.id
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: [
      "projects:projects:read",
      "projects:projects:write",
      "projects:tasks:read",
      "projects:tasks:write",
      "kernel:threads:write",
      "kernel:threads:read",
    ],
    dimensionGrants: { "*": ["*"] },
  }
})

afterAll(releaseTestLock)

describe("task release and effective-release filter", () => {
  it("child inherits the nearest ancestor release; a grandchild's own release wins", async () => {
    const p = await makeProject("Release inheritance")
    const parent = await makeTask(p.projectId, { release: "2.1.0", title: "parent" })
    const child = await makeTask(p.projectId, { parentTaskId: parent.id, title: "child" })
    const grandchild = await makeTask(p.projectId, {
      parentTaskId: child.id,
      release: "2.2.0",
      title: "grandchild",
    })
    const loose = await makeTask(p.projectId, { title: "no release anywhere" })

    expect(await projectIds(p.projectId, "2.1.0")).toEqual([parent.id, child.id].sort())
    expect(await projectIds(p.projectId, "2.2.0")).toEqual([grandchild.id])
    expect(await projectIds(p.projectId, RELEASE_NONE)).toEqual([loose.id])

    // The board list (REST GET /:projectId/tasks) applies the same filter.
    const board = await withRlsContext(actor, (tx) =>
      listTasks({ tx, orgId, projectId: p.projectId, filters: { release: "2.1.0" } }),
    )
    expect(board.items.map((t) => t.id).sort()).toEqual([parent.id, child.id].sort())
    // Lists carry the task's OWN release, not the inherited one.
    expect(board.items.find((t) => t.id === child.id)!.release).toBeNull()
    expect(board.items.find((t) => t.id === parent.id)!.release).toBe("2.1.0")

    // Cross-project list too.
    const cross = await withRlsContext(actor, (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: userId, release: "2.1.0" }),
    )
    expect(cross.items.map((t) => t.id).sort()).toEqual([parent.id, child.id].sort())
  })

  it("release is trimmed on create and update; an empty string stores NULL", async () => {
    const p = await makeProject("Release trim")
    const t = await makeTask(p.projectId, { release: " 2.1.0 " })
    expect(t.release).toBe("2.1.0")

    const updated = await withRlsContext(actor, (tx) =>
      updateTask({
        tx,
        orgId,
        actor,
        taskId: t.id,
        input: { release: "  3.0  " },
      }),
    )
    expect(updated.release).toBe("3.0")
    // The task:updated event carries the stored (trimmed) value, not the raw input.
    const [evt] = extractRows<{ release: string | null }>(
      await db.execute(drizzleSql`
        SELECT payload->'data'->>'release' AS release FROM kernel.pending_events
        WHERE payload->>'entityId' = ${t.id} AND payload->>'action' = 'updated'
        ORDER BY seq DESC LIMIT 1
      `),
    )
    expect(evt?.release).toBe("3.0")

    const cleared = await withRlsContext(actor, (tx) =>
      updateTask({ tx, orgId, actor, taskId: t.id, input: { release: "   " } }),
    )
    expect(cleared.release).toBeNull()
    const read = await withRlsContext(actor, (tx) => getTask({ tx, orgId, taskId: t.id }))
    expect(read.release).toBeNull()

    const nulled = await makeTask(p.projectId, { release: "" })
    expect(nulled.release).toBeNull()
  })

  it("the filter is case-insensitive", async () => {
    const p = await makeProject("Release case")
    const t = await makeTask(p.projectId, { release: "V3-Beta" })
    expect(await projectIds(p.projectId, "v3-beta")).toEqual([t.id])
    expect(await projectIds(p.projectId, " V3-BETA ")).toEqual([t.id])
  })

  it("refuses a release over 40 characters with a 400 naming the field", async () => {
    const p = await makeProject("Release limit")
    const long = "x".repeat(41)
    let createErr: unknown
    try {
      await makeTask(p.projectId, { release: long })
    } catch (err) {
      createErr = err
    }
    expect(createErr).toBeInstanceOf(ProjectsServiceError)
    expect((createErr as ProjectsServiceError).status).toBe(400)
    expect((createErr as ProjectsServiceError).message).toContain("release")

    const ok = await makeTask(p.projectId, { release: "x".repeat(40) })
    expect(ok.release).toBe("x".repeat(40))
    let updateErr: unknown
    try {
      await withRlsContext(actor, (tx) =>
        updateTask({
          tx,
          orgId,
          actor,
          taskId: ok.id,
          input: { release: long },
        }),
      )
    } catch (err) {
      updateErr = err
    }
    expect(updateErr).toBeInstanceOf(ProjectsServiceError)
    expect((updateErr as ProjectsServiceError).status).toBe(400)
    expect((updateErr as ProjectsServiceError).message).toContain("release")
  })

  it("listReleases returns own values with counts equal to the effective-release list lengths", async () => {
    const p = await makeProject("Release counts")
    const root = await makeTask(p.projectId, { release: "9.0.0" })
    await makeTask(p.projectId, { parentTaskId: root.id })
    await makeTask(p.projectId, { release: "9.1.0" })

    const releases = await withRlsContext(actor, (tx) => listReleases({ tx, orgId }))
    expect(releases.length).toBeGreaterThan(0)
    expect(releases.length).toBeLessThanOrEqual(50)
    // Most recent first: 9.1.0 was touched last.
    expect(releases[0]!.value).toBe("9.1.0")
    const values = releases.map((r) => r.value)
    expect(values).toContain("9.0.0")
    expect(new Set(values.map((v) => v.toLowerCase())).size).toBe(values.length)

    for (const r of releases) {
      const cross = await withRlsContext(actor, (tx) =>
        listTasksAcrossProjects({ tx, orgId, assigneeId: userId, release: r.value }),
      )
      expect(r.count, `count for ${r.value}`).toBe(cross.totalCount)
    }
    expect(releases.find((r) => r.value === "9.0.0")!.count).toBe(2)
  })
})
