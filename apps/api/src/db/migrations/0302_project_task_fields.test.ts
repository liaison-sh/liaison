// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0302 adds per-project task fields, `tasks.status_entered_at` and the append-only
// `task_transitions`. Runs the migration file itself against tasks shaped like the ones it meets
// on a live database (no transition yet):
//   - a task whose audit trail moved it into its current status, then edited it there: its time
//     in status starts at the move, not at the later edit;
//   - a task with no status event: it entered its status when it was created;
//   - each gets exactly one `system` transition into its status, and a second run adds none;
//   - the table is FORCE RLS, readable exactly when the task is, and no scope holder (`*`
//     included) can change or remove a transition;
//   - the backfill is one pass (no per-task scan of the audit events): measured below.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0302_project_task_fields.sql")
const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
]

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim() !== "")
  await withSystemDb("0302-test-run", async (tx) => {
    for (const statement of statements) await tx.execute(drizzleSql.raw(statement))
  })
}

let orgId: string
let actor: UserContext
let projectId: string
let statusA: string
let statusB: string

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), '0302 Org', ${`m0302-${Date.now()}-${Math.random()}`}) RETURNING id
    `),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`m0302-${Date.now()}@test.com`}, 'Owner', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  actor = {
    actorType: "user",
    userId: u!.id,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }
  const project = await withRlsContext(actor, (tx) =>
    createProject({ tx, orgId, actor, input: { name: `m0302-${Date.now()}` } }),
  )
  projectId = project.id
  statusA = project.statuses[0]!.id
  statusB = project.statuses[1]!.id
})

afterAll(async () => {
  await releaseTestLock()
})

/** A task as a database before 0302 holds it: in status B, with no transition. */
async function legacyTask(title: string, createdAt: string): Promise<string> {
  const task = await withRlsContext(actor, (tx) =>
    createTask({ tx, orgId, actor, input: { projectId, statusId: statusA, title } }),
  )
  await withSystemDb("0302-test-legacy", async (tx) => {
    await tx.execute(
      drizzleSql`DELETE FROM app_projects.task_transitions WHERE task_id = ${task.id}::uuid`,
    )
    await tx.execute(drizzleSql`
      UPDATE app_projects.tasks
      SET status_id = ${statusB}::uuid, created_at = ${createdAt}::timestamptz,
          status_entered_at = now()
      WHERE id = ${task.id}::uuid
    `)
  })
  return task.id
}

async function audit(taskId: string, action: string, statusId: string, at: string): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO kernel.audit_log (org_id, "timestamp", actor_type, app, entity_type, entity_id, action, changes)
    VALUES (${orgId}::uuid, ${at}::timestamptz, 'user', 'projects', 'task', ${taskId}, ${action},
            ${JSON.stringify({ statusId, changedFields: ["statusId"] })}::jsonb)
  `)
}

async function state(taskId: string) {
  const [task] = extractRows<{ status_entered_at: Date }>(
    await db.execute(
      drizzleSql`SELECT status_entered_at FROM app_projects.tasks WHERE id = ${taskId}::uuid`,
    ),
  )
  const transitions = extractRows<{
    from_status_id: string | null
    to_status_id: string
    actor_type: string
    at: Date
  }>(
    await db.execute(drizzleSql`
      SELECT from_status_id, to_status_id, actor_type, "at"
      FROM app_projects.task_transitions WHERE task_id = ${taskId}::uuid
    `),
  )
  return { enteredAt: new Date(task!.status_entered_at).toISOString(), transitions }
}

