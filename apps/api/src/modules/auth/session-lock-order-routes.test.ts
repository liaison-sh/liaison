// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A refresh and a sign-in of the same user at the same moment, through the
// real routes (auth.ts refreshSession and createSession).
//
// A sign-in locks the user row, then the user's sessions (createSession, so a
// concurrent deactivation cannot slip in, and the session cap counts under a
// lock). A refresh used to lock its session row first and the user row second.
// Run together, each held the row the other waited on: Postgres broke the
// deadlock by failing one of them, and a sign-in answered 500 ("deadlock
// detected" on the sessions FOR UPDATE, seen on the gate runner). Both now take
// the user row first, so the second one waits for the first.
//
// The test holds what a sign-in holds at its first step (the user row), starts
// a refresh, waits until that refresh is blocked on a lock, then takes the
// sign-in's second lock (the user's sessions). With the old order this is the
// deadlock; with one order the refresh simply waits and then rotates.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORIGIN = "http://localhost:5173"
const EMAIL = "lockorder@test.com"
const PASSWORD = "testpass123"
const UA = "Mozilla/5.0 (X11; Linux x86_64) LockOrderTest/1.0"

function cookieOf(res: Response): string {
  const header = res.headers.get("set-cookie") ?? ""
  const rt = header
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((v) => v.trim())
    .find((v) => v.includes("liaison_rt="))
  if (!rt) throw new Error(`no refresh cookie in: ${header}`)
  return rt.split(";")[0] as string
}

async function login(): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "User-Agent": UA },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  expect(res.status).toBe(200)
  return cookieOf(res)
}

async function refresh(cookie: string): Promise<Response> {
  return await app.request("/api/auth/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "User-Agent": UA,
      Cookie: cookie,
    },
    body: "{}",
  })
}

/** Resolves once some backend of this database waits on a row lock. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const [r] = await sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if ((r as { n: number }).n > 0) return
    if (Date.now() > deadline) throw new Error("the refresh never waited on a lock")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("a refresh and a sign-in of the same user", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Lock Order" }),
    })
  }, 120_000)
  afterAll(async () => {
    await releaseTestLock()
  })
  beforeEach(async () => {
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*"])
    await sql`DELETE FROM kernel.sessions WHERE user_id IN
      (SELECT id FROM kernel.users WHERE email = ${EMAIL})`
  })

  it("take the user row, then the sessions, in that order: neither deadlocks", async () => {
    const cookie = await login()
    const [user] = await sql`SELECT id FROM kernel.users WHERE email = ${EMAIL}`
    const userId = (user as { id: string }).id

    let refreshed: Promise<Response> | undefined
    await sql.begin(async (tx) => {
      // A sign-in's first lock (createSession): the user row.
      await tx`SELECT id FROM kernel.users WHERE id = ${userId} FOR UPDATE`
      refreshed = refresh(cookie)
      await untilSomeoneWaitsOnALock()
      // Its second: the user's live sessions (the cap's count).
      await tx`SELECT id FROM kernel.sessions
        WHERE user_id = ${userId} AND is_grace = false ORDER BY created_at FOR UPDATE`
    })

    const res = await (refreshed as Promise<Response>)
    expect(res.status).toBe(200)
    expect(cookieOf(res)).not.toBe(cookie)
  }, 30_000)
})
