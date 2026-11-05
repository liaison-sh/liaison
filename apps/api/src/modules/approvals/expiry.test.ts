// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { runApprovalExpiry, runApprovalExpirySweep } from "~/modules/approvals/expiry"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000063001"
const USER = "00000000-0000-4000-8000-000000063002"
const THREAD = "00000000-0000-4000-8000-000000063003"

async function seedRequest(
  id: string,
  status = "pending",
  expiresSql = "now() - interval '1 second'",
) {
  await sql.unsafe(
    `INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason
    ) VALUES (
      '${id}', '${ORG}', 'expiry-${id.slice(-4)}', '${THREAD}', '${THREAD}', 'expiry:tool', '{}'::jsonb,
      '{"x":1}'::jsonb, ${expiresSql}, ARRAY['${USER}']::uuid[], '${USER}', '${status}', 'gated'
    )`,
  )
}

describe("approval expiry", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Approval Expiry Org', 'approval-expiry-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'expiry@test.com', 'Expiry User', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'expiry-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("transitions a pending request to expired and posts a system message", async () => {
    const id = "00000000-0000-4000-8000-000000063101"
    await seedRequest(id)
    await runApprovalExpiry({ orgId: ORG, requestId: id })
    const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("expired")
    const [msg] = await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG}`
    expect(msg.metadata).toMatchObject({ type: "approval-decision", decision: "expired" })
  })

  it("stamps the handle so two expiries in one thread are two distinguishable lines", async () => {
    const id = "00000000-0000-4000-8000-000000063105"
    await seedRequest(id)
    await runApprovalExpiry({ orgId: ORG, requestId: id })
    const [msg] = await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG}`
    expect(msg.metadata).toMatchObject({ requestHandle: `expiry-${id.slice(-4)}` })
  })

  it("posts the notice ONCE however many times it is run for one request", async () => {
    // The per-request delayed job and the two-minute sweep both target the same
    // row. The status guard is what stops a second run posting a second
    // identical line into the thread.
    const id = "00000000-0000-4000-8000-000000063106"
    await seedRequest(id)
    await runApprovalExpiry({ orgId: ORG, requestId: id })
    await runApprovalExpiry({ orgId: ORG, requestId: id })
    await runApprovalExpirySweep()
    const messages = await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG}`
    expect(messages.length).toBe(1)
  })

  it("is a no-op when the request is already decided", async () => {
    const id = "00000000-0000-4000-8000-000000063102"
    await seedRequest(id, "denied")
    await runApprovalExpiry({ orgId: ORG, requestId: id })
    const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.status).toBe("denied")
    const messages = await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG}`
    expect(messages.length).toBe(0)
  })

  it("sweep recovers expired pending rows whose delayed job was missed", async () => {
    const due = "00000000-0000-4000-8000-000000063103"
    const future = "00000000-0000-4000-8000-000000063104"
    await seedRequest(due)
    await seedRequest(future, "pending", "now() + interval '1 hour'")
    await runApprovalExpirySweep()
    const rows =
      await sql`SELECT id, status FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY id`
    expect(rows.map((r: any) => [r.id, r.status])).toEqual([
      [due, "expired"],
      [future, "pending"],
    ])
  })
})
