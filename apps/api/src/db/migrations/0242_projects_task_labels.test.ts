// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins what migration 0242 establishes for task labels: the two tables, RLS on
// both (read with projects:projects:read, taxonomy writes with
// projects:labels:admin, assignment writes with projects:tasks:write), the
// one-value-per-group unique key, the composite FK proving a value belongs to
// its group, the parent guard (depth 2, parents immutable), the cascade from a
// task, and the absence of hard delete on the taxonomy.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { sql as drizzleSql } from "drizzle-orm"
import postgres from "postgres"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const FULL_SCOPES = ["projects:projects:read", "projects:projects:write", "projects:tasks:write"]
const ADMIN_SCOPES = ["projects:projects:read", "projects:labels:admin"]
const MEMBER_SCOPES = ["projects:projects:read", "projects:tasks:write"]

type Org = { orgId: string; userId: string; actor: UserContext }

async function seedOrg(label: string, scopes: string[]): Promise<Org> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), ${`0242 ${label}`}, ${`migration-0242-${label}-${stamp}`}) RETURNING id
    `),
  )
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${org!.id}::uuid, ${`0242-${label}-${stamp}@t.co`}, ${`0242 ${label}`}, 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  return {
    orgId: org!.id,
    userId: u!.id,
    actor: { actorType: "user", userId: u!.id, orgId: org!.id, scopes, dimensionGrants: {} },
  }
}

function withScopes(o: Org, scopes: string[]): UserContext {
  return { ...o.actor, scopes }
}

async function seedTask(o: Org): Promise<string> {
  const project = await withRlsContext(o.actor, (tx) =>
    createProject({ tx, orgId: o.orgId, actor: o.actor, input: { name: `Labels ${Date.now()}` } }),
  )
  const statusId = project.statuses.find((s) => !s.terminal)!.id
  const task = await withRlsContext(o.actor, (tx) =>
    createTask({
      tx,
      orgId: o.orgId,
      actor: o.actor,
      input: { projectId: project.id, statusId, title: "labels task" },
    }),
  )
  return task.id
}

async function insertLabelPrivileged(
  orgId: string,
  name: string,
  parentId: string | null,
): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.labels (org_id, name, parent_id)
      VALUES (${orgId}::uuid, ${name}, ${parentId}::uuid) RETURNING id
    `),
  )
  return row!.id
}

async function assignPrivileged(
  orgId: string,
  taskId: string,
  groupId: string,
  valueId: string,
): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
      VALUES (${orgId}::uuid, ${taskId}::uuid, ${groupId}::uuid, ${valueId}::uuid) RETURNING id
    `),
  )
  return row!.id
}

async function pgCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } }
    return e.code ?? e.cause?.code ?? "unknown"
  }
}

async function pgMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return ""
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } }
    return `${e.message ?? ""} ${e.cause?.message ?? ""}`
  }
}

async function countPrivileged(table: "labels" | "task_labels", orgId: string): Promise<number> {
  const [r] = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM app_projects.${drizzleSql.raw(table)} WHERE org_id = ${orgId}::uuid`,
    ),
  )
  return r!.n
}

/** SQLSTATE of a row refused by a policy's WITH CHECK. */
const RLS_REFUSED = "42501"
/** SQLSTATE of a foreign-key violation. */
const FK_VIOLATION = "23503"

let a: Org
let b: Org
let taskA: string
let taskB: string
let groupA: string
let valueA: string
let group2A: string
let value2A: string

beforeAll(async () => {
  await acquireTestLock()
  a = await seedOrg("a", FULL_SCOPES)
  b = await seedOrg("b", FULL_SCOPES)
  taskA = await seedTask(a)
  taskB = await seedTask(b)
  groupA = await insertLabelPrivileged(a.orgId, "Nature", null)
  valueA = await insertLabelPrivileged(a.orgId, "bug", groupA)
  group2A = await insertLabelPrivileged(a.orgId, "Domain", null)
  value2A = await insertLabelPrivileged(a.orgId, "security", group2A)
})

afterAll(releaseTestLock)

