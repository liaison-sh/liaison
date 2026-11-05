// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Newest-first sync over Graph list edges (graph-paging.ts), through the real
// Facebook and Instagram adapters against a paging Graph fake. On Graph,
// `after` walks to OLDER items: a sync that persisted it as its watermark read
// the next older page every tick and only came back to new conversations after
// walking off the end of the list (hours of DM lag). These tests pin that each
// tick starts at the newest page, stops at the stored high-water mark, and
// covers history with a bounded pass.

import { describe, expect, test } from "bun:test"
import { packCursor, parseJsonCursor } from "./cursor"
import { facebookAdapter } from "./facebook"
import { graphError, graphTime, usageThrottled } from "./graph-paging"
import { instagramAdapter } from "./instagram"
import type { AdapterFetch } from "./types"

interface Item {
  id: string
  t: string
}

interface Call {
  url: string
}

type Handler = (url: URL) => { status?: number; body: unknown; headers?: Record<string, string> } | null

/**
 * A Graph list edge: `limit` items per page, `after=O<offset>` cursors, and a
 * `paging.next` only when more items exist (like Graph). Any other `after`
 * value stands for a legacy token from the backward walk: an OLDER page.
 */
function listEdge(items: () => Item[], shape: (i: Item) => Record<string, unknown>) {
  return (url: URL) => {
    const limit = Number(url.searchParams.get("limit") ?? 25)
    const after = url.searchParams.get("after")
    const offset = after === null ? 0 : after.startsWith("O") ? Number(after.slice(1)) : 40
    const all = items()
    const page = all.slice(offset, offset + limit)
    const end = offset + page.length
    return {
      body: {
        data: page.map(shape),
        paging: {
          cursors: { after: `O${end}` },
          ...(end < all.length ? { next: `https://graph/next?after=O${end}` } : {}),
        },
      },
    }
  }
}

function graphFake(routes: Array<[RegExp, Handler]>): AdapterFetch & { calls: Call[] } {
  const calls: Call[] = []
  const fetch = (async (url: string) => {
    calls.push({ url })
    const u = new URL(url)
    for (const [re, h] of routes) {
      if (!re.test(u.pathname)) continue
      const res = h(u)
      if (res) return { status: res.status ?? 200, headers: res.headers ?? {}, body: JSON.stringify(res.body) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) }
  }) as AdapterFetch & { calls: Call[] }
  fetch.calls = calls
  return fetch
}

const T0 = Date.parse("2026-10-20T12:00:00Z")
/** `n` items, newest first, one minute apart, ids `<prefix><i>`. */
function items(n: number, prefix = "conv-", newestAt = T0): Item[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    t: new Date(newestAt - i * 60_000).toISOString().replace(".000Z", "+0000"),
  }))
}

const IG_ME: [RegExp, Handler] = [/\/me$/, () => ({ body: { id: "ig-pro-1", username: "our_brand" } })]
const igConv = (i: Item) => ({
  id: i.id,
  updated_time: i.t,
  participants: { data: [{ id: "ig1", username: "our_brand" }, { id: `fan-${i.id}`, username: `fan_${i.id}` }] },
})

function igDmFake(list: () => Item[], extra: Array<[RegExp, Handler]> = []) {
  return graphFake([IG_ME, ...extra, [/\/me\/conversations$/, listEdge(list, igConv)]])
}

const conversationCalls = (calls: Call[]) => calls.filter((c) => c.url.includes("/conversations"))

