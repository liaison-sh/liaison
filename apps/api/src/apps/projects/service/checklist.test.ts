// SPDX-License-Identifier: FSL-1.1-ALv2
// Spec S8-S12 and the edge-case table: checklist items, validations and
// levels. Limits, the S10 access rules (human / agent, none / direct /
// with_source), the fail note posted to the task thread, per-key JSONB writes
// under concurrency, level replacement, merge, archive and events.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import {
  addItems,
  listChecklist,
  removeItem,
  setValidationLevels,
  setValidations,
  updateItem,
} from "~/apps/projects/service/checklist"
import type { ValidationLevel } from "~/apps/projects/service/checklist-status"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask, deleteTask, mergeTasks, updateTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { pgLockWaiters } from "~/tests/helpers/pg-lock-waiters"
import { waitFor } from "~/tests/helpers/wait-for"
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

interface Env {
  projectId: string
  openStatusId: string
  doneStatusId: string
  levels: ValidationLevel[]
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Checklist Items Org', ${`checklist-items-${Date.now()}-${Math.random()}`})
      RETURNING id
    `),
  )
  orgId = org!.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`items-${Date.now()}@test.com`}, 'Items Tester', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user!.id
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
})

afterAll(async () => {
  await releaseTestLock()
})

const run = <T>(fn: Parameters<typeof withRlsContext<T>>[1]) => withRlsContext(actor, fn)

async function makeProject(levelNames: string[]): Promise<Env> {
  const p = await run((tx) =>
    createProject({
      tx,
      orgId,
      actor,
      // Explicit unique key: the derived one ("ITE") runs out of collision
      // candidates once the file creates more than a handful of projects.
      input: {
        name: `items-${randomUUID().slice(0, 8)}`,
        key: `I${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      },
    }),
  )
  const levels = levelNames.length
    ? await run((tx) =>
        setValidationLevels({
          tx,
          orgId,
          userId,
          projectId: p.id,
          levels: levelNames.map((name) => ({ name })),
        }),
      )
    : []
  return {
    projectId: p.id,
    openStatusId: (p.statuses.find((s) => !s.terminal) ?? p.statuses[0]!).id,
    doneStatusId: p.statuses.find((s) => s.terminal)!.id,
    levels,
  }
}

async function makeTask(env: Env, title: string, statusId?: string): Promise<string> {
  const t = await run((tx) =>
    createTask({
      tx,
      orgId,
      actor,
      input: { projectId: env.projectId, statusId: statusId ?? env.openStatusId, title },
    }),
  )
  return t.id
}

async function add(
  taskId: string,
  titles: string[],
  actorKind: "human" | "agent" = "human",
): Promise<string[]> {
  const items = await run((tx) =>
    addItems({ tx, orgId, userId, actorKind, taskId, items: titles.map((title) => ({ title })) }),
  )
  return items.map((i) => i.id)
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await p
  } catch (err) {
    return err as { code: string; status: number }
  }
  throw new Error("expected a refusal, the call succeeded")
}

async function itemValidations(itemId: string): Promise<Record<string, any>> {
  const [row] = extractRows<{ validations: Record<string, any> }>(
    await db.execute(drizzleSql`
      SELECT validations FROM app_projects.task_checklist_items WHERE id = ${itemId}::uuid
    `),
  )
  return row!.validations
}

async function threadMessages(taskId: string): Promise<{ content: string; author_type: string }[]> {
  return extractRows<{ content: string; author_type: string }>(
    await db.execute(drizzleSql`
      SELECT m.content, m.author_type FROM kernel.messages m
      JOIN app_projects.tasks t ON t.thread_id = m.thread_id
      WHERE t.id = ${taskId}::uuid
      ORDER BY m.created_at ASC
    `),
  )
}

async function itemEventCount(itemId: string, action: string): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await db.execute(drizzleSql`
      SELECT COUNT(*)::int AS n FROM kernel.pending_events
      WHERE payload->>'entityId' = ${itemId} AND payload->>'entity' = 'task_checklist_item'
        AND payload->>'action' = ${action}
    `),
  )
  return row!.n
}

