// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task labels on the task service: the assignment write path (label
// map resolution, null clears, typed refusals listing the valid values,
// atomicity with the rest of the task write), the effective read with
// inheritance at every read site, and the label filter + completion window.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { createProject, searchTasksByTitle } from "~/apps/projects/service/create-project"
import { archiveLabel, createLabel } from "~/apps/projects/service/labels"
import { moveTask } from "~/apps/projects/service/move-task"
import { loadTaskDetails } from "~/apps/projects/service/task-detail"
import type { TaskLabel } from "~/apps/projects/service/task-labels"
import {
  createTask,
  getTask,
  listProjectTasks,
  listTasks,
  listTasksAcrossProjects,
  mergeTasks,
  updateTask,
} from "~/apps/projects/service/tasks"
import { extractRows, type RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:labels:admin",
  "kernel:threads:write",
  "kernel:threads:read",
]

interface World {
  orgId: string
  actor: UserContext
  projectId: string
  projectKey: string
  todo: string
  done: string
  groups: Record<string, string>
  values: Record<string, Record<string, string>>
}

async function seedOrg(): Promise<{ orgId: string; actor: UserContext }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Task Labels Org', ${`task-labels-${stamp}`}) RETURNING id
    `),
  )
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${org!.id}::uuid, ${`task-labels-${stamp}@test.com`}, 'Label Tester', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  return {
    orgId: org!.id,
    actor: {
      actorType: "user",
      userId: user!.id,
      orgId: org!.id,
      scopes: SCOPES,
      dimensionGrants: { "*": ["*"] },
    },
  }
}

/**
 * A fresh org with: Domain {enrichment, security}, Nature {bug, evolution,
 * maintenance, support, chore (archived)}, Legacy {old} (group archived), and
 * one project.
 */
async function makeWorld(): Promise<World> {
  const { orgId, actor } = await seedOrg()
  const groups: Record<string, string> = {}
  const values: Record<string, Record<string, string>> = {}
  await withRlsContext(actor, async (rtx) => {
    const tx = rtx as RlsClient
    const tax: Array<[string, string[]]> = [
      ["Domain", ["enrichment", "security"]],
      ["Nature", ["bug", "evolution", "maintenance", "support", "chore"]],
      ["Legacy", ["old"]],
    ]
    for (const [g, vs] of tax) {
      const group = await createLabel({ tx, orgId, actor, input: { name: g } })
      groups[g] = group.id
      values[g] = {}
      for (const v of vs) {
        const value = await createLabel({
          tx,
          orgId,
          actor,
          input: { name: v, parentId: group.id },
        })
        values[g]![v] = value.id
      }
    }
    await archiveLabel({ tx, orgId, actor, input: { id: values.Nature!.chore! } })
    await archiveLabel({ tx, orgId, actor, input: { id: groups.Legacy! } })
  })
  const p = await withRlsContext(actor, (tx) =>
    createProject({ tx, orgId, actor, input: { name: `Labels ${Date.now()}` } }),
  )
  return {
    orgId,
    actor,
    projectId: p.id,
    projectKey: p.key,
    todo: p.statuses.find((s) => s.label === "todo")!.id,
    done: p.statuses.find((s) => s.label === "done")!.id,
    groups,
    values,
  }
}

const as = <T>(w: World, fn: (tx: RlsClient) => Promise<T>) =>
  withRlsContext(w.actor, (tx) => fn(tx as RlsClient))

function newTask(
  w: World,
  title: string,
  extra: {
    parentTaskId?: string | null
    labels?: Record<string, string | null>
    projectId?: string
    statusId?: string
  } = {},
) {
  return as(w, (tx) =>
    createTask({
      tx,
      orgId: w.orgId,
      actor: w.actor,
      input: {
        projectId: w.projectId,
        statusId: w.todo,
        title,
        assigneeId: w.actor.userId,
        ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined)),
      },
    }),
  )
}

/** A parent chain of `depth` tasks (root first), as `hierarchy.test.ts` builds it. */
async function chainOfDepth(w: World, depth: number): Promise<string[]> {
  const ids: string[] = []
  let parent: string | null = null
  for (let i = 0; i < depth; i++) {
    const t = await newTask(w, `chain${i}`, { parentTaskId: parent })
    ids.push(t.id)
    parent = t.id
  }
  return ids
}

/** A 9-level chain: an 8-chain whose root is linked under one more root by privileged SQL. */
async function chainOfNine(w: World): Promise<{ root: string; leaf: string }> {
  const ids = await chainOfDepth(w, 8)
  const top = await newTask(w, "chain-top")
  await db.execute(
    drizzleSql`UPDATE app_projects.tasks SET parent_task_id = ${top.id}::uuid WHERE id = ${ids[0]!}::uuid`,
  )
  return { root: top.id, leaf: ids[7]! }
}

function setLabels(w: World, taskId: string, labels: Record<string, string | null>, more = {}) {
  return as(w, (tx) =>
    updateTask({ tx, orgId: w.orgId, actor: w.actor, taskId, input: { ...more, labels } }),
  )
}

function readTask(w: World, taskId: string) {
  return as(w, (tx) => getTask({ tx, orgId: w.orgId, taskId }))
}

function slim(labels: TaskLabel[]) {
  return labels.map((l) => ({
    group: l.groupName,
    value: l.valueName,
    inherited: l.inherited,
    from: l.inheritedFromKey,
  }))
}

async function caught(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (err) {
    return err as { code?: string; status?: number; message: string; details?: any }
  }
  throw new Error("expected a refusal")
}

async function assignPrivileged(w: World, taskId: string, group: string, value: string) {
  await db.execute(drizzleSql`
    INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
    VALUES (${w.orgId}::uuid, ${taskId}::uuid, ${w.groups[group]!}::uuid, ${w.values[group]![value]!}::uuid)
  `)
}

let w: World

beforeAll(async () => {
  await acquireTestLock()
  w = await makeWorld()
})

afterAll(releaseTestLock)

describe("task labels: assignment", () => {
  it("stores a value set by case-insensitive names, and by ids", async () => {
    const t = await newTask(w, "by name")
    const out = await setLabels(w, t.id, { nature: "BUG" })
    expect(out.labels).toEqual([
      {
        groupId: w.groups.Nature!,
        groupName: "Nature",
        groupArchived: false,
        valueId: w.values.Nature!.bug!,
        valueName: "bug",
        archived: false,
        inherited: false,
        inheritedFromKey: null,
      },
    ])
    const t2 = await newTask(w, "by id")
    await setLabels(w, t2.id, { [w.groups.Domain!]: w.values.Domain!.security! })
    expect(slim((await readTask(w, t2.id)).labels)).toEqual([
      { group: "Domain", value: "security", inherited: false, from: null },
    ])
  })

  it("prefers the live value over an archived one with the same name", async () => {
    const x = await makeWorld()
    await as(x, async (tx) => {
      await archiveLabel({
        tx,
        orgId: x.orgId,
        actor: x.actor,
        input: { id: x.values.Nature!.bug! },
      })
      await createLabel({
        tx,
        orgId: x.orgId,
        actor: x.actor,
        input: { name: "Bug", parentId: x.groups.Nature! },
      })
    })
    const t = await newTask(x, "live wins")
    const out = await setLabels(x, t.id, { Nature: "bug" })
    expect(out.labels[0]!.valueName).toBe("Bug")
    expect(out.labels[0]!.valueId).not.toBe(x.values.Nature!.bug!)
  })

  it("null clears the own value, also archived ones; other groups untouched; no-op when none", async () => {
    const t = await newTask(w, "clear")
    await setLabels(w, t.id, { Nature: "bug", Domain: "security" })
    const cleared = await setLabels(w, t.id, { Nature: null })
    expect(slim(cleared.labels)).toEqual([
      { group: "Domain", value: "security", inherited: false, from: null },
    ])
    const again = await setLabels(w, t.id, { Nature: null })
    expect(slim(again.labels)).toEqual(slim(cleared.labels))

    const t2 = await newTask(w, "archived clear")
    await assignPrivileged(w, t2.id, "Legacy", "old")
    await assignPrivileged(w, t2.id, "Nature", "chore")
    expect((await readTask(w, t2.id)).labels.map((l) => l.archived)).toEqual([true, true])
    const out = await setLabels(w, t2.id, { Legacy: null, Nature: null })
    expect(out.labels).toEqual([])
  })

  it("a subtask cannot opt out of an inherited value", async () => {
    const p = await newTask(w, "parent", { labels: { Nature: "bug" } })
    const c = await newTask(w, "child", { parentTaskId: p.id })
    const out = await setLabels(w, c.id, { Nature: null })
    expect(slim(out.labels)).toEqual([
      { group: "Nature", value: "bug", inherited: true, from: p.key },
    ])
  })

  const LIVE_NATURE = ["bug", "evolution", "maintenance", "support"]
  const refusals: Array<{
    name: string
    labels: () => Record<string, string>
    code: string
    valid: string[]
    text: string
  }> = [
    {
      name: "unknown group",
      labels: () => ({ Team: "core" }),
      code: "label_not_found",
      valid: ["Domain", "Nature"],
      text: "Valid groups: Domain, Nature.",
    },
    {
      name: "unknown value",
      labels: () => ({ Nature: "nope" }),
      code: "label_not_found",
      valid: LIVE_NATURE,
      text: `Valid values: ${LIVE_NATURE.join(", ")}.`,
    },
    {
      name: "value id of another group",
      labels: () => ({ Nature: w.values.Domain!.security! }),
      code: "label_not_found",
      valid: LIVE_NATURE,
      text: `Valid values: ${LIVE_NATURE.join(", ")}.`,
    },
    {
      name: "archived value",
      labels: () => ({ Nature: "chore" }),
      code: "label_archived",
      valid: LIVE_NATURE,
      text: `Valid values: ${LIVE_NATURE.join(", ")}.`,
    },
    {
      name: "value of an archived group",
      labels: () => ({ Legacy: "old" }),
      code: "label_archived",
      valid: [],
      text: "Valid values: none.",
    },
  ]
  for (const r of refusals) {
    it(`refuses ${r.name} with ${r.code} listing the valid values`, async () => {
      const t = await newTask(w, r.name)
      const err = await caught(() => setLabels(w, t.id, r.labels()))
      expect(err.code).toBe(r.code)
      expect(err.details.validValues.map((v: { name: string }) => v.name)).toEqual(r.valid)
      expect(err.message).toContain(r.text)
      expect((await readTask(w, t.id)).labels).toEqual([])
    })
  }

  it("is atomic with the rest of the write: no title change, no task, no thread", async () => {
    const t = await newTask(w, "old title")
    await caught(() => setLabels(w, t.id, { Nature: "nope" }, { title: "new" }))
    expect((await readTask(w, t.id)).title).toBe("old title")

    const count = async () => {
      const [r] = extractRows<{ tasks: number; threads: number }>(
        await db.execute(drizzleSql`
          SELECT (SELECT count(*)::int FROM app_projects.tasks WHERE org_id = ${w.orgId}::uuid) AS tasks,
                 (SELECT count(*)::int FROM kernel.threads WHERE org_id = ${w.orgId}::uuid) AS threads
        `),
      )
      return r!
    }
    const before = await count()
    const err = await caught(() => newTask(w, "never", { labels: { Nature: "nope" } }))
    expect(err.code).toBe("label_not_found")
    expect(await count()).toEqual(before)
  })

  it("refuses the same group named twice", async () => {
    const t = await newTask(w, "twice")
    const err = await caught(() =>
      setLabels(w, t.id, { Nature: "bug", [w.groups.Nature!]: "evolution" }),
    )
    expect(err.code).toBe("invalid_params")
  })

  it("a labels-only update bumps updated_at", async () => {
    const t = await newTask(w, "bump")
    const stored = async () => {
      const [r] = extractRows<{ u: string }>(
        await db.execute(
          drizzleSql`SELECT updated_at::text AS u FROM app_projects.tasks WHERE id = ${t.id}::uuid`,
        ),
      )
      return new Date(r!.u).getTime()
    }
    const before = await stored()
    const start = Date.now()
    while (Date.now() === start) await Bun.sleep(1)
    const out = await setLabels(w, t.id, { Nature: "evolution" })
    expect(await stored()).toBeGreaterThan(before)
    expect(new Date(out.updatedAt).getTime()).toBeGreaterThan(before)
  })

  it("refuses a name matching several archived values and no live one", async () => {
    const x = await makeWorld()
    const second = await as(x, async (tx) => {
      await archiveLabel({
        tx,
        orgId: x.orgId,
        actor: x.actor,
        input: { id: x.values.Nature!.bug! },
      })
      const b = await createLabel({
        tx,
        orgId: x.orgId,
        actor: x.actor,
        input: { name: "bug", parentId: x.groups.Nature! },
      })
      await archiveLabel({ tx, orgId: x.orgId, actor: x.actor, input: { id: b.id } })
      return b.id
    })
    const t = await newTask(x, "ambiguous")
    const err = await caught(() => setLabels(x, t.id, { Nature: "bug" }))
    expect(err.code).toBe("invalid_params")
    expect([...err.details.candidates].sort()).toEqual([x.values.Nature!.bug!, second].sort())
    expect(err.message).toContain(second)
    expect(err.message).toContain(x.values.Nature!.bug!)
    const byId = await caught(() => setLabels(x, t.id, { Nature: second }))
    expect(byId.code).toBe("label_archived")
  })

  it("never resolves another org's taxonomy", async () => {
    const other = await makeWorld()
    const t = await newTask(other, "foreign")
    const err = await caught(() =>
      setLabels(other, t.id, { [w.groups.Nature!]: w.values.Nature!.bug! }),
    )
    expect(err.code).toBe("label_not_found")
  })

  it("never filters by another org's taxonomy", async () => {
    const other = await makeWorld()
    await newTask(other, "foreign")
    const err = await caught(() =>
      as(other, (tx) =>
        listProjectTasks({
          tx,
          orgId: other.orgId,
          projectId: other.projectId,
          labels: { [w.groups.Nature!]: w.values.Nature!.bug! },
        }),
      ),
    )
    expect(err.code).toBe("label_not_found")
    const byValue = await caught(() =>
      as(other, (tx) =>
        listProjectTasks({
          tx,
          orgId: other.orgId,
          projectId: other.projectId,
          labels: { Nature: w.values.Nature!.bug! },
        }),
      ),
    )
    expect(byValue.code).toBe("label_not_found")
  })

  it("never reads an assignment row of another org on a task", async () => {
    const other = await makeWorld()
    const t = await newTask(other, "foreign-read")
    // A row carrying org A's id and taxonomy on org B's task (written past
    // RLS): every read is scoped by the reader's org, so B never sees it.
    await db.execute(drizzleSql`
      INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
      VALUES (${w.orgId}::uuid, ${t.id}::uuid, ${w.groups.Nature!}::uuid, ${w.values.Nature!.bug!}::uuid)
    `)
    expect((await readTask(other, t.id)).labels).toEqual([])
    const listed = await as(other, (tx) =>
      listProjectTasks({ tx, orgId: other.orgId, projectId: other.projectId }),
    )
    expect(listed.items.find((i) => i.id === t.id)?.labels).toEqual([])
    const none = await as(other, (tx) =>
      listProjectTasks({
        tx,
        orgId: other.orgId,
        projectId: other.projectId,
        labels: { Nature: "__none__" },
      }),
    )
    expect(none.items.map((i) => i.id)).toContain(t.id)
  })
})

describe("task labels: reads and inheritance", () => {
  const key = async (id: string) => (await readTask(w, id)).key

  it("inherits per group from the nearest holder; an own value overrides only its group", async () => {
    const p = await newTask(w, "inh-parent", { labels: { Nature: "bug", Domain: "security" } })
    const c = await newTask(w, "inh-child", { parentTaskId: p.id })
    const g = await newTask(w, "inh-grandchild", { parentTaskId: c.id })
    const pk = await key(p.id)
    expect(slim((await readTask(w, c.id)).labels)).toEqual([
      { group: "Domain", value: "security", inherited: true, from: pk },
      { group: "Nature", value: "bug", inherited: true, from: pk },
    ])
    expect(slim((await readTask(w, g.id)).labels)).toEqual([
      { group: "Domain", value: "security", inherited: true, from: pk },
      { group: "Nature", value: "bug", inherited: true, from: pk },
    ])
    await setLabels(w, c.id, { Nature: "evolution" })
    expect(slim((await readTask(w, c.id)).labels)).toEqual([
      { group: "Domain", value: "security", inherited: true, from: pk },
      { group: "Nature", value: "evolution", inherited: false, from: null },
    ])
  })

  it("the nearest holder wins over a farther one", async () => {
    const g = await newTask(w, "near-g", { labels: { Nature: "bug" } })
    const p = await newTask(w, "near-p", { parentTaskId: g.id, labels: { Nature: "evolution" } })
    const c = await newTask(w, "near-c", { parentTaskId: p.id })
    expect(slim((await readTask(w, c.id)).labels)).toEqual([
      { group: "Nature", value: "evolution", inherited: true, from: p.key },
    ])
    await setLabels(w, p.id, { Nature: null })
    expect(slim((await readTask(w, c.id)).labels)).toEqual([
      { group: "Nature", value: "bug", inherited: true, from: g.key },
    ])
  })

  it("walks exactly MAX_TASK_DEPTH levels (the task is depth 1)", async () => {
    const eight = await chainOfDepth(w, 8)
    await setLabels(w, eight[0]!, { Nature: "bug" })
    const rootKey = await key(eight[0]!)
    expect(slim((await readTask(w, eight[7]!)).labels)).toEqual([
      { group: "Nature", value: "bug", inherited: true, from: rootKey },
    ])
    const nine = await chainOfNine(w)
    await setLabels(w, nine.root, { Nature: "bug" })
    expect((await readTask(w, nine.leaf)).labels).toEqual([])
  })

  it("re-parent and cross-project moves change inherited values, never own ones", async () => {
    const p = await newTask(w, "mv-p", { labels: { Nature: "bug" } })
    const q = await newTask(w, "mv-q", { labels: { Nature: "maintenance" } })
    const c = await newTask(w, "mv-c", { parentTaskId: p.id, labels: { Domain: "security" } })
    await as(w, (tx) =>
      moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId: c.id, parentTaskId: q.id }),
    )
    expect(slim((await readTask(w, c.id)).labels)).toEqual([
      { group: "Domain", value: "security", inherited: false, from: null },
      { group: "Nature", value: "maintenance", inherited: true, from: q.key },
    ])
    const other = await as(w, (tx) =>
      createProject({ tx, orgId: w.orgId, actor: w.actor, input: { name: `Other ${Date.now()}` } }),
    )
    // Only a root crosses projects (its subtree follows): the child keeps its
    // own value and now inherits from the holder's NEW key.
    await as(w, (tx) =>
      moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId: q.id, targetProjectId: other.id }),
    )
    const movedQ = await readTask(w, q.id)
    const moved = await readTask(w, c.id)
    expect(moved.projectId).toBe(other.id)
    expect(movedQ.key).not.toBe(q.key)
    expect(slim(moved.labels)).toEqual([
      { group: "Domain", value: "security", inherited: false, from: null },
      { group: "Nature", value: "maintenance", inherited: true, from: movedQ.key },
    ])
    await as(w, (tx) =>
      moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId: c.id, parentTaskId: null }),
    )
    expect(slim((await readTask(w, c.id)).labels)).toEqual([
      { group: "Domain", value: "security", inherited: false, from: null },
    ])
  })

  it("a merge re-parents the source's children, which re-inherit from the target", async () => {
    const src = await newTask(w, "merge-src", { labels: { Nature: "bug" } })
    const tgt = await newTask(w, "merge-tgt", { labels: { Nature: "evolution" } })
    const child = await newTask(w, "merge-child", { parentTaskId: src.id })
    expect((await readTask(w, child.id)).labels[0]!.valueName).toBe("bug")
    await as(w, (tx) =>
      mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: src.id, targetId: tgt.id }),
    )
    expect(slim((await readTask(w, child.id)).labels)).toEqual([
      { group: "Nature", value: "evolution", inherited: true, from: tgt.key },
    ])
    expect(slim((await readTask(w, tgt.id)).labels)).toEqual([
      { group: "Nature", value: "evolution", inherited: false, from: null },
    ])
  })

  it("marks an archived value and a value of an archived group", async () => {
    const t = await newTask(w, "archived-marks")
    await assignPrivileged(w, t.id, "Nature", "chore")
    await assignPrivileged(w, t.id, "Legacy", "old")
    const byGroup = Object.fromEntries(
      (await readTask(w, t.id)).labels.map((l) => [l.groupName, l]),
    )
    expect(byGroup.Nature).toMatchObject({ archived: true, groupArchived: false })
    expect(byGroup.Legacy).toMatchObject({ archived: true, groupArchived: true })
  })

  it("every read site returns the same entries", async () => {
    const title = `same-everywhere-${Date.now()}`
    const p = await newTask(w, `${title}-parent`, { labels: { Domain: "security" } })
    const t = await newTask(w, title, { parentTaskId: p.id, labels: { Nature: "bug" } })
    const expected = (await readTask(w, t.id)).labels
    expect(expected).toHaveLength(2)
    const sites: Array<[string, () => Promise<TaskLabel[] | undefined>]> = [
      [
        "listTasks",
        async () =>
          (
            await as(w, (tx) => listTasks({ tx, orgId: w.orgId, projectId: w.projectId }))
          ).items.find((x) => x.id === t.id)?.labels,
      ],
      [
        "listProjectTasks",
        async () =>
          (
            await as(w, (tx) =>
              listProjectTasks({ tx, orgId: w.orgId, projectId: w.projectId, limit: 200 }),
            )
          ).items.find((x) => x.id === t.id)?.labels,
      ],
      [
        "listTasksAcrossProjects",
        async () =>
          (
            await as(w, (tx) =>
              listTasksAcrossProjects({ tx, orgId: w.orgId, assigneeId: w.actor.userId }),
            )
          ).items.find((x) => x.id === t.id)?.labels,
      ],
      [
        "searchTasksByTitle",
        async () =>
          (await as(w, (tx) => searchTasksByTitle(tx, w.orgId, title, 10))).find(
            (x) => x.id === t.id,
          )?.labels,
      ],
      ["getTask", async () => (await readTask(w, t.id)).labels],
    ]
    for (const [name, read] of sites) {
      expect({ name, labels: await read() }).toEqual({ name, labels: expected })
    }
  })

  it("reads labels in exactly one statement per result set", async () => {
    const x = await makeWorld()
    const small = await as(x, (tx) =>
      createProject({ tx, orgId: x.orgId, actor: x.actor, input: { name: `Small ${Date.now()}` } }),
    )
    await newTask(x, "alone", {
      projectId: small.id,
      statusId: small.statuses.find((s) => !s.terminal)!.id,
      labels: { Nature: "bug" },
    })
    const roots = []
    for (let i = 0; i < 10; i++)
      roots.push(await newTask(x, `root${i}`, { labels: { Nature: "bug" } }))
    for (let i = 0; i < 5; i++) {
      const c = await newTask(x, `child${i}`, { parentTaskId: roots[i]!.id })
      await newTask(x, `grandchild${i}`, { parentTaskId: c.id })
    }
    const dialect = new PgDialect()
    const counting = (tx: RlsClient) => {
      const box = { n: 0 }
      const proxy = new Proxy(tx, {
        get(target, prop) {
          if (prop === "execute") {
            return (q: Parameters<RlsClient["execute"]>[0]) => {
              if (dialect.sqlToQuery(q as never).sql.includes("task_labels")) box.n++
              return target.execute(q)
            }
          }
          const v = Reflect.get(target, prop)
          return typeof v === "function" ? v.bind(target) : v
        },
      })
      return { proxy, box }
    }
    const reads: Array<[string, (tx: RlsClient) => Promise<{ items: unknown[] }>]> = []
    for (const projectId of [small.id, x.projectId]) {
      reads.push([`listTasks ${projectId}`, (tx) => listTasks({ tx, orgId: x.orgId, projectId })])
      reads.push([
        `listProjectTasks ${projectId}`,
        (tx) => listProjectTasks({ tx, orgId: x.orgId, projectId }),
      ])
    }
    reads.push([
      "listTasksAcrossProjects",
      (tx) => listTasksAcrossProjects({ tx, orgId: x.orgId, assigneeId: x.actor.userId }),
    ])
    // Search task hits (several hits) and the detail loader behind get and events.
    reads.push([
      "searchTasksByTitle",
      async (tx) => ({ items: await searchTasksByTitle(tx, x.orgId, "root", 50) }),
    ])
    const detailIds = roots.map((r) => r.id)
    reads.push([
      "loadTaskDetails",
      async (tx) => ({ items: await loadTaskDetails(tx, x.orgId, detailIds) }),
    ])
    for (const [name, read] of reads) {
      const n = await as(x, async (tx) => {
        const { proxy, box } = counting(tx)
        const out = await read(proxy)
        expect(out.items.length).toBeGreaterThan(name === "searchTasksByTitle" ? 1 : 0)
        return box.n
      })
      expect({ name, n }).toEqual({ name, n: 1 })
    }
  })

  it("a reader with only projects:projects:read and projects:tasks:read gets the labels", async () => {
    const t = await newTask(w, "visible", { labels: { Nature: "support" } })
    const reader: UserContext = {
      ...w.actor,
      scopes: ["projects:projects:read", "projects:tasks:read"],
    }
    const out = await withRlsContext(reader, (tx) =>
      listTasks({ tx: tx as RlsClient, orgId: w.orgId, projectId: w.projectId }),
    )
    expect(slim(out.items.find((i) => i.id === t.id)!.labels)).toEqual([
      { group: "Nature", value: "support", inherited: false, from: null },
    ])
  })
})

describe("task labels: filters and completion window", () => {
  let f: World
  let ids: Record<string, string>
  const sorted = (xs: string[]) => [...xs].sort()
  const names = (wanted: string[]) => sorted(wanted.map((n) => ids[n]!))

  beforeAll(async () => {
    f = await makeWorld()
    const mk = async (name: string, labels?: Record<string, string>, parent?: string) =>
      (await newTask(f, name, { labels, parentTaskId: parent ? ids[parent] : undefined })).id
    ids = {}
    ids.A = await mk("A", { Nature: "bug", Domain: "security" })
    ids.B = await mk("B", { Nature: "bug" })
    ids.P = await mk("P", { Nature: "bug" })
    ids.C1 = await mk("C1", undefined, "P")
    ids.C2 = await mk("C2", { Nature: "evolution" }, "P")
    ids.Q = await mk("Q")
    ids.D = await mk("D", undefined, "Q")
    ids.R = await mk("R", { Domain: "security" })
    ids.E = await mk("E", undefined, "R")
  })

  const project = (labels: Record<string, string>) =>
    as(f, (tx) =>
      listProjectTasks({ tx, orgId: f.orgId, projectId: f.projectId, labels, limit: 200 }),
    )
  const board = (labels: Record<string, string>) =>
    as(f, (tx) => listTasks({ tx, orgId: f.orgId, projectId: f.projectId, filters: { labels } }))

  it("matches the effective value, AND across groups, __none__ for no value", async () => {
    const ids1 = (await project({ Nature: "bug" })).items.map((t) => t.id)
    expect(sorted(ids1)).toEqual(names(["A", "B", "P", "C1"]))
    expect((await project({ Nature: "evolution" })).items.map((t) => t.id)).toEqual([ids.C2!])
    expect((await project({ Nature: "bug", Domain: "security" })).items.map((t) => t.id)).toEqual([
      ids.A!,
    ])
    expect(sorted((await project({ Nature: "__none__" })).items.map((t) => t.id))).toEqual(
      names(["Q", "D", "R", "E"]),
    )
  })

  it("accepts an archived value and a value of an archived group", async () => {
    // Its own world: the shared one stays as the other filter tests expect it.
    const y = await makeWorld()
    const t1 = await newTask(y, "with-chore")
    const t2 = await newTask(y, "with-old")
    await assignPrivileged(y, t1.id, "Nature", "chore")
    await assignPrivileged(y, t2.id, "Legacy", "old")
    const inY = (labels: Record<string, string>) =>
      as(y, (tx) => listProjectTasks({ tx, orgId: y.orgId, projectId: y.projectId, labels }))
    expect((await inY({ Nature: "chore" })).items.map((t) => t.id)).toEqual([t1.id])
    expect((await inY({ Legacy: "old" })).items.map((t) => t.id)).toEqual([t2.id])
  })

  it("refuses an unknown group or value with label_not_found listing live and archived", async () => {
    const g = await caught(() => project({ Team: "core" }))
    expect(g.code).toBe("label_not_found")
    expect(g.message).toContain("Valid groups: Domain, Nature, Legacy (archived).")
    const v = await caught(() => project({ Nature: "nope" }))
    expect(v.code).toBe("label_not_found")
    expect(v.message).toContain(
      "Valid values: bug, evolution, maintenance, support, chore (archived).",
    )
    expect(v.details.validValues.map((x: { name: string }) => x.name)).toEqual([
      "bug",
      "evolution",
      "maintenance",
      "support",
      "chore",
    ])
  })

  it("counts tasks completed in a window with an effective label (the MON-37 probe)", async () => {
    const x = await makeWorld()
    const other = await as(x, (tx) =>
      createProject({ tx, orgId: x.orgId, actor: x.actor, input: { name: `Y ${Date.now()}` } }),
    )
    const after = "2026-10-19T00:00:00Z"
    const before = "2026-10-26T00:00:00Z"
    const mid = "2026-10-22T12:00:00Z"
    const mk = async (
      name: string,
      opts: {
        labels?: Record<string, string>
        parent?: string
        terminal: boolean
        completedAt: string | null
        projectId?: string
        statusId?: string
      },
    ) => {
      const t = await newTask(x, name, {
        labels: opts.labels,
        parentTaskId: opts.parent,
        projectId: opts.projectId,
        statusId: opts.statusId ?? (opts.terminal ? x.done : x.todo),
      })
      await db.execute(drizzleSql`
        UPDATE app_projects.tasks
        SET created_at = '2026-09-01T00:00:00Z', updated_at = '2026-09-01T00:00:00Z',
            completed_at = ${opts.completedAt === null ? drizzleSql`NULL` : drizzleSql`${opts.completedAt}::timestamptz`}
        WHERE id = ${t.id}::uuid
      `)
      return t.id
    }
    await mk("t1", { labels: { Nature: "bug" }, terminal: true, completedAt: after })
    const tp = await mk("tp", { labels: { Nature: "bug" }, terminal: false, completedAt: null })
    await mk("t2", { parent: tp, terminal: true, completedAt: mid })
    await mk("t3", { labels: { Nature: "bug" }, terminal: true, completedAt: before })
    await mk("t4", {
      labels: { Nature: "bug" },
      terminal: true,
      completedAt: "2026-10-18T23:59:59Z",
    })
    await mk("t5", { labels: { Nature: "evolution" }, terminal: true, completedAt: mid })
    await mk("t6", { terminal: true, completedAt: mid })
    await mk("t7", { labels: { Nature: "bug" }, terminal: false, completedAt: mid })
    await mk("y1", {
      labels: { Nature: "bug" },
      terminal: true,
      completedAt: mid,
      projectId: other.id,
      statusId: other.statuses.find((s) => s.terminal)!.id,
    })
    const count = (completedAfter: string, completedBefore: string) =>
      as(x, (tx) =>
        listProjectTasks({
          tx,
          orgId: x.orgId,
          projectId: x.projectId,
          terminal: true,
          labels: { Nature: "bug" },
          completedAfter,
          completedBefore,
          countOnly: true,
        }),
      )
    expect((await count(after, before)).totalCount).toBe(2)
    expect((await count("2026-10-19T02:00:00+02:00", "2026-10-26T02:00:00+02:00")).totalCount).toBe(
      2,
    )
  })

  for (const field of ["completedAfter", "completedBefore"] as const) {
    it(`refuses an unparsable ${field} with invalid_params naming it`, async () => {
      const err = await caught(() =>
        as(f, (tx) =>
          listProjectTasks({ tx, orgId: f.orgId, projectId: f.projectId, [field]: "next week" }),
        ),
      )
      expect(err.code).toBe("invalid_params")
      expect(err.message).toContain(field)
    })
  }

  it("totalCount counts the label filter", async () => {
    const out = await project({ Nature: "bug" })
    expect(out.totalCount).toBe(out.items.length)
    expect(out.totalCount).toBe(4)
  })

  it("filters the board list (REST path) the same way", async () => {
    expect((await board({ Nature: "bug", Domain: "security" })).items.map((t) => t.id)).toEqual([
      ids.A!,
    ])
    const bug = (await board({ Nature: "bug" })).items.map((t) => t.id)
    expect(sorted(bug)).toEqual(names(["A", "B", "P", "C1"]))
  })

  it("matches within MAX_TASK_DEPTH only", async () => {
    const x = await makeWorld()
    const eight = await chainOfDepth(x, 8)
    await setLabels(x, eight[0]!, { Nature: "bug" })
    const nine = await chainOfNine(x)
    await setLabels(x, nine.root, { Nature: "bug" })
    const matched = new Set(
      (
        await as(x, (tx) =>
          listProjectTasks({
            tx,
            orgId: x.orgId,
            projectId: x.projectId,
            labels: { Nature: "bug" },
            limit: 200,
          }),
        )
      ).items.map((t) => t.id),
    )
    expect(matched.has(eight[7]!)).toBe(true)
    expect(matched.has(nine.leaf)).toBe(false)
  })

  it("refuses a filter name matching several archived values", async () => {
    const x = await makeWorld()
    const second = await as(x, async (tx) => {
      const c = await createLabel({
        tx,
        orgId: x.orgId,
        actor: x.actor,
        input: { name: "chore", parentId: x.groups.Nature! },
      })
      await archiveLabel({ tx, orgId: x.orgId, actor: x.actor, input: { id: c.id } })
      return c.id
    })
    const err = await caught(() =>
      as(x, (tx) =>
        listProjectTasks({
          tx,
          orgId: x.orgId,
          projectId: x.projectId,
          labels: { Nature: "chore" },
        }),
      ),
    )
    expect(err.code).toBe("invalid_params")
    expect(sorted(err.details.candidates)).toEqual(sorted([x.values.Nature!.chore!, second]))
  })
})
