// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression coverage for the BATCH last-failure read. The original query used
// `approval_request_id = ANY(${ids})` in a raw drizzle sql`` template — drizzle
// spreads a JS array into comma-joined scalar params, so Postgres saw a row
// constructor `ANY(($2,$3,...))` and threw "op ANY/ALL (array) requires array
// on right side", 500ing GET /api/approvals for any org with pending
// approvals. These tests hit the real DB with MULTIPLE ids so that shape can
// never come back.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { readApprovalLastFailure, readApprovalLastFailures } from "~/modules/approvals/last-failure"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "0f7f3c1e-aaaa-4bbb-8ccc-1dd2ee3ff401"
const USER = "0f7f3c1e-aaaa-4bbb-8ccc-1dd2ee3ff402"
const THREAD = "0f7f3c1e-aaaa-4bbb-8ccc-1dd2ee3ff403"
const REQ_FAILED = "0f7f3c1e-aaaa-4bbb-8ccc-1dd2ee3ff404"
const REQ_AMBIGUOUS = "0f7f3c1e-aaaa-4bbb-8ccc-1dd2ee3ff405"
const REQ_CLEAN = "0f7f3c1e-aaaa-4bbb-8ccc-1dd2ee3ff406"

async function seedRequest(id: string, suffix: string): Promise<void> {
  await sql`INSERT INTO kernel.approval_requests (
    id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
    current_payload, expires_at, notify_user_ids, requested_by, status, reason
  ) VALUES (
    ${id}, ${ORG}, ${`last-failure-${suffix}`}, ${THREAD}, ${THREAD},
    'last_failure_test:tool', '{}'::jsonb, '{}'::jsonb, now() + interval '1 hour',
    ARRAY[${USER}]::uuid[], ${USER}, 'pending', 'gated'
  ) ON CONFLICT DO NOTHING`
}

async function seedExecution(
  requestId: string,
  status: string,
  message: string,
  finishedOffset: string,
): Promise<void> {
  await sql`INSERT INTO kernel.approved_handler_executions (
    org_id, approval_request_id, tool_name, status, error, actor_id, finished_at
  ) VALUES (
    ${ORG}, ${requestId}, ${`last_failure_test:tool-${message}`}, ${status},
    ${JSON.stringify({ code: "handler_failed", message })}::jsonb, ${USER},
    now() + ${finishedOffset}::interval
  )`
}

describe("readApprovalLastFailures (batch)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Last Failure Org', 'last-failure-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'last-failure@test.com', 'LastFailure', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'last-failure-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await seedRequest(REQ_FAILED, "failed")
    await seedRequest(REQ_AMBIGUOUS, "ambiguous")
    await seedRequest(REQ_CLEAN, "clean")
    // REQ_FAILED: an older failure and a newer one — the read must return the latest.
    await seedExecution(REQ_FAILED, "failed_no_effect", "older failure", "-2 hours")
    await seedExecution(REQ_FAILED, "failed_no_effect", "latest failure", "-1 hour")
    await seedExecution(REQ_AMBIGUOUS, "ambiguous", "ambiguous outcome", "-1 hour")
    // REQ_CLEAN: a succeeded execution only — must NOT surface as a failure.
    await seedExecution(REQ_CLEAN, "succeeded", "fine", "-1 hour")
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("resolves the latest failure per request across MULTIPLE ids in one query", async () => {
    // 3+ ids is the shape that broke in prod (ANY over a spread param list).
    const out = await withPrivilegedDb(ORG, "last-failure-test-batch", (tx) =>
      readApprovalLastFailures(tx, ORG, [REQ_FAILED, REQ_AMBIGUOUS, REQ_CLEAN]),
    )
    expect(out.get(REQ_FAILED)?.message).toBe("latest failure")
    expect(out.get(REQ_AMBIGUOUS)?.message).toBe("ambiguous outcome")
    expect(out.has(REQ_CLEAN)).toBe(false)
  })

  it("returns an empty map for an empty id list without querying", async () => {
    const out = await withPrivilegedDb(ORG, "last-failure-test-empty", (tx) =>
      readApprovalLastFailures(tx, ORG, []),
    )
    expect(out.size).toBe(0)
  })

  it("single-request read agrees with the batch read", async () => {
    const single = await withPrivilegedDb(ORG, "last-failure-test-single", (tx) =>
      readApprovalLastFailure(tx, ORG, REQ_FAILED),
    )
    expect(single?.message).toBe("latest failure")
  })
})
