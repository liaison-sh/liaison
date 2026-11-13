// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Own-content auto-watch: our new Facebook Page posts and Instagram media are
// enrolled as `auto_own` watches by the watch poller, polled on a cadence that
// decays with the post's age, retired past the age cutoff, and capped so the
// Graph rate limits hold. Driven through the REAL Facebook and Instagram
// adapters against the Graph fakes (makeMockFetch).

import { describe, expect, test } from "bun:test"
import { facebookAdapter } from "./adapters/facebook"
import { instagramAdapter } from "./adapters/instagram"
import {
  connectedAccountList,
  type MockFetch,
  makeMockFetch,
  testAuth,
} from "./adapters/mock-fetch"
import { META_POLLS_PER_TICK, OWN_WATCH_CAP_PER_PLATFORM, ownPostCadence } from "./auto-watch"
import type { SocialToolCtx } from "./ctx"
import { runWatchPoller } from "./sync"
import { createMockDb, type MockDb } from "./test-db"

const NOW = new Date("2026-10-20T12:00:00.000Z")
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString()

function ctxWith(db: MockDb, fetch: MockFetch, logs: string[] = []): SocialToolCtx {
  return {
    orgId: "org-1",
    db,
    fetch,
    connections: { getAccounts: async () => connectedAccountList() },
    config: { get: async () => null },
    logger: {
      warn: (m: string) => logs.push(m),
      error: (m: string) => logs.push(m),
      info: () => {},
    },
    async emit() {},
  } as unknown as SocialToolCtx
}

async function seedAccount(
  db: MockDb,
  platform: "facebook" | "instagram",
  account: string,
): Promise<void> {
  await db.insert("sync_state", {
    platform,
    account_external_id: account,
    source_type: "discovery",
    active: true,
  })
}

interface WatchRow {
  id: string
  external_id: string
  reason: string
  status: string
  cadence_seconds: number
  next_poll_at: string | null
  last_polled_at: string | null
  metadata: { postedAt?: string; retiredReason?: string }
}

async function watches(db: MockDb, platform: string): Promise<WatchRow[]> {
  return (await db.findMany("watched_object", { where: { platform } })) as WatchRow[]
}

const commentCalls = (fetch: MockFetch) => fetch.calls.filter((c) => c.url.includes("/comments"))

