// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A parked run_on_my_computer approval is decided only by the person whose computer runs it (the
// requester: the run uses their own computers). Another member who holds the approve scope is
// refused, like for the folder share and the clone.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { decideApproval } from "~/modules/approvals/decide"
import { resolveApprovalResourceOwner } from "~/modules/approvals/resource-owner"
import { executeTool } from "~/modules/apps/execute-tool"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORG = "00000000-0000-4000-8000-0000000b0a01"
const OWNER = "00000000-0000-4000-8000-0000000b0a02"
const OTHER = "00000000-0000-4000-8000-0000000b0a03"
const THREAD = "00000000-0000-4000-8000-0000000b0a04"
const ROLE = "00000000-0000-4000-8000-0000000b0a05"

describe("run_on_my_computer approvals are the computer owner's", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings) VALUES (${ORG}, 'RunOwner', 'run-owner', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES
      (${OWNER}, ${ORG}, 'run-owner@test.com', 'Owner', 'active'),
      (${OTHER}, ${ORG}, 'run-other@test.com', 'Other', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES (${ROLE}, ${ORG}, 'run-approver') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'kernel:approve') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${OTHER}, ${ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    // A conversation both are in, that has read outside text: the run parks for approval.
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
      VALUES (${THREAD}, ${ORG}, 'run-owner-thread', 'agent_chat', ${OWNER}, true) ON CONFLICT DO NOTHING`
    for (const u of [OWNER, OTHER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD}, ${u}, ${ORG}) ON CONFLICT DO NOTHING`
    }
    await registerKernelAgentTools(ORG)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    broadcastSpy.mockRestore()
  })

  it("routes the approval to the requester, and refuses another member with the approve scope", async () => {
    expect(await resolveApprovalResourceOwner(ORG, "kernel", "run_on_my_computer", {}, OWNER)).toBe(
      OWNER,
    )
    const res = await executeTool({
      toolName: "kernel:run_on_my_computer",
      orgId: ORG,
      actor: {
        actorType: "user",
        userId: OWNER,
        orgId: ORG,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      params: { task: "list the files", noFolder: true, model: "any" },
      threadId: THREAD,
      origin: "in-app-agent",
      stepBundleId: null,
    })
    const approvalId = res.blocked?.approvalRequestId
    expect(approvalId).toBeDefined()
    const [row] =
      await sql`SELECT resource_owner_id FROM kernel.approval_requests WHERE id = ${approvalId as string}`
    expect(row?.resource_owner_id).toBe(OWNER)

    await expect(
      decideApproval({
        orgId: ORG,
        requestId: approvalId as string,
        actor: {
          actorType: "user",
          userId: OTHER,
          orgId: ORG,
          scopes: ["kernel:approve"],
          dimensionGrants: {},
        },
        decision: "approve",
      }),
    ).rejects.toThrow()
    const [after] =
      await sql`SELECT status FROM kernel.approval_requests WHERE id = ${approvalId as string}`
    expect(after?.status).toBe("pending")
  })
})
