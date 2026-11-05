// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000a2001"
const USER = "00000000-0000-4000-8000-0000000a2002"
const THREAD = "00000000-0000-4000-8000-0000000a2003"

describe("approval_requests bundle columns", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Bundle Schema Org', 'bundle-schema-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'bundle-schema@test.com', 'Bundler', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'bundle-schema-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${THREAD}, ${ORG}) ON CONFLICT DO NOTHING`
  })
  afterAll(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("accepts a bundle head + deferred dependent step", async () => {
    const [head] = await sql`
      INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, status)
      VALUES (${ORG}, 'b-1', ${THREAD}, ${THREAD}, 'seq_test:step1', '{}'::jsonb,
         '{}'::jsonb, now() + interval '1 day', ${USER}, 'pending')
      RETURNING id`
    await sql`UPDATE kernel.approval_requests
      SET bundle_id = ${head.id}, bundle_position = 0 WHERE id = ${head.id}`

    const [step] = await sql`
      INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, status,
         bundle_id, bundle_position, depends_on_id)
      VALUES (${ORG}, 'b-2', ${THREAD}, ${THREAD}, 'seq_test:step2', '{}'::jsonb,
         '{}'::jsonb, now() + interval '1 day', ${USER}, 'deferred',
         ${head.id}, 1, ${head.id})
      RETURNING id, status, bundle_id, bundle_position, depends_on_id`

    expect(step.status).toBe("deferred")
    expect(step.bundle_id).toBe(head.id)
    expect(step.bundle_position).toBe(1)
    expect(step.depends_on_id).toBe(head.id)
  })

  it("accepts awaiting_output execution status", async () => {
    const [head] = await sql`SELECT id, requested_by FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND bundle_position = 0 LIMIT 1`
    const [exec] = await sql`
      INSERT INTO kernel.approved_handler_executions
        (org_id, approval_request_id, tool_name, status, actor_id)
      VALUES (${ORG}, ${head.id}, 'seq_test:step1', 'awaiting_output', ${USER})
      RETURNING status`
    expect(exec.status).toBe("awaiting_output")
  })
})
