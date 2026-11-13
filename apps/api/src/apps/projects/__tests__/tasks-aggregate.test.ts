// SPDX-License-Identifier: FSL-1.1-ALv2
//
// tasks_aggregate as an agent and a dashboard meet it: through the real dispatch (manifest ->
// sandbox handler -> rpc bridge -> service), under the caller's RLS.
//   - group by status (board order, empty statuses kept, done left out unless asked), assignee,
//     priority, a choice field, a person field, age in status and SLA state; a series split;
//     sum and avg of an amount field;
//   - each row's `filter` handed to tasks_byProject lists exactly that row's tasks (the drill);
//   - several projects at once;
//   - a caller without the read scope is refused, one of another org counts nothing, and the
//     service under a context with no scopes reads no task;
//   - a dashboard bar block on it saves and runs for the viewer, and its drill (map.drillRows
//     "tasks") lists the bar's tasks, each opening the task.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { tasksAggregate } from "~/apps/projects/service/tasks-aggregate"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { createDashboard, getBlockData, getBlockRows } from "~/modules/dashboards/service"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Hermetic copy of execute-tool (a neighbouring file mock.module()s it; see
// service/assignee-name-enrichment.test.ts for the full story).
const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-tasks-aggregate`
)) as typeof import("~/modules/apps/execute-tool")

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
  "kernel:dashboards:read",
  "kernel:dashboards:write",
]

let orgId: string
let userId: string
let otherId: string
let actor: UserContext

type Json = any

async function run(
  tool: string,
  params: Record<string, unknown>,
  who: UserContext = actor,
): Promise<{ data?: Json; error?: { code?: string; message?: string } }> {
  try {
    const out = (await executeTool({
      toolName: `projects:${tool}`,
      orgId: who.orgId,
      actor: who as ActorContext,
      origin: "mcp",
      params,
    })) as { data?: Json; error?: { code?: string } }
    if (out.data && typeof out.data === "object" && "error" in out.data && out.data.error) {
      return { error: out.data.error }
    }
    return out
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { error: { code: e.code, message: e.message } }
  }
}

async function ok(tool: string, params: Record<string, unknown>, who?: UserContext): Promise<Json> {
  const out = await run(tool, params, who)
  expect({ tool, error: out.error }).toEqual({ tool, error: undefined })
  return out.data
}

const FIELDS = [
  { key: "problem", label: "Problem type", type: "choice", choices: ["Noise", "Power", "Other"] },
  { key: "cost", label: "Cost", type: "amount", currency: "EUR" },
  { key: "handler", label: "Handler", type: "person" },
]

interface Board {
  id: string
  todo: string
  doing: string
  done: string
}

async function makeBoard(fields: unknown[] = FIELDS): Promise<Board> {
  const project = await ok("createProject", {
    name: `agg-${randomUUID().slice(0, 8)}`,
    fields,
    statuses: [{ label: "Todo" }, { label: "Doing" }, { label: "Done", terminal: true }],
  })
  const by = (label: string) =>
    project.statuses.find((s: { label: string }) => s.label === label).id as string
  return { id: project.id, todo: by("Todo"), doing: by("Doing"), done: by("Done") }
}

async function task(board: Board, input: Record<string, unknown>): Promise<string> {
  const t = await ok("create", {
    projectId: board.id,
    title: `t-${randomUUID().slice(0, 6)}`,
    ...input,
  })
  return t.id as string
}

async function backdate(taskId: string, days: number, column: "created_at" | "status_entered_at") {
  const at = new Date(Date.now() - days * 86_400_000).toISOString()
  if (column === "created_at") {
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET created_at = ${at}::timestamptz WHERE id = ${taskId}::uuid`,
    )
  } else {
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET status_entered_at = ${at}::timestamptz WHERE id = ${taskId}::uuid`,
    )
  }
}

/** The rows as {groupLabel: value}. */
function byLabel(rows: Json[]): Record<string, number | null> {
  return Object.fromEntries(rows.map((r: Json) => [r.groupLabel, r.value]))
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = await seedOrgRow({ name: "Tasks Aggregate Org", slug: `tasks-agg-${randomUUID()}` })
  const mk = (name: string) =>
    seedUserRow({
      orgId,
      email: `${name}-${randomUUID()}@test.com`,
      name,
      status: "active",
      passwordHash: "hash",
      authVersion: 1,
      permissionVersion: 1,
    })
  userId = await mk("Ada Manager")
  otherId = await mk("Bo Handler")
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
  await ensureAppsForOrg(orgId, {})
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("tasks_aggregate: groups and measures", () => {
  it("by status: board order, empty open statuses kept, done left out unless includeTerminal", async () => {
    const b = await makeBoard()
    await task(b, { statusId: b.todo })
    await task(b, { statusId: b.todo })
    await task(b, { statusId: b.done })
    const open = await ok("tasks_aggregate", { projectId: b.id })
    expect(open.rows.map((r: Json) => [r.groupLabel, r.value])).toEqual([
      ["Todo", 2],
      ["Doing", 0],
    ])
    expect(open.totalTasks).toBe(2)
    expect(open.truncated).toBe(false)
    const all = await ok("tasks_aggregate", { projectId: b.id, includeTerminal: true })
    expect(byLabel(all.rows)).toEqual({ Todo: 2, Doing: 0, Done: 1 })
  })

  it("by assignee and priority, with a series", async () => {
    const b = await makeBoard()
    await task(b, { assigneeId: userId, priority: "high" })
    await task(b, { assigneeId: otherId, priority: "high" })
    await task(b, { assigneeId: otherId, priority: "low" })
    await task(b, {})
    const people = await ok("tasks_aggregate", { projectId: b.id, groupBy: "assignee" })
    expect(byLabel(people.rows)).toEqual({ "Ada Manager": 1, "Bo Handler": 2, Unassigned: 1 })
    expect(people.rows.at(-1).groupLabel).toBe("Unassigned")
    const split = await ok("tasks_aggregate", {
      projectId: b.id,
      groupBy: "assignee",
      series: "priority",
    })
    const bo = split.rows.filter((r: Json) => r.group === otherId)
    expect(bo.map((r: Json) => [r.seriesLabel, r.value])).toEqual([
      ["High", 1],
      ["Low", 1],
    ])
  })

  it("by a choice field and a person field; sum and avg of an amount field", async () => {
    const b = await makeBoard()
    await task(b, { fields: { problem: "Noise", cost: 10, handler: otherId } })
    await task(b, { fields: { problem: "Noise", cost: 30 } })
    await task(b, { fields: { problem: "Power" } })
    const sums = await ok("tasks_aggregate", {
      projectId: b.id,
      groupBy: "field:problem",
      measure: "sum:cost",
    })
    expect(sums.rows.map((r: Json) => [r.groupLabel, r.value, r.count])).toEqual([
      ["Noise", 40, 2],
      ["Power", 0, 1],
      ["Other", 0, 0],
    ])
    expect(sums.currency).toBe("EUR")
    const avg = await ok("tasks_aggregate", {
      projectId: b.id,
      groupBy: "field:problem",
      measure: "avg:cost",
    })
    expect(byLabel(avg.rows)).toEqual({ Noise: 20, Power: null, Other: null })
    const handlers = await ok("tasks_aggregate", { projectId: b.id, groupBy: "field:handler" })
    expect(byLabel(handlers.rows)).toEqual({ "Bo Handler": 1, "No value": 2 })
  })

  it("refuses an unknown field, a text field as a group and a choice field as a measure", async () => {
    const b = await makeBoard()
    expect(
      (await run("tasks_aggregate", { projectId: b.id, groupBy: "field:nope" })).error?.code,
    ).toBe("unknown_field")
    expect(
      (await run("tasks_aggregate", { projectId: b.id, groupBy: "field:cost" })).error?.code,
    ).toBe("invalid_group")
    expect(
      (await run("tasks_aggregate", { projectId: b.id, measure: "sum:problem" })).error?.code,
    ).toBe("invalid_group")
    expect((await run("tasks_aggregate", { projectId: b.id, groupBy: "sla" })).error?.code).toBe(
      "invalid_params",
    )
    expect((await run("tasks_aggregate", {})).error?.code).toBe("invalid_params")
  })

  it("by age in status, in the default buckets", async () => {
    const b = await makeBoard()
    const fresh = await task(b, {})
    const week = await task(b, {})
    const old = await task(b, {})
    await backdate(week, 5, "status_entered_at")
    await backdate(old, 40, "status_entered_at")
    const out = await ok("tasks_aggregate", { projectId: b.id, groupBy: "age_in_status" })
    expect(out.rows.map((r: Json) => r.group)).toEqual([
      "<1d",
      "1-3d",
      "3-7d",
      "7-14d",
      "14-30d",
      "30d+",
    ])
    expect(byLabel(out.rows)).toMatchObject({
      "Less than 1 day": 1,
      "3 to 7 days": 1,
      "30 days or more": 1,
    })
    expect(out.rows[0].taskIds).toEqual([fresh])
    expect(out.rows[5].taskIds).toEqual([old])
  })

  it("by SLA state: met, missed, open on time, open late", async () => {
    const b = await makeBoard()
    const met = await task(b, {})
    await ok("update", { taskId: met, statusId: b.doing })
    const missed = await task(b, {})
    await backdate(missed, 30, "created_at")
    await ok("update", { taskId: missed, statusId: b.doing })
    const openOk = await task(b, {})
    const openLate = await task(b, {})
    await backdate(openLate, 30, "created_at")
    const out = await ok("tasks_aggregate", {
      projectId: b.id,
      groupBy: "sla",
      sla: { toStatusIds: [b.doing], withinWorkingDays: 3 },
    })
    expect(out.rows.map((r: Json) => [r.group, r.taskIds])).toEqual([
      ["met", [met]],
      ["missed", [missed]],
      ["open_ok", [openOk]],
      ["open_late", [openLate]],
    ])
  })

  it("sums amounts per currency: projects in EUR and USD are never added together", async () => {
    const eur = await makeBoard()
    const usd = await makeBoard(
      FIELDS.map((f) => (f.key === "cost" ? { ...f, currency: "USD" } : f)),
    )
    await task(eur, { statusId: eur.todo, fields: { cost: 10 } })
    await task(eur, { statusId: eur.todo, fields: { cost: 5 } })
    await task(usd, { statusId: usd.todo, fields: { cost: 100 } })
    const out = await ok("tasks_aggregate", {
      projectIds: [eur.id, usd.id],
      groupBy: "status",
      measure: "sum:cost",
    })
    const todo = out.rows
      .filter((r: Json) => r.groupLabel === "Todo")
      .map((r: Json) => [r.currency, r.value, r.count])
    expect(todo).toEqual([
      ["EUR", 15, 2],
      ["USD", 100, 1],
    ])
    expect(out.rows.every((r: Json) => typeof r.currency === "string")).toBe(true)
    expect(out.currency).toBeUndefined()
    // One currency across the projects read: the result says it.
    const one = await ok("tasks_aggregate", { projectId: eur.id, measure: "sum:cost" })
    expect(one.currency).toBe("EUR")
  })

  it("several projects at once: a status groups by its label", async () => {
    const a = await makeBoard()
    const b = await makeBoard()
    await task(a, { statusId: a.todo })
    await task(b, { statusId: b.todo })
    await task(b, { statusId: b.doing })
    const out = await ok("tasks_aggregate", { projectIds: [a.id, b.id] })
    expect(byLabel(out.rows)).toEqual({ Doing: 1, Todo: 2 })
    expect(out.rows.every((r: Json) => r.filter === undefined)).toBe(true)
  })
})

describe("tasks_aggregate: the drill", () => {
  it("each row's filter, handed to tasks_byProject, lists exactly its tasks", async () => {
    const b = await makeBoard()
    await task(b, { assigneeId: otherId, fields: { problem: "Noise" }, priority: "urgent" })
    await task(b, { assigneeId: otherId, fields: { problem: "Power" } })
    await task(b, { fields: { problem: "Noise" }, statusId: b.doing })
    await task(b, { statusId: b.done, fields: { problem: "Noise" } })
    for (const params of [
      { groupBy: "status" },
      { groupBy: "assignee" },
      { groupBy: "priority" },
      { groupBy: "due" },
      { groupBy: "field:problem", series: "assignee" },
      { groupBy: "status", where: { fields: { problem: "Noise" } } },
    ]) {
      const out = await ok("tasks_aggregate", { projectId: b.id, ...params })
      for (const row of out.rows) {
        expect({ params, group: row.group, hasFilter: !!row.filter }).toEqual({
          params,
          group: row.group,
          hasFilter: true,
        })
        const listed = await ok("tasks_byProject", row.filter)
        expect({
          params,
          row: row.groupLabel,
          ids: listed.items.map((t: Json) => t.id).sort(),
        }).toEqual({
          params,
          row: row.groupLabel,
          ids: [...row.taskIds].sort(),
        })
      }
    }
  })
})

describe("tasks_aggregate: permissions", () => {
  it("refuses a caller without projects:tasks:read; another org's member counts nothing", async () => {
    const b = await makeBoard()
    await task(b, {})
    const noScope = await run(
      "tasks_aggregate",
      { projectId: b.id },
      {
        ...actor,
        userId: otherId,
        scopes: ["kernel:threads:read"],
      },
    )
    expect(noScope.data).toBeUndefined()
    expect(noScope.error).toBeDefined()

    const otherOrgId = await seedOrgRow({ name: "Agg Other", slug: `agg-other-${randomUUID()}` })
    await ensureAppsForOrg(otherOrgId, {})
    const stranger = await seedUserRow({
      orgId: otherOrgId,
      email: `stranger-${randomUUID()}@test.com`,
      name: "Stranger",
      status: "active",
      passwordHash: "hash",
      authVersion: 1,
      permissionVersion: 1,
    })
    const out = await ok(
      "tasks_aggregate",
      { projectId: b.id },
      { ...actor, orgId: otherOrgId, userId: stranger },
    )
    expect(out.totalTasks).toBe(0)
    expect(out.rows).toEqual([])
  })

  it("the service under the viewer's RLS: no read scope reads no task", async () => {
    const b = await makeBoard()
    await task(b, {})
    const count = (who: UserContext) =>
      withRlsContext(who, (tx) => tasksAggregate({ tx, orgId, projectId: b.id }))
    expect((await count(actor)).totalTasks).toBe(1)
    expect((await count({ ...actor, userId: otherId, scopes: [] })).totalTasks).toBe(0)
  })
})

describe("tasks_aggregate as a dashboard source", () => {
  it("a bar block on it saves and runs for the viewer", async () => {
    const b = await makeBoard()
    await task(b, { statusId: b.todo })
    await task(b, { statusId: b.doing })
    await task(b, { statusId: b.doing })
    const d = await createDashboard(actor, {
      title: "Project overview",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "by-status",
            type: "bar",
            title: "Open tasks by status",
            source: { kind: "tool", tool: "projects:tasks_aggregate", params: { projectId: b.id } },
            map: { x: "groupLabel", y: "value" },
          },
        ],
      },
    })
    const out = (await getBlockData(actor, d.id, "by-status")) as Json
    expect(out.ok).toBe(true)
    expect(JSON.stringify(out.data)).toContain("Doing")
  })
})

describe("the Project overview dashboard (docs/apps/projects.md)", () => {
  it("an agent creates it in one dashboards_create call; every block runs", async () => {
    const b = await makeBoard()
    const todoTitle = `overview-${randomUUID().slice(0, 6)}`
    const todoId = await task(b, {
      statusId: b.todo,
      assigneeId: otherId,
      dueDate: "2020-01-01",
      title: todoTitle,
    })
    await task(b, { statusId: b.doing })
    const aggregate = (params: Record<string, unknown>) => ({
      kind: "tool",
      tool: "projects:tasks_aggregate",
      params: { projectId: b.id, ...params },
    })
    const bar = {
      x: "groupLabel",
      y: "value",
      drillRows: "tasks",
      link: { entity: "task", idField: "id", app: "projects" },
    }
    const spec = {
      v: 1,
      blocks: [
        {
          id: "open",
          type: "metric",
          title: "Open tasks",
          source: aggregate({}),
          map: { value: "value", agg: "sum" },
        },
        { id: "status", type: "bar", title: "By status", source: aggregate({}), map: bar },
        {
          id: "handler",
          type: "bar",
          title: "By handler",
          source: aggregate({ groupBy: "assignee" }),
          map: bar,
        },
        {
          id: "aging",
          type: "bar",
          title: "Time in status",
          source: aggregate({ groupBy: "age_in_status" }),
          map: bar,
        },
        {
          id: "sla",
          type: "metric",
          title: "SLA missed",
          source: aggregate({
            groupBy: "sla",
            sla: { toStatusIds: [b.doing], withinWorkingDays: 2 },
          }),
          map: {
            value: "value",
            agg: "sum",
            where: [{ field: "group", op: "in", value: ["missed", "open_late"] }],
          },
        },
        {
          id: "overdue",
          type: "table",
          title: "Overdue",
          source: {
            kind: "tool",
            tool: "projects:tasks_byProject",
            params: { projectId: b.id, due: "overdue" },
          },
          map: {
            columns: [
              { field: "title", label: "Task" },
              { field: "assigneeName", label: "Handler" },
              { field: "dueDate", label: "Due" },
            ],
            link: { entity: "task", idField: "id", app: "projects" },
          },
        },
      ],
    }
    const created = (await executeTool({
      toolName: "kernel:dashboards_create",
      orgId,
      actor: actor as ActorContext,
      origin: "mcp",
      params: { title: "Project overview", visibility: "personal", spec },
    })) as { data?: Json }
    const id = created.data?.id ?? created.data?.dashboard?.id
    expect(typeof id).toBe("string")
    const run = async (block: string) => (await getBlockData(actor, id, block)) as Json
    expect(await run("open")).toMatchObject({ ok: true, data: { value: 2 } })
    for (const block of ["status", "handler", "aging", "sla"]) {
      expect({ block, ok: (await run(block)).ok }).toEqual({ block, ok: true })
    }
    const overdue = await run("overdue")
    expect(overdue.ok).toBe(true)
    expect(overdue.data.rows).toHaveLength(1)
    // A bar's drill lists its tasks (not the group row), each opening the task.
    const drill = (await getBlockRows(actor, id, "status", { category: "Todo" })) as Json
    expect(drill.ok).toBe(true)
    expect(drill.total).toBe(1)
    expect(drill.rows[0].title).toBe(todoTitle)
    expect(drill.columns.map((c: { field: string }) => c.field)).toEqual([
      "title",
      "status",
      "assigneeName",
    ])
    expect(drill.links).toEqual([
      { kind: "entity", app: "projects", entityType: "task", id: todoId },
    ])
  })
})
