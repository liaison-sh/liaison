// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  agentMemory,
  agentThreadCheckpoints,
  creditBalances,
  modelPricing,
  systemConfig,
} from "~/db/schema/kernel"

const ORG_ID = "00000000-0000-0000-0000-b00000000001"
const USER_A = "00000000-0000-0000-0000-b00000000002"
const USER_B = "00000000-0000-0000-0000-b00000000003"
const AGENT_A = "00000000-0000-0000-0000-b00000000004"
const AGENT_B = "00000000-0000-0000-0000-b00000000005"

function rlsCtx(userId: string, orgId: string = ORG_ID): UserContext {
  return { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'RLS Test Org', 'rls-test') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_A}, ${ORG_ID}, 'usera@test.com', 'User A', 'active', 1) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_B}, ${ORG_ID}, 'userb@test.com', 'User B', 'active', 1) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id) VALUES (${AGENT_A}, ${ORG_ID}, 'personal', '@rls-a', 'Liaison', ${USER_A}) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id) VALUES (${AGENT_B}, ${ORG_ID}, 'personal', '@rls-b', 'Liaison', ${USER_B}) ON CONFLICT DO NOTHING`

  // Seed credit_balances via privileged
  await withPrivilegedDb(ORG_ID, "test-seed", async (tx) => {
    await tx
      .insert(creditBalances)
      .values({
        orgId: ORG_ID,
        includedBalance: "100.00000000",
        purchasedBalance: "50.00000000",
        currency: "EUR",
      })
      .onConflictDoNothing()
  })

  // Seed model_pricing via system
  await withSystemDb("test-seed", async (tx) => {
    await tx
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "test-model",
        displayName: "Test Model",
        inputCostPerM: "1.00000000",
        outputCostPerM: "2.00000000",
        contextWindow: 100000,
      })
      .onConflictDoNothing()
  })

  // Seed system_config
  await sql`INSERT INTO kernel.system_config (key, value) VALUES ('test_key', '"test_value"'::jsonb) ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'test-model'`
  await sql`DELETE FROM kernel.system_config WHERE key = 'test_key'`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("agent tables RLS enforcement", () => {
  it("liaison_rls can SELECT credit_balances for own org", async () => {
    const result = await withRlsContext(rlsCtx(USER_A), async (tx) =>
      tx.select().from(creditBalances).where(eq(creditBalances.orgId, ORG_ID)),
    )
    expect(result.length).toBe(1)
    expect(result[0].includedBalance).toBe("100.00000000")
  })

  it("liaison_rls CANNOT UPDATE credit_balances", async () => {
    try {
      await withRlsContext(rlsCtx(USER_A), async (tx) =>
        tx
          .update(creditBalances)
          .set({ includedBalance: "999.00000000" })
          .where(eq(creditBalances.orgId, ORG_ID)),
      )
    } catch {
      // Clean migrations revoke UPDATE; older test databases may rely on RLS
      // filtering instead, which resolves after updating zero rows.
    }

    const [balance] =
      await sql`SELECT included_balance FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
    expect(balance.included_balance).toBe("100.00000000")
  })

  it("liaison_rls can SELECT model_pricing (global)", async () => {
    const result = await withRlsContext(rlsCtx(USER_A), async (tx) =>
      tx.select().from(modelPricing).where(eq(modelPricing.modelId, "test-model")),
    )
    expect(result.length).toBe(1)
  })

  it("liaison_rls CANNOT INSERT into model_pricing", async () => {
    await expect(
      withRlsContext(rlsCtx(USER_A), async (tx) =>
        tx.insert(modelPricing).values({
          provider: "test",
          modelId: "hacked",
          displayName: "H",
          inputCostPerM: "0",
          outputCostPerM: "0",
          contextWindow: 1,
        }),
      ),
    ).rejects.toThrow()
  })

  it("liaison_rls can SELECT system_config (global)", async () => {
    const result = await withRlsContext(rlsCtx(USER_A), async (tx) =>
      tx.select().from(systemConfig).where(eq(systemConfig.key, "test_key")),
    )
    expect(result.length).toBe(1)
  })

  it("liaison_rls CANNOT INSERT into system_config", async () => {
    await expect(
      withRlsContext(rlsCtx(USER_A), async (tx) =>
        tx.insert(systemConfig).values({ key: "hacked", value: "x" }),
      ),
    ).rejects.toThrow()
  })

  it("user A can INSERT agent_memory for themselves", async () => {
    // owner_agent_id is required for the row to be writable/readable once
    // the agent_memory RLS policies move to owner_agent_id (migration 0056);
    // AGENT_A is USER_A's personal agent, seeded in beforeAll.
    await withRlsContext(rlsCtx(USER_A), async (tx) => {
      await tx.insert(agentMemory).values({
        orgId: ORG_ID,
        userId: USER_A,
        ownerAgentId: AGENT_A,
        type: "user",
        name: "tone",
        description: "formal",
        content: "formal",
        requiredScopes: [],
      })
    })
    const rows = await sql`SELECT * FROM kernel.agent_memory WHERE user_id = ${USER_A}`
    expect(rows.length).toBe(1)
  })

  it("user A CANNOT SELECT user B's agent_memory", async () => {
    // Seeded with ownerAgentId = AGENT_B (user B's OWN personal agent), not
    // left null. A null-owner row is invisible to EVERYONE under 0056's
    // owner_agent_id-only EXISTS check, so this case would have passed for
    // the wrong reason: it proved the blind spot, not cross-user isolation.
    // Routing the row through the personal-agent branch is what actually
    // exercises the isolation this test claims to assert.
    await withPrivilegedDb(ORG_ID, "test-seed", async (tx) => {
      await tx
        .insert(agentMemory)
        .values({
          orgId: ORG_ID,
          userId: USER_B,
          ownerAgentId: AGENT_B,
          type: "user",
          name: "tone",
          description: "casual",
          content: "casual",
          requiredScopes: [],
        })
        .onConflictDoNothing()
    })

    const result = await withRlsContext(rlsCtx(USER_A), async (tx) =>
      tx.select().from(agentMemory).where(eq(agentMemory.userId, USER_B)),
    )
    expect(result.length).toBe(0)
  })

  it("agent_memory rejects duplicate (org_id, owner_agent_id, type, name)", async () => {
    await withPrivilegedDb(ORG_ID, "test-dup-seed", async (tx) => {
      await tx.insert(agentMemory).values({
        orgId: ORG_ID,
        ownerAgentId: AGENT_A,
        userId: USER_A,
        type: "user",
        name: "dup-tone",
        description: "first",
        content: "first",
        requiredScopes: [],
      })
    })

    await expect(
      withPrivilegedDb(ORG_ID, "test-dup", async (tx) => {
        await tx.insert(agentMemory).values({
          orgId: ORG_ID,
          ownerAgentId: AGENT_A,
          userId: USER_A,
          type: "user",
          name: "dup-tone",
          description: "duplicate",
          content: "duplicate",
          requiredScopes: [],
        })
      }),
    ).rejects.toThrow()
  })
})

