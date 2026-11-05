// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("approvalPayloadHash", () => {
  it("ignores key order and jsonb-as-text round trips", () => {
    const a = approvalPayloadHash("t:x", { b: 1, a: { d: [1, 2], c: "x" } })
    const b = approvalPayloadHash("t:x", { a: { c: "x", d: [1, 2] }, b: 1 })
    const c = approvalPayloadHash("t:x", JSON.stringify({ a: { c: "x", d: [1, 2] }, b: 1 }))
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it("changes with any edit and with the tool", () => {
    const base = approvalPayloadHash("t:x", { body: "hello" })
    expect(approvalPayloadHash("t:x", { body: "hello!" })).not.toBe(base)
    expect(approvalPayloadHash("t:y", { body: "hello" })).not.toBe(base)
  })
})

const ORG = "00000000-0000-4000-8000-0000005e1001"
const USER = "00000000-0000-4000-8000-0000005e1002"
const THREAD = "00000000-0000-4000-8000-0000005e1003"
const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["ph_test:gated:write", "ph_test:approve"],
  dimensionGrants: {},
}

describe("a decision is bound to the payload the human saw", () => {
  let ran = 0
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'PH Org', 'ph-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'ph@test.com', 'PH', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'ph-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
    for (const scope of ["ph_test:gated:write", "ph_test:approve"]) {
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${USER}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
    }
    toolRegistry.set([ORG, "ph_test", "send"], {
      appName: "ph_test",
      name: "send",
      description: "gated send",
      requiredScopes: ["ph_test:gated:write"],
      gated: true,
      handler: async () => {
        ran++
        return { done: true }
      },
    } as any)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  async function stage(body: string): Promise<{ id: string; hash: string }> {
    const res = await executeTool({
      toolName: "ph_test:send",
      orgId: ORG,
      actor,
      params: { body },
      threadId: THREAD,
      origin: "in-app-agent",
    })
    const id = res.blocked!.approvalRequestId!
    const [row] =
      await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${id}`
    return { id, hash: approvalPayloadHash(row.tool_name, row.current_payload) }
  }

  it("refuses an approve whose payload was edited after the card was shown, and runs nothing", async () => {
    ran = 0
    const { id, hash } = await stage("original")
    // The requesting agent edits the pending payload after the human opened the card.
    await sql`UPDATE kernel.approval_requests
      SET current_payload = jsonb_set(current_payload, '{body}', '"exfiltrate"') WHERE id = ${id}`
    let err: unknown
    try {
      await decideApproval({
        orgId: ORG,
        requestId: id,
        actor,
        decision: "approve",
        payloadHash: hash,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApprovalDecisionError)
    expect((err as ApprovalDecisionError).code).toBe("payload_changed")
    expect((err as ApprovalDecisionError).status).toBe(409)
    expect(ran).toBe(0)
    const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("pending")
  })

  it("approves when the hash still matches, and a fresh hash after the edit works", async () => {
    ran = 0
    const { id, hash } = await stage("as shown")
    const res = await decideApproval({
      orgId: ORG,
      requestId: id,
      actor,
      decision: "approve",
      payloadHash: hash,
    })
    expect(res.status).toBe("approved")
    expect(ran).toBe(1)
  })

  it("a deny needs no hash", async () => {
    const { id } = await stage("deny me")
    const res = await decideApproval({ orgId: ORG, requestId: id, actor, decision: "deny" })
    expect(res.status).toBe("denied")
  })
})
