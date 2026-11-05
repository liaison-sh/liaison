// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A restricted device session end to end, through the real app: the client
// declares its scopes at initiate, a human approves, the poll hands back a
// token capped to them, a refresh keeps the cap, and the restricted token
// cannot mint anything wider (another device approval, an MCP consent, a
// desktop MCP connection). One rule: a restricted session mints no credential
// (modules/auth/session-ceiling.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { createSession } from "~/modules/auth/auth"
import { verifyAccessToken } from "~/modules/auth/jwt"
import { applyScopeCeiling } from "~/modules/auth/session-ceiling"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CLIENT = "test-restricted-cli"
let userId: string
let orgId: string
let fullToken: string

const json = (body: unknown, token?: string) => ({
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
})

async function initiate(scopes: string[] = ["kernel:threads:read"]) {
  const res = await app.request(
    "/api/auth/device-flow/initiate",
    json({ clientId: CLIENT, scopes }),
  )
  return { res, data: res.status === 200 ? ((await res.json()) as any).data : null }
}

async function approve(userCode: string, token: string) {
  return app.request(`/api/auth/device-flow/approve/${userCode}`, json({}, token))
}

async function poll(deviceCode: string) {
  await redis.del(`device-poll:${deviceCode}`)
  const res = await app.request(`/api/auth/device-flow/poll/${deviceCode}?client_id=${CLIENT}`)
  return ((await res.json()) as any).data as { accessToken: string; refreshToken: string }
}

