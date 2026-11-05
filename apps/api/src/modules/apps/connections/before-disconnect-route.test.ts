// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DELETE /api/connections/:id runs the app's `beforeDisconnect` provider cleanup
// only once the caller is allowed to disconnect that connection: a member who
// cannot see another member's personal connection gets 404 and the store is
// left untouched (no cleanup, connection still active).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import {
  connectionBeforeDisconnectRegistry,
  connectionConfigRegistry,
  initializedOrgRuntimes,
  manifestRegistry,
} from "~/modules/apps/app-registries"
import { BeforeDisconnectTestAccess } from "~/modules/apps/connections/before-disconnect"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "bdroute"
const CONN = "shop"

describe("DELETE /api/connections/:id runs beforeDisconnect only for an authorized caller", () => {
  let orgId: string
  let alice: { bearer: string; userId: string }
  let bob: { bearer: string; userId: string }
  const hookCalls: string[] = []

  async function personalAccount(ownerId: string): Promise<string> {
    const rows = (await sql`
      INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, identifier, owner_type, owner_id, provider_type, status, created_by)
      VALUES (${orgId}, ${APP}, ${CONN}, ${crypto.randomUUID()}, 'user', ${ownerId}, 'credentials', 'active', ${ownerId})
      RETURNING id`) as Array<{ id: string }>
    const id = rows[0]?.id
    if (!id) throw new Error("no connected account inserted")
    return id
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const rows = (await sql`
      SELECT status FROM kernel.connected_accounts WHERE id = ${id}`) as Array<{ status: string }>
    return rows[0]?.status
  }

  const del = (token: string, id: string) =>
    app.request(`/api/connections/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })

  beforeAll(async () => {
    await acquireTestLock()
    const a = await minimal.session((await createTestOrg()).id)
    orgId = a.orgId
    alice = a
    bob = await minimal.session(orgId, { role: "member" })
    initializedOrgRuntimes.add(orgId)
    manifestRegistry.set([orgId, APP], { name: APP, uiBundleUrl: null })
    connectionConfigRegistry.set([orgId, APP, CONN], {
      type: "credentials",
      allowedDomains: ["demo.test"],
      credentialFields: [{ name: "token", label: "Token", type: "password", required: true }],
      beforeDisconnect: "onBeforeDisconnect",
    })
    connectionBeforeDisconnectRegistry.set([orgId, APP, CONN], {
      bundlePath: "/bundles/bdroute.js",
      exportName: "onBeforeDisconnect",
    })
    BeforeDisconnectTestAccess.setExecutor(async ({ params }) => {
      hookCalls.push(params.id)
    })
  })

  afterAll(async () => {
    BeforeDisconnectTestAccess.setExecutor(null)
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    connectionConfigRegistry.deleteByPrefix([orgId, APP])
    connectionBeforeDisconnectRegistry.deleteByPrefix([orgId, APP])
    manifestRegistry.delete([orgId, APP])
    initializedOrgRuntimes.delete(orgId)
    await releaseTestLock()
  })

  it("another member's personal connection: 404, no cleanup, still active", async () => {
    const id = await personalAccount(alice.userId)
    const res = await del(bob.bearer, id)
    expect(res.status).toBe(404)
    expect(hookCalls).not.toContain(id)
    expect(await statusOf(id)).toBe("active")
  })

  it("the owner's own personal connection: cleanup runs, then the disconnect", async () => {
    const id = await personalAccount(alice.userId)
    const res = await del(alice.bearer, id)
    expect(res.status).toBe(200)
    expect(hookCalls).toContain(id)
    expect(await statusOf(id)).toBe("disconnected")
  })

  it("an unknown id: 404, no cleanup", async () => {
    const id = crypto.randomUUID()
    expect((await del(alice.bearer, id)).status).toBe(404)
    expect(hookCalls).not.toContain(id)
  })
})