async function taskStatus(taskId: string): Promise<string> {
  const [row] = extractRows<{ status_id: string }>(
    await db.execute(
      drizzleSql`SELECT status_id FROM app_projects.tasks WHERE id = ${taskId}::uuid`,
    ),
  )
  return row!.status_id
}

describe("checklist items: limits", () => {
  it("refuses 51 items in one call and writes none", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "fifty-one")
    const err = await refusal(
      add(
        taskId,
        Array.from({ length: 51 }, (_, i) => `item ${i}`),
      ),
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe("checklist_too_many_items")
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items).toHaveLength(0)
  })

  it("refuses the 201st item", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "two hundred")
    for (let batch = 0; batch < 4; batch++) {
      await add(
        taskId,
        Array.from({ length: 50 }, (_, i) => `b${batch} i${i}`),
      )
    }
    const err = await refusal(add(taskId, ["one too many"]))
    expect(err.status).toBe(400)
    expect(err.code).toBe("checklist_too_many_items")
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items).toHaveLength(200)
  })

  it("two concurrent adds cannot pass 200 together: exactly one succeeds", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "cap race")
    await add(
      taskId,
      Array.from({ length: 50 }, (_, i) => `a${i}`),
    )
    await add(
      taskId,
      Array.from({ length: 50 }, (_, i) => `b${i}`),
    )
    await add(
      taskId,
      Array.from({ length: 10 }, (_, i) => `c${i}`),
    )
    // 110 + 50 + 50 = 210 > 200. Each add holds its transaction open after the
    // insert so both would read the count before either commits: until the
    // other add is queued behind it or has finished, at most 200 ms.
    let settledAdds = 0
    const holdForTheOther = () =>
      waitFor(async () => settledAdds > 0 || (await pgLockWaiters()) > 0, {
        timeoutMs: 200,
      }).catch(() => {})
    const concurrentAdd = (tag: string) =>
      run(async (tx) => {
        const out = await addItems({
          tx,
          orgId,
          userId,
          actorKind: "human",
          taskId,
          items: Array.from({ length: 50 }, (_, i) => ({ title: `${tag}${i}` })),
        })
        await holdForTheOther()
        return out
      }).finally(() => {
        settledAdds++
      })
    const results = await Promise.allSettled([concurrentAdd("x"), concurrentAdd("y")])
    const ok = results.filter((r) => r.status === "fulfilled")
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
    expect(ok).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect((refused[0]!.reason as { code: string }).code).toBe("checklist_too_many_items")
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items).toHaveLength(160)
  })

  it("trims titles and refuses an empty or over-long one", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "titles")
    const [id] = await add(taskId, ["  padded  "])
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items.find((i) => i.id === id)?.title).toBe("padded")
    expect((await refusal(add(taskId, ["   "]))).code).toBe("checklist_item_invalid")
    expect((await refusal(add(taskId, ["x".repeat(301)]))).code).toBe("checklist_item_invalid")
  })
})

describe("checklist items: terminal tasks (S8, D6)", () => {
  it("a human adds an item to a Done task: added, task stays Done, counters count it", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "done already", env.doneStatusId)
    await add(taskId, ["late item"])
    expect(await taskStatus(taskId)).toBe(env.doneStatusId)
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.status.total).toBe(1)
    expect(view.status.complete).toBe(0)
    expect(view.status.perLevel[0]?.applicable).toBe(1)
  })

  it("an agent adding to a Done task is refused with checklist_task_terminal", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "agent done", env.doneStatusId)
    const err = await refusal(add(taskId, ["sneaky"], "agent"))
    expect(err.status).toBe(409)
    expect(err.code).toBe("checklist_task_terminal")
  })

  it("a validation on a Done task leaves it Done", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "done validation")
    const [itemId] = await add(taskId, ["x"])
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: itemId!, level: "AI", state: "success" }],
        commentRequiredScopes: [],
      }),
    )
    await run((tx) =>
      updateTask({
        tx,
        orgId,
        actor,
        taskId,
        input: { statusId: env.doneStatusId },
      }),
    )
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: itemId!, level: "AI", state: "fail", note: "regressed" }],
        commentRequiredScopes: [],
      }),
    )
    expect(await taskStatus(taskId)).toBe(env.doneStatusId)
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.status.failing).toBe(1)
  })
})

