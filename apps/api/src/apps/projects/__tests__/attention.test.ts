// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/projects/attention"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, deleteTask, updateTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

let orgId: string
let meId: string
let otherId: string
let actor: UserContext

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-attention-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Attention Org', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [me] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`me-${Date.now()}@test.com`}, 'Me', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  meId = me!.id
  const [other] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`other-${Date.now()}@test.com`}, 'Other', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  otherId = other!.id
  actor = {
    actorType: "user",
    userId: meId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
})

afterAll(async () => {
  await releaseTestLock()
})

interface ProjectFixture {
  projectId: string
  openStatusId: string
  terminalStatusId: string
}

async function setupProject(label: string): Promise<ProjectFixture> {
  return withRlsContext(actor, async (tx) => {
    const project = await createProject({
      tx,
      orgId,
      actor,
      input: { name: label },
    })
    return {
      projectId: project.id,
      openStatusId: project.statuses.find((s) => !s.terminal)!.id,
      terminalStatusId: project.statuses.find((s) => s.terminal)!.id,
    }
  })
}

async function makeTask(
  fixture: ProjectFixture,
  patch: {
    title?: string
    assigneeId?: string | null
    dueDateOffset?: number | null
    blocked?: boolean
    terminal?: boolean
  },
): Promise<string> {
  return withRlsContext(actor, async (tx) => {
    const t = await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: fixture.projectId,
        statusId: patch.terminal ? fixture.terminalStatusId : fixture.openStatusId,
        title: patch.title ?? "task",
        assigneeId: patch.assigneeId === undefined ? meId : patch.assigneeId,
        blocked: patch.blocked ?? false,
        dueDate:
          patch.dueDateOffset === undefined || patch.dueDateOffset === null
            ? null
            : new Date(Date.now() + patch.dueDateOffset * 86400000).toISOString().slice(0, 10),
      },
    })
    return t.id
  })
}

async function runProvider(): Promise<Awaited<ReturnType<typeof computeAttentionItems>>> {
  return withRlsContext(actor, (tx) => computeAttentionItems(tx, orgId, meId))
}