describe("instagram DM sync reads newest first", () => {
  test("a legacy backward cursor is dropped: the first read is the newest page, and a new thread is picked up next tick", async () => {
    let list = items(100)
    const fetch = igDmFake(() => list)
    const first = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, "LEGACY_AFTER")
    expect(first.error).toBeUndefined()
    expect(conversationCalls(fetch.calls)[0]!.url).not.toContain("after=")
    expect(first.conversations[0]!.externalId).toBe("conv-0")

    // A customer writes: the thread moves to the top of the list.
    list = [{ id: "conv-new", t: new Date(T0 + 5 * 60_000).toISOString() }, ...list]
    fetch.calls.length = 0
    const second = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, first.nextCursor)
    expect(second.conversations.map((c) => c.externalId)).toEqual(["conv-new"])
    // Stopped at the high-water mark: one list call, on the newest page.
    expect(conversationCalls(fetch.calls).length).toBe(1)
    expect(conversationCalls(fetch.calls)[0]!.url).not.toContain("after=")
  })

  test("a new connection backfills its whole history one page per tick, then stops paging", async () => {
    const list = items(130)
    const fetch = igDmFake(() => list)
    const seen = new Set<string>()
    let cursor: string | null = null
    for (let tick = 0; tick < 6; tick++) {
      const r = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, cursor)
      for (const c of r.conversations) seen.add(c.externalId)
      cursor = r.nextCursor
    }
    expect(seen.size).toBe(130)
    expect((parseJsonCursor(cursor) as { conversations: { bf: unknown } }).conversations.bf).toBeNull()
    fetch.calls.length = 0
    await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, cursor)
    expect(conversationCalls(fetch.calls).length).toBe(1)
  })

  test("more new threads than the head budget: the gap is closed by the history pass down to the old mark", async () => {
    let list = items(30)
    const fetch = igDmFake(() => list)
    const first = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, "LEGACY_AFTER")
    list = [...items(70, "burst-", T0 + 200 * 60_000), ...list]
    const seen = new Set<string>()
    let cursor = first.nextCursor
    for (let tick = 0; tick < 2; tick++) {
      const r = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, cursor)
      for (const c of r.conversations) seen.add(c.externalId)
      cursor = r.nextCursor
    }
    expect([...seen].filter((id) => id.startsWith("burst-")).length).toBe(70)
    expect((parseJsonCursor(cursor) as { conversations: { bf: unknown } }).conversations.bf).toBeNull()
  })

  test("a Graph rate-limit code on a 400 is RATE_LIMITED and keeps the cursor", async () => {
    const fetch = graphFake([
      IG_ME,
      [/\/me\/conversations$/, () => ({ status: 400, body: { error: { code: 4, message: "Application request limit reached" } } })],
    ])
    const r = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, "PRIOR")
    expect(r).toMatchObject({ conversations: [], messages: [], nextCursor: "PRIOR", error: "RATE_LIMITED" })
  })

  test("high Graph usage skips the optional pages: no history read while throttled", async () => {
    const list = items(130)
    const edge = listEdge(() => list, igConv)
    const fetch = graphFake([
      IG_ME,
      [/\/me\/conversations$/, (u) => ({ ...edge(u), headers: { "x-app-usage": '{"call_count":92,"total_time":10}' } })],
    ])
    const r = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, null)
    expect(conversationCalls(fetch.calls).length).toBe(1)
    expect(r.conversations.length).toBe(20)
    // The unread rest is owed to the history pass, not lost.
    expect((parseJsonCursor(r.nextCursor) as { conversations: { bf: { after: string } } }).conversations.bf.after).toBe("O20")
  })

  test("a rate limit on a thread's messages holds the state and the thread's last-message mark", async () => {
    const list = items(3)
    const fetch = igDmFake(() => list, [
      [/\/conv-0\/messages$/, () => ({ body: { data: [{ id: "m0", from: { id: "fan" }, message: "hi", created_time: list[0]!.t }] } })],
      [/\/conv-1\/messages$/, () => ({ status: 400, body: { error: { code: 613, message: "Calls to this api have exceeded the rate limit." } } })],
    ])
    const prior = packCursor({ conversations: { hw: "2026-10-19T00:00:00.000Z", bf: null } })
    const r = await instagramAdapter.syncDms!({ accountExternalId: "ig1", fetch, accessToken: "tok" }, prior)
    expect(r.error).toBeUndefined()
    expect(r.messages.map((m) => m.externalId)).toEqual(["m0"])
    // Re-read next tick from the same mark.
    expect(parseJsonCursor(r.nextCursor)).toEqual({ conversations: { hw: "2026-10-19T00:00:00.000Z", bf: null } })
    const byId = new Map(r.conversations.map((c) => [c.externalId, c]))
    expect(byId.get("conv-0")!.lastMessageAt).toBe(list[0]!.t)
    expect(byId.get("conv-1")!.lastMessageAt).toBeNull()
    // No further message fetch after the limit was hit.
    expect(fetch.calls.some((c) => c.url.includes("/conv-2/messages"))).toBe(false)
    expect(byId.get("conv-2")!.lastMessageAt).toBeNull()
  })

  test("a changed thread's messages are read down to its stored last-message time, not 100 deep", async () => {
    const list = items(1)
    const messages = items(100, "m-", T0)
    const fetch = igDmFake(() => list, [
      [
        /\/conv-0\/messages$/,
        listEdge(() => messages, (m) => ({ id: m.id, from: { id: "fan" }, message: "x", created_time: m.t })),
      ],
    ])
    const since = messages[10]!.t // stored mark: 10 messages are new
    const r = await instagramAdapter.syncDms!(
      { accountExternalId: "ig1", fetch, accessToken: "tok", skipMessagesBefore: new Map([["conv-0", new Date(graphTime(since)).toISOString()]]) },
      packCursor({ conversations: { hw: null, bf: null } }),
    )
    expect(fetch.calls.filter((c) => c.url.includes("/messages")).length).toBe(1)
    expect(r.messages.length).toBe(25)
  })
})