describe("own-content auto-watch: enrollment", () => {
  test("a new own Facebook post becomes an auto_own watch on the fresh cadence and its comments are caught the same tick; an old post is not enrolled", async () => {
    const db = createMockDb()
    await seedAccount(db, "facebook", "user-1")
    const fetch = makeMockFetch({
      "/me/accounts": { data: [{ id: "page-1", name: "Page", access_token: "page-token" }] },
      "/page-1/posts": {
        data: [
          {
            id: "page-1_new",
            message: "New arrivals",
            permalink_url: "https://fb/new",
            created_time: hoursAgo(2),
          },
          { id: "page-1_old", message: "Old news", created_time: hoursAgo(20 * 24) },
        ],
      },
      "page-1_new/comments": {
        data: [
          {
            id: "page-1_c1",
            message: "Price?",
            from: { id: "fan-1", name: "Fan" },
            created_time: hoursAgo(1),
          },
          {
            id: "page-1_c2",
            message: "DM us",
            from: { id: "page-1", name: "Page" },
            created_time: hoursAgo(1),
          },
        ],
      },
    })
    const res = await runWatchPoller(ctxWith(db, fetch), {
      adapters: { facebook: facebookAdapter },
      now: NOW,
    })

    const rows = await watches(db, "facebook")
    expect(rows.map((r) => r.external_id)).toEqual(["page-1_new"])
    const w = rows[0] as WatchRow
    expect(w.reason).toBe("auto_own")
    expect(w.status).toBe("active")
    expect(w.metadata.postedAt).toBe(hoursAgo(2))
    // Polled this tick: fan comment ingested and linked, the Page's own reply skipped.
    expect(res.polled).toBe(1)
    const findings = (await db.findMany("finding", {})) as Array<{
      external_id: string
      watched_object_id: string
    }>
    expect(findings.map((f) => f.external_id)).toEqual(["page-1_c1"])
    expect(findings[0]?.watched_object_id).toBe(w.id)
    // Fresh post with activity: 5 min cadence; the comments read is newest first.
    expect(w.cadence_seconds).toBe(300)
    expect(w.next_poll_at).toBe(new Date(NOW.getTime() + 300_000).toISOString())
    expect(commentCalls(fetch)[0]?.url).toContain("order=reverse_chronological")
  })

  test("new Instagram media is enrolled; our own reply on it is not a finding", async () => {
    const db = createMockDb()
    await seedAccount(db, "instagram", "ig-1")
    const fetch = makeMockFetch({
      "/ig-1/media": {
        data: [
          { id: "m1", caption: "Launch", permalink: "https://ig/m1", timestamp: hoursAgo(30) },
        ],
      },
      "/me?": { id: "17841", username: "brand" },
      "/m1/comments": {
        data: [
          { id: "ic1", text: "Love it", username: "fan", timestamp: hoursAgo(1) },
          { id: "ic2", text: "Thanks!", username: "brand", timestamp: hoursAgo(1) },
        ],
      },
    })
    await runWatchPoller(ctxWith(db, fetch), {
      adapters: { instagram: instagramAdapter },
      now: NOW,
    })
    const [w] = await watches(db, "instagram")
    expect(w?.reason).toBe("auto_own")
    const findings = (await db.findMany("finding", {})) as Array<{ external_id: string }>
    expect(findings.map((f) => f.external_id)).toEqual(["ic1"])
  })

  test("an existing stopped watch (operator unwatch or retirement) is never resurrected", async () => {
    const db = createMockDb()
    await seedAccount(db, "instagram", "ig-1")
    await db.insert("watched_object", {
      platform: "instagram",
      external_id: "m1",
      object_type: "instagram_media",
      reason: "auto_own",
      status: "stopped",
      metadata: { postedAt: hoursAgo(1) },
    })
    const fetch = makeMockFetch({ "/ig-1/media": { data: [{ id: "m1", timestamp: hoursAgo(1) }] } })
    await runWatchPoller(ctxWith(db, fetch), {
      adapters: { instagram: instagramAdapter },
      now: NOW,
    })
    const rows = await watches(db, "instagram")
    expect(rows.length).toBe(1)
    expect(rows[0]?.status).toBe("stopped")
    expect(commentCalls(fetch).length).toBe(0)
  })

  test("a Graph throttle on the listing (code 4 on a 400) enrolls nothing and is logged", async () => {
    const db = createMockDb()
    await seedAccount(db, "instagram", "ig-1")
    const fetch = makeMockFetch(
      { "/ig-1/media": { error: { code: 4, message: "Application request limit reached" } } },
      { status: 400 },
    )
    const logs: string[] = []
    await runWatchPoller(ctxWith(db, fetch, logs), {
      adapters: { instagram: instagramAdapter },
      now: NOW,
    })
    expect((await watches(db, "instagram")).length).toBe(0)
    expect(logs.some((m) => /own posts listing failed/.test(m))).toBe(true)
  })
})

