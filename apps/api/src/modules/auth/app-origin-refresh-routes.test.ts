// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wrapped shells' session, end to end through the real routes.
//
// From capacitor://localhost and tauri://localhost every call to the server is
// CROSS SITE, so the SameSite=Strict refresh cookie is never attached: a
// wrapped session died at the first access-token expiry and the push client
// could never mint its bearer. The contract these tests pin is the fix: an app
// origin is answered with the refresh token in the BODY and no cookie at all,
// a browser origin keeps the cookie, and /api/auth/refresh accepts the token
// from the X-Liaison-Refresh header with the same rotation and revocation.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { env } from "~/lib/env"
import { REFRESH_TOKEN_HEADER } from "~/lib/response"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP_ORIGIN = "capacitor://localhost"
const BROWSER_ORIGIN = "http://localhost:5173"
const EMAIL = "shellsession@test.com"
const PASSWORD = "testpass123"

function setCookies(res: Response): string[] {
  const header = res.headers.get("set-cookie")
  return header === null ? [] : [header]
}

function refreshCookie(res: Response): string | null {
  const rt = setCookies(res).find((value) => value.startsWith("liaison_rt="))
  return rt ?? null
}

async function login(origin: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (origin !== null) headers.Origin = origin
  return app.request("/api/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
}

describe("a wrapped shell's refresh token", () => {
  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Shell Session" }),
    })
    expect(res.status).toBe(200)
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("gives an app origin the token in the body and sets no refresh cookie", async () => {
    const res = await login(APP_ORIGIN)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { accessToken: string; refreshToken?: string } }
    expect(typeof body.data.refreshToken).toBe("string")
    expect(body.data.refreshToken?.length).toBeGreaterThan(10)
    expect(refreshCookie(res)).toBeNull()
  })

  it("keeps the cookie for a browser origin", async () => {
    const res = await login(BROWSER_ORIGIN)
    expect(res.status).toBe(200)
    const cookie = refreshCookie(res)
    expect(cookie).not.toBeNull()
    expect(cookie).toContain("HttpOnly")
  })

  it("rotates on the header exactly as it rotates on the cookie", async () => {
    const res = await login(APP_ORIGIN)
    const first = (await res.json()) as { data: { refreshToken: string } }

    const rotated = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
        [REFRESH_TOKEN_HEADER]: first.data.refreshToken,
      },
      body: "{}",
    })
    expect(rotated.status).toBe(200)
    const second = (await rotated.json()) as {
      data: { accessToken: string; refreshToken?: string }
    }
    expect(typeof second.data.accessToken).toBe("string")
    expect(typeof second.data.refreshToken).toBe("string")
    expect(second.data.refreshToken).not.toBe(first.data.refreshToken)
    expect(refreshCookie(rotated)).toBeNull()

    // Rotation REVOKES the token it consumed, on this path as on the other.
    const replayed = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
        [REFRESH_TOKEN_HEADER]: first.data.refreshToken,
      },
      body: "{}",
    })
    expect(replayed.status).toBe(401)
  })

  it("refuses a logged-out token presented in the header", async () => {
    const res = await login(APP_ORIGIN)
    const session = (await res.json()) as { data: { refreshToken: string } }

    const loggedOut = await app.request("/api/auth/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
        [REFRESH_TOKEN_HEADER]: session.data.refreshToken,
      },
      body: "{}",
    })
    expect(loggedOut.status).toBe(200)

    const refused = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
        [REFRESH_TOKEN_HEADER]: session.data.refreshToken,
      },
      body: "{}",
    })
    expect(refused.status).toBe(401)
  })

  // THE NEGATIVE THE HARNESS USED TO HIDE. Every test process here runs with
  // EXPOSE_REFRESH_TOKEN_IN_BODY on, so "a browser origin gets no body token"
  // could not be asserted at all: the escape hatch handed it one. The flag is
  // read per request, so the seam is the parsed env itself, flipped around
  // this one case and restored whatever happens.
  it("gives a browser origin no body token once the escape hatch is off", async () => {
    const flag = env as { EXPOSE_REFRESH_TOKEN_IN_BODY: boolean }
    const saved = flag.EXPOSE_REFRESH_TOKEN_IN_BODY
    flag.EXPOSE_REFRESH_TOKEN_IN_BODY = false
    try {
      const res = await login(BROWSER_ORIGIN)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { accessToken: string; refreshToken?: string }
      }
      expect(typeof body.data.accessToken).toBe("string")
      expect(body.data.refreshToken).toBeUndefined()
      // The cookie is where it went, and it is the only copy.
      expect(refreshCookie(res)).not.toBeNull()
    } finally {
      flag.EXPOSE_REFRESH_TOKEN_IN_BODY = saved
    }
  })

  // An app origin is answered from the allowlist, never from the escape hatch:
  // with the flag off it still gets the body token, because that is the only
  // channel it has.
  it("still gives an app origin the body token with the escape hatch off", async () => {
    const flag = env as { EXPOSE_REFRESH_TOKEN_IN_BODY: boolean }
    const saved = flag.EXPOSE_REFRESH_TOKEN_IN_BODY
    flag.EXPOSE_REFRESH_TOKEN_IN_BODY = false
    try {
      const res = await login(APP_ORIGIN)
      const body = (await res.json()) as { data: { refreshToken?: string } }
      expect(typeof body.data.refreshToken).toBe("string")
      expect(refreshCookie(res)).toBeNull()
    } finally {
      flag.EXPOSE_REFRESH_TOKEN_IN_BODY = saved
    }
  })

  // THE HEADER IS THE SHELLS' CHANNEL AND NOTHING ELSE'S. A caller that presents
  // one from a browser origin gets a rotation whose new token is returned only in
  // a SameSite=Strict cookie it cannot keep across its own cross-site calls: the
  // old token is spent, the new one is unreachable, and the session is gone. That
  // is a 400 rather than a silent one-way door.

  it("refuses the header path for a browser origin", async () => {
    const res = await login(APP_ORIGIN)
    const session = (await res.json()) as { data: { refreshToken: string } }

    const refused = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: BROWSER_ORIGIN,
        [REFRESH_TOKEN_HEADER]: session.data.refreshToken,
      },
      body: "{}",
    })
    expect(refused.status).toBe(400)

    // Refused, not consumed: the token the shell holds still works.
    const accepted = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: APP_ORIGIN,
        [REFRESH_TOKEN_HEADER]: session.data.refreshToken,
      },
      body: "{}",
    })
    expect(accepted.status).toBe(200)
  })

  it("refuses the header path when the request carries no origin at all", async () => {
    const res = await login(APP_ORIGIN)
    const session = (await res.json()) as { data: { refreshToken: string } }

    const refused = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [REFRESH_TOKEN_HEADER]: session.data.refreshToken,
      },
      body: "{}",
    })
    expect(refused.status).toBe(400)
  })
})

