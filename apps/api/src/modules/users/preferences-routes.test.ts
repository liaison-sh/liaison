// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("PUT /api/user/preferences/theme", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "theme-admin@test.com",
        password: "testpass123",
        name: "Theme Admin",
      }),
    })
    token = ((await res.json()) as any).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("accepts valid theme and returns the updated row", async () => {
    const res = await app.request("/api/user/preferences/theme", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ theme: "dark" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.theme).toBe("dark")
  })

  it("persists across GET /api/user/preferences", async () => {
    await app.request("/api/user/preferences/theme", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ theme: "light" }),
    })
    const res = await app.request("/api/user/preferences", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.theme).toBe("light")
  })

  it("rejects invalid theme with 400", async () => {
    const res = await app.request("/api/user/preferences/theme", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ theme: "rainbow" }),
    })
    expect(res.status).toBe(400)
  })

  it("rejects unauthenticated requests with 401", async () => {
    const res = await app.request("/api/user/preferences/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "light" }),
    })
    expect(res.status).toBe(401)
  })
})

describe("PUT /api/user/preferences/magic-wand", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "wand-prefs@test.com",
        password: "testpass123",
        name: "Wand Prefs",
      }),
    })
    token = ((await res.json()) as { data: { accessToken: string } }).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` })

  it("stores a non-empty instruction and returns it", async () => {
    const res = await app.request("/api/user/preferences/magic-wand", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ instructions: "Use British spelling; warm tone." }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { magicWandInstructions: string | null } }
    expect(body.data.magicWandInstructions).toBe("Use British spelling; warm tone.")
  })

  it("persists across GET /api/user/preferences", async () => {
    const res = await app.request("/api/user/preferences", { headers: auth() })
    const body = (await res.json()) as { data: { magicWandInstructions: string | null } }
    expect(body.data.magicWandInstructions).toBe("Use British spelling; warm tone.")
  })

  it("clears the instruction when given an empty string (stored as null)", async () => {
    const res = await app.request("/api/user/preferences/magic-wand", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ instructions: "   " }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { magicWandInstructions: string | null } }
    expect(body.data.magicWandInstructions).toBeNull()
  })

  it("rejects an over-long instruction (>2000 chars)", async () => {
    const res = await app.request("/api/user/preferences/magic-wand", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ instructions: "x".repeat(2001) }),
    })
    expect(res.status).toBe(400)
  })

  it("requires auth", async () => {
    const res = await app.request("/api/user/preferences/magic-wand", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instructions: "hi" }),
    })
    expect(res.status).toBe(401)
  })
})

describe("PUT /api/user/preferences/home-cards", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "home-cards-prefs@test.com",
        password: "testpass123",
        name: "Home Cards Prefs",
      }),
    })
    token = ((await res.json()) as { data: { accessToken: string } }).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` })

  it("is null by default for a fresh user", async () => {
    const res = await app.request("/api/user/preferences", { headers: auth() })
    const body = (await res.json()) as { data: { homeCardLayout: unknown } }
    expect(body.data.homeCardLayout).toBeNull()
  })

  it("persists and GET round-trips", async () => {
    const res = await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({
        order: ["mail", "approvals", "messages", "feed"],
        collapsed: ["feed"],
      }),
    })
    expect(res.status).toBe(200)
    const putBody = (await res.json()) as {
      data: { homeCardLayout: { order: string[]; collapsed: string[] } }
    }
    expect(putBody.data.homeCardLayout).toEqual({
      order: ["mail", "approvals", "messages", "feed"],
      collapsed: ["feed"],
    })

    const getRes = await app.request("/api/user/preferences", { headers: auth() })
    const getBody = (await getRes.json()) as {
      data: { homeCardLayout: { order: string[]; collapsed: string[] } }
    }
    expect(getBody.data.homeCardLayout).toEqual({
      order: ["mail", "approvals", "messages", "feed"],
      collapsed: ["feed"],
    })
  })

  it("accepts unknown card ids (forward compatible)", async () => {
    const res = await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ order: ["mail", "some-future-card"], collapsed: [] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { homeCardLayout: { order: string[] } } }
    expect(body.data.homeCardLayout.order).toEqual(["mail", "some-future-card"])
  })

  it("rejects wrong types with a 400 envelope error", async () => {
    const res = await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ order: "mail", collapsed: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toBeTruthy()
  })

  it("rejects oversized arrays (>16 ids, or an id >32 chars)", async () => {
    const tooManyRes = await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({
        order: Array.from({ length: 17 }, (_, i) => `card-${i}`),
        collapsed: [],
      }),
    })
    expect(tooManyRes.status).toBe(400)

    const tooLongRes = await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ order: ["x".repeat(33)], collapsed: [] }),
    })
    expect(tooLongRes.status).toBe(400)
  })

  it("survives a full-replace PUT /api/user/preferences save (theme trap regression)", async () => {
    await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ order: ["approvals", "messages"], collapsed: ["approvals"] }),
    })

    const fullReplaceRes = await app.request("/api/user/preferences", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({
        digestCadence: "daily",
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: [1, 2, 3, 4, 5],
        timezone: "UTC",
      }),
    })
    expect(fullReplaceRes.status).toBe(200)

    const getRes = await app.request("/api/user/preferences", { headers: auth() })
    const body = (await getRes.json()) as {
      data: { homeCardLayout: { order: string[]; collapsed: string[] } }
    }
    expect(body.data.homeCardLayout).toEqual({
      order: ["approvals", "messages"],
      collapsed: ["approvals"],
    })
  })

  it("requires auth", async () => {
    const res = await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order: [], collapsed: [] }),
    })
    expect(res.status).toBe(401)
  })

  it("another user in the same org cannot read or write my row", async () => {
    // Save a distinctive layout as user 1 first — the previous version of
    // this test only checked that a BRAND NEW user's own row is null, which
    // is vacuous (true even with zero RLS/route scoping, e.g. an UPDATE with
    // no WHERE clause or a GET returning an arbitrary row). Proving real
    // isolation requires attempting to read/write user 1's ALREADY-SAVED row
    // from user 2's session and asserting it's neither visible nor mutable.
    //
    // A second `/api/auth/register` in the SAME org is gated by invitation
    // (bootstrapRegister single-org invariant), so `createTestUserSession`
    // is called with the existing org id (decoded straight from user 1's
    // access token — the JWT payload segment, no verification needed here)
    // rather than with no `orgId`, which would go through `createTestOrg`
    // and truncate user 1's row out from under this test.
    await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ order: ["mail", "feed"], collapsed: ["mail"] }),
    })

    const orgId = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"))
      .orgId as string
    const other = await minimal.session(orgId)

    const getRes = await app.request("/api/user/preferences", {
      headers: { Authorization: `Bearer ${other.bearer}` },
    })
    const body = (await getRes.json()) as { data: { homeCardLayout: unknown } }
    // User 2's own row is fresh — must never leak user 1's saved layout.
    expect(body.data.homeCardLayout).toBeNull()

    const putRes = await app.request("/api/user/preferences/home-cards", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${other.bearer}` },
      body: JSON.stringify({ order: ["approvals"], collapsed: [] }),
    })
    expect(putRes.status).toBe(200)

    // User 1's row must be completely unaffected by user 2's write.
    const user1Res = await app.request("/api/user/preferences", { headers: auth() })
    const user1Body = (await user1Res.json()) as {
      data: { homeCardLayout: { order: string[]; collapsed: string[] } }
    }
    expect(user1Body.data.homeCardLayout).toEqual({ order: ["mail", "feed"], collapsed: ["mail"] })
  })
})

// S16: the reaction picker's favourites row, one targeted column (0111).
describe("PUT /api/user/preferences/favorite-emoji", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "favorite-emoji-prefs@test.com",
        password: "testpass123",
        name: "Favorite Emoji Prefs",
      }),
    })
    token = ((await res.json()) as { data: { accessToken: string } }).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` })
  const put = (body: unknown) =>
    app.request("/api/user/preferences/favorite-emoji", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify(body),
    })

  it("is null by default for a fresh user (the client shows the 9 defaults)", async () => {
    const res = await app.request("/api/user/preferences", { headers: auth() })
    const body = (await res.json()) as { data: { favoriteEmoji: unknown } }
    expect(body.data.favoriteEmoji).toBeNull()
  })

  it("persists the list in order and GET round-trips", async () => {
    const res = await put({ favoriteEmoji: ["🚀", "👍🏽", "👨‍👩‍👧", "🇫🇷"] })
    expect(res.status).toBe(200)
    const putBody = (await res.json()) as { data: { favoriteEmoji: string[] } }
    expect(putBody.data.favoriteEmoji).toEqual(["🚀", "👍🏽", "👨‍👩‍👧", "🇫🇷"])

    const getRes = await app.request("/api/user/preferences", { headers: auth() })
    const getBody = (await getRes.json()) as { data: { favoriteEmoji: string[] } }
    expect(getBody.data.favoriteEmoji).toEqual(["🚀", "👍🏽", "👨‍👩‍👧", "🇫🇷"])
  })

  it("accepts an empty list (every favourite unpinned)", async () => {
    const res = await put({ favoriteEmoji: [] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { favoriteEmoji: string[] } }
    expect(body.data.favoriteEmoji).toEqual([])
  })

  it("refuses more than 24 favourites, plain text and duplicates", async () => {
    // 25 distinct emoji (U+1F600..U+1F618): only the cap refuses them.
    const many = Array.from({ length: 25 }, (_, i) => String.fromCodePoint(0x1f600 + i))
    expect((await put({ favoriteEmoji: many.slice(0, 24) })).status).toBe(200)
    expect((await put({ favoriteEmoji: many })).status).toBe(400)
    expect((await put({ favoriteEmoji: ["👍", "abc"] })).status).toBe(400)
    expect((await put({ favoriteEmoji: ["👍", "👍"] })).status).toBe(400)
    expect((await put({ favoriteEmoji: "👍" })).status).toBe(400)
  })

  it("survives a full-replace PUT /api/user/preferences save", async () => {
    await put({ favoriteEmoji: ["🎉", "🙏"] })
    const fullReplaceRes = await app.request("/api/user/preferences", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({
        digestCadence: "daily",
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: [1, 2, 3, 4, 5],
        timezone: "UTC",
      }),
    })
    expect(fullReplaceRes.status).toBe(200)
    const getRes = await app.request("/api/user/preferences", { headers: auth() })
    const body = (await getRes.json()) as { data: { favoriteEmoji: string[] } }
    expect(body.data.favoriteEmoji).toEqual(["🎉", "🙏"])
  })
})

