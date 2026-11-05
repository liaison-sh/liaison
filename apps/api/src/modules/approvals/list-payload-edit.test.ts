// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The approvals list's "last edit" enrichment. Prod: `GET /api/approvals` hit
// the 10 s statement timeout on the payload-edit lookup. Approval threads are
// shared (an MCP connection's or a routine's thread carries hundreds of
// approvals and thousands of messages), and the lookup joined every message of
// the thread once per approval, running the messages RLS policy on each row.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import postgres from "postgres"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { getApproval, listApprovals } from "~/modules/approvals/list"

const ORG = "00000000-0000-4000-8000-000000071001"
const USER = "00000000-0000-4000-8000-000000071002"
const THREAD = "00000000-0000-4000-8000-000000071003"
const APPROVALS = 30
const FILLER_MESSAGES = 3000
const requestId = (i: number) => `00000000-0000-4000-8000-0000000712${String(i).padStart(2, "0")}`

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["plk_test:approve", "kernel:approvals:read"],
  dimensionGrants: {},
}

const LAST_EDIT_AT = "2026-10-14T10:00:00.000Z"

describe("approvals list: last payload edit", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Payload Edit List Org', 'payload-edit-list-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES
      (${USER}, ${ORG}, 'payload-edit-list@test.local', 'Payload Edit Lister', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES
      (${USER}, ${ORG}, 'plk_test:approve') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'payload-edit-list-thread', 'approval', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${THREAD}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    for (let i = 0; i < APPROVALS; i++) {
      await sql`INSERT INTO kernel.approval_requests (
        id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
        current_payload, expires_at, notify_user_ids, requested_by, status, reason, summary
      ) VALUES (
        ${requestId(i)}, ${ORG}, ${`request-plk-${i}`}, ${THREAD}, ${THREAD}, 'plk_test:tool', '{}'::jsonb,
        '{}'::jsonb, now() + interval '1 hour', ARRAY[${USER}]::uuid[], ${USER}, 'pending', 'gated',
        '{"kind":"plk","title":"Shared thread approval","lines":[]}'::jsonb
      ) ON CONFLICT DO NOTHING`
    }
    // A busy shared approval thread: thousands of ordinary system messages
    // (approval cards, results) and two payload edits, the later one wins.
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, metadata, required_scopes, created_at)
      SELECT ${ORG}, ${THREAD}, ${USER}, 'system', 'approval card ' || g,
             jsonb_build_object('type', 'approval-request', 'padding', repeat('x', 400)),
             '{}'::text[],
             timestamptz '2026-10-01T00:00:00Z' + g * interval '1 minute'
      FROM generate_series(1, ${FILLER_MESSAGES}) g`
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, metadata, required_scopes, created_at) VALUES
      (${ORG}, ${THREAD}, ${USER}, 'system', 'Edited', ${JSON.stringify({ type: "payload-edit", editorUserId: USER, diff: [{ field: "message", from: "a", to: "b" }] })}::jsonb, '{}'::text[], timestamptz '2026-10-02T00:00:00Z'),
      (${ORG}, ${THREAD}, ${USER}, 'system', 'Edited', ${JSON.stringify({ type: "payload-edit", editorUserId: USER, diff: [{ field: "message", from: "b", to: "c" }] })}::jsonb, '{}'::text[], ${LAST_EDIT_AT})`
    // As a superuser: the app role does not own the table, and Postgres skips a
    // non-owner's ANALYZE with only a warning. Stale statistics from an earlier
    // run then steer the plan (an org index estimated at one row) and the
    // lookup reads the whole thread, which is what this test must not measure.
    const DSN =
      process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
    const owner = postgres(DSN.replace("liaison_app:liaison_app", "liaison:liaison"), { max: 1 })
    try {
      await owner`ANALYZE kernel.messages`
    } finally {
      await owner.end()
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("reads each approval's last edit without walking the shared thread once per approval", async () => {
    const { list, messageRowsRead } = await withRlsContext(actor, async (tx) => {
      const readCount = async () =>
        Number(
          extractRows<{ n: string | number }>(
            await tx.execute(drizzleSql`
              SELECT COALESCE(seq_tup_read, 0) + COALESCE(idx_tup_fetch, 0) AS n
              FROM pg_stat_xact_user_tables
              WHERE schemaname = 'kernel' AND relname = 'messages'
            `),
          )[0]?.n ?? 0,
        )
      const before = await readCount()
      const list = await listApprovals(tx, { orgId: ORG, userId: USER, scopes: actor.scopes })
      return { list, messageRowsRead: (await readCount()) - before }
    })

    const mine = list.filter((r) => r.id.startsWith("00000000-0000-4000-8000-0000000712"))
    expect(mine).toHaveLength(APPROVALS)
    for (const row of mine) {
      expect(row.lastEdit?.at).toBe(LAST_EDIT_AT)
      expect(row.lastEdit?.diff).toEqual([{ field: "message", from: "b", to: "c" }])
    }
    // The old join read the whole thread once per approval (30 x 3002 rows;
    // still every edit row once per approval with the partial index alone).
    // The lookup now reads the newest edit once per THREAD, whatever the
    // number of approvals sharing it.
    expect(messageRowsRead).toBeLessThanOrEqual(APPROVALS / 10)
  })

  it("lists the approvals without their last edit when the edit lookup fails", async () => {
    // A lookup that cannot get its rows (here: kernel.messages locked by
    // another session, refused by lock_timeout) must cost the cards their
    // "edited" marker, never the whole list.
    const holder = await sql.reserve()
    try {
      await holder`BEGIN`
      await holder`LOCK TABLE kernel.messages IN ACCESS EXCLUSIVE MODE`
      const { list, detail } = await withRlsContext(actor, async (tx) => {
        await tx.execute(drizzleSql`SELECT set_config('lock_timeout', '200ms', true)`)
        const list = await listApprovals(tx, { orgId: ORG, userId: USER, scopes: actor.scopes })
        const detail = await getApproval(tx, { orgId: ORG, userId: USER, requestId: requestId(0) })
        return { list, detail }
      })
      const mine = list.filter((r) => r.id.startsWith("00000000-0000-4000-8000-0000000712"))
      expect(mine).toHaveLength(APPROVALS)
      for (const row of mine) expect(row.lastEdit).toBeNull()
      expect(detail?.id).toBe(requestId(0))
      expect(detail?.lastEdit).toBeNull()
    } finally {
      await holder`ROLLBACK`
      holder.release()
    }
  })
})
