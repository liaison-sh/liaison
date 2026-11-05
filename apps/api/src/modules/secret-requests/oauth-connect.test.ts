// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S36-S37: AN OAUTH CONSENT AS A CARD.
//
// An `oauth_connect` request is a card whose Connect button starts the
// provider's consent for the request's own connection and owner. The grant
// completes server-side: the callback exchanges the code with a local fake
// provider, stores the account, and that stored account (never the browser)
// saves the card. The agent hears {connected, accountHint} and nothing else.
//
// Covered here, on the real routes and the real callback:
//   - a member's personal Gmail: only that member may connect it, the others
//     see the card read-only; the popup ends on the closing page;
//   - a shared Shopify store: the shop domain typed on the card, the org's
//     account, a blocked popup's same-tab return to the conversation;
//   - a refused consent leaves the card pending and says why on the page.
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown> }> = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (_app: string, jobName: string, payload: Record<string, unknown>) => {
    enqueued.push({ jobName, payload })
    return "job-id"
  },
}))
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const crypto = await import("node:crypto")
const { app } = await import("~/app")
const { sql } = await import("~/db")
const { withPrivilegedDb } = await import("~/db/privileged")
const { withRlsContext } = await import("~/db/rls")
const { apps, oauthProviders, threadParticipants } = await import("~/db/schema/kernel")
const { CryptoContext, encryptSecret } = await import("~/lib/crypto")
const { redis } = await import("~/lib/redis")
const { env } = await import("~/lib/env")
const { systemEventLine } = await import("~/modules/agent/context/system-event-replay")
const { handleRequestSecret } = await import("~/modules/agent/tools/secret-request-tools")
const { connectionConfigRegistry } = await import("~/modules/apps/app-registries")
const { testOAuthProvider } = await import("~/modules/apps/connections/service")
const { ensureAppsForOrg } = await import("~/modules/apps/init")
const { setMailProviderEnabled } = await import("~/modules/mail/provider-settings")
const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
const { saveGoogleIntegrationConfig } = await import("~/modules/settings/google-integration")
const minimal = await import("~/seed/tiers/minimal")
const { createTestOrg } = await import("~/tests/helpers/org")
const { acquireTestLock, releaseTestLock } = await import("~/tests/route-test-setup")

type Json = Record<string, any>

const GMAIL_ADDRESS = `dana.${crypto.randomUUID().slice(0, 6)}@example.com`
/** What the fake provider hands out: none of it may reach the card, the line or the agent. */
const CODE = `code-${crypto.randomUUID()}`
const ACCESS = `ya29.access-${crypto.randomUUID()}`
const REFRESH = `1//refresh-${crypto.randomUUID()}`
const SHOPIFY_SECRET = `shpss_${crypto.randomUUID()}`

/** A callback query signed as Shopify signs it, with the store's client secret. */
function shopifySigned(params: Record<string, string>): string {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&")
  const hmac = crypto.createHmac("sha256", SHOPIFY_SECRET).update(message).digest("hex")
  return new URLSearchParams({ ...params, hmac }).toString()
}

let orgId: string
let adminId: string
let adminToken: string
let memberId: string
let memberToken: string
let otherMemberToken: string
let otherMemberId: string
let secondAdminToken: string
let threadId: string
let agentId: string
let provider: ReturnType<typeof Bun.serve> | null = null
let providerBase = ""
/** The codes the fake token endpoint was asked to exchange. */
const exchanged: string[] = []

