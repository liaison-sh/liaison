// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-S T2b (A18, A50/F6): a node job's taint is kept PER JOB, keyed by the
// MCP connection the job's Liaison tools run on, for the job's whole life,
// and bounded like localReplyScope (the conservative floor always in, every
// unreadable input falls back to the ceiling).
//
//   1. a scoped read on the job's connection taints the job, and the result
//      is tagged with it;
//   2. the job keeps it past the agent's 15 minute sliding window;
//   3. a read on ANOTHER connection of the same agent (another conversation)
//      does not tag this job's result;
//   4. an unreadable job taint falls back to the agent's ceiling;
//   5. the connection a job binds must be the owner's, bound to the job's
//      agent, not revoked;
//   6. two runs of one agent live on one connection at once (P3 caps): each
//      ends tagged with at least what was read while it was bound (fail
//      closed: over-tag, never under-tag), and a released run stops
//      collecting.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { nodeJobs, nodes } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  mcpTurnTaintKey,
  mcpTurnTaintLedgerKey,
  mcpTurnTaintMarksKey,
  mcpTurnTaintTouchedKey,
} from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"
import { nodeJobReplyScope } from "./job-taint"
import { nodeJobTaintKey } from "./job-taint-store"
import { bindNodeJobConnection, type NodeJobRow, releaseJobConnection } from "./jobs"

const KPI_READ = "kpi:metrics:read"
// The marks a kpi app's manifest declares for its read tools (the app is not
// bundled with this repository).
const KPI_MANIFEST: { tools: Record<string, { requiredScopes: string[]; readOnly?: boolean }> } = {
  tools: {
    kpi_list_hubs: { requiredScopes: [KPI_READ], readOnly: true },
    kpi_run: { requiredScopes: [KPI_READ], readOnly: true },
  },
}

function registerKpi(orgId: string) {
  for (const name of ["kpi_list_hubs", "kpi_run"]) {
    const m = KPI_MANIFEST.tools[name]!
    toolRegistry.set([orgId, "kpi", name], {
      appName: "kpi",
      name,
      description: name,
      requiredScopes: m.requiredScopes,
      ...(m.readOnly === true ? { readOnly: true } : {}),
      params: z.object({}).passthrough(),
      handler: async () => ({ ok: true }),
    } as never)
  }
}

const CEILING = ["test:items:read", KPI_READ]

