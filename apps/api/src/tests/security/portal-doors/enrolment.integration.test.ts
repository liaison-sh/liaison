// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A client whose company requires a second factor, and who has none yet, signs in
// to a session that can only set one up: every other portal route refuses it, it
// cannot be refreshed, and a confirmed code turns it into a full session. A client
// who already has a factor never gets one.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { generateCurrentCode } from "~/modules/auth/totp"
import { PORTAL_ROUTES } from "~/modules/portal/routes-list"
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

async function verifyLinkFor(email: string): Promise<Response> {
  await clearSends()
  capture.sent = []
  await post("/api/portal/auth/request", { orgSlug: w.orgSlug, email })
  await new Promise((r) => setTimeout(r, 50))
  return post("/api/portal/auth/verify", linkOf(capture.sent[0]))
}

async function enrolmentToken(): Promise<string> {
  const res = await verifyLinkFor(w.clientB.email)
  expect(res.status).toBe(200)
  expect(cookieOf(res)).toBeNull()
  const body = (await res.json()) as { data: { enrolmentRequired?: true; enrolmentToken?: string } }
  expect(body.data.enrolmentRequired).toBe(true)
  return body.data.enrolmentToken as string
}

function call(method: string, path: string, token: string, body: unknown = {}) {
  return app.request(path.replace(/:id|:n/g, crypto.randomUUID()), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  })
}

beforeAll(async () => {
  await acquireTestLock()
  previous = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createSignInWorld()
  // Company B requires a second factor; its client has none.
  await sql`UPDATE kernel.companies SET portal_require_totp = true WHERE id = ${w.companyB}`
}, 120_000)

afterAll(async () => {
  setSystemEmailProvider(previous)
  if (w) await dropDoorWorld(w)
  await sql.unsafe("REVOKE liaison_portal FROM liaison_request GRANTED BY liaison").catch(() => {})
  await releaseTestLock()
})

describe("a client who must set up a second factor", () => {
  it("an enrolment session gets 403 on every other portal route", async () => {
    const token = await enrolmentToken()
    const others = PORTAL_ROUTES.filter(
      (r) =>
        r.access === "token" &&
        !r.path.endsWith("/me/totp/setup") &&
        !r.path.endsWith("/me/totp/confirm"),
    )
    expect(others.length).toBeGreaterThan(10)
    for (const r of others) {
      const res = await call(r.method, r.path, token)
      expect({ route: r.path, status: res.status }).toEqual({ route: r.path, status: 403 })
    }
    expect((await call("POST", "/api/portal/me/totp/setup", token)).status).toBe(200)
  })

  it("an enrolment session cannot be refreshed", async () => {
    const res = await verifyLinkFor(w.clientB.email)
    expect(cookieOf(res)).toBeNull()
    const refresh = await app.request("/api/portal/auth/refresh", {
      method: "POST",
      headers: { Origin: ORIGIN },
    })
    expect(refresh.status).toBe(401)
  })

  it("a confirmed code yields a full session", async () => {
    const token = await enrolmentToken()
    const setup = await call("POST", "/api/portal/me/totp/setup", token)
    const { secret } = ((await setup.json()) as { data: { secret: string } }).data
    expect(
      (await call("POST", "/api/portal/me/totp/confirm", token, { code: "000000" })).status,
    ).toBe(400)
    const confirmed = await call("POST", "/api/portal/me/totp/confirm", token, {
      code: generateCurrentCode(secret),
    })
    expect(confirmed.status).toBe(200)
    expect(cookieOf(confirmed)).not.toBeNull()
    const full = ((await confirmed.json()) as { data: { accessToken: string } }).data.accessToken
    expect((await call("GET", "/api/portal/me", full)).status).toBe(200)
    // The enrolment token itself stays what it was.
    expect((await call("GET", "/api/portal/me", token)).status).toBe(403)
    // From now on the link asks for the factor instead.
    const next = await verifyLinkFor(w.clientB.email)
    expect(await next.text()).toContain('"totpRequired":true')
  })

  it("a person who already has a factor never gets an enrolment session", async () => {
    await sql`UPDATE kernel.companies SET portal_require_totp = true WHERE id = ${w.companyA}`
    try {
      const res = await verifyLinkFor(w.clientTotp.email)
      const text = await res.text()
      expect(text).toContain('"totpRequired":true')
      expect(text).not.toContain("enrolment")
    } finally {
      await sql`UPDATE kernel.companies SET portal_require_totp = false WHERE id = ${w.companyA}`
    }
  })
})
