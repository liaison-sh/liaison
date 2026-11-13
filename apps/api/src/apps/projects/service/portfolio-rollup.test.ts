// SPDX-License-Identifier: FSL-1.1-ALv2
// BL-263 — the bounded projects PORTFOLIO ROLLUP (portfolio_rollup tool). One
// aggregate read returns, per active project, {total, done, remaining, overdue,
// percentDone, biggestAtRisk} — the board one-screen view that previously
// required N separate tasks_byProject calls tallied in-context
// (cross-project-portfolio-rollup, l628). Fails-without (the service/tool did
// not exist), passes-with.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import {
  createTask,
  type PortfolioRollupResult,
  portfolioRollup,
} from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"

// Hermetic execute-tool import (see list-project-tasks.total.test.ts) — a
// query-string-suffixed specifier dodges a neighbouring file's module mock so we
// load the genuine dispatch path for the end-to-end manifest→bridge assertion.
const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-portfolio`
)) as typeof import("~/modules/apps/execute-tool")

import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let otherUserId: string
let actor: UserContext

// Project A handles: a mix of done/open/overdue with an urgent overdue at-risk task.
let projectAId: string
let projectAName: string

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

beforeAll(async () => {
  await acquireTestLock()
  const orgRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Proj Portfolio', ${`proj-portfolio-${Date.now()}-${Math.random()}`}) RETURNING id
    `),
  )
  orgId = orgRows[0]!.id
  const userRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`pp-${Date.now()}@xp.test`}, 'Riley Vance', 'active', 'h', 1, 1) RETURNING id
    `),
  )
  userId = userRows[0]!.id
  const otherRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`pp2-${Date.now()}@xp.test`}, 'Dana Okafor', 'active', 'h', 1, 1) RETURNING id
    `),
  )
  otherUserId = otherRows[0]!.id
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }

  await withRlsContext(actor, async (tx) => {
    // Project A: 5 tasks — 2 done, 3 open. Of the 3 open: 1 urgent OVERDUE
    // (the biggest-at-risk), 1 normal overdue, 1 future-due.
    const a = await createProject({ tx, orgId, actor, input: { name: "Kestrel Launch" } })
    projectAId = a.id
    projectAName = a.name
    const aOpen = a.statuses.find((s) => !s.terminal)!.id
    const aDone = a.statuses.find((s) => s.terminal)!.id
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId: a.id, statusId: aDone, title: "a-done-1" },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId: a.id, statusId: aDone, title: "a-done-2" },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: a.id,
        statusId: aOpen,
        title: "Ship firmware sign-off",
        priority: "urgent",
        dueDate: isoDaysFromNow(-5),
        assigneeId: otherUserId,
      },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: a.id,
        statusId: aOpen,
        title: "a-open-normal-overdue",
        priority: "normal",
        dueDate: isoDaysFromNow(-1),
      },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId: a.id,
        statusId: aOpen,
        title: "a-open-future",
        dueDate: isoDaysFromNow(7),
      },
    })

    // Project B: 2 tasks, both done — 100% done, no at-risk task.
    const b = await createProject({ tx, orgId, actor, input: { name: "Archive Cleanup" } })
    const bDone = b.statuses.find((s) => s.terminal)!.id
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId: b.id, statusId: bDone, title: "b-done-1" },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId: b.id, statusId: bDone, title: "b-done-2" },
    })

    // Project C: empty — 0% done, no tasks, no at-risk.
    await createProject({ tx, orgId, actor, input: { name: "Empty Backlog" } })
  })
  await ensureAppsForOrg(orgId, {})
})

afterAll(async () => {
  await releaseTestLock()
})

describe("portfolioRollup — bounded cross-project board rollup (BL-263)", () => {
  it("rolls up every active project in ONE call with authoritative per-project counts", async () => {
    const res = await withRlsContext(actor, (tx) => portfolioRollup({ tx, orgId }))
    expect(res.projectCount).toBe(3)
    expect(res.totalProjects).toBe(3)
    expect(res.truncated).toBe(false)

    const a = res.projects.find((p) => p.projectId === projectAId)!
    expect(a).toBeDefined()
    expect(a.projectName).toBe(projectAName)
    expect(a.totalTasks).toBe(5)
    expect(a.doneTasks).toBe(2)
    expect(a.remainingTasks).toBe(3)
    expect(a.overdueTasks).toBe(2) // urgent-overdue + normal-overdue; future-due excluded
    expect(a.percentDone).toBe(40) // 2/5

    // Biggest at-risk = the urgent, most-overdue non-terminal task, with its owner.
    expect(a.biggestAtRisk).not.toBeNull()
    expect(a.biggestAtRisk!.title).toBe("Ship firmware sign-off")
    expect(a.biggestAtRisk!.priority).toBe("urgent")
    expect(a.biggestAtRisk!.daysOverdue).toBe(5)
    expect(a.biggestAtRisk!.assigneeName).toBe("Dana Okafor")
  })

  it("a fully-done project reports 100% and no at-risk task; an empty project reports 0% with no tasks", async () => {
    const res = await withRlsContext(actor, (tx) => portfolioRollup({ tx, orgId }))
    const b = res.projects.find((p) => p.projectName === "Archive Cleanup")!
    expect(b.totalTasks).toBe(2)
    expect(b.percentDone).toBe(100)
    expect(b.overdueTasks).toBe(0)
    expect(b.biggestAtRisk).toBeNull()

    const c = res.projects.find((p) => p.projectName === "Empty Backlog")!
    expect(c.totalTasks).toBe(0)
    expect(c.percentDone).toBe(0)
    expect(c.remainingTasks).toBe(0)
    expect(c.biggestAtRisk).toBeNull()
  })

  it("the limit bounds the rollup and flags truncation + the full project count", async () => {
    const res = await withRlsContext(actor, (tx) => portfolioRollup({ tx, orgId, limit: 1 }))
    expect(res.projectCount).toBe(1)
    expect(res.truncated).toBe(true)
    expect(res.totalProjects).toBe(3)
  })

  it("surfaces the rollup through the projects:portfolio_rollup tool (manifest → handler → rpc bridge)", async () => {
    const out = await executeTool({
      toolName: "projects:portfolio_rollup",
      orgId,
      actor: actor as ActorContext,
      params: {},
    })
    const data = out.data as PortfolioRollupResult
    expect(data.projectCount).toBe(3)
    expect(Array.isArray(data.projects)).toBe(true)
    const a = data.projects.find((p) => p.projectId === projectAId)!
    expect(a.percentDone).toBe(40)
    expect(a.biggestAtRisk!.title).toBe("Ship firmware sign-off")
  })
})
