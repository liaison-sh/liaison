// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0303 adds `routines.flow`, `routine_runs.steps`, the flow run statuses and the projects task
// event filter. Runs the migration file itself (twice: it is re-runnable) and checks:
//   - a projects task event routine may carry a filter, any other event outside the old list may not;
//   - a flow must be an object with a steps array;
//   - a run may be running, waiting, flagged or skipped_condition, and keeps its steps;
//   - a legacy routine (no flow) and its succeeded run are untouched (S14).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import postgres from "postgres"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MIGRATION = join(import.meta.dir, "0303_routine_flows.sql")

/** The migration runs as the schema owner (the migrator's role), like 0103's test. */
function ownerUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

async function runMigration(): Promise<void> {
  const owner = postgres(ownerUrl(), { max: 1, onnotice: () => {} })
  try {
    await owner.begin((tx) =>
      tx.unsafe(readFileSync(MIGRATION, "utf8").replaceAll("--> statement-breakpoint", "")),
    )
  } finally {
    await owner.end()
  }
}

let orgId: string
let userId: string
let legacyId: string

async function insertRoutine(
  name: string,
  event: string,
  filter: unknown,
  flow: unknown,
): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.routines
        (org_id, owner_user_id, name, description, kind, event, prompt, scopes, created_by_actor_type,
         event_filter, flow)
      VALUES (${orgId}::uuid, ${userId}::uuid, ${name}, 'd', 'event', ${event}, 'p', '{}', 'user',
              ${filter === null ? null : JSON.stringify(filter)}::jsonb,
              ${flow === null ? null : JSON.stringify(flow)}::jsonb)
      RETURNING id
    `),
  )
  return row!.id
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), '0303 Org', ${`m0303-${Date.now()}-${Math.random()}`}) RETURNING id
    `),
  )
  orgId = org!.id
  const [u] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`m0303-${Date.now()}@test.com`}, 'Owner', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = u!.id
  legacyId = await insertRoutine("legacy", "projects:task:moved", null, null)
  await db.execute(drizzleSql`
    INSERT INTO kernel.routine_runs (org_id, routine_id, status) VALUES (${orgId}::uuid, ${legacyId}::uuid, 'succeeded')
  `)
  await runMigration()
  await runMigration()
})

afterAll(async () => {
  await releaseTestLock()
})

describe("0303 routine flows", () => {
  it("allows a filter on projects task events, and still refuses one elsewhere", async () => {
    for (const event of [
      "projects:task:status_changed",
      "projects:task:updated",
      "projects:task:created",
    ]) {
      await insertRoutine(`f-${event.split(":")[2]}`, event, { projectId: orgId }, null)
    }
    await expect(
      insertRoutine("f-moved", "projects:task:moved", { projectId: orgId }, null),
    ).rejects.toThrow()
  })

  it("takes a flow object with steps, refuses any other shape", async () => {
    await insertRoutine("flow-ok", "projects:task:created", null, { version: 1, steps: [] })
    await expect(
      insertRoutine("flow-array", "projects:task:created", null, [{ id: "a" }]),
    ).rejects.toThrow()
    await expect(
      insertRoutine("flow-nosteps", "projects:task:created", null, { version: 1 }),
    ).rejects.toThrow()
  })

  it("keeps flow run statuses and their steps", async () => {
    for (const status of ["running", "waiting", "flagged", "skipped_condition"]) {
      await db.execute(drizzleSql`
        INSERT INTO kernel.routine_runs (org_id, routine_id, status, steps)
        VALUES (${orgId}::uuid, ${legacyId}::uuid, ${status},
                ${JSON.stringify([{ id: "a", type: "action", state: "done" }])}::jsonb)
      `)
    }
    await expect(
      (async () =>
        db.execute(drizzleSql`
          INSERT INTO kernel.routine_runs (org_id, routine_id, status)
          VALUES (${orgId}::uuid, ${legacyId}::uuid, 'paused')
        `))(),
    ).rejects.toThrow()
  })

  it("leaves a legacy routine and its runs as they were", async () => {
    const [r] = extractRows<{ flow: unknown }>(
      await db.execute(drizzleSql`SELECT flow FROM kernel.routines WHERE id = ${legacyId}::uuid`),
    )
    expect(r!.flow).toBeNull()
    const runs = extractRows<{ status: string; steps: unknown }>(
      await db.execute(drizzleSql`
        SELECT status, steps FROM kernel.routine_runs WHERE routine_id = ${legacyId}::uuid AND status = 'succeeded'
      `),
    )
    expect(runs).toEqual([{ status: "succeeded", steps: null }])
  })
})
