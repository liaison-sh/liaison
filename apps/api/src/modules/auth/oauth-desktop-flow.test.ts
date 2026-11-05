// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DESKTOP APP SIGNS IN THROUGH THE SYSTEM BROWSER (RFC 8252), and the web
// flow does not move. Driven end to end against a local IdP stub, exactly like
// oauth-routes.test.ts: authorize, the provider's redirect, the callback, the
// exchange.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { app } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { oauthAccounts, oauthProviders, organizations, users } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  DESKTOP_EXCHANGE_CODE_TTL_SECONDS,
  WEB_EXCHANGE_CODE_TTL_SECONDS,
} from "~/modules/auth/desktop-oauth"
import { parseExchangePayload, serializeExchangePayload } from "~/modules/auth/oauth-routes"
import { clearRedisPatterns } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000000997"
const CLIENT_ID = "desktop-flow-client"

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

/** The app's own opaque state, the shape the web layer mints. */
function appState(): string {
  return randomBytes(32).toString("base64url")
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`
}

/** Pulls the `liaison://oauth-complete?...` link out of the handoff page. */
function handoffLink(html: string): URL {
  const match = /href="(liaison:\/\/oauth-complete\?[^"]+)"/.exec(html)
  expect(match).not.toBeNull()
  return new URL(match![1]!.replace(/&amp;/g, "&"))
}

