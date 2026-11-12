// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App pages (app-pages.ts) against the `pagefx` fixture, a SANDBOXED app: the
 * whole round trip on the real routes and the real sandbox run.
 *
 * Discriminators: a link is minted only for a person holding the page's scope; a
 * ticket renders once; the page carries only its declared hosts and an opaque
 * origin (sandbox) off the frame host; a route call runs the app's handler as
 * the page's person with the app's params; a route the page does not list,
 * another app's frame host, another org's host, or a person who lost the route's
 * scope is refused. The app's code gets a handle, never a URL: only the person,
 * signed in, opens it. A route call needs the session's key, which only the
 * page's bootstrap holds. Minting and calls are rate-limited; calls are audited.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { PAGE_FX_APP, pageFixtureApp } from "~/modules/apps/__fixtures__/page-app/descriptor"
import {
  PAGE_CALLS_PER_MINUTE,
  PAGE_KEY_HEADER,
  PAGE_LINKS_PER_WINDOW,
  renderAppPage,
} from "~/modules/apps/app-pages"
import { registerApps } from "~/modules/apps/runtime"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function mintToken(userId: string): Promise<string> {
  const [row] = await withSystemDb("app-pages-test-mint", (db) =>
    db
      .select({
        orgId: users.orgId,
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row) throw new Error(`mintToken: user ${userId} missing`)
  const perms = await withPrivilegedDb(row.orgId, "app-pages-test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, row.orgId),
  )
  return signAccessToken(
    {
      userId,
      orgId: row.orgId,
      name: row.name,
      authVersion: row.authVersion,
      permissionVersion: row.permissionVersion,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    60 * 60,
  )
}

async function mintLink(token: string, params?: unknown) {
  const res = await app.request(`/api/apps/${PAGE_FX_APP}/pages/hello/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(params === undefined ? {} : { params }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

/** The fixture's tool: `ctx.pages.link("hello", { tag })` from a run for the person. */
async function toolHandle(token: string, tag: string) {
  const res = await app.request(`/api/apps/${PAGE_FX_APP}/tools/page.link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ params: { tag } }),
  })
  const body = (await res.json()) as any
  return { status: res.status, result: (body.data?.result ?? body.data) as any }
}

async function openHandle(token: string, handle: unknown) {
  const res = await app.request(`/api/apps/${PAGE_FX_APP}/pages/open`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

/** The path of a minted URL, requested against the app (no network). */
function pathOf(url: string): string {
  const u = new URL(url)
  return `${u.pathname}${u.search}`
}

/** Render a page; answers the session's base path and the document. */
async function openPage(url: string) {
  const res = await app.request(pathOf(url))
  const html = await res.text()
  const script = /src="([^"]+\/page\.js)"/.exec(html)?.[1] ?? ""
  const key = /,k="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? ""
  return { res, html, sessionBase: script.replace(/\/page\.js$/, ""), key }
}

async function callRoute(
  page: { sessionBase: string; key: string },
  route: string,
  body: unknown,
  key: string | null = page.key,
) {
  const res = await app.request(`${pathOf(page.sessionBase)}/routes/${route}`, {
    method: "POST",
    headers: { "content-type": "text/plain", ...(key === null ? {} : { [PAGE_KEY_HEADER]: key }) },
    body: JSON.stringify(body),
  })
  return { status: res.status, headers: res.headers, body: (await res.json()) as any }
}