/** A restricted token through the whole real flow. */
async function restrictedLogin(scopes: string[]) {
  const { data } = await initiate(scopes)
  expect((await approve(data.userCode, fullToken)).status).toBe(200)
  return poll(data.deviceCode)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = (await minimal.session(orgId, { role: "admin" })).userId
  fullToken = (await createSession(userId, orgId)).accessToken
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("declaring scopes at initiate", () => {
  it("initiate → approve → poll → refresh: the token holds exactly the declared scopes, and says it is restricted", async () => {
    const tokens = await restrictedLogin(["kernel:threads:read"])
    const first = await verifyAccessToken(tokens.accessToken, env.JWT_SECRET)
    expect(first.scopes).toEqual(["kernel:threads:read"])
    expect(first.restricted).toBe(true)

    const refreshed = await app.request(
      "/api/auth/refresh",
      json({ refreshToken: tokens.refreshToken }),
    )
    expect(refreshed.status).toBe(200)
    const again = await verifyAccessToken(
      ((await refreshed.json()) as any).data.accessToken,
      env.JWT_SECRET,
    )
    expect(again.scopes).toEqual(["kernel:threads:read"])
    expect(again.restricted).toBe(true)
  })

  it("refuses a malformed scope at initiate and an unknown one at approval", async () => {
    expect((await initiate(["*"])).res.status).toBe(400)
    expect((await initiate(["Not A Scope"])).res.status).toBe(400)
    const { data } = await initiate(["kernel:nothing:here"])
    expect((await approve(data.userCode, fullToken)).status).toBe(400)
  })

  it("an interactive session is not restricted", async () => {
    const payload = await verifyAccessToken(fullToken, env.JWT_SECRET)
    expect(payload.restricted).toBeUndefined()
  })
})

describe("a restricted session mints no credential", () => {
  let restricted: string

  beforeAll(async () => {
    restricted = (await restrictedLogin(["kernel:threads:read"])).accessToken
  })

  it("cannot approve a device sign-in, even one it started itself", async () => {
    const { data } = await initiate()
    const res = await approve(data.userCode, restricted)
    expect(res.status).toBe(403)
    // The flow stays pending: nothing was approved.
    const status = await app.request(
      `/api/auth/device-flow/poll/${data.deviceCode}?client_id=${CLIENT}`,
    )
    expect(((await status.json()) as any).data.status).toBe("authorization_pending")
  })

  it("cannot consent to an MCP client (which would carry the grantor's full grants)", async () => {
    const res = await app.request(
      "/mcp/oauth/authorize/consent?consent=approve&client_id=x&redirect_uri=http://localhost/cb&code_challenge=abc&code_challenge_method=S256&response_type=code",
      { method: "POST", headers: { Authorization: `Bearer ${restricted}` } },
    )
    expect(res.status).toBe(403)
  })

  it("cannot open a desktop MCP connection", async () => {
    const res = await app.request(
      "/mcp/desktop/connection",
      json({ agentId: crypto.randomUUID() }, restricted),
    )
    expect(res.status).toBe(403)
  })

  // Decisions are authorized on STORED grants (and the resource-owner branch
  // on no scope at all), so a restricted session would decide past its cap.
  it("cannot decide or edit an approval", async () => {
    const id = crypto.randomUUID()
    const decide = await app.request(
      `/api/approvals/${id}/decide`,
      json({ decision: "approve" }, restricted),
    )
    expect(decide.status).toBe(403)
    const edit = await app.request(`/api/approvals/${id}/payload`, json({ fields: {} }, restricted))
    expect(edit.status).toBe(403)
    // An unrestricted session reaches the handler (the approval does not exist).
    const full = await app.request(
      `/api/approvals/${id}/decide`,
      json({ decision: "approve" }, fullToken),
    )
    expect(full.status).not.toBe(403)
  })

  it("cannot register a push device (it would receive notifications past the cap)", async () => {
    const res = await app.request(
      "/api/push/tokens",
      json({ platform: "ios", token: `tok-${crypto.randomUUID()}` }, restricted),
    )
    expect(res.status).toBe(403)
  })

  it("cannot send itself a test notification (it would reach devices past the cap)", async () => {
    const res = await app.request("/api/notifications/test", json({}, restricted))
    expect(res.status).toBe(403)
  })

  it("cannot mint a WebSocket ticket (the ticket would not carry the restriction)", async () => {
    const res = await app.request("/api/auth/ws-ticket", json({}, restricted))
    expect(res.status).toBe(403)
  })

  it("cannot change the password or the account's sign-in factors", async () => {
    // The password change would hand back an unrestricted session, past the cap
    // and past any second factor. Refused before the password is even read.
    for (const [method, path, body] of [
      [
        "POST",
        "/api/auth/password/change",
        { currentPassword: "x".repeat(8), newPassword: "y".repeat(12) },
      ],
      ["POST", "/api/auth/totp/setup", { currentPassword: "x".repeat(8) }],
      ["POST", "/api/auth/totp/confirm", { code: "123456" }],
      ["DELETE", "/api/auth/totp", { currentPassword: "x".repeat(8) }],
      ["POST", "/api/auth/account/delete", { stepUpCode: "123456" }],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${restricted}` },
        body: JSON.stringify(body),
      })
      expect({ path, status: res.status }).toEqual({ path, status: 403 })
    }
  })

  it("an unrestricted session can mint a WebSocket ticket", async () => {
    const res = await app.request("/api/auth/ws-ticket", json({}, fullToken))
    expect(res.status).toBe(200)
  })

  it("an unrestricted session still can (the guard is on the restriction, not the route)", async () => {
    const { data } = await initiate()
    expect((await approve(data.userCode, fullToken)).status).toBe(200)
  })
})

describe("applyScopeCeiling", () => {
  it("never exceeds either side, hierarchically", () => {
    expect(applyScopeCeiling(["kernel"], ["kernel:threads:read"])).toEqual(["kernel:threads:read"])
    expect(applyScopeCeiling(["kernel:threads:read"], ["kernel:threads"])).toEqual([
      "kernel:threads:read",
    ])
    expect(applyScopeCeiling(["tickets"], ["kernel:threads:read"])).toEqual([])
    expect(applyScopeCeiling(["a", "b"], null)).toEqual(["a", "b"])
  })
})
