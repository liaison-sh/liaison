// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * App pages (app-pages.ts) against the `pagefx` fixture, a SANDBOXED app: the
 * whole round trip on the real routes and the real sandbox run.
 *
 * Discriminators: a link is minted only for a person holding the page's scope; a
 * ticket renders once; the page carries only its declared hosts and an opaque
 * origin (sandbox) off the frame host; a route call runs the app's handler as
 * the page's person with the opener's params; a route the page does not list,
 * another app's frame host, or a person who lost the route's scope is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { PAGE_FX_APP, pageFixtureApp } from "~/modules/apps/__fixtures__/page-app/descriptor"
import { renderAppPage } from "~/modules/apps/app-pages"
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

async function mintLink(token: string, params: unknown = { account: "acc-1" }) {
  const res = await app.request(`/api/apps/${PAGE_FX_APP}/pages/hello/link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ params }),
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
  return { res, html, sessionBase: script.replace(/\/page\.js$/, "") }
}

async function callRoute(sessionBase: string, route: string, body: unknown) {
  const res = await app.request(`${pathOf(sessionBase)}/routes/${route}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
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

  test("round trip: link, render, the person's click calls the route, the handler answers", async () => {
    const link = await mintLink(userToken)
    expect(link.status).toBe(200)
    expect(link.body.data.url).toMatch(/\/api\/app-pages\/[A-Za-z0-9_-]{43}$/)

    const page = await openPage(link.body.data.url)
    expect(page.res.status).toBe(200)
    expect(page.html).toContain("<title>Hello page</title>")
    expect(page.html).toContain('"account":"acc-1"')
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
    const call = await callRoute(page.sessionBase, "greet", { name: "Ada" })
    expect(call.status).toBe(200)
    expect(call.headers.get("access-control-allow-origin")).toBe("*")
    expect(call.body.data).toEqual({
      greeting: "Hello Ada",
      params: { account: "acc-1" },
      page: "hello",
      by: userId,
    })
    const [stored] = await sql<{ data: unknown }[]>`
      SELECT data FROM kernel.app_documents
      WHERE org_id = ${orgId} AND app = ${PAGE_FX_APP} AND collection = 'greetings' AND doc_id = 'last'`
    expect(stored?.data).toEqual({ name: "Ada", by: userId })
  }, 60_000)

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
    const call = await callRoute(page.sessionBase, "greet", { name: "x" })
    expect(call.status).toBe(403)
  }, 30_000)

  test("a route the page does not list, and an unknown page, are refused", async () => {
    const link = await mintLink(userToken)
    const page = await openPage(link.body.data.url)
    const call = await callRoute(page.sessionBase, "provision", {})
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

  test("ctx.pages.link from a tool run for the person mints a working link", async () => {
    const res = await app.request(`/api/apps/${PAGE_FX_APP}/tools/page.link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "content-type": "application/json" },
      body: JSON.stringify({ params: { tag: "from-tool" } }),
    })
    const body = (await res.json()) as any
    expect(res.status).toBe(200)
    const url = (body.data?.result ?? body.data)?.url as string
    expect(url).toMatch(/\/api\/app-pages\//)
    const page = await openPage(url)
    expect(page.html).toContain('"tag":"from-tool"')
  }, 60_000)
})
