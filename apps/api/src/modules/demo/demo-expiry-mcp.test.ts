// SPDX-License-Identifier: FSL-1.1-ALv2
// On a demo instance an EXPIRED visitor workspace refuses every credential it
// ever issued (demo-expiry.ts). The session middleware enforces that; the MCP
// transport and the MCP token endpoint authenticate through their own path and
// must enforce it too.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo } from "~/modules/demo/demo-org"
import { createMcpConnection, mintAccessToken } from "~/modules/mcp/connection-service"
import { cleanupSeededOrg, grantScope, seedOrgWithUser } from "~/modules/mcp/test-helpers"

let orgId = ""
let userId = ""
let mcpToken = ""
let refreshToken = ""

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  ;({ orgId, userId } = await seedOrgWithUser())
  await grantScope(orgId, userId, "kernel:threads:read")
  const conn = await createMcpConnection({
    orgId,
    userId,
    clientId: "expiry-probe",
    label: "Probe",
  })
  refreshToken = conn.refreshToken
  mcpToken = (await mintAccessToken(conn.connection.id)).token
  const past = Date.now() - 3 * 24 * 3600_000
  await markOrgAsDemo(orgId, {
    variant: "visitor",
    createdAt: new Date(past).toISOString(),
    expiresAt: new Date(past + 3600_000).toISOString(),
  })
  invalidateDemoMarker(orgId)
})

afterAll(async () => {
  DemoModeTestAccess.set(null)
  invalidateDemoMarker(orgId)
  await cleanupSeededOrg(orgId)
})

describe("an expired demo workspace and its MCP credentials", () => {
  it("the session middleware refuses the workspace (positive control)", async () => {
    const bearer = await signAccessToken(
      {
        userId,
        orgId,
        name: "Conn User",
        authVersion: 1,
        permissionVersion: 1,
        roles: [],
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
      600,
    )
    const res = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${bearer}` },
    })
    expect(res.status).toBe(403)
  })

  it("the MCP transport refuses an access token minted before expiry", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${mcpToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    })
    expect(res.status === 401 || res.status === 403).toBe(true)
  })

  it("the MCP token endpoint mints nothing from a refresh token of the expired workspace", async () => {
    const res = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    })
    expect(res.status).not.toBe(200)
  })
})
