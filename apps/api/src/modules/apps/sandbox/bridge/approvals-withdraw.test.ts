// SPDX-License-Identifier: FSL-1.1-ALv2
//
// approvals_withdraw: an app withdraws one of its own approvals still waiting for a decision (an
// issue approval for a draft another path already issued). Only a pending request of this app's
// tools in this org moves; one being approved, decided, another app's or another org's stays.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import { createApprovalsMethods } from "~/modules/apps/sandbox/bridge/approvals"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"

const ORG = randomUUID()
const OTHER_ORG = randomUUID()
const USER = randomUUID()
const OTHER_USER = randomUUID()
const THREAD = randomUUID()
const OTHER_THREAD = randomUUID()

const IDS = {
  pending: randomUUID(),
  approving: randomUUID(),
  denied: randomUUID(),
  otherApp: randomUUID(),
  otherOrg: randomUUID(),
}

async function insertApproval(
  id: string,
  opts: { org?: string; thread?: string; toolName?: string; status?: string; expiresInMs?: number },
) {
  const org = opts.org ?? ORG
  const thread = opts.thread ?? THREAD
  const user = org === ORG ? USER : OTHER_USER
  const expires = new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString()
  await sql`
    INSERT INTO kernel.approval_requests (
      id, org_id, handle, status, tool_name, tool_params, summary, current_payload,
      thread_id, originating_thread_id, requested_by, notify_user_ids, expires_at
    ) VALUES (
      ${id}, ${org}, ${`agw-${id.slice(0, 8)}`}, ${opts.status ?? "pending"},
      ${opts.toolName ?? "invoicing:received_einvoice_set_status"}, '{}'::jsonb, '{"title":"t"}'::jsonb, '{}'::jsonb,
      ${thread}, ${thread}, ${user}, ${sql.array([user], 2950)}, ${expires}::timestamptz
    )`
}

function methods(appName: string, orgId = ORG) {
  return createApprovalsMethods({
    appName,
    orgId,
    approvalContext: null,
    bridgeOptions: {},
  } as unknown as BridgeContext) as Record<string, (id: string, reason?: string) => Promise<string>>
}

const withdraw = async (id: string, appName = "invoicing") =>
  JSON.parse(
    await methods(appName).approvals_withdraw!(id, "Cancelled: the draft was issued"),
  ) as Record<string, unknown>

const statusOf = async (id: string) =>
  (
    await sql<Array<{ status: string; reason: string | null }>>`
    SELECT status, reason FROM kernel.approval_requests WHERE id = ${id}`
  )[0]

describe("approvals_withdraw", () => {
  beforeAll(async () => {
    for (const [org, thread, user] of [
      [ORG, THREAD, USER],
      [OTHER_ORG, OTHER_THREAD, OTHER_USER],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, 'Approval withdraw org', ${`agw-${org.slice(0, 8)}`})`
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash) VALUES (${user}, ${org}, ${`agw-${user.slice(0, 8)}@example.com`}, 'U', 'active', 'hash')`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${thread}, ${org}, ${`agw-${thread.slice(0, 8)}`}, 'approval', ${user})`
    }
    await insertApproval(IDS.pending, {})
    await insertApproval(IDS.approving, { status: "approving" })
    await insertApproval(IDS.denied, { status: "denied" })
    await insertApproval(IDS.otherApp, { toolName: "invoicingx:anything" })
    await insertApproval(IDS.otherOrg, { org: OTHER_ORG, thread: OTHER_THREAD })
  })

  afterAll(async () => {
    for (const org of [ORG, OTHER_ORG]) {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })

  it("an app withdraws its own pending approval, with the reason", async () => {
    expect(await withdraw(IDS.pending)).toEqual({ ok: true, approval_id: IDS.pending })
    expect(await statusOf(IDS.pending)).toEqual({
      status: "cancelled",
      reason: "Cancelled: the draft was issued",
    })
    // A second withdraw finds nothing waiting.
    expect(await withdraw(IDS.pending)).toEqual({ ok: false, code: "not_pending" })
  })

  it("a request being approved or already decided is left as it is", async () => {
    expect(await withdraw(IDS.approving)).toEqual({ ok: false, code: "not_pending" })
    expect((await statusOf(IDS.approving))?.status).toBe("approving")
    expect(await withdraw(IDS.denied)).toEqual({ ok: false, code: "not_pending" })
    expect((await statusOf(IDS.denied))?.status).toBe("denied")
  })

  it("another app's request, another org's request and a malformed id are never withdrawn", async () => {
    expect(await withdraw(IDS.otherApp)).toEqual({ ok: false, code: "not_pending" })
    expect((await statusOf(IDS.otherApp))?.status).toBe("pending")
    expect((await withdraw(IDS.otherOrg)).ok).toBe(false)
    expect((await statusOf(IDS.otherOrg))?.status).toBe("pending")
    expect(await withdraw("1' OR '1'='1")).toEqual({ ok: false, code: "not_found" })
  })
})