describe("checklist validations: access and notes (S10)", () => {
  it("refuses a fail without a note", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "fail no note")
    const [itemId] = await add(taskId, ["x"])
    const err = await refusal(
      run((tx) =>
        setValidations({
          tx,
          orgId,
          userId,
          actorKind: "human",
          entries: [{ itemId: itemId!, level: "AI", state: "fail", note: "   " }],
          commentRequiredScopes: [],
        }),
      ),
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe("checklist_fail_note_required")
    expect(await itemValidations(itemId!)).toEqual({})
  })

  it("a fail with a note posts exactly one thread comment with the S10 text", async () => {
    const env = await makeProject(["Dev"])
    const taskId = await makeTask(env, "fail with note")
    const [itemId] = await add(taskId, ["Pedal sustains"])
    const before = await threadMessages(taskId)
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: itemId!, level: "dev", state: "fail", note: "  drops after 3s  " }],
        commentRequiredScopes: [],
      }),
    )
    const after = await threadMessages(taskId)
    expect(after.length - before.length).toBe(1)
    const posted = after[after.length - 1]!
    expect(posted.content).toBe('Fail on Dev for "Pedal sustains": drops after 3s')
    expect(posted.author_type).toBe("user")
    expect((await itemValidations(itemId!))[env.levels[0]!.id].state).toBe("fail")
  })

  it("an agent's note is posted as an agent, and a success note reads <State> on", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "agent note")
    const [itemId] = await add(taskId, ["Boots"])
    const before = await threadMessages(taskId)
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "agent",
        entries: [{ itemId: itemId!, level: "AI", state: "success", note: "sim e2e green" }],
        commentRequiredScopes: [],
      }),
    )
    const after = await threadMessages(taskId)
    expect(after.length - before.length).toBe(1)
    expect(after[after.length - 1]!.content).toBe('Success on AI for "Boots": sim e2e green')
    expect(after[after.length - 1]!.author_type).toBe("agent")
  })

  it("an agent sets any level to any state without a source, via agent (D15)", async () => {
    const env = await makeProject(["AI", "Dev", "Beta"])
    const taskId = await makeTask(env, "agent any level")
    const [itemId] = await add(taskId, ["x"])
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "agent",
        entries: [
          { itemId: itemId!, level: "Beta", state: "success" },
          { itemId: itemId!, level: "Dev", state: "na" },
        ],
        commentRequiredScopes: [],
      }),
    )
    const v = await itemValidations(itemId!)
    expect(v[env.levels[2]!.id]).toMatchObject({ state: "success", via: "agent", source: null })
    expect(v[env.levels[1]!.id]).toMatchObject({ state: "na", via: "agent", source: null })
  })

  it("a source is optional but, when given, an https URL of at most 500 chars", async () => {
    const env = await makeProject(["Dev"])
    const taskId = await makeTask(env, "with source")
    const [itemId] = await add(taskId, ["x"])
    for (const bad of ["http://qa.example/1", `https://qa.example/${"a".repeat(500)}`]) {
      const err = await refusal(
        run((tx) =>
          setValidations({
            tx,
            orgId,
            userId,
            actorKind: "human",
            entries: [{ itemId: itemId!, level: "Dev", state: "success", source: bad }],
            commentRequiredScopes: [],
          }),
        ),
      )
      expect(err.status).toBe(400)
      expect(err.code).toBe("checklist_validation_invalid")
    }
    const source = "https://claude.ai/artifact/qa-board"
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "agent",
        entries: [{ itemId: itemId!, level: "Dev", state: "success", source }],
        commentRequiredScopes: [],
      }),
    )
    const record = (await itemValidations(itemId!))[env.levels[0]!.id]
    expect(record).toMatchObject({ state: "success", by: userId, via: "agent", source })
    expect(typeof record.at).toBe("string")
  })

  it("a human sets a level, via human", async () => {
    const env = await makeProject(["Beta"])
    const taskId = await makeTask(env, "human none")
    const [itemId] = await add(taskId, ["x"])
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: itemId!, level: env.levels[0]!.id, state: "success" }],
        commentRequiredScopes: [],
      }),
    )
    expect((await itemValidations(itemId!))[env.levels[0]!.id]).toMatchObject({
      state: "success",
      via: "human",
      source: null,
    })
  })

  it("refuses an unknown level id", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "unknown level")
    const [itemId] = await add(taskId, ["x"])
    const err = await refusal(
      run((tx) =>
        setValidations({
          tx,
          orgId,
          userId,
          actorKind: "human",
          entries: [{ itemId: itemId!, level: randomUUID(), state: "success" }],
          commentRequiredScopes: [],
        }),
      ),
    )
    expect(err.status).toBe(400)
    expect(err.code).toBe("checklist_level_unknown")
  })

  it("plain mode: an agent may set checked", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "plain")
    const [itemId] = await add(taskId, ["x"])
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "agent",
        entries: [{ itemId: itemId!, checked: true }],
        commentRequiredScopes: [],
      }),
    )
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items[0]?.checked).toBe(true)
    expect(view.status.complete).toBe(1)
  })

  it("level mode: checked is refused through setValidations and updateItem, for everyone", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "levels, no checkbox")
    const [itemId] = await add(taskId, ["x"])
    for (const actorKind of ["human", "agent"] as const) {
      const viaSet = await refusal(
        run((tx) =>
          setValidations({
            tx,
            orgId,
            userId,
            actorKind,
            entries: [{ itemId: itemId!, checked: true }],
            commentRequiredScopes: [],
          }),
        ),
      )
      expect(viaSet.status).toBe(400)
      expect(viaSet.code).toBe("checklist_checked_in_level_mode")
      const viaPatch = await refusal(
        run((tx) =>
          updateItem({ tx, orgId, userId, actorKind, itemId: itemId!, patch: { checked: true } }),
        ),
      )
      expect(viaPatch.status).toBe(400)
      expect(viaPatch.code).toBe("checklist_checked_in_level_mode")
    }
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items[0]?.checked).toBe(false)
  })

  it("plain mode: updateItem sets checked", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "plain patch")
    const [itemId] = await add(taskId, ["x"])
    await run((tx) =>
      updateItem({
        tx,
        orgId,
        userId,
        actorKind: "agent",
        itemId: itemId!,
        patch: { checked: true },
      }),
    )
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items[0]?.checked).toBe(true)
  })
})

