// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connecting an app from the desktop or mobile shell, with the connect browser
// binding ON (shell-connect.ts). The shell's fetch is cross site, so the
// binding cookie the browser flow relies on is never stored there: the shell
// binds the flow to itself with a PKCE verifier, the callback parks the grant
// behind a one-time code handed back on `liaison://oauth-complete`, and only
// the shell's own session with its verifier completes it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { allocatePorts, api } from "@liaison/test-helpers"
import { startMockOidc } from "./helpers/mock-oidc"
import { setupScenario, teardownScenario } from "./setup"

const SHELL_ORIGIN = "tauri://localhost"

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

const appState = () => randomBytes(32).toString("base64url")

describe("Connect from the desktop or mobile shell", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let oidc: Awaited<ReturnType<typeof startMockOidc>>
  let oidcPort: number
  let adminToken: string

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 7,
      org: { name: "Shell Connect Test" },
      serverEnv: {
        GMAIL_OAUTH_CLIENT_ID: "api-e2e-gmail-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: "api-e2e-gmail-client-secret",
        OAUTH_CONNECT_BROWSER_BINDING: "true",
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    adminToken = world.admin.token
    const [port] = await allocatePorts(1)
    oidcPort = port
    oidc = await startMockOidc(oidcPort)
    const enabled = await api(url, "/api/mail/providers/gmail", {
      token: adminToken,
      method: "PATCH",
      body: { enabled: true },
    })
    expect(enabled.status).toBe(200)
  }, 120_000)

  afterAll(async () => {
    if (oidc) oidc.stop()
    await teardownScenario(env, world)
  }, 15_000)

  /** Points the stored state's token endpoint at the mock provider. */
  async function patchOAuthState(state: string): Promise<void> {
    const key = `${env.redisPrefix ?? ""}oauth:state:${state}`
    const raw = await env.redis.redis.get(key)
    if (!raw) throw new Error("OAuth state not found in Redis")
    const parsed = JSON.parse(raw)
    parsed.tokenUrl = `http://localhost:${oidcPort}/token`
    await env.redis.redis.set(key, JSON.stringify(parsed), "EX", 900)
  }

  /** The shell starts a flow; the provider consents; the callback lands in the system browser. */
  async function shellFlowToCallback(email: string, challenge: string, returnState: string) {
    const start = await api(url, "/api/connections/mail/gmail/authorize", {
      token: adminToken,
      headers: { Origin: SHELL_ORIGIN },
      body: {
        client: "desktop",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: returnState,
      },
    })
    expect(start.status).toBe(200)
    // No binding cookie: the shell could not keep one, and nothing relies on it.
    expect(start.headers.get("set-cookie") ?? "").not.toContain("connect_state")
    const state = new URL(start.body.data.redirectUrl).searchParams.get("state")!
    await patchOAuthState(state)
    const consent = await fetch(
      `http://localhost:${oidcPort}/authorize?state=${state}&redirect_uri=${encodeURIComponent(`${url}/api/connections/callback`)}&login_hint=${encodeURIComponent(email)}`,
      { redirect: "manual" },
    )
    const providerCode = new URL(consent.headers.get("location")!).searchParams.get("code")!
    // The system browser: no cookie of the shell's, none at all.
    return fetch(`${url}/api/connections/callback?code=${providerCode}&state=${state}`, {
      redirect: "manual",
    })
  }

  /** The handoff link the callback page sends the browser to. */
  async function handoffLink(res: Response): Promise<URL> {
    expect(res.status).toBe(200)
    const html = await res.text()
    const match = html.match(/content="0;url=([^"]+)"/)
    expect(match).not.toBeNull()
    return new URL(match![1].replace(/&amp;/g, "&"))
  }

  async function connectedRows(email: string): Promise<number> {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
    const rows = await env.db.sql.unsafe(
      `SELECT id FROM ${ks}.connected_accounts WHERE identifier = $1 AND status = 'active'`,
      [email],
    )
    return rows.length
  }

  it("completes a shell connect with the binding on, once, and only with the shell's verifier", async () => {
    const email = "shell-connect@e2e.test"
    const { verifier, challenge } = pkce()
    const returnState = appState()
    const link = await handoffLink(await shellFlowToCallback(email, challenge, returnState))
    expect(link.protocol).toBe("liaison:")
    expect(link.host).toBe("oauth-complete")
    expect(link.searchParams.get("state")).toBe(returnState)
    const code = link.searchParams.get("code")!
    expect(code).toMatch(/^[0-9a-f]{64}$/)
    // Parked, not completed: nothing is connected until the shell redeems it.
    expect(await connectedRows(email)).toBe(0)

    const redeemed = await api(url, "/api/connections/oauth-handoff", {
      token: adminToken,
      headers: { Origin: SHELL_ORIGIN },
      body: { code, code_verifier: verifier },
    })
    expect(redeemed.status).toBe(200)
    expect(redeemed.body.data).toEqual({
      appName: "mail",
      connectionName: "gmail",
      settingsPath: "/settings/apps/mail",
    })
    expect(await connectedRows(email)).toBe(1)

    // A replayed code is refused.
    const replay = await api(url, "/api/connections/oauth-handoff", {
      token: adminToken,
      headers: { Origin: SHELL_ORIGIN },
      body: { code, code_verifier: verifier },
    })
    expect(replay.status).toBe(400)
  })

  it("refuses a callback redeemed without the shell's verifier, and burns the code", async () => {
    const email = "shell-no-verifier@e2e.test"
    const { verifier, challenge } = pkce()
    const link = await handoffLink(await shellFlowToCallback(email, challenge, appState()))
    const code = link.searchParams.get("code")!

    // Whoever read the link (another app on the scheme, a log) holds a code and no verifier.
    const stolen = await api(url, "/api/connections/oauth-handoff", {
      token: adminToken,
      body: { code, code_verifier: pkce().verifier },
    })
    expect(stolen.status).toBe(400)
    const bare = await api(url, "/api/connections/oauth-handoff", {
      token: adminToken,
      body: { code },
    })
    expect(bare.status).toBe(400)
    // The refused attempt burned it: the shell's own verifier cannot use it now.
    const late = await api(url, "/api/connections/oauth-handoff", {
      token: adminToken,
      body: { code, code_verifier: verifier },
    })
    expect(late.status).toBe(400)
    expect(await connectedRows(email)).toBe(0)
  })

  it("a provider refusal on a shell flow goes back to the shell", async () => {
    const { challenge } = pkce()
    const returnState = appState()
    const start = await api(url, "/api/connections/mail/gmail/authorize", {
      token: adminToken,
      headers: { Origin: SHELL_ORIGIN },
      body: {
        client: "desktop",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: returnState,
      },
    })
    const state = new URL(start.body.data.redirectUrl).searchParams.get("state")!
    const res = await fetch(`${url}/api/connections/callback?error=access_denied&state=${state}`, {
      redirect: "manual",
    })
    const link = await handoffLink(res)
    expect(link.searchParams.get("error")).toBe("access_denied")
    expect(link.searchParams.get("state")).toBe(returnState)
  })

  it("a browser tab cannot ask for the shell flow, and its own flow stays cookie bound", async () => {
    const { challenge } = pkce()
    const refused = await api(url, "/api/connections/mail/gmail/authorize", {
      token: adminToken,
      headers: { Origin: "https://evil.example" },
      body: {
        client: "desktop",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: appState(),
      },
    })
    expect(refused.status).toBe(400)

    // The browser flow, unchanged: the cookie is set, and a callback without it
    // (a forwarded link opened elsewhere) ends on oauth_browser_mismatch.
    const start = await api(url, "/api/connections/mail/gmail/authorize", {
      token: adminToken,
      body: {},
    })
    expect(start.status).toBe(200)
    const state = new URL(start.body.data.redirectUrl).searchParams.get("state")!
    // One binding cookie per flow (lib/oauth-browser-binding.ts): its name
    // carries a short hash of THIS flow's state and its value the full hash,
    // HttpOnly and scoped to the callback, so it binds this flow and no other.
    const stateHash = createHash("sha256").update(state).digest("hex")
    const setCookie = start.headers.get("set-cookie") ?? ""
    expect(setCookie).toContain(`__connect_state_${stateHash.slice(0, 16)}=${stateHash};`)
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("Path=/api/connections/callback")
    await patchOAuthState(state)
    const consent = await fetch(
      `http://localhost:${oidcPort}/authorize?state=${state}&redirect_uri=${encodeURIComponent(`${url}/api/connections/callback`)}&login_hint=forwarded@e2e.test`,
      { redirect: "manual" },
    )
    const providerCode = new URL(consent.headers.get("location")!).searchParams.get("code")!
    const forwarded = await fetch(
      `${url}/api/connections/callback?code=${providerCode}&state=${state}`,
      { redirect: "manual" },
    )
    expect(forwarded.status).toBe(302)
    expect(forwarded.headers.get("location") ?? "").toContain("oauth_error=oauth_browser_mismatch")
  })
})
