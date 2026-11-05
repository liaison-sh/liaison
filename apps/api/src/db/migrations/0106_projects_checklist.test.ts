// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins what migration 0106 establishes for the task checklist: the storage
// shape (projects.validation_levels, tasks.release, task_checklist_items), the
// FK cascade from a task to its items, and the RLS contract on the items
// table. Each RLS case names the clause it discriminates: remove that clause
// from the policy and the case goes red.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const FULL_SCOPES = ["projects:projects:read", "projects:projects:write", "projects:tasks:write"]

type Org = { orgId: string; userId: string; actor: UserContext }

async function seedOrg(label: string, scopes: string[]): Promise<Org> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), ${`0106 ${label}`}, ${`migration-0106-${label}-${stamp}`}) RETURNING id
    `),
  )
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${org!.id}::uuid, ${`0106-${label}-${stamp}@t.co`}, ${`0106 ${label}`}, 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  return {
    orgId: org!.id,
    userId: u!.id,
    actor: { actorType: "user", userId: u!.id, orgId: org!.id, scopes, dimensionGrants: {} },
  }
}

async function seedTask(o: Org): Promise<string> {
  const project = await withRlsContext(o.actor, (tx) =>
    createProject({
      tx,
      orgId: o.orgId,
      actor: o.actor,
      input: { name: `Checklist ${Date.now()}` },
    }),
  )
  const statusId = project.statuses.find((s) => !s.terminal)!.id
  const task = await withRlsContext(o.actor, (tx) =>
    createTask({
      tx,
      orgId: o.orgId,
      actor: o.actor,
      input: { projectId: project.id, statusId, title: "checklist task" },
    }),
  )
  return task.id
}

async function insertItemPrivileged(
  orgId: string,
  taskId: string,
  userId: string,
): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.task_checklist_items (org_id, task_id, position, title, created_by)
      VALUES (${orgId}::uuid, ${taskId}::uuid, 1000, 'item', ${userId}::uuid) RETURNING id
    `),
  )
  return row!.id
}