describe("own-content auto-watch: cadence decays with post age", () => {
  test("ownPostCadence bands", () => {
    expect(ownPostCadence(hoursAgo(1), false, NOW)).toBe(300)
    expect(ownPostCadence(hoursAgo(12), false, NOW)).toBe(900)
    expect(ownPostCadence(hoursAgo(48), false, NOW)).toBe(3600)
    expect(ownPostCadence(hoursAgo(5 * 24), false, NOW)).toBe(6 * 3600)
    expect(ownPostCadence(hoursAgo(10 * 24), false, NOW)).toBe(86_400)
    expect(ownPostCadence(hoursAgo(15 * 24), false, NOW)).toBeNull()
    expect(ownPostCadence(null, false, NOW)).toBeNull()
    // Fresh activity on an older post tightens to at most hourly, never looser than the band.
    expect(ownPostCadence(hoursAgo(5 * 24), true, NOW)).toBe(3600)
    expect(ownPostCadence(hoursAgo(1), true, NOW)).toBe(300)
  })

  async function pollSeeded(postedHoursAgo: number, comments: unknown[]): Promise<WatchRow> {
    const db = createMockDb()
    await seedAccount(db, "instagram", "ig-1")
    await db.insert("watched_object", {
      platform: "instagram",
      external_id: "m1",
      object_type: "instagram_media",
      reason: "auto_own",
      status: "active",
      cadence_seconds: 300,
      priority: 50,
      next_poll_at: hoursAgo(0.1),
      metadata: { postedAt: hoursAgo(postedHoursAgo) },
    })
    const fetch = makeMockFetch({
      "/ig-1/media": { data: [] },
      "/me?": { id: "17841", username: "brand" },
      "/m1/comments": { data: comments },
    })
    await runWatchPoller(ctxWith(db, fetch), {
      adapters: { instagram: instagramAdapter },
      now: NOW,
    })
    return (await watches(db, "instagram"))[0] as WatchRow
  }

  test("a quiet watch slows as its post ages (poller writes the age band, not the activity cadence)", async () => {
    expect((await pollSeeded(12, [])).cadence_seconds).toBe(900)
    expect((await pollSeeded(48, [])).cadence_seconds).toBe(3600)
    const fiveDays = await pollSeeded(5 * 24, [])
    expect(fiveDays.cadence_seconds).toBe(6 * 3600)
    expect(fiveDays.status).toBe("active")
  })

  test("fresh activity on a five-day-old post polls it hourly", async () => {
    const w = await pollSeeded(5 * 24, [
      { id: "ic9", text: "Still available?", username: "fan", timestamp: hoursAgo(1) },
    ])
    expect(w.cadence_seconds).toBe(3600)
  })
})