describe("checklist validations: concurrency (per-key JSONB)", () => {
  it("two concurrent writes on different levels of one item both survive", async () => {
    const env = await makeProject(["AI", "Dev"])
    const taskId = await makeTask(env, "concurrent")
    const [itemId] = await add(taskId, ["x"])
    const write = (level: string) =>
      run(async (tx) => {
        const out = await setValidations({
          tx,
          orgId,
          userId,
          actorKind: "human",
          entries: [{ itemId: itemId!, level, state: "success" }],
          commentRequiredScopes: [],
        })
        // Hold the transaction open so both overlap.
        await new Promise((r) => setTimeout(r, 150))
        return out
      })
    await Promise.all([write("AI"), write("Dev")])
    const v = await itemValidations(itemId!)
    expect(v[env.levels[0]!.id]?.state).toBe("success")
    expect(v[env.levels[1]!.id]?.state).toBe("success")
  })

  it("two writes on the same level: the later one wins", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "same level")
    const [itemId] = await add(taskId, ["x"])
    const first = run(async (tx) => {
      await setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: itemId!, level: "AI", state: "success" }],
        commentRequiredScopes: [],
      })
      await new Promise((r) => setTimeout(r, 150))
    })
    await new Promise((r) => setTimeout(r, 50))
    const second = run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: itemId!, level: "AI", state: "na" }],
        commentRequiredScopes: [],
      }),
    )
    await Promise.all([first, second])
    expect((await itemValidations(itemId!))[env.levels[0]!.id]?.state).toBe("na")
  })
})

