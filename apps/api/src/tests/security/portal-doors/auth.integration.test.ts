// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal's doors of sign-in and token class, through the real app.
// Each test is named by its door id; each one fails when its protection is gone.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as jose from "jose"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withPortalContext } from "~/db/portal-rls"
import { withPrivilegedDb } from "~/db/privileged"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { createPortalSession, createSession } from "~/modules/auth/auth"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { generateCurrentCode } from "~/modules/auth/totp"
import { PORTAL_REFRESH_COOKIE } from "~/modules/portal/auth-routes"
import { PORTAL_PREFIX, PORTAL_ROUTES } from "~/modules/portal/routes-list"
import { createInvitation } from "~/modules/users/invites"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  CaptureProvider,
  clearSends,
  cookieOf,
  createSignInWorld,
  dropDoorWorld,
  linkOf,
  ORIGIN,
  post,
  type SignInWorld,
} from "./fixture"

let w: SignInWorld
let previous: EmailProvider
const capture = new CaptureProvider()
let portalToken: string
let memberToken: string

const UUID = "00000000-0000-4000-8000-000000000001"
const TEST_ONLY_PREFIXES = ["/api/_test/"]

function concretePath(path: string): string {
  return path
    .replace(":name/:version/ui.js", "tickets/1.0.0/ui.js")
    .replace(/:key\{\.\+\}/g, "a/b")
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, (m) =>
      /(id|Id)$/.test(m.split("{")[0] ?? "") ? UUID : "x1",
    )
}

function call(method: string, path: string, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...headers } }
  if (method !== "GET" && method !== "HEAD") {
    init.body = "{}"
    ;(init.headers as Record<string, string>)["Content-Type"] = "application/json"
  }
  return app.request(concretePath(path), init)
}

/** Every `METHOD path` the app mounts (middleware entries left out). */
function mountedRoutes(): string[] {
  const seen = new Set<string>()
  for (const r of app.routes) if (r.method !== "ALL") seen.add(`${r.method} ${r.path}`)
  return [...seen].sort()
}

const PORTAL_KEYS = new Set(PORTAL_ROUTES.map((r) => `${r.method} ${r.path}`))

beforeAll(async () => {
  await acquireTestLock()
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createSignInWorld()
  portalToken = (await createPortalSession(w.clientA.userId, w.orgId)).accessToken
  memberToken = (await createSession(w.member.userId, w.orgId)).accessToken
})

afterAll(async () => {
  setSystemEmailProvider(previous)
  await dropDoorWorld(w)
  await releaseTestLock()
})

