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
import { seedContext } from "~/seed/context"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let ORG = ""
let OTHER_ORG = ""
let USER = ""
let OTHER_USER = ""
let THREAD = ""
let OTHER_THREAD = ""

const IDS = {
  pending: randomUUID(),
  approving: randomUUID(),
  denied: randomUUID(),
  otherApp: randomUUID(),
  otherOrg: randomUUID(),
}

/** One parked request, through the approvals factory (a pending or denied one). */
async function seedApproval(
  id: string,
  opts: { org?: string; toolName?: string; status?: "pending" | "denied" },
) {
  const org = opts.org ?? ORG
  const user = org === ORG ? USER : OTHER_USER
  await seedApprovalRequests(seedContext({ orgId: org, now: new Date() }), [
    {
      id,
      handle: `agw-${id.slice(0, 8)}`,
      threadId: org === ORG ? THREAD : OTHER_THREAD,
      toolName: opts.toolName ?? "invoicing:received_einvoice_set_status",
      payload: {},
      requestedBy: user,
      agentId: null,
      notifyUserIds: [user],
      status: opts.status ?? "pending",
      ...(opts.status === "denied" ? { decidedBy: user, decidedAt: new Date() } : {}),
      createdAt: new Date(),
    },
  ])
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
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    USER = (await minimal.adminSession(ORG)).userId
    const other = await minimal.secondOrg({ name: "Approval withdraw org" })
    OTHER_ORG = other.orgId
    OTHER_USER = other.adminUserId
    THREAD = await minimal.thread(ORG, USER)
    OTHER_THREAD = await minimal.thread(OTHER_ORG, OTHER_USER)
    await seedApproval(IDS.pending, {})
    // A request a person is approving right now: parked, then mid-decision.
    await seedApproval(IDS.approving, {})
    await sql`UPDATE kernel.approval_requests SET status = 'approving' WHERE id = ${IDS.approving}`
    await seedApproval(IDS.denied, { status: "denied" })
    await seedApproval(IDS.otherApp, { toolName: "invoicingx:anything" })
    await seedApproval(IDS.otherOrg, { org: OTHER_ORG })
  })

  afterAll(async () => {
    for (const org of [ORG, OTHER_ORG]) {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${org}`
    }
    await releaseTestLock()
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
