// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An expired demo workspace must refuse every credential it issued, on every
// route that accepts one, not only the routes behind the demo-aware `authMw`
// (security pass, demo-and-selfhost). The auth-plumbing mounts compose the RAW
// authMiddleware, and login, refresh, the websocket and MCP never touch it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { DEMO_WORKSPACE_EXPIRED_CODE } from "@liaison/shared"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { authMiddleware } from "~/middleware/auth"
import { errorHandler } from "~/middleware/error-handler"
import { createSession, refreshSession } from "~/modules/auth/auth"
import { isUserAuthCurrent } from "~/modules/auth/auth-state"
import { signAccessToken } from "~/modules/auth/jwt"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { refreshAccessToken, resolveConnectionFromToken } from "~/modules/mcp/connection-service"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const HOUR = 60 * 60 * 1000

describe("an expired demo workspace refuses every credential it issued", () => {
  let orgId: string
  let userId: string
  let accessToken: string
  let refreshToken: string

  beforeAll(async () => {
    await acquireTestLock()
    ;({ id: orgId } = await createTestOrg())
    const [u] = await withSystemDb("test-user", (db) => db.select({ id: users.id }).from(users))
    userId = u.id
    DemoModeTestAccess.set(true)
    // Credentials minted while the workspace was still alive.
    await markOrgAsDemo(orgId, visitorMarker(72))
    invalidateDemoMarker()
    const pair = await createSession(userId, orgId)
    accessToken = pair.accessToken
    refreshToken = pair.refreshToken
  }, 60_000)

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    invalidateDemoMarker()
    await releaseTestLock()
  })

  function expire(): Promise<void> {
    return markOrgAsDemo(orgId, visitorMarker(72, new Date(Date.now() - 73 * HOUR))).then(() =>
      invalidateDemoMarker(),
    )
  }

  function rawAuthApp() {
    // The RAW middleware, exactly as the auth-plumbing mounts use it.
    const a = new Hono<AppEnv>()
    a.onError(errorHandler)
    a.use("*", authMiddleware(env.JWT_SECRET))
    a.get("/thing", (c) => c.json({ ok: true }))
    return a
  }

  it("works while the workspace is alive", async () => {
    const res = await rawAuthApp().request("/thing", {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(200)
    expect(await isUserAuthCurrent({ userId, orgId })).toBe(true)
  })

  it("then refuses a bearer token on the RAW auth middleware", async () => {
    await expire()
    const res = await rawAuthApp().request("/thing", {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code?: string; message: string } }
    // The client tells this refusal apart from any other 403 by its code.
    expect(body.error.code).toBe(DEMO_WORKSPACE_EXPIRED_CODE)
    expect(body.error.message).toMatch(/expired/i)
  })

  it("mints no new session (login, OAuth and magic link all go through createSession)", async () => {
    await expect(createSession(userId, orgId)).rejects.toThrow(/expired/i)
  })

  it("refuses to refresh a session issued before expiry, with the same code", async () => {
    const a = new Hono<AppEnv>()
    a.onError(errorHandler)
    a.post("/refresh", async (c) => c.json(await refreshSession(refreshToken)))
    const res = await a.request("/refresh", { method: "POST" })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code?: string } }
    expect(body.error.code).toBe(DEMO_WORKSPACE_EXPIRED_CODE)
  })

  it("makes a websocket ticket / live socket no longer current", async () => {
    expect(await isUserAuthCurrent({ userId, orgId }, { forceFresh: true })).toBe(false)
  })

  it("refuses an MCP token minted before expiry, and an MCP refresh", async () => {
    const mcpToken = await signAccessToken(
      {
        userId,
        orgId,
        name: "mcp",
        authVersion: 1,
        permissionVersion: 1,
        scopes: [],
        mcpConnectionId: "00000000-0000-4000-8000-000000000001",
      },
      env.JWT_SECRET,
    )
    await expect(resolveConnectionFromToken(mcpToken)).rejects.toThrow(/expired/i)
    await expect(refreshAccessToken("not-a-real-refresh-token")).rejects.toThrow()
  })

  it("leaves the same org alone once demo mode is off", async () => {
    DemoModeTestAccess.set(false)
    const res = await rawAuthApp().request("/thing", {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    expect(res.status).toBe(200)
    DemoModeTestAccess.set(true)
  })
})