async function insertAs(actor: UserContext, orgId: string, taskId: string): Promise<boolean> {
  try {
    await withRlsContext(actor, (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO app_projects.task_checklist_items (org_id, task_id, position, title, created_by)
        VALUES (${orgId}::uuid, ${taskId}::uuid, 1000, 'rls item', ${actor.userId}::uuid)
      `),
    )
    return true
  } catch {
    return false
  }
}

async function columns(
  table: string,
): Promise<
  Record<string, { data_type: string; is_nullable: string; column_default: string | null }>
> {
  const rows = extractRows<{
    column_name: string
    data_type: string
    is_nullable: string
    column_default: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'app_projects' AND table_name = ${table}
    `),
  )
  return Object.fromEntries(rows.map((r) => [r.column_name, r]))
}

let a: Org
let b: Org
let readOnlyA: UserContext
let taskA: string
let taskB: string

beforeAll(async () => {
  await acquireTestLock()
  a = await seedOrg("a", FULL_SCOPES)
  b = await seedOrg("b", FULL_SCOPES)
  readOnlyA = { ...a.actor, scopes: ["projects:projects:read"] }
  taskA = await seedTask(a)
  taskB = await seedTask(b)
})

afterAll(releaseTestLock)

describe("0106_projects_checklist storage", () => {
  it("adds projects.validation_levels jsonb NOT NULL DEFAULT '[]'", async () => {
    const c = (await columns("projects")).validation_levels
    expect(c).toBeDefined()
    expect(c!.data_type).toBe("jsonb")
    expect(c!.is_nullable).toBe("NO")
    expect(c!.column_default).toBe("'[]'::jsonb")
  })

  it("adds projects.checklist_on_cards boolean NOT NULL DEFAULT true", async () => {
    const c = (await columns("projects")).checklist_on_cards
    expect(c).toBeDefined()
    expect(c!.data_type).toBe("boolean")
    expect(c!.is_nullable).toBe("NO")
    expect(c!.column_default).toBe("true")
  })

  it("adds tasks.release as nullable text", async () => {
    const c = (await columns("tasks")).release
    expect(c).toBeDefined()
    expect(c!.data_type).toBe("text")
    expect(c!.is_nullable).toBe("YES")
    expect(c!.column_default).toBeNull()
  })

  it("creates task_checklist_items with the S1 columns", async () => {
    const c = await columns("task_checklist_items")
    const shape = Object.fromEntries(
      Object.entries(c).map(([k, v]) => [k, `${v.data_type}|${v.is_nullable}`]),
    )
    expect(shape).toEqual({
      id: "uuid|NO",
      org_id: "uuid|NO",
      task_id: "uuid|NO",
      position: "double precision|NO",
      title: "text|NO",
      details: "text|YES",
      checked: "boolean|NO",
      validations: "jsonb|NO",
      created_by: "uuid|NO",
      created_at: "timestamp with time zone|NO",
      updated_at: "timestamp with time zone|NO",
    })
    expect(c.checked!.column_default).toBe("false")
    expect(c.validations!.column_default).toBe("'{}'::jsonb")
  })

  it("indexes items by (task_id, position) and tasks by (org_id, lower(release))", async () => {
    const rows = extractRows<{ indexdef: string }>(
      await db.execute(drizzleSql`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'app_projects' AND tablename IN ('task_checklist_items', 'tasks')
      `),
    )
    const defs = rows.map((r) => r.indexdef)
    expect(
      defs.some((d) => /task_checklist_items USING btree \(task_id, "?position"?\)/.test(d)),
    ).toBe(true)
    expect(defs.some((d) => /tasks USING btree \(org_id, lower\(release\)\)/.test(d))).toBe(true)
  })

  it("enables and forces RLS on task_checklist_items and grants the app roles", async () => {
    const [r] = extractRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app_projects' AND c.relname = 'task_checklist_items'
      `),
    )
    expect(r?.relrowsecurity).toBe(true)
    expect(r?.relforcerowsecurity).toBe(true)
    for (const role of ["liaison_rls", "liaison_app"]) {
      const [g] = extractRows<{ ok: boolean }>(
        await db.execute(drizzleSql`
          SELECT has_table_privilege(${role}, 'app_projects.task_checklist_items', 'SELECT, INSERT, UPDATE, DELETE') AS ok
        `),
      )
      expect(g?.ok).toBe(true)
    }
  })

  it("deletes a task's items when the task is deleted (ON DELETE CASCADE)", async () => {
    const taskId = await seedTask(a)
    const itemId = await insertItemPrivileged(a.orgId, taskId, a.userId)
    await db.execute(drizzleSql`DELETE FROM app_projects.tasks WHERE id = ${taskId}::uuid`)
    const rows = extractRows(
      await db.execute(drizzleSql`
        SELECT 1 FROM app_projects.task_checklist_items WHERE id = ${itemId}::uuid
      `),
    )
    expect(rows).toHaveLength(0)
  })
})

describe("0106_projects_checklist RLS", () => {
  it("an org member with tasks write can insert and read an item on its own task", async () => {
    expect(await insertAs(a.actor, a.orgId, taskA)).toBe(true)
    const rows = await withRlsContext(a.actor, async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
          SELECT id FROM app_projects.task_checklist_items WHERE task_id = ${taskA}::uuid
        `),
      ),
    )
    expect(rows.length).toBeGreaterThan(0)
  })

  it("an actor of another org reads zero items", async () => {
    await insertItemPrivileged(a.orgId, taskA, a.userId)
    const rows = await withRlsContext(b.actor, async (tx) =>
      extractRows(
        await tx.execute(drizzleSql`
          SELECT id FROM app_projects.task_checklist_items WHERE task_id = ${taskA}::uuid
        `),
      ),
    )
    expect(rows).toHaveLength(0)
  })

  it("a member holding only projects:projects:read cannot insert (write scope check)", async () => {
    expect(await insertAs(readOnlyA, a.orgId, taskA)).toBe(false)
  })

  it("a member holding only projects:projects:read cannot update or delete (write scope check)", async () => {
    const itemId = await insertItemPrivileged(a.orgId, taskA, a.userId)
    const touched = await withRlsContext(readOnlyA, async (tx) => {
      const up = extractRows(
        await tx.execute(drizzleSql`
          UPDATE app_projects.task_checklist_items SET title = 'x' WHERE id = ${itemId}::uuid RETURNING id
        `),
      )
      const del = extractRows(
        await tx.execute(drizzleSql`
          DELETE FROM app_projects.task_checklist_items WHERE id = ${itemId}::uuid RETURNING id
        `),
      )
      return up.length + del.length
    })
    expect(touched).toBe(0)
  })

  it("an item whose org_id differs from its task's org is refused (task EXISTS check)", async () => {
    // Own org_id, foreign task: the org predicate passes and the FK check
    // bypasses RLS, so only the task EXISTS clause refuses it.
    expect(await insertAs(a.actor, a.orgId, taskB)).toBe(false)
    // Foreign org_id on an own task: refused by the org predicate.
    expect(await insertAs(a.actor, b.orgId, taskA)).toBe(false)
  })
})
