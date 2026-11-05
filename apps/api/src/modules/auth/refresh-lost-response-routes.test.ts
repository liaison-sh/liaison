// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A refresh whose RESPONSE IS LOST, end to end through the real routes
// (auth.ts refreshSession, migration 0224).
//
// The browser sends its cookie, the server rotates it and answers, and the
// answer never arrives: the browser keeps the spent cookie. Its retry used to
// get 409 for 30 s and then a 401 that signed it out. Now a retry inside the
// lost-response window, from the same client, while the successor is still
// unused, is handed a fresh successor in the same family. Every other replay
// of a spent token is reuse: the family is revoked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { hashToken } from "~/lib/crypto"
import { authLogger } from "~/lib/logger"
import { LOST_RESPONSE_WINDOW_MS } from "~/modules/auth/auth"
import { __resetSessionUseMemo } from "~/modules/auth/session-use"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORIGIN = "http://localhost:5173"
const EMAIL = "lostresponse@test.com"
const PASSWORD = "testpass123"
const UA = "Mozilla/5.0 (X11; Linux x86_64) LostResponseTest/1.0"

interface Pair {
  cookie: string
  accessToken: string
}

function cookieOf(res: Response): string {
  const header = res.headers.get("set-cookie") ?? ""
  const rt = header
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((v) => v.trim())
    .find((v) => v.includes("liaison_rt="))
  if (!rt) throw new Error(`no refresh cookie in: ${header}`)
  return rt.split(";")[0] as string
}

function tokenOf(cookie: string): string {
  return decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1))
}

async function login(): Promise<Pair> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "User-Agent": UA },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { accessToken: string } }
  return { cookie: cookieOf(res), accessToken: body.data.accessToken }
}

async function refresh(cookie: string, userAgent = UA): Promise<Response> {
  return app.request("/api/auth/refresh", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "User-Agent": userAgent,
      Cookie: cookie,
    },
    body: "{}",
  })
}

async function pairOf(res: Response): Promise<Pair> {
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { accessToken: string } }
  return { cookie: cookieOf(res), accessToken: body.data.accessToken }
}

/** One authenticated request with this access token (stamps the session's first use). */
async function useAccess(accessToken: string): Promise<void> {
  const res = await app.request("/api/auth/totp/status", {
    headers: { Authorization: `Bearer ${accessToken}`, Origin: ORIGIN },
  })
  expect(res.status).toBe(200)
}

/** Moves a rotated row's clock back, as if `ms` had passed since its rotation. */
async function age(cookie: string, ms: number): Promise<void> {
  const hash = hashToken(tokenOf(cookie))
  const interval = `${ms} milliseconds`
  await sql`UPDATE kernel.sessions
    SET rotated_at = rotated_at - ${interval}::interval,
        successor_issued_at = successor_issued_at - ${interval}::interval
    WHERE refresh_token_hash = ${hash}`
}

/** The `refresh_family_revoked_successor_used` lines logged while `run` ran. */
async function successorUsedEvents(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const warn = spyOn(authLogger, "warn")
  try {
    await run()
    return warn.mock.calls
      .map((call) => call[0] as unknown)
      .filter(
        (arg): arg is Record<string, unknown> =>
          typeof arg === "object" &&
          arg !== null &&
          (arg as { event?: unknown }).event === "refresh_family_revoked_successor_used",
      )
  } finally {
    warn.mockRestore()
  }
}

async function row(cookie: string) {
  const hash = hashToken(tokenOf(cookie))
  const [r] = await sql`SELECT id, family_id, successor_id, is_grace, used_at
    FROM kernel.sessions WHERE refresh_token_hash = ${hash}`
  return r as
    | { id: string; family_id: string; successor_id: string | null; is_grace: boolean }
    | undefined
}

async function liveSessions(): Promise<{ id: string; family_id: string }[]> {
  return (await sql`SELECT s.id, s.family_id FROM kernel.sessions s
    JOIN kernel.users u ON u.id = s.user_id
    WHERE u.email = ${EMAIL} AND s.is_grace = false AND s.expires_at > now()`) as unknown as {
    id: string
    family_id: string
  }[]
}