describe("validation levels (S9)", () => {
  it("removing a level strips its key from every item; renaming keeps states; adding leaves not_done", async () => {
    const env = await makeProject(["AI", "Dev"])
    const [ai, dev] = env.levels
    const t1 = await makeTask(env, "levels one")
    const t2 = await makeTask(env, "levels two")
    const [i1] = await add(t1, ["a"])
    const [i2] = await add(t2, ["b"])
    for (const itemId of [i1!, i2!]) {
      await run((tx) =>
        setValidations({
          tx,
          orgId,
          userId,
          actorKind: "human",
          entries: [
            { itemId, level: "AI", state: "success" },
            { itemId, level: "Dev", state: "na" },
          ],
          commentRequiredScopes: [],
        }),
      )
    }

    // Rename Dev -> Developer, drop AI, add Beta.
    const next = await run((tx) =>
      setValidationLevels({
        tx,
        orgId,
        userId,
        projectId: env.projectId,
        levels: [{ id: dev!.id, name: "Developer" }, { name: "Beta" }],
      }),
    )
    expect(next[0]).toEqual({ id: dev!.id, name: "Developer" })
    const beta = next[1]!
    expect(beta.id).not.toBe(ai!.id)
    for (const itemId of [i1!, i2!]) {
      const v = await itemValidations(itemId)
      expect(Object.keys(v)).toEqual([dev!.id])
      expect(v[dev!.id].state).toBe("na")
    }
    const view = await run((tx) => listChecklist({ tx, orgId, taskId: t1 }))
    expect(view.levels.map((l) => l.name)).toEqual(["Developer", "Beta"])
    expect(view.status.blocking[0]?.levels).toEqual(["Beta"])
  })

  it("refuses duplicate names case-insensitively", async () => {
    const env = await makeProject([])
    const err = await refusal(
      run((tx) =>
        setValidationLevels({
          tx,
          orgId,
          userId,
          projectId: env.projectId,
          levels: [{ name: "ai" }, { name: "AI" }],
        }),
      ),
    )
    expect(err.code).toBe("validation_levels_invalid")
  })

  it("a stored level carrying a legacy agentAccess key still parses, the key ignored", async () => {
    const env = await makeProject([])
    const levelId = randomUUID()
    await db.execute(drizzleSql`
      UPDATE app_projects.projects
      SET validation_levels = ${JSON.stringify([{ id: levelId, name: "Beta", agentAccess: "none" }])}::jsonb
      WHERE id = ${env.projectId}::uuid
    `)
    const taskId = await makeTask(env, "legacy level")
    const [itemId] = await add(taskId, ["x"])
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.levels).toEqual([{ id: levelId, name: "Beta" }])
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "agent",
        entries: [{ itemId: itemId!, level: "Beta", state: "success" }],
        commentRequiredScopes: [],
      }),
    )
    expect((await itemValidations(itemId!))[levelId]).toMatchObject({ state: "success" })
    // A client still sending the key on a write gets it dropped, not refused.
    const saved = await run((tx) =>
      setValidationLevels({
        tx,
        orgId,
        userId,
        projectId: env.projectId,
        levels: [
          { id: levelId, name: "Beta", agentAccess: "none" } as { id: string; name: string },
        ],
      }),
    )
    expect(saved).toEqual([{ id: levelId, name: "Beta" }])
  })
})

