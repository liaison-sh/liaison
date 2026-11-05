// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T9 — audit_log entries written inside an active runContextStore frame
// carry `metadata.runId` and `metadata.parentRunId`. Entries written outside
// any frame do not carry those keys (no ALS leakage).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { auditLog } from "~/db/schema/kernel"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { writeAuditLog } from "~/modules/audit/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
})

afterAll(async () => {
  await releaseTestLock()
})

describe("audit log linkage (T9)", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
  })

  it("audit_log entries written inside a run frame carry runId + parentRunId", async () => {
    const subRunId = crypto.randomUUID()
    const parentRunId = crypto.randomUUID()
    const entityId = crypto.randomUUID()

    await runContextStore.run(
      {
        runId: subRunId,
        parentRunId,
        rootRunId: parentRunId,
        nestingDepth: 1,
      },
      async () => {
        await withPrivilegedDb(orgId, "t9-audit-insert", async (db) => {
          await writeAuditLog(db, {
            orgId,
            actorId: userId,
            actorType: "agent",
            app: "kernel",
            entityType: "sub_run_test",
            entityId,
            action: "test_action",
          })
        })
      },
    )

    const [row] = await withPrivilegedDb(orgId, "t9-audit-read", async (db) =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityId, entityId)))
        .limit(1),
    )
    expect(row).toBeDefined()
    const md = row.metadata as Record<string, unknown>
    expect(md.runId).toBe(subRunId)
    expect(md.parentRunId).toBe(parentRunId)
  })

  it("audit_log entries outside any run frame do NOT carry runId metadata (no ALS leak)", async () => {
    const entityId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "t9-audit-no-frame", async (db) => {
      await writeAuditLog(db, {
        orgId,
        actorId: userId,
        actorType: "system",
        app: "kernel",
        entityType: "background_test",
        entityId,
        action: "no_frame",
      })
    })

    const [row] = await withPrivilegedDb(orgId, "t9-audit-no-frame-read", async (db) =>
      db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.entityId, entityId)))
        .limit(1),
    )
    expect(row).toBeDefined()
    const md = (row.metadata ?? {}) as Record<string, unknown>
    expect(md.runId).toBeUndefined()
    expect(md.parentRunId).toBeUndefined()
  })

  it("can find all audit rows for a sub-run via metadata ->> 'runId'", async () => {
    const subRunId = crypto.randomUUID()
    const parentRunId = crypto.randomUUID()
    const insideEntityIds = [crypto.randomUUID(), crypto.randomUUID()]

    await runContextStore.run(
      {
        runId: subRunId,
        parentRunId,
        rootRunId: parentRunId,
        nestingDepth: 1,
      },
      async () => {
        for (const id of insideEntityIds) {
          await withPrivilegedDb(orgId, "t9-audit-multi", async (db) => {
            await writeAuditLog(db, {
              orgId,
              actorId: userId,
              actorType: "agent",
              app: "kernel",
              entityType: "sub_run_op",
              entityId: id,
              action: "step",
            })
          })
        }
      },
    )

    const rows = await withPrivilegedDb(orgId, "t9-audit-query", async (db) =>
      db
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.orgId, orgId), drizzleSql`${auditLog.metadata}->>'runId' = ${subRunId}`),
        ),
    )
    expect(rows.length).toBe(2)
  })
})