// Two tabs of one browser (or the app and the MCP consent popup) refresh at the
// same moment with the same cookie. Only one may rotate it; the other used to
// get 401 AND a cookie-clearing Set-Cookie, which wiped the winner's fresh token
// and signed the whole browser out. The loser now gets 409 REFRESH_RACE and the
// cookie is left alone, so it retries with the rotated cookie.
describe("a concurrent refresh in the same browser", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Shell Session" }),
    })
  })
  afterAll(async () => {
    await releaseTestLock()
  })

  it("answers the loser 409 without clearing the cookie; a spent token after its grace is still 401", async () => {
    const res = await login(BROWSER_ORIGIN)
    const cookie = (refreshCookie(res) ?? "").split(";")[0] as string
    expect(cookie.startsWith("liaison_rt=")).toBe(true)
    const refresh = () =>
      app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BROWSER_ORIGIN, Cookie: cookie },
        body: "{}",
      })
    const first = await refresh()
    expect(first.status).toBe(200)
    const second = await refresh()
    expect(second.status).toBe(409)
    const body = (await second.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe("REFRESH_RACE")
    expect(refreshCookie(second)).toBeNull()

    // Past the grace window the same token is just spent: 401, cookie cleared.
    const { sql } = await import("~/db")
    const { hashToken } = await import("~/lib/crypto")
    const hash = hashToken(decodeURIComponent(cookie.slice("liaison_rt=".length)))
    await sql`UPDATE kernel.sessions SET expires_at = now() - interval '1 second'
      WHERE refresh_token_hash = ${hash}`
    const third = await refresh()
    expect(third.status).toBe(401)
  })
})