// P4m-T04: the memory tree's columns on kernel.agent_memory. The cases below
// are appended, never edited into the block above: the new columns must widen
// nothing in the 0056 or 0057 policies, and the type vocabulary gains exactly
// one member.
describe("P4m agent_memory tree columns", () => {
  const THREAD_ID = "00000000-0000-0000-0000-b0000000000a"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'rls-mem-tree', 'thread', ${USER_A})
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID} AND type IN ('episode','project')`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD_ID}`
  })

  it("a memory row of type episode is accepted by the type check", async () => {
    await withRlsContext(rlsCtx(USER_A), async (tx) => {
      await tx.insert(agentMemory).values({
        orgId: ORG_ID,
        userId: USER_A,
        ownerAgentId: AGENT_A,
        type: "episode",
        name: "ep-2026-09-13",
        description: "a closed conversation",
        content: "body",
        requiredScopes: [],
      })
    })
    const rows =
      await sql`SELECT id FROM kernel.agent_memory WHERE org_id = ${ORG_ID} AND type = 'episode'`
    expect(rows.length).toBe(1)
  })

  it("another user cannot select a memory row carrying the new provenance columns", async () => {
    await withPrivilegedDb(ORG_ID, "test-seed", async (tx) => {
      await tx.insert(agentMemory).values({
        orgId: ORG_ID,
        userId: USER_A,
        ownerAgentId: AGENT_A,
        type: "project",
        name: "prov-row",
        description: "provenance",
        content: "body",
        requiredScopes: [],
        sourceThreadId: THREAD_ID,
        sourceKind: "consolidation",
      })
    })
    const result = await withRlsContext(rlsCtx(USER_B), async (tx) =>
      tx.select().from(agentMemory).where(eq(agentMemory.name, "prov-row")),
    )
    expect(result.length).toBe(0)
  })

  it("source_kind rejects an unknown value", async () => {
    await expect(
      (async () =>
        await sql`INSERT INTO kernel.agent_memory
          (org_id, owner_agent_id, type, name, description, content, required_scopes, source_kind)
          VALUES (${ORG_ID}, ${AGENT_A}, 'project', 'bad-kind', 'd', 'c', '{}', 'robot')`)(),
    ).rejects.toThrow(/check constraint/i)
  })
})