describe("facebook sync reads newest first", () => {
  const PAGES: [RegExp, Handler] = [/\/me\/accounts$/, () => ({ body: { data: [{ id: "page-1", access_token: "pt" }] } })]
  const fbConv = (i: Item) => ({ id: i.id, updated_time: i.t, participants: { data: [{ id: "page-1" }, { id: `psid-${i.id}` }] } })

  test("DM sync drops a legacy per-page `after` token and picks up a new thread on the next tick", async () => {
    let list = items(60)
    const fetch = graphFake([PAGES, [/\/page-1\/conversations$/, listEdge(() => list, fbConv)]])
    const legacy = packCursor({ pages: { "page-1": "LEGACY_AFTER" } })
    const first = await facebookAdapter.syncDms!({ accountExternalId: "u", fetch, accessToken: "ut" }, legacy)
    expect(conversationCalls(fetch.calls)[0]!.url).not.toContain("after=")
    list = [{ id: "conv-new", t: new Date(T0 + 60_000).toISOString() }, ...list]
    const second = await facebookAdapter.syncDms!({ accountExternalId: "u", fetch, accessToken: "ut" }, first.nextCursor)
    expect(second.conversations.map((c) => c.externalId)).toEqual(["conv-new"])
  })

  test("a Page whose list read fails for another reason is skipped with its state kept; the other Pages still sync", async () => {
    const list = items(3)
    const fetch = graphFake([
      [/\/me\/accounts$/, () => ({ body: { data: [{ id: "page-a", access_token: "ta" }, { id: "page-b", access_token: "tb" }] } })],
      [/\/page-a\/conversations$/, () => ({ status: 400, body: { error: { code: 200, message: "Permissions error" } } })],
      [/\/page-b\/conversations$/, listEdge(() => list, fbConv)],
    ])
    const keptA = { hw: "2026-10-01T00:00:00.000Z", bf: null }
    const r = await facebookAdapter.syncDms!(
      { accountExternalId: "u", fetch, accessToken: "ut" },
      packCursor({ pages: { "page-a": keptA } }),
    )
    expect(r.error).toBeUndefined()
    expect(r.conversations.map((c) => c.externalId)).toEqual(["conv-0", "conv-1", "conv-2"])
    const pages = (parseJsonCursor(r.nextCursor) as { pages: Record<string, unknown> }).pages
    expect(pages["page-a"]).toEqual(keptA)
    expect(pages["page-b"]).toMatchObject({ hw: expect.any(String) })
  })

  test("discover reads the newest feed page every tick plus one rotating older page, newest comments first", async () => {
    const posts = items(60, "page-1_post-")
    const fbPost = (i: Item) => ({ id: i.id, created_time: i.t, comments: { summary: { total_count: 1 } } })
    const fetch = graphFake([
      PAGES,
      [/\/page-1\/feed$/, listEdge(() => posts, fbPost)],
      [/\/comments$/, () => ({ body: { data: [] } })],
    ])
    let cursor: string | null = packCursor({ pages: { "page-1": "LEGACY_AFTER" } })
    const backfillOffsets: string[] = []
    for (let tick = 0; tick < 5; tick++) {
      fetch.calls.length = 0
      const r = await facebookAdapter.discover({ accountExternalId: "u", fetch, accessToken: "ut" }, cursor)
      expect(r.error).toBeUndefined()
      const feed = fetch.calls.filter((c) => c.url.includes("/feed"))
      expect(feed[0]!.url).not.toContain("after=")
      // The newest post's comments are read every tick, newest first.
      const newest = fetch.calls.find((c) => c.url.includes("/page-1_post-0/comments"))
      expect(newest?.url).toContain("order=reverse_chronological")
      for (const c of feed.slice(1)) backfillOffsets.push(new URL(c.url).searchParams.get("after") ?? "")
      cursor = r.nextCursor
    }
    // Tick 1 has no mark yet, so its head reads two pages (O25 is the second);
    // after that the head is page 1 only, and the history pass walks 10 posts
    // per tick and wraps back to just below the newest page.
    expect(backfillOffsets).toEqual(["O25", "O35", "O45", "O55", "O25", "O35"])
  })
})

describe("graph-paging helpers", () => {
  test("graphError maps Graph rate-limit codes whatever the HTTP status", () => {
    const body = (code: number) => JSON.stringify({ error: { code } })
    expect(graphError({ status: 400, body: body(17) })).toBe("RATE_LIMITED")
    expect(graphError({ status: 403, body: body(80006) })).toBe("RATE_LIMITED")
    expect(graphError({ status: 400, body: body(190) })).toBe("CONNECTION_LOST")
    expect(graphError({ status: 400, body: body(100) })).toBeNull()
    expect(graphError({ status: 200, body: "{}" })).toBeNull()
  })

  test("usageThrottled reads the business use case header", () => {
    const buc = JSON.stringify({ "123": [{ type: "pages", call_count: 85, total_cputime: 2, total_time: 3 }] })
    expect(usageThrottled({ "X-Business-Use-Case-Usage": buc })).toBe(true)
    expect(usageThrottled({ "x-app-usage": '{"call_count":10}' })).toBe(false)
    expect(usageThrottled(undefined)).toBe(false)
  })

  test("graphTime accepts Graph's +0000 offsets", () => {
    expect(graphTime("2026-10-20T12:00:00+0000")).toBe(T0)
    expect(Number.isNaN(graphTime(null))).toBe(true)
  })
})
