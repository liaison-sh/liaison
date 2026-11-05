// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import * as rlsModule from "~/db/rls"
import { WithdrawApprovalError, withdrawApproval } from "~/modules/approvals/withdraw"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000093001"
const REQUESTER = "00000000-0000-4000-8000-000000093002"
const OTHER_USER = "00000000-0000-4000-8000-000000093003"
const THREAD = "00000000-0000-4000-8000-000000093004"

const requesterActor: UserContext = {
  actorType: "user",
  userId: REQUESTER,
  orgId: ORG,
  scopes: ["withdraw_test:gated:write", "withdraw_test:approve"],
  dimensionGrants: {},
}

const otherActor: UserContext = {
  actorType: "user",
  userId: OTHER_USER,
  orgId: ORG,
  // Holds BOTH kernel:approvals:write and the full approve scope for this
  // tool family — the test proves scope does not satisfy the ownership
  // check, only being the requester does.
  scopes: ["withdraw_test:gated:write", "withdraw_test:approve", "kernel:approvals:write"],
  dimensionGrants: {},
}

let handlerInvocations = 0

async function grantScopes(userId: string, scopes: string[]): Promise<void> {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${userId}`
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

async function createPendingRequest(): Promise<string> {
  handlerInvocations = 0
  const result = await executeTool({
    toolName: "withdraw_test:gatedEcho",
    orgId: ORG,
    actor: requesterActor,
    params: { message: "hello" },
    threadId: THREAD,
    // Force the gated approval path even though the requester also holds
    // :approve (the direct self-approve bypass only fires when origin is unset).
    origin: "in-app-agent",
  })
  return result.blocked!.approvalRequestId!
}

async function statusOf(id: string): Promise<string> {
  const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return row.status as string
}

async function decidedByOf(id: string): Promise<string | null> {
  const [row] = await sql`SELECT decided_by FROM kernel.approval_requests WHERE id = ${id}`
  return row.decided_by as string | null
}

async function handlerExecutionCountFor(id: string): Promise<number> {
  const rows =
    await sql`SELECT id FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
  return rows.length
}