describe("0302 project task fields", () => {
  it("backfills the time in status from the audit trail, else creation, and seeds one transition each", async () => {
    const moved = await legacyTask("moved", "2026-01-01T00:00:00Z")
    await audit(moved, "task.created", statusA, "2026-01-01T00:00:00Z")
    await audit(moved, "task.moved", statusB, "2026-02-01T00:00:00Z")
    await audit(moved, "task.updated", statusB, "2026-03-01T00:00:00Z")
    const quiet = await legacyTask("quiet", "2026-01-05T00:00:00Z")

    await runMigration()

    const m = await state(moved)
    expect(m.enteredAt).toBe("2026-02-01T00:00:00.000Z")
    expect(m.transitions).toHaveLength(1)
    expect(m.transitions[0]).toMatchObject({
      from_status_id: null,
      to_status_id: statusB,
      actor_type: "system",
    })
    expect(new Date(m.transitions[0]!.at).toISOString()).toBe("2026-02-01T00:00:00.000Z")
    const q = await state(quiet)
    expect(q.enteredAt).toBe("2026-01-05T00:00:00.000Z")
    expect(q.transitions).toHaveLength(1)

    // A second run changes nothing.
    await runMigration()
    expect((await state(moved)).transitions).toHaveLength(1)
    expect((await state(moved)).enteredAt).toBe("2026-02-01T00:00:00.000Z")
  })

  it("the backfill is one pass: 10 000 tasks with 100 000 audit events take seconds, not hours", async () => {
    const template = await legacyTask("bulk-template", "2026-01-01T00:00:00Z")
    const TASKS = 10_000
    const PER_TASK = 10
    await withSystemDb("0302-test-bulk", async (tx) => {
      // Tasks shaped like the legacy one (no transition), each with ten audit events: A then B
      // alternating, the last one B (its current status), at hourly steps.
      await tx.execute(drizzleSql`
        INSERT INTO app_projects.tasks
          (id, org_id, project_id, status_id, number, title, thread_id, created_by, created_at)
        SELECT gen_random_uuid(), t.org_id, t.project_id, t.status_id, 1000000 + g, 'bulk',
               t.thread_id, t.created_by, t.created_at
        FROM app_projects.tasks t, generate_series(1, ${TASKS}) g
        WHERE t.id = ${template}::uuid
      `)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.audit_log (org_id, "timestamp", actor_type, app, entity_type, entity_id, action, changes)
        SELECT t.org_id, '2026-01-01T00:00:00Z'::timestamptz + make_interval(hours => k), 'user',
               'projects', 'task', t.id::text, 'task.updated',
               jsonb_build_object('statusId', CASE WHEN k % 2 = 1 THEN ${statusB} ELSE ${statusA} END)
        FROM app_projects.tasks t, generate_series(0, ${PER_TASK - 1}) k
        WHERE t.project_id = ${projectId}::uuid AND t.title = 'bulk'
      `)
    })
    const started = performance.now()
    await runMigration()
    const ms = Math.round(performance.now() - started)
    console.log(`0302 backfill: ${TASKS} tasks, ${TASKS * PER_TASK} audit events: ${ms} ms`)
    const [sample] = extractRows<{ status_entered_at: Date; n: number }>(
      await db.execute(drizzleSql`
        SELECT t.status_entered_at,
               (SELECT COUNT(*)::int FROM app_projects.task_transitions x WHERE x.task_id = t.id) AS n
        FROM app_projects.tasks t WHERE t.project_id = ${projectId}::uuid AND t.title = 'bulk' LIMIT 1
      `),
    )
    // The last event (k = 9, status B) is the first after the last A (k = 8).
    expect(new Date(sample!.status_entered_at).toISOString()).toBe("2026-01-01T09:00:00.000Z")
    expect(sample!.n).toBe(1)
    // The quadratic form took minutes at this size; one pass takes well under a minute.
    expect(ms).toBeLessThan(60_000)
  }, 180_000)

  it("task_transitions is FORCE RLS, follows the task, and a task writer cannot change or remove a row", async () => {
    const [rls] = extractRows<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      await db.execute(drizzleSql`
        SELECT c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app_projects' AND c.relname = 'task_transitions'
      `),
    )
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
    const task = await withRlsContext(actor, (tx) =>
      createTask({ tx, orgId, actor, input: { projectId, statusId: statusA, title: "rls" } }),
    )
    // Registration's scope-only policies pass on `*`, `projects` and `projects:*`; the
    // migration's restrictive ones hold for those holders too.
    for (const scopes of [SCOPES, ["*"], ["projects:*"], ["projects"]]) {
      const touched = await withRlsContext({ ...actor, scopes }, async (tx) => {
        const updated = extractRows(
          await tx.execute(drizzleSql`
            UPDATE app_projects.task_transitions SET to_status_id = ${statusB}::uuid
            WHERE task_id = ${task.id}::uuid RETURNING id
          `),
        )
        const deleted = extractRows(
          await tx.execute(drizzleSql`
            DELETE FROM app_projects.task_transitions WHERE task_id = ${task.id}::uuid RETURNING id
          `),
        )
        return updated.length + deleted.length
      })
      expect({ scopes, touched }).toEqual({ scopes, touched: 0 })
    }
    const visible = (scopes: string[]) =>
      withRlsContext(
        { ...actor, scopes },
        async (tx) =>
          extractRows(
            await tx.execute(drizzleSql`
            SELECT id FROM app_projects.task_transitions WHERE task_id = ${task.id}::uuid
          `),
          ).length,
      )
    expect(await visible(SCOPES)).toBe(1)
    expect(await visible(["kernel:threads:read"])).toBe(0)
  })
})