describe("node job taint, per job and per connection (P4 T2b)", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) {
      toolRegistry.deleteByPrefix([o])
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${o}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${o}`
      await cleanupSeededOrg(o)
    }
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  async function seed() {
    const s = await seedOrgWithTicketsApp()
    orgs.push(s.orgId)
    registerKpi(s.orgId)
    const { agentId } = await seedAgentForOrg(s.orgId, { scopeCeiling: CEILING })
    const jobConn = await seedMcpConnection({
      orgId: s.orgId,
      userId: s.ownerId,
      clientId: "liaison-node",
      label: "Node job",
      agentId,
    })
    const otherConn = await seedMcpConnection({
      orgId: s.orgId,
      userId: s.ownerId,
      clientId: "claude-code",
      label: "Another session",
      agentId,
    })
    const [node] = await withSystemDb("test", (db) =>
      db
        .insert(nodes)
        .values({
          orgId: s.orgId,
          ownerUserId: s.ownerId,
          deviceId: `d.${crypto.randomUUID()}`,
          name: "Mac",
        })
        .returning(),
    )
    const insertJob = async () => {
      const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, prompt,
                                    status, node_id, lease_holder, lease_generation,
                                    lease_expires_at, claimed_at, started_at)
      VALUES (${s.orgId}, ${s.ownerId}, ${agentId}, ${s.threadId}, 'chat', 'p', 'running',
              ${node.id}, ${node.id}, 1, now() + interval '2 minutes', now(), now())
      RETURNING id`
      return row
    }
    const jobRow = await insertJob()
    const ctx = (connectionId: string): ToolCallCtx => ({
      orgId: s.orgId,
      actor: userContextFor(s.orgId, s.ownerId, [...s.scopes, KPI_READ]),
      connectionId,
      ownerUserId: s.ownerId,
      agentId,
      connectionThreadId: null,
      discovered: new Set(),
    })
    const job = async (id: string = jobRow.id): Promise<NodeJobRow> => {
      const [row] = await withSystemDb("test", (db) =>
        db.select().from(nodeJobs).where(eq(nodeJobs.id, id)),
      )
      return row
    }
    const clearAgentWindow = async () => {
      await redis.del(
        mcpTurnTaintKey(s.orgId, agentId),
        mcpTurnTaintMarksKey(s.orgId, agentId),
        mcpTurnTaintTouchedKey(s.orgId, agentId),
      )
    }
    return {
      s,
      agentId,
      node,
      jobId: jobRow.id,
      jobConn,
      otherConn,
      ctx,
      job,
      clearAgentWindow,
      insertJob,
    }
  }

  it("a scoped read on the job's connection taints the job, and the result is tagged with it", async () => {
    const t = await seed()
    await t.clearAgentWindow()
    expect(await bindNodeJobConnection(t.node, t.jobId, t.jobConn.id)).toBe("bound")
    const r = await handleToolCall(t.ctx(t.jobConn.id), "kpi__kpi_list_hubs", {})
    expect(r.isError).toBeFalsy()
    expect(await redis.smembers(nodeJobTaintKey(t.jobId))).toContain(KPI_READ)
    expect(await nodeJobReplyScope(await t.job(), CEILING)).toContain(KPI_READ)
    // The day-long ledger a long LOCAL turn's tag reads past the window has it too.
    expect(await redis.hkeys(mcpTurnTaintLedgerKey(t.s.orgId, t.agentId))).toContain(KPI_READ)
  }, 30_000)

  it("keeps the job's taint past the agent's 15 minute window", async () => {
    const t = await seed()
    await t.clearAgentWindow()
    await bindNodeJobConnection(t.node, t.jobId, t.jobConn.id)
    await handleToolCall(t.ctx(t.jobConn.id), "kpi__kpi_list_hubs", {})
    // The agent's sliding window has run out (the job ran for an hour).
    await t.clearAgentWindow()
    expect(await nodeJobReplyScope(await t.job(), CEILING)).toContain(KPI_READ)
  }, 30_000)

  it("a read on another connection of the same agent does not tag this job's result", async () => {
    const t = await seed()
    await t.clearAgentWindow()
    await bindNodeJobConnection(t.node, t.jobId, t.jobConn.id)
    // The job's own call reads nothing scoped by KPI; another session of the
    // same agent reads KPI figures while the job runs.
    await handleToolCall(t.ctx(t.otherConn.id), "kpi__kpi_list_hubs", {})
    expect(await redis.smembers(nodeJobTaintKey(t.jobId))).not.toContain(KPI_READ)
    expect(await nodeJobReplyScope(await t.job(), CEILING)).not.toContain(KPI_READ)
  }, 30_000)

  it("an unreadable job taint falls back to the agent's ceiling", async () => {
    const t = await seed()
    await t.clearAgentWindow()
    await bindNodeJobConnection(t.node, t.jobId, t.jobConn.id)
    // Not a set: the read fails, and the tag must not get shorter for it.
    await redis.del(nodeJobTaintKey(t.jobId))
    await redis.set(nodeJobTaintKey(t.jobId), "garbage")
    const scopes = await nodeJobReplyScope(await t.job(), CEILING)
    for (const s of CEILING) expect(scopes).toContain(s)
    // The unknown-taint marker is a marker, never stored as a scope.
    await redis.del(nodeJobTaintKey(t.jobId))
    await redis.sadd(nodeJobTaintKey(t.jobId), "scope_taint:unknown")
    const marked = await nodeJobReplyScope(await t.job(), CEILING)
    for (const s of CEILING) expect(marked).toContain(s)
    expect(marked).not.toContain("scope_taint:unknown")
  }, 30_000)

  it("binds only the owner's connection for the job's agent, not revoked", async () => {
    const t = await seed()
    const { agentId: otherAgent } = await seedAgentForOrg(t.s.orgId, { scopeCeiling: CEILING })
    const wrongAgent = await seedMcpConnection({
      orgId: t.s.orgId,
      userId: t.s.ownerId,
      clientId: "x",
      label: "x",
      agentId: otherAgent,
    })
    expect(await bindNodeJobConnection(t.node, t.jobId, wrongAgent.id)).toBe("bad_connection")
    const unbound = await seedMcpConnection({
      orgId: t.s.orgId,
      userId: t.s.ownerId,
      clientId: "y",
      label: "y",
    })
    expect(await bindNodeJobConnection(t.node, t.jobId, unbound.id)).toBe("bad_connection")
    await sql`UPDATE kernel.mcp_connections SET revoked_at = now() WHERE id = ${t.otherConn.id}`
    expect(await bindNodeJobConnection(t.node, t.jobId, t.otherConn.id)).toBe("bad_connection")
    expect(await bindNodeJobConnection(t.node, t.jobId, crypto.randomUUID())).toBe("bad_connection")
    expect(await bindNodeJobConnection(t.node, t.jobId, t.jobConn.id)).toBe("bound")
    const [row] = await sql<{ mcp_connection_id: string }[]>`
      SELECT mcp_connection_id FROM kernel.node_jobs WHERE id = ${t.jobId}`
    expect(row.mcp_connection_id).toBe(t.jobConn.id)
  }, 30_000)

  it("two concurrent runs of one agent on one connection each end tagged with what they read", async () => {
    const t = await seed()
    await t.clearAgentWindow()
    const b = await t.insertJob()
    // Run A binds, then run B of the same agent binds the same connection.
    expect(await bindNodeJobConnection(t.node, t.jobId, t.jobConn.id)).toBe("bound")
    expect(await bindNodeJobConnection(t.node, b.id, t.jobConn.id)).toBe("bound")
    // A scoped read on the shared connection: it may be either run's, so
    // both carry it.
    await handleToolCall(t.ctx(t.jobConn.id), "kpi__kpi_list_hubs", {})
    expect(await redis.smembers(nodeJobTaintKey(t.jobId))).toContain(KPI_READ)
    expect(await redis.smembers(nodeJobTaintKey(b.id))).toContain(KPI_READ)
    await t.clearAgentWindow()
    expect(await nodeJobReplyScope(await t.job(), CEILING)).toContain(KPI_READ)
    expect(await nodeJobReplyScope(await t.job(b.id), CEILING)).toContain(KPI_READ)

    // Run B ends: a read after that lands on A only.
    await releaseJobConnection(await t.job(b.id))
    await redis.del(nodeJobTaintKey(b.id))
    await redis.sadd(nodeJobTaintKey(b.id), "__bound__")
    await redis.del(nodeJobTaintKey(t.jobId))
    await redis.sadd(nodeJobTaintKey(t.jobId), "__bound__")
    await handleToolCall(t.ctx(t.jobConn.id), "kpi__kpi_run", {})
    expect(await redis.smembers(nodeJobTaintKey(t.jobId))).toContain(KPI_READ)
    expect(await redis.smembers(nodeJobTaintKey(b.id))).not.toContain(KPI_READ)
  }, 30_000)
})
