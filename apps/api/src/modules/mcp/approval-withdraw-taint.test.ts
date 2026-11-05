// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Withdrawing your own pending approval on a TAINTED MCP connection (demo cleanup, 2026-10-13).
// The first kernel__approval_withdraw over a connection recorded its own scope into the agent's
// window (kernel:approvals:write, projected onto kernel:approvals:read), and the second withdraw
// on the same connection was refused E_SCOPE_TAINT_BLOCKED: kernel.approval_requests declares no
// readers, so every write to it from a tainted turn was refused. A withdraw WITHOUT a reason
// writes none of the conversation's data (a status change on the caller's own row), so taint
// must not judge it. A withdraw WITH a reason runs too (walk 2026-10-24: removing a duplicate
// request raised a third approval): the reason is kept off the request row and posted only in the
// approval's threads, stamped with what the turn read, where each reader is filtered by it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  cleanupSeededOrg,
  gatedTicketTool,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

const APPROVAL_SCOPES = ["kernel:approvals:read", "kernel:approvals:write"]

async function seedTaintCtx(orgs: string[]): Promise<ToolCallCtx> {
  const seed = await seedOrgWithTicketsApp()
  orgs.push(seed.orgId)
  await registerKernelAgentTools(seed.orgId)
  for (const scope of APPROVAL_SCOPES) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${seed.ownerId}, ${seed.orgId}, ${scope}) ON CONFLICT DO NOTHING`
  }
  const { agentId } = await seedAgentForOrg(seed.orgId)
  const conn = await seedMcpConnection({
    orgId: seed.orgId,
    userId: seed.ownerId,
    clientId: "claude-code",
    label: "Claude Code",
  })
  return {
    orgId: seed.orgId,
    actor: userContextFor(seed.orgId, seed.ownerId, [...seed.scopes, ...APPROVAL_SCOPES]),
    connectionId: conn.id,
    ownerUserId: seed.ownerId,
    connectionThreadId: null,
    discovered: new Set(),
    agentId,
  }
}

async function stagePending(ctx: ToolCallCtx): Promise<string> {
  const res = await handleToolCall(ctx, "test__gatedEcho", gatedTicketTool.validParams)
  const id = (res.structuredContent as { approvalRequestId?: string }).approvalRequestId
  expect(id).toBeTruthy()
  return id!
}

async function statusOf(id: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return row!.status
}

describe("kernel__approval_withdraw on a tainted MCP connection", () => {
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

  it("withdraws one pending request after another on the same connection", async () => {
    const ctx = await seedTaintCtx(orgs)
    const ids = [await stagePending(ctx), await stagePending(ctx), await stagePending(ctx)]

    for (const requestId of ids) {
      const res = await handleToolCall(ctx, "kernel__approval_withdraw", { requestId })
      expect((res.structuredContent as { code?: string } | undefined)?.code).toBeUndefined()
      expect(res.isError).toBeFalsy()
      expect(await statusOf(requestId)).toBe("withdrawn")
    }
  }, 60_000)

  it("after a scoped read, a withdraw runs with or without a reason, and the reason is stamped with the read", async () => {
    const ctx = await seedTaintCtx(orgs)
    const plain = await stagePending(ctx)
    const reasoned = await stagePending(ctx)

    const read = await handleToolCall(ctx, "test__listItems", {})
    expect(read.isError).toBeFalsy()

    const reason = "the read showed the item was already handled"
    const withReason = await handleToolCall(ctx, "kernel__approval_withdraw", {
      requestId: reasoned,
      reason,
    })
    expect((withReason.structuredContent as { code?: string } | undefined)?.code).toBeUndefined()
    expect(withReason.isError).toBeFalsy()
    expect(await statusOf(reasoned)).toBe("withdrawn")
    // Off the row, whose readers no requiredScopes filter reaches.
    const [row] = await sql<{ reason: string | null }[]>`
      SELECT reason FROM kernel.approval_requests WHERE id = ${reasoned}`
    expect(row?.reason).toBeNull()
    // In the threads, stamped with what the turn read.
    const notes = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE org_id = ${ctx.orgId} AND content LIKE ${`%${reason}%`}`
    expect(notes.length).toBeGreaterThan(0)
    for (const note of notes) expect(note.required_scopes.length).toBeGreaterThan(0)

    // A blank reason carries nothing either.
    const blank = await handleToolCall(ctx, "kernel__approval_withdraw", {
      requestId: plain,
      reason: "   ",
    })
    expect(blank.isError).toBeFalsy()
    expect(await statusOf(plain)).toBe("withdrawn")
  }, 60_000)
})
