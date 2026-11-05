// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * T3 — worked example of the real-boundary test helper.
 *
 * Demonstrates the discipline the helper exists to enforce: seed with a
 * privileged connection, then ASSERT through `withRlsBoundaryAs` (the real
 * `liaison_rls` role), never `withPrivilegedDb`. A cross-org leak that would
 * ship green under a privileged-connection assertion is caught here because the
 * query runs under the role with the user's REAL persisted permissions.
 *
 * This is illustrative scaffolding for the pattern — it is NOT a rewrite of any
 * existing test (per the WS-0 scope).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withRlsBoundaryAs } from "~/tests/helpers/rls-boundary"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { seedTwoOrgsWithIsolatedData } from "~/tests/security/seeds"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("T3 example — assert through the real liaison_rls boundary", () => {
  it("userA sees their org's thread; userB (other org) sees zero — under RLS", async () => {
    const fx = await seedTwoOrgsWithIsolatedData()
    const threadId = fx.orgA.secretThreadId

    // Owner, in-org, with their REAL persisted permissions → row visible.
    const ownerRows = await withRlsBoundaryAs(fx.userA.id, fx.orgA.id, (tx) =>
      tx.execute(drizzleSql`SELECT id FROM kernel.threads WHERE id = ${threadId}::uuid`),
    )
    expect(ownerRows).toHaveLength(1)

    // Different org, real permissions → RLS returns zero rows. (A privileged
    // connection would return the row here, masking the isolation bug — the
    // exact T3 failure mode this helper prevents.)
    const otherOrgRows = await withRlsBoundaryAs(fx.userB.id, fx.orgB.id, (tx) =>
      tx.execute(drizzleSql`SELECT id FROM kernel.threads WHERE id = ${threadId}::uuid`),
    )
    expect(otherOrgRows).toHaveLength(0)
  })
})
