// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { runApprovingReaper, runDeferredStepReaper } from "~/modules/approvals/approving-reaper"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000064001"
const USER = "00000000-0000-4000-8000-000000064002"
const THREAD = "00000000-0000-4000-8000-000000064003"

async function seedRequest(
  id: string,
  opts: {
    stale?: boolean
    status?: string
    /** When set, links this row as a dependent of the given head request. */
    dependsOn?: string
    /**
     * Make `decided_at` stale (>STALE_MINUTES). The deferred-step reaper keys
     * staleness off the head's `decided_at`; the approving reaper keys off
     * `approving_started_at` and is unaffected. Defaults to `now()` to preserve
     * the original approving-reaper fixtures.
     */
    decidedStale?: boolean
  } = {},
) {
  const staleSql =
    opts.stale === false ? "now() - interval '1 minute'" : "now() - interval '11 minutes'"
  const decidedSql = opts.decidedStale ? "now() - interval '11 minutes'" : "now()"
  const dependsOnSql = opts.dependsOn ? `'${opts.dependsOn}'` : "NULL"
  await sql.unsafe(
    `INSERT INTO kernel.approval_requests (
      id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
      current_payload, expires_at, notify_user_ids, requested_by, status, reason, decided_by, decided_at,
      approving_started_at, depends_on_id
    ) VALUES (
      '${id}', '${ORG}', 'reaper-${id.slice(-4)}', '${THREAD}', '${THREAD}', 'reaper:tool', '{}'::jsonb,
      '{"x":1}'::jsonb, now() + interval '1 hour', ARRAY['${USER}']::uuid[], '${USER}', '${opts.status ?? "approving"}',
      'gated', '${USER}', ${decidedSql}, ${staleSql}, ${dependsOnSql}
    )`,
  )
}

async function seedExecution(requestId: string, status: string) {
  const error =
    status === "failed_no_effect" || status === "ambiguous"
      ? JSON.stringify({ code: status })
      : null
  const externalRef = status === "succeeded" ? JSON.stringify({ messageId: "m-1" }) : null
  await sql`INSERT INTO kernel.approved_handler_executions (
    org_id, approval_request_id, tool_name, status, actor_id, attempts, error, external_ref, finished_at
  ) VALUES (
    ${ORG}, ${requestId}, 'reaper:tool', ${status}, ${USER}, 1,
    ${error}::jsonb,
    ${externalRef}::jsonb,
    CASE WHEN ${status} = 'started' THEN NULL ELSE now() END
  )`
}

async function statusOf(id: string) {
  const [row] = await sql`SELECT status FROM kernel.approval_requests WHERE id = ${id}`
  return row.status as string
}

