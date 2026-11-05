// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A GATED CALL PARKED FOR APPROVAL TAINTS NOTHING, AT THE MCP SEAM.
//
// An external client (Claude Code on the Liaison MCP server) stages a compound
// bundle the same way the in-app agent does: call a gated tool, copy the @ref
// token out of the blocked result, pass it to the next gated call. Scope taint
// on writes broke that chain here too: `handleToolCall` recorded the call's
// declared scopes BEFORE invoking the tool and persisted them to the
// connection's 15-minute window, so the first gated call tainted a turn whose
// handler never ran, and the second was refused as a write from a tainted turn
// (`E_SCOPE_TAINT_BLOCKED`) instead of joining the bundle. Worse than in-app:
// the taint outlives the request, so every later call in the window inherited
// it.
//
// Guard 1 is the chain. Guard 2 is the other half: a read that ACTUALLY RAN
// still taints, and the next undeclared write is still refused.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { mcpTurnTaintKey } from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  mutatingTicketTool,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

async function agentBoundCtx(seed: {
  orgId: string
  ownerId: string
  scopes: string[]
}): Promise<{ ctx: ToolCallCtx; agentId: string }> {
  const { agentId } = await seedAgentForOrg(seed.orgId)
  const conn = await seedMcpConnection({
    orgId: seed.orgId,
    userId: seed.ownerId,
    clientId: "claude-code",
    label: "Claude Code",
  })
  return {
    agentId,
    ctx: {
      orgId: seed.orgId,
      actor: userContextFor(seed.orgId, seed.ownerId, seed.scopes),
      connectionId: conn.id,
      ownerUserId: seed.ownerId,
      agentId,
      connectionThreadId: null,
      discovered: new Set(),
    },
  }
}

describe("mcp gated chain under scope taint", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("chains a second gated call into the bundle instead of refusing it as a tainted write", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { ctx, agentId } = await agentBoundCtx(seed)

    const produce = (await handleToolCall(ctx, "test__gatedProduce", { seed: "beta" }))
      .structuredContent as any
    expect(produce.gated).toBe(true)
    expect(produce.executed).toBe(false)
    const token = produce.outputs.value as string
    expect(token).toBe(`@ref:${produce.approvalRequestId}:value`)

    // The regression: this came back isError with E_SCOPE_TAINT_BLOCKED.
    const consumeRes = await handleToolCall(ctx, "test__gatedConsume", {
      note: token,
      label: "reply-label",
    })
    expect((consumeRes.structuredContent as { code?: string }).code).not.toBe(
      "E_SCOPE_TAINT_BLOCKED",
    )
    expect(consumeRes.isError).toBeFalsy()
    const consume = consumeRes.structuredContent as any
    expect(consume.gated).toBe(true)

    // Neither parked call read anything, so neither wrote scopes into the
    // connection's window. A stale non-empty set here taints every later call
    // for the next 15 minutes, across every connection bound to this agent.
    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(seed.orgId, agentId))) ?? "[]")
    expect(persisted).toEqual([])

    const rows = (await sql`
      SELECT id, bundle_id, bundle_position, depends_on_id, status, current_payload
      FROM kernel.approval_requests WHERE org_id = ${seed.orgId}
      ORDER BY bundle_position`) as Array<{
      id: string
      bundle_id: string | null
      bundle_position: number | null
      depends_on_id: string | null
      status: string
      current_payload: { note?: string }
    }>
    expect(rows).toHaveLength(2)
    const head = rows.find((r) => r.id === produce.approvalRequestId)!
    const step = rows.find((r) => r.id === consume.approvalRequestId)!
    expect(head.status).toBe("pending")
    expect(head.bundle_position).toBe(0)
    expect(step.status).toBe("deferred")
    expect(step.bundle_id).toBe(head.id)
    expect(step.bundle_position ?? 0).toBeGreaterThan(0)
    expect(step.depends_on_id).toBe(head.id)
    expect(step.current_payload.note).toContain("@ref:")
  }, 30_000)

  it("an undeclared write after a scoped read that actually ran never runs inline: it parks (rule 8)", async () => {
    const seed = await seedOrgWithTicketsApp()
    orgs.push(seed.orgId)
    const { ctx, agentId } = await agentBoundCtx(seed)

    const read = await handleToolCall(ctx, "test__listItems", {})
    expect(read.isError).toBeFalsy()

    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(seed.orgId, agentId))) ?? "[]")
    expect(persisted.length).toBeGreaterThan(0)

    const write = await handleToolCall(ctx, "test__createItem", mutatingTicketTool.validParams)
    expect((write.structuredContent as { code?: string }).code).not.toBe("E_SCOPE_TAINT_BLOCKED")
    const out = write.structuredContent as { gated?: boolean; executed?: boolean }
    expect(out.gated).toBe(true)
    expect(out.executed).toBe(false)
  }, 30_000)
})
