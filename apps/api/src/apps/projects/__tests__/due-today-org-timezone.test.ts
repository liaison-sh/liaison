// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/projects/attention"
import { createProject } from "~/apps/projects/service/create-project"
import { orgToday } from "~/apps/projects/service/due-status"
import {
  createTask,
  listProjectTasks,
  listTasks,
  listTasksAcrossProjects,
  portfolioRollup,
} from "~/apps/projects/service/tasks"
import { tasksAggregate } from "~/apps/projects/service/tasks-aggregate"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// One "today" per org: Home and every task-list due filter read the org's own
// date from the same clock. The org sits in Los Angeles and the moment is 01:00
// UTC on the database's current day, so UTC has already rolled over while Los
// Angeles is still on the evening before.

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

let orgId: string
let meId: string
let actor: UserContext
let now: Date
let laToday: string
let projectId: string
let taskId: string

beforeAll(async () => {
  await acquireTestLock()
  const slug = `projects-org-today-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug, timezone)
      VALUES (gen_random_uuid(), 'Org Today', ${slug}, 'America/Los_Angeles') RETURNING id
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
  actor = {
    actorType: "user",
    userId: meId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }

  // 01:00 UTC on the database's own current date.
  const [{ d }] = extractRows<{ d: string }>(
    await db.execute(drizzleSql`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`),
  ) as [{ d: string }]
  const [y, m, day] = d.split("-").map(Number) as [number, number, number]
  now = new Date(Date.UTC(y, m - 1, day, 1, 0, 0))
  laToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
  expect(laToday < d).toBe(true)

  await withRlsContext(actor, async (tx) => {
    const project = await createProject({ tx, orgId, actor, input: { name: "Org today" } })
    projectId = project.id
    const open = project.statuses.find((s) => !s.terminal)!.id
    const t = await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        statusId: open,
        title: "due today here",
        assigneeId: meId,
        dueDate: laToday,
      },
    })
    taskId = t.id
  })
})

afterAll(async () => {
  await releaseTestLock()
})

describe("one today per org", () => {
  it("orgToday reads the org's own date at the given moment", async () => {
    expect(await withRlsContext(actor, (tx) => orgToday(tx, orgId, now))).toBe(laToday)
  })

  it("Home and every task-list due filter put a task due today in the same bucket", async () => {
    await withRlsContext(actor, async (tx) => {
      const home = await computeAttentionItems(tx, orgId, meId, [], now)
      const homeKinds = home.filter((i) => i.entityId === taskId).map((i) => i.kind)
      expect(homeKinds).toEqual(["task_due_this_week"])

      const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

      const soonList = await listTasks({ tx, orgId, projectId, filters: { due: "due_soon" }, now })
      const lateList = await listTasks({ tx, orgId, projectId, filters: { due: "overdue" }, now })
      expect(ids(soonList.items)).toEqual([taskId])
      expect(ids(lateList.items)).toEqual([])

      const soonProject = await listProjectTasks({ tx, orgId, projectId, due: "due_soon", now })
      const lateProject = await listProjectTasks({ tx, orgId, projectId, due: "overdue", now })
      expect(ids(soonProject.items)).toEqual([taskId])
      expect(soonProject.items[0]!.overdue).toBe(false)
      expect(ids(lateProject.items)).toEqual([])

      const soonMine = await listTasksAcrossProjects({
        tx,
        orgId,
        assigneeId: meId,
        due: "due_soon",
        now,
      })
      const lateMine = await listTasksAcrossProjects({
        tx,
        orgId,
        assigneeId: meId,
        due: "overdue",
        now,
      })
      expect(ids(soonMine.items)).toEqual([taskId])
      expect(soonMine.items[0]!.overdue).toBe(false)
      expect(ids(lateMine.items)).toEqual([])

      const soonAgg = await tasksAggregate({
        tx,
        orgId,
        projectId,
        where: { due: "due_soon" },
        now,
      })
      const lateAgg = await tasksAggregate({ tx, orgId, projectId, where: { due: "overdue" }, now })
      expect(soonAgg.totalTasks).toBe(1)
      expect(lateAgg.totalTasks).toBe(0)

      const rollup = await portfolioRollup({ tx, orgId, now })
      const mine = rollup.projects.find((p) => p.projectId === projectId)
      expect(mine?.overdueTasks).toBe(0)
    })
  })
})