async function req(
  token: string | null,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.cookie) headers.Cookie = init.cookie
  const res = await app.request(path, {
    method: init.method ?? "GET",
    headers,
    redirect: "manual",
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  const text = await res.text()
  let body: Json = {}
  try {
    body = text ? (JSON.parse(text) as Json) : {}
  } catch {
    body = { html: text }
  }
  return {
    status: res.status,
    body,
    location: res.headers.get("location") ?? "",
    setCookie: res.headers.get("set-cookie") ?? "",
  }
}

/** The agent's request_secret call, as the person whose turn it is. */
async function agentAsks(userId: string, target: Json): Promise<string> {
  const perms = await withPrivilegedDb(orgId, "test-connect-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  const out = await withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    (db) =>
      handleRequestSecret(
        { kind: "oauth_connect", target },
        { userId, orgId, db, agentExecutionThreadId: threadId, scopes: perms.scopes },
      ),
  )
  if (!("requestId" in out)) throw new Error(`refused: ${JSON.stringify(out)}`)
  await sql`UPDATE kernel.secret_requests SET agent_id = ${agentId} WHERE id = ${out.requestId}`
  return out.requestId
}

/**
 * Point a started flow's token exchange at the local fake provider. A flow
 * only starts against an https endpoint, so the manifest's real token URL is
 * kept for the start and swapped in the stored state, the one place the
 * callback reads it from.
 */
async function exchangeWithFakeProvider(state: string, path: string): Promise<void> {
  const key = `oauth:state:${state}`
  const raw = await redis.get(key)
  if (!raw) throw new Error("no stored state")
  await redis.set(
    key,
    JSON.stringify({ ...JSON.parse(raw), tokenUrl: `${providerBase}${path}` }),
    "EX",
    600,
  )
}

/** The person presses Connect: the provider's URL, its state, and the binding cookie. */
async function connect(token: string, requestId: string, body: Json = {}) {
  const res = await req(token, `/api/secret-requests/${requestId}/authorize`, {
    method: "POST",
    body,
  })
  const url = res.body.data?.redirectUrl ? new URL(String(res.body.data.redirectUrl)) : null
  const state = url?.searchParams.get("state") ?? ""
  if (state) {
    await exchangeWithFakeProvider(
      state,
      url?.host.endsWith(".myshopify.com") ? "/shop/admin/oauth/access_token" : "/google/token",
    )
  }
  return { res, url, state, cookie: res.setCookie.split(";")[0] ?? "" }
}

describe("oauth_connect: a consent card completed by the grant", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    adminId = (await minimal.person(orgId, { role: "admin" })).id
    adminToken = await minimal.token(adminId)
    memberId = (await minimal.person(orgId)).id
    memberToken = await minimal.token(memberId)
    const otherId = (await minimal.person(orgId)).id
    otherMemberId = otherId
    otherMemberToken = await minimal.token(otherId)
    secondAdminToken = await minimal.token((await minimal.person(orgId, { role: "admin" })).id)
    threadId = await minimal.thread(orgId, adminId)
    await withPrivilegedDb(orgId, "test-connect-members", async (tx) => {
      await tx.insert(threadParticipants).values({ threadId, userId: memberId, orgId })
      await tx.insert(threadParticipants).values({ threadId, userId: otherId, orgId })
    })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${orgId}, 'role', ${`@oc-${crypto.randomUUID().slice(0, 8)}`}, 'Setup',
              '["*"]'::jsonb)
      RETURNING id`
    agentId = agent.id
    await ensureAppsForOrg(orgId)

    // The local fake provider: a token endpoint answering an id_token that
    // names the Google account, or a Shopify-shaped token with no identity.
    provider = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        const form = new URLSearchParams(await request.text())
        exchanged.push(form.get("code") ?? "")
        // `${CODE}` answers the default account; `${CODE}~<email>` another one.
        const [code, other] = (form.get("code") ?? "").split("~")
        if (code !== CODE) return new Response("{}", { status: 400 })
        const email = other ? Buffer.from(other, "base64url").toString() : GMAIL_ADDRESS
        if (url.pathname === "/shop/admin/oauth/access_token") {
          return Response.json({ access_token: ACCESS, scope: "read_orders" })
        }
        const idToken = [
          Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
          Buffer.from(JSON.stringify({ email })).toString("base64url"),
          "",
        ].join(".")
        return Response.json({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3600,
          id_token: idToken,
          scope: "https://www.googleapis.com/auth/gmail.modify",
        })
      },
    })
    providerBase = `http://127.0.0.1:${provider.port}`

    // Gmail: the org's Google client and the real manifest connection; its
    // token exchange goes to the fake provider (exchangeWithFakeProvider).
    await setMailProviderEnabled(orgId, "gmail", true)
    await saveGoogleIntegrationConfig(orgId, {
      clientId: "1234-fake.apps.googleusercontent.com",
      clientSecret: `GOCSPX-${crypto.randomUUID()}`,
    })
    if (!connectionConfigRegistry.get([orgId, "mail", "gmail"])) {
      throw new Error("the mail app declares no gmail connection")
    }

    // Shopify: a per-store connection shaped like the bundled app's.
    await withPrivilegedDb(orgId, "test-connect-shopify", async (tx) => {
      await tx
        .insert(apps)
        .values({ orgId, name: "shopify", version: "1.0.0", config: null })
        .onConflictDoNothing()
      await tx.insert(oauthProviders).values({
        orgId,
        name: "shopify:shop",
        issuerUrl: "https://example.myshopify.com",
        clientId: "shopify-client-id",
        clientSecretEncrypted: encryptSecret(
          SHOPIFY_SECRET,
          env.ENCRYPTION_KEY,
          CryptoContext.oauthProviderClientSecret,
        ),
      })
    })
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      type: "oauth2",
      authorizationUrl: "https://{shop}/admin/oauth/authorize",
      tokenUrl: "https://{shop}/admin/oauth/access_token",
      scopes: ["read_orders"],
      // The Dev Dashboard guide (shopify-app-toml.ts) needs the API version.
      apiVersion: "2026-01",
      allowedDomains: ["*.myshopify.com"],
      templateVars: {
        shop: {
          lowercase: true,
          pattern: "^[a-z0-9][a-z0-9-]*(\\.myshopify\\.com)?$",
          appendSuffix: ".myshopify.com",
        },
      },
      identifierVar: "shop",
      callbackSignature: "hmac-sha256-query",
    })
  }, 180_000)

  afterAll(async () => {
    provider?.stop(true)
    await releaseTestLock()
  })

  afterEach(() => {
    enqueued.length = 0
  })

  it("a member's personal Gmail: only that member connects it; the grant saves the card", async () => {
    const id = await agentAsks(memberId, { app: "mail", connection: "gmail", mode: "personal" })

    const mine = await req(memberToken, `/api/secret-requests/${id}`)
    expect(mine.status).toBe(200)
    expect(mine.body.data).toMatchObject({
      kind: "oauth_connect",
      target: { app: "mail", connection: "gmail", mode: "personal" },
      status: "pending",
      canSubmit: true,
      fields: [],
      connect: { provider: "google" },
    })
    // Another member, and an admin, see it read-only and cannot start it.
    for (const token of [otherMemberToken, adminToken]) {
      const theirs = await req(token, `/api/secret-requests/${id}`)
      expect(theirs.body.data.canSubmit).toBe(false)
      const refused = await connect(token, id)
      expect(refused.res.status).toBe(403)
    }

    const started = await connect(memberToken, id)
    expect(started.res.status).toBe(200)
    expect(started.url?.origin).toBe("https://accounts.google.com")
    expect(started.cookie).toContain("__connect_state_")

    // A callback without the starting browser's cookie connects nothing.
    const foreign = await req(
      null,
      `/api/connections/callback?code=${CODE}&state=${encodeURIComponent(started.state)}`,
    )
    expect(foreign.status).toBe(302)
    expect(foreign.location).toContain("/api/connections/oauth-done?result=failed")
    expect((await req(memberToken, `/api/secret-requests/${id}`)).body.data.status).toBe("pending")

    // The real round trip: the popup ends on the closing page.
    const again = await connect(memberToken, id)
    const done = await req(
      null,
      `/api/connections/callback?code=${CODE}&state=${encodeURIComponent(again.state)}`,
      { cookie: again.cookie },
    )
    expect(done.status).toBe(302)
    expect(done.location).toBe(`${env.BASE_URL}/api/connections/oauth-done?result=connected`)
    expect(exchanged).toContain(CODE)

    const saved = await req(memberToken, `/api/secret-requests/${id}`)
    expect(saved.body.data).toMatchObject({ status: "saved", hint: GMAIL_ADDRESS })
    // The account is the member's own, never the org's.
    const [account] = await sql<{ owner_type: string; owner_id: string }[]>`
      SELECT owner_type, owner_id FROM kernel.connected_accounts
      WHERE org_id = ${orgId} AND app_name = 'mail' AND connection_name = 'gmail'
        AND status = 'active' AND identifier = ${GMAIL_ADDRESS}`
    expect(account).toEqual({ owner_type: "user", owner_id: memberId })

    // The conversation hears {connected, accountHint}; the agent's turn is queued.
    const [line] = await sql<{ content: string; metadata: Json }[]>`
      SELECT content, metadata FROM kernel.messages
      WHERE org_id = ${orgId} AND metadata->>'secretRequestId' = ${id}`
    expect(line.metadata).toMatchObject({
      type: "secret-request-result",
      kind: "oauth_connect",
      connected: true,
      accountHint: GMAIL_ADDRESS,
    })
    expect(line.content).toContain("connected by")
    const replayed = systemEventLine(line) ?? ""
    expect(replayed).toContain("connected; first sync pending")
    expect(enqueued.some((j) => j.payload.secretRequestId === id)).toBe(true)
    // No code and no token anywhere the card, the line or the agent can read.
    const visible = JSON.stringify([saved.body, line, replayed, enqueued])
    for (const secret of [CODE, ACCESS, REFRESH]) expect(visible).not.toContain(secret)
  })

  it("a client card carries its setup guide's values: Google's computed, Shopify's callback", async () => {
    const google = await withRlsContext(
      {
        actorType: "user",
        userId: adminId,
        orgId,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (db) =>
        handleRequestSecret(
          { kind: "google_integration_client", target: {} },
          { userId: adminId, orgId, db, agentExecutionThreadId: threadId, scopes: ["*"] },
        ),
    )
    if (!("requestId" in google)) throw new Error("refused")
    const card = await req(adminToken, `/api/secret-requests/${google.requestId}`)
    expect(card.body.data.guide.provider).toBe("google")
    expect(card.body.data.guide.values.redirectUris).toContain(
      `${env.BASE_URL}/api/connections/callback`,
    )
    expect(card.body.data.guide.values.scopes.length).toBeGreaterThan(0)

    const shop = await withRlsContext(
      { actorType: "user", userId: adminId, orgId, scopes: ["*"], dimensionGrants: {} },
      (db) =>
        handleRequestSecret(
          { kind: "oauth_client", target: { app: "shopify", connection: "shop" } },
          { userId: adminId, orgId, db, agentExecutionThreadId: threadId, scopes: ["*"] },
        ),
    )
    if (!("requestId" in shop)) throw new Error("refused")
    const shopCard = await req(adminToken, `/api/secret-requests/${shop.requestId}`)
    expect(shopCard.body.data.guide).toMatchObject({
      provider: "shopify",
      values: {
        clientSource: "none",
        redirectUrls: [`${env.BASE_URL}/api/connections/callback`],
        scopes: ["read_orders"],
        apiVersion: "2026-01",
      },
    })
  })

  it("the closing page says how it went and runs only its own script", async () => {
    const ok = await app.request("/api/connections/oauth-done?result=connected")
    expect(ok.status).toBe(200)
    expect(ok.headers.get("content-security-policy")).toContain("script-src 'sha256-")
    const html = await ok.text()
    expect(html).toContain('data-result="connected"')
    expect(html).toContain("window.close()")
    // A known reason shows its fixed sentence; text in the link is never shown.
    const failed = await app.request(
      `/api/connections/oauth-done?result=failed&reason=access_denied&message=${encodeURIComponent("Call +1 555 0100 now")}`,
    )
    const failedHtml = await failed.text()
    expect(failedHtml).toContain('data-result="failed"')
    expect(failedHtml).toContain("Access was not allowed at the provider.")
    expect(failedHtml).not.toContain("555 0100")
    expect(failedHtml).not.toContain("<script>")
    const unknown = await (
      await app.request("/api/connections/oauth-done?result=failed&reason=%3Cb%3Eyou%20won")
    ).text()
    expect(unknown).toContain("The connection did not complete.")
    expect(unknown).not.toContain("you won")
  })

  it("a shared Shopify store: the shop typed on the card, a same-tab return to the thread", async () => {
    const id = await agentAsks(adminId, { app: "shopify", connection: "shop", mode: "org" })
    const card = await req(adminToken, `/api/secret-requests/${id}`)
    expect(card.body.data).toMatchObject({
      canSubmit: true,
      fields: [{ name: "shop", secret: false, required: true }],
      connect: { provider: "shopify" },
    })
    // A member without the connection's admin scope sees it read-only.
    expect((await req(memberToken, `/api/secret-requests/${id}`)).body.data.canSubmit).toBe(false)

    // A store that is not one: a fixed sentence and a code, never the raw value or error.
    const bad = await connect(adminToken, id, { shop: "not a shop!", display: "tab" })
    expect(bad.res.status).toBe(400)
    expect(bad.res.body.error.code).toBe("connect_invalid_value")
    expect(bad.res.body.error.message).not.toContain("not a shop!")

    // A callback whose hmac does not check out connects nothing, and the tab
    // goes back to the conversation with the reason for the card.
    const forged = await connect(adminToken, id, { shop: "acme-store", display: "tab" })
    const refused = await req(
      null,
      `/api/connections/callback?code=${CODE}&state=${encodeURIComponent(forged.state)}&shop=acme-store.myshopify.com&hmac=${"ab".repeat(32)}`,
      { cookie: forged.cookie },
    )
    const back = new URL(refused.location)
    expect(back.pathname).toBe(`/threads/${threadId}`)
    expect(back.searchParams.get("connect_request")).toBe(id)
    expect(back.searchParams.get("oauth_error")).toBe("oauth_callback_refused")
    expect((await req(adminToken, `/api/secret-requests/${id}`)).body.data.status).toBe("pending")
    // Signed, but for another store than the one the card started: refused too.
    const swapped = await connect(adminToken, id, { shop: "acme-store", display: "tab" })
    const other = await req(
      null,
      `/api/connections/callback?${shopifySigned({ code: CODE, state: swapped.state, shop: "other-store.myshopify.com" })}`,
      { cookie: swapped.cookie },
    )
    expect(new URL(other.location).searchParams.get("oauth_error")).toBe("oauth_callback_refused")

    const started = await connect(adminToken, id, { shop: "Acme-Store", display: "tab" })
    expect(started.res.status).toBe(200)
    expect(started.url?.host).toBe("acme-store.myshopify.com")
    const done = await req(
      null,
      `/api/connections/callback?${shopifySigned({ code: CODE, state: started.state, shop: "acme-store.myshopify.com", timestamp: "1700000000" })}`,
      { cookie: started.cookie },
    )
    expect(done.status).toBe(302)
    expect(done.location).toEndWith(`/threads/${threadId}`)
    const saved = await req(adminToken, `/api/secret-requests/${id}`)
    expect(saved.body.data).toMatchObject({ status: "saved", hint: "acme-store.myshopify.com" })
    const [account] = await sql<{ owner_type: string }[]>`
      SELECT owner_type FROM kernel.connected_accounts
      WHERE org_id = ${orgId} AND app_name = 'shopify' AND status = 'active'`
    expect(account.owner_type).toBe("org")
  })

  it("a refused consent keeps the card pending and goes back to the conversation with why", async () => {
    const id = await agentAsks(adminId, { app: "mail", connection: "gmail", mode: "org" })
    const started = await connect(adminToken, id, { display: "tab" })
    const denied = await req(
      null,
      `/api/connections/callback?error=access_denied&error_description=${encodeURIComponent("The user denied access")}&state=${encodeURIComponent(started.state)}`,
      { cookie: started.cookie },
    )
    expect(denied.status).toBe(302)
    const back = new URL(denied.location)
    expect(back.pathname).toBe(`/threads/${threadId}`)
    expect(back.searchParams.get("oauth_error")).toBe("access_denied")
    expect(back.searchParams.get("connect_request")).toBe(id)
    // The provider's own words never travel back.
    expect(denied.location).not.toContain("denied%20access")
    expect((await req(adminToken, `/api/secret-requests/${id}`)).body.data.status).toBe("pending")
    // A finished card cannot be started again.
    await req(adminToken, `/api/secret-requests/${id}/cancel`, { method: "POST" })
    expect((await connect(adminToken, id)).res.status).toBe(409)
  })

  it("Gmail mailboxes switched off: no Connect card is posted, and an earlier card says so by code", async () => {
    const earlier = await agentAsks(adminId, { app: "mail", connection: "gmail", mode: "org" })
    await setMailProviderEnabled(orgId, "gmail", false)
    try {
      const perms = await withPrivilegedDb(orgId, "test-connect-perms", (tx) =>
        loadEffectivePermissions(tx, adminId, orgId),
      )
      const refused = await withRlsContext(
        {
          actorType: "user",
          userId: adminId,
          orgId,
          scopes: perms.scopes,
          dimensionGrants: perms.dimensionGrants,
        },
        (db) =>
          handleRequestSecret(
            { kind: "oauth_connect", target: { app: "mail", connection: "gmail", mode: "org" } },
            { userId: adminId, orgId, db, agentExecutionThreadId: threadId, scopes: perms.scopes },
          ),
      )
      if (!("error" in refused)) throw new Error("a card was posted while Gmail is off")
      expect(refused.error.code).toBe("connection_turned_off")
      // What turns it on, in the agent's own tool terms.
      expect(refused.error.message).toContain("kernel__config_apps")
      expect(refused.error.message).toContain("providers: { gmail: { enabled: true } }")

      const started = await connect(adminToken, earlier)
      expect(started.res.status).toBe(400)
      expect(started.res.body.error.code).toBe("connect_turned_off")
      expect(started.res.body.error.message).toContain("Settings > Mail")
    } finally {
      await setMailProviderEnabled(orgId, "gmail", true)
    }
  })

  it("an unexpected failure to start is a generic refusal, kept in the log", async () => {
    const calendar = connectionConfigRegistry.get([orgId, "calendar", "google-calendar"])
    if (!calendar) throw new Error("the calendar app declares no google-calendar connection")
    connectionConfigRegistry.set([orgId, "calendar", "google-calendar"], {
      ...calendar,
      authorizationUrl: "http://127.0.0.1:9/authorize",
    })
    try {
      const id = await agentAsks(adminId, {
        app: "calendar",
        connection: "google-calendar",
        mode: "org",
      })
      const res = await connect(adminToken, id)
      expect(res.res.status).toBe(400)
      expect(res.res.body.error.code).toBe("connect_failed")
      expect(res.res.body.error.message).not.toMatch(/Unsafe|127\.0\.0\.1/)
    } finally {
      connectionConfigRegistry.set([orgId, "calendar", "google-calendar"], calendar)
    }
  })

  it("two people in one conversation each get their own personal card, and only their own grant saves it", async () => {
    await sql`UPDATE kernel.connected_accounts SET status = 'disconnected'
      WHERE org_id = ${orgId} AND app_name = 'mail' AND connection_name = 'gmail'`
    const target = { app: "mail", connection: "gmail", mode: "personal" }
    const forMember = await agentAsks(memberId, target)
    const forOther = await agentAsks(otherMemberId, target)
    // Not deduplicated across people: each has a card they can submit.
    expect(forOther).not.toBe(forMember)
    expect(
      (await req(otherMemberToken, `/api/secret-requests/${forOther}`)).body.data.canSubmit,
    ).toBe(true)
    // The same person asking again gets the same card.
    expect(await agentAsks(otherMemberId, target)).toBe(forOther)

    // The other member connects their own Gmail from Settings: it settles THEIR
    // card, never the first member's.
    const res = await req(otherMemberToken, "/api/connections/mail/gmail/authorize", {
      method: "POST",
      body: { mode: "personal" },
    })
    const url = new URL(String(res.body.data.redirectUrl))
    const state = url.searchParams.get("state") ?? ""
    await exchangeWithFakeProvider(state, "/google/token")
    const otherEmail = Buffer.from(`other.${crypto.randomUUID().slice(0, 6)}@example.com`).toString(
      "base64url",
    )
    await req(
      null,
      `/api/connections/callback?code=${CODE}~${otherEmail}&state=${encodeURIComponent(state)}`,
      {
        cookie: res.setCookie.split(";")[0],
      },
    )
    expect((await req(otherMemberToken, `/api/secret-requests/${forOther}`)).body.data.status).toBe(
      "saved",
    )
    expect((await req(memberToken, `/api/secret-requests/${forMember}`)).body.data.status).toBe(
      "pending",
    )
  })

  it("an org card is settled only by its own flow: another admin's Settings connect leaves it", async () => {
    const id = await agentAsks(adminId, { app: "mail", connection: "gmail", mode: "org" })
    const res = await req(secondAdminToken, "/api/connections/mail/gmail/authorize", {
      method: "POST",
      body: { mode: "org" },
    })
    const url = new URL(String(res.body.data.redirectUrl))
    const state = url.searchParams.get("state") ?? ""
    await exchangeWithFakeProvider(state, "/google/token")
    const inbox = Buffer.from(`sales.${crypto.randomUUID().slice(0, 6)}@example.com`).toString(
      "base64url",
    )
    const done = await req(
      null,
      `/api/connections/callback?code=${CODE}~${inbox}&state=${encodeURIComponent(state)}`,
      { cookie: res.setCookie.split(";")[0] },
    )
    // Settings' own flow lands on the app's settings page, and stored the inbox.
    expect(done.location).not.toContain("oauth-done")
    const [stored] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.connected_accounts
      WHERE org_id = ${orgId} AND app_name = 'mail' AND owner_type = 'org' AND status = 'active'`
    expect(stored.n).toBeGreaterThan(0)
    expect((await req(adminToken, `/api/secret-requests/${id}`)).body.data.status).toBe("pending")
  })

  it("a card flow and a Settings connect run side by side in one browser", async () => {
    const id = await agentAsks(adminId, { app: "mail", connection: "gmail", mode: "org" })
    const card = await connect(adminToken, id)
    const settings = await req(adminToken, "/api/connections/mail/gmail/authorize", {
      method: "POST",
      body: { mode: "org" },
    })
    const settingsState =
      new URL(String(settings.body.data.redirectUrl)).searchParams.get("state") ?? ""
    await exchangeWithFakeProvider(settingsState, "/google/token")
    const jar = `${card.cookie}; ${settings.setCookie.split(";")[0]}`
    // The Settings flow finishing first does not break the card's binding.
    const shared = Buffer.from(`desk.${crypto.randomUUID().slice(0, 6)}@example.com`).toString(
      "base64url",
    )
    await req(
      null,
      `/api/connections/callback?code=${CODE}~${shared}&state=${encodeURIComponent(settingsState)}`,
      {
        cookie: jar,
      },
    )
    const cardInbox = Buffer.from(`card.${crypto.randomUUID().slice(0, 6)}@example.com`).toString(
      "base64url",
    )
    const done = await req(
      null,
      `/api/connections/callback?code=${CODE}~${cardInbox}&state=${encodeURIComponent(card.state)}`,
      { cookie: jar },
    )
    expect(done.location).toContain("result=connected")
    expect((await req(adminToken, `/api/secret-requests/${id}`)).body.data.status).toBe("saved")
  })

  it("the test stand-in provider is read only under NODE_ENV test", () => {
    expect(testOAuthProvider("test", "http://127.0.0.1:1/")).toBe("http://127.0.0.1:1")
    expect(testOAuthProvider("production", "http://127.0.0.1:1")).toBeNull()
    expect(testOAuthProvider("development", "http://127.0.0.1:1")).toBeNull()
    expect(testOAuthProvider("test", undefined)).toBeNull()
  })
})
