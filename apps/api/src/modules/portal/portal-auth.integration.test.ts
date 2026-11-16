// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client portal's sign-in through the real app: the mailed link, its one
// use and its 15 minutes, the second factor, the portal's own refresh cookie.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { redis } from "~/lib/redis"
import { createSession } from "~/modules/auth/auth"
import { generateCurrentCode } from "~/modules/auth/totp"
import { PORTAL_REFRESH_COOKIE } from "~/modules/portal/auth-routes"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  type AuthWorld,
  CaptureProvider,
  clearSends,
  cookieOf,
  createAuthWorld,
  dropAuthWorld,
  linkOf,
  ORIGIN,
  post,
} from "~/tests/security/portal-doors/auth-world"

let w: AuthWorld
let previous: EmailProvider
const capture = new CaptureProvider()

async function requestLink(email: string, orgSlug = w.org.slug) {
  capture.sent = []
  const res = await post("/api/portal/auth/request", { orgSlug, email })
  expect(res.status).toBe(200)
  // The send is not awaited by the route.
  await new Promise((r) => setTimeout(r, 50))
  return capture.sent.filter((m) => m.to === email.toLowerCase())
}

beforeAll(async () => {
  await acquireTestLock()
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createAuthWorld("auth")
})

afterAll(async () => {
  setSystemEmailProvider(previous)
  await dropAuthWorld(w)
  await releaseTestLock()
})

describe("portal sign-in", () => {
  it("sign-in mail goes to an active client of that organisation only", async () => {
    expect(await requestLink(w.clientA.email)).toHaveLength(1)
    // Wrong org, a member, a deactivated client, a closed company's client: no mail.
    expect(await requestLink(w.clientA.email, w.otherOrg.slug)).toHaveLength(0)
    expect(await requestLink(w.member.email)).toHaveLength(0)
    expect(await requestLink(w.clientGone.email)).toHaveLength(0)
    expect(await requestLink(w.clientClosed.email)).toHaveLength(0)
    const [mail] = await requestLink(w.clientB.email)
    expect(mail?.template).toBe("portal.sign-in-link")
    // The secret is in the link's fragment only, never a query string.
    expect(mail?.html).not.toMatch(/[?&]token=/)
  })

  it("a link opened by a scanner's GET is not used up", async () => {
    await clearSends()
    const link = linkOf((await requestLink(w.clientA.email))[0])
    // The page and any GET on the API: nothing consumes the link.
    expect((await app.request(`/api/portal/auth/verify?c=${link.challengeId}`)).status).toBe(404)
    const res = await post("/api/portal/auth/verify", link)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accessToken: string } }
    expect(body.data.accessToken).toBeString()
    expect(cookieOf(res)).toBeString()
    expect(res.headers.get("set-cookie")).toContain("HttpOnly; Secure; SameSite=Strict; Path=/")
  })

  it("a second use and a link past 15 minutes are refused", async () => {
    await clearSends()
    const link = linkOf((await requestLink(w.clientA.email))[0])
    const ttl = await redis.ttl(`magic:challenge:${link.challengeId}`)
    expect(ttl).toBeGreaterThan(14 * 60)
    expect(ttl).toBeLessThanOrEqual(15 * 60)
    expect((await post("/api/portal/auth/verify", link)).status).toBe(200)
    const again = await post("/api/portal/auth/verify", link)
    expect(again.status).toBe(401)

    await clearSends()
    const late = linkOf((await requestLink(w.clientA.email))[0])
    // Past its lifetime the challenge is gone: the same one refusal.
    await redis.pexpire(`magic:challenge:${late.challengeId}`, 1)
    await new Promise((r) => setTimeout(r, 20))
    const lateRes = await post("/api/portal/auth/verify", late)
    expect(lateRes.status).toBe(401)
    expect(await lateRes.text()).toBe(await again.text())
  })

  it("a member sign-in route does not accept a portal link", async () => {
    await clearSends()
    const link = linkOf((await requestLink(w.clientB.email))[0])
    const member = await post("/api/auth/magic-link/verify", {
      challengeId: link.challengeId,
      token: link.token,
    })
    expect(member.status).toBe(401)
    // Left intact for its own route.
    expect((await post("/api/portal/auth/verify", link)).status).toBe(200)
  })

  it("a client with a second factor gets no token before the code, and a wrong code waits", async () => {
    const link = linkOf((await requestLink(w.clientTotp.email))[0])
    const res = await post("/api/portal/auth/verify", link)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { totpRequired?: boolean; challengeToken: string; accessToken?: string }
    }
    expect(body.data.totpRequired).toBe(true)
    expect(body.data.accessToken).toBeUndefined()
    expect(cookieOf(res)).toBeNull()
    const started = performance.now()
    const wrong = await post("/api/portal/auth/totp", {
      challengeToken: body.data.challengeToken,
      code: "000000",
    })
    expect(wrong.status).toBe(401)
    expect(performance.now() - started).toBeGreaterThanOrEqual(950)
    const ok = await post("/api/portal/auth/totp", {
      challengeToken: body.data.challengeToken,
      code: generateCurrentCode(w.clientTotp.secret),
    })
    expect(ok.status).toBe(200)
    expect(cookieOf(ok)).toBeString()
  })

  it("a member's refresh cookie is refused on the portal refresh route", async () => {
    const memberTokens = await createSession(w.member.id, w.org.id)
    const res = await post(
      "/api/portal/auth/refresh",
      {},
      {
        Origin: ORIGIN,
        Cookie: `${PORTAL_REFRESH_COOKIE}=${memberTokens.refreshToken}`,
      },
    )
    expect(res.status).toBe(401)
    expect(res.headers.get("set-cookie")).toContain(`${PORTAL_REFRESH_COOKIE}=;`)
    // The member's own refresh still works: nothing about the session changed.
    const own = await post("/api/auth/refresh", { refreshToken: memberTokens.refreshToken })
    expect(own.status).toBe(200)
  })

  it("the portal refresh rotates the portal cookie from an allowed origin", async () => {
    await clearSends()
    const link = linkOf((await requestLink(w.clientA.email))[0])
    const signedIn = await post("/api/portal/auth/verify", link)
    const cookie = cookieOf(signedIn)
    const res = await post(
      "/api/portal/auth/refresh",
      {},
      {
        Origin: ORIGIN,
        Cookie: `${PORTAL_REFRESH_COOKIE}=${cookie}`,
      },
    )
    expect(res.status).toBe(200)
    const next = cookieOf(res)
    expect(next).toBeString()
    expect(next).not.toBe(cookie)
  })
})
