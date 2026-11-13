// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { packCursor, parseJsonCursor } from "./cursor"
import { instagramAdapter } from "./instagram"
import { makeMockFetch, testAuth } from "./mock-fetch"

// Every test account uses this shape: the connection-scoped id ("ig1") is
// DIFFERENT from the professional-account id `/me` returns ("pro-ig1") — the
// exact id-space split that caused the self-identity bug. Tests below
// deliberately exercise both id spaces (and the username) to prove the fix.
const ME_ROUTE = { "/me?fields=id,username": { id: "pro-ig1", username: "our_brand" } }

describe("instagramAdapter (B4)", () => {
  test("mentioned_media is never called — the edge does not exist under Instagram Login", async () => {
    const fetch = makeMockFetch({
      ...ME_ROUTE,
      "/ig1/media": { data: [], paging: { cursors: {} } },
    })
    const { findings, nextCursor } = await instagramAdapter.discover(
      { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
      null,
    )
    expect(findings).toEqual([])
    expect(parseJsonCursor(nextCursor)).toEqual({ ownMedia: { hw: null, bf: null } })
    expect(fetch.calls.some((c) => c.url.includes("mentioned_media"))).toBe(false)
    // Exactly the self-identity fetch + the own-media fetch happen — no other discover call.
    expect(fetch.calls.length).toBe(2)
    expect(fetch.calls.some((c) => c.url.includes("/ig1/media"))).toBe(true)
  })

  test("emits one info log per discover cycle noting mentions discovery is unavailable", async () => {
    const fetch = makeMockFetch({
      ...ME_ROUTE,
      "/ig1/media": { data: [], paging: { cursors: {} } },
    })
    const infoCalls: Array<[string, unknown]> = []
    await instagramAdapter.discover(
      {
        accountExternalId: "ig1",
        fetch,
        auth: testAuth("tok"),
        logger: { info: (msg, data) => infoCalls.push([msg, data]) },
      },
      null,
    )
    expect(infoCalls.length).toBe(1)
    expect(infoCalls[0]?.[0]).toContain("mentions discovery unavailable")
  })

  test("401 on the own-media fetch surfaces as CONNECTION_LOST (no findings)", async () => {
    const fetch = makeMockFetch({ ...ME_ROUTE, "/ig1/media": {} }, { status: 401 })
    const res = await instagramAdapter.discover(
      { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
      null,
    )
    expect(res.findings.length).toBe(0)
    expect((res as { error?: string }).error).toBe("CONNECTION_LOST")
  })

  test("401 on the self-identity (/me) fetch surfaces as CONNECTION_LOST before the own-media fetch", async () => {
    const fetch = makeMockFetch({ "/me?fields=id,username": {} }, { status: 401 })
    const res = await instagramAdapter.discover(
      { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
      null,
    )
    expect(res.findings.length).toBe(0)
    expect((res as { error?: string }).error).toBe("CONNECTION_LOST")
    expect(fetch.calls.some((c) => c.url.includes("/ig1/media"))).toBe(false)
  })

  test("429 on the self-identity (/me) fetch surfaces as RATE_LIMITED", async () => {
    const fetch = makeMockFetch({ "/me?fields=id,username": {} }, { status: 429 })
    const res = await instagramAdapter.discover(
      { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
      null,
    )
    expect(res.findings.length).toBe(0)
    expect((res as { error?: string }).error).toBe("RATE_LIMITED")
  })

  test("a non-401/429 self-identity fetch failure degrades to accountExternalId-only matching (never throws)", async () => {
    // /me 500s (not 401/429) — must degrade to accountExternalId-only
    // matching, not error out; the rest of discover proceeds normally and
    // still returns the fan's comment.
    const fetch = (async (url: string) => {
      if (url.includes("/me?fields=id,username")) {
        return { status: 500, headers: {}, body: "{}" }
      }
      if (url.includes("/ig1/media")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: [{ id: "own-media-1", caption: "hi", timestamp: "t", comments_count: 1 }],
            paging: { cursors: {} },
          }),
        }
      }
      if (url.includes("/own-media-1/comments")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: [{ id: "c1", text: "hey", username: "fan1", timestamp: "t" }],
          }),
        }
      }
      return { status: 200, headers: {}, body: "{}" }
    }) as Parameters<typeof instagramAdapter.discover>[0]["fetch"]

    const res = await instagramAdapter.discover(
      { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
      null,
    )
    expect(res.error).toBeUndefined()
    expect(res.findings.some((f) => f.externalId === "c1")).toBe(true)
  })

  test("tolerates an old cursor carrying a leftover `mentions` member (never read, never re-emitted)", async () => {
    const fetch = makeMockFetch({
      ...ME_ROUTE,
      "/ig1/media": {
        data: [{ id: "own-media-1", caption: "hi", timestamp: "t", comments_count: 0 }],
        paging: { cursors: { after: "OWN_MEDIA_CURSOR" } },
      },
    })
    const oldCursor = packCursor({ mentions: "STALE", ownMedia: "PRIOR" })
    const { nextCursor } = await instagramAdapter.discover(
      { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
      oldCursor,
    )
    expect(nextCursor).toBeDefined()
    const decoded = parseJsonCursor(nextCursor) as { mentions?: string; ownMedia?: unknown }
    // The legacy `ownMedia` token is replaced by a newest-first state.
    expect(decoded).toEqual({ ownMedia: { hw: null, bf: null } })
    expect(decoded.mentions).toBeUndefined()
  })

  describe("own-media comment discovery", () => {
    test("own media with comments_count > 0 yields comment_on_our_content findings", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/ig1/media": {
          data: [
            {
              id: "own-media-1",
              caption: "New drop!",
              timestamp: "2026-06-01T10:00:00+0000",
              comments_count: 2,
            },
            {
              id: "own-media-2",
              caption: "No comments here",
              timestamp: "2026-06-01T09:00:00+0000",
              comments_count: 0,
            },
          ],
          paging: { cursors: { after: "OWN_MEDIA_CURSOR" } },
        },
        "/own-media-1/comments": {
          data: [
            {
              id: "ig-comment-1",
              text: "Where do I buy this?",
              username: "fan1",
              timestamp: "2026-06-01T10:05:00+0000",
            },
            {
              id: "ig-comment-2",
              text: "Love it!",
              username: "fan2",
              timestamp: "2026-06-01T10:06:00+0000",
            },
          ],
        },
      })
      const { findings } = await instagramAdapter.discover(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      const ownComments = findings.filter((f) => f.relation === "comment_on_our_content")
      expect(ownComments.length).toBe(2)
      expect(ownComments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ externalId: "ig-comment-1", parentExternalId: "own-media-1" }),
          expect.objectContaining({ externalId: "ig-comment-2", parentExternalId: "own-media-1" }),
        ]),
      )
      // media with comments_count 0 is never queried for comments.
      expect(fetch.calls.some((c) => c.url.includes("own-media-2"))).toBe(false)
    })

    test("a comment authored by the connected account itself (by username) is skipped — not an actionable finding", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/ig1/media": {
          data: [{ id: "own-media-1", caption: "post", timestamp: "t", comments_count: 2 }],
          paging: { cursors: {} },
        },
        "/own-media-1/comments": {
          data: [
            { id: "self-reply-1", text: "thanks!", username: "our_brand", timestamp: "t" },
            { id: "fan-comment-1", text: "nice!", username: "fan1", timestamp: "t" },
          ],
        },
      })
      const { findings } = await instagramAdapter.discover(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      const ids = findings.map((f) => f.externalId)
      expect(ids).toEqual(["fan-comment-1"])
    })

    test("a comment id repeated across own-media batches contributes only one finding (dedup guard)", async () => {
      // Same comment id surfacing twice (e.g. a paginated re-fetch overlap)
      // must collapse to a single finding — exercises the seenExternalIds guard
      // now that mentions no longer pre-seed it.
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/ig1/media": {
          data: [
            {
              id: "own-media-1",
              caption: "post one",
              timestamp: "2026-06-01T09:00:00+0000",
              comments_count: 1,
            },
            {
              id: "own-media-2",
              caption: "post two",
              timestamp: "2026-06-01T09:30:00+0000",
              comments_count: 1,
            },
          ],
          paging: { cursors: {} },
        },
        "/own-media-1/comments": {
          data: [
            {
              id: "dup-comment-1",
              text: "first",
              username: "fan1",
              timestamp: "2026-06-01T09:05:00+0000",
            },
          ],
        },
        "/own-media-2/comments": {
          data: [
            {
              id: "dup-comment-1",
              text: "same id again",
              username: "fan1",
              timestamp: "2026-06-01T09:35:00+0000",
            },
          ],
        },
      })
      const { findings } = await instagramAdapter.discover(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      const ids = findings.map((f) => f.externalId)
      expect(ids.filter((id) => id === "dup-comment-1").length).toBe(1)
    })

    test("no own media with comments → no own-comment fetch calls, no findings", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/ig1/media": { data: [], paging: { cursors: {} } },
      })
      const { findings } = await instagramAdapter.discover(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(findings).toEqual([])
      expect(fetch.calls.some((c) => c.url.includes("/comments"))).toBe(false)
    })

    test("redaction signature (comments_count > 0 but empty data) warns once per cycle, zero findings", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/ig1/media": {
          data: [
            {
              id: "own-media-1",
              caption: "post one",
              timestamp: "2026-06-01T09:00:00+0000",
              comments_count: 3,
            },
            {
              id: "own-media-2",
              caption: "post two",
              timestamp: "2026-06-01T09:30:00+0000",
              comments_count: 5,
            },
          ],
          paging: { cursors: {} },
        },
        "/own-media-1/comments": { data: [] },
        "/own-media-2/comments": { data: [] },
      })
      const warnCalls: Array<[string, unknown]> = []
      const { findings } = await instagramAdapter.discover(
        {
          accountExternalId: "ig1",
          fetch,
          auth: testAuth("tok"),
          logger: { warn: (msg, data) => warnCalls.push([msg, data]) },
        },
        null,
      )
      expect(findings).toEqual([])
      // Warned exactly once despite TWO redacted media in this cycle.
      expect(warnCalls.length).toBe(1)
      expect(warnCalls[0]?.[0]).toContain("instagram_business_manage_comments")
      expect(warnCalls[0]?.[1]).toMatchObject({ mediaId: "own-media-1", commentsCount: 3 })
    })

    test("a genuine zero-comments media (comments_count: 0) is never fetched, so it never counts as redacted", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/ig1/media": {
          data: [{ id: "own-media-1", caption: "quiet post", timestamp: "t", comments_count: 0 }],
          paging: { cursors: {} },
        },
      })
      const warnCalls: Array<[string, unknown]> = []
      await instagramAdapter.discover(
        {
          accountExternalId: "ig1",
          fetch,
          auth: testAuth("tok"),
          logger: { warn: (msg, data) => warnCalls.push([msg, data]) },
        },
        null,
      )
      expect(warnCalls.length).toBe(0)
      expect(fetch.calls.some((c) => c.url.includes("/comments"))).toBe(false)
    })
  })

  describe("syncDms", () => {
    test("normalizes conversations + messages, direction by from.id !== our account id", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": {
          data: [
            {
              id: "conv-1",
              participants: {
                data: [
                  { id: "ig1", username: "our_brand" },
                  { id: "fan-1", username: "Jamie" },
                ],
              },
              updated_time: "2026-06-01T10:00:00+0000",
            },
          ],
          paging: { cursors: { after: "CONV_AFTER" } },
        },
        "/conv-1/messages": {
          data: [
            {
              id: "m1",
              from: { id: "fan-1", username: "Jamie" },
              message: "hi there",
              created_time: "2026-06-01T09:00:00+0000",
            },
            {
              id: "m2",
              from: { id: "ig1", username: "our_brand" },
              message: "hello!",
              created_time: "2026-06-01T09:05:00+0000",
            },
          ],
        },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )

      expect(result?.conversations).toEqual([
        expect.objectContaining({
          platform: "instagram",
          externalId: "conv-1",
          participantExternalId: "fan-1",
          participantHandle: "Jamie",
        }),
      ])
      expect(result?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            externalId: "m1",
            direction: "inbound",
            conversationExternalId: "conv-1",
          }),
          expect.objectContaining({
            externalId: "m2",
            direction: "outbound",
            conversationExternalId: "conv-1",
          }),
        ]),
      )
      expect(parseJsonCursor(result?.nextCursor ?? null)).toEqual({
        conversations: { hw: "2026-06-01T10:00:00.000Z", bf: null },
      })
    })

    // ── Self-identity id-space bug (the fix under test) ──────────────────
    test("a participant carrying the professional-account id (from /me, NOT accountExternalId) is correctly excluded as self — the real counterpart is picked", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE, // /me → { id: "pro-ig1", username: "our_brand" }
        "/me/conversations": {
          data: [
            {
              id: "conv-1",
              // "pro-ig1" is the API's self id — NOT "ig1" (accountExternalId).
              // Pre-fix, nonSelfParticipant compared only against "ig1", so
              // "pro-ig1" (us) was picked as the "other party" instead of fan-1.
              participants: {
                data: [
                  { id: "pro-ig1", username: "our_brand" },
                  { id: "fan-1", username: "real_fan" },
                ],
              },
              updated_time: "2026-06-01T10:00:00+0000",
            },
          ],
        },
        "/conv-1/messages": { data: [] },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result?.conversations).toEqual([
        expect.objectContaining({
          participantExternalId: "fan-1",
          participantHandle: "real_fan",
        }),
      ])
    })

    test("direction: from.id equal to the /me professional-account id (17-prefix style) classifies as outbound", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": {
          data: [{ id: "conv-1", participants: { data: [{ id: "pro-ig1" }, { id: "fan-1" }] } }],
        },
        "/conv-1/messages": {
          data: [
            { id: "m1", from: { id: "pro-ig1" }, message: "our reply", created_time: "t" },
            { id: "m2", from: { id: "fan-1" }, message: "their message", created_time: "t" },
          ],
        },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ externalId: "m1", direction: "outbound" }),
          expect.objectContaining({ externalId: "m2", direction: "inbound" }),
        ]),
      )
    })

    test("direction: from.username equal to our own connected username classifies as outbound even with an unrecognized from.id", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE, // username: "our_brand"
        "/me/conversations": {
          data: [{ id: "conv-1", participants: { data: [{ id: "pro-ig1" }, { id: "fan-1" }] } }],
        },
        "/conv-1/messages": {
          data: [
            // from.id is some other/unexpected id, but from.username matches ours.
            {
              id: "m1",
              from: { id: "some-other-id", username: "our_brand" },
              message: "our reply",
              created_time: "t",
            },
          ],
        },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result?.messages).toEqual([
        expect.objectContaining({ externalId: "m1", direction: "outbound" }),
      ])
    })

    test("a genuine third party (matches none of accountExternalId/meId/username) classifies as inbound", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": {
          data: [{ id: "conv-1", participants: { data: [{ id: "pro-ig1" }, { id: "fan-1" }] } }],
        },
        "/conv-1/messages": {
          data: [
            {
              id: "m1",
              from: { id: "fan-1", username: "real_fan" },
              message: "hi",
              created_time: "t",
            },
          ],
        },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result?.messages).toEqual([
        expect.objectContaining({ externalId: "m1", direction: "inbound" }),
      ])
    })

    test("/me failure degrades to accountExternalId-only matching — sync still completes, no throw", async () => {
      const fetch = (async (url: string) => {
        if (url.includes("/me?fields=id,username")) {
          return { status: 500, headers: {}, body: "{}" }
        }
        if (url.includes("/me/conversations")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [{ id: "conv-1", participants: { data: [{ id: "ig1" }, { id: "fan-1" }] } }],
            }),
          }
        }
        if (url.includes("/conv-1/messages")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [{ id: "m1", from: { id: "ig1" }, message: "our reply", created_time: "t" }],
            }),
          }
        }
        return { status: 200, headers: {}, body: "{}" }
      }) as Parameters<NonNullable<typeof instagramAdapter.syncDms>>[0]["fetch"]

      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      // Degraded (accountExternalId-only) matching still recognizes "ig1" as self.
      expect(result?.error).toBeUndefined()
      expect(result?.messages).toEqual([
        expect.objectContaining({ externalId: "m1", direction: "outbound" }),
      ])
    })

    test("empty inbox → empty result, a state with no mark and no history owed", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": { data: [], paging: { cursors: {} } },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result).toMatchObject({ conversations: [], messages: [] })
      expect(parseJsonCursor(result?.nextCursor ?? null)).toEqual({
        conversations: { hw: null, bf: null },
      })
      expect(fetch.calls.some((c) => c.url.includes("/messages"))).toBe(false)
    })

    test("401 on /me/conversations → CONNECTION_LOST, cursor unchanged", async () => {
      const fetch = makeMockFetch({ ...ME_ROUTE, "/me/conversations": {} }, { status: 401 })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({
        conversations: [],
        messages: [],
        nextCursor: "PRIOR_CURSOR",
        error: "CONNECTION_LOST",
      })
    })

    test("429 on /me/conversations → RATE_LIMITED, cursor unchanged", async () => {
      const fetch = makeMockFetch({ ...ME_ROUTE, "/me/conversations": {} }, { status: 429 })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({
        conversations: [],
        messages: [],
        nextCursor: "PRIOR_CURSOR",
        error: "RATE_LIMITED",
      })
    })

    test("401 on the self-identity (/me) fetch surfaces as CONNECTION_LOST, cursor unchanged", async () => {
      const fetch = makeMockFetch({ "/me?fields=id,username": {} }, { status: 401 })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({
        conversations: [],
        messages: [],
        nextCursor: "PRIOR_CURSOR",
        error: "CONNECTION_LOST",
      })
      expect(fetch.calls.some((c) => c.url.includes("/me/conversations"))).toBe(false)
    })

    test("429 on the self-identity (/me) fetch surfaces as RATE_LIMITED, cursor unchanged", async () => {
      const fetch = makeMockFetch({ "/me?fields=id,username": {} }, { status: 429 })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({
        conversations: [],
        messages: [],
        nextCursor: "PRIOR_CURSOR",
        error: "RATE_LIMITED",
      })
    })

    // ── A: participant-name fallback ────────────────────────────────────
    test("falls back to the most recent inbound message's from.username when the conversation-level username is missing", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": {
          data: [{ id: "conv-1", participants: { data: [{ id: "ig1" }, { id: "fan-1" }] } }],
        },
        "/conv-1/messages": {
          data: [
            {
              id: "m2",
              from: { id: "fan-1", username: "real_fan" },
              message: "second",
              created_time: "2026-06-01T09:05:00+0000",
            },
            {
              id: "m1",
              from: { id: "fan-1", username: "real_fan" },
              message: "first",
              created_time: "2026-06-01T09:00:00+0000",
            },
          ],
        },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result?.conversations).toEqual([
        expect.objectContaining({
          participantHandle: "real_fan",
          participantDisplayName: "real_fan",
        }),
      ])
    })

    test("never overwrites a real conversation-level username with a message username", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": {
          data: [
            {
              id: "conv-1",
              participants: { data: [{ id: "ig1" }, { id: "fan-1", username: "real_handle" }] },
            },
          ],
        },
        "/conv-1/messages": {
          data: [
            {
              id: "m1",
              from: { id: "fan-1", username: "other_handle" },
              message: "hi",
              created_time: "2026-06-01T09:00:00+0000",
            },
          ],
        },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result?.conversations).toEqual([
        expect.objectContaining({ participantHandle: "real_handle" }),
      ])
    })

    test("the participant-name fallback never picks a self-authored (by /me id or username) message's name", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE, // pro-ig1 / our_brand
        "/me/conversations": {
          data: [{ id: "conv-1", participants: { data: [{ id: "pro-ig1" }, { id: "fan-1" }] } }],
        },
        "/conv-1/messages": {
          // Newest-first: our own reply (self, via /me id) comes before the fan's message.
          data: [
            {
              id: "m2",
              from: { id: "pro-ig1", username: "our_brand" },
              message: "our reply",
              created_time: "2026-06-01T09:05:00+0000",
            },
            {
              id: "m1",
              from: { id: "fan-1", username: "real_fan" },
              message: "hi",
              created_time: "2026-06-01T09:00:00+0000",
            },
          ],
        },
      })
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(result?.conversations).toEqual([
        expect.objectContaining({
          participantHandle: "real_fan",
          participantDisplayName: "real_fan",
        }),
      ])
    })

    // ── C: message pagination ───────────────────────────────────────────
    test("paginates a conversation's messages on paging.cursors.after, up to the 4-page bound", async () => {
      let pageCalls = 0
      const fetch = (async (url: string) => {
        if (url.includes("/me?fields=id,username")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ id: "pro-ig1", username: "our_brand" }),
          }
        }
        if (url.includes("/me/conversations")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [{ id: "conv-1", participants: { data: [{ id: "ig1" }, { id: "fan-1" }] } }],
            }),
          }
        }
        if (url.includes("/conv-1/messages")) {
          pageCalls += 1
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [
                {
                  id: `m${pageCalls}`,
                  from: { id: "fan-1" },
                  message: "x",
                  created_time: "2026-06-01T09:00:00+0000",
                },
              ],
              paging: { cursors: { after: `CURSOR_${pageCalls}` } }, // always offers another page
            }),
          }
        }
        return { status: 200, headers: {}, body: "{}" }
      }) as Parameters<NonNullable<typeof instagramAdapter.syncDms>>[0]["fetch"]

      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok") },
        null,
      )
      expect(pageCalls).toBe(4) // bounded at 4 pages
      expect(result?.messages.length).toBe(4)
    })

    // ── D: changed-only skip ────────────────────────────────────────────
    test("skips the /messages fetch for a conversation whose updated_time is not newer than the stored watermark", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": {
          data: [
            {
              id: "conv-unchanged",
              participants: { data: [{ id: "ig1" }, { id: "fan-1" }] },
              updated_time: "2026-06-01T09:00:00+0000",
            },
          ],
        },
      })
      const skipMessagesBefore = new Map([["conv-unchanged", "2026-06-01T09:00:00+0000"]])
      const result = await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok"), skipMessagesBefore },
        null,
      )
      expect(fetch.calls.some((c) => c.url.includes("/messages"))).toBe(false)
      expect(result?.messages).toEqual([])
      expect(result?.conversations).toEqual([
        expect.objectContaining({ externalId: "conv-unchanged" }),
      ])
    })

    test("still fetches /messages when updated_time is strictly newer than the stored watermark", async () => {
      const fetch = makeMockFetch({
        ...ME_ROUTE,
        "/me/conversations": {
          data: [
            {
              id: "conv-changed",
              participants: { data: [{ id: "ig1" }, { id: "fan-1" }] },
              updated_time: "2026-06-01T10:00:00+0000",
            },
          ],
        },
        "/conv-changed/messages": { data: [] },
      })
      const skipMessagesBefore = new Map([["conv-changed", "2026-06-01T09:00:00+0000"]])
      await instagramAdapter.syncDms?.(
        { accountExternalId: "ig1", fetch, auth: testAuth("tok"), skipMessagesBefore },
        null,
      )
      expect(fetch.calls.some((c) => c.url.includes("/messages"))).toBe(true)
    })
  })
})
