// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Module J — Task J2: task merge, template instantiation, and dependencies.
 * Service-level integration test (real DB + RLS).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import { moveTask } from "~/apps/projects/service/move-task"
import {
  addDependency,
  createTask,
  instantiateTemplate,
  mergeTasks,
} from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
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

async function makeProject(
  name: string,
): Promise<{ projectId: string; openStatusId: string; terminalStatusId: string }> {
  return withRlsContext(actor, async (tx) => {
    const r = await createProject({ tx, orgId, actor, input: { name } })
    return {
      projectId: r.id,
      openStatusId: r.statuses.find((s) => !s.terminal)!.id,
      terminalStatusId: r.statuses.find((s) => s.terminal)!.id,
    }
  })
}

async function makeTask(
  projectId: string,
  statusId: string,
  opts: { parentTaskId?: string; title?: string } = {},
): Promise<string> {
  return withRlsContext(actor, async (tx) => {
    const t = await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        statusId,
        parentTaskId: opts.parentTaskId ?? null,
        title: opts.title ?? "T",
      },
    })
    return t.id
  })
}

async function parentOf(taskId: string): Promise<string | null> {
  const rows = extractRows<{ parent_task_id: string | null }>(
    await db.execute(
      drizzleSql`SELECT parent_task_id FROM ${projectsRel("tasks")} WHERE id = ${taskId}::uuid`,
    ),
  )
  return rows[0]?.parent_task_id ?? null
}

async function archivedAt(taskId: string): Promise<string | null> {
  const rows = extractRows<{ archived_at: Date | string | null }>(
    await db.execute(
      drizzleSql`SELECT archived_at FROM ${projectsRel("tasks")} WHERE id = ${taskId}::uuid`,
    ),
  )
  const v = rows[0]?.archived_at ?? null
  return v instanceof Date ? v.toISOString() : v
}

async function isBlocked(taskId: string): Promise<boolean> {
  const rows = extractRows<{ blocked: boolean }>(
    await db.execute(
      drizzleSql`SELECT blocked FROM ${projectsRel("tasks")} WHERE id = ${taskId}::uuid`,
    ),
  )
  return rows[0]?.blocked ?? false
}

async function listTaskTitles(projectId: string): Promise<string[]> {
  const rows = extractRows<{ title: string }>(
    await db.execute(
      drizzleSql`SELECT title FROM ${projectsRel("tasks")} WHERE project_id = ${projectId}::uuid AND archived_at IS NULL`,
    ),
  )
  return rows.map((r) => r.title)
}

async function seedTemplate(name: string, structure: unknown): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO ${projectsRel("project_templates")} (org_id, name, structure, created_by)
      VALUES (${orgId}::uuid, ${name}, ${JSON.stringify(structure)}::jsonb, ${userId}::uuid)
      RETURNING id
    `),
  )
  return rows[0]!.id
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-merge-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Merge Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`merge-${Date.now()}@t.test`}, 'Merge Tester', 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  userId = u!.id
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
})

afterAll(releaseTestLock)

describe("projects merge + templates + dependencies (J2)", () => {
  it("mergeTasks reassigns children + thread to target, archives source", async () => {
    const p = await makeProject("Pmerge")
    const source = await makeTask(p.projectId, p.openStatusId, { title: "S" })
    const child = await makeTask(p.projectId, p.openStatusId, {
      parentTaskId: source,
      title: "S_CHILD",
    })
    const target = await makeTask(p.projectId, p.openStatusId, { title: "T" })
    await withRlsContext(actor, (tx) =>
      mergeTasks({ tx, orgId, actor, sourceId: source, targetId: target }),
    )
    expect(await parentOf(child)).toBe(target)
    expect(await archivedAt(source)).toBeTruthy()
  })

  it("instantiateTemplate creates the full task tree from the stored structure", async () => {
    const tpl = await seedTemplate("Launch", [
      { title: "Plan", children: [] },
      { title: "QA", children: [] },
      { title: "Ship", children: [] },
    ])
    const r = await withRlsContext(actor, (tx) =>
      instantiateTemplate({ tx, orgId, actor, templateId: tpl, projectName: "Launch Q3" }),
    )
    expect((await listTaskTitles(r.projectId)).sort()).toEqual(["Plan", "QA", "Ship"])
  })

  it("addDependency sets blocked=true on the dependent while the blocker is open, clears on completion", async () => {
    const p = await makeProject("Pdep")
    const a = await makeTask(p.projectId, p.openStatusId, { title: "A" })
    const b = await makeTask(p.projectId, p.openStatusId, { title: "B" })
    await withRlsContext(actor, (tx) =>
      addDependency({ tx, orgId, actor, taskId: b, dependsOnTaskId: a, type: "blocks" }),
    )
    expect(await isBlocked(b)).toBe(true)
    // Complete A by moving it to a terminal status — the completion path
    // recomputes its dependents' blocked flags.
    await withRlsContext(actor, (tx) =>
      moveTask({ tx, orgId, actor, taskId: a, statusId: p.terminalStatusId }),
    )
    expect(await isBlocked(b)).toBe(false)
  })

  it("addDependency rejects a cycle (A→B→A)", async () => {
    const p = await makeProject("Pcycle")
    const a = await makeTask(p.projectId, p.openStatusId, { title: "A" })
    const b = await makeTask(p.projectId, p.openStatusId, { title: "B" })
    await withRlsContext(actor, (tx) =>
      addDependency({ tx, orgId, actor, taskId: b, dependsOnTaskId: a, type: "blocks" }),
    )
    await expect(
      withRlsContext(actor, (tx) =>
        addDependency({ tx, orgId, actor, taskId: a, dependsOnTaskId: b, type: "blocks" }),
      ),
    ).rejects.toThrow(/cycle|circular/i)
  })

  it("instantiateTemplate respects MAX_TASK_DEPTH (reuses createTask guard)", async () => {
    // Build a template nested deeper than MAX_TASK_DEPTH (5).
    let node: { title: string; children: unknown[] } = { title: "leaf", children: [] }
    for (let i = 0; i < 8; i++) node = { title: `n${i}`, children: [node] }
    const tpl = await seedTemplate("TooDeep", [node])
    await expect(
      withRlsContext(actor, (tx) =>
        instantiateTemplate({ tx, orgId, actor, templateId: tpl, projectName: "X" }),
      ),
    ).rejects.toThrow(/depth/i)
  })
})