// P4m-T05: kernel.agent_thread_checkpoints. A checkpoint is one agent's view of
// one thread, so the cases below pin per-agent isolation, version immutability
// and the stale_at carve out that P4m-T23 and P4m-T26 depend on.
describe("P4m agent_thread_checkpoints", () => {
  const THREAD_ID = "00000000-0000-0000-0000-b0000000000b"
  const ROLE_AGENT = "00000000-0000-0000-0000-b0000000000c"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, 'rls-checkpoints', 'thread', ${USER_A})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${ROLE_AGENT}, ${ORG_ID}, 'role', '@rls-role', 'Logistics')
      ON CONFLICT DO NOTHING`
    // 0084: a checkpoint is content of its thread, so reading one needs the
    // room as well as the scopes. USER_A created this thread and is in it, the
    // shape every real checkpoint is written under.
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
      VALUES (${THREAD_ID}, ${USER_A}, ${ORG_ID}, 'user') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.threads WHERE id = ${THREAD_ID}`
    await sql`DELETE FROM kernel.agents WHERE id = ${ROLE_AGENT}`
  })

  async function seedCheckpoint(
    agentId: string,
    version: number,
    summary: string,
    requiredScopes: string[] = [],
  ): Promise<void> {
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
      VALUES (${ORG_ID}, ${agentId}, ${THREAD_ID}, NULL, ${summary},
              ${sql.array(requiredScopes)}, 100, ${version})`
  }

  it("an agent can select only its own thread checkpoints", async () => {
    await seedCheckpoint(AGENT_A, 1, "agent A view")
    await seedCheckpoint(AGENT_B, 1, "agent B view")
    const rows = await withRlsContext(rlsCtx(USER_A), async (tx) =>
      tx.select().from(agentThreadCheckpoints).where(eq(agentThreadCheckpoints.orgId, ORG_ID)),
    )
    expect(rows.length).toBe(1)
    expect(rows[0].summary).toBe("agent A view")
  })

  it("a second version of the same agent and thread is accepted and a duplicate version is rejected", async () => {
    await seedCheckpoint(AGENT_A, 2, "agent A, later")
    await expect((async () => await seedCheckpoint(AGENT_A, 1, "duplicate"))()).rejects.toThrow(
      /duplicate key/i,
    )
  })

  it("updating a written checkpoint summary or version or required scopes is refused", async () => {
    await seedCheckpoint(ROLE_AGENT, 1, "role view", ["kernel:threads:read"])
    const guarded = [
      sql`UPDATE kernel.agent_thread_checkpoints SET summary = 'rewritten'
            WHERE agent_id = ${ROLE_AGENT} AND version = 1`,
      sql`UPDATE kernel.agent_thread_checkpoints SET version = 9
            WHERE agent_id = ${ROLE_AGENT} AND version = 1`,
      sql`UPDATE kernel.agent_thread_checkpoints SET required_scopes = '{}'
            WHERE agent_id = ${ROLE_AGENT} AND version = 1`,
      sql`UPDATE kernel.agent_thread_checkpoints SET upto_message_id = gen_random_uuid()
            WHERE agent_id = ${ROLE_AGENT} AND version = 1`,
    ]
    let refused = 0
    for (const stmt of guarded) {
      try {
        await stmt
      } catch {
        refused += 1
      }
    }
    expect(refused).toBe(4)
  })

  it("updating stale_at on a written checkpoint is allowed in both directions", async () => {
    await seedCheckpoint(AGENT_B, 2, "agent B, later")
    await sql`UPDATE kernel.agent_thread_checkpoints SET stale_at = now()
                WHERE agent_id = ${AGENT_B} AND version = 2`
    await sql`UPDATE kernel.agent_thread_checkpoints SET stale_at = NULL
                WHERE agent_id = ${AGENT_B} AND version = 2`
    const [row] = await sql<{ summary: string; stale_at: Date | null }[]>`
      SELECT summary, stale_at FROM kernel.agent_thread_checkpoints
       WHERE agent_id = ${AGENT_B} AND version = 2`
    expect(row.stale_at).toBeNull()
    expect(row.summary).toBe("agent B, later")
  })

  it("a role agent checkpoint is hidden from a caller missing one of its required scopes", async () => {
    await seedCheckpoint(ROLE_AGENT, 2, "role view, scoped", [
      "kernel:threads:read",
      "kernel:agents:admin",
    ])
    const subset: UserContext = {
      actorType: "user",
      userId: USER_A,
      orgId: ORG_ID,
      scopes: ["kernel:threads:read"],
      dimensionGrants: {},
    }
    const rows = await withRlsContext(subset, async (tx) =>
      tx
        .select()
        .from(agentThreadCheckpoints)
        .where(
          and(
            eq(agentThreadCheckpoints.agentId, ROLE_AGENT),
            eq(agentThreadCheckpoints.version, 2),
          ),
        ),
    )
    expect(rows.length).toBe(0)
  })
})
