// SPDX-License-Identifier: FSL-1.1-ALv2
//
// approvals_pendingFor, scoped: an app lists the requests still awaiting a decision on its own
// tools whose payload carries a key (e.g. "finding_id"), so it can show "awaiting approval" on the
// row a parked call targets and drop it once the request is denied, expires or is cancelled. Only
// this org, only this app's tools, newest first.
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
  older: randomUUID(),
  newer: randomUUID(),
  like: randomUUID(),
  deferred: randomUUID(),
  denied: randomUUID(),
  cancelled: randomUUID(),
  pastDeadline: randomUUID(),
  noKey: randomUUID(),
  otherApp: randomUUID(),
  otherOrg: randomUUID(),
}

async function insertApproval(
  id: string,
  opts: {
    org?: string
    toolName?: string
    status?: string
    expiresInMs?: number
    payload?: Record<string, unknown>
    createdSecondsAgo?: number
  },
) {
  const org = opts.org ?? ORG
  const thread = org === ORG ? THREAD : OTHER_THREAD
  const user = org === ORG ? USER : OTHER_USER
  const expires = new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString()
  const created = new Date(Date.now() - (opts.createdSecondsAgo ?? 60) * 1000).toISOString()
  const payload = JSON.stringify(opts.payload ?? { finding_id: "f1", reply_text: "hi" })
  await sql`
    INSERT INTO kernel.approval_requests (
      id, org_id, handle, status, tool_name, tool_params, summary, current_payload,
      thread_id, originating_thread_id, requested_by, notify_user_ids, expires_at, created_at
    ) VALUES (
      ${id}, ${org}, ${`apf-${id.slice(0, 8)}`}, ${opts.status ?? "pending"},
      ${opts.toolName ?? "social:reply_to_finding"}, ${payload}::jsonb, '{"title":"t"}'::jsonb, ${payload}::jsonb,
      ${thread}, ${thread}, ${user}, ${sql.array([user], 2950)}, ${expires}::timestamptz, ${created}::timestamptz
    )`
}

function methods(appName: string, orgId = ORG) {
  return createApprovalsMethods({
    appName,
    orgId,
    approvalContext: null,
    bridgeOptions: {},
  } as unknown as BridgeContext) as Record<string, (key: string, tools?: string) => Promise<string>>
}

const pendingFor = async (key: string, tools?: string[], appName = "social", orgId = ORG) =>
  JSON.parse(
    await methods(appName, orgId).approvals_pendingFor!(
      key,
      tools === undefined ? undefined : JSON.stringify(tools),
    ),
  ) as Array<{
    id: string
    tool_name: string
    target_id: string
    payload: Record<string, unknown>
    created_at: string
  }>

describe("approvals_pendingFor scope", () => {
  beforeAll(async () => {
    for (const [org, thread, user] of [
      [ORG, THREAD, USER],
      [OTHER_ORG, OTHER_THREAD, OTHER_USER],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, 'Pending for org', ${`apf-${org.slice(0, 8)}`})`
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash) VALUES (${user}, ${org}, ${`apf-${user.slice(0, 8)}@example.com`}, 'U', 'active', 'hash')`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${thread}, ${org}, ${`apf-${thread.slice(0, 8)}`}, 'approval', ${user})`
    }
    await insertApproval(IDS.older, {
      createdSecondsAgo: 300,
      payload: { finding_id: "f1", reply_text: "old" },
    })
    await insertApproval(IDS.newer, {
      createdSecondsAgo: 30,
      payload: { finding_id: "f1", reply_text: "new" },
    })
    await insertApproval(IDS.like, {
      toolName: "social:like_item",
      createdSecondsAgo: 120,
      payload: { finding_id: "f2" },
    })
    await insertApproval(IDS.deferred, {
      status: "deferred",
      createdSecondsAgo: 200,
      payload: { finding_id: "f3" },
    })
    await insertApproval(IDS.denied, { status: "denied", payload: { finding_id: "f4" } })
    await insertApproval(IDS.cancelled, { status: "cancelled", payload: { finding_id: "f5" } })
    await insertApproval(IDS.pastDeadline, { expiresInMs: -60_000, payload: { finding_id: "f6" } })
    await insertApproval(IDS.noKey, {
      toolName: "social:send_dm",
      payload: { conversation_id: "c1", body: "x" },
    })
    await insertApproval(IDS.otherApp, {
      toolName: "socialx:reply_to_finding",
      payload: { finding_id: "f1" },
    })
    await insertApproval(IDS.otherOrg, { org: OTHER_ORG, payload: { finding_id: "f1" } })
  })

  afterAll(async () => {
    for (const org of [ORG, OTHER_ORG]) {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })

  it("lists this app's pending and deferred requests carrying the key, newest first, with their payload", async () => {
    const rows = await pendingFor("finding_id")
    expect(rows.map((r) => r.id)).toEqual([IDS.newer, IDS.like, IDS.deferred, IDS.older])
    expect(rows[0]).toMatchObject({
      tool_name: "social:reply_to_finding",
      target_id: "f1",
      payload: { finding_id: "f1", reply_text: "new" },
    })
    expect(typeof rows[0]!.created_at).toBe("string")
  })

  it("denied, cancelled and past-deadline requests are not pending", async () => {
    const ids = (await pendingFor("finding_id")).map((r) => r.id)
    for (const gone of [IDS.denied, IDS.cancelled, IDS.pastDeadline])
      expect(ids).not.toContain(gone)
  })

  it("narrows to the given tool names, ignoring any that are not this app's", async () => {
    expect((await pendingFor("finding_id", ["social:like_item"])).map((r) => r.id)).toEqual([
      IDS.like,
    ])
    expect(await pendingFor("finding_id", ["socialx:reply_to_finding"])).toEqual([])
    expect(await pendingFor("finding_id", [])).toEqual([])
    expect((await pendingFor("conversation_id")).map((r) => r.id)).toEqual([IDS.noKey])
  })

  it("never returns another app's or another org's requests, and refuses a malformed key", async () => {
    expect(await pendingFor("finding_id", undefined, "socialx")).toHaveLength(1)
    expect((await pendingFor("finding_id", undefined, "socialx"))[0]!.id).toBe(IDS.otherApp)
    expect(await pendingFor("finding_id", undefined, "shopify")).toEqual([])
    expect(
      (await pendingFor("finding_id", undefined, "social", OTHER_ORG)).map((r) => r.id),
    ).toEqual([IDS.otherOrg])
    expect(await pendingFor("finding_id' OR '1'='1")).toEqual([])
    expect(await pendingFor("")).toEqual([])
  })
})