describe("0242_projects_task_labels storage", () => {
  it("creates both tables with RLS enabled and forced", async () => {
    const rows = extractRows<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      await db.execute(drizzleSql`
        SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app_projects' AND c.relname IN ('labels', 'task_labels')
      `),
    )
    expect(rows.map((r) => r.relname).sort()).toEqual(["labels", "task_labels"])
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true)
      expect(r.relforcerowsecurity).toBe(true)
    }
  })

  it("refuses a second assignment for the same task and group (unique)", async () => {
    const taskId = await seedTask(a)
    const other = await insertLabelPrivileged(a.orgId, `evolution-${Date.now()}`, groupA)
    await assignPrivileged(a.orgId, taskId, groupA, valueA)
    expect(await pgCode(() => assignPrivileged(a.orgId, taskId, groupA, other))).toBe("23505")
  })

  it("refuses a value of another group, and a group id as value (composite FK)", async () => {
    const taskId = await seedTask(a)
    expect(await pgCode(() => assignPrivileged(a.orgId, taskId, group2A, valueA))).toBe("23503")
    expect(await pgCode(() => assignPrivileged(a.orgId, taskId, groupA, groupA))).toBe("23503")
  })

  it("deletes a task's assignments when the task is deleted", async () => {
    const taskId = await seedTask(a)
    const id = await assignPrivileged(a.orgId, taskId, groupA, valueA)
    await db.execute(drizzleSql`DELETE FROM app_projects.tasks WHERE id = ${taskId}::uuid`)
    const rows = extractRows(
      await db.execute(drizzleSql`SELECT 1 FROM app_projects.task_labels WHERE id = ${id}::uuid`),
    )
    expect(rows).toHaveLength(0)
  })
})

describe("0242_projects_task_labels parent guard", () => {
  it("refuses a child under a value", async () => {
    expect(await pgMessage(() => insertLabelPrivileged(a.orgId, "deep", valueA))).toContain(
      "label_depth_limit",
    )
  })

  it("refuses a child under a group of another org", async () => {
    expect(await pgMessage(() => insertLabelPrivileged(b.orgId, "foreign", groupA))).toContain(
      "label_depth_limit",
    )
  })

  it("refuses any change of parent_id and allows name, sort and archive edits", async () => {
    const g = await insertLabelPrivileged(a.orgId, `G-${Date.now()}`, null)
    const v = await insertLabelPrivileged(a.orgId, "v", g)
    const moves = [
      drizzleSql`UPDATE app_projects.labels SET parent_id = ${group2A}::uuid WHERE id = ${v}::uuid`,
      drizzleSql`UPDATE app_projects.labels SET parent_id = NULL WHERE id = ${v}::uuid`,
      drizzleSql`UPDATE app_projects.labels SET parent_id = ${group2A}::uuid WHERE id = ${g}::uuid`,
    ]
    for (const q of moves) {
      expect(await pgMessage(() => db.execute(q))).toContain("label_parent_immutable")
    }
    await db.execute(
      drizzleSql`UPDATE app_projects.labels SET name = 'v2', sort_order = 3, archived_at = now() WHERE id = ${v}::uuid`,
    )
    const [r] = extractRows<{ name: string; parent_id: string }>(
      await db.execute(
        drizzleSql`SELECT name, parent_id FROM app_projects.labels WHERE id = ${v}::uuid`,
      ),
    )
    expect(r).toEqual({ name: "v2", parent_id: g })
  })
})

