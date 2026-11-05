// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  createApprovalRequestInBundle,
  createSequencedApprovalStep,
} from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-0000000bc001"
const USER_ID = "00000000-0000-0000-0000-0000000bc002"
const THREAD_ID = "00000000-0000-0000-0000-0000000bc003"

async function seed(): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'BundleOrg', 'bundle-org') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'bundle@test.com', 'Bundle User') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'bundle-thread', 'agent_chat', ${USER_ID}) ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
}

async function clearApprovals(): Promise<void> {
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
}

const baseArgs = {
  orgId: ORG_ID,
  threadId: THREAD_ID,
  toolName: "test:tool",
  requestedBy: USER_ID,
  appName: "test",
  toolShortName: "tool",
  requesterCanApprove: true,
  origin: "in-app-agent" as const,
}

describe("createApprovalRequestInBundle", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await seed()
  })

  afterAll(async () => {
    await clearApprovals()
    await releaseTestLock()
  })

  test("first call in bundle gets position 0", async () => {
    await clearApprovals()
    const bundleId = crypto.randomUUID()
    const id = await createApprovalRequestInBundle({
      ...baseArgs,
      toolParams: { x: 1 },
      summary: { kind: "test", title: "t", lines: [] },
      stepBundleId: bundleId,
    })
    const rows = await withPrivilegedDb(ORG_ID, "t", async (tx) =>
      extractRows<{ bundle_id: string; bundle_position: number; depends_on_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT bundle_id, bundle_position, depends_on_id FROM kernel.approval_requests WHERE id = ${id}`,
        ),
      ),
    )
    expect(rows[0].bundle_id).toBe(bundleId)
    expect(rows[0].bundle_position).toBe(0)
    expect(rows[0].depends_on_id).toBeNull()
  })

  test("second call in same bundle gets position 1, no dependsOn", async () => {
    await clearApprovals()
    const bundleId = crypto.randomUUID()
    const first = await createApprovalRequestInBundle({
      ...baseArgs,
      toolParams: {},
      summary: { kind: "test", title: "t1", lines: [] },
      stepBundleId: bundleId,
    })
    const second = await createApprovalRequestInBundle({
      ...baseArgs,
      toolParams: {},
      summary: { kind: "test", title: "t2", lines: [] },
      stepBundleId: bundleId,
    })
    const rows = await withPrivilegedDb(ORG_ID, "t", async (tx) =>
      extractRows<{ id: string; bundle_position: number; depends_on_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT id, bundle_position, depends_on_id FROM kernel.approval_requests WHERE bundle_id = ${bundleId} ORDER BY bundle_position`,
        ),
      ),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].id).toBe(first)
    expect(rows[0].bundle_position).toBe(0)
    expect(rows[1].id).toBe(second)
    expect(rows[1].bundle_position).toBe(1)
    expect(rows[0].depends_on_id).toBeNull()
    expect(rows[1].depends_on_id).toBeNull()
  })

  test("no stepBundleId → leaves bundle_id null (today's standalone behavior)", async () => {
    await clearApprovals()
    const id = await createApprovalRequestInBundle({
      ...baseArgs,
      toolParams: {},
      summary: { kind: "test", title: "standalone", lines: [] },
      stepBundleId: null,
    })
    const rows = await withPrivilegedDb(ORG_ID, "t", async (tx) =>
      extractRows<{ bundle_id: string | null; bundle_position: number | null }>(
        await tx.execute(
          drizzleSql`SELECT bundle_id, bundle_position FROM kernel.approval_requests WHERE id = ${id}`,
        ),
      ),
    )
    expect(rows[0].bundle_id).toBeNull()
    expect(rows[0].bundle_position).toBeNull()
  })

  test("concurrent inserts into the same bundle get distinct positions (no race)", async () => {
    await clearApprovals()
    const bundleId = crypto.randomUUID()
    const mk = (title: string) =>
      createApprovalRequestInBundle({
        ...baseArgs,
        toolParams: {},
        summary: { kind: "test", title, lines: [] },
        stepBundleId: bundleId,
      })
    const [a, b] = await Promise.all([mk("a"), mk("b")])
    expect(a).not.toBe(b)
    const rows = await withPrivilegedDb(ORG_ID, "t", async (tx) =>
      extractRows<{ id: string; bundle_position: number }>(
        await tx.execute(
          drizzleSql`SELECT id, bundle_position FROM kernel.approval_requests WHERE bundle_id = ${bundleId} ORDER BY bundle_position`,
        ),
      ),
    )
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.bundle_position).sort()).toEqual([0, 1])
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([a, b]))
  })

  test("multi-source refs in one call → invalid_ref", async () => {
    await clearApprovals()
    const { validateRefSources } = await import("~/modules/apps/execute-tool")
    const stepBundleId = crypto.randomUUID()
    const a = await createApprovalRequestInBundle({
      ...baseArgs,
      toolName: "test:a",
      toolShortName: "a",
      toolParams: {},
      summary: { kind: "test", title: "a", lines: [] },
      stepBundleId: null,
    })
    const b = await createApprovalRequestInBundle({
      ...baseArgs,
      toolName: "test:b",
      toolShortName: "b",
      toolParams: {},
      summary: { kind: "test", title: "b", lines: [] },
      stepBundleId: null,
    })
    // Build refs that point at two different source approvals.
    const refs = [
      { approvalId: a, outputKey: "x", path: "x" },
      { approvalId: b, outputKey: "y", path: "y" },
    ]
    await expect(validateRefSources(ORG_ID, THREAD_ID, USER_ID, refs)).rejects.toThrow(
      /invalid_ref|more than one source/i,
    )
    // Drop the stepBundleId silencer — we only need to import the helper.
    void stepBundleId
  })

  test("sequenced step joins this step's bundle, not source approval's bundle", async () => {
    await clearApprovals()
    const sourceBundleId = crypto.randomUUID()
    const stepBundleId = crypto.randomUUID()
    const sourceId = await createApprovalRequestInBundle({
      ...baseArgs,
      toolName: "test:source",
      toolShortName: "source",
      toolParams: {},
      summary: { kind: "test", title: "source", lines: [] },
      stepBundleId: sourceBundleId,
    })
    const dependentId = await createSequencedApprovalStep({
      orgId: ORG_ID,
      threadId: THREAD_ID,
      toolName: "test:dependent",
      toolParams: { ref: `@ref(${sourceId}.outputs.x)` },
      requestedBy: USER_ID,
      summary: { kind: "test", title: "dep", lines: [] },
      appName: "test",
      toolShortName: "dependent",
      bundle: { bundleId: stepBundleId, dependsOnId: sourceId, position: -1 },
    })
    const rows = await withPrivilegedDb(ORG_ID, "t", async (tx) =>
      extractRows<{ bundle_id: string; depends_on_id: string }>(
        await tx.execute(
          drizzleSql`SELECT bundle_id, depends_on_id FROM kernel.approval_requests WHERE id = ${dependentId}`,
        ),
      ),
    )
    expect(rows[0].bundle_id).toBe(stepBundleId)
    expect(rows[0].bundle_id).not.toBe(sourceBundleId)
    expect(rows[0].depends_on_id).toBe(sourceId)
  })
})
