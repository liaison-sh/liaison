// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import searchFixture from "../__fixtures__/youtube-search.json"
import { packCursor, parseJsonCursor } from "./cursor"
import { makeMockFetch, type MockFetch } from "./mock-fetch"
import type { AdapterFetch } from "./types"
import { youtubeAdapter } from "./youtube"

const QUOTA_BODY = {
  error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded", domain: "youtube.quota" }] },
}

/** A fetch whose response is chosen per call by `respond(url)`; records calls. */
function scriptedFetch(respond: (url: string) => { status?: number; json: unknown }): MockFetch {
  const calls: MockFetch["calls"] = []
  const base: AdapterFetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" })
    const r = respond(url)
    return { status: r.status ?? 200, headers: {}, body: JSON.stringify(r.json) }
  }
  const fn = base as MockFetch
  fn.calls = calls
  return fn
}

describe("youtubeAdapter (B4)", () => {
  test("discover with NO monitor terms skips search.list entirely (own-channel sweep still runs)", async () => {
    // No /channels route → channels.list returns {} (no items), so the
    // own-channel sweep contributes 1 unit (channels.list) and stops (no
    // uploads playlist to walk) — but it still runs regardless of terms
    // (comments under our own videos are worth finding with zero keywords
    // configured, per build spec A).
    const fetch = makeMockFetch({ "/search": searchFixture })
    const { findings, unitsConsumed, nextCursor } = await youtubeAdapter.discover(
      { accountExternalId: "chan-1", fetch, accessToken: "tok", terms: [] },
      null,
    )
    expect(findings).toEqual([])
    expect(unitsConsumed).toBe(1) // channels.list only (no uploads playlist)
    expect(nextCursor).toBe(null)
    // No search.list call was made — the keyword sweep is skipped entirely.
    expect(fetch.calls.some((c) => c.url.includes("/search"))).toBe(false)
    expect(fetch.calls.some((c) => c.url.includes("/channels"))).toBe(true)
  })

  test("discover with 2 terms issues 2 search.list calls with &q=<term>, deduping a video matched by both", async () => {
    const fetch = makeMockFetch({ "/search": searchFixture })
    const { findings, nextCursor, unitsConsumed } = await youtubeAdapter.discover(
      {
        accountExternalId: "chan-1",
        fetch,
        accessToken: "tok",
        terms: [
          { id: "term-1", kind: "keyword", value: "OurBrand" },
          { id: "term-2", kind: "keyword", value: "widgets" },
        ],
      },
      null,
    )
    // One search.list call per term.
    const searchCalls = fetch.calls.filter((c) => c.url.includes("/search"))
    expect(searchCalls.length).toBe(2)
    expect(searchCalls[0]?.url).toContain("q=OurBrand")
    expect(searchCalls[1]?.url).toContain("q=widgets")
    // The fixture's two items share videoId 'vid-abc' AND both terms hit that
    // same video across the two calls → still a single deduped finding, with
    // both matching term ids recorded (§8 multi-term dedup, now cross-term too).
    const videoFindings = findings.filter((f) => f.relation === "keyword_match")
    expect(videoFindings.length).toBe(1)
    expect(videoFindings[0]).toMatchObject({
      platform: "youtube",
      relation: "keyword_match",
      externalId: "vid-abc",
    })
    expect(videoFindings[0]?.metadata?.matchedTerms).toEqual(["term-1", "term-2"])
    // search.list costs 100 units EACH (200 total) + a 1-unit videos.list
    // statistics batch for the deduped video + a 1-unit channels.list from the
    // (always-run) own-channel sweep (no /channels route → no uploads → stops there).
    expect(unitsConsumed).toBe(202)
    // First run of each term (no watermark): the next page is older history,
    // so no pageToken is kept; each term starts its own publishedAfter window.
    const next = parseJsonCursor(nextCursor) as { v: number; terms: Record<string, { after?: string; pageToken?: string }> }
    expect(next.v).toBe(2)
    expect(Object.keys(next.terms).sort()).toEqual(["term-1", "term-2"])
    expect(next.terms["term-1"]?.pageToken).toBeUndefined()
  })

  test("a handle-kind term's leading @ is stripped from the search query", async () => {
    const fetch = makeMockFetch({ "/search": { items: [], nextPageToken: null } })
    await youtubeAdapter.discover(
      {
        accountExternalId: "chan-1",
        fetch,
        accessToken: "tok",
        terms: [{ id: "term-1", kind: "handle", value: "@ourbrand" }],
      },
      null,
    )
    expect(fetch.calls[0]?.url).toContain("q=ourbrand")
    expect(fetch.calls[0]?.url).not.toContain("q=%40ourbrand")
  })

  test("pollObject (commentThreads) costs 1 unit", async () => {
    const fetch = makeMockFetch({
      "/commentThreads": {
        items: [
          {
            id: "ct-1",
            snippet: {
              topLevelComment: {
                id: "c-1",
                snippet: {
                  textDisplay: "Great video!",
                  authorDisplayName: "Fan",
                  publishedAt: "2026-05-31T11:00:00Z",
                },
              },
            },
          },
        ],
      },
    })
    const { findings, unitsConsumed } = await youtubeAdapter.pollObject(
      { accountExternalId: "chan-1", fetch, accessToken: "tok" },
      "vid-abc",
      null,
    )
    expect(findings.length).toBe(1)
    expect(unitsConsumed).toBe(1)
  })

  test("decodes HTML entities in comment text and author at ingest (don&#39;t -> don't, &amp; -> &)", async () => {
    const fetch = makeMockFetch({
      "/commentThreads": {
        items: [
          {
            id: "ct-ent",
            snippet: {
              topLevelComment: {
                id: "c-ent",
                snippet: {
                  // YouTube's Data API HTML-encodes textDisplay and author.
                  textDisplay: "I don&#39;t like Sound &amp; Vision",
                  authorDisplayName: "Beavis &amp; Butthead",
                  publishedAt: "2026-05-31T11:00:00Z",
                },
              },
            },
          },
        ],
      },
    })
    const { findings } = await youtubeAdapter.pollObject(
      { accountExternalId: "chan-1", fetch, accessToken: "tok" },
      "vid-abc",
      null,
    )
    expect(findings.length).toBe(1)
    expect(findings[0]?.contentText).toBe("I don't like Sound & Vision")
    expect(findings[0]?.authorHandle).toBe("Beavis & Butthead")
  })

  test("discover with NO terms still runs own-channel comment discovery (0 keyword units, own-channel units only)", async () => {
    const fetch = makeMockFetch({
      "/channels": { items: [{ id: "own-chan", contentDetails: { relatedPlaylists: { uploads: "UU-uploads" } } }] },
      "/playlistItems": {
        items: [{ contentDetails: { videoId: "vid-own-1" }, snippet: { title: "Our latest video" } }],
      },
      "/commentThreads": {
        items: [
          {
            id: "ct-1",
            snippet: {
              topLevelComment: {
                id: "c-own-1",
                snippet: {
                  textDisplay: "Love this!",
                  authorDisplayName: "Fan",
                  authorChannelId: { value: "fan-chan" },
                  publishedAt: "2026-05-31T11:00:00Z",
                },
              },
            },
          },
        ],
      },
    })
    const { findings, unitsConsumed } = await youtubeAdapter.discover(
      { accountExternalId: "chan-1", fetch, accessToken: "tok", terms: [] },
      null,
    )
    // channels.list (1) + playlistItems.list (1) + commentThreads.list per video (1) = 3
    expect(unitsConsumed).toBe(3)
    expect(findings.length).toBe(1)
    expect(findings[0]).toMatchObject({
      platform: "youtube",
      externalId: "c-own-1",
      relation: "comment_on_our_content",
      parentExternalId: "vid-own-1",
    })
    expect(findings[0]?.permalink).toBe("https://www.youtube.com/watch?v=vid-own-1&lc=c-own-1")
    expect(findings[0]?.metadata?.videoTitle).toBe("Our latest video")
  })

  test("own-channel discovery walks channels(mine) -> playlistItems(uploads) -> commentThreads per recent upload", async () => {
    const fetch = makeMockFetch({
      "/channels": { items: [{ id: "own-chan", contentDetails: { relatedPlaylists: { uploads: "UU-uploads" } } }] },
      "/playlistItems": {
        items: [
          { contentDetails: { videoId: "vid-own-1" }, snippet: { title: "Video One" } },
          { contentDetails: { videoId: "vid-own-2" }, snippet: { title: "Video Two" } },
        ],
      },
      "/commentThreads": { items: [] },
    })
    await youtubeAdapter.discover(
      { accountExternalId: "chan-1", fetch, accessToken: "tok", terms: [] },
      null,
    )
    const urls = fetch.calls.map((c) => c.url)
    expect(urls.some((u) => u.includes("/channels") && u.includes("mine=true"))).toBe(true)
    expect(urls.some((u) => u.includes("/playlistItems") && u.includes("playlistId=UU-uploads"))).toBe(true)
    // One commentThreads.list call per recent upload.
    expect(urls.filter((u) => u.includes("/commentThreads")).length).toBe(2)
    expect(urls.some((u) => u.includes("videoId=vid-own-1"))).toBe(true)
    expect(urls.some((u) => u.includes("videoId=vid-own-2"))).toBe(true)
  })

  test("own-channel discovery skips comments authored by the channel itself", async () => {
    const fetch = makeMockFetch({
      "/channels": { items: [{ id: "own-chan", contentDetails: { relatedPlaylists: { uploads: "UU-uploads" } } }] },
      "/playlistItems": {
        items: [{ contentDetails: { videoId: "vid-own-1" }, snippet: { title: "Our video" } }],
      },
      "/commentThreads": {
        items: [
          {
            id: "ct-own",
            snippet: {
              topLevelComment: {
                id: "c-self",
                snippet: {
                  textDisplay: "Thanks for watching!",
                  authorDisplayName: "Us",
                  authorChannelId: { value: "own-chan" },
                  publishedAt: "2026-05-31T11:00:00Z",
                },
              },
            },
          },
          {
            id: "ct-fan",
            snippet: {
              topLevelComment: {
                id: "c-fan",
                snippet: {
                  textDisplay: "Great content",
                  authorDisplayName: "Fan",
                  authorChannelId: { value: "fan-chan" },
                  publishedAt: "2026-05-31T11:05:00Z",
                },
              },
            },
          },
        ],
      },
    })
    const { findings } = await youtubeAdapter.discover(
      { accountExternalId: "chan-1", fetch, accessToken: "tok", terms: [] },
      null,
    )
    expect(findings.length).toBe(1)
    expect(findings[0]?.externalId).toBe("c-fan")
  })

  test("a 403 (comments disabled) on one video is swallowed per-video, other videos still processed", async () => {
    const fetch = makeMockFetch(
      {
        "/channels": { items: [{ id: "own-chan", contentDetails: { relatedPlaylists: { uploads: "UU-uploads" } } }] },
        "/playlistItems": {
          items: [
            { contentDetails: { videoId: "vid-disabled" }, snippet: { title: "Disabled comments" } },
            { contentDetails: { videoId: "vid-ok" }, snippet: { title: "OK video" } },
          ],
        },
      },
      {},
    )
    // Override fetch to return 403 only for vid-disabled's commentThreads call.
    const baseFetch = fetch
    const wrapped = (async (url: string, init?: Parameters<typeof baseFetch>[1]) => {
      if (url.includes("/commentThreads") && url.includes("videoId=vid-disabled")) {
        return { status: 403, headers: {}, body: JSON.stringify({ error: "commentsDisabled" }) }
      }
      if (url.includes("/commentThreads") && url.includes("videoId=vid-ok")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            items: [
              {
                id: "ct-1",
                snippet: {
                  topLevelComment: {
                    id: "c-ok",
                    snippet: { textDisplay: "Nice", authorDisplayName: "Fan", publishedAt: "2026-05-31T11:00:00Z" },
                  },
                },
              },
            ],
          }),
        }
      }
      return baseFetch(url, init)
    }) as typeof baseFetch
    wrapped.calls = baseFetch.calls

    const { findings, unitsConsumed } = await youtubeAdapter.discover(
      { accountExternalId: "chan-1", fetch: wrapped, accessToken: "tok", terms: [] },
      null,
    )
    // channels (1) + playlistItems (1) + only the SUCCESSFUL commentThreads call (1) = 3.
    // The 403 video contributes 0 units and 0 findings but doesn't abort the sweep.
    expect(unitsConsumed).toBe(3)
    expect(findings.length).toBe(1)
    expect(findings[0]?.externalId).toBe("c-ok")
  })

  test("keyword search populates commentCount via a batched videos.list(statistics) call, counted in units", async () => {
    const fetch = makeMockFetch({
      "/search": searchFixture,
      "/videos": { items: [{ id: "vid-abc", statistics: { commentCount: "42" } }] },
      "/channels": { items: [] }, // no uploads playlist → own-channel sweep is a no-op
    })
    const { findings, unitsConsumed } = await youtubeAdapter.discover(
      {
        accountExternalId: "chan-1",
        fetch,
        accessToken: "tok",
        terms: [{ id: "term-1", kind: "keyword", value: "OurBrand" }],
      },
      null,
    )
    const videoFinding = findings.find((f) => f.relation === "keyword_match")
    expect(videoFinding?.commentCount).toBe(42)
    // search.list (100) + videos.list statistics batch (1) + channels.list (1, own-channel no-op) = 102
    expect(unitsConsumed).toBe(102)
    expect(fetch.calls.some((c) => c.url.includes("/videos?part=statistics&id=vid-abc"))).toBe(true)
  })

  describe("verbatim relevance gate (incident fix — fuzzy search.list false positives)", () => {
    test("a fuzzy semantic hit with no verbatim term match is dropped entirely", async () => {
      // search.list's `q` match is fuzzy: a term like "tessera touch" can surface a
      // video about a band's "era" with zero textual relationship to the term.
      const fetch = makeMockFetch({
        "/search": {
          items: [
            {
              id: { kind: "youtube#video", videoId: "F7QCSn8QibE" },
              snippet: {
                title: "goodbye SIS era",
                description: "I miss manon and this era",
                channelTitle: "FanChannel",
                channelId: "chan-fan",
                publishedAt: "2026-05-31T10:00:00Z",
              },
            },
          ],
          nextPageToken: null,
        },
        "/channels": { items: [] },
      })
      const { findings, unitsConsumed } = await youtubeAdapter.discover(
        {
          accountExternalId: "chan-1",
          fetch,
          accessToken: "tok",
          terms: [{ id: "term-1", kind: "keyword", value: "tessera touch" }],
        },
        null,
      )
      // Dropped — no keyword_match finding survives the verbatim gate.
      expect(findings.filter((f) => f.relation === "keyword_match")).toEqual([])
      // Units are still spent — the search call happened regardless of the gate.
      expect(unitsConsumed).toBe(101) // search.list (100) + channels.list (1, own-channel no-op)
      // No videos.list statistics call either — nothing survived to batch.
      expect(fetch.calls.some((c) => c.url.includes("/videos?part=statistics"))).toBe(false)
    })

    test("a true verbatim hit is kept, with only the passing term recorded in matchedTerms", async () => {
      const fetch = makeMockFetch({
        "/search": {
          items: [
            {
              id: { kind: "youtube#video", videoId: "vid-real" },
              snippet: {
                title: "Fabrikam TESSERA Touch review",
                description: "Testing out the new synth",
                channelTitle: "TechReviewer",
                channelId: "chan-1",
                publishedAt: "2026-05-31T10:00:00Z",
              },
            },
          ],
          nextPageToken: null,
        },
        "/channels": { items: [] },
      })
      const { findings } = await youtubeAdapter.discover(
        {
          accountExternalId: "chan-1",
          fetch,
          accessToken: "tok",
          terms: [
            { id: "term-1", kind: "keyword", value: "tessera touch" },
            { id: "term-2", kind: "keyword", value: "some other keyword" },
          ],
        },
        null,
      )
      const videoFindings = findings.filter((f) => f.relation === "keyword_match")
      expect(videoFindings.length).toBe(1)
      expect(videoFindings[0]?.externalId).toBe("vid-real")
      // Case-insensitive substring match ("TESSERA Touch" vs term "tessera touch").
      expect(videoFindings[0]?.metadata?.matchedTerms).toEqual(["term-1"])
    })

    test("a multi-word term must match as a PHRASE, not as scattered words", async () => {
      const fetch = makeMockFetch({
        "/search": {
          items: [
            {
              id: { kind: "youtube#video", videoId: "vid-scattered" },
              snippet: {
                // Contains "tessera" and "touch" as separate words, never as the phrase.
                title: "The tessera of the human touch in music production",
                description: "A retrospective",
                channelTitle: "MusicChannel",
                channelId: "chan-x",
                publishedAt: "2026-05-31T10:00:00Z",
              },
            },
          ],
          nextPageToken: null,
        },
        "/channels": { items: [] },
      })
      const { findings } = await youtubeAdapter.discover(
        {
          accountExternalId: "chan-1",
          fetch,
          accessToken: "tok",
          terms: [{ id: "term-1", kind: "keyword", value: "tessera touch" }],
        },
        null,
      )
      expect(findings.filter((f) => f.relation === "keyword_match")).toEqual([])
    })

    test("a video passing for no term is dropped even when multiple terms are configured", async () => {
      const fetch = makeMockFetch({
        "/search": {
          items: [
            {
              id: { kind: "youtube#video", videoId: "vid-irrelevant" },
              snippet: {
                title: "Completely unrelated content",
                description: "Nothing to see here",
                channelTitle: "Random",
                channelId: "chan-r",
                publishedAt: "2026-05-31T10:00:00Z",
              },
            },
          ],
          nextPageToken: null,
        },
        "/channels": { items: [] },
      })
      const { findings } = await youtubeAdapter.discover(
        {
          accountExternalId: "chan-1",
          fetch,
          accessToken: "tok",
          terms: [
            { id: "term-1", kind: "keyword", value: "tessera touch" },
            { id: "term-2", kind: "keyword", value: "widgets" },
          ],
        },
        null,
      )
      expect(findings.filter((f) => f.relation === "keyword_match")).toEqual([])
    })
  })

  test("videos.list statistics batches ids up to 50 per call", async () => {
    const manyIds = Array.from({ length: 60 }, (_, i) => `vid-${i}`)
    const items = manyIds.map((id) => ({
      id: { kind: "youtube#video", videoId: id },
      // Title must carry the search term verbatim — every hit needs to survive
      // the relevance gate for this test to still exercise batching (not the gate).
      snippet: { title: `OurBrand Video ${id}`, channelTitle: "Ch", channelId: "c", publishedAt: "2026-05-31T10:00:00Z" },
    }))
    const fetch = makeMockFetch({
      "/search": { items, nextPageToken: null },
      "/videos": { items: [] },
      "/channels": { items: [] },
    })
    await youtubeAdapter.discover(
      {
        accountExternalId: "chan-1",
        fetch,
        accessToken: "tok",
        terms: [{ id: "term-1", kind: "keyword", value: "OurBrand" }],
      },
      null,
    )
    const videosCalls = fetch.calls.filter((c) => c.url.includes("/videos?part=statistics"))
    expect(videosCalls.length).toBe(2) // 60 ids -> batches of 50 + 10
  })

  describe("quota-aware keyword search", () => {
    const NOW = new Date("2026-10-20T12:00:00.000Z")
    const terms = [
      { id: "term-1", kind: "keyword" as const, value: "OurBrand" },
      { id: "term-2", kind: "keyword" as const, value: "widgets" },
    ]

    test("one date-sorted search per term, each with its OWN publishedAfter and pageToken", async () => {
      const cursor = packCursor({
        v: 2,
        terms: {
          "term-1": { after: "2026-10-19T00:00:00.000Z", pageToken: "TOK_A" },
          "term-2": { after: "2026-10-18T00:00:00.000Z" },
        },
      })
      const fetch = scriptedFetch((url) =>
        url.includes("/search") && url.includes("q=OurBrand")
          ? { json: { items: [], nextPageToken: "TOK_A2" } }
          : { json: { items: [] } },
      )
      const res = await youtubeAdapter.discover({ accountExternalId: "chan-1", fetch, accessToken: "tok", terms, now: NOW }, cursor)
      const searches = fetch.calls.filter((c) => c.url.includes("/search"))
      expect(searches.length).toBe(2)
      for (const c of searches) expect(c.url).toContain("order=date")
      const t1 = searches.find((c) => c.url.includes("q=OurBrand"))!.url
      const t2 = searches.find((c) => c.url.includes("q=widgets"))!.url
      expect(t1).toContain(`publishedAfter=${encodeURIComponent("2026-10-19T00:00:00.000Z")}`)
      expect(t1).toContain("pageToken=TOK_A")
      expect(t2).toContain(`publishedAfter=${encodeURIComponent("2026-10-18T00:00:00.000Z")}`)
      // term-1's token is never replayed on term-2.
      expect(t2).not.toContain("pageToken=")
      const next = parseJsonCursor(res.nextCursor) as { terms: Record<string, { after?: string; pageToken?: string }> }
      // term-1 still has a page of new videos in the same window: keep the window, next page.
      expect(next.terms["term-1"]).toEqual({ after: "2026-10-19T00:00:00.000Z", pageToken: "TOK_A2" })
      // term-2 drained its window: the next window starts at this run (minus the overlap).
      expect(next.terms["term-2"]).toEqual({ after: "2026-10-20T00:00:00.000Z" })
      expect(res.unitsConsumed).toBe(200 + 1) // 2 searches + channels.list
    })

    test("a legacy single-token cursor is not replayed on any term", async () => {
      const fetch = scriptedFetch(() => ({ json: { items: [] } }))
      await youtubeAdapter.discover({ accountExternalId: "chan-1", fetch, accessToken: "tok", terms, now: NOW }, "CDIQAA")
      const searches = fetch.calls.filter((c) => c.url.includes("/search"))
      expect(searches.length).toBe(2)
      for (const c of searches) {
        expect(c.url).not.toContain("pageToken=")
        expect(c.url).not.toContain("publishedAfter=")
      }
    })

    test("a 403 quotaExceeded on search stops discovery: no further calls, refused call not charged, term state kept", async () => {
      const cursor = packCursor({ v: 2, terms: { "term-1": { after: "2026-10-19T00:00:00.000Z" } } })
      const fetch = scriptedFetch((url) =>
        url.includes("/search") ? { status: 403, json: QUOTA_BODY } : { json: {} },
      )
      const res = await youtubeAdapter.discover({ accountExternalId: "chan-1", fetch, accessToken: "tok", terms, now: NOW }, cursor)
      expect(res.quotaExhausted).toBe(true)
      expect(res.error).toBeUndefined()
      expect(res.unitsConsumed).toBe(0)
      expect(fetch.calls.length).toBe(1) // no second term, no own-channel sweep
      const next = parseJsonCursor(res.nextCursor) as { terms: Record<string, { after?: string }> }
      expect(next.terms["term-1"]).toEqual({ after: "2026-10-19T00:00:00.000Z" })
    })

    test("dailyLimitExceeded on the own-channel sweep is reported as quota exhaustion", async () => {
      const fetch = scriptedFetch((url) =>
        url.includes("/channels")
          ? { status: 403, json: { error: { errors: [{ reason: "dailyLimitExceeded" }] } } }
          : { json: { items: [] } },
      )
      const res = await youtubeAdapter.discover({ accountExternalId: "chan-1", fetch, accessToken: "tok", terms: [], now: NOW }, null)
      expect(res.quotaExhausted).toBe(true)
      expect(res.unitsConsumed).toBe(0)
    })

    test("a plain 403 (comments disabled) is NOT quota exhaustion", async () => {
      const fetch = scriptedFetch(() => ({ status: 403, json: { error: { errors: [{ reason: "commentsDisabled" }] } } }))
      const res = await youtubeAdapter.pollObject({ accountExternalId: "chan-1", fetch, accessToken: "tok" }, "vid-abc", null)
      expect(res.quotaExhausted).toBeUndefined()
    })

    test("pollObject on quotaExceeded reports exhaustion and charges nothing", async () => {
      const fetch = scriptedFetch(() => ({ status: 403, json: QUOTA_BODY }))
      const res = await youtubeAdapter.pollObject({ accountExternalId: "chan-1", fetch, accessToken: "tok" }, "vid-abc", null)
      expect(res.quotaExhausted).toBe(true)
      expect(res.unitsConsumed).toBe(0)
      expect(res.findings).toEqual([])
    })
  })
})