describe("0242_projects_task_labels RLS", () => {
  it("an admin inserts a group and a value; a member is refused insert and updates nothing", async () => {
    const admin = withScopes(a, ADMIN_SCOPES)
    const ids = await withRlsContext(admin, async (tx) => {
      const [g] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_projects.labels (org_id, name) VALUES (${a.orgId}::uuid, ${`Team-${Date.now()}`}) RETURNING id
        `),
      )
      const [v] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_projects.labels (org_id, name, parent_id) VALUES (${a.orgId}::uuid, 'core', ${g!.id}::uuid) RETURNING id
        `),
      )
      return { g: g!.id, v: v!.id }
    })
    const stored = extractRows<{ id: string; parent_id: string | null }>(
      await db.execute(drizzleSql`
        SELECT id, parent_id FROM app_projects.labels WHERE id IN (${ids.g}::uuid, ${ids.v}::uuid)
      `),
    )
    expect(stored.find((r) => r.id === ids.v)?.parent_id).toBe(ids.g)

    const member = withScopes(a, MEMBER_SCOPES)
    expect(
      await pgCode(() =>
        withRlsContext(member, (tx) =>
          tx.execute(
            drizzleSql`INSERT INTO app_projects.labels (org_id, name) VALUES (${a.orgId}::uuid, 'nope')`,
          ),
        ),
      ),
    ).toBe(RLS_REFUSED)
    const updated = await withRlsContext(member, async (tx) =>
      extractRows(
        await tx.execute(
          drizzleSql`UPDATE app_projects.labels SET name = 'x' WHERE id = ${ids.g}::uuid RETURNING id`,
        ),
      ),
    )
    expect(updated).toHaveLength(0)
  })

  it("projects:projects:read alone reads labels and assignments; no projects read scope reads nothing", async () => {
    const taskId = await seedTask(a)
    await assignPrivileged(a.orgId, taskId, groupA, valueA)
    const reader = withScopes(a, ["projects:projects:read"])
    const seen = await withRlsContext(reader, async (tx) => ({
      labels: extractRows(await tx.execute(drizzleSql`SELECT id FROM app_projects.labels`)).length,
      assignments: extractRows(
        await tx.execute(drizzleSql`SELECT id FROM app_projects.task_labels`),
      ).length,
    }))
    expect(seen.labels).toBeGreaterThan(0)
    expect(seen.assignments).toBeGreaterThan(0)

    const noRead = withScopes(a, ["projects:tasks:read", "projects:tasks:write"])
    const hidden = await withRlsContext(noRead, async (tx) => ({
      labels: extractRows(await tx.execute(drizzleSql`SELECT id FROM app_projects.labels`)).length,
      assignments: extractRows(
        await tx.execute(drizzleSql`SELECT id FROM app_projects.task_labels`),
      ).length,
    }))
    expect(await countPrivileged("labels", a.orgId)).toBeGreaterThan(0)
    expect(await countPrivileged("task_labels", a.orgId)).toBeGreaterThan(0)
    expect(hidden).toEqual({ labels: 0, assignments: 0 })
  })

  it("another org sees nothing of org A and cannot touch its assignments", async () => {
    const taskId = await seedTask(a)
    const assignmentId = await assignPrivileged(a.orgId, taskId, groupA, valueA)
    const bLabels = await withRlsContext(b.actor, async (tx) => ({
      labels: extractRows(
        await tx.execute(
          drizzleSql`SELECT id FROM app_projects.labels WHERE org_id = ${a.orgId}::uuid`,
        ),
      ).length,
      assignments: extractRows(
        await tx.execute(
          drizzleSql`SELECT id FROM app_projects.task_labels WHERE org_id = ${a.orgId}::uuid`,
        ),
      ).length,
    }))
    expect(bLabels).toEqual({ labels: 0, assignments: 0 })

    expect(
      await pgCode(() =>
        withRlsContext(b.actor, (tx) =>
          tx.execute(drizzleSql`
            INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
            VALUES (${a.orgId}::uuid, ${taskA}::uuid, ${group2A}::uuid, ${value2A}::uuid)
          `),
        ),
      ),
    ).toBe(RLS_REFUSED)

    const touched = await withRlsContext(b.actor, async (tx) => {
      const up = extractRows(
        await tx.execute(drizzleSql`
          UPDATE app_projects.task_labels SET value_id = ${valueA}::uuid WHERE id = ${assignmentId}::uuid RETURNING id
        `),
      )
      const del = extractRows(
        await tx.execute(
          drizzleSql`DELETE FROM app_projects.task_labels WHERE id = ${assignmentId}::uuid RETURNING id`,
        ),
      )
      return up.length + del.length
    })
    expect(touched).toBe(0)
    const [still] = extractRows<{ value_id: string }>(
      await db.execute(
        drizzleSql`SELECT value_id FROM app_projects.task_labels WHERE id = ${assignmentId}::uuid`,
      ),
    )
    expect(still?.value_id).toBe(valueA)
  })

  it("org B cannot label org A's task under its own org id (the same-org task guard)", async () => {
    // Everything but the task is org B's own: only the policies' "task in the
    // same org" EXISTS clause stands between B and A's task (the FK to tasks
    // checks no org, the composite FK only ties group and value to the org).
    const groupB = await insertLabelPrivileged(b.orgId, `Nature-${Date.now()}`, null)
    const valueB = await insertLabelPrivileged(b.orgId, "bug", groupB)
    const before = await countPrivileged("task_labels", b.orgId)
    expect(
      await pgCode(() =>
        withRlsContext(b.actor, (tx) =>
          tx.execute(drizzleSql`
            INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
            VALUES (${b.orgId}::uuid, ${taskA}::uuid, ${groupB}::uuid, ${valueB}::uuid)
          `),
        ),
      ),
    ).toBe(RLS_REFUSED)

    // Nor re-point one of its own rows at A's task.
    const own = await assignPrivileged(b.orgId, taskB, groupB, valueB)
    expect(
      await pgCode(() =>
        withRlsContext(b.actor, (tx) =>
          tx.execute(drizzleSql`
            UPDATE app_projects.task_labels SET task_id = ${taskA}::uuid WHERE id = ${own}::uuid
          `),
        ),
      ),
    ).toBe(RLS_REFUSED)
    const [row] = extractRows<{ task_id: string }>(
      await db.execute(
        drizzleSql`SELECT task_id FROM app_projects.task_labels WHERE id = ${own}::uuid`,
      ),
    )
    expect(row?.task_id).toBe(taskB)
    expect(await countPrivileged("task_labels", b.orgId)).toBe(before + 1)
  })

  it("org B cannot put org A's group and value on its own task (composite FK carries the org)", async () => {
    const before = await countPrivileged("task_labels", b.orgId)
    expect(
      await pgCode(() =>
        withRlsContext(b.actor, (tx) =>
          tx.execute(drizzleSql`
            INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
            VALUES (${b.orgId}::uuid, ${taskB}::uuid, ${groupA}::uuid, ${valueA}::uuid)
          `),
        ),
      ),
    ).toBe(FK_VIOLATION)
    // Without RLS too: the constraint itself refuses it.
    expect(await pgCode(() => assignPrivileged(b.orgId, taskB, groupA, valueA))).toBe(FK_VIOLATION)
    expect(await countPrivileged("task_labels", b.orgId)).toBe(before)
  })

  it("assignment writes need exactly projects:tasks:write", async () => {
    const refused = [
      withScopes(a, ["projects:projects:read"]),
      withScopes(a, ["projects:projects:read", "projects:projects:write", "projects:labels:admin"]),
    ]
    for (const actor of refused) {
      const taskId = await seedTask(a)
      expect(
        await pgCode(() =>
          withRlsContext(actor, (tx) =>
            tx.execute(drizzleSql`
              INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
              VALUES (${a.orgId}::uuid, ${taskId}::uuid, ${groupA}::uuid, ${valueA}::uuid)
            `),
          ),
        ),
      ).toBe(RLS_REFUSED)
      const id = await assignPrivileged(a.orgId, taskId, group2A, value2A)
      const touched = await withRlsContext(actor, async (tx) => {
        const up = extractRows(
          await tx.execute(
            drizzleSql`UPDATE app_projects.task_labels SET updated_at = now() WHERE id = ${id}::uuid RETURNING id`,
          ),
        )
        const del = extractRows(
          await tx.execute(
            drizzleSql`DELETE FROM app_projects.task_labels WHERE id = ${id}::uuid RETURNING id`,
          ),
        )
        return up.length + del.length
      })
      expect(touched).toBe(0)
      const rows = extractRows(
        await db.execute(drizzleSql`SELECT 1 FROM app_projects.task_labels WHERE id = ${id}::uuid`),
      )
      expect(rows).toHaveLength(1)
    }

    const member = withScopes(a, MEMBER_SCOPES)
    const taskId = await seedTask(a)
    const result = await withRlsContext(member, async (tx) => {
      const [ins] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_projects.task_labels (org_id, task_id, group_id, value_id)
          VALUES (${a.orgId}::uuid, ${taskId}::uuid, ${groupA}::uuid, ${valueA}::uuid) RETURNING id
        `),
      )
      const up = extractRows(
        await tx.execute(
          drizzleSql`UPDATE app_projects.task_labels SET updated_at = now() WHERE id = ${ins!.id}::uuid RETURNING id`,
        ),
      )
      const del = extractRows(
        await tx.execute(
          drizzleSql`DELETE FROM app_projects.task_labels WHERE id = ${ins!.id}::uuid RETURNING id`,
        ),
      )
      return { up: up.length, del: del.length }
    })
    expect(result).toEqual({ up: 1, del: 1 })
  })

  it("never hard-deletes a label, even for an admin", async () => {
    const g = await insertLabelPrivileged(a.orgId, `Del-${Date.now()}`, null)
    const admin = withScopes(a, ADMIN_SCOPES)
    let deleted = 0
    let code: string | null = null
    try {
      deleted = await withRlsContext(
        admin,
        async (tx) =>
          extractRows(
            await tx.execute(
              drizzleSql`DELETE FROM app_projects.labels WHERE id = ${g}::uuid RETURNING id`,
            ),
          ).length,
      )
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } }
      code = e.code ?? e.cause?.code ?? "unknown"
    }
    expect(code === "42501" || deleted === 0).toBe(true)
    const rows = extractRows(
      await db.execute(drizzleSql`SELECT 1 FROM app_projects.labels WHERE id = ${g}::uuid`),
    )
    expect(rows).toHaveLength(1)
  })
})

// The migration is re-runnable: replaying its own statements over the migrated
// database succeeds and leaves exactly one of everything it creates. Run as an
// owner role (scripts/db-reset.ts convention), in one transaction so other
// sessions never see a dropped policy.
describe("0242_projects_task_labels replay", () => {
  function privilegedUrl(): string {
    if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
    const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
    const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
    return `${base.replace(/\/$/, "")}/${dbName}`
  }

  /** Counts of what 0242 creates (the runtime's generated `<table>_rls_*` policies left out). */
  async function shape(
    sql: postgres.Sql | postgres.TransactionSql,
  ): Promise<Record<string, number>> {
    const [row] = await sql<Record<string, number>[]>`
      SELECT
        (SELECT count(*)::int FROM pg_trigger
          WHERE tgname = 'labels_parent_guard' AND NOT tgisinternal) AS guard_triggers,
        (SELECT count(*)::int FROM pg_constraint
          WHERE conname = 'task_labels_value_in_group_fk') AS composite_fks,
        (SELECT count(*)::int FROM pg_constraint
          WHERE conname = 'labels_id_parent_org_key') AS id_parent_org_keys,
        (SELECT count(*)::int FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'app_projects' AND t.relname = 'task_labels' AND c.contype = 'u') AS task_label_uniques,
        (SELECT count(*)::int FROM pg_policies
          WHERE schemaname = 'app_projects' AND tablename = 'labels'
            AND policyname NOT LIKE '%\\_rls\\_%') AS label_policies,
        (SELECT count(*)::int FROM pg_policies
          WHERE schemaname = 'app_projects' AND tablename = 'task_labels'
            AND policyname NOT LIKE '%\\_rls\\_%') AS task_label_policies,
        (SELECT count(*)::int FROM pg_indexes
          WHERE schemaname = 'app_projects' AND tablename IN ('labels', 'task_labels')) AS indexes`
    return row!
  }

  it("replaying 0242's own statements succeeds and changes nothing", async () => {
    const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
    try {
      const before = await shape(sql)
      expect(before).toMatchObject({
        guard_triggers: 1,
        composite_fks: 1,
        id_parent_org_keys: 1,
        task_label_uniques: 1,
        label_policies: 4,
        task_label_policies: 5,
      })
      const statements = readFileSync(
        new URL("./0242_projects_task_labels.sql", import.meta.url).pathname,
        "utf8",
      )
        .split("--> statement-breakpoint")
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
      expect(statements.length).toBeGreaterThan(0)
      await sql.begin(async (tx) => {
        for (const statement of statements) await tx.unsafe(statement)
      })
      expect(await shape(sql)).toEqual(before)
    } finally {
      await sql.end()
    }
  })

  // A database that applied an earlier copy of this migration (a fork shipped
  // it under another number, with bare rls_ctx calls in its policies) converges
  // here: the tables and their rows are kept, the policies come out in the
  // read-once form. Rolled back, so the migrated database is left as it was.
  it("converges a database that applied the earlier copy, keeping its rows", async () => {
    const sql = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
    const rollback = new Error("rollback")
    try {
      const before = await shape(sql)
      const statements = readFileSync(
        new URL("./0242_projects_task_labels.sql", import.meta.url).pathname,
        "utf8",
      )
        .split("--> statement-breakpoint")
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
      const earlier = statements.map((x) =>
        x.replaceAll("(SELECT rls_ctx.org_id())::uuid", "rls_ctx.org_id()::uuid"),
      )
      expect(earlier.join("\n")).not.toContain("SELECT rls_ctx.org_id()")
      const orgId = crypto.randomUUID()
      await sql
        .begin(async (tx) => {
          await tx.unsafe("DROP TABLE app_projects.task_labels, app_projects.labels CASCADE")
          for (const statement of earlier) await tx.unsafe(statement)
          await tx.unsafe(
            "INSERT INTO app_projects.labels (org_id, name) VALUES ($1::uuid, 'Nature')",
            [orgId],
          )
          for (const statement of statements) await tx.unsafe(statement)
          expect(await shape(tx)).toEqual(before)
          const kept = await tx.unsafe(
            "SELECT count(*)::int AS n FROM app_projects.labels WHERE org_id = $1::uuid",
            [orgId],
          )
          expect(kept[0]?.n).toBe(1)
          const quals = await tx.unsafe(
            `SELECT policyname, coalesce(qual, with_check) AS q FROM pg_policies
              WHERE schemaname = 'app_projects' AND tablename IN ('labels', 'task_labels')
                AND policyname NOT LIKE '%\\_rls\\_%' AND policyname NOT LIKE '%deny_default'`,
          )
          expect(quals.length).toBe(7)
          for (const row of quals) expect(String(row.q)).toContain("SELECT rls_ctx.org_id()")
          throw rollback
        })
        .catch((err: unknown) => {
          if (err !== rollback) throw err
        })
      expect(await shape(sql)).toEqual(before)
    } finally {
      await sql.end()
    }
  })
})