describe("own-content auto-watch: retirement and caps", () => {
  test("a due watch on a post past the 14 day cutoff is retired without a Graph call", async () => {
    const db = createMockDb()
    await seedAccount(db, "facebook", "user-1")
    await db.insert("watched_object", {
      platform: "facebook",
      external_id: "page-1_old",
      object_type: "facebook_post",
      reason: "auto_own",
      status: "active",
      priority: 50,
      next_poll_at: hoursAgo(1),
      metadata: { postedAt: hoursAgo(15 * 24) },
    })
    const fetch = makeMockFetch({
      "/me/accounts": { data: [{ id: "page-1", access_token: "page-token" }] },
      "/page-1/posts": { data: [] },
    })
    const res = await runWatchPoller(ctxWith(db, fetch), {
      adapters: { facebook: facebookAdapter },
      now: NOW,
    })
    const [w] = await watches(db, "facebook")
    expect(w?.status).toBe("stopped")
    expect(w?.metadata.retiredReason).toBe("age")
    expect(res.polled).toBe(0)
    expect(commentCalls(fetch).length).toBe(0)
  })

  test("a manual watch on an old post is not retired by the age rule", async () => {
    const db = createMockDb()
    await seedAccount(db, "facebook", "user-1")
    await db.insert("watched_object", {
      platform: "facebook",
      external_id: "page-1_old",
      object_type: "facebook_post",
      reason: "manual",
      status: "active",
      priority: 50,
      next_poll_at: hoursAgo(1),
      metadata: { postedAt: hoursAgo(60 * 24) },
    })
    const fetch = makeMockFetch({
      "/me/accounts": { data: [{ id: "page-1", access_token: "page-token" }] },
      "/page-1/posts": { data: [] },
    })
    const res = await runWatchPoller(ctxWith(db, fetch), {
      adapters: { facebook: facebookAdapter },
      now: NOW,
    })
    expect(res.polled).toBe(1)
    // The manual watch keeps the activity cadence (decayed when idle), never the age retirement.
    const [w] = await watches(db, "facebook")
    expect(w?.status).not.toBe("stopped")
    expect(w?.metadata?.retiredReason).toBeUndefined()
  })

  test("enrollment keeps at most the cap of newest posts and retires the oldest active auto_own watches beyond it", async () => {
    const db = createMockDb()
    await seedAccount(db, "instagram", "ig-1")
    // An older enrolled watch that the newest posts push past the cap.
    await db.insert("watched_object", {
      platform: "instagram",
      external_id: "older",
      object_type: "instagram_media",
      reason: "auto_own",
      status: "active",
      priority: 50,
      next_poll_at: hoursAgo(-1),
      metadata: { postedAt: hoursAgo(100) },
    })
    const media = Array.from({ length: OWN_WATCH_CAP_PER_PLATFORM + 5 }, (_, i) => ({
      id: `m${i}`,
      timestamp: hoursAgo(1 + i),
    }))
    const fetch = makeMockFetch({ "/ig-1/media": { data: media }, "/comments": { data: [] } })
    await runWatchPoller(ctxWith(db, fetch), {
      adapters: { instagram: instagramAdapter },
      now: NOW,
    })
    const rows = await watches(db, "instagram")
    const active = rows.filter((r) => r.status === "active")
    expect(active.length).toBe(OWN_WATCH_CAP_PER_PLATFORM)
    expect(active.map((r) => r.external_id)).not.toContain("older")
    expect(rows.find((r) => r.external_id === "older")?.metadata.retiredReason).toBe("cap")
    // The listing asked for no more than the cap.
    expect(fetch.calls.find((c) => c.url.includes("/ig-1/media"))?.url).toContain(
      `limit=${OWN_WATCH_CAP_PER_PLATFORM}`,
    )
  })

  test("at most META_POLLS_PER_TICK comment polls per platform per tick; the rest stay due and are logged", async () => {
    const db = createMockDb()
    await seedAccount(db, "instagram", "ig-1")
    const media = Array.from({ length: 15 }, (_, i) => ({
      id: `m${i}`,
      timestamp: hoursAgo(1 + i * 0.1),
    }))
    const fetch = makeMockFetch({ "/ig-1/media": { data: media }, "/comments": { data: [] } })
    const logs: string[] = []
    const res = await runWatchPoller(ctxWith(db, fetch, logs), {
      adapters: { instagram: instagramAdapter },
      now: NOW,
    })
    expect(commentCalls(fetch).length).toBe(META_POLLS_PER_TICK)
    expect(res.polled).toBe(META_POLLS_PER_TICK)
    const unpolled = (await watches(db, "instagram")).filter((w) => !w.last_polled_at)
    expect(unpolled.length).toBe(15 - META_POLLS_PER_TICK)
    expect(logs.some((m) => /per-tick Graph cap/.test(m))).toBe(true)

    // Next tick: the deferred ones go first.
    const fetch2 = makeMockFetch({ "/ig-1/media": { data: media }, "/comments": { data: [] } })
    await runWatchPoller(ctxWith(db, fetch2), {
      adapters: { instagram: instagramAdapter },
      now: new Date(NOW.getTime() + 60_000),
    })
    expect((await watches(db, "instagram")).filter((w) => !w.last_polled_at).length).toBe(0)
  })
})

describe("own-content auto-watch: watched polls read Graph throttling", () => {
  const throttled = (code: number) => ({
    status: 400,
    headers: {},
    body: JSON.stringify({ error: { code, message: "limit" } }),
  })

  test("an Instagram comments poll answered 400 with a rate-limit code is RATE_LIMITED, not an empty read", async () => {
    const fetch: MockFetch = Object.assign(async () => throttled(80002), { calls: [] })
    const res = await instagramAdapter.pollObject(
      { accountExternalId: "ig-1", fetch, auth: testAuth("t") },
      "m1",
      null,
    )
    expect(res.error).toBe("RATE_LIMITED")
    expect(res.findings).toEqual([])
  })

  test("a Facebook comments poll answered 400 with code 613 is RATE_LIMITED", async () => {
    const fetch: MockFetch = Object.assign(
      async (url: string) =>
        url.includes("/comments")
          ? throttled(613)
          : {
              status: 200,
              headers: {},
              body: JSON.stringify({
                data: [{ id: "pg1", access_token: "page-token", name: "Brand" }],
              }),
            },
      { calls: [] },
    )
    const res = await facebookAdapter.pollObject(
      { accountExternalId: "pg1", fetch, auth: testAuth("t") },
      "pg1_post1",
      null,
    )
    expect(res.error).toBe("RATE_LIMITED")
    expect(res.findings).toEqual([])
  })
})
