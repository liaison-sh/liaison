// SPDX-License-Identifier: FSL-1.1-ALv2
//
// OAuth through a central redirect host (LIAISON_OAUTH_REDIRECT_BASE). With it
// set, providers send every grant back to one registered URI on that host, the
// `state` names the org (`<slug>.<random>`) so the edge can bounce the browser
// to the org's own host, and the callback there refuses a state of another org.
// The code exchange sends the same redirect_uri the authorize URL carried.
// Unset, the authorize URL is what it always was (BASE_URL, a bare random state).
//
// Both flows are covered: sign-in (modules/auth/oauth-routes.ts) and connector
// (modules/apps/connections/service.ts).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import { forgetOrgHostCache } from "~/lib/org-host"
import { redis } from "~/lib/redis"
import { hostOnlyCookies } from "~/lib/response"
import { oauthStateCookieSpec } from "~/modules/auth/oauth-routes"
import type { Person } from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const { app } = await import("~/app")
const { startOAuthFlow } = await import("~/modules/apps/connections/service")
const { ensureAppsForOrg } = await import("~/modules/apps/init")
const { setMailProviderEnabled } = await import("~/modules/mail/provider-settings")
const { saveGoogleIntegrationConfig } = await import("~/modules/settings/google-integration")
const minimal = await import("~/seed/tiers/minimal")
const { connectionConfigRegistry } = await import("~/modules/apps/app-registries")
const { computeGoogleSetupValues } = await import("~/modules/connection-guides/google")
const { appConnectionSetup, shopifyDashboardPlan, shopifyCliPlan, translator } = await import(
  "~/modules/connection-guides/plan"
)
const { serverSetup } = await import("~/modules/connection-guides/server-setup")

const TEMPLATE = "https://{slug}.example.com"
const AUTH = "https://auth.example.com"

interface Tenant {
  user: Person
  slug: string
  host: string
}

let A: Tenant
let B: Tenant
let providerId: string
let idp: ReturnType<typeof Bun.serve>
let idpUrl: string
/** Every token request the stand-in provider saw: its form body. */
const tokenRequests: URLSearchParams[] = []

const saved = {
  template: env.LIAISON_ORG_HOST_TEMPLATE,
  redirect: env.LIAISON_OAUTH_REDIRECT_BASE,
  standIn: process.env.LIAISON_TEST_OAUTH_PROVIDER,
}

function managed() {
  env.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  env.LIAISON_OAUTH_REDIRECT_BASE = AUTH
  forgetOrgHostCache()
}
function selfHosted() {
  env.LIAISON_ORG_HOST_TEMPLATE = undefined
  env.LIAISON_OAUTH_REDIRECT_BASE = undefined
}

/** A request as it reaches the app on `host`. */
function on(host: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("host", host)
  return app.request(`http://${host}${path}`, { ...init, headers })
}

async function tenant(): Promise<Tenant> {
  const { orgId } = await minimal.secondOrg({ name: "Redirect base" })
  const user = await minimal.orgAdmin(orgId)
  const [org] = await sql<
    { slug: string }[]
  >`SELECT slug FROM kernel.organizations WHERE id = ${orgId}`
  const slug = org!.slug
  return { user, slug, host: `${slug}.example.com` }
}

beforeAll(async () => {
  await acquireTestLock()
  idp = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === "/token") {
        tokenRequests.push(new URLSearchParams(await req.text()))
        // No usable grant: the flows stop after the exchange, which is all
        // these tests look at.
        return Response.json({ error: "invalid_grant" }, { status: 400 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  idpUrl = `http://localhost:${idp.port}`
  A = await tenant()
  B = await tenant()
  const [row] = await withPrivilegedDb(A.user.orgId, "test-redirect-base-provider", (db) =>
    db
      .insert(oauthProviders)
      .values({
        orgId: A.user.orgId,
        name: "redirect-base-idp",
        issuerUrl: idpUrl,
        authorizationEndpoint: `${idpUrl}/authorize`,
        tokenEndpoint: `${idpUrl}/token`,
        userinfoEndpoint: `${idpUrl}/userinfo`,
        clientId: "redirect-base-client",
        clientSecretEncrypted: encryptSecret(
          "secret",
          encryptionKey,
          CryptoContext.oauthProviderClientSecret,
        ),
        scopes: "openid email profile",
        autoProvision: false,
      })
      .returning({ id: oauthProviders.id }),
  )
  providerId = row!.id

  // Connector: the org's Google client on the mail app's Gmail connection; the
  // stand-in provider takes its authorize and token calls.
  await ensureAppsForOrg(A.user.orgId)
  await setMailProviderEnabled(A.user.orgId, "gmail", true)
  await saveGoogleIntegrationConfig(A.user.orgId, {
    clientId: "1234-fake.apps.googleusercontent.com",
    clientSecret: `GOCSPX-${randomBytes(8).toString("hex")}`,
  })
  process.env.LIAISON_TEST_OAUTH_PROVIDER = idpUrl
}, 180_000)

afterEach(() => {
  env.LIAISON_ORG_HOST_TEMPLATE = saved.template
  env.LIAISON_OAUTH_REDIRECT_BASE = saved.redirect
  tokenRequests.length = 0
})

afterAll(async () => {
  env.LIAISON_ORG_HOST_TEMPLATE = saved.template
  env.LIAISON_OAUTH_REDIRECT_BASE = saved.redirect
  if (saved.standIn === undefined) delete process.env.LIAISON_TEST_OAUTH_PROVIDER
  else process.env.LIAISON_TEST_OAUTH_PROVIDER = saved.standIn
  await sql`DELETE FROM kernel.oauth_providers WHERE id = ${providerId}`
  idp.stop(true)
  await releaseTestLock()
})

const SIGN_IN_KEYS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "nonce",
]

/** Sign-in authorize on `host`: the provider URL and the state cookie. */
async function signInAuthorize(host: string, query = "") {
  const res = await on(host, `/api/auth/oauth/${providerId}/authorize${query}`)
  expect(res.status).toBe(302)
  return {
    url: new URL(res.headers.get("location")!),
    cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]!,
  }
}

