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
import { sql as drizzleSql, eq } from "drizzle-orm"
import postgres from "postgres"
import { withPrivilegedDb } from "~/db/privileged"
import { routineRuns, routines } from "~/db/schema/kernel"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import * as minimal from "~/seed/tiers/minimal"
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

function seed(name: string, event: string, eventFilter?: Record<string, unknown>) {
  return seedRoutine(seedContext({ orgId, now: new Date() }), {
    createdByUserId: userId,
    ownerScopes: [],
    routine: {
      name,
      description: "d",
      kind: "event",
      event,
      ownerUserId: userId,
      scopes: [],
      prompt: "p",
      ...(eventFilter ? { eventFilter } : {}),
    },
  })
}

/** A flow written as raw jsonb: shapes the typed column would not take. */
function setFlowJson(id: string, json: string) {
  return withPrivilegedDb(orgId, "0303-test-flow", (tx) =>
    tx
      .update(routines)
      .set({ flow: drizzleSql`${json}::jsonb` })
      .where(eq(routines.id, id)),
  )
}

function insertRun(status: string, steps?: Array<Record<string, unknown>>) {
  return withPrivilegedDb(orgId, "0303-test-run", (tx) =>
    tx.insert(routineRuns).values({
      orgId,
      routineId: legacyId,
      status,
      ...(steps ? { steps: drizzleSql`${JSON.stringify(steps)}::jsonb` } : {}),
    }),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg({ name: "0303 Org" })).orgId
  userId = (await minimal.person(orgId, { name: "Owner" })).id
  legacyId = await seed("legacy", "projects:task:moved")
  await insertRun("succeeded")
  await runMigration()
  await runMigration()
}, 60_000)

afterAll(async () => {
  await withPrivilegedDb(orgId, "0303-test-clean", async (tx) => {
    await tx.delete(routineRuns).where(eq(routineRuns.orgId, orgId))
    await tx.delete(routines).where(eq(routines.orgId, orgId))
  })
  await releaseTestLock()
})

describe("0303 routine flows", () => {
  it("allows a filter on projects task events, and still refuses one elsewhere", async () => {
    for (const event of [
      "projects:task:status_changed",
      "projects:task:updated",
      "projects:task:created",
    ]) {
      await seed(`f-${event.split(":")[2]}`, event, { projectId: orgId })
    }
    await expect(seed("f-moved", "projects:task:moved", { projectId: orgId })).rejects.toThrow()
  })

  it("takes a flow object with steps, refuses any other shape", async () => {
    const id = await seed("flow-shape", "projects:task:created")
    await setFlowJson(id, JSON.stringify({ version: 1, steps: [] }))
    await expect(setFlowJson(id, JSON.stringify([{ id: "a" }]))).rejects.toThrow()
    await expect(setFlowJson(id, JSON.stringify({ version: 1 }))).rejects.toThrow()
  })

  it("keeps flow run statuses and their steps", async () => {
    for (const status of ["running", "waiting", "flagged", "skipped_condition"]) {
      await insertRun(status, [{ id: "a", type: "action", state: "done" }])
    }
    await expect(insertRun("paused")).rejects.toThrow()
  })

  it("leaves a legacy routine and its runs as they were", async () => {
    const [r] = await withPrivilegedDb(orgId, "0303-test-read", (tx) =>
      tx.select({ flow: routines.flow }).from(routines).where(eq(routines.id, legacyId)),
    )
    expect(r!.flow).toBeNull()
    const runs = await withPrivilegedDb(orgId, "0303-test-runs", (tx) =>
      tx
        .select({ status: routineRuns.status, steps: routineRuns.steps })
        .from(routineRuns)
        .where(eq(routineRuns.routineId, legacyId)),
    )
    expect(runs.find((x) => x.status === "succeeded")).toEqual({ status: "succeeded", steps: null })
  })
})