describe("a refresh whose response was lost", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Lost Response" }),
    })
  }, 120_000)
  afterAll(async () => {
    await releaseTestLock()
  })
  beforeEach(async () => {
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*"])
    await sql`DELETE FROM kernel.sessions WHERE user_id IN
      (SELECT id FROM kernel.users WHERE email = ${EMAIL})`
    __resetSessionUseMemo()
  })

  it("rotates normally: a new pair, one live session, the old row linked to it", async () => {
    const first = await login()
    await useAccess(first.accessToken)
    const second = await pairOf(await refresh(first.cookie))
    expect(second.cookie).not.toBe(first.cookie)
    await useAccess(second.accessToken)

    const old = await row(first.cookie)
    const now = await row(second.cookie)
    expect(old?.is_grace).toBe(true)
    expect(old?.successor_id).toBe(now?.id ?? "missing")
    expect(now?.family_id).toBe(old?.family_id ?? "missing")
    expect(await liveSessions()).toHaveLength(1)

    // The successor rotates as usual too.
    await pairOf(await refresh(second.cookie))
    expect(await liveSessions()).toHaveLength(1)
  })

  it("re-issues the unused successor to a retry inside the window: same family, one live session", async () => {
    const first = await login()
    const lost = await refresh(first.cookie)
    expect(lost.status).toBe(200) // the response the browser never received
    const lostRow = await row(cookieOf(lost))
    await age(first.cookie, 60_000)

    const retried = await pairOf(await refresh(first.cookie))
    const now = await row(retried.cookie)
    const old = await row(first.cookie)
    expect(now?.family_id).toBe(old?.family_id ?? "missing")
    expect(old?.successor_id).toBe(now?.id ?? "missing")
    // The successor nobody received is gone, replaced, not duplicated.
    expect(await row(cookieOf(lost))).toBeUndefined()
    expect(lostRow?.id).not.toBe(now?.id)
    const live = await liveSessions()
    expect(live.map((s) => s.id)).toEqual([now?.id ?? "missing"])

    // The pair works, and refreshes normally.
    await useAccess(retried.accessToken)
    await pairOf(await refresh(retried.cookie))
    expect(await liveSessions()).toHaveLength(1)
  })

  it("answers the race (409) while the successor is under 30 s old, without changing anything", async () => {
    const first = await login()
    const lost = await refresh(first.cookie)
    expect(lost.status).toBe(200)
    const raced = await refresh(first.cookie)
    expect(raced.status).toBe(409)
    expect(raced.headers.get("set-cookie")).toBeNull()
    expect(await row(cookieOf(lost))).toBeDefined()
    expect(await liveSessions()).toHaveLength(1)
  })

  it("treats a replay after the successor was used as theft: the family is revoked", async () => {
    const first = await login()
    const second = await pairOf(await refresh(first.cookie))
    await useAccess(second.accessToken)
    await age(first.cookie, 60_000)

    let replayStatus = 0
    const events = await successorUsedEvents(async () => {
      replayStatus = (await refresh(first.cookie)).status
    })
    expect(replayStatus).toBe(401)
    // The revocation names its case, so a triage can tell a client that lost
    // its rotated token from a stolen one.
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ successorUse: "request", sameClient: true })
    expect(await liveSessions()).toHaveLength(0)
    expect(await row(first.cookie)).toBeUndefined()
    // The revoked successor is dead too.
    expect((await refresh(second.cookie)).status).toBe(401)
  })

  it("ends only the replayed token's own sign-in: the user's other devices stay signed in", async () => {
    // A device presents a token rotated hours ago (a relaunched app whose
    // store kept the spent one). Only that device's family is ended; a browser
    // or phone signed in separately is another family and keeps its session.
    const otherDevice = await login()
    const first = await login()
    const second = await pairOf(await refresh(first.cookie))
    await useAccess(second.accessToken)
    await age(first.cookie, 2 * 60 * 60_000)

    const replay = await refresh(first.cookie)
    expect(replay.status).toBe(401)
    expect((await refresh(second.cookie)).status).toBe(401)

    const live = await liveSessions()
    expect(live).toHaveLength(1)
    const survivor = await row(otherDevice.cookie)
    expect(survivor?.family_id).toBeDefined()
    expect(live[0]?.family_id).toBe(survivor?.family_id ?? "missing")
    expect((await refresh(otherDevice.cookie)).status).toBe(200)
  })

  it("treats a replay after the successor was refreshed as theft", async () => {
    const first = await login()
    const second = await pairOf(await refresh(first.cookie))
    const third = await pairOf(await refresh(second.cookie))
    await age(first.cookie, 60_000)

    let status = 0
    const events = await successorUsedEvents(async () => {
      status = (await refresh(first.cookie)).status
    })
    expect(status).toBe(401)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ successorUse: "refresh" })
    expect(await liveSessions()).toHaveLength(0)
    expect((await refresh(third.cookie)).status).toBe(401)
  })

  it("treats a replay from another client as theft, even with the successor unused", async () => {
    const first = await login()
    const lost = await refresh(first.cookie)
    expect(lost.status).toBe(200)
    await age(first.cookie, 60_000)

    expect((await refresh(first.cookie, "curl/8.0")).status).toBe(401)
    expect(await liveSessions()).toHaveLength(0)
    expect((await refresh(cookieOf(lost))).status).toBe(401)
  })

  it("answers 401 outside the window and revokes the family", async () => {
    const first = await login()
    const lost = await refresh(first.cookie)
    expect(lost.status).toBe(200)
    await age(first.cookie, LOST_RESPONSE_WINDOW_MS + 1_000)

    const late = await refresh(first.cookie)
    expect(late.status).toBe(401)
    expect(late.headers.get("set-cookie") ?? "").toContain("liaison_rt=")
    expect(await liveSessions()).toHaveLength(0)
  })

  it("gives concurrent replays one winner; the others get the race answer", async () => {
    const first = await login()
    const lost = await refresh(first.cookie)
    expect(lost.status).toBe(200)
    await age(first.cookie, 60_000)

    const answers = await Promise.all([
      refresh(first.cookie),
      refresh(first.cookie),
      refresh(first.cookie),
    ])
    const statuses = answers.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409, 409])
    const winner = await pairOf(answers.find((r) => r.status === 200) as Response)
    const live = await liveSessions()
    expect(live).toHaveLength(1)
    expect(live[0]?.id).toBe((await row(winner.cookie))?.id ?? "missing")
    expect(new Set(live.map((s) => s.family_id)).size).toBe(1)
  })

  it("does not re-issue a successor that was signed out", async () => {
    const first = await login()
    const second = await pairOf(await refresh(first.cookie))
    const out = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: second.cookie },
      body: "{}",
    })
    expect(out.status).toBe(200)
    await age(first.cookie, 60_000)

    expect((await refresh(first.cookie)).status).toBe(401)
    expect(await liveSessions()).toHaveLength(0)
  })
})
