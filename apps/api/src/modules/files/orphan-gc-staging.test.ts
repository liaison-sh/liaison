// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A send copies each attachment onto mail's `outbound_staging` parent and moves
// the copy onto the sent message once it is out. A send that never got there
// (refused, failed, cut off by the execution ceiling) left the copy behind for
// good. The weekly orphan GC removes those copies, and nothing else.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { sweepAbortedSendStagingCopies } from "~/modules/files/orphan-gc"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-000000063001"
const USER = "00000000-0000-4000-8000-000000063002"
const THREAD = "00000000-0000-4000-8000-000000063003"
const ACCOUNT = "00000000-0000-4000-8000-000000063004"
const NOW = new Date("2026-10-20T03:00:00Z")
const HOURS = 60 * 60 * 1000

async function file(opts: {
  entityType?: string
  copied?: boolean
  ageHours: number
}): Promise<string> {
  const id = crypto.randomUUID()
  const createdAt = new Date(NOW.getTime() - opts.ageHours * HOURS).toISOString()
  await sql`INSERT INTO kernel.files
      (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key,
       copied_from_id, created_at)
    VALUES (${id}, ${ORG}, 'mail', ${opts.entityType ?? "outbound_staging"}, ${ACCOUNT},
      'invoice.pdf', 'application/pdf', 10, ${`orgs/${ORG}/${id}`},
      ${opts.copied === false ? null : crypto.randomUUID()}, ${createdAt}::timestamptz)`
  return id
}

async function exists(id: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM kernel.files WHERE id = ${id}`
  return rows.length > 0
}

describe("sweepAbortedSendStagingCopies", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Staging Sweep Org', 'staging-sweep-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'sweep@test.com', 'Sweep User', 'active', 'hash') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG}, 'sweep-thread', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("removes an aborted send's staged copy past 24 h, and announces it as a file delete", async () => {
    const orphan = await file({ ageHours: 25 })
    const swept = await withPrivilegedDb(ORG, "test", (tx) =>
      sweepAbortedSendStagingCopies(tx, ORG, NOW),
    )
    expect(swept).toEqual([orphan])
    expect(await exists(orphan)).toBe(false)
    const events = await sql`SELECT payload->>'entityId' AS entity_id FROM kernel.pending_events
      WHERE org_id = ${ORG} AND payload->>'entity' = 'file' AND payload->>'action' = 'delete'`
    expect(events.map((e) => e.entity_id)).toEqual([orphan])
  })

  it("keeps a copy inside the grace window, an export written to the parent, and other parents", async () => {
    const recent = await file({ ageHours: 2 })
    const exported = await file({ ageHours: 72, copied: false })
    const onMessage = await file({ ageHours: 72, entityType: "message" })
    await withPrivilegedDb(ORG, "test", (tx) => sweepAbortedSendStagingCopies(tx, ORG, NOW))
    expect(await exists(recent)).toBe(true)
    expect(await exists(exported)).toBe(true)
    expect(await exists(onMessage)).toBe(true)
  })

  it("keeps a copy an open approval still names", async () => {
    const staged = await file({ ageHours: 72 })
    const closedRef = await file({ ageHours: 72 })
    for (const [fileId, status] of [
      [staged, "pending"],
      [closedRef, "denied"],
    ] as const) {
      await sql`INSERT INTO kernel.approval_requests (
        id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
        current_payload, expires_at, notify_user_ids, requested_by, status, reason
      ) VALUES (
        ${crypto.randomUUID()}, ${ORG}, ${`sweep-${status}`}, ${THREAD}, ${THREAD}, 'mail:compose',
        '{}'::jsonb, ${JSON.stringify({ attachments: [fileId] })}::jsonb, now() + interval '1 day',
        ARRAY[${USER}]::uuid[], ${USER}, ${status}, 'gated'
      )`
    }
    await withPrivilegedDb(ORG, "test", (tx) => sweepAbortedSendStagingCopies(tx, ORG, NOW))
    expect(await exists(staged)).toBe(true)
    expect(await exists(closedRef)).toBe(false)
  })
})
