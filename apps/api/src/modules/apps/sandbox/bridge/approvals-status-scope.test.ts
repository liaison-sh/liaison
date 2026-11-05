// SPDX-License-Identifier: FSL-1.1-ALv2
//
// approvals_statusOf, scoped: an app reads the live state of an approval request it created, so a
// row that records "an approval is pending" can learn the request was denied, expired, cancelled or
// withdrawn. Only the status is returned, and only for this org and this app's own tools.
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
  denied: randomUUID(),
  cancelled: randomUUID(),
  pastDeadline: randomUUID(),
  deferredPastDeadline: randomUUID(),
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
      ${id}, ${org}, ${`ags-${id.slice(0, 8)}`}, ${opts.status ?? "pending"},
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
  } as unknown as BridgeContext) as Record<string, (id: string) => Promise<string>>
}

const state = async (id: string, appName = "invoicing") =>
  JSON.parse(await methods(appName).approvals_statusOf!(id)) as {
    status: string | null
    expired?: boolean
  }

describe("approvals_statusOf scope", () => {
  beforeAll(async () => {
    for (const [org, thread, user] of [
      [ORG, THREAD, USER],
      [OTHER_ORG, OTHER_THREAD, OTHER_USER],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, 'Approval state org', ${`ags-${org.slice(0, 8)}`})`
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash) VALUES (${user}, ${org}, ${`ags-${user.slice(0, 8)}@example.com`}, 'U', 'active', 'hash')`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${thread}, ${org}, ${`ags-${thread.slice(0, 8)}`}, 'approval', ${user})`
    }
    await insertApproval(IDS.pending, {})
    await insertApproval(IDS.denied, { status: "denied" })
    await insertApproval(IDS.cancelled, { status: "cancelled" })
    await insertApproval(IDS.pastDeadline, { expiresInMs: -60_000 })
    await insertApproval(IDS.deferredPastDeadline, { status: "deferred", expiresInMs: -60_000 })
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

  it("answers the status of the app's own request", async () => {
    expect(await state(IDS.pending)).toEqual({ status: "pending", expired: false })
    expect(await state(IDS.denied)).toEqual({ status: "denied", expired: false })
    expect(await state(IDS.cancelled)).toEqual({ status: "cancelled", expired: false })
  })

  it("a pending or deferred request past its deadline reads as expired before the sweep reaches it", async () => {
    expect(await state(IDS.pastDeadline)).toEqual({ status: "pending", expired: true })
    expect(await state(IDS.deferredPastDeadline)).toEqual({ status: "deferred", expired: true })
  })

  it("another app's request, another org's request, an unknown or malformed id read as unknown", async () => {
    expect(await state(IDS.otherApp)).toEqual({ status: null })
    expect(await state(IDS.pending, "shopify")).toEqual({ status: null })
    expect(await state(IDS.otherOrg)).toEqual({ status: null })
    expect(await state(randomUUID())).toEqual({ status: null })
    expect(await state("1' OR '1'='1")).toEqual({ status: null })
  })
})
