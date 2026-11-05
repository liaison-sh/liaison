// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Changing who may sign in is a person's decision, never an agent's on its own:
// an agent call that deactivates an account parks for approval, as role edits
// and API-key creation do, and certainly after the turn read outside text.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let admin: minimal.Session
let threadId: string
let cleanThreadId: string

const actor = () => ({
  actorType: "user" as const,
  userId: admin.userId,
  orgId: admin.orgId,
  scopes: ["*"],
  dimensionGrants: {},
})

const agentCall = (toolName: string, params: unknown, onThread: string = threadId) =>
  executeToolCore({
    toolName,
    orgId: admin.orgId,
    actor: actor(),
    params,
    threadId: onThread,
    origin: "in-app-agent",
  })

describe("account deactivation by an agent", () => {
  beforeAll(async () => {
    await acquireTestLock()
    admin = await minimal.adminSession((await createTestOrg()).id)
    threadId = await minimal.thread(admin.orgId, admin.userId)
    cleanThreadId = await minimal.thread(admin.orgId, admin.userId)
    await ensureAppsForOrg(admin.orgId)
    // The turn has read outside text (a mail, a ticket, a web page).
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("positive control: a role edit from the same turn parks for a person", async () => {
    const res = await agentCall("kernel:create_role", {
      name: `r-${crypto.randomUUID()}`,
      scopes: [],
    })
    expect("blocked" in res).toBe(true)
  })

  it("deactivating a colleague's account parks for a person instead of running", async () => {
    const colleague = await minimal.person(admin.orgId, { role: "member" })
    const res = await agentCall("kernel:deactivateUser", { userId: colleague.id })
    const [row] = await sql`SELECT status FROM kernel.users WHERE id = ${colleague.id}`
    expect({ parked: "blocked" in res, status: row?.status }).toEqual({
      parked: true,
      status: "active",
    })
  })

  it("in a clean turn, a person asking gets one approval card, not a refusal", async () => {
    const colleague = await minimal.person(admin.orgId, { role: "member" })
    const res = await agentCall("kernel:deactivateUser", { userId: colleague.id }, cleanThreadId)
    const [row] = await sql`SELECT status FROM kernel.users WHERE id = ${colleague.id}`
    const approvals = await sql`
      SELECT summary FROM kernel.approval_requests
      WHERE org_id = ${admin.orgId} AND thread_id = ${cleanThreadId} AND status = 'pending'`
    expect({ parked: "blocked" in res, status: row?.status, cards: approvals.length }).toEqual({
      parked: true,
      status: "active",
      cards: 1,
    })
    expect(String(approvals[0]?.summary?.title ?? "")).toContain("Deactivate")
  })

  it("the bulk form parks every account for a person too", async () => {
    const a = await minimal.person(admin.orgId, { role: "member" })
    const b = await minimal.person(admin.orgId, { role: "member" })
    const res = (await agentCall("kernel:bulkDeactivateUsers", {
      ids: [a.id, b.id],
      idempotencyKey: crypto.randomUUID(),
    })) as { data?: { items?: Array<{ status: string }> } }
    const rows = await sql`SELECT status FROM kernel.users WHERE id IN (${a.id}, ${b.id})`
    expect(res.data?.items?.map((i) => i.status)).toEqual(["pending_approval", "pending_approval"])
    expect(rows.map((r) => r.status)).toEqual(["active", "active"])
  })

  it("a person's own click still deactivates at once", async () => {
    const colleague = await minimal.person(admin.orgId, { role: "member" })
    const res = await executeToolCore({
      toolName: "kernel:deactivateUser",
      orgId: admin.orgId,
      actor: actor(),
      params: { userId: colleague.id },
      origin: "human-ui",
    })
    const [row] = await sql`SELECT status FROM kernel.users WHERE id = ${colleague.id}`
    expect({ parked: "blocked" in res, status: row?.status }).toEqual({
      parked: false,
      status: "deactivated",
    })
  })
})
