// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHmac, timingSafeEqual } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { type SocialWebhookBridge, verifyMetaSignature } from "../lib/hmac"
import { parseJsonCursor } from "./cursor"
import { facebookAdapter, postExcerpt } from "./facebook"
import { makeMockFetch } from "./mock-fetch"

/** Node-backed mock of the kernel webhook crypto bridge (host-side). */
function mockBridge(): SocialWebhookBridge {
  return {
    crypto_hmacSha256Hex: async (s: string, body: string) =>
      createHmac("sha256", s).update(body, "utf8").digest("hex"),
    crypto_timingSafeEqual: async (a: string, b: string) => {
      const la = Buffer.from(a)
      const lb = Buffer.from(b)
      if (la.length !== lb.length) return false
      return timingSafeEqual(la, lb)
    },
  }
}

/** One managed page's `/me/accounts` fixture entry. */
function page(id: string, accessToken: string, name = id) {
  return { id, name, access_token: accessToken }
}

describe("facebookAdapter (B4)", () => {
  describe("discover", () => {
    test("resolves managed pages via /me/accounts, fetches the feed (with comment counts), then fetches COMMENTS on posts that have them — never ingesting the post itself", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/feed": {
          data: [
            {
              id: "post-1",
              message: "Check out our new arrivals!",
              permalink_url: "https://facebook.com/x/post-1",
              created_time: "2026-05-31T07:00:00+0000",
              comments: { summary: { total_count: 2 } },
            },
          ],
          paging: { cursors: { after: "AFTER_FB" } },
        },
        "/post-1/comments": {
          data: [
            {
              id: "page-1_comment-1",
              message: "Is this in stock?",
              from: { id: "fb-user-9", name: "Shopper" },
              created_time: "2026-05-31T08:00:00+0000",
              permalink_url: "https://facebook.com/x/1",
            },
            {
              id: "page-1_comment-2",
              message: "Thanks for asking, yes!",
              from: { id: "page-1", name: "Our Page" },
              created_time: "2026-05-31T08:05:00+0000",
            },
          ],
        },
      })
      const { findings, nextCursor } = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      // Only the shopper's comment is a finding — the page's own reply comment
      // is skipped, and the post itself is never ingested as a finding.
      expect(findings.length).toBe(1)
      expect(findings[0]).toMatchObject({
        platform: "facebook",
        relation: "comment_on_our_content",
        externalId: "page-1_comment-1",
        parentExternalId: "post-1",
        authorHandle: "Shopper",
        authorExternalId: "fb-user-9",
        contentText: "Is this in stock?",
        metadata: {
          siblingsAccessible: true,
          pageId: "page-1",
          postPermalink: "https://facebook.com/x/post-1",
          postExcerpt: "Check out our new arrivals!",
        },
      })

      const accountsCall = fetch.calls.find((c) => c.url.includes("/me/accounts"))!
      expect(accountsCall.headers).toEqual({ Authorization: "Bearer user-token" })

      const feedCall = fetch.calls.find((c) => c.url.includes("/feed"))!
      expect(feedCall.url).toContain("/page-1/feed")
      expect(feedCall.url).toContain("comments.summary(true).limit(0)")
      // The feed call must carry the PAGE token, NOT the user token.
      expect(feedCall.headers).toEqual({ Authorization: "Bearer page-1-token" })

      const commentsCall = fetch.calls.find((c) => c.url.includes("/post-1/comments"))!
      expect(commentsCall.headers).toEqual({ Authorization: "Bearer page-1-token" })

      expect(nextCursor).not.toBeNull()
      // Newest-first state per page (no `paging.next` here: the feed ended).
      const decoded = parseJsonCursor(nextCursor) as { pages?: Record<string, unknown> }
      expect(decoded.pages).toEqual({ "page-1": { hw: expect.any(String), bf: null } })
    })

    test("a comment Graph returns without permalink_url (and on a post without one) gets a link built from its ids", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("111", "page-token")] },
        "/111/feed": {
          data: [
            {
              id: "111_222",
              message: "New post",
              created_time: "2026-05-31T07:00:00+0000",
              comments: { summary: { total_count: 1 } },
            },
          ],
        },
        "/111_222/comments": {
          data: [{ id: "222_333", message: "Hello?", from: { id: "9", name: "Jo" }, created_time: "2026-05-31T08:00:00+0000" }],
        },
      })
      const { findings } = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(findings).toHaveLength(1)
      expect(findings[0]?.permalink).toBe("https://www.facebook.com/111/posts/222?comment_id=333")
    })

    test("a post with zero comments is skipped — no per-post comments call, no finding", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/feed": {
          data: [
            {
              id: "post-empty",
              message: "Just a caption",
              comments: { summary: { total_count: 0 } },
            },
          ],
        },
      })
      const { findings } = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(findings).toEqual([])
      expect(fetch.calls.some((c) => c.url.includes("/comments"))).toBe(false)
    })

    test("a post's /comments non-200 logs a warn with status/code/message and is skipped (post-1 self-heals next cycle)", async () => {
      const calls: Array<{ url: string; method: string; body?: unknown }> = []
      const fetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body })
        if (url.includes("/me/accounts")) {
          return { status: 200, headers: {}, body: JSON.stringify({ data: [page("page-1", "page-1-token")] }) }
        }
        if (url.includes("/page-1/feed")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [
                {
                  id: "post-1",
                  message: "reel caption",
                  comments: { summary: { total_count: 4 } },
                },
              ],
            }),
          }
        }
        if (url.includes("/post-1/comments")) {
          return {
            status: 400,
            headers: {},
            body: JSON.stringify({
              error: { message: "An unknown error occurred", type: "OAuthException", code: 100 },
            }),
          }
        }
        return { status: 200, headers: {}, body: "{}" }
      }) as Parameters<typeof facebookAdapter.discover>[0]["fetch"]

      const warnCalls: Array<[string, unknown]> = []
      const { findings } = await facebookAdapter.discover(
        {
          accountExternalId: "user-1",
          fetch,
          accessToken: "user-token",
          logger: { warn: (msg, data) => warnCalls.push([msg, data]) },
        },
        null,
      )
      // Swallowed: no finding, no thrown error, discovery completes normally.
      expect(findings).toEqual([])
      expect(warnCalls.length).toBe(1)
      expect(warnCalls[0]?.[0]).toContain("facebook comments fetch failed")
      expect(warnCalls[0]?.[1]).toMatchObject({
        postId: "post-1",
        status: 400,
        code: 100,
        message: "An unknown error occurred",
      })
    })

    test("fans out over 2+ managed pages, each producing findings, with a compound per-page cursor", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": {
          data: [page("page-a", "token-a"), page("page-b", "token-b")],
        },
        "/page-a/feed": {
          data: [{ id: "post-a1", message: "post A", comments: { summary: { total_count: 1 } } }],
          paging: { cursors: { after: "AFTER_A" } },
        },
        "/page-b/feed": {
          data: [{ id: "post-b1", message: "post B", comments: { summary: { total_count: 1 } } }],
          paging: { cursors: { after: "AFTER_B" } },
        },
        "/post-a1/comments": {
          data: [{ id: "page-a_c1", message: "hello A", from: { id: "u1" }, created_time: "t1" }],
        },
        "/post-b1/comments": {
          data: [{ id: "page-b_c1", message: "hello B", from: { id: "u2" }, created_time: "t2" }],
        },
      })
      const { findings, nextCursor } = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(findings.map((f) => f.externalId).sort()).toEqual(["page-a_c1", "page-b_c1"])
      expect(findings.every((f) => f.metadata?.pageId)).toBe(true)

      const decoded = parseJsonCursor(nextCursor) as { pages?: Record<string, unknown> }
      expect(Object.keys(decoded.pages ?? {}).sort()).toEqual(["page-a", "page-b"])

      // /me/accounts resolved exactly once, not once per page.
      expect(fetch.calls.filter((c) => c.url.includes("/me/accounts")).length).toBe(1)
    })

    test("no managed pages → empty result, nextCursor null", async () => {
      const fetch = makeMockFetch({ "/me/accounts": { data: [] } })
      const result = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(result).toEqual({ findings: [], nextCursor: null, unitsConsumed: 0 })
    })

    test("/me/accounts 401 → CONNECTION_LOST, cursor unchanged", async () => {
      const fetch = makeMockFetch({ "/me/accounts": {} }, { status: 401 })
      const result = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({ findings: [], nextCursor: "PRIOR_CURSOR", error: "CONNECTION_LOST" })
    })

    test("/me/accounts 429 → RATE_LIMITED, cursor unchanged", async () => {
      const fetch = makeMockFetch({ "/me/accounts": {} }, { status: 429 })
      const result = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({ findings: [], nextCursor: "PRIOR_CURSOR", error: "RATE_LIMITED" })
    })

    test("a single page's /feed erroring fails the whole call, cursor unchanged (no partial advance)", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-a", "token-a")] },
        "/page-a/feed": {},
      })
      // Force the /feed call to 401 by overriding status only for that route via
      // a second mock composed manually.
      const calls: Array<{ url: string; method: string; body?: unknown }> = []
      const failingFetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body })
        if (url.includes("/me/accounts")) {
          return { status: 200, headers: {}, body: JSON.stringify({ data: [page("page-a", "token-a")] }) }
        }
        return { status: 401, headers: {}, body: "{}" }
      }) as typeof fetch
      const result = await facebookAdapter.discover(
        { accountExternalId: "user-1", fetch: failingFetch, accessToken: "user-token" },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({ findings: [], nextCursor: "PRIOR_CURSOR", error: "CONNECTION_LOST" })
    })
  })

  test("verifyMetaSignature validates the X-Hub-Signature-256 HMAC (host-bridge, QuickJS-safe)", async () => {
    const secret = "app-secret"
    const raw = JSON.stringify({ object: "page", entry: [] })
    const sig = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`
    const bridge = mockBridge()
    expect(await verifyMetaSignature(raw, sig, secret, bridge)).toBe(true)
    // Bare hex (no sha256= prefix) is also accepted.
    expect(await verifyMetaSignature(raw, sig.slice("sha256=".length), secret, bridge)).toBe(true)
    expect(await verifyMetaSignature(raw, "sha256=deadbeef", secret, bridge)).toBe(false)
    expect(await verifyMetaSignature(raw, "", secret, bridge)).toBe(false)
  })

  test("facebookAdapter does NOT carry a node:crypto verifyWebhook (bundle stays QuickJS-safe)", () => {
    expect(facebookAdapter.verifyWebhook).toBeUndefined()
  })

  describe("syncDms", () => {
    test("normalizes conversations + messages per page, direction computed against the ACTUAL page id (not the user id), authorized with the PAGE token", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": {
          data: [
            {
              id: "conv-1",
              participants: { data: [{ id: "page-1", name: "Our Page" }, { id: "cust-1", name: "Jamie" }] },
              updated_time: "2026-06-01T10:00:00+0000",
            },
          ],
          paging: { cursors: { after: "CONV_AFTER" } },
        },
        "/conv-1/messages": {
          data: [
            { id: "m1", from: { id: "cust-1", name: "Jamie" }, message: "hi there", created_time: "2026-06-01T09:00:00+0000" },
            { id: "m2", from: { id: "page-1", name: "Our Page" }, message: "hello!", created_time: "2026-06-01T09:05:00+0000" },
          ],
        },
      })
      const result = await facebookAdapter.syncDms?.(
        // accountExternalId here is the connected USER id — deliberately
        // different from "page-1" to prove direction is computed against the
        // real page id, not this.
        { accountExternalId: "user-42", fetch, accessToken: "user-token" },
        null,
      )
      const { conversations, messages, nextCursor } = result ?? {
        conversations: [],
        messages: [],
        nextCursor: null,
      }

      expect(conversations).toEqual([
        expect.objectContaining({
          platform: "facebook",
          externalId: "conv-1",
          participantExternalId: "cust-1",
          participantHandle: "Jamie",
          metadata: { pageId: "page-1" },
        }),
      ])
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ externalId: "m1", direction: "inbound", conversationExternalId: "conv-1" }),
          expect.objectContaining({ externalId: "m2", direction: "outbound", conversationExternalId: "conv-1" }),
        ]),
      )
      const decoded = parseJsonCursor(nextCursor) as { pages?: Record<string, unknown> }
      expect(decoded.pages).toEqual({ "page-1": { hw: "2026-06-01T10:00:00.000Z", bf: null } })

      const conversationsCall = fetch.calls.find((c) => c.url.includes("/page-1/conversations"))!
      expect(conversationsCall.headers).toEqual({ Authorization: "Bearer page-1-token" })
      const messagesCall = fetch.calls.find((c) => c.url.includes("/conv-1/messages"))!
      expect(messagesCall.headers).toEqual({ Authorization: "Bearer page-1-token" })
    })

    test("fans out over 2+ pages' conversations independently", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-a", "token-a"), page("page-b", "token-b")] },
        "/page-a/conversations": {
          data: [{ id: "conv-a1", participants: { data: [{ id: "page-a" }, { id: "cust-a" }] } }],
          paging: { cursors: { after: "A_AFTER" } },
        },
        "/page-b/conversations": {
          data: [{ id: "conv-b1", participants: { data: [{ id: "page-b" }, { id: "cust-b" }] } }],
          paging: { cursors: { after: "B_AFTER" } },
        },
        "/conv-a1/messages": { data: [] },
        "/conv-b1/messages": { data: [] },
      })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(result?.conversations.map((c) => c.externalId).sort()).toEqual(["conv-a1", "conv-b1"])
      const decoded = parseJsonCursor(result?.nextCursor ?? null) as { pages?: Record<string, unknown> }
      expect(Object.keys(decoded.pages ?? {}).sort()).toEqual(["page-a", "page-b"])
    })

    test("empty inbox → empty result, a state with no mark and no history owed", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": { data: [], paging: { cursors: {} } },
      })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(result).toMatchObject({ conversations: [], messages: [] })
      expect(parseJsonCursor(result?.nextCursor ?? null)).toEqual({ pages: { "page-1": { hw: null, bf: null } } })
      expect(fetch.calls.some((c) => c.url.includes("/messages"))).toBe(false)
    })

    test("no managed pages → empty result, nextCursor null, no /conversations call", async () => {
      const fetch = makeMockFetch({ "/me/accounts": { data: [] } })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(result).toEqual({ conversations: [], messages: [], nextCursor: null })
    })

    test("/me/accounts 401 → CONNECTION_LOST, cursor unchanged", async () => {
      const fetch = makeMockFetch({ "/me/accounts": {} }, { status: 401 })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({
        conversations: [],
        messages: [],
        nextCursor: "PRIOR_CURSOR",
        error: "CONNECTION_LOST",
      })
    })

    test("/me/accounts 429 → RATE_LIMITED, cursor unchanged", async () => {
      const fetch = makeMockFetch({ "/me/accounts": {} }, { status: 429 })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({
        conversations: [],
        messages: [],
        nextCursor: "PRIOR_CURSOR",
        error: "RATE_LIMITED",
      })
    })

    test("a page's /conversations erroring fails the whole call, cursor unchanged", async () => {
      const calls: Array<{ url: string; method: string; body?: unknown }> = []
      const failingFetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body })
        if (url.includes("/me/accounts")) {
          return { status: 200, headers: {}, body: JSON.stringify({ data: [page("page-a", "token-a")] }) }
        }
        return { status: 429, headers: {}, body: "{}" }
      }) as Parameters<NonNullable<typeof facebookAdapter.syncDms>>[0]["fetch"]
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch: failingFetch, accessToken: "user-token" },
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
    test("falls back to the most recent inbound message's from.name when the conversation-level name is the 'Facebook user' placeholder", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": {
          data: [
            {
              id: "conv-1",
              participants: { data: [{ id: "page-1", name: "Our Page" }, { id: "cust-1", name: "Facebook user" }] },
              updated_time: "2026-06-01T10:00:00+0000",
            },
          ],
        },
        "/conv-1/messages": {
          data: [
            { id: "m2", from: { id: "cust-1", name: "Manage Al" }, message: "second", created_time: "2026-06-01T09:05:00+0000" },
            { id: "m1", from: { id: "cust-1", name: "Manage Al" }, message: "first", created_time: "2026-06-01T09:00:00+0000" },
          ],
        },
      })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(result?.conversations).toEqual([
        expect.objectContaining({ participantHandle: "Manage Al", participantDisplayName: "Manage Al" }),
      ])
    })

    test("never overwrites a real conversation-level participant name with a message name", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": {
          data: [
            {
              id: "conv-1",
              participants: { data: [{ id: "page-1" }, { id: "cust-1", name: "Real Name" }] },
            },
          ],
        },
        "/conv-1/messages": {
          data: [{ id: "m1", from: { id: "cust-1", name: "Some Other Name" }, message: "hi", created_time: "2026-06-01T09:00:00+0000" }],
        },
      })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(result?.conversations).toEqual([
        expect.objectContaining({ participantHandle: "Real Name" }),
      ])
    })

    test("stays null (platform-generic UI fallback) when no message carries a usable from.name either", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": {
          data: [
            {
              id: "conv-1",
              participants: { data: [{ id: "page-1" }, { id: "cust-1", name: "Facebook user" }] },
            },
          ],
        },
        "/conv-1/messages": {
          data: [{ id: "m1", from: { id: "cust-1", name: "Facebook user" }, message: "hi", created_time: "2026-06-01T09:00:00+0000" }],
        },
      })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(result?.conversations).toEqual([
        expect.objectContaining({ participantHandle: null, participantDisplayName: null }),
      ])
    })

    // ── C: message pagination ───────────────────────────────────────────
    test("paginates a conversation's messages on paging.cursors.after, up to the 4-page bound", async () => {
      let pageCalls = 0
      const fetch = (async (url: string) => {
        if (url.includes("/me/accounts")) {
          return { status: 200, headers: {}, body: JSON.stringify({ data: [page("page-1", "page-1-token")] }) }
        }
        if (url.includes("/page-1/conversations")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ data: [{ id: "conv-1", participants: { data: [{ id: "page-1" }, { id: "cust-1" }] } }] }),
          }
        }
        if (url.includes("/conv-1/messages")) {
          pageCalls += 1
          if (pageCalls === 1) {
            expect(url).not.toContain("&after=")
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({
                data: [{ id: "m1", from: { id: "cust-1" }, message: "one", created_time: "2026-06-01T09:00:00+0000" }],
                paging: { cursors: { after: "CURSOR_1" } },
              }),
            }
          }
          if (pageCalls === 2) {
            expect(url).toContain("after=CURSOR_1")
            return {
              status: 200,
              headers: {},
              body: JSON.stringify({
                data: [{ id: "m2", from: { id: "cust-1" }, message: "two", created_time: "2026-06-01T09:01:00+0000" }],
                // No further cursor — pagination stops here (2 pages).
              }),
            }
          }
          throw new Error(`unexpected extra /messages page call #${pageCalls}`)
        }
        return { status: 200, headers: {}, body: "{}" }
      }) as Parameters<NonNullable<typeof facebookAdapter.syncDms>>[0]["fetch"]

      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(pageCalls).toBe(2) // stopped once a page returned no next cursor
      expect(result?.messages.map((m) => m.externalId).sort()).toEqual(["m1", "m2"])
    })

    test("stops at the 4-page bound (100 messages) even when the API keeps offering a next cursor", async () => {
      let pageCalls = 0
      const fetch = (async (url: string) => {
        if (url.includes("/me/accounts")) {
          return { status: 200, headers: {}, body: JSON.stringify({ data: [page("page-1", "page-1-token")] }) }
        }
        if (url.includes("/page-1/conversations")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ data: [{ id: "conv-1", participants: { data: [{ id: "page-1" }, { id: "cust-1" }] } }] }),
          }
        }
        if (url.includes("/conv-1/messages")) {
          pageCalls += 1
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: [{ id: `m${pageCalls}`, from: { id: "cust-1" }, message: `msg ${pageCalls}`, created_time: "2026-06-01T09:00:00+0000" }],
              paging: { cursors: { after: `CURSOR_${pageCalls}` } }, // ALWAYS offers a next page
            }),
          }
        }
        return { status: 200, headers: {}, body: "{}" }
      }) as Parameters<NonNullable<typeof facebookAdapter.syncDms>>[0]["fetch"]

      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(pageCalls).toBe(4) // bounded, never fetches a 5th page
      expect(result?.messages.length).toBe(4)
    })

    // ── D: changed-only skip ────────────────────────────────────────────
    test("skips the /messages fetch for a conversation whose updated_time is not newer than the stored watermark", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": {
          data: [
            {
              id: "conv-unchanged",
              participants: { data: [{ id: "page-1" }, { id: "cust-1" }] },
              updated_time: "2026-06-01T09:00:00+0000",
            },
          ],
        },
      })
      const skipMessagesBefore = new Map([["conv-unchanged", "2026-06-01T09:00:00+0000"]])
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token", skipMessagesBefore },
        null,
      )
      expect(fetch.calls.some((c) => c.url.includes("/messages"))).toBe(false)
      expect(result?.messages).toEqual([])
      // Conversation metadata still upserts (comes back in the result).
      expect(result?.conversations).toEqual([expect.objectContaining({ externalId: "conv-unchanged" })])
    })

    test("still fetches /messages when updated_time is strictly newer than the stored watermark", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": {
          data: [
            {
              id: "conv-changed",
              participants: { data: [{ id: "page-1" }, { id: "cust-1" }] },
              updated_time: "2026-06-01T10:00:00+0000",
            },
          ],
        },
        "/conv-changed/messages": { data: [] },
      })
      const skipMessagesBefore = new Map([["conv-changed", "2026-06-01T09:00:00+0000"]])
      await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token", skipMessagesBefore },
        null,
      )
      expect(fetch.calls.some((c) => c.url.includes("/messages"))).toBe(true)
    })

    test("always fetches /messages for a conversation with no stored watermark entry (new conversation)", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/page-1/conversations": {
          data: [{ id: "conv-new", participants: { data: [{ id: "page-1" }, { id: "cust-1" }] } }],
        },
        "/conv-new/messages": { data: [] },
      })
      const result = await facebookAdapter.syncDms?.(
        { accountExternalId: "user-1", fetch, accessToken: "user-token", skipMessagesBefore: new Map() },
        null,
      )
      expect(fetch.calls.some((c) => c.url.includes("/messages"))).toBe(true)
      expect(result?.error).toBeUndefined()
    })
  })

  describe("pollObject", () => {
    test("parses the <pageId>_<postId> prefix to pick the matching page's token", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token"), page("page-2", "page-2-token")] },
        "/page-1_post-9/comments": {
          data: [{ id: "page-1_c1", message: "nice!", from: { id: "u1" }, created_time: "t1" }],
          paging: { cursors: { after: "AFTER_C" } },
        },
      })
      const result = await facebookAdapter.pollObject(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "page-1_post-9",
        null,
      )
      expect(result.findings.length).toBe(1)
      expect(result.findings[0]).toMatchObject({
        externalId: "page-1_c1",
        parentExternalId: "page-1_post-9",
        metadata: { pageId: "page-1" },
      })
      expect(result.nextCursor).toBe("AFTER_C")

      const commentsCall = fetch.calls.find((c) => c.url.includes("/comments"))!
      expect(commentsCall.headers).toEqual({ Authorization: "Bearer page-1-token" })
    })

    test("asks for each comment's permalink and builds one when Graph omits it", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("111", "page-token")] },
        "/111_222/comments": {
          data: [
            { id: "222_333", message: "a", from: { id: "9" }, created_time: "t1" },
            { id: "222_444", message: "b", from: { id: "9" }, created_time: "t2", permalink_url: "https://www.facebook.com/p/444" },
          ],
        },
      })
      const result = await facebookAdapter.pollObject(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "111_222",
        null,
      )
      expect(fetch.calls.find((c) => c.url.includes("/comments"))?.url).toContain("permalink_url")
      expect(result.findings.map((f) => f.permalink)).toEqual([
        "https://www.facebook.com/111/posts/222?comment_id=333",
        "https://www.facebook.com/p/444",
      ])
    })

    test("falls back to the first managed page when the id prefix matches no managed page", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
        "/unknownprefix_post-1/comments": {
          data: [{ id: "c1", message: "hi", from: { id: "u1" }, created_time: "t1" }],
        },
      })
      const result = await facebookAdapter.pollObject(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "unknownprefix_post-1",
        null,
      )
      expect(result.findings.length).toBe(1)
      expect(result.findings[0]?.metadata).toMatchObject({ pageId: "page-1" })
    })

    test("/me/accounts 401 → CONNECTION_LOST, cursor unchanged", async () => {
      const fetch = makeMockFetch({ "/me/accounts": {} }, { status: 401 })
      const result = await facebookAdapter.pollObject(
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "page-1_post-9",
        "PRIOR_CURSOR",
      )
      expect(result).toMatchObject({ findings: [], nextCursor: "PRIOR_CURSOR", error: "CONNECTION_LOST" })
    })
  })

  describe("outbound requests use the resolved PAGE token", () => {
    test("replyRequest attaches Authorization: Bearer <page-token> resolved from the comment id prefix", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
      })
      const req = await facebookAdapter.replyRequest(
        { externalId: "page-1_comment-9" },
        "thanks!",
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
      )
      expect(req.url).toBe("https://graph.facebook.com/v26.0/page-1_comment-9/comments")
      expect(req.headers).toEqual({ Authorization: "Bearer page-1-token" })
    })

    test("likeRequest attaches Authorization: Bearer <page-token>", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-1", "page-1-token")] },
      })
      const req = await facebookAdapter.likeRequest?.(
        { externalId: "page-1_comment-9" },
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
      )
      expect(req?.headers).toEqual({ Authorization: "Bearer page-1-token" })
    })

    test("dmRequest resolves the page token from the explicit pageId argument (conversation metadata)", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-a", "token-a"), page("page-b", "token-b")] },
      })
      const req = await facebookAdapter.dmRequest?.(
        { recipientExternalId: "cust-1" },
        "hello",
        "none",
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        "page-b",
      )
      expect(req?.headers).toEqual({ Authorization: "Bearer token-b" })
    })

    test("dmRequest falls back to the first managed page when pageId is missing", async () => {
      const fetch = makeMockFetch({
        "/me/accounts": { data: [page("page-a", "token-a")] },
      })
      const req = await facebookAdapter.dmRequest?.(
        { recipientExternalId: "cust-1" },
        "hello",
        "none",
        { accountExternalId: "user-1", fetch, accessToken: "user-token" },
        null,
      )
      expect(req?.headers).toEqual({ Authorization: "Bearer token-a" })
    })

    test("without a ctx argument, no headers are attached (sync callers that don't pass ctx stay backward-compatible)", async () => {
      const req = await facebookAdapter.replyRequest({ externalId: "page-1_comment-9" }, "thanks!")
      expect(req.headers).toBeUndefined()
    })
  })
})

describe("postExcerpt — surrogate-pair-safe truncation", () => {
  test("never splits an emoji at the 80-point boundary (lone surrogate → pg 22P02)", () => {
    // 79 ascii chars + a 2-unit emoji straddling the old .slice(0, 80) cut.
    const msg = `${"a".repeat(79)}\u{1F4F1}rest of the caption goes on and on`
    const out = postExcerpt(msg)
    expect(out).toBeDefined()
    expect(out?.includes("\u{1F4F1}")).toBe(true)
    // JSON round-trips cleanly — the exact failure mode that killed discovery.
    expect(() => JSON.parse(JSON.stringify({ postExcerpt: out }))).not.toThrow()
    expect(out?.endsWith("…")).toBe(true)
  })
  test("short messages pass through untouched", () => {
    expect(postExcerpt("hello 📱")).toBe("hello 📱")
    expect(postExcerpt(null)).toBeUndefined()
  })
})