describe("checklist items: edit, reorder, remove, archive, merge, events", () => {
  it("reorders before/after a sibling and edits title and details", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "reorder")
    const [a, b, c] = await add(taskId, ["a", "b", "c"])
    await run((tx) =>
      updateItem({
        tx,
        orgId,
        userId,
        actorKind: "human",
        itemId: c!,
        patch: { afterItemId: a!, beforeItemId: b!, title: "c2", details: "**md**" },
      }),
    )
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items.map((i) => i.title)).toEqual(["a", "c2", "b"])
    expect(view.items[1]?.details).toBe("**md**")
    await run((tx) =>
      updateItem({
        tx,
        orgId,
        userId,
        actorKind: "human",
        itemId: a!,
        patch: { afterItemId: b! },
      }),
    )
    const again = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(again.items.map((i) => i.title)).toEqual(["c2", "b", "a"])
  })

  it("queues created, updated and deleted events carrying the taskId", async () => {
    const env = await makeProject(["AI"])
    const taskId = await makeTask(env, "events")
    const [itemId] = await add(taskId, ["evented"])
    expect(await itemEventCount(itemId!, "created")).toBe(1)
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: itemId!, level: "AI", state: "success" }],
        commentRequiredScopes: [],
      }),
    )
    expect(await itemEventCount(itemId!, "updated")).toBe(1)
    await run((tx) => removeItem({ tx, orgId, userId, actorKind: "human", itemId: itemId! }))
    expect(await itemEventCount(itemId!, "deleted")).toBe(1)
    const [payload] = extractRows<{ task_id: string }>(
      await db.execute(drizzleSql`
        SELECT payload->'data'->>'taskId' AS task_id FROM kernel.pending_events
        WHERE payload->>'entityId' = ${itemId!} AND payload->>'action' = 'deleted'
      `),
    )
    expect(payload?.task_id).toBe(taskId)
    const view = await run((tx) => listChecklist({ tx, orgId, taskId }))
    expect(view.items).toHaveLength(0)
  })

  it("an archived task's items are hidden with it and not deleted", async () => {
    const env = await makeProject([])
    const taskId = await makeTask(env, "archived")
    const [itemId] = await add(taskId, ["kept"])
    await run((tx) => deleteTask({ tx, orgId, actor, taskId }))
    const err = await refusal(run((tx) => listChecklist({ tx, orgId, taskId })))
    expect(err.status).toBe(404)
    const rows = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id FROM app_projects.task_checklist_items WHERE id = ${itemId!}::uuid
      `),
    )
    expect(rows).toHaveLength(1)
  })

  it("merge appends the source's items after the target's own, keeping validations", async () => {
    const env = await makeProject(["AI"])
    const target = await makeTask(env, "target")
    const source = await makeTask(env, "source")
    await add(target, ["t1", "t2"])
    const [s1] = await add(source, ["s1", "s2"])
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: s1!, level: "AI", state: "success" }],
        commentRequiredScopes: [],
      }),
    )
    await run((tx) => mergeTasks({ tx, orgId, actor, sourceId: source, targetId: target }))
    const view = await run((tx) => listChecklist({ tx, orgId, taskId: target }))
    expect(view.items.map((i) => i.title)).toEqual(["t1", "t2", "s1", "s2"])
    expect(view.items[2]?.validations[env.levels[0]!.id]?.state).toBe("success")
  })

  it("merge across projects maps validations by level name", async () => {
    const a = await makeProject(["AI"])
    const b = await makeProject(["Dev", "ai"])
    const target = await makeTask(b, "target")
    const source = await makeTask(a, "source")
    const [s1] = await add(source, ["s1"])
    await run((tx) =>
      setValidations({
        tx,
        orgId,
        userId,
        actorKind: "human",
        entries: [{ itemId: s1!, level: "AI", state: "success" }],
        commentRequiredScopes: [],
      }),
    )
    await run((tx) => mergeTasks({ tx, orgId, actor, sourceId: source, targetId: target }))
    expect(Object.keys(await itemValidations(s1!))).toEqual([b.levels[1]!.id])
  })

  it("merge is refused when the total would pass 200", async () => {
    const env = await makeProject([])
    const target = await makeTask(env, "full target")
    const source = await makeTask(env, "source")
    for (let batch = 0; batch < 4; batch++) {
      await add(
        target,
        Array.from({ length: 50 }, (_, i) => `b${batch} i${i}`),
      )
    }
    await add(source, ["overflow"])
    const err = await refusal(
      run((tx) => mergeTasks({ tx, orgId, actor, sourceId: source, targetId: target })),
    )
    expect(err.code).toBe("checklist_too_many_items")
  })
})
