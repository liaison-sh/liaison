// SPDX-License-Identifier: FSL-1.1-ALv2
//
// fix2-F1: a Web Push endpoint belongs to exactly one user. A browser keeps
// its push subscription across sessions, so when user B registers the endpoint
// user A registered before (A's session ended without a sign-out, e.g. a
// rejected refresh token), A's row must stop holding it, A's receipt
// credential for that browser must die, and A's notifications must no longer
// reach that browser. Real routes and rows, across two orgs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { loadWebPushSubscriptions } from "~/modules/push/web-push"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { issueDeviceCredential, verifyDeviceCredential } from "./devices"

// User A lives in a second org, made by hand: the test org factory keeps one
// org per database, and the leak crosses orgs as easily as users.
const ORG_X = "00000000-0000-0000-0000-00000000f1a0"
const USER_X = "00000000-0000-0000-0000-00000000f1a1"

describe("a Web Push endpoint has one owner (fix2-F1)", () => {
  let a: minimal.Session
  let b: minimal.Session

  const register = async (session: minimal.Session, deviceId: string, endpoint: string | null) => {
    const res = await app.request("/api/notifications/browser-subscriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        subscription: endpoint
          ? { endpoint, keys: { p256dh: `p-${session.userId}`, auth: `a-${session.userId}` } }
          : null,
      }),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { data: { receiptCredential: string } }).data.receiptCredential
  }

  const endpointsOf = async (s: minimal.Session) =>
    (await loadWebPushSubscriptions(s.orgId, s.userId)).map((r) => r.endpoint)

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    a = await minimal.session(org.id)
    b = await minimal.session(org.id)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_X}, 'EndpointOrg', 'endpoint-owner-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_X}, ${ORG_X}, 'endpoint-owner@t.com', 'Xavier', 'x') ON CONFLICT (id) DO NOTHING`
  })

  beforeEach(async () => {
    for (const userId of [a.userId, b.userId, USER_X]) {
      await sql`DELETE FROM kernel.notification_device_credentials WHERE user_id = ${userId}`
      await sql`DELETE FROM kernel.browser_push_subscriptions WHERE user_id = ${userId}`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.notification_device_credentials WHERE org_id = ${ORG_X}`
    await sql`DELETE FROM kernel.browser_push_subscriptions WHERE org_id = ${ORG_X}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER_X}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_X}`
    await releaseTestLock()
  })

  it("B registering A's endpoint (A in another org) takes it: A's row drops it, A's credential dies, A's sends skip it", async () => {
    const endpoint = `https://push.example/shared-${crypto.randomUUID()}`
    const deviceId = `web-${crypto.randomUUID()}`
    // A's browser registration, as the route leaves it.
    await sql`INSERT INTO kernel.browser_push_subscriptions
      (org_id, user_id, device_id, endpoint, p256dh, auth)
      VALUES (${ORG_X}, ${USER_X}, ${deviceId}, ${endpoint}, 'pA', 'aA')`
    const aCred = await issueDeviceCredential({
      orgId: ORG_X,
      userId: USER_X,
      deviceId,
      surface: "browser",
    })
    expect((await loadWebPushSubscriptions(ORG_X, USER_X)).map((r) => r.endpoint)).toEqual([
      endpoint,
    ])

    // The same browser, now signed in as B, registers its (unchanged) subscription.
    const bCred = await register(b, deviceId, endpoint)

    // A no longer targets that browser: the Web Push sender reads exactly this.
    expect(await loadWebPushSubscriptions(ORG_X, USER_X)).toEqual([])
    const [aRow] = await sql<Array<{ endpoint: string | null; p256dh: string | null }>>`
      SELECT endpoint, p256dh FROM kernel.browser_push_subscriptions
       WHERE user_id = ${USER_X} AND device_id = ${deviceId}`
    expect(aRow).toEqual({ endpoint: null, p256dh: null })
    // A's receipt credential for that browser is revoked; B's works.
    expect(await verifyDeviceCredential(aCred)).toBeNull()
    expect(await verifyDeviceCredential(bCred)).toMatchObject({ userId: b.userId, deviceId })
    expect(await endpointsOf(b)).toEqual([endpoint])
  })

  it("within one org, through the route for both: the previous user's row is cleared", async () => {
    const endpoint = `https://push.example/shared-${crypto.randomUUID()}`
    const aCred = await register(a, `web-${crypto.randomUUID()}`, endpoint)
    await register(b, `web-${crypto.randomUUID()}`, endpoint)
    expect(await endpointsOf(a)).toEqual([])
    expect(await endpointsOf(b)).toEqual([endpoint])
    expect(await verifyDeviceCredential(aCred)).toBeNull()
  })

  it("a re-registration by the owner keeps its endpoint and credential flow", async () => {
    const endpoint = `https://push.example/own-${crypto.randomUUID()}`
    const deviceId = `web-${crypto.randomUUID()}`
    await register(a, deviceId, endpoint)
    const cred = await register(a, deviceId, endpoint)
    expect(await endpointsOf(a)).toEqual([endpoint])
    expect(await verifyDeviceCredential(cred)).toMatchObject({ userId: a.userId })
  })

  it("the database refuses two rows on one endpoint", async () => {
    const endpoint = `https://push.example/dup-${crypto.randomUUID()}`
    await register(a, `web-${crypto.randomUUID()}`, endpoint)
    let failed = false
    try {
      await sql`INSERT INTO kernel.browser_push_subscriptions (org_id, user_id, device_id, endpoint)
        VALUES (${ORG_X}, ${USER_X}, ${`web-${crypto.randomUUID()}`}, ${endpoint})`
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})
