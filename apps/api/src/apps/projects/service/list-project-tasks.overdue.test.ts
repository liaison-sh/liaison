// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-row server-computed `overdue` boolean on listProjectTasks / listTasksAcrossProjects (the
// tasks_byProject + tasks_byAssignee tools). A launch/board-digest routine tick (e.g.
// synth-summit-modular-expo-calendar-blockout-routine) must DISCRIMINATE the OVERDUE tasks (past due
// date, non-terminal) from on-track ones. Per the l710/l711 "compute the discrimination server-side"
// doctrine, the flash-lite tick RENDERS a boolean it cannot reliably compute from `dueDate < today`
// date math. This locks the SQL semantics: overdue === (due_date in the PAST AND status non-terminal):
//   • a past-due NON-terminal task → overdue:true
//   • a FUTURE-due non-terminal task → overdue:false
//   • a no-due-date non-terminal task → overdue:false
//   • a past-due DONE (terminal) task → overdue:false (a finished task is never "overdue")
// Fails-without (the field is undefined → every assertion that reads `.overdue` is undefined),
// passes-with the server-computed flag.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { createProject } from "~/apps/projects/service/create-project"
import {
  createTask,
  listProjectTasks,
  listTasksAcrossProjects,
} from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"

const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-overdue`
)) as typeof import("~/modules/apps/execute-tool")

import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let actor: UserContext
let projectId: string
let openStatusId: string
let doneStatusId: string

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

// Titles the tasks are keyed by so the assertions can pick each row out of the list.
const T_OVERDUE = "overdue-past-due-nonterminal"
const T_FUTURE = "ontrack-future-due"
const T_NODUE = "ontrack-no-due-date"
const T_DONE_PAST = "done-but-past-due"

beforeAll(async () => {
  await acquireTestLock()
  const orgRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Proj Overdue', ${`proj-overdue-${Date.now()}-${Math.random()}`}) RETURNING id
    `),
  )
  orgId = orgRows[0]!.id
  const userRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`po-${Date.now()}@xp.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
    `),
  )
  userId = userRows[0]!.id
  actor = {
    actorType: "user",
    userId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }

  await withRlsContext(actor, async (tx) => {
    const p = await createProject({ tx, orgId, actor, input: { name: "Overdue board" } })
    projectId = p.id
    openStatusId = p.statuses.find((s) => !s.terminal)!.id
    doneStatusId = p.statuses.find((s) => s.terminal)!.id
    // Four tasks pinning each overdue-semantics corner. Assign all to userId so the
    // cross-project (tasks_byAssignee) path covers the same rows.
    await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        statusId: openStatusId,
        title: T_OVERDUE,
        assigneeId: userId,
        dueDate: "2000-01-01",
      },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        statusId: openStatusId,
        title: T_FUTURE,
        assigneeId: userId,
        dueDate: "2999-12-31",
      },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        statusId: openStatusId,
        title: T_NODUE,
        assigneeId: userId,
        dueDate: null,
      },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: {
        projectId,
        statusId: doneStatusId,
        title: T_DONE_PAST,
        assigneeId: userId,
        dueDate: "2000-01-01",
      },
    })
  })
  await ensureAppsForOrg(orgId, {})
})

afterAll(async () => {
  await releaseTestLock()
})

function byTitle(items: { title: string; overdue: boolean }[], title: string) {
  const row = items.find((t) => t.title === title)
  if (!row) throw new Error(`row "${title}" not returned`)
  return row
}

describe("listProjectTasks — server-computed per-row `overdue` flag", () => {
  it("flags ONLY the past-due non-terminal task as overdue (future / no-due / done-past are not)", async () => {
    const res = await withRlsContext(actor, async (tx) =>
      listProjectTasks({ tx, orgId, projectId } as never),
    )
    expect(byTitle(res.items, T_OVERDUE).overdue).toBe(true)
    expect(byTitle(res.items, T_FUTURE).overdue).toBe(false)
    expect(byTitle(res.items, T_NODUE).overdue).toBe(false)
    // A past-due DONE task is terminal → never "overdue" however old its due date.
    expect(byTitle(res.items, T_DONE_PAST).overdue).toBe(false)
    // The overdue set is exactly one — discrimination, not everything-or-nothing.
    expect(res.items.filter((t) => t.overdue).length).toBe(1)
  })

  it("surfaces the `overdue` flag through the projects:tasks_byProject tool (manifest → rpc bridge)", async () => {
    const out = await executeTool({
      toolName: "projects:tasks_byProject",
      orgId,
      actor: actor as ActorContext,
      params: { projectId },
    })
    const data = out.data as { items: { title: string; overdue: boolean }[] }
    expect(byTitle(data.items, T_OVERDUE).overdue).toBe(true)
    expect(byTitle(data.items, T_FUTURE).overdue).toBe(false)
    expect(byTitle(data.items, T_DONE_PAST).overdue).toBe(false)
  })

  it("listTasksAcrossProjects (tasks_byAssignee) carries the same overdue discrimination", async () => {
    const res = await withRlsContext(actor, async (tx) =>
      listTasksAcrossProjects({ tx, orgId, assigneeId: userId } as never),
    )
    expect(byTitle(res.items, T_OVERDUE).overdue).toBe(true)
    expect(byTitle(res.items, T_FUTURE).overdue).toBe(false)
    expect(byTitle(res.items, T_DONE_PAST).overdue).toBe(false)
    expect(res.items.filter((t) => t.overdue).length).toBe(1)
  })

  it("moving the overdue task to a terminal status clears its overdue flag (terminal exclusion)", async () => {
    await withRlsContext(actor, async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("tasks")} SET status_id = ${doneStatusId}::uuid, updated_at = now()
        WHERE org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid AND title = ${T_OVERDUE}
      `)
    })
    const res = await withRlsContext(actor, async (tx) =>
      listProjectTasks({ tx, orgId, projectId } as never),
    )
    expect(byTitle(res.items, T_OVERDUE).overdue).toBe(false)
    // Nothing left overdue now (the only past-due non-terminal task became terminal).
    expect(res.items.filter((t) => t.overdue).length).toBe(0)
  })
})