describe("projects.attention", () => {
  it("projects.attention.deterministic-ids", async () => {
    const env = await setupProject("deterministic")
    const overdueId = await makeTask(env, { title: "overdue", dueDateOffset: -3 })
    const dueId = await makeTask(env, { title: "due", dueDateOffset: 2 })
    const blockedId = await makeTask(env, { title: "blocked", blocked: true })

    const items = await runProvider()
    expect(items.find((i) => i.kind === "task_overdue")?.id).toBe(
      `projects:task_overdue:${overdueId}`,
    )
    expect(items.find((i) => i.kind === "task_due_this_week")?.id).toBe(
      `projects:task_due_this_week:${dueId}`,
    )
    expect(items.find((i) => i.kind === "task_blocked")?.id).toBe(
      `projects:task_blocked:${blockedId}`,
    )
  })

  it("projects.attention.project-metadata", async () => {
    const env = await setupProject("metadata")
    const overdueTaskId = await makeTask(env, { title: "overdue", dueDateOffset: -3 })
    const dueSoonTaskId = await makeTask(env, { title: "due soon", dueDateOffset: 2 })
    const blockedTaskId = await makeTask(env, { title: "blocked", blocked: true })
    const items = await runProvider()
    const byEntity = new Map(items.map((i) => [i.entityId, i]))

    const overdue = byEntity.get(overdueTaskId)
    expect(overdue).toBeDefined()
    expect(overdue?.kind).toBe("task_overdue")
    expect(overdue?.metadata).toMatchObject({ projectId: env.projectId })
    const overdueMeta = (overdue?.metadata ?? {}) as { daysOver?: unknown; dueDate?: unknown }
    expect(overdueMeta.daysOver).toBeNumber()
    expect(overdueMeta.dueDate).toBeString()

    const dueSoon = byEntity.get(dueSoonTaskId)
    expect(dueSoon?.kind).toBe("task_due_this_week")
    expect(dueSoon?.metadata).toMatchObject({ projectId: env.projectId })
    const dueSoonMeta = (dueSoon?.metadata ?? {}) as { daysRemaining?: unknown; dueDate?: unknown }
    expect(dueSoonMeta.daysRemaining).toBeNumber()
    expect(dueSoonMeta.dueDate).toBeString()

    const blocked = byEntity.get(blockedTaskId)
    expect(blocked?.kind).toBe("task_blocked")
    expect(blocked?.metadata).toMatchObject({ projectId: env.projectId })
    const blockedMeta = (blocked?.metadata ?? {}) as { projectName?: unknown }
    expect(blockedMeta.projectName).toBeString()
  })

  it("projects.attention.urgency-bands", async () => {
    const env = await setupProject("urgency")
    const oneDayOver = await makeTask(env, { title: "1d", dueDateOffset: -1 })
    const fiveDayOver = await makeTask(env, { title: "5d", dueDateOffset: -5 })
    const farOverdue = await makeTask(env, { title: "far", dueDateOffset: -30 })
    const dueLater = await makeTask(env, { title: "later", dueDateOffset: 6 })
    const blockedId = await makeTask(env, { title: "block", blocked: true })

    const items = await runProvider()
    const byEntity = new Map(items.map((i) => [i.entityId, i]))
    const oneDayUrgency = byEntity.get(oneDayOver)?.urgency
    const fiveDayUrgency = byEntity.get(fiveDayOver)?.urgency
    const farUrgency = byEntity.get(farOverdue)?.urgency
    expect(oneDayUrgency).toBeGreaterThanOrEqual(60)
    expect(oneDayUrgency).toBeLessThanOrEqual(80)
    expect(fiveDayUrgency).toBeGreaterThan(oneDayUrgency!)
    expect(farUrgency).toBe(100)
    expect(byEntity.get(blockedId)?.urgency).toBe(50)
    const dueLaterUrgency = byEntity.get(dueLater)?.urgency
    expect(dueLaterUrgency).toBeGreaterThanOrEqual(30)
    expect(dueLaterUrgency).toBeLessThanOrEqual(65)
  })

  it("projects.attention.excludes-terminal-unassigned-and-other-caller", async () => {
    const env = await setupProject("excludes")
    // Terminal overdue assigned to me
    const terminalTask = await makeTask(env, { title: "term", terminal: true })
    await withRlsContext(actor, async (tx) =>
      updateTask({
        tx,
        orgId,
        actor,
        taskId: terminalTask,
        input: { dueDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10) },
      }),
    )
    // Unassigned overdue
    await makeTask(env, { title: "unassigned", assigneeId: null, dueDateOffset: -1 })
    // Other caller overdue
    await makeTask(env, { title: "other", assigneeId: otherId, dueDateOffset: -1 })

    const items = (await runProvider()).filter(
      (i) => (i.metadata as { projectId?: string } | undefined)?.projectId === env.projectId,
    )
    expect(items).toHaveLength(0)
  })

  it("projects.attention.excludes-deleted-tasks-and-archived-projects", async () => {
    const env = await setupProject("bin")
    const deleted = await makeTask(env, { title: "deleted", dueDateOffset: -2 })
    const kept = await makeTask(env, { title: "kept", dueDateOffset: -2 })
    await withRlsContext(actor, (tx) => deleteTask({ tx, orgId, actor, taskId: deleted }))
    let ids = (await runProvider()).map((i) => i.entityId)
    expect(ids).not.toContain(deleted)
    expect(ids).toContain(kept)

    // The archive route's own write: the project is archived, its tasks stay.
    await withRlsContext(actor, (tx) =>
      tx.execute(
        drizzleSql`UPDATE ${projectsRel("projects")} SET archived_at = now()
                   WHERE id = ${env.projectId}::uuid`,
      ),
    )
    ids = (await runProvider()).map((i) => i.entityId)
    expect(ids).not.toContain(kept)
  })
})