describe("sign-in authorize URL", () => {
  it("self-hosted: BASE_URL callback and a bare random state, exactly as before", async () => {
    selfHosted()
    const { url } = await signInAuthorize("localhost:3000", `?orgSlug=${A.slug}`)
    expect([...url.searchParams.keys()]).toEqual(SIGN_IN_KEYS)
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.BASE_URL}/api/auth/oauth/callback`)
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })
  it("managed: the central redirect host and a state naming the org", async () => {
    managed()
    const { url } = await signInAuthorize(A.host)
    expect([...url.searchParams.keys()]).toEqual(SIGN_IN_KEYS)
    expect(url.searchParams.get("redirect_uri")).toBe(`${AUTH}/api/auth/oauth/callback`)
    expect(url.searchParams.get("state")).toMatch(new RegExp(`^${A.slug}\\.[A-Za-z0-9_-]{22}$`))
  })
  it("managed: the record keeps the org's slug", async () => {
    managed()
    const { url } = await signInAuthorize(A.host)
    const raw = await redis.get(`oauth:login-state:${url.searchParams.get("state")}`)
    expect(JSON.parse(raw!).orgSlug).toBe(A.slug)
  })
})

describe("sign-in callback", () => {
  const callback = (host: string, state: string, cookie: string) =>
    on(host, `/api/auth/oauth/callback?code=c&state=${encodeURIComponent(state)}`, {
      headers: { cookie },
    })

  it("managed: the exchange sends the redirect_uri the authorize URL carried", async () => {
    managed()
    const { url, cookie } = await signInAuthorize(A.host)
    await callback(A.host, url.searchParams.get("state")!, cookie)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]!.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"))
  })
  it("self-hosted: the same, on BASE_URL", async () => {
    selfHosted()
    const { url, cookie } = await signInAuthorize("localhost:3000", `?orgSlug=${A.slug}`)
    await callback("localhost:3000", url.searchParams.get("state")!, cookie)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]!.get("redirect_uri")).toBe(`${env.BASE_URL}/api/auth/oauth/callback`)
  })
  it("managed: A's state on B's host is refused before any exchange, and is not spent", async () => {
    managed()
    const { url, cookie } = await signInAuthorize(A.host)
    const state = url.searchParams.get("state")!
    const res = await callback(B.host, state, cookie)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(tokenRequests).toHaveLength(0)
    expect(await redis.get(`oauth:login-state:${state}`)).not.toBeNull()
  })
  it("managed: a state without the org prefix is refused", async () => {
    managed()
    const bare = randomBytes(16).toString("base64url")
    await redis.set(
      `oauth:login-state:${bare}`,
      JSON.stringify({ providerId, codeVerifier: "v", nonce: "n" }),
      "EX",
      60,
    )
    // The browser binding is right: only the missing prefix refuses it.
    const cookie = `${oauthStateCookieSpec(hostOnlyCookies()).name}=${createHash("sha256").update(bare).digest("hex")}`
    const res = await callback(A.host, bare, cookie)
    expect(res.status).toBe(400)
    expect(tokenRequests).toHaveLength(0)
  })
})

describe("connector authorize URL", () => {
  const start = () => startOAuthFlow(A.user.orgId, A.user.id, "mail", "gmail")

  it("self-hosted: BASE_URL callback and a bare random state, exactly as before", async () => {
    selfHosted()
    const url = new URL(await start())
    expect(url.searchParams.get("redirect_uri")).toBe(`${env.BASE_URL}/api/connections/callback`)
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
  it("managed: the central redirect host and a state naming the org", async () => {
    managed()
    const url = new URL(await start())
    expect(url.searchParams.get("redirect_uri")).toBe(`${AUTH}/api/connections/callback`)
    expect(url.searchParams.get("state")).toMatch(new RegExp(`^${A.slug}\\.[A-Za-z0-9_-]{43}$`))
  })
})

describe("connector callback", () => {
  const start = async () => new URL(await startOAuthFlow(A.user.orgId, A.user.id, "mail", "gmail"))
  const callback = async (host: string, state: string) =>
    (
      await on(host, `/api/connections/callback?code=c&state=${encodeURIComponent(state)}`)
    ).headers.get("location") ?? ""

  it("managed: the exchange sends the redirect_uri the authorize URL carried", async () => {
    managed()
    const url = await start()
    await callback(A.host, url.searchParams.get("state")!)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]!.get("redirect_uri")).toBe(url.searchParams.get("redirect_uri"))
  })
  it("self-hosted: the same, on BASE_URL", async () => {
    selfHosted()
    const url = await start()
    await callback("localhost:3000", url.searchParams.get("state")!)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]!.get("redirect_uri")).toBe(`${env.BASE_URL}/api/connections/callback`)
  })
  it("managed: A's state on B's host is refused before any exchange, and is not spent", async () => {
    managed()
    const state = (await start()).searchParams.get("state")!
    expect(await callback(B.host, state)).toContain("oauth_browser_mismatch")
    expect(tokenRequests).toHaveLength(0)
    expect(await redis.get(`oauth:state:${state}`)).not.toBeNull()
  })
  it("a state whose prefix names another org than its record is refused", async () => {
    // No org hosts, so no host check: only the prefix ties the state to its org.
    env.LIAISON_ORG_HOST_TEMPLATE = undefined
    env.LIAISON_OAUTH_REDIRECT_BASE = AUTH
    const state = (await start()).searchParams.get("state")!
    const random = state.slice(state.indexOf(".") + 1)
    const forged = `${B.slug}.${random}`
    await redis.set(`oauth:state:${forged}`, (await redis.get(`oauth:state:${state}`))!, "EX", 60)
    expect(await callback("localhost:3000", forged)).toContain("oauth_browser_mismatch")
    expect(tokenRequests).toHaveLength(0)
  })
})

describe("setup guides show the redirect URI the flows send", () => {
  const t = translator("en")

  beforeAll(() => {
    connectionConfigRegistry.set([A.user.orgId, "shopify", "shop"], {
      type: "oauth2",
      authorizationUrl: "https://{shop}/admin/oauth/authorize",
      tokenUrl: "https://{shop}/admin/oauth/access_token",
      scopes: ["read_orders"],
      apiVersion: "2026-01",
      allowedDomains: ["*.myshopify.com"],
      identifierVar: "shop",
    })
    connectionConfigRegistry.set([A.user.orgId, "meta-like", "page"], {
      type: "oauth2",
      authorizationUrl: "https://www.facebook.com/v23.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
      scopes: ["pages_show_list"],
      allowedDomains: ["graph.facebook.com"],
    })
  })
  afterAll(() => {
    connectionConfigRegistry.delete([A.user.orgId, "shopify", "shop"])
    connectionConfigRegistry.delete([A.user.orgId, "meta-like", "page"])
  })

  async function shown(): Promise<string[]> {
    const google = computeGoogleSetupValues(A.user.orgId)
    const dashboard = await shopifyDashboardPlan(A.user.orgId, t)
    const cli = await shopifyCliPlan(A.user.orgId, t)
    const meta = await appConnectionSetup(A.user.orgId, "meta-like", "page")
    if ("error" in dashboard || "error" in cli) throw new Error("no shopify plan")
    return [
      ...google.redirectUris,
      google.signIn.redirectUri,
      ...dashboard.values.redirectUrls,
      cli.toml.match(/^redirect_urls = \[ ?"([^"]+)"/m)?.[1] ?? "",
      meta?.redirectUri ?? "",
    ]
  }

  it("managed: every guide shows the central redirect host", async () => {
    managed()
    const uris = await shown()
    expect(uris.length).toBeGreaterThan(4)
    for (const uri of uris) expect(uri.startsWith(`${AUTH}/api/`)).toBe(true)
    const server = JSON.stringify(
      serverSetup({ BASE_URL: "https://cell.example.com", LIAISON_OAUTH_REDIRECT_BASE: AUTH }),
    )
    expect(server).toContain(`${AUTH}/api/connections/callback`)
    expect(server).toContain(`${AUTH}/api/auth/oauth/callback`)
    expect(server).not.toContain("https://cell.example.com/api/connections/callback")
  })
  it("self-hosted: every guide shows BASE_URL", async () => {
    selfHosted()
    const base = env.BASE_URL.replace(/\/+$/, "")
    for (const uri of await shown()) expect(uri.startsWith(`${base}/api/`)).toBe(true)
    expect(JSON.stringify(serverSetup({ BASE_URL: "https://cell.example.com" }))).toContain(
      "https://cell.example.com/api/connections/callback",
    )
  })
})
