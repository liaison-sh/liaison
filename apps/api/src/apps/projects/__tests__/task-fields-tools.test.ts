// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-project typed task fields, status transitions and templates v2, as an agent meets them:
// through the real dispatch (manifest -> sandbox handler -> rpc bridge -> service).
//   - fields_set: definitions validated by the dashboard column rules; a removed definition keeps
//     its values hidden and restores them when re-added; a type change or a choice option still
//     held is refused (renames rewrite values).
//   - create / update: values checked per type (422 naming the field), required on create,
//     partial updates, null empties, `changedFields` is the real diff.
//   - every status change (create, update, move, cross-project move of a subtree, status
//     migration) writes one transition and one `task:status_changed` event; no change, none.
//   - tasks_byProject filters on field values and returns them with statusEnteredAt; get returns
//     the transitions.
//   - templates: a legacy array still instantiates, v2 carries statuses + fields + values,
//     template_save copies a project, an invalid value in a template is refused at save.
//   - RLS: a user without projects:projects:read reads no transition and no task.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { migrateStatusTasks } from "~/apps/projects/service/statuses"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ownerCanSeeEventEntity } from "~/infra/jobs/event-routine-gate"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Hermetic copy of execute-tool (a neighbouring file mock.module()s it; see
// service/assignee-name-enrichment.test.ts for the full story).
const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-task-fields-tools`
)) as typeof import("~/modules/apps/execute-tool")

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

let orgId: string
let userId: string
let otherMemberId: string
let actor: UserContext

type Origin = "mcp" | "in-app-agent" | "human-ui"

type Json = any

async function run(
  tool: string,
  params: Record<string, unknown>,
  origin: Origin = "mcp",
): Promise<{ data?: Json; error?: { code?: string; message?: string } }> {
  try {
    const out = (await executeTool({
      toolName: `projects:${tool}`,
      orgId,
      actor: actor as ActorContext,
      origin,
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

async function ok(tool: string, params: Record<string, unknown>, origin?: Origin): Promise<Json> {
  const out = await run(tool, params, origin)
  expect({ tool, error: out.error }).toEqual({ tool, error: undefined })
  return out.data
}

const FIELDS = [
  { key: "problem", label: "Problem type", type: "choice", choices: ["Noise", "Power", "Other"] },
  { key: "serial", label: "Serial number", type: "text" },
  { key: "cost", label: "Cost", type: "amount", currency: "EUR" },
  { key: "handler", label: "Handler", type: "person" },
  { key: "parts", label: "Parts", type: "choices", choices: ["Fan", "Board", "Cable"] },
  { key: "ref", label: "Linked record", type: "link" },
]

interface Board {
  id: string
  statuses: Array<{ id: string; label: string; terminal: boolean }>
  open: string
  next: string
  done: string
}

async function makeBoard(fields: unknown[] = FIELDS, statuses?: unknown[]): Promise<Board> {
  const project = await ok("createProject", {
    name: `fields-${randomUUID().slice(0, 8)}`,
    fields,
    ...(statuses ? { statuses } : {}),
  })
  const open = project.statuses.filter((s: { terminal: boolean }) => !s.terminal)
  return {
    id: project.id,
    statuses: project.statuses,
    open: open[0].id,
    next: open[1]?.id ?? open[0].id,
    done: project.statuses.find((s: { terminal: boolean }) => s.terminal).id,
  }
}

async function transitions(taskId: string) {
  return extractRows<{
    from_status_id: string | null
    to_status_id: string
    actor_type: string
    actor_id: string | null
    project_id: string
  }>(
    await db.execute(drizzleSql`
      SELECT from_status_id, to_status_id, actor_type, actor_id, project_id
      FROM app_projects.task_transitions WHERE task_id = ${taskId}::uuid ORDER BY "at", created_at
    `),
  )
}

async function events(taskId: string, action: string): Promise<Json[]> {
  const rows = extractRows<{ data: Json }>(
    await db.execute(drizzleSql`
      SELECT payload->'data' AS data FROM kernel.pending_events
      WHERE payload->>'entityId' = ${taskId} AND payload->>'entity' = 'task'
        AND payload->>'action' = ${action}
      ORDER BY seq ASC
    `),
  )
  return rows.map((r) => r.data)
}

async function storedFields(taskId: string): Promise<Record<string, unknown>> {
  const [row] = extractRows<{ fields: Record<string, unknown> }>(
    await db.execute(drizzleSql`SELECT fields FROM app_projects.tasks WHERE id = ${taskId}::uuid`),
  )
  return row!.fields
}

async function insertUser(name: string): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-${randomUUID()}@test.com`}, ${name}, 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  return u!.id
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Task Fields Org', ${`task-fields-${randomUUID()}`})
      RETURNING id
    `),
  )
  orgId = org!.id
  userId = await insertUser("Field Tester")
  otherMemberId = await insertUser("Second Member")
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
  await ensureAppsForOrg(orgId, {})
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("fields_set: field definitions", () => {
  it("createProject declares fields; get(projectId) returns them; fields_set replaces the list", async () => {
    const board = await makeBoard()
    const project = await ok("get", { projectId: board.id })
    expect(project.fields.map((f: { key: string }) => f.key)).toEqual(FIELDS.map((f) => f.key))
    const set = await ok("fields_set", {
      projectId: board.id,
      fields: [FIELDS[1], FIELDS[0]],
    })
    expect(set.fields.map((f: { key: string }) => f.key)).toEqual(["serial", "problem"])
    const again = await ok("get", { projectId: board.id })
    expect(again.fields.map((f: { key: string }) => f.key)).toEqual(["serial", "problem"])
  })

  it("refuses a duplicate key and an amount without currency, writing nothing", async () => {
    const board = await makeBoard([FIELDS[1]])
    const dup = await run("fields_set", { projectId: board.id, fields: [FIELDS[1], FIELDS[1]] })
    expect(dup.error?.code).toBe("invalid_fields")
    const noCurrency = await run("fields_set", {
      projectId: board.id,
      fields: [{ key: "cost", label: "Cost", type: "amount" }],
    })
    expect(noCurrency.error?.code).toBe("invalid_fields")
    expect(noCurrency.error?.message).toContain("currency")
    const project = await ok("get", { projectId: board.id })
    expect(project.fields.map((f: { key: string }) => f.key)).toEqual(["serial"])
  })

  it("refuses a type change while tasks hold values; allows it once they are emptied", async () => {
    const board = await makeBoard([FIELDS[1]])
    const task = await ok("create", {
      projectId: board.id,
      title: "has serial",
      fields: { serial: "SN-1" },
    })
    const change = await run("fields_set", {
      projectId: board.id,
      fields: [{ key: "serial", label: "Serial number", type: "number" }],
    })
    expect(change.error?.code).toBe("field_type_in_use")
    await ok("update", { taskId: task.id, fields: { serial: null } })
    await ok("fields_set", {
      projectId: board.id,
      fields: [{ key: "serial", label: "Serial number", type: "number" }],
    })
  })

  it("a removed field keeps its values hidden and re-adding it restores them; re-adding with another type is refused", async () => {
    const board = await makeBoard([FIELDS[0], FIELDS[1]])
    const task = await ok("create", {
      projectId: board.id,
      title: "t",
      fields: { problem: "Noise", serial: "SN-9" },
    })
    await ok("fields_set", { projectId: board.id, fields: [FIELDS[0]] })
    const hidden = await ok("get", { taskId: task.id })
    expect(hidden.fields).toEqual({ problem: "Noise" })
    expect((await storedFields(task.id)).serial).toBe("SN-9")
    const retyped = await run("fields_set", {
      projectId: board.id,
      fields: [FIELDS[0], { key: "serial", label: "Serial", type: "checkbox" }],
    })
    expect(retyped.error?.code).toBe("field_type_in_use")
    await ok("fields_set", { projectId: board.id, fields: [FIELDS[0], FIELDS[1]] })
    const restored = await ok("get", { taskId: task.id })
    expect(restored.fields).toEqual({ problem: "Noise", serial: "SN-9" })
  })

  it("removing a choice option tasks use is refused unless renamed; a rename rewrites the values", async () => {
    const board = await makeBoard([FIELDS[0], FIELDS[4]])
    const task = await ok("create", {
      projectId: board.id,
      title: "t",
      fields: { problem: "Noise", parts: ["Fan", "Cable"] },
    })
    const removed = await run("fields_set", {
      projectId: board.id,
      fields: [{ ...FIELDS[0], choices: ["Power", "Other"] }, FIELDS[4]],
    })
    expect(removed.error?.code).toBe("choice_in_use")
    await ok("fields_set", {
      projectId: board.id,
      fields: [
        { ...FIELDS[0], choices: ["Acoustic", "Power", "Other"] },
        { ...FIELDS[4], choices: ["Fan", "Board", "Wiring"] },
      ],
      renames: { problem: { Noise: "Acoustic" }, parts: { Cable: "Wiring" } },
    })
    const after = await ok("get", { taskId: task.id })
    expect(after.fields).toEqual({ problem: "Acoustic", parts: ["Fan", "Wiring"] })
  })
})

describe("create / update: field values", () => {
  it("checks each value by its type and names the refused field", async () => {
    const board = await makeBoard()
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ problem: "Smoke" }, "invalid_field", "problem"],
      [{ handler: randomUUID() }, "invalid_field", "handler"],
      [{ ref: { app: "tickets", id: "x" } }, "invalid_field", "ref"],
      [{ cost: "12" }, "invalid_field", "cost"],
      [{ nope: 1 }, "unknown_field", "nope"],
    ]
    for (const [fields, code, field] of cases) {
      const out = await run("create", { projectId: board.id, title: "bad", fields })
      expect({ fields, code: out.error?.code }).toEqual({ fields, code })
      expect(out.error?.message).toContain(`'${field}'`)
    }
    const good = await ok("create", {
      projectId: board.id,
      title: "good",
      fields: {
        problem: "Power",
        handler: otherMemberId,
        cost: 42.5,
        parts: ["Fan", "Fan", "Board"],
        ref: { app: "tickets", entityType: "ticket", id: "t-1", label: "A ticket" },
      },
    })
    expect(good.fields).toEqual({
      problem: "Power",
      handler: otherMemberId,
      cost: 42.5,
      parts: ["Fan", "Board"],
      // The caller holds no tickets scope: the link's label is hidden (dashboard tables' rule).
      ref: { app: "tickets", entityType: "ticket", id: "t-1", label: "Linked record" },
    })
    expect((await storedFields(good.id)).ref).toEqual({
      app: "tickets",
      entityType: "ticket",
      id: "t-1",
      label: "A ticket",
    })
  })

  it("a required field is required on a tool create, never on a template or a project's initial tasks", async () => {
    const required = [{ ...FIELDS[1], required: true }]
    const board = await makeBoard(required)
    const missing = await run("create", { projectId: board.id, title: "no serial" })
    expect(missing.error?.code).toBe("invalid_field")
    expect(missing.error?.message).toContain("'serial'")
    await ok("create", { projectId: board.id, title: "with", fields: { serial: "S" } })
    const withTasks = await ok("createProject", {
      name: `req-${randomUUID().slice(0, 8)}`,
      fields: required,
      tasks: [{ title: "initial" }],
    })
    expect(withTasks.taskCount).toBe(1)
  })

  it("a partial update leaves other values, null empties one, changedFields lists only what differs", async () => {
    const board = await makeBoard()
    const task = await ok("create", {
      projectId: board.id,
      title: "t",
      fields: { problem: "Noise", serial: "A" },
    })
    const updated = await ok("update", {
      taskId: task.id,
      title: "t",
      priority: "normal",
      fields: { serial: "B", problem: "Noise" },
    })
    expect(updated.fields).toEqual({ problem: "Noise", serial: "B" })
    const [evt] = (await events(task.id, "updated")).slice(-1)
    expect(evt.changedFields).toEqual(["fields.serial"])
    const cleared = await ok("update", { taskId: task.id, fields: { serial: null } })
    expect(cleared.fields).toEqual({ problem: "Noise" })
    const [evt2] = (await events(task.id, "updated")).slice(-1)
    expect(evt2.changedFields).toEqual(["fields.serial"])
  })
})

describe("transitions and task:status_changed", () => {
  it("create records a transition from nothing; update and move each record one with from/to; no change records none", async () => {
    const board = await makeBoard()
    const task = await ok("create", { projectId: board.id, title: "t", statusId: board.open })
    let rows = await transitions(task.id)
    expect(rows.map((r) => [r.from_status_id, r.to_status_id])).toEqual([[null, board.open]])
    let changed = await events(task.id, "status_changed")
    expect(changed).toHaveLength(1)
    expect(changed[0].fromStatusId).toBeNull()
    expect(changed[0].toStatusId).toBe(board.open)

    await ok("update", { taskId: task.id, statusId: board.next })
    await ok("update", { taskId: task.id, title: "renamed" })
    await ok("move", { taskId: task.id, statusId: board.done })
    await ok("move", { taskId: task.id, statusId: board.done })
    rows = await transitions(task.id)
    expect(rows.map((r) => [r.from_status_id, r.to_status_id])).toEqual([
      [null, board.open],
      [board.open, board.next],
      [board.next, board.done],
    ])
    changed = await events(task.id, "status_changed")
    expect(changed.map((e) => [e.fromStatusId, e.toStatusId])).toEqual([
      [null, board.open],
      [board.open, board.next],
      [board.next, board.done],
    ])
    const doneLabel = board.statuses.find((s) => s.id === board.done)!.label
    expect(changed[2].toStatusLabel).toBe(doneLabel)
    expect(changed[2].terminal).toBe(true)
    const [moved] = (await events(task.id, "moved")).slice(-1)
    expect(moved.fromStatusId).toBe(board.done)

    const detail = await ok("get", { taskId: task.id })
    expect(detail.transitions.map((t: Json) => t.toStatusId)).toEqual([
      board.done,
      board.next,
      board.open,
    ])
    expect(typeof detail.statusEnteredAt).toBe("string")
  })

  it("records the actor: an agent's call is agent, a person's in the app is user", async () => {
    const board = await makeBoard()
    const viaAgent = await ok("create", { projectId: board.id, title: "a" }, "mcp")
    const viaPerson = await ok("create", { projectId: board.id, title: "p" }, "human-ui")
    expect((await transitions(viaAgent.id))[0]!.actor_type).toBe("agent")
    const person = (await transitions(viaPerson.id))[0]!
    expect(person.actor_type).toBe("user")
    expect(person.actor_id).toBe(userId)
  })

  it("a status migration records one transition per moved task", async () => {
    const board = await makeBoard()
    const a = await ok("create", { projectId: board.id, title: "a", statusId: board.open })
    const b = await ok("create", { projectId: board.id, title: "b", statusId: board.open })
    await withRlsContext(actor, (tx) =>
      migrateStatusTasks({
        tx,
        orgId,
        projectId: board.id,
        sourceStatusId: board.open,
        targetStatusId: board.next,
        actor,
      }),
    )
    for (const t of [a, b]) {
      const rows = await transitions(t.id)
      expect(rows.at(-1)).toMatchObject({ from_status_id: board.open, to_status_id: board.next })
      expect((await events(t.id, "status_changed")).at(-1).toStatusId).toBe(board.next)
    }
  })

  it("a cross-project move records a transition for every task of the subtree and hides values the destination does not fit", async () => {
    const source = await makeBoard([FIELDS[0], FIELDS[1]])
    const target = await makeBoard([{ key: "serial", label: "Serial", type: "number" }, FIELDS[0]])
    const root = await ok("create", {
      projectId: source.id,
      title: "root",
      fields: { problem: "Noise", serial: "SN-1" },
    })
    const child = await ok("create", {
      projectId: source.id,
      title: "child",
      parentTaskId: root.id,
    })
    await ok("move", { taskId: root.id, projectId: target.id })
    for (const t of [root, child]) {
      const last = (await transitions(t.id)).at(-1)!
      expect(last.project_id).toBe(target.id)
      expect(last.from_status_id).toBe(source.open)
    }
    const moved = await ok("get", { taskId: root.id })
    expect(moved.fields).toEqual({ problem: "Noise" })
    const [evt] = (await events(root.id, "moved")).slice(-1)
    expect(evt.hiddenFields).toEqual(["serial"])
    // Moving back brings the value it put aside.
    await ok("move", { taskId: root.id, projectId: source.id })
    expect((await ok("get", { taskId: root.id })).fields).toEqual({
      problem: "Noise",
      serial: "SN-1",
    })
  })
})

describe("tasks_byProject: field filters and rows", () => {
  it("filters by equal, any of and empty, and returns fields + statusEnteredAt per row", async () => {
    const board = await makeBoard()
    const noise = await ok("create", {
      projectId: board.id,
      title: "n",
      fields: { problem: "Noise" },
    })
    const power = await ok("create", {
      projectId: board.id,
      title: "p",
      fields: { problem: "Power" },
    })
    const none = await ok("create", { projectId: board.id, title: "x" })
    await ok("create", { projectId: board.id, title: "f", fields: { parts: ["Fan", "Board"] } })
    const ids = async (fields: Record<string, unknown>) =>
      ((await ok("tasks_byProject", { projectId: board.id, fields })).items as Json[])
        .map((t) => t.id)
        .sort()
    expect(await ids({ problem: "Noise" })).toEqual([noise.id])
    expect(await ids({ problem: ["Noise", "Power"] })).toEqual([noise.id, power.id].sort())
    expect((await ids({ problem: null })).includes(none.id)).toBe(true)
    expect((await ids({ problem: null })).includes(noise.id)).toBe(false)
    expect(await ids({ parts: "Board" })).toHaveLength(1)
    const unknown = await run("tasks_byProject", { projectId: board.id, fields: { nope: 1 } })
    expect(unknown.error?.code).toBe("unknown_field")
    const rows = (await ok("tasks_byProject", { projectId: board.id })).items as Json[]
    const row = rows.find((t) => t.id === noise.id)
    expect(row.fields).toEqual({ problem: "Noise" })
    expect(typeof row.statusEnteredAt).toBe("string")
  })
})

describe("templates v2", () => {
  it("a legacy array template still instantiates its task tree", async () => {
    const templateId = randomUUID()
    await db.execute(drizzleSql`
      INSERT INTO app_projects.project_templates (id, org_id, name, structure, created_by)
      VALUES (${templateId}::uuid, ${orgId}::uuid, 'Legacy',
        ${JSON.stringify([{ title: "Parent", children: [{ title: "Child" }] }])}::jsonb, ${userId}::uuid)
    `)
    const out = await ok("instantiate_template", {
      templateId,
      projectName: `legacy-${randomUUID().slice(0, 6)}`,
    })
    const rows = (await ok("tasks_byProject", { projectId: out.projectId })).items as Json[]
    expect(rows.map((t) => t.title).sort()).toEqual(["Child", "Parent"])
  })

  it("template_save + instantiate_template: statuses, fields and task values; a copy of a project round-trips", async () => {
    const saved = await ok("template_save", {
      name: "Repairs",
      statuses: [
        { label: "Received" },
        { label: "Diagnosed" },
        { label: "Closed", terminal: true },
      ],
      fields: [FIELDS[0], FIELDS[1]],
      tasks: [
        {
          title: "Intake",
          priority: "high",
          statusLabel: "Diagnosed",
          fields: { problem: "Noise" },
          children: [{ title: "Check serial" }],
        },
      ],
    })
    expect(saved).toMatchObject({ name: "Repairs", statusCount: 3, fieldCount: 2, taskCount: 2 })
    const listed = await ok("templates_list", {})
    expect(listed.items.some((t: Json) => t.id === saved.id)).toBe(true)

    const out = await ok("instantiate_template", {
      templateId: saved.id,
      projectName: `repairs-${randomUUID().slice(0, 6)}`,
    })
    const project = await ok("get", { projectId: out.projectId })
    expect(project.statuses.map((s: Json) => s.label)).toEqual(["Received", "Diagnosed", "Closed"])
    expect(project.fields.map((f: Json) => f.key)).toEqual(["problem", "serial"])
    const rows = (await ok("tasks_byProject", { projectId: out.projectId })).items as Json[]
    const intake = rows.find((t) => t.title === "Intake")
    expect(intake.fields).toEqual({ problem: "Noise" })
    expect(intake.priority).toBe("high")
    expect(intake.statusLabel).toBe("Diagnosed")

    const copy = await ok("template_save", { name: "Copy", fromProjectId: out.projectId })
    expect(copy.structure.statuses.map((s: Json) => s.label)).toEqual([
      "Received",
      "Diagnosed",
      "Closed",
    ])
    expect(copy.structure.fields.map((f: Json) => f.key)).toEqual(["problem", "serial"])
    expect(copy.structure.tasks[0]).toMatchObject({
      title: "Intake",
      priority: "high",
      statusLabel: "Diagnosed",
      fields: { problem: "Noise" },
      children: [{ title: "Check serial" }],
    })
  })

  it("refuses at save a task value its fields do not allow, and an unknown status", async () => {
    const badValue = await run("template_save", {
      name: "Bad",
      fields: [FIELDS[0]],
      tasks: [{ title: "x", fields: { problem: "Smoke" } }],
    })
    expect(badValue.error?.code).toBe("invalid_field")
    const badStatus = await run("template_save", {
      name: "Bad",
      statuses: [{ label: "Open" }, { label: "Done", terminal: true }],
      tasks: [{ title: "x", statusLabel: "Elsewhere" }],
    })
    expect(badStatus.error?.code).toBe("invalid_template")
  })
})

describe("RLS on fields and transitions", () => {
  it("transitions are readable exactly when the task is: a user with no projects read scope and another org read none", async () => {
    const board = await makeBoard()
    const task = await ok("create", { projectId: board.id, title: "t", fields: { serial: "S" } })
    const count = async (who: UserContext) =>
      withRlsContext(who, async (tx) => {
        const [x] = extractRows<{ n: number }>(
          await tx.execute(drizzleSql`
            SELECT (SELECT COUNT(*)::int FROM app_projects.task_transitions WHERE task_id = ${task.id}::uuid)
                 + (SELECT COUNT(*)::int FROM app_projects.tasks WHERE id = ${task.id}::uuid) AS n
          `),
        )
        return x!.n
      })
    expect(await count(actor)).toBe(2)
    expect(await count({ ...actor, userId: otherMemberId, scopes: ["kernel:threads:read"] })).toBe(
      0,
    )
    // projects:tasks:read alone reads the task (the manifest's generated policy), so its
    // transitions too.
    expect(await count({ ...actor, userId: otherMemberId, scopes: ["projects:tasks:read"] })).toBe(
      2,
    )
    const [org2] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Other Org', ${`task-fields-other-${randomUUID()}`}) RETURNING id
      `),
    )
    expect(await count({ ...actor, orgId: org2!.id })).toBe(0)
  })
})

describe("event routines: the owner gate covers project tasks", () => {
  it("a task event reaches a routine only when its owner can read the task", async () => {
    const board = await makeBoard()
    const task = await ok("create", { projectId: board.id, title: "t", fields: { serial: "S" } })
    const evt = {
      app: "projects",
      entity: "task",
      action: "status_changed",
      orgId,
      entityId: task.id,
      data: { id: task.id, projectId: board.id },
    }
    expect(await ownerCanSeeEventEntity(actor, evt)).toBe(true)
    expect(
      await ownerCanSeeEventEntity(
        { ...actor, userId: otherMemberId, scopes: ["kernel:threads:read"] },
        evt,
      ),
    ).toBe(false)
  })
})
