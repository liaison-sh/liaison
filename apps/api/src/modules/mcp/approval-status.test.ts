// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { decideApproval } from "~/modules/approvals/decide"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { getApprovalStatus } from "~/modules/mcp/approval-status"
import {
  cleanupSeededOrg,
  seedApprovedGatedRequest,
  seedMcpConnection,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

describe("liaison_approval_status meta-tool", () => {
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

  it("pending approval → { state: 'pending' }, no result", async () => {
    const { orgId, approvalRequestId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    const status = await getApprovalStatus(orgId, approvalRequestId)
    // The handle rides along on every found state: it is the `request-N`
    // label the approval card prints, the reference the agent must cite.
    expect(status).toEqual({ state: "pending", handle: expect.stringMatching(/^request-\d+$/) })
  }, 30_000)

  it("pending approval whose last execution FAILED → { state: 'pending', last_failure } (never an indistinct pending)", async () => {
    const { orgId, ownerId, approvalRequestId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    // Simulate a post-approval handler failure that reverted the card to pending
    // (the run-approved-handler soft-error path persists exactly this row).
    await sql`
      INSERT INTO kernel.approved_handler_executions
        (org_id, approval_request_id, tool_name, status, actor_id, attempts, last_attempt_at, finished_at, error)
      VALUES (${orgId}, ${approvalRequestId}, 'boxtal:create_shipment', 'failed_no_effect', ${ownerId}, 1, now(), now(),
        ${JSON.stringify({ code: "carrier_rejected", message: "A valid North American phone number is required" })}::jsonb)`
    const status = await getApprovalStatus(orgId, approvalRequestId)
    expect(status.state).toBe("pending")
    const failure = (status as { last_failure?: { code: string; message: string; at: string } })
      .last_failure
    expect(failure?.code).toBe("carrier_rejected")
    expect(failure?.message).toContain("North American phone number")
    expect(typeof failure?.at).toBe("string")
  }, 30_000)

  it("approved + decided → { state: 'approved', result }", async () => {
    const { orgId, approvalRequestId, expectedResult } = await seedApprovedGatedRequest()
    orgs.push(orgId)
    const status = await getApprovalStatus(orgId, approvalRequestId)
    expect(status).toEqual({
      state: "approved",
      handle: expect.stringMatching(/^request-\d+$/),
      result: expectedResult,
    })
  }, 30_000)

  it("denied → { state: 'denied', reason }", async () => {
    const { orgId, approvalRequestId, decider } = await seedApprovedGatedRequest({
      decide: false,
    })
    orgs.push(orgId)
    await decideApproval({
      orgId,
      requestId: approvalRequestId,
      actor: decider,
      decision: "deny",
      reason: "not allowed",
    })
    const status = await getApprovalStatus(orgId, approvalRequestId)
    expect(status.state).toBe("denied")
    expect((status as { reason?: string }).reason).toBe("not allowed")
  }, 30_000)

  it("withdrawn request reports state withdrawn, never pending", async () => {
    const { orgId, approvalRequestId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    await sql`UPDATE kernel.approval_requests SET status = 'withdrawn', decided_at = now()
      WHERE id = ${approvalRequestId}`
    const status = await getApprovalStatus(orgId, approvalRequestId)
    expect(status.state).toBe("withdrawn")
    expect(status.state).not.toBe("pending")
  }, 30_000)

  it("cancelled request reports state cancelled, never pending", async () => {
    const { orgId, approvalRequestId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    await sql`UPDATE kernel.approval_requests SET status = 'cancelled', decided_at = now()
      WHERE id = ${approvalRequestId}`
    const status = await getApprovalStatus(orgId, approvalRequestId)
    expect(status.state).toBe("cancelled")
    expect(status.state).not.toBe("pending")
  }, 30_000)

  it("deferred bundle step reports state pending, never unknown", async () => {
    const { orgId, approvalRequestId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    await sql`UPDATE kernel.approval_requests SET status = 'deferred' WHERE id = ${approvalRequestId}`
    const status = await getApprovalStatus(orgId, approvalRequestId)
    expect(status.state).toBe("pending")
    expect(status.state).not.toBe("unknown")
  }, 30_000)

  it("unrecognised status falls to the fail closed unknown state", async () => {
    const { orgId, approvalRequestId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    await sql`UPDATE kernel.approval_requests SET status = 'totally_bogus_status' WHERE id = ${approvalRequestId}`
    const status = await getApprovalStatus(orgId, approvalRequestId)
    expect(status.state).toBe("unknown")
    expect((status as { raw_status?: string }).raw_status).toBe("totally_bogus_status")
  }, 30_000)

  it("unknown approvalRequestId → { state: 'not_found' }", async () => {
    const { orgId } = await seedApprovedGatedRequest({ decide: false })
    orgs.push(orgId)
    const status = await getApprovalStatus(orgId, "00000000-0000-4000-9999-000000000000")
    expect(status).toEqual({ state: "not_found" })
  }, 30_000)

  it("end-to-end via handleToolCall meta-tool routing", async () => {
    const { orgId, ownerId, approvalRequestId, expectedResult } = await seedApprovedGatedRequest()
    orgs.push(orgId)
    const conn = await seedMcpConnection({
      orgId,
      userId: ownerId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const ctx: ToolCallCtx = {
      orgId,
      actor: { actorType: "user", userId: ownerId, orgId, scopes: [], dimensionGrants: {} },
      connectionId: conn.id,
      ownerUserId: ownerId,
      connectionThreadId: null,
      discovered: new Set(),
    }
    const res = await handleToolCall(ctx, "liaison_approval_status", {
      approvalRequestId,
    })
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({
      state: "approved",
      handle: expect.stringMatching(/^request-\d+$/),
      result: expectedResult,
    })
  }, 30_000)
})