describe("OAuth for the desktop app: system browser + PKCE", () => {
  let idp: ReturnType<typeof Bun.serve>
  let idpUrl: string
  let providerId: string
  let nextClaims: Record<string, unknown> = {}

  async function insertUser(email: string, status: "active" | "deactivated") {
    await withPrivilegedDb(ORG_ID, "test-desktop-oauth-user", (db) =>
      db.insert(users).values({ orgId: ORG_ID, email, name: email, status }),
    )
  }

  async function cleanOrg() {
    await withPrivilegedDb(ORG_ID, "test-desktop-oauth-clean", async (db) => {
      await db.delete(oauthAccounts).where(eq(oauthAccounts.orgId, ORG_ID))
      await db.delete(oauthProviders).where(eq(oauthProviders.orgId, ORG_ID))
      await db.delete(users).where(eq(users.orgId, ORG_ID))
      await db.delete(organizations).where(eq(organizations.id, ORG_ID))
    })
  }

  /**
   * authorize (with whatever query the caller passes) -> IdP stub -> callback.
   * Returns the callback's raw response.
   */
  async function signIn(
    query: string,
    email: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const authRes = await app.request(`/api/auth/oauth/${providerId}/authorize${query}`)
    expect(authRes.status).toBe(302)
    const idpRedirect = new URL(authRes.headers.get("location")!)
    const state = idpRedirect.searchParams.get("state")!
    nextClaims = {
      iss: idpUrl,
      aud: CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: `desktop-flow-${email}`,
      email,
      email_verified: true,
      nonce: idpRedirect.searchParams.get("nonce")!,
    }
    const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0]!
    return app.request(
      `/api/auth/oauth/callback?code=idp-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie, ...headers } },
    )
  }

  function desktopQuery(state: string, challenge: string, client = "desktop"): string {
    const params = new URLSearchParams({
      state,
      client,
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
    return `?${params}`
  }

  beforeAll(async () => {
    idp = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        if (pathname === "/token") {
          return Response.json({
            access_token: "stub-access-token",
            token_type: "Bearer",
            id_token: unsignedJwt(nextClaims),
          })
        }
        if (pathname === "/userinfo") {
          return Response.json({
            sub: nextClaims.sub,
            email: nextClaims.email,
            email_verified: true,
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    idpUrl = `http://localhost:${idp.port}`
    await cleanOrg()
    await withPrivilegedDb(ORG_ID, "test-desktop-oauth-org", (db) =>
      db
        .insert(organizations)
        .values({ id: ORG_ID, name: "Desktop OAuth Test Org", slug: "desktop-oauth-test" }),
    )
    const [row] = await withPrivilegedDb(ORG_ID, "test-desktop-oauth-provider", (db) =>
      db
        .insert(oauthProviders)
        .values({
          orgId: ORG_ID,
          name: "acme-desktop-idp",
          issuerUrl: idpUrl,
          authorizationEndpoint: `${idpUrl}/authorize`,
          tokenEndpoint: `${idpUrl}/token`,
          userinfoEndpoint: `${idpUrl}/userinfo`,
          clientId: CLIENT_ID,
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
    await insertUser("linked@desktop-flow.test", "active")
    await insertUser("gone@desktop-flow.test", "deactivated")
    await insertUser("second-factor@desktop-flow.test", "active")
    await withPrivilegedDb(ORG_ID, "test-desktop-oauth-totp", (db) =>
      db
        .update(users)
        .set({ totpEnabled: true })
        .where(eq(users.email, "second-factor@desktop-flow.test")),
    )
    // Both users sign in through an existing link, the path most sign-ins take.
    const linked = await withPrivilegedDb(ORG_ID, "test-desktop-oauth-users", (db) =>
      db.select({ id: users.id, email: users.email }).from(users).where(eq(users.orgId, ORG_ID)),
    )
    await withPrivilegedDb(ORG_ID, "test-desktop-oauth-links", (db) =>
      db.insert(oauthAccounts).values(
        linked.map((u) => ({
          orgId: ORG_ID,
          userId: u.id,
          providerId,
          externalSubject: `desktop-flow-${u.email}`,
          externalEmail: u.email,
          externalProfile: {},
        })),
      ),
    )
  })

  afterAll(async () => {
    await cleanOrg()
    await clearRedisPatterns(["oauth:exchange:test-desktop-*"])
    idp.stop(true)
  })

  // ── authorize: the desktop parameters are validated strictly ──

  describe("authorize", () => {
    const { challenge } = pkcePair()
    // Every native client (the desktop app and the phone) is held to the same
    // rules: a mobile request missing its challenge must not pass as the web flow.
    const perClient = (client: string): Array<[string, Record<string, string>]> => [
      [`no challenge (client=${client})`, { client, code_challenge_method: "S256" }],
      [`no challenge and no method (client=${client})`, { client }],
      [
        `the plain method (client=${client})`,
        { client, code_challenge: challenge, code_challenge_method: "plain" },
      ],
      [`no method (client=${client})`, { client, code_challenge: challenge }],
      [
        `a challenge that is not a SHA-256 digest (client=${client})`,
        { client, code_challenge: "short", code_challenge_method: "S256" },
      ],
    ]
    const refusals: Array<[string, Record<string, string>]> = [
      ...perClient("desktop"),
      ...perClient("mobile"),
      [
        "an unknown client",
        { client: "tablet", code_challenge: challenge, code_challenge_method: "S256" },
      ],
      [
        "a challenge without client=desktop",
        { code_challenge: challenge, code_challenge_method: "S256" },
      ],
    ]
    for (const [what, params] of refusals) {
      it(`refuses ${what}`, async () => {
        const query = new URLSearchParams({ state: appState(), ...params })
        const res = await app.request(`/api/auth/oauth/${providerId}/authorize?${query}`)
        expect(res.status).toBe(400)
      })
    }

    for (const client of ["desktop", "mobile"]) {
      it(`refuses a ${client} request without the app's own state`, async () => {
        const query = new URLSearchParams({
          client,
          code_challenge: challenge,
          code_challenge_method: "S256",
        })
        const res = await app.request(`/api/auth/oauth/${providerId}/authorize?${query}`)
        expect(res.status).toBe(400)
      })
    }

    it("accepts client=desktop with an S256 challenge and carries it to the callback", async () => {
      const state = appState()
      const res = await app.request(
        `/api/auth/oauth/${providerId}/authorize${desktopQuery(state, challenge)}`,
      )
      expect(res.status).toBe(302)
      const oauthState = new URL(res.headers.get("location")!).searchParams.get("state")!
      const stored = JSON.parse((await redis.get(`oauth:login-state:${oauthState}`))!)
      expect(stored.desktop).toEqual({ codeChallenge: challenge })
      expect(stored.returnState).toBe(state)
      // Our own challenge to the PROVIDER is a different one, ours alone.
      expect(new URL(res.headers.get("location")!).searchParams.get("code_challenge")).not.toBe(
        challenge,
      )
    })
  })

  // ── callback: the handoff page, the challenge bound to the code ──

  describe("callback in a desktop flow", () => {
    it("answers the handoff page with a liaison:// link and binds the challenge to the code", async () => {
      const { challenge } = pkcePair()
      const state = appState()
      const res = await signIn(desktopQuery(state, challenge), "linked@desktop-flow.test")

      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      const html = await res.text()
      const link = handoffLink(html)
      expect(link.protocol).toBe("liaison:")
      expect(link.host).toBe("oauth-complete")
      expect(link.searchParams.get("state")).toBe(state)
      const code = link.searchParams.get("code")!
      expect(code).toMatch(/^[0-9a-f]{64}$/)
      // The page moves on by itself, and names the same link.
      expect(html).toContain(
        `http-equiv="refresh" content="0;url=liaison://oauth-complete?code=${code}`,
      )
      expect(html).toContain("Return to the Liaison app")

      // The code carries the app's challenge, and lives long enough for the
      // browser's "Open Liaison?" prompt but no longer than two minutes.
      const stored = parseExchangePayload((await redis.get(`oauth:exchange:${code}`))!)
      expect(stored.codeChallenge).toBe(challenge)
      expect("refreshToken" in stored && stored.refreshToken).toBeString()
      const ttl = await redis.ttl(`oauth:exchange:${code}`)
      expect(ttl).toBeGreaterThan(WEB_EXCHANGE_CODE_TTL_SECONDS)
      expect(ttl).toBeLessThanOrEqual(DESKTOP_EXCHANGE_CODE_TTL_SECONDS)
      expect(DESKTOP_EXCHANGE_CODE_TTL_SECONDS).toBeLessThanOrEqual(120)

      // No web session is left behind in the user's browser.
      expect(res.headers.get("set-cookie") ?? "").not.toContain("liaison_rt=")
      expect(res.headers.get("location")).toBeNull()
    })

    it("serves the page under its own strict policy, with no external asset", async () => {
      const { challenge } = pkcePair()
      const res = await signIn(desktopQuery(appState(), challenge), "linked@desktop-flow.test")
      const csp = res.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).not.toContain("unsafe-inline")
      expect(csp).not.toContain("script-src")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
      const html = await res.text()
      expect(html).not.toContain("<script")
      expect(html).not.toMatch(/(src|href)="https?:/)
    })

    it("speaks French to a French browser", async () => {
      const { challenge } = pkcePair()
      const res = await signIn(desktopQuery(appState(), challenge), "linked@desktop-flow.test", {
        "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
      })
      const html = await res.text()
      expect(html).toContain('lang="fr"')
      expect(html).toContain("Revenir à l&#39;application Liaison")
    })

    it("hands a refused sign-in back to the app, not to the web login page", async () => {
      const { challenge } = pkcePair()
      const state = appState()
      const res = await signIn(desktopQuery(state, challenge), "gone@desktop-flow.test")
      expect(res.status).toBe(200)
      expect(res.headers.get("location")).toBeNull()
      const link = handoffLink(await res.text())
      expect(link.host).toBe("oauth-complete")
      expect(link.searchParams.get("error")).toBe("Account deactivated")
      expect(link.searchParams.get("state")).toBe(state)
      expect(link.searchParams.get("code")).toBeNull()
    })

    it("hands a cancel at the provider back to the app", async () => {
      const { challenge } = pkcePair()
      const state = appState()
      const authRes = await app.request(
        `/api/auth/oauth/${providerId}/authorize${desktopQuery(state, challenge)}`,
      )
      const oauthState = new URL(authRes.headers.get("location")!).searchParams.get("state")!
      const res = await app.request(
        `/api/auth/oauth/callback?error=access_denied&state=${encodeURIComponent(oauthState)}`,
      )
      expect(res.status).toBe(200)
      const link = handoffLink(await res.text())
      expect(link.searchParams.get("error")).toBe("OAuth authentication failed")
      expect(link.searchParams.get("state")).toBe(state)
      // And the state is spent.
      expect(await redis.get(`oauth:login-state:${oauthState}`)).toBeNull()
    })
  })

  // ── exchange: the verifier is required for a desktop code ──

  describe("exchange", () => {
    async function seedDesktopCode(key: string, challenge: string) {
      await redis.set(
        `oauth:exchange:${key}`,
        serializeExchangePayload({
          accessToken: "at-desktop",
          refreshToken: "rt-desktop",
          codeChallenge: challenge,
        }),
        "EX",
        DESKTOP_EXCHANGE_CODE_TTL_SECONDS,
      )
    }

    async function exchange(body: Record<string, unknown>) {
      return app.request("/api/auth/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "tauri://localhost" },
        body: JSON.stringify(body),
      })
    }

    it("releases the tokens to the matching verifier", async () => {
      const { verifier, challenge } = pkcePair()
      await seedDesktopCode("test-desktop-ok", challenge)
      const res = await exchange({ code: "test-desktop-ok", code_verifier: verifier })
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.accessToken).toBe("at-desktop")
      expect(body.data.refreshToken).toBe("rt-desktop")
    })

    it("refuses a missing verifier, and the code is spent", async () => {
      const { verifier, challenge } = pkcePair()
      await seedDesktopCode("test-desktop-missing", challenge)
      const res = await exchange({ code: "test-desktop-missing" })
      expect(res.status).toBe(400)
      const again = await exchange({ code: "test-desktop-missing", code_verifier: verifier })
      expect(again.status).toBe(400)
    })

    it("refuses a wrong verifier, and the code is spent", async () => {
      const { verifier, challenge } = pkcePair()
      await seedDesktopCode("test-desktop-wrong", challenge)
      const res = await exchange({ code: "test-desktop-wrong", code_verifier: pkcePair().verifier })
      expect(res.status).toBe(400)
      const body = (await res.json()) as any
      expect(body.data).toBeUndefined()
      const again = await exchange({ code: "test-desktop-wrong", code_verifier: verifier })
      expect(again.status).toBe(400)
    })

    it("refuses the challenge itself passed as the verifier", async () => {
      const { challenge } = pkcePair()
      await seedDesktopCode("test-desktop-echo", challenge)
      const res = await exchange({ code: "test-desktop-echo", code_verifier: challenge })
      expect(res.status).toBe(400)
    })

    it("completes the whole round trip: page link -> exchange with the verifier", async () => {
      const { verifier, challenge } = pkcePair()
      const res = await signIn(desktopQuery(appState(), challenge), "linked@desktop-flow.test")
      const code = handoffLink(await res.text()).searchParams.get("code")!
      const out = await exchange({ code, code_verifier: verifier })
      expect(out.status).toBe(200)
      const body = (await out.json()) as any
      expect(body.data.accessToken).toBeString()
      expect(body.data.refreshToken).toBeString()
    })
  })

  // ── the iOS shell: the same flow, run in ASWebAuthenticationSession ──

  describe("mobile flow (client=mobile)", () => {
    async function exchangeFromPhone(body: Record<string, unknown>) {
      return app.request("/api/auth/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "capacitor://localhost" },
        body: JSON.stringify(body),
      })
    }

    it("client=mobile with S256 challenge gets the liaison:// handoff and exchange needs the verifier", async () => {
      const { verifier, challenge } = pkcePair()
      const state = appState()
      const res = await signIn(desktopQuery(state, challenge, "mobile"), "linked@desktop-flow.test")
      expect(res.status).toBe(200)
      expect(res.headers.get("set-cookie")).toBeNull()
      const link = handoffLink(await res.text())
      expect(link.protocol).toBe("liaison:")
      expect(link.host).toBe("oauth-complete")
      expect(link.searchParams.get("state")).toBe(state)
      const code = link.searchParams.get("code")!
      const stored = parseExchangePayload((await redis.get(`oauth:exchange:${code}`))!)
      expect(stored.codeChallenge).toBe(challenge)

      const withoutVerifier = await exchangeFromPhone({ code })
      expect(withoutVerifier.status).toBe(400)

      const { verifier: v2, challenge: c2 } = pkcePair()
      const again = await signIn(desktopQuery(appState(), c2, "mobile"), "linked@desktop-flow.test")
      const code2 = handoffLink(await again.text()).searchParams.get("code")!
      const out = await exchangeFromPhone({ code: code2, code_verifier: v2 })
      expect(out.status).toBe(200)
      expect(verifier).not.toBe(v2)
    })

    it("exchange from origin capacitor://localhost is allowed and answers the refresh token in the body", async () => {
      const { verifier, challenge } = pkcePair()
      const res = await signIn(
        desktopQuery(appState(), challenge, "mobile"),
        "linked@desktop-flow.test",
      )
      const code = handoffLink(await res.text()).searchParams.get("code")!
      const out = await exchangeFromPhone({ code, code_verifier: verifier })
      expect(out.status).toBe(200)
      expect(out.headers.get("access-control-allow-origin")).toBe("capacitor://localhost")
      const body = (await out.json()) as any
      expect(body.data.accessToken).toBeString()
      expect(body.data.refreshToken).toBeString()
    })

    it("refuses an unknown address: no account is created from the phone", async () => {
      const { challenge } = pkcePair()
      const state = appState()
      const res = await signIn(
        desktopQuery(state, challenge, "mobile"),
        "stranger@desktop-flow.test",
      )
      const link = handoffLink(await res.text())
      expect(link.searchParams.get("error")).toBe("No matching account")
      expect(link.searchParams.get("code")).toBeNull()
      const created = await withPrivilegedDb(ORG_ID, "test-desktop-oauth-stranger", (db) =>
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, "stranger@desktop-flow.test")),
      )
      expect(created).toHaveLength(0)
    })
  })

  // ── the web flow does not move ──

  describe("web flow, unchanged", () => {
    it("redirects to /login/oauth-complete with a cookie and a 30 second code with no challenge", async () => {
      const state = "web-opaque-state"
      const res = await signIn(`?state=${state}`, "linked@desktop-flow.test")
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get("location")!, "http://x")
      expect(location.pathname).toBe("/login/oauth-complete")
      expect(location.searchParams.get("state")).toBe(state)
      expect(res.headers.get("set-cookie") ?? "").toContain("liaison_rt=")
      const code = location.searchParams.get("code")!
      const stored = parseExchangePayload((await redis.get(`oauth:exchange:${code}`))!)
      expect(stored.codeChallenge).toBeUndefined()
      expect(await redis.ttl(`oauth:exchange:${code}`)).toBeLessThanOrEqual(
        WEB_EXCHANGE_CODE_TTL_SECONDS,
      )
      // Redeemed without any verifier, as the SPA always has.
      const out = await app.request("/api/auth/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
      })
      expect(out.status).toBe(200)
    })

    it("an account with two-factor sign-in gets a TOTP challenge, not a session", async () => {
      const state = "web-totp-state"
      const res = await signIn(`?state=${state}`, "second-factor@desktop-flow.test")
      expect(res.status).toBe(302)
      // No session yet: no refresh cookie.
      expect(res.headers.get("set-cookie") ?? "").not.toContain("liaison_rt=")
      const code = new URL(res.headers.get("location")!, "http://x").searchParams.get("code")!
      const out = await app.request("/api/auth/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
      })
      expect(out.status).toBe(200)
      const data = ((await out.json()) as any).data
      expect(data.accessToken).toBeUndefined()
      expect(data.totpRequired).toBe(true)
      expect(await redis.get(`challenge:${data.challengeToken}`)).not.toBeNull()
      const [u] = await withPrivilegedDb(ORG_ID, "test-desktop-oauth-totp-sessions", (db) =>
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, "second-factor@desktop-flow.test")),
      )
      const sessionRows = await withPrivilegedDb(ORG_ID, "test-desktop-oauth-totp-s", (db) =>
        db.execute(drizzleSql`SELECT id FROM kernel.sessions WHERE user_id = ${u!.id}`),
      )
      expect((sessionRows as unknown[]).length).toBe(0)
    })

    it("still sends a refused web sign-in to /login with the reason", async () => {
      const res = await signIn("?state=web-state", "gone@desktop-flow.test")
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe("/login?error=Account+deactivated")
    })

    it("still answers a web cancel at the provider with the same 400", async () => {
      const authRes = await app.request(`/api/auth/oauth/${providerId}/authorize?state=web-cancel`)
      const oauthState = new URL(authRes.headers.get("location")!).searchParams.get("state")!
      const res = await app.request(
        `/api/auth/oauth/callback?error=access_denied&state=${encodeURIComponent(oauthState)}`,
      )
      expect(res.status).toBe(400)
      // Left exactly as it was: the web flow's record is not touched.
      expect(await redis.get(`oauth:login-state:${oauthState}`)).not.toBeNull()
    })

    it("stores no desktop field in a web flow's state record", async () => {
      const res = await app.request(`/api/auth/oauth/${providerId}/authorize?state=web-record`)
      const oauthState = new URL(res.headers.get("location")!).searchParams.get("state")!
      const stored = JSON.parse((await redis.get(`oauth:login-state:${oauthState}`))!)
      expect(Object.keys(stored).sort()).toEqual([
        "codeVerifier",
        "nonce",
        "providerId",
        "returnState",
      ])
    })
  })
})
