// SPDX-License-Identifier: FSL-1.1-ALv2
// P12-M6: the connection-thread single-thread guarantee under a self-race
// (spec C8 boundary) had no test. ensureConnectionThread's guarded
// `UPDATE ... WHERE thread_id IS NULL` claim + loser re-read must yield ONE
// shared thread id no matter how many concurrent first-gated-calls race.

import { afterEach, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/kernel"
import { ensureConnectionThread } from "~/modules/mcp/connection-thread"
import { cleanupSeededOrg, seedMcpConnection, seedOrgWithUser } from "~/modules/mcp/test-helpers"

describe("ensureConnectionThread (spec C8)", () => {
  const orgs: string[] = []
  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  it("concurrent first-gated calls converge on exactly one thread id", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({ orgId, userId, clientId: "c", label: "L" })

    const ids = await Promise.all(
      Array.from({ length: 6 }, () => ensureConnectionThread(conn.id, orgId, userId)),
    )
    // Every racer returns the SAME thread id.
    expect(new Set(ids).size).toBe(1)
    // And it is the id persisted on the connection row.
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, conn.id)),
    )
    expect(row.threadId).toBe(ids[0])
  })

  it("is idempotent — a later call returns the same thread id", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({ orgId, userId, clientId: "c", label: "L" })
    const first = await ensureConnectionThread(conn.id, orgId, userId)
    const second = await ensureConnectionThread(conn.id, orgId, userId)
    expect(second).toBe(first)
  })
})