describe("portal doors: sign-in and token classes", () => {
  it("NT-06: a client action's kind of token opens no portal route and sets no cookie", async () => {
    const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
    for (const r of PORTAL_ROUTES.filter((x) => x.access === "token")) {
      const res = await call(r.method, r.path, { Authorization: `Bearer ${raw}` })
      expect({ route: r.path, status: res.status }).toEqual({ route: r.path, status: 401 })
      expect(res.headers.get("set-cookie")).toBeNull()
    }
  })

  it("NT-08: a valid portal token gets 401 on every mounted route outside the portal list and the public ones", async () => {
    // A portal token is valid where it should be.
    expect(
      (await call("GET", `${PORTAL_PREFIX}/me`, { Authorization: `Bearer ${portalToken}` })).status,
    ).toBe(200)
    const opened: string[] = []
    const probed: string[] = []
    for (const key of mountedRoutes()) {
      const [method, path] = key.split(" ") as [string, string]
      if (PORTAL_KEYS.has(key) || TEST_ONLY_PREFIXES.some((p) => path.startsWith(p))) continue
      // A public route answers without a credential; the token changes nothing there.
      if ((await call(method, path)).status !== 401) continue
      probed.push(key)
      const res = await call(method, path, { Authorization: `Bearer ${portalToken}` })
      if (res.status !== 401) opened.push(`${key} -> ${res.status}`)
    }
    expect(opened).toEqual([])
    // The agent, tools, sockets, search, mentions and people are among them by name.
    for (const prefix of [
      "/api/agent",
      "/api/apps/",
      "/api/auth/ws-ticket",
      "/api/search",
      "/api/mentions",
      "/api/threads",
      "/api/approvals",
      "/api/knowledge",
      "/api/files",
      "/api/sharing/members",
      "/api/users/:id/preview",
    ]) {
      expect({ prefix, covered: probed.some((k) => k.split(" ")[1]?.startsWith(prefix)) }).toEqual({
        prefix,
        covered: true,
      })
    }
  })

  it("NT-09: the routes mounted under /api/portal are exactly the portal list", () => {
    const mounted = mountedRoutes().filter((k) => k.split(" ")[1]?.startsWith(`${PORTAL_PREFIX}/`))
    expect(mounted).toEqual([...PORTAL_KEYS].sort())
  })

  it("NT-25: a portal token cannot ask for a socket ticket", async () => {
    const res = await call("POST", "/api/auth/ws-ticket", {
      Authorization: `Bearer ${portalToken}`,
    })
    expect(res.status).toBe(401)
    // A member's token still gets one: the refusal is the token class, not the route.
    expect(
      (await call("POST", "/api/auth/ws-ticket", { Authorization: `Bearer ${memberToken}` }))
        .status,
    ).toBe(200)
  })

  it("NT-27: a member door never opens a session for a client's row", async () => {
    await clearSends()
    await expect(createSession(w.clientB.userId, w.orgId)).rejects.toThrow()
    const login = await post("/api/auth/login", {
      email: w.clientB.email,
      password: "Whatever-horse-1",
      orgSlug: w.orgSlug,
    })
    expect(login.status).toBe(401)
    capture.sent = []
    await post("/api/auth/magic-link/request", { email: w.clientB.email, orgSlug: w.orgSlug })
    await post("/api/auth/password-reset/request", { email: w.clientB.email, orgSlug: w.orgSlug })
    await new Promise((r) => setTimeout(r, 50))
    expect(capture.sent).toHaveLength(0)
  })

  it("NT-28: a portal session's refresh cookie on the member route gets 401, and a closed company's person gets no token from either route", async () => {
    const portal = await createPortalSession(w.clientB.userId, w.orgId)
    const onMember = await post("/api/auth/refresh", { refreshToken: portal.refreshToken })
    expect(onMember.status).toBe(401)
    expect(await onMember.text()).not.toContain("accessToken")
    // A member's access token on the portal gets 401.
    expect(
      (await call("GET", `${PORTAL_PREFIX}/me`, { Authorization: `Bearer ${memberToken}` })).status,
    ).toBe(401)
    // A member's refresh token on the portal's route gets 401.
    const member = await createSession(w.member.userId, w.orgId)
    const onPortal = await post(
      "/api/portal/auth/refresh",
      {},
      {
        Origin: ORIGIN,
        Cookie: `${PORTAL_REFRESH_COOKIE}=${member.refreshToken}`,
      },
    )
    expect(onPortal.status).toBe(401)
    // Company B closes: neither route gives its person a token.
    await sql`UPDATE kernel.companies SET closed_at = now() WHERE id = ${w.companyB}`
    try {
      const closed = await createPortalSession(w.clientB.userId, w.orgId).catch((e) => e)
      expect(closed).toBeInstanceOf(Error)
      const second = await post(
        "/api/portal/auth/refresh",
        {},
        {
          Origin: ORIGIN,
          Cookie: `${PORTAL_REFRESH_COOKIE}=${portal.refreshToken}`,
        },
      )
      expect(second.status).toBe(401)
      expect((await post("/api/auth/refresh", { refreshToken: portal.refreshToken })).status).toBe(
        401,
      )
    } finally {
      await sql`UPDATE kernel.companies SET closed_at = NULL WHERE id = ${w.companyB}`
    }
  })

  it("NT-30: a staff invitation for a client's address is refused with EMAIL_IS_PORTAL_USER", async () => {
    const roleId = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.roles", {
        id: roleId,
        org_id: w.orgId,
        name: `Plain ${roleId.slice(0, 6)}`,
      }),
    )
    const result = await withPrivilegedDb(w.orgId, "t", (tx) =>
      createInvitation(tx as never, {
        orgId: w.orgId,
        email: w.clientA.email.toUpperCase(),
        roleId,
        invitedBy: w.member.userId,
        actorScopes: ["*"],
        actorDimensionGrants: { "*": ["*"] },
      }),
    )
    expect(result).toEqual({ error: "EMAIL_IS_PORTAL_USER" })
    const [n] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.invitations WHERE org_id = ${w.orgId}`
    expect(n?.n).toBe(0)
  })

  it("NT-31: a member of one org who is a client of another still signs in to both", async () => {
    await clearSends()
    capture.sent = []
    await post("/api/auth/magic-link/request", { email: w.member.email })
    await post("/api/portal/auth/request", { orgSlug: w.otherOrgSlug, email: w.member.email })
    await new Promise((r) => setTimeout(r, 50))
    expect(capture.sent.map((m) => m.template).sort()).toEqual([
      "auth.sign-in-code",
      "portal.sign-in-link",
    ])
  })

  it("NT-32: sign-in answers every address with the same bytes and padded time, and mails only an active client", async () => {
    const slow = new CaptureProvider(500)
    setSystemEmailProvider(slow)
    const flooredEnv = env as { AUTH_ENUMERATION_FLOOR_MS: number }
    const savedFloor = flooredEnv.AUTH_ENUMERATION_FLOOR_MS
    flooredEnv.AUTH_ENUMERATION_FLOOR_MS = 300
    try {
      await clearSends()
      const addresses = [
        w.clientA.email,
        `nobody-${w.orgSlug}@example.com`,
        w.member.email,
        w.clientGone.email,
      ]
      const answers: { body: string; ms: number }[] = []
      for (const email of addresses) {
        const started = performance.now()
        const res = await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email })
        answers.push({ body: `${res.status} ${await res.text()}`, ms: performance.now() - started })
      }
      expect(new Set(answers.map((a) => a.body)).size).toBe(1)
      for (const a of answers) expect(a.ms).toBeGreaterThanOrEqual(295)
      // The mail of the known address is not awaited: its answer is not slower.
      const spread = Math.max(...answers.map((a) => a.ms)) - Math.min(...answers.map((a) => a.ms))
      expect(spread).toBeLessThan(150)
      await new Promise((r) => setTimeout(r, 600))
      expect(slow.sent.map((m) => m.to)).toEqual([w.clientA.email])
    } finally {
      flooredEnv.AUTH_ENUMERATION_FLOOR_MS = savedFloor
      setSystemEmailProvider(capture)
    }
  })

  it("NT-36: a scanner's GET does not use the link, a second use and an old link are refused, a required second factor blocks", async () => {
    await clearSends()
    capture.sent = []
    await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email: w.clientA.email })
    await new Promise((r) => setTimeout(r, 50))
    const link = linkOf(capture.sent[0])
    expect(
      (await app.request(`/api/portal/auth/verify#c=${link.challengeId}&t=${link.token}`)).status,
    ).toBe(404)
    expect((await post("/api/portal/auth/verify", link)).status).toBe(200)
    expect((await post("/api/portal/auth/verify", link)).status).toBe(401)
    capture.sent = []
    await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email: w.clientTotp.email })
    await new Promise((r) => setTimeout(r, 50))
    const totp = await post("/api/portal/auth/verify", linkOf(capture.sent[0]))
    expect(cookieOf(totp)).toBeNull()
    expect(await totp.text()).toContain('"totpRequired":true')
  })

  it("NT-49: portal API answers carry no referrer, no index, no store and no framing", async () => {
    for (const res of [
      await call("GET", `${PORTAL_PREFIX}/me`, { Authorization: `Bearer ${portalToken}` }),
      await call("GET", `${PORTAL_PREFIX}/auth/branding/${w.orgSlug}`),
      await call("GET", `${PORTAL_PREFIX}/me`),
    ]) {
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    }
  })

  it("NT-50: the company is read from the row, not the token; an unsigned or wrong-audience token is refused", async () => {
    const token = (await createPortalSession(w.clientB.userId, w.orgId)).accessToken
    const company = () =>
      withPortalContext(
        { orgId: w.orgId, userId: w.clientB.userId },
        async (tx) =>
          extractRows<{ c: string }>(
            await tx.execute(drizzleSql`SELECT portal.company_id() AS c`),
          )[0]?.c,
      )
    expect(await company()).toBe(w.companyB)
    await sql`UPDATE kernel.users SET company_id = ${w.companyA} WHERE id = ${w.clientB.userId}`
    try {
      expect(await company()).toBe(w.companyA)
      expect(
        (await call("GET", `${PORTAL_PREFIX}/me`, { Authorization: `Bearer ${token}` })).status,
      ).toBe(200)
    } finally {
      await sql`UPDATE kernel.users SET company_id = ${w.companyB} WHERE id = ${w.clientB.userId}`
    }
    const claims = {
      userId: w.clientA.userId,
      orgId: w.orgId,
      name: "x",
      authVersion: 1,
      permissionVersion: 1,
    }
    const none = new jose.UnsecuredJWT(claims)
      .setAudience("portal")
      .setExpirationTime("5m")
      .encode()
    const access = await new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("access")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(env.JWT_SECRET))
    const withCompany = await new jose.SignJWT({ ...claims, companyId: w.companyB })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("portal")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(env.JWT_SECRET))
    for (const t of [none, access, withCompany]) {
      expect(
        (await call("GET", `${PORTAL_PREFIX}/me`, { Authorization: `Bearer ${t}` })).status,
      ).toBe(401)
    }
  })

  it("NT-51: the refresh needs an allowed Origin, and the cookie alone opens no data route", async () => {
    const s = await createPortalSession(w.clientA.userId, w.orgId)
    const cookie = `${PORTAL_REFRESH_COOKIE}=${s.refreshToken}`
    expect((await post("/api/portal/auth/refresh", {}, { Cookie: cookie })).status).toBe(401)
    expect(
      (
        await post(
          "/api/portal/auth/refresh",
          {},
          { Cookie: cookie, Origin: "https://elsewhere.example" },
        )
      ).status,
    ).toBe(401)
    expect((await call("GET", `${PORTAL_PREFIX}/me`, { Cookie: cookie })).status).toBe(401)
    expect(
      (await post("/api/portal/auth/refresh", {}, { Cookie: cookie, Origin: ORIGIN })).status,
    ).toBe(200)
  })

  it("NT-52: branding gives a known slug's name, logo and notice only, and an unknown slug the same shape", async () => {
    const known = (await (
      await call("GET", `${PORTAL_PREFIX}/auth/branding/${w.orgSlug}`)
    ).json()) as {
      data: Record<string, unknown>
    }
    const unknown = (await (
      await call("GET", `${PORTAL_PREFIX}/auth/branding/no-such-${w.orgSlug}`)
    ).json()) as {
      data: Record<string, unknown>
    }
    expect(Object.keys(known.data).sort()).toEqual(["logoUrl", "name", "notice"])
    expect(Object.keys(unknown.data).sort()).toEqual(["logoUrl", "name", "notice"])
    expect(known.data.name).toBe(w.orgName)
    expect(unknown.data).toEqual({ name: null, logoUrl: null, notice: null })
  })

  it("a company whose portal access ended gives its person no link, no session and no refresh", async () => {
    await clearSends()
    capture.sent = []
    const before = await createPortalSession(w.clientB.userId, w.orgId)
    await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email: w.clientB.email })
    await new Promise((r) => setTimeout(r, 50))
    const link = linkOf(capture.sent[0])
    await sql`UPDATE kernel.companies SET portal_ended_at = now() WHERE id = ${w.companyB}`
    try {
      // A link mailed before the end is no longer good.
      const verify = await post("/api/portal/auth/verify", link)
      expect(verify.status).toBe(401)
      expect(cookieOf(verify)).toBeNull()
      // No new link is mailed.
      await clearSends()
      capture.sent = []
      await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email: w.clientB.email })
      await new Promise((r) => setTimeout(r, 50))
      expect(capture.sent).toHaveLength(0)
      // No session is minted, and the session from before does not refresh.
      expect(await createPortalSession(w.clientB.userId, w.orgId).catch((e) => e)).toBeInstanceOf(
        Error,
      )
      const refresh = await post(
        "/api/portal/auth/refresh",
        {},
        { Origin: ORIGIN, Cookie: `${PORTAL_REFRESH_COOKIE}=${before.refreshToken}` },
      )
      expect(refresh.status).toBe(401)
      expect(await refresh.text()).not.toContain("accessToken")
    } finally {
      await sql`UPDATE kernel.companies SET portal_ended_at = NULL WHERE id = ${w.companyB}`
    }
  })

  it("a company that requires a second factor gives no token without the code, and its sessions from before stop refreshing", async () => {
    const before = await createPortalSession(w.clientA.userId, w.orgId)
    await sql`UPDATE kernel.companies SET portal_require_totp = true WHERE id = ${w.companyA}`
    try {
      // A person with no second factor of their own gets no session from the link,
      // only the enrolment token that opens the second-factor setup.
      await clearSends()
      capture.sent = []
      await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email: w.clientA.email })
      await new Promise((r) => setTimeout(r, 50))
      const plain = await post("/api/portal/auth/verify", linkOf(capture.sent[0]))
      expect(cookieOf(plain)).toBeNull()
      const plainBody = await plain.text()
      expect(plainBody).not.toContain("accessToken")
      expect(plainBody).toContain('"enrolmentRequired":true')
      expect(await createPortalSession(w.clientA.userId, w.orgId).catch((e) => e)).toBeInstanceOf(
        Error,
      )
      const refresh = await post(
        "/api/portal/auth/refresh",
        {},
        { Origin: ORIGIN, Cookie: `${PORTAL_REFRESH_COOKIE}=${before.refreshToken}` },
      )
      expect(refresh.status).toBe(401)
      // A person with a second factor signs in with the code, and that session refreshes.
      capture.sent = []
      await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email: w.clientTotp.email })
      await new Promise((r) => setTimeout(r, 50))
      const step = (await (
        await post("/api/portal/auth/verify", linkOf(capture.sent[0]))
      ).json()) as { data: { challengeToken: string } }
      const signedIn = await post("/api/portal/auth/totp", {
        challengeToken: step.data.challengeToken,
        code: generateCurrentCode(w.clientTotp.secret),
      })
      expect(signedIn.status).toBe(200)
      const cookie = cookieOf(signedIn)
      expect(cookie).not.toBeNull()
      expect(
        (
          await post(
            "/api/portal/auth/refresh",
            {},
            { Origin: ORIGIN, Cookie: `${PORTAL_REFRESH_COOKIE}=${cookie}` },
          )
        ).status,
      ).toBe(200)
    } finally {
      await sql`UPDATE kernel.companies SET portal_require_totp = false WHERE id = ${w.companyA}`
    }
  })

  it("a deactivated client's live token stops at the next request", async () => {
    const token = (await createPortalSession(w.clientB.userId, w.orgId)).accessToken
    await sql`UPDATE kernel.users SET status = 'deactivated', auth_version = auth_version + 1 WHERE id = ${w.clientB.userId}`
    invalidateAuthCache(w.clientB.userId)
    try {
      expect(
        (await call("GET", `${PORTAL_PREFIX}/me`, { Authorization: `Bearer ${token}` })).status,
      ).toBe(401)
    } finally {
      await sql`UPDATE kernel.users SET status = 'active' WHERE id = ${w.clientB.userId}`
      invalidateAuthCache(w.clientB.userId)
    }
  })
})
