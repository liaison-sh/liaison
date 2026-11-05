// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { auditLog } from "~/db/schema/kernel"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedAuditMutationSet } from "./seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("B9 — audit log completeness: every kernel mutation produces a matching audit entry", () => {
  test("each mutation in the seeded set yields an audit row with correct actor, action, entity, and changes", async () => {
    const mutations = await seedAuditMutationSet()
    for (const m of mutations) {
      await m.execute()
      const rows = await withSystemDb("b9-fetch", async (db) =>
        db
          .select({
            actorId: auditLog.actorId,
            action: auditLog.action,
            entityId: auditLog.entityId,
            changes: auditLog.changes,
          })
          .from(auditLog)
          .where(and(eq(auditLog.entityId, m.entityId), eq(auditLog.action, m.expectedAction))),
      )
      const matching = rows[0]
      expect(matching).toBeDefined()
      expect(matching!.actorId).toBe(m.actorId)
      expect(matching!.entityId).toBe(m.entityId)
      expect(matching!.action).toBe(m.expectedAction)
      expect(m.expectedChanges(matching!.changes)).toBe(true)
    }
  })
})
