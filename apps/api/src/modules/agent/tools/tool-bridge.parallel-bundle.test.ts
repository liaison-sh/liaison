// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { approvalSummarizerRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000bd0001"
const USER_ID = "00000000-0000-0000-0000-000000bd0002"
const THREAD_ID = "00000000-0000-0000-0000-000000bd0003"

async function seed(): Promise<void> {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ParallelOrg', 'parallel-bundle-org') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'parallel@test.com', 'Parallel User') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'parallel-bundle-thread', 'agent_chat', ${USER_ID}) ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
}

async function clearApprovals(): Promise<void> {
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
}

function registerGatedTools(): void {
  for (const name of ["actionA", "actionB"] as const) {
    toolRegistry.set([ORG_ID, "test", name], {
      appName: "test",
      name,
      description: `gated ${name}`,
      requiredScopes: ["test:write"],
      gated: true,
      handler: async () => ({ ok: true }),
      params: z.object({}),
    } as any)
    approvalSummarizerRegistry.set([ORG_ID, "test", name], async () => ({
      kind: "test",
      title: `gated ${name}`,
      lines: [],
    }))
  }
}

describe("parallel approval bundling via buildToolSet", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await seed()
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    await releaseTestLock()
  })

  afterEach(async () => {
    delete process.env.PARALLEL_APPROVAL_BUNDLING
    await clearApprovals()
    toolRegistry.deleteByPrefix([ORG_ID])
  })

  test("with flag on, two parallel gated calls in one step share a bundle", async () => {
    process.env.PARALLEL_APPROVAL_BUNDLING = "1"
    registerGatedTools()

    const actor: UserContext = {
      actorType: "user",
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["test:write"],
      dimensionGrants: {},
    }
    const stepCtx = { stepBundleId: null as string | null }
    const tools = buildToolSet(
      ORG_ID,
      actor,
      THREAD_ID,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      undefined,
      stepCtx,
    )

    // Simulate the stream loop's first tool-call chunk: lazy-init the bundle id.
    stepCtx.stepBundleId = crypto.randomUUID()
    // Two parallel executions in one step.
    const [r1, r2] = await Promise.all([
      (tools.test__actionA as any).execute({}, {}),
      (tools.test__actionB as any).execute({}, {}),
    ])
    // Both blocked (gated).
    expect((r1 as any).blocked).toBe(true)
    expect((r2 as any).blocked).toBe(true)

    const rows = await withPrivilegedDb(ORG_ID, "t", async (tx) =>
      extractRows<{
        bundle_id: string
        bundle_position: number
        depends_on_id: string | null
        tool_name: string
      }>(
        await tx.execute(
          drizzleSql`SELECT bundle_id, bundle_position, depends_on_id, tool_name FROM kernel.approval_requests WHERE org_id = ${ORG_ID} ORDER BY bundle_position`,
        ),
      ),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].bundle_id).toBe(rows[1].bundle_id)
    expect(rows[0].bundle_id).not.toBeNull()
    expect(rows[0].bundle_position).toBe(0)
    expect(rows[1].bundle_position).toBe(1)
    expect(rows[0].depends_on_id).toBeNull()
    expect(rows[1].depends_on_id).toBeNull()
  })

  test("with flag off, two parallel gated calls stay standalone", async () => {
    // PARALLEL_APPROVAL_BUNDLING intentionally unset.
    registerGatedTools()

    const actor: UserContext = {
      actorType: "user",
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["test:write"],
      dimensionGrants: {},
    }
    // Stream loop wouldn't allocate stepBundleId when flag is off.
    const stepCtx = { stepBundleId: null as string | null }
    const tools = buildToolSet(
      ORG_ID,
      actor,
      THREAD_ID,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      undefined,
      stepCtx,
    )

    await Promise.all([
      (tools.test__actionA as any).execute({}, {}),
      (tools.test__actionB as any).execute({}, {}),
    ])

    const rows = await withPrivilegedDb(ORG_ID, "t", async (tx) =>
      extractRows<{ bundle_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT bundle_id FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`,
        ),
      ),
    )

    expect(rows).toHaveLength(2)
    expect(rows[0].bundle_id).toBeNull()
    expect(rows[1].bundle_id).toBeNull()
  })
})
