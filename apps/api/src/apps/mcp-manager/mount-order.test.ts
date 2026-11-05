// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Through the WHOLE app, not the mcp-manager router alone: the generic app
// route `GET /api/apps/:appName/connections` (connected-account views of an
// app's manifest connections) matched `/api/apps/mcp-manager/connections`
// first, so Settings > MCP servers and My connections listed nothing at all,
// however many connections existed. The router-level tests could not see it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"

const ORG = "00000000-0000-0000-0000-00000f7a1c01"
const MEMBER = "00000000-0000-0000-0000-00000f7a1c02"

describe("mcp-manager routes under /api/apps", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Mount order', 'mcp-mount-order') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${MEMBER}, ${ORG}, 'mount-order@test.com', 'Member', 'active', 'hash')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO app_mcp_manager.mcp_connections
        (org_id, slug, display_name, transport, ownership_scope, owner_user_id, http_url,
         auth_flavor, managed_by, created_by)
      VALUES (${ORG}, 'mine-walk', 'Mine', 'http', 'personal', ${MEMBER},
        'https://mcp.example.com/mcp', 'none', 'ui', ${MEMBER})`
    await sql`INSERT INTO app_mcp_manager.mcp_connections
        (org_id, slug, display_name, transport, ownership_scope, owner_user_id, http_url,
         auth_flavor, managed_by, created_by)
      VALUES (${ORG}, 'mine-oauth', 'Mine OAuth', 'http', 'personal', ${MEMBER},
        'https://mcp-oauth.example.com/mcp', 'oauth_dcr', 'ui', ${MEMBER})`
  })
  afterAll(async () => {
    await sql`DELETE FROM app_mcp_manager.mcp_connections WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("GET /api/apps/mcp-manager/connections reaches the mcp-manager list (the owner sees their personal row)", async () => {
    const token = await signAccessToken(
      {
        userId: MEMBER,
        orgId: ORG,
        name: "Member",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["mcp_manager:connection:read", "mcp_manager:personal_connection:write"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/apps/mcp-manager/connections", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ slug: string; ownershipScope: string }> }
    expect(body.data.map((r) => [r.slug, r.ownershipScope]).sort()).toEqual([
      ["mine-oauth", "personal"],
      ["mine-walk", "personal"],
    ])
  })

  // An OAuth connection with no token yet (sign-in abandoned, or never done) is
  // "oauth_pending": that status is what shows "Sign in" in both lists. The
  // server never set it, so such a row had no way back but delete and re-add.
  it("an OAuth connection without a token lists as oauth_pending; a no-auth one does not", async () => {
    const token = await signAccessToken(
      {
        userId: MEMBER,
        orgId: ORG,
        name: "Member",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["mcp_manager:connection:read", "mcp_manager:personal_connection:write"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    const res = await app.request("/api/apps/mcp-manager/connections", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { data: Array<{ slug: string; status: string }> }
    const status = Object.fromEntries(body.data.map((r) => [r.slug, r.status]))
    expect(status["mine-oauth"]).toBe("oauth_pending")
    expect(status["mine-walk"]).not.toBe("oauth_pending")
  })

  // An authorization server fetches the Client ID Metadata Document with no
  // Liaison session: the route must sit outside the bearer chain (HB-3).
  it("the client metadata document is reachable without a session", async () => {
    const { OAuthRegistrationTestAccess } = await import("./oauth-registration")
    OAuthRegistrationTestAccess.setPublicBaseUrl("https://liaison.example")
    try {
      const res = await app.request("/api/apps/mcp-manager/oauth/client-metadata.json")
      expect(res.status).toBe(200)
      const doc = (await res.json()) as { client_id: string; redirect_uris: string[] }
      expect(doc.client_id).toBe(
        "https://liaison.example/api/apps/mcp-manager/oauth/client-metadata.json",
      )
      expect(doc.redirect_uris).toEqual([
        "https://liaison.example/api/apps/mcp-manager/oauth/callback",
      ])
    } finally {
      OAuthRegistrationTestAccess.setPublicBaseUrl(null)
    }
    // Without a public BASE_URL there is no document to serve.
    const none = await app.request("/api/apps/mcp-manager/oauth/client-metadata.json")
    expect(none.status).toBe(404)
  })

  it("the session bypass covers the client metadata document only, not paths under it", async () => {
    const res = await app.request("/api/apps/mcp-manager/oauth/client-metadata.json/other")
    expect(res.status).toBe(401)
  })
})
