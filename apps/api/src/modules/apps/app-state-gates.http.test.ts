// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S19 / A6 / A24-3 / D24: an app turned Off for the workspace is refused at
// every HTTP chokepoint, from the persisted state (a cold process included),
// and comes back on re-enable with no restart:
//  - the manifest feed omits it for every user and names it in unavailableApps,
//  - its own /api/apps/:app/* routes answer 410 app_disabled (admins keep the
//    read-only config read), the kernel-mounted prefix (/api/mail) likewise,
//  - its first-party public endpoints (tickets create) answer 503 app_disabled,
//  - a third-party webhook delivery is acknowledged 200 and dropped (counted),
//    BEFORE the registration lookup,
//  - a scope request for its scopes is refused in words.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { APP_DISABLED_CODE } from "@liaison/shared"
import { app } from "~/app"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { webhooksDroppedAppDisabledCount } from "~/modules/webhooks/routes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let admin: minimal.Session
let member: minimal.Session

/**
 * Every On/Off change bumps the org's permission_version (A24-5), so a token
 * minted before it is refused: re-mint both sessions' tokens after a change.
 */
async function setStatus(appName: string, status: "active" | "disabled"): Promise<void> {
  await setOrgAppStatus(admin.orgId, appName, status)
  admin = { ...admin, bearer: await minimal.token(admin.userId) }
  member = { ...member, bearer: await minimal.token(member.userId) }
}

function call(path: string, s: minimal.Session | null, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(s ? { Authorization: `Bearer ${s.bearer}` } : {}),
      ...(init.headers ?? {}),
    },
  })
}

async function manifests(s: minimal.Session): Promise<{ names: string[]; unavailable: string[] }> {
  const res = await call("/api/apps/manifests", s)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: Array<{ name: string }>; unavailableApps: string[] }
  return { names: body.data.map((d) => d.name), unavailable: body.unavailableApps }
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code
}

beforeAll(async () => {
  await acquireTestLock()
  admin = await minimal.adminSession((await createTestOrg()).id)
  member = await minimal.session(admin.orgId, { role: "member" })
}, 120_000)

afterEach(async () => {
  for (const a of ["tickets", "mail"]) await setStatus(a, "active")
})

afterAll(releaseTestLock)

describe("Off app: HTTP chokepoints", () => {
  it("the manifest feed omits an Off app for every user and names it unavailable; re-enable restores", async () => {
    expect((await manifests(admin)).names).toContain("tickets")
    await setStatus("tickets", "disabled")
    for (const s of [admin, member]) {
      const m = await manifests(s)
      expect(m.names).not.toContain("tickets")
      expect(m.unavailable).toContain("tickets")
    }
    await setStatus("tickets", "active")
    const back = await manifests(admin)
    expect(back.names).toContain("tickets")
    expect(back.unavailable).not.toContain("tickets")
  }, 60_000)

  it("its /api/apps/:app routes answer 410 app_disabled; an admin keeps the config read", async () => {
    await setStatus("tickets", "disabled")
    forgetOrgApps(admin.orgId) // a cold process: the gate loads the persisted state
    const tool = await call("/api/apps/tickets/tools/tickets_list", member, {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(tool.status).toBe(410)
    expect(await errorCode(tool)).toBe(APP_DISABLED_CODE)
    const memberConfig = await call("/api/apps/tickets/config", member)
    expect(memberConfig.status).toBe(410)
    const adminConfig = await call("/api/apps/tickets/config", admin)
    expect(adminConfig.status).toBe(200)
    const adminTool = await call("/api/apps/tickets/tools/tickets_list", admin, {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(adminTool.status).toBe(410)

    await setStatus("tickets", "active")
    const again = await call("/api/apps/tickets/config", member)
    expect(again.status).not.toBe(410)
  }, 60_000)

  it("a kernel-mounted app prefix (/api/mail) answers 410 while mail is Off", async () => {
    const before = await call("/api/mail/conversations", admin)
    expect(before.status).not.toBe(410)
    await setStatus("mail", "disabled")
    const off = await call("/api/mail/conversations", admin)
    expect(off.status).toBe(410)
    expect(await errorCode(off)).toBe(APP_DISABLED_CODE)
  }, 60_000)

  it("the tickets public create endpoint answers 503 app_disabled while tickets is Off", async () => {
    await setStatus("tickets", "disabled")
    const res = await call(`/webhooks/${admin.orgId}/tickets/create`, null, {
      method: "POST",
      body: JSON.stringify({ subject: "Hello", body: "Help", email: "c@example.com" }),
    })
    expect(res.status).toBe(503)
    expect(await errorCode(res)).toBe(APP_DISABLED_CODE)
    await setStatus("tickets", "active")
    const on = await call(`/webhooks/${admin.orgId}/tickets/create`, null, {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(on.status).not.toBe(503)
  }, 60_000)

  it("a third-party webhook delivery is acknowledged 200 and dropped (counted), before the lookup", async () => {
    // On, an endpoint nobody registered is a 404: the lookup ran.
    const unknown = await call(`/webhooks/${admin.orgId}/mail/no-such-endpoint`, null, {
      method: "POST",
      body: "{}",
    })
    expect(unknown.status).toBe(404)
    await setStatus("mail", "disabled")
    const before = webhooksDroppedAppDisabledCount()
    const res = await call(`/webhooks/${admin.orgId}/mail/no-such-endpoint`, null, {
      method: "POST",
      body: "{}",
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, dropped: APP_DISABLED_CODE })
    expect(webhooksDroppedAppDisabledCount()).toBe(before + 1)
    const challenge = await call(
      `/webhooks/${admin.orgId}/mail/no-such-endpoint?hub.mode=subscribe&hub.challenge=x&hub.verify_token=t`,
      null,
    )
    expect(challenge.status).toBe(200)
  }, 60_000)

  it("a scope request for an Off app's scope is refused in words", async () => {
    await setStatus("tickets", "disabled")
    const res = await call("/api/scope-requests", member, {
      method: "POST",
      body: JSON.stringify({ scopes: ["tickets:tickets:read"], reason: "need it" }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "This app is turned off by your admin.",
    )
  }, 60_000)
})