describe("withdrawApproval", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Withdraw Approval Org', 'withdraw-approval-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${REQUESTER}, ${ORG}, 'withdraw-requester@test.com', 'Requester', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${OTHER_USER}, ${ORG}, 'withdraw-other@test.com', 'Other', 'active', 'hash')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'withdraw-thread', 'agent_chat', ${REQUESTER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${REQUESTER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${REQUESTER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`

    toolRegistry.set([ORG, "withdraw_test", "gatedEcho"], {
      appName: "withdraw_test",
      name: "gatedEcho",
      description: "Gated echo for withdraw tests",
      requiredScopes: ["withdraw_test:gated:write"],
      gated: true,
      handler: async (params: any) => {
        handlerInvocations += 1
        return { echoed: params.message }
      },
    } as any)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("requester withdraws own pending request", async () => {
    const id = await createPendingRequest()
    const result = await withdrawApproval({
      orgId: ORG,
      requestId: id,
      actor: requesterActor,
      reason: "made a mistake",
    })
    expect(result.status).toBe("withdrawn")
    expect(await statusOf(id)).toBe("withdrawn")
    // The underlying action never ran: the handler was not invoked and no
    // handler-protocol execution row exists for this approval.
    expect(handlerInvocations).toBe(0)
    expect(await handlerExecutionCountFor(id)).toBe(0)
  })

  it("SECURITY: non requester cannot withdraw another users request", async () => {
    // OTHER_USER must hold a REAL DB grant of the tool's approve scope so it
    // lands in notify_user_ids at creation time (eligibleApprovers) and so RLS
    // makes the row visible to it at all -- otherwise the refusal would be a
    // meaningless 404 (not visible) rather than the ownership check we mean to
    // exercise. It also holds kernel:approvals:write, the withdraw tool's own
    // scope, proving scope never substitutes for being the requester.
    await grantScopes(OTHER_USER, ["withdraw_test:approve", "kernel:approvals:write"])
    const id = await createPendingRequest()
    await expect(
      withdrawApproval({
        orgId: ORG,
        requestId: id,
        actor: otherActor,
        reason: "not mine to withdraw",
      }),
    ).rejects.toMatchObject({ code: "forbidden", status: 403 })
    // Scope alone (even the full approve scope) never satisfies ownership:
    // the row is untouched and still pending.
    expect(await statusOf(id)).toBe("pending")
    expect(handlerInvocations).toBe(0)
  })

  it("withdraw refuses a request that is approving", async () => {
    const id = await createPendingRequest()
    await sql`UPDATE kernel.approval_requests SET status = 'approving', approving_started_at = now()
      WHERE id = ${id}`
    await expect(
      withdrawApproval({ orgId: ORG, requestId: id, actor: requesterActor }),
    ).rejects.toMatchObject({ code: "stale_status", status: 409 })
    // Left untouched at approving: a human must resolve it, not the agent.
    expect(await statusOf(id)).toBe("approving")
  })

  it("withdraw of a decided request returns a state error", async () => {
    const id = await createPendingRequest()
    await sql`UPDATE kernel.approval_requests SET status = 'denied', decided_at = now() WHERE id = ${id}`
    let error: unknown
    try {
      await withdrawApproval({ orgId: ORG, requestId: id, actor: requesterActor })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(WithdrawApprovalError)
    expect((error as WithdrawApprovalError).status).toBe(409)
    expect((error as WithdrawApprovalError).message).toContain("denied")
  })

  it("withdraw of an already withdrawn request returns a state error", async () => {
    const id = await createPendingRequest()
    await withdrawApproval({ orgId: ORG, requestId: id, actor: requesterActor })
    let error: unknown
    try {
      await withdrawApproval({ orgId: ORG, requestId: id, actor: requesterActor })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(WithdrawApprovalError)
    expect((error as WithdrawApprovalError).status).toBe(409)
    expect((error as WithdrawApprovalError).message).toContain("withdrawn")
  })

  it("withdrawn row is distinguishable from a human denial", async () => {
    const withdrawnId = await createPendingRequest()
    await withdrawApproval({ orgId: ORG, requestId: withdrawnId, actor: requesterActor })
    expect(await statusOf(withdrawnId)).toBe("withdrawn")
    expect(await statusOf(withdrawnId)).not.toBe("denied")
    // Records who withdrew it.
    expect(await decidedByOf(withdrawnId)).toBe(REQUESTER)

    const deniedId = await createPendingRequest()
    await sql`UPDATE kernel.approval_requests SET status = 'denied', decided_by = ${OTHER_USER}, decided_at = now(), reason = 'no'
      WHERE id = ${deniedId}`
    expect(await statusOf(deniedId)).toBe("denied")
    expect(await statusOf(deniedId)).not.toBe("withdrawn")
  })

  it("SECURITY: a row reported under a different org is refused not_found, not withdrawn", async () => {
    const id = await createPendingRequest()
    // withRlsContext is itself org scoped in real use; this test forces a
    // mismatched org_id past it (defense in depth for a second layer failing)
    // to prove the explicit org check at :100 refuses it rather than a
    // read that trusts the row's own org_id column.
    const wrongOrgRow = {
      id,
      org_id: "00000000-0000-4000-8000-000000099999",
      tool_name: "withdraw_test:gatedEcho",
      thread_id: THREAD,
      originating_thread_id: THREAD,
      requested_by: REQUESTER,
      status: "pending",
    }
    spyOn(rlsModule, "withRlsContext").mockImplementationOnce((async (
      _ctx: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      fn({
        execute: async () => [wrongOrgRow],
      } as unknown)) as unknown as typeof rlsModule.withRlsContext)
    let error: unknown
    try {
      await withdrawApproval({ orgId: ORG, requestId: id, actor: requesterActor })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(WithdrawApprovalError)
    expect((error as WithdrawApprovalError).code).toBe("not_found")
    expect((error as WithdrawApprovalError).status).toBe(404)
    // Still pending: the mismatched-org read must never withdraw the real row.
    expect(await statusOf(id)).toBe("pending")
  })

  it("SECURITY: the CAS refuses a stale pending read once the row has moved to approving", async () => {
    const id = await createPendingRequest()
    // The real row already transitioned (e.g. cascade claimed it
    // pending -> approving) AFTER the point where the pre-lock guards would
    // have read it.
    await sql`UPDATE kernel.approval_requests SET status = 'approving', approving_started_at = now()
      WHERE id = ${id}`

    // Force the code past the pre-lock guards (:111/:127) with a stale read
    // that still reports 'pending', so only the locked CAS at :145 stands
    // between this call and withdrawing a row that is really 'approving'.
    const staleRow = {
      id,
      org_id: ORG,
      tool_name: "withdraw_test:gatedEcho",
      thread_id: THREAD,
      originating_thread_id: THREAD,
      requested_by: REQUESTER,
      status: "pending",
    }
    spyOn(rlsModule, "withRlsContext").mockImplementationOnce((async (
      _ctx: unknown,
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      fn({
        execute: async () => [staleRow],
      } as unknown)) as unknown as typeof rlsModule.withRlsContext)

    let error: unknown
    try {
      await withdrawApproval({ orgId: ORG, requestId: id, actor: requesterActor })
    } catch (err) {
      error = err
    }
    expect(error).toBeInstanceOf(WithdrawApprovalError)
    expect((error as WithdrawApprovalError).code).toBe("stale_status")
    // The refusal names the REAL status, not the stale one the pre-lock read saw.
    expect((error as WithdrawApprovalError).message).toContain("approving")
    // The row must still be approving: the CAS never let a stale caller
    // withdraw a request a human is already mid-deciding.
    expect(await statusOf(id)).toBe("approving")
  })
})
