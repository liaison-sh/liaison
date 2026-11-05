// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"

const ORG = "00000000-0000-4000-8000-000000067001"
const REQUESTER = "00000000-0000-4000-8000-000000067002"
const APPROVER = "00000000-0000-4000-8000-000000067003"
const ORIGIN_THREAD = "00000000-0000-4000-8000-000000067004"

describe("cross-thread approval creation", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Cross Thread Org', 'cross-thread-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES
      (${REQUESTER}, ${ORG}, 'cross-requester@test.local', 'Cross Requester', 'active'),
      (${APPROVER}, ${ORG}, 'cross-approver@test.local', 'Cross Approver', 'active')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${APPROVER}, ${ORG}, 'cross_app:approve') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
      VALUES (${ORIGIN_THREAD}, ${ORG}, 'cross-origin', 'Origin', 'thread', ${REQUESTER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES
      (${ORIGIN_THREAD}, ${REQUESTER}, ${ORG}, 'admin'),
      (${ORIGIN_THREAD}, ${APPROVER}, ${ORG}, 'member')
      ON CONFLICT DO NOTHING`
    toolRegistry.set([ORG, "cross_app", "gated"], {
      appName: "cross_app",
      name: "gated",
      description: "Cross-thread gated test tool",
      requiredScopes: ["cross_app:write"],
      gated: true,
      handler: async () => ({ ok: true }),
    } as any)
  })

  afterAll(async () => {
    toolRegistry.delete([ORG, "cross_app", "gated"])
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_references WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("stays on the originating thread, requester-first snapshot, single greeting, no extra thread", async () => {
    const result = await executeTool({
      toolName: "cross_app:gated",
      orgId: ORG,
      actor: {
        actorType: "user",
        userId: REQUESTER,
        orgId: ORG,
        scopes: ["cross_app:write"],
        dimensionGrants: {},
      },
      threadId: ORIGIN_THREAD,
      params: { message: "hello" },
    })
    const requestId = result.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()

    const [request] = await sql`
      SELECT thread_id, originating_thread_id, notify_user_ids, status
      FROM kernel.approval_requests WHERE id = ${requestId!}
    `
    expect(request.status).toBe("pending")
    expect(request.originating_thread_id).toBe(ORIGIN_THREAD)
    // No second thread is created: the approval's thread_id stays pinned to
    // the originating thread for its whole life.
    expect(request.thread_id).toBe(ORIGIN_THREAD)
    expect(request.notify_user_ids).toEqual([REQUESTER, APPROVER])

    const discussionThreads = await sql`
      SELECT id FROM kernel.threads
      WHERE org_id = ${ORG} AND type = 'approval' AND created_from->>'entityId' = ${requestId!}
    `
    expect(discussionThreads).toHaveLength(0)

    const refs =
      await sql`SELECT id FROM kernel.thread_references WHERE thread_id = ${ORIGIN_THREAD} AND entity_id = ${requestId!}`
    expect(refs).toHaveLength(0)

    const greetings = await sql`
      SELECT thread_id FROM kernel.messages
      WHERE org_id = ${ORG} AND author_type = 'system' AND metadata->>'type' = 'approval-created'
    `
    expect(greetings.map((row) => row.thread_id)).toEqual([ORIGIN_THREAD])
  })

  // The greeting is a system line stamped with the requester's user id, and a
  // thread drew it as that person's own post. It names who asked instead, by
  // the requester rule (an agent's request is the agent's), so the line reads
  // as an event "requested by X".
  it("stamps the greeting with who asked, so the line never borrows a byline", async () => {
    const result = await executeTool({
      toolName: "cross_app:gated",
      orgId: ORG,
      actor: {
        actorType: "user",
        userId: REQUESTER,
        orgId: ORG,
        scopes: ["cross_app:write"],
        dimensionGrants: {},
      },
      threadId: ORIGIN_THREAD,
      params: { message: "who asked" },
    })
    const requestId = result.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()
    const [greeting] = await sql`
      SELECT author_type, metadata FROM kernel.messages
      WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-created'
        AND metadata->>'requestId' = ${requestId!}
    `
    expect(greeting.author_type).toBe("system")
    expect(greeting.metadata).toMatchObject({
      requesterKind: "user",
      requesterName: "Cross Requester",
      requesterId: REQUESTER,
    })
  })
})