describe("app pages: a sandboxed app's page, served and called through the platform", () => {
  let orgId: string
  let userToken: string
  let userId: string
  let readerToken: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    await registerApps([pageFixtureApp], orgId)
    invalidateScopeCatalog(orgId)
    const user = await minimal.person(orgId, { role: "member" })
    userId = user.id
    await minimal.grantScope(user.id, "pagefx:items:read")
    await minimal.grantScope(user.id, "pagefx:items:write")
    userToken = await mintToken(user.id)
    const reader = await minimal.person(orgId, { role: "member" })
    await minimal.grantScope(reader.id, "pagefx:items:read")
    readerToken = await mintToken(reader.id)
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  test("round trip: handle, open, render, the person's click calls the route, the handler answers", async () => {
    const minted = await toolHandle(userToken, "acc-1")
    expect(minted.status).toBe(200)
    expect(minted.result.handle).toMatch(/^lpg_[A-Za-z0-9_-]{43}$/)
    expect(minted.result).not.toHaveProperty("url")
    const link = await openHandle(userToken, minted.result.handle)
    expect(link.status).toBe(200)
    expect(link.body.data.url).toMatch(/\/api\/app-pages\/[A-Za-z0-9_-]{43}$/)
    expect(link.body.data.expiresInSeconds).toBe(300)

    const page = await openPage(link.body.data.url)
    expect(page.res.status).toBe(200)
    expect(page.html).toContain("<title>Hello page</title>")
    expect(page.html).toContain('"tag":"acc-1"')
    // The key lives in the bootstrap's closure, which removes its own element and
    // holds its own fetch; never in liaisonPage.
    expect(page.key).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(page.html).toContain("removeChild(d)")
    expect(page.html).toContain("var f=window.fetch.bind(window)")
    expect(/liaisonPage=Object\.freeze\(\{params:[^}]*\}\),call:/.test(page.html)).toBe(true)
    const csp = page.res.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("script-src 'nonce-")
    expect(csp).toContain("https://apis.example.com")
    expect(csp).toContain("frame-src https://docs.example.com")
    expect(csp).toContain("sandbox allow-scripts")
    expect(csp).not.toContain("allow-same-origin")

    // The page's script: built from the app's pages/hello.ts.
    const js = await app.request(`${pathOf(page.sessionBase)}/page.js`)
    expect(js.status).toBe(200)
    expect(await js.text()).toContain("greet")

    // The click: the route runs the app's handler as this person, in the sandbox.
    const call = await callRoute(page, "greet", { name: "Ada" })
    expect(call.status).toBe(200)
    expect(call.headers.get("access-control-allow-origin")).toBe("*")
    expect(call.body.data).toEqual({
      greeting: "Hello Ada",
      params: { tag: "acc-1" },
      page: "hello",
      by: userId,
    })
    const [stored] = await sql<{ data: unknown }[]>`
      SELECT data FROM kernel.app_documents
      WHERE org_id = ${orgId} AND app = ${PAGE_FX_APP} AND collection = 'greetings' AND doc_id = 'last'`
    expect(stored?.data).toEqual({ name: "Ada", by: userId })
    const audited = await sql<{ actor_id: string }[]>`
      SELECT actor_id FROM kernel.audit_log
      WHERE org_id = ${orgId} AND action = ${`${PAGE_FX_APP}.page_route.called`}`
    expect(audited.map((r) => r.actor_id)).toContain(userId)
  }, 60_000)

  test("a session id alone calls nothing: the route needs the page's key", async () => {
    const page = await openPage((await mintLink(userToken)).body.data.url)
    for (const key of [null, "", "x".repeat(43), page.key.slice(0, -1)]) {
      const call = await callRoute(page, "greet", { name: "x" }, key)
      expect({ key, status: call.status, code: call.body.error?.code }).toEqual({
        key,
        status: 403,
        code: "page_key_invalid",
      })
    }
  }, 30_000)

  test("a handle opens only for its person, once; the app's code never holds a URL", async () => {
    const minted = await toolHandle(userToken, "mine")
    // Another member, or a bare call: not found, and the handle is not burnt.
    expect((await openHandle(readerToken, minted.result.handle)).status).toBe(404)
    expect((await openHandle(userToken, "lpg_nope")).status).toBe(404)
    expect((await openHandle(userToken, minted.result.handle)).status).toBe(200)
    expect((await openHandle(userToken, minted.result.handle)).status).toBe(404)
  }, 60_000)

  test("a widget page runs the platform's script with a narrow token; app code never holds one", async () => {
    const { CryptoContext, encryptSecret } = await import("~/lib/crypto")
    const { seedConnectedAccountRow } = await import("~/seed/factories/org/platform-rows")
    const account = (
      owner: string | null,
      identifier: string,
      token: string,
      grant: string[] | null = ["read", "openid", "email"],
    ) =>
      seedConnectedAccountRow({
        orgId,
        appName: PAGE_FX_APP,
        connectionName: "primary",
        ownerType: owner ? "user" : "org",
        ownerId: owner,
        providerType: "oauth2",
        identifier,
        accessTokenEncrypted: encryptSecret(
          token,
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        status: "active",
        createdBy: userId,
        ...(grant ? { metadata: { grantedOAuthScopes: grant } } : {}),
      })
    const reader = (
      await sql<{ id: string }[]>`
      SELECT id FROM kernel.users WHERE org_id = ${orgId} AND id <> ${userId} LIMIT 1`
    )[0]!.id
    const mine = await account(userId, "me@pages.test", "tok-mine")
    const broad = await account(userId, "broad@pages.test", "tok-broad", ["read", "write"])
    const unknown = await account(userId, "unknown@pages.test", "tok-unknown", null)
    const theirs = await account(reader, "them@pages.test", "tok-theirs")
    const orgOwned = await account(null, "team@pages.test", "tok-org")
    const pickerHandle = async (acc: string) => {
      const res = await app.request(`/api/apps/${PAGE_FX_APP}/tools/picker.link`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}`, "content-type": "application/json" },
        body: JSON.stringify({ params: { account: acc } }),
      })
      const body = (await res.json()) as any
      return (body.data?.result ?? body.data).handle as string
    }
    const render = async (acc: string) => {
      const link = await openHandle(userToken, await pickerHandle(acc))
      const res = await app.request(pathOf(link.body.data.url))
      return {
        url: link.body.data.url as string,
        status: res.status,
        html: await res.text(),
        policy: res.headers.get("content-security-policy") ?? "",
      }
    }
    const ok = await render(mine)
    expect(ok.status).toBe(200)
    // On the org's origin, the platform's widget script inline; no app script,
    // and nothing on `liaisonPage` (the object app code would read).
    expect(ok.url).toContain("/api/app-pages/")
    expect(ok.html).toContain('"token":"tok-mine"')
    expect(ok.html).toContain("(function(cfg,page){")
    expect(ok.html).not.toContain("page.js")
    expect(ok.html).not.toContain("connectionToken")
    expect(ok.policy).toContain("https://apis.google.com")
    expect(ok.policy).not.toContain("sandbox")
    const issued = await sql<{ metadata: Record<string, unknown> }[]>`
      SELECT metadata FROM kernel.audit_log
      WHERE org_id = ${orgId} AND action = ${`${PAGE_FX_APP}.page_widget.token_issued`}`
    expect(issued.map((r) => r.metadata.account)).toContain(mine)
    // A grant broader than tokenScopes, or none recorded: refused, no token.
    for (const acc of [broad, unknown]) {
      const refused = await render(acc)
      expect(refused.status).toBe(403)
      expect(refused.html).toContain("page_token_too_broad")
      expect(refused.html).not.toContain("tok-")
    }
    // Another member's account, and the org's without the connection's admin scope: refused.
    for (const acc of [theirs, orgOwned]) {
      const refused = await render(acc)
      expect(refused.status).toBe(403)
      expect(refused.html).not.toContain("tok-")
    }
    // A page with a script of its own never carries a token.
    const hello = await openPage((await mintLink(userToken)).body.data.url)
    expect(hello.html).not.toContain("tok-")
  }, 60_000)

  test("a link asked over HTTP takes no params: the opener cannot choose them", async () => {
    const r = await mintLink(userToken, { account: "someone-elses" })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe("params_not_accepted")
  }, 30_000)

  test("minting is rate-limited per person and app", async () => {
    const person = await minimal.person(orgId, { role: "member" })
    await minimal.grantScope(person.id, "pagefx:items:read")
    const token = await mintToken(person.id)
    for (let i = 0; i < PAGE_LINKS_PER_WINDOW; i++) expect((await mintLink(token)).status).toBe(200)
    const over = await mintLink(token)
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe("page_links_rate_limited")
  }, 60_000)

  test("route calls are rate-limited per page session", async () => {
    const page = await openPage((await mintLink(userToken)).body.data.url)
    // An unlisted route answers 404 after the key and the count: no sandbox run.
    for (let i = 0; i < PAGE_CALLS_PER_MINUTE; i++) {
      expect((await callRoute(page, "provision", {})).status).toBe(404)
    }
    const over = await callRoute(page, "provision", {})
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe("page_calls_rate_limited")
  }, 60_000)

  test("a ticket is refused on another org's host, and stays usable on its own", async () => {
    const link = await mintLink(userToken)
    const ticket = link.body.data.url.split("/").pop() as string
    await expect(
      renderAppPage(
        ticket,
        { kind: "org", binding: { kind: "org", slug: "no-such-org-xyz", origin: "https://x" } },
        "https://x",
      ),
    ).rejects.toMatchObject({ status: 404 })
    expect((await openPage(link.body.data.url)).res.status).toBe(200)
  }, 30_000)

  test("a ticket renders once", async () => {
    const link = await mintLink(userToken)
    expect((await openPage(link.body.data.url)).res.status).toBe(200)
    expect((await openPage(link.body.data.url)).res.status).toBe(404)
  }, 30_000)

  test("a person without the page's scope gets no link", async () => {
    const outsider = await minimal.person(orgId, { role: "member" })
    const r = await mintLink(await mintToken(outsider.id))
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe("forbidden")
  }, 30_000)

  test("a route needs its own scope too, checked as the person is now", async () => {
    const link = await mintLink(readerToken)
    expect(link.status).toBe(200)
    const page = await openPage(link.body.data.url)
    const call = await callRoute(page, "greet", { name: "x" })
    expect(call.status).toBe(403)
  }, 30_000)

  test("a route the page does not list, and an unknown page, are refused", async () => {
    const link = await mintLink(userToken)
    const page = await openPage(link.body.data.url)
    const call = await callRoute(page, "provision", {})
    expect(call.status).toBe(404)
    expect(call.body.error.code).toBe("route_not_found")
    const res = await app.request(`/api/apps/${PAGE_FX_APP}/pages/nope/link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(res.status).toBe(404)
  }, 30_000)

  test("a ticket is refused on another app's frame host", async () => {
    const link = await mintLink(userToken)
    const ticket = link.body.data.url.split("/").pop() as string
    await expect(
      renderAppPage(ticket, { kind: "frame", app: "otherapp", orgId }, "https://x.example"),
    ).rejects.toMatchObject({ status: 404 })
  }, 30_000)
})
