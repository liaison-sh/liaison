// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { routineRuns } from "~/db/schema/kernel/routine-runs"
import { routines } from "~/db/schema/kernel/routines"
import { createTestOrg } from "~/tests/helpers/org"

async function expectPgErrorCode(p: Promise<unknown>, expected: string): Promise<void> {
  let caught: unknown
  try {
    await p
  } catch (e) {
    caught = e
  }
  if (caught === undefined) throw new Error(`expected pg error ${expected} but resolved`)
  let cur: unknown = caught
  let code: string | undefined
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const o = cur as { code?: string; cause?: unknown }
    if (typeof o.code === "string") {
      code = o.code
      break
    }
    cur = o.cause
  }
  if (code !== expected) {
    throw new Error(`expected pg error ${expected}, got ${code ?? "<none>"}: ${String(caught)}`)
  }
}

async function makeOrgRoutine(): Promise<{
  orgId: string
  userId: string
  routineId: string
}> {
  const org = await createTestOrg()
  const userId = await withSystemDb("rr-seed-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId: org.id,
        email: `u-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Owner",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  const routineId = await withPrivilegedDb(org.id, "rr-seed-routine", async (tx) => {
    const [r] = await tx
      .insert(routines)
      .values({
        orgId: org.id,
        ownerUserId: userId,
        name: "r",
        description: "d",
        cron: "* * * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: ["kernel:threads:write"],
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routines.id })
    return r.id
  })
  return { orgId: org.id, userId, routineId }
}

const ALL_STATUSES = [
  "succeeded",
  "failed",
  "skipped_no_credits",
  "skipped_overlap",
  "skipped_scope_mismatch",
  "output_thread_recreated",
] as const

describe("kernel.routine_runs schema", () => {
  for (const status of ALL_STATUSES) {
    it(`accepts status=${status}`, async () => {
      const { orgId, routineId } = await makeOrgRoutine()
      await withPrivilegedDb(orgId, `rr-insert-${status}`, async (tx) => {
        await tx.insert(routineRuns).values({ orgId, routineId, status })
      })
    })
  }

  it("rejects status='whatever'", async () => {
    const { orgId, routineId } = await makeOrgRoutine()
    await expectPgErrorCode(
      withPrivilegedDb(orgId, "rr-bad-status", async (tx) => {
        await tx.insert(routineRuns).values({ orgId, routineId, status: "whatever" as never })
      }),
      "23514",
    )
  })

  it("(routineId, ran_at DESC) index exists for the last-N-runs query plan", async () => {
    const rows = extractRows<{ indexdef: string }>(
      await withSystemDb("rr-indexes", (db) =>
        db.execute(drizzleSql`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname='kernel' AND tablename='routine_runs'
        `),
      ),
    )
    expect(
      rows.some((r) => r.indexdef.includes("routine_id") && r.indexdef.includes("ran_at")),
    ).toBe(true)
  })

  it("cascades on routine delete", async () => {
    const { orgId, routineId } = await makeOrgRoutine()
    await withPrivilegedDb(orgId, "rr-seed-run", async (tx) => {
      await tx.insert(routineRuns).values({ orgId, routineId, status: "succeeded" })
    })
    await withSystemDb("rr-delete-routine", async (db) => {
      await db.execute(drizzleSql`DELETE FROM kernel.routines WHERE id = ${routineId}::uuid`)
    })
    const rows = extractRows<{ id: string }>(
      await withSystemDb("rr-after-delete", (db) =>
        db.execute(
          drizzleSql`SELECT id FROM kernel.routine_runs WHERE routine_id = ${routineId}::uuid`,
        ),
      ),
    )
    expect(rows).toHaveLength(0)
  })
})
