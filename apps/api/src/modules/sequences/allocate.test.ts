// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B5 — gapless sequence allocator. Uses `withPrivilegedDb` to
// drive the calling tool-handler's tx semantics (the allocator only cares
// that it runs inside *a* transaction — privileged vs RLS is irrelevant to
// the lock + UPSERT path).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { allocateSequence } from "./allocate"

/**
 * Insert a bare organizations row directly (no bootstrapRegister, no roles).
 * Multi-org allocator tests need two orgs to COEXIST, but bootstrapRegister
 * enforces a single-org invariant (createTestOrg truncates on every call), so
 * a second createTestOrg() would delete the first org. Since WS-3 added the
 * `app_sequences_org_fk` FK, that orphaned-org pattern now (correctly) fails
 * the FK — these helpers insert coexisting orgs instead. The allocator + its
 * org-scoped RLS policy only need the org row to exist; no roles/users needed.
 */
async function insertBareOrg(): Promise<string> {
  const id = crypto.randomUUID()
  await withSystemDb("test-seq-bare-org", async (db) => {
    await db.execute(
      drizzleSql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}::uuid, ${"seq-test"}, ${`seq-${id}`})`,
    )
  })
  return id
}

describe("sequences.allocate (K3)", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  test("monotonic per (org, app, key) starting at 1", async () => {
    const { id: orgId } = await createTestOrg()
    const k = "invoicing:doc_number:issuer_1:invoice:2026"
    const values: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await withPrivilegedDb(orgId, `b5-mono-${i}`, (tx) =>
        allocateSequence(tx as unknown as RlsClient, {
          orgId,
          callingAppId: "invoicing",
          key: k,
        }),
      )
      values.push(r.value)
    }
    expect(values).toEqual([1, 2, 3, 4, 5])
  })

  test("isolates by org", async () => {
    // Two orgs must coexist (see insertBareOrg) — a second createTestOrg() would
    // truncate the first away and the app_sequences_org_fk FK would then reject
    // the orphaned allocation.
    const orgA = await insertBareOrg()
    const orgB = await insertBareOrg()
    const k = "invoicing:isolation-test"
    const v1 = await withPrivilegedDb(orgA, "b5-iso-a", (tx) =>
      allocateSequence(tx as unknown as RlsClient, {
        orgId: orgA,
        callingAppId: "invoicing",
        key: k,
      }),
    )
    const v2 = await withPrivilegedDb(orgB, "b5-iso-b", (tx) =>
      allocateSequence(tx as unknown as RlsClient, {
        orgId: orgB,
        callingAppId: "invoicing",
        key: k,
      }),
    )
    expect(v1.value).toBe(1)
    expect(v2.value).toBe(1)
  })

  test("key namespace enforced — key must start with callingAppId + ':'", async () => {
    const { id: orgId } = await createTestOrg()
    await expect(
      withPrivilegedDb(orgId, "b5-namespace", (tx) =>
        allocateSequence(tx as unknown as RlsClient, {
          orgId,
          callingAppId: "invoicing",
          key: "mail:x",
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" })
  })

  test("rolls back on tx rollback — next allocation still returns 1", async () => {
    const { id: orgId } = await createTestOrg()
    const k = "invoicing:doc_number:rollback_test:invoice:2026"
    await withPrivilegedDb(orgId, "b5-rollback", async (tx) => {
      const v = await allocateSequence(tx as unknown as RlsClient, {
        orgId,
        callingAppId: "invoicing",
        key: k,
      })
      expect(v.value).toBe(1)
      throw new Error("rollback")
    }).catch(() => {})
    const after = await withPrivilegedDb(orgId, "b5-after-rollback", (tx) =>
      allocateSequence(tx as unknown as RlsClient, {
        orgId,
        callingAppId: "invoicing",
        key: k,
      }),
    )
    expect(after.value).toBe(1)
  })

  // B14 — the production code path runs ctx.sequences.allocate() inside the
  // tool-handler's RLS transaction (SET LOCAL ROLE liaison_rls), NOT
  // withPrivilegedDb. Before WS-3, app_sequences had REVOKE ALL FROM liaison_rls
  // and no policy, so this path failed with "permission denied" and K3 document
  // numbering was unreachable for every bundled app. These tests drive the real
  // role boundary so the grant + org-scoped policy are actually exercised.
  describe("under withRlsContext (real liaison_rls role boundary)", () => {
    function rlsCtx(orgId: string, userId: string) {
      return {
        actorType: "user" as const,
        userId,
        orgId,
        scopes: ["*"],
        dimensionGrants: {},
      }
    }

    test("allocates monotonically under liaison_rls (not permission-denied)", async () => {
      const { id: orgId } = await createTestOrg()
      // The org-scoped allocator policy keys on org_id only; the RLS context
      // user need not be a real kernel.users row (it is just a GUC value).
      const userId = crypto.randomUUID()
      const k = "invoicing:doc_number:rls_role:invoice:2026"
      const values: number[] = []
      for (let i = 0; i < 3; i++) {
        const r = await withRlsContext(rlsCtx(orgId, userId), (tx) =>
          allocateSequence(tx, { orgId, callingAppId: "invoicing", key: k }),
        )
        values.push(r.value)
      }
      expect(values).toEqual([1, 2, 3])
    })

    test("org-scoped policy isolates counters across orgs under liaison_rls", async () => {
      // Two coexisting orgs (createTestOrg truncates; the new FK rejects orphans).
      const orgA = await insertBareOrg()
      const orgB = await insertBareOrg()
      const userAId = crypto.randomUUID()
      const userBId = crypto.randomUUID()
      const k = "invoicing:rls-isolation"
      const a = await withRlsContext(rlsCtx(orgA, userAId), (tx) =>
        allocateSequence(tx, { orgId: orgA, callingAppId: "invoicing", key: k }),
      )
      const b = await withRlsContext(rlsCtx(orgB, userBId), (tx) =>
        allocateSequence(tx, { orgId: orgB, callingAppId: "invoicing", key: k }),
      )
      expect(a.value).toBe(1)
      expect(b.value).toBe(1)
    })

    test("WITH CHECK rejects allocating into a different org than the RLS context", async () => {
      // Two coexisting orgs so the FK passes and the WITH CHECK is what rejects.
      const orgA = await insertBareOrg()
      const orgB = await insertBareOrg()
      const userAId = crypto.randomUUID()
      // RLS context is orgA, but the allocator tries to write a row for orgB.
      // The org-scoped WITH CHECK must reject it (RLS violation), proving the
      // policy — not just the grant — is enforced.
      await expect(
        withRlsContext(rlsCtx(orgA, userAId), (tx) =>
          allocateSequence(tx, {
            orgId: orgB,
            callingAppId: "invoicing",
            key: "invoicing:cross-org",
          }),
        ),
      ).rejects.toThrow()
    })
  })

  test("two concurrent transactions on the same key serialize via advisory lock and produce {1,2}", async () => {
    const { id: orgId } = await createTestOrg()
    const k = "invoicing:doc_number:concurrent:invoice:2026"
    const [a, b] = await Promise.all([
      withPrivilegedDb(orgId, "b5-conc-a", (tx) =>
        allocateSequence(tx as unknown as RlsClient, {
          orgId,
          callingAppId: "invoicing",
          key: k,
        }),
      ),
      withPrivilegedDb(orgId, "b5-conc-b", (tx) =>
        allocateSequence(tx as unknown as RlsClient, {
          orgId,
          callingAppId: "invoicing",
          key: k,
        }),
      ),
    ])
    expect([a.value, b.value].sort()).toEqual([1, 2])
  })
})
