// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { decideApproval } from "~/modules/approvals/decide"

const ORG = "00000000-0000-4000-8000-000000068001"
const REQUESTER = "00000000-0000-4000-8000-000000068002"
const DISCUSSION_THREAD = "00000000-0000-4000-8000-000000068003"
const ORIGIN_THREAD = "00000000-0000-4000-8000-000000068004"
const REQUEST = "00000000-0000-4000-8000-000000068005"

describe("cross-thread approval decisions", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Cross Decide Org', 'cross-decide-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
      VALUES (${REQUESTER}, ${ORG}, 'cross-decide@test.local', 'Cross Decide Requester', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES
      (${DISCUSSION_THREAD}, ${ORG}, 'cross-discussion', 'approval', ${REQUESTER}),
      (${ORIGIN_THREAD}, ${ORG}, 'cross-origin-decide', 'thread', ${REQUESTER})
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES
      (${DISCUSSION_THREAD}, ${REQUESTER}, ${ORG}, 'admin'),
      (${ORIGIN_THREAD}, ${REQUESTER}, ${ORG}, 'admin')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
    ) VALUES (
      ${REQUEST}, ${ORG}, 'request-cross-deny', ${DISCUSSION_THREAD}, ${ORIGIN_THREAD}, 'cross_decide:tool', '{}'::jsonb,
      '{}'::jsonb, now() + interval '1 hour', ARRAY[${REQUESTER}]::uuid[], ${REQUESTER}, 'pending', 'gated',
      '{"kind":"decide","title":"Cross Decide","lines":[]}'::jsonb
    ) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("posts denial system messages to discussion and originating threads", async () => {
    const result = await decideApproval({
      orgId: ORG,
      requestId: REQUEST,
      actor: {
        actorType: "user",
        userId: REQUESTER,
        orgId: ORG,
        scopes: [],
        dimensionGrants: {},
      },
      decision: "deny",
      reason: "Not needed",
    })

    expect(result.status).toBe("denied")
    const messages = await sql`
      SELECT thread_id FROM kernel.messages
      WHERE org_id = ${ORG} AND author_type = 'system' AND metadata->>'type' = 'approval-decision'
    `
    expect(messages.map((row) => row.thread_id).sort()).toEqual(
      [DISCUSSION_THREAD, ORIGIN_THREAD].sort(),
    )
  })
})
