// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db/connection"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { signAccessToken } from "~/modules/auth/jwt"
import testManifest from "../../test-support/apps/test/app.manifest.json"

const TEST_ORG = "00000000-0000-0000-0000-000000210001"
const TEST_USER = "00000000-0000-0000-0000-000000210002"
const MOCK_CLIENT_SECRET = "test-client-secret"

async function apiRequest(
  path: string,
  opts: {
    method?: string
    body?: unknown
    scopes?: string[]
    dimensionGrants?: Record<string, string[]>
  } = {},
) {
  const token = await signAccessToken(
    {
      userId: TEST_USER,
      orgId: TEST_ORG,
      name: "Test User",
      authVersion: 1,
      permissionVersion: 1,
      scopes: opts.scopes ?? [],
      dimensionGrants: opts.dimensionGrants ?? {},
    },
    env.JWT_SECRET,
  )
  return app.request(path, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-org-id": TEST_ORG,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

describe("sandbox integration — end-to-end via HTTP", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Integration Test Org', 'integration-sandbox')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'integ-sandbox@test.com', 'hash', 'Integ', 'active')
      ON CONFLICT (id) DO NOTHING`
    // Insert a mock oauth_provider for "test:gitlab" so the OAuth authorize flow can build a real URL
    await sql`INSERT INTO kernel.oauth_providers (org_id, name, issuer_url, client_id, client_secret_encrypted)
      VALUES (
        ${TEST_ORG},
        'test:gitlab',
        'https://gitlab.com',
        'test-client-id',
        ${encryptSecret(MOCK_CLIENT_SECRET, env.ENCRYPTION_KEY, CryptoContext.oauthProviderClientSecret)}
      )
      ON CONFLICT DO NOTHING`
    await initSandboxPool()
    const manifest = {
      ...testManifest,
      _format: "manifest",
      _bundlePath: new URL("../../test-support/apps/test/handler-bundle.ts", import.meta.url)
        .pathname,
    }
    await registerApps([manifest as any], TEST_ORG)
  })

  afterAll(async () => {
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_test" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE org_id = ${TEST_ORG}`
    await sql`DELETE FROM kernel.oauth_providers WHERE org_id = ${TEST_ORG} AND name = 'test:gitlab'`
    await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("POST /api/apps/tools/test:listItems → returns array through sandbox", async () => {
    const res = await apiRequest("/api/apps/tools/test:listItems", {
      method: "POST",
      body: {},
      scopes: ["test:items:read"],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
  })

  it("POST /api/apps/tools/test:createItem → createItem round-trip through sandbox + RLS", async () => {
    const res = await apiRequest("/api/apps/tools/test:createItem", {
      method: "POST",
      body: { title: "Integration Item", team: "engineering" },
      scopes: ["test:items:write"],
      dimensionGrants: {
        "test:team": ["engineering"],
        "test:sensitivity": ["public", "internal", "confidential"],
      },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.title).toBe("Integration Item")
    expect(body.data.id).toBeDefined()
  })

  it("scope enforcement returns 403 through HTTP path", async () => {
    const res = await apiRequest("/api/apps/tools/test:createItem", {
      method: "POST",
      body: { title: "Should fail", team: "eng" },
      scopes: ["test:items:read"], // Missing write scope
    })
    expect(res.status).toBe(403)
  })

  it("dimension filtering applied through sandbox to HTTP response", async () => {
    const res = await apiRequest("/api/apps/tools/test:externalSearch", {
      method: "POST",
      body: { query: "search" },
      scopes: ["test:external:read"],
      dimensionGrants: { "test:market": ["us"] },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.every((i: any) => i.market === "us")).toBe(true)
  })

  it("OAuth authorize endpoint returns a real GitLab authorization URL with PKCE params", async () => {
    const res = await apiRequest("/api/connections/test/gitlab/authorize", {
      method: "POST",
      scopes: [],
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    const redirectUrl: string = body.data.redirectUrl
    expect(redirectUrl).toBeDefined()

    // Must be the real GitLab authorize URL (not the placeholder)
    const url = new URL(redirectUrl)
    expect(url.hostname).toBe("gitlab.com")
    expect(url.pathname).toBe("/oauth/authorize")

    // PKCE params must be present
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBeTruthy()
    expect(url.searchParams.get("client_id")).toBe("test-client-id")
    expect(url.searchParams.get("redirect_uri")).toContain("/api/connections/callback")
    expect(url.searchParams.get("scope")).toBe("read_api")
  })
})