// The assistant-mail switch relayed between the holder's devices (0115). The
// server is a relay: it stores the newest change only, refuses an "on" that
// carries no mailbox MAC, and tells only the holder's own devices.
describe("PUT /api/user/preferences/agent-mail-access", () => {
  let token: string
  let userId: string
  const frames: Record<string, unknown>[] = []

  beforeAll(async () => {
    await acquireTestLock()
    const { onEvent } = await import("~/infra/events/event-bus")
    onEvent(
      async (event) => {
        if (event.app === "kernel" && event.entity === "read_state") {
          frames.push(event.data as Record<string, unknown>)
        }
      },
      { delivery: "per-replica" },
    )
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "agent-mail-access-prefs@test.com",
        password: "testpass123",
        name: "Agent Mail Access Prefs",
      }),
    })
    token = ((await res.json()) as { data: { accessToken: string } }).data.accessToken
    userId = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).userId
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` })
  const put = (body: unknown) =>
    app.request("/api/user/preferences/agent-mail-access", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify(body),
    })
  const framesFor = async (from: number) => {
    for (let i = 0; i < 50 && frames.length === from; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    return frames.slice(from).filter((f) => f.kind === "agent_mail_access")
  }

  it("is null until a device syncs it", async () => {
    const res = await app.request("/api/user/preferences", { headers: auth() })
    const body = (await res.json()) as { data: { agentMailAccess: unknown } }
    expect(body.data.agentMailAccess).toBeNull()
  })

  it("refuses an 'on' without the mailbox MAC", async () => {
    const res = await put({ enabled: true, at: 1_000 })
    expect(res.status).toBe(400)
  })

  it("stores an 'off', tells the holder's devices, and GET round-trips", async () => {
    const from = frames.length
    const res = await put({ enabled: false, at: 2_000 })
    expect(res.status).toBe(200)
    expect(await framesFor(from)).toEqual([
      { forUserId: userId, kind: "agent_mail_access", enabled: false, at: 2_000 },
    ])
    const getRes = await app.request("/api/user/preferences", { headers: auth() })
    const getBody = (await getRes.json()) as { data: { agentMailAccess: unknown } }
    expect(getBody.data.agentMailAccess).toEqual({ enabled: false, at: 2_000 })
  })

  it("never lets an older change overwrite a newer one, and says nothing for it", async () => {
    const from = frames.length
    const stale = await put({ enabled: true, at: 1_500, mac: "c3RhbGU=" })
    expect(stale.status).toBe(200)
    const body = (await stale.json()) as { data: { agentMailAccess: unknown; changed: boolean } }
    expect(body.data).toEqual({ agentMailAccess: { enabled: false, at: 2_000 }, changed: false })
    await new Promise((r) => setTimeout(r, 50))
    expect(frames.slice(from).filter((f) => f.kind === "agent_mail_access")).toEqual([])
  })

  it("stores a newer signed 'on' as given (the devices verify the MAC)", async () => {
    const res = await put({ enabled: true, at: 3_000, mac: "bWFj" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { agentMailAccess: unknown } }
    expect(body.data.agentMailAccess).toEqual({ enabled: true, at: 3_000, mac: "bWFj" })
  })
})

// "Clean up dictation automatically" (S11, migration 0173): default on, its own
// targeted PUT, and untouched by the full-replace preferences save.
describe("PUT /api/user/preferences/dictation", () => {
  let token: string

  beforeAll(async () => {
    await acquireTestLock()
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dictation-prefs@test.com",
        password: "testpass123",
        name: "Dictation Prefs",
      }),
    })
    token = ((await res.json()) as { data: { accessToken: string } }).data.accessToken
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  const auth = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` })
  const read = async () => {
    const res = await app.request("/api/user/preferences", { headers: auth() })
    return ((await res.json()) as { data: { dictationAutoClean: boolean } }).data
  }

  it("defaults to on", async () => {
    expect((await read()).dictationAutoClean).toBe(true)
  })

  it("persists a toggle and returns it", async () => {
    const res = await app.request("/api/user/preferences/dictation", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ autoClean: false }),
    })
    expect(res.status).toBe(200)
    expect(
      ((await res.json()) as { data: { dictationAutoClean: boolean } }).data.dictationAutoClean,
    ).toBe(false)
    expect((await read()).dictationAutoClean).toBe(false)
  })

  it("is not reset by an unrelated full preferences save", async () => {
    await app.request("/api/user/preferences/dictation", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({ autoClean: false }),
    })
    const full = await app.request("/api/user/preferences", {
      method: "PUT",
      headers: auth(),
      body: JSON.stringify({
        digestCadence: "daily",
        workHoursStart: "09:00",
        workHoursEnd: "17:00",
        workDays: [1, 2, 3, 4, 5],
        timezone: "UTC",
      }),
    })
    expect(full.status).toBe(200)
    expect((await read()).dictationAutoClean).toBe(false)
  })

  it("rejects a non-boolean or an extra field (400)", async () => {
    for (const body of [{ autoClean: "yes" }, { autoClean: true, other: 1 }, {}]) {
      const res = await app.request("/api/user/preferences/dictation", {
        method: "PUT",
        headers: auth(),
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
  })
})