describe("approval approving reaper", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Approving Reaper Org', 'approving-reaper-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'reaper@test.com', 'Reaper User', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'reaper-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("terminalizes stale approving rows with a succeeded handler record", async () => {
    const id = "00000000-0000-4000-8000-000000064101"
    await seedRequest(id)
    await seedExecution(id, "succeeded")
    await runApprovingReaper()
    expect(await statusOf(id)).toBe("approved")
    const [msg] = await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG}`
    expect(msg.metadata).toMatchObject({
      type: "approval-decision",
      decision: "approved",
    })
  })

  it("reverts stale approving rows with failed_no_effect handler records", async () => {
    const id = "00000000-0000-4000-8000-000000064102"
    await seedRequest(id)
    await seedExecution(id, "failed_no_effect")
    await runApprovingReaper()
    expect(await statusOf(id)).toBe("pending")
    const [msg] = await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG}`
    expect(msg.metadata.type).toBe("approval-error")
  })

  it("the recovered handler-failure notice carries the requester's scopes, because its metadata quotes the handler error", async () => {
    // The text is fixed, but `metadata.error` is the handler's own error object
    // verbatim, and listMessages serves metadata to every reader of the row. A
    // handler that failed holding scoped data puts that data here, so the row
    // fails closed to the requester's scope set rather than to the empty set
    // that every member satisfies.
    const id = "00000000-0000-4000-8000-000000064109"
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'reaper_test:read') ON CONFLICT DO NOTHING`
    try {
      await seedRequest(id)
      await seedExecution(id, "failed_no_effect")
      await runApprovingReaper()
      expect(await statusOf(id)).toBe("pending")
      const rows = await sql<{ required_scopes: string[] }[]>`
        SELECT required_scopes FROM kernel.messages
        WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-error'`
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.required_scopes).toEqual(["reaper_test:read"])
      }
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${USER}`
    }
  })

  it.each([
    ["ambiguous", "00000000-0000-4000-8000-000000064103"],
    ["started", "00000000-0000-4000-8000-000000064104"],
  ])("leaves %s outcomes in approving", async (outcome, id) => {
    await seedRequest(id)
    await seedExecution(id, outcome)
    await runApprovingReaper()
    expect(await statusOf(id)).toBe("approving")
    const messages = await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG}`
    expect(messages.length).toBe(0)
  })

  it("leaves stale approving rows with no handler record alone", async () => {
    const id = "00000000-0000-4000-8000-000000064105"
    await seedRequest(id)
    await runApprovingReaper()
    expect(await statusOf(id)).toBe("approving")
  })

  it("flags an operator-review row on first scan so later scans stay silent", async () => {
    const id = "00000000-0000-4000-8000-000000064107"
    await seedRequest(id)
    await runApprovingReaper()
    const [row] = await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.metadata?.reaperFlaggedAt).toBeTruthy()
    // A second scan must not fail and must leave the row (and flag) untouched.
    await runApprovingReaper()
    expect(await statusOf(id)).toBe("approving")
    const [again] = await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(again.metadata.reaperFlaggedAt).toBe(row.metadata.reaperFlaggedAt)
  })

  it("flags ambiguous operator-review rows too", async () => {
    const id = "00000000-0000-4000-8000-000000064108"
    await seedRequest(id)
    await seedExecution(id, "ambiguous")
    await runApprovingReaper()
    const [row] = await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`
    expect(row.metadata?.reaperFlaggedAt).toBeTruthy()
    expect(await statusOf(id)).toBe("approving")
  })

  it("does not touch non-stale approving rows", async () => {
    const id = "00000000-0000-4000-8000-000000064106"
    await seedRequest(id, { stale: false })
    await seedExecution(id, "succeeded")
    await runApprovingReaper()
    expect(await statusOf(id)).toBe("approving")
  })
})

describe("deferred-step reaper", () => {
  const HEAD = "00000000-0000-4000-8000-000000064201"
  const DEP = "00000000-0000-4000-8000-000000064202"

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Approving Reaper Org', 'approving-reaper-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'reaper@test.com', 'Reaper User', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'reaper-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("cancels a deferred step stranded behind a terminal head past the stale window", async () => {
    // Head reached a terminal status long ago, its handler execution is itself
    // terminal, but the dependent never advanced past `deferred` (cascade crash).
    await seedRequest(HEAD, { status: "approved", decidedStale: true })
    await seedExecution(HEAD, "succeeded")
    await seedRequest(DEP, { status: "deferred", dependsOn: HEAD })

    await runDeferredStepReaper()

    expect(await statusOf(DEP)).toBe("cancelled")
    const [msg] = await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG}`
    expect(msg.metadata).toMatchObject({ type: "approval-decision", decision: "cancelled" })
  })

  it("does NOT cancel a deferred step whose head is still driving an async cascade", async () => {
    // The head terminalized to `approved` but its execution is still
    // `awaiting_output` — a poll job is legitimately advancing the bundle.
    // Even past the stale window the dependent must be left alone.
    await seedRequest(HEAD, { status: "approved", decidedStale: true })
    await seedExecution(HEAD, "awaiting_output")
    await seedRequest(DEP, { status: "deferred", dependsOn: HEAD })

    await runDeferredStepReaper()

    expect(await statusOf(DEP)).toBe("deferred")
    const messages = await sql`SELECT id FROM kernel.messages WHERE org_id = ${ORG}`
    expect(messages.length).toBe(0)
  })

  it("does not cancel a deferred step whose head was decided recently", async () => {
    await seedRequest(HEAD, { status: "approved", decidedStale: false })
    await seedExecution(HEAD, "succeeded")
    await seedRequest(DEP, { status: "deferred", dependsOn: HEAD })

    await runDeferredStepReaper()

    expect(await statusOf(DEP)).toBe("deferred")
  })

  it("cancels a deferred step stranded behind a withdrawn head past the stale window", async () => {
    // Head was withdrawn long ago (no handler execution ever ran for a
    // withdrawn head), but the dependent never advanced past `deferred`.
    await seedRequest(HEAD, { status: "withdrawn", decidedStale: true })
    await seedRequest(DEP, { status: "deferred", dependsOn: HEAD })

    await runDeferredStepReaper()

    expect(await statusOf(DEP)).toBe("cancelled")
    const [msg] = await sql`SELECT metadata FROM kernel.messages WHERE org_id = ${ORG}`
    expect(msg.metadata).toMatchObject({ type: "approval-decision", decision: "cancelled" })
  })
})
