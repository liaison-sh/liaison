// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S1, S3, A3, A7: receipt-only device credentials, POST /api/notifications/receipts
// and GET /api/notifications/devices. The receipt's identity comes from the
// credential, never from the body.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { createSession } from "~/modules/auth/auth"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("notification receipts and device credentials", () => {
  let me: minimal.Session
  let other: minimal.Session

  const call = (path: string, method: string, bearer: string | null, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data

  async function iosDevice(session: minimal.Session, token = `tok-${crypto.randomUUID()}`) {
    const res = await call("/api/push/tokens", "POST", session.bearer, {
      platform: "ios",
      token,
      environment: "sandbox",
    })
    expect(res.status).toBe(201)
    const d = await data(res)
    return { deviceId: d.id as string, credential: d.receiptCredential as string, token }
  }

  async function desktopDevice(session: minimal.Session, deviceId = `desk-${crypto.randomUUID()}`) {
    const res = await call("/api/notifications/desktop-devices", "POST", session.bearer, {
      deviceId,
      os: "macos",
      appVersion: "0.1.19",
      notificationPermission: "granted",
    })
    expect(res.status).toBe(201)
    return { deviceId, credential: (await data(res)).receiptCredential as string }
  }

  async function browserDevice(session: minimal.Session, deviceId = `web-${crypto.randomUUID()}`) {
    const res = await call("/api/notifications/browser-subscriptions", "POST", session.bearer, {
      deviceId,
      subscription: {
        endpoint: `https://push.example/${deviceId}`,
        keys: { p256dh: "BPub", auth: "authsecret" },
      },
      userAgent: "Chrome",
    })
    expect(res.status).toBe(201)
    return { deviceId, credential: (await data(res)).receiptCredential as string }
  }

  async function delivered(
    session: minimal.Session,
    deviceId: string,
    surface: string,
    channel = "push",
  ): Promise<string> {
    const nid = crypto.randomUUID()
    await sql`INSERT INTO kernel.notification_deliveries
      (org_id, user_id, notification_id, device_id, surface, channel, result)
      VALUES (${session.orgId}, ${session.userId}, ${nid}, ${deviceId}, ${surface}, ${channel}, 'accepted')`
    return nid
  }

  const receipt = (credential: string, body: Record<string, unknown>) =>
    call("/api/notifications/receipts", "POST", credential, body)

  const stored = async (nid: string) =>
    sql<Array<{ user_id: string; device_id: string; outcome: string; reason: string | null }>>`
      SELECT user_id, device_id, outcome, reason FROM kernel.notification_receipts
       WHERE notification_id = ${nid}`

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    me = await minimal.session(org.id)
    other = await minimal.session(org.id)
  })

  beforeEach(async () => {
    for (const s of [me, other]) {
      await sql`DELETE FROM kernel.notification_receipts WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.notification_deliveries WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.notification_device_credentials WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.desktop_devices WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.browser_push_subscriptions WHERE user_id = ${s.userId}`
      await sql`DELETE FROM kernel.push_tokens WHERE user_id = ${s.userId}`
    }
  })

  afterAll(async () => {
    if (me) {
      await sql`DELETE FROM kernel.notification_receipts WHERE org_id = ${me.orgId}`
      await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${me.orgId}`
      await sql`DELETE FROM kernel.notification_device_credentials WHERE org_id = ${me.orgId}`
      await sql`DELETE FROM kernel.desktop_devices WHERE org_id = ${me.orgId}`
      await sql`DELETE FROM kernel.browser_push_subscriptions WHERE org_id = ${me.orgId}`
      await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${me.orgId}`
    }
    await releaseTestLock()
  })

  it("takes the user from the credential: a forged user_id in the body is ignored", async () => {
    const dev = await iosDevice(me)
    const nid = await delivered(me, dev.deviceId, "ios")
    const res = await receipt(dev.credential, {
      notificationId: nid,
      deviceId: dev.deviceId,
      surface: "ios",
      appState: "background",
      outcome: "received",
      userId: other.userId,
      user_id: other.userId,
      orgId: "00000000-0000-0000-0000-000000000000",
    })
    expect(res.status).toBe(200)
    const rows = await stored(nid)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      user_id: me.userId,
      device_id: dev.deviceId,
      outcome: "received",
    })
  })

  it("a credential for device A cannot write device B (403)", async () => {
    const a = await desktopDevice(me)
    const b = await desktopDevice(me)
    const nid = await delivered(me, b.deviceId, "desktop", "desktop")
    const res = await receipt(a.credential, {
      notificationId: nid,
      deviceId: b.deviceId,
      surface: "desktop",
      outcome: "shown",
    })
    expect(res.status).toBe(403)
    expect(await stored(nid)).toHaveLength(0)
  })

  it("a notificationId with no delivery row for the device gets 404, on all three surfaces", async () => {
    const ios = await iosDevice(me)
    const desk = await desktopDevice(me)
    const web = await browserDevice(me)
    // A real delivery, but to ANOTHER device: still no row for this one.
    const elsewhere = await delivered(me, desk.deviceId, "desktop", "desktop")
    for (const [dev, surface] of [
      [ios, "ios"],
      [desk, "desktop"],
      [web, "browser_push"],
    ] as const) {
      const unknown = await receipt(dev.credential, {
        notificationId: crypto.randomUUID(),
        deviceId: dev.deviceId,
        surface,
        outcome: "shown",
      })
      expect(unknown.status).toBe(404)
    }
    const res = await receipt(ios.credential, {
      notificationId: elsewhere,
      deviceId: ios.deviceId,
      surface: "ios",
      outcome: "shown",
    })
    expect(res.status).toBe(404)
  })

  it("precedence: received then shown gives shown; shown then received stays shown", async () => {
    const dev = await iosDevice(me)
    const n1 = await delivered(me, dev.deviceId, "ios")
    const n2 = await delivered(me, dev.deviceId, "ios")
    const post = (nid: string, outcome: string, reason?: string) =>
      receipt(dev.credential, {
        notificationId: nid,
        deviceId: dev.deviceId,
        surface: "ios",
        outcome,
        ...(reason ? { reason } : {}),
      })
    expect((await post(n1, "received")).status).toBe(200)
    expect((await post(n1, "shown")).status).toBe(200)
    expect((await stored(n1))[0].outcome).toBe("shown")

    expect((await post(n2, "shown")).status).toBe(200)
    expect((await post(n2, "received")).status).toBe(200)
    expect((await stored(n2))[0].outcome).toBe("shown")
    // suppressed outranks shown; nothing outranks suppressed.
    expect((await post(n2, "suppressed", "on_screen")).status).toBe(200)
    expect((await post(n2, "shown")).status).toBe(200)
    expect([...(await stored(n2))]).toEqual([
      { user_id: me.userId, device_id: dev.deviceId, outcome: "suppressed", reason: "on_screen" },
    ])
  })

  it("a revoked credential gets 401: re-registration, token deletion, logout", async () => {
    // Re-registration rotates: the old credential dies, the new one works.
    const first = await iosDevice(me, "rotating-token")
    const second = await iosDevice(me, "rotating-token")
    expect(second.deviceId).toBe(first.deviceId)
    const nid = await delivered(me, first.deviceId, "ios")
    const body = { notificationId: nid, deviceId: first.deviceId, surface: "ios", outcome: "shown" }
    expect((await receipt(first.credential, body)).status).toBe(401)
    expect((await receipt(second.credential, body)).status).toBe(200)

    // Deleting the push token revokes its credential.
    const del = await call("/api/push/tokens", "DELETE", me.bearer, {
      platform: "ios",
      token: "rotating-token",
    })
    expect(del.status).toBe(204)
    expect((await receipt(second.credential, body)).status).toBe(401)

    // Logout names the device it signs out of.
    const desk = await desktopDevice(me)
    const dn = await delivered(me, desk.deviceId, "desktop", "desktop")
    const tokens = await createSession(me.userId, me.orgId)
    const out = await call("/api/auth/logout", "POST", null, {
      refreshToken: tokens.refreshToken,
      deviceId: desk.deviceId,
    })
    expect(out.status).toBe(200)
    expect(
      (
        await receipt(desk.credential, {
          notificationId: dn,
          deviceId: desk.deviceId,
          surface: "desktop",
          outcome: "shown",
        })
      ).status,
    ).toBe(401)

    // A phone leaving a server it is not on signs out by its refresh token
    // alone and names its device: the push row goes with the session.
    const phone = await iosDevice(me, "leaving-token")
    const phoneTokens = await createSession(me.userId, me.orgId)
    const left = await call("/api/auth/logout", "POST", null, {
      refreshToken: phoneTokens.refreshToken,
      deviceId: phone.deviceId,
    })
    expect(left.status).toBe(200)
    const rows = await sql`SELECT id FROM kernel.push_tokens WHERE id = ${phone.deviceId}`
    expect(rows).toHaveLength(0)

    // A garbage credential, and none at all.
    expect((await receipt("lnr_nope", body)).status).toBe(401)
    expect((await call("/api/notifications/receipts", "POST", null, body)).status).toBe(401)
  })

  it("a credential only works on the server origin that issued it (A7)", async () => {
    const dev = await iosDevice(me)
    const nid = await delivered(me, dev.deviceId, "ios")
    const body = {
      notificationId: nid,
      deviceId: dev.deviceId,
      surface: "ios",
      outcome: "received",
    }
    expect((await receipt(dev.credential, body)).status).toBe(200)
    await sql`UPDATE kernel.notification_device_credentials SET server_origin = 'https://other.example'
               WHERE user_id = ${me.userId} AND device_id = ${dev.deviceId}`
    expect((await receipt(dev.credential, { ...body, outcome: "shown" })).status).toBe(401)
  })

  it("issues a credential only for the caller's own registered device", async () => {
    const mine = await iosDevice(me)
    const res = await call(
      `/api/notifications/devices/${mine.deviceId}/credential`,
      "POST",
      other.bearer,
      { surface: "ios" },
    )
    expect(res.status).toBe(404)
    const ok = await call(
      `/api/notifications/devices/${mine.deviceId}/credential`,
      "POST",
      me.bearer,
      { surface: "ios" },
    )
    expect(ok.status).toBe(201)
    const fresh = (await data(ok)).receiptCredential as string
    const nid = await delivered(me, mine.deviceId, "ios")
    const body = { notificationId: nid, deviceId: mine.deviceId, surface: "ios", outcome: "shown" }
    // Issuing rotates: the registration's credential is revoked.
    expect((await receipt(mine.credential, body)).status).toBe(401)
    expect((await receipt(fresh, body)).status).toBe(200)
  })

  it("the device list shows the 3 surfaces with their last delivery and last receipt", async () => {
    const ios = await iosDevice(me)
    const desk = await desktopDevice(me)
    const web = await browserDevice(me)
    await desktopDevice(other)
    const nid = await delivered(me, desk.deviceId, "desktop", "desktop")
    await receipt(desk.credential, {
      notificationId: nid,
      deviceId: desk.deviceId,
      surface: "desktop",
      outcome: "suppressed",
      reason: "on_screen",
    })
    const res = await call("/api/notifications/devices", "GET", me.bearer)
    expect(res.status).toBe(200)
    const list = (await data(res)) as Array<{
      deviceId: string
      surface: string
      lastDelivery: { notificationId: string; result: string } | null
      lastReceipt: { notificationId: string; outcome: string; reason: string | null } | null
    }>
    expect(list.map((d) => [d.surface, d.deviceId]).sort()).toEqual(
      [
        ["browser", web.deviceId],
        ["desktop", desk.deviceId],
        ["ios", ios.deviceId],
      ].sort(),
    )
    const d = list.find((x) => x.deviceId === desk.deviceId)
    expect(d?.lastDelivery).toMatchObject({ notificationId: nid, result: "accepted" })
    expect(d?.lastReceipt).toMatchObject({
      notificationId: nid,
      outcome: "suppressed",
      reason: "on_screen",
    })
    expect(list.find((x) => x.deviceId === ios.deviceId)?.lastReceipt).toBeNull()
  })
})
