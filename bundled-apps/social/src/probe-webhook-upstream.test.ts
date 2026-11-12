// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe. The kernel trusts this report to decide whether
// webhook silence is a dead Meta subscription or a quiet Page, so each branch
// pins the side it errs on: a subscribed Page reports its newest event that Meta
// delivers to us, no live sender reports null (never pages), our own outbound
// activity never counts, and an unreachable Graph reports NO activity at all.
import { describe, expect, test } from "bun:test"
import type { SocialToolCtx } from "./ctx"
import { probeWebhookUpstreamJob } from "./probe-webhook-upstream"
import { createMockDb, type MockDb } from "./test-db"

const APP_ID = "our-app"
const PAGE = "page-1"

type Route = { status?: number; body: unknown }

function ctxWith(
  db: MockDb,
  routes: Record<string, Route>,
  opts: { token?: string | null } = {},
): SocialToolCtx & { __calls: string[] } {
  const calls: string[] = []
  const token = opts.token === undefined ? "user-tok" : opts.token
  return {
    orgId: "org-1",
    db,
    connections: {
      getToken: async () => {
        if (!token) throw new Error("No connected account")
        return token
      },
    },
    config: { get: async () => null },
    fetch: async (url: string) => {
      calls.push(url)
      const path = new URL(url).pathname.replace(/^\/v\d+\.\d+/, "")
      const r = routes[path]
      if (!r) throw new Error(`unrouted ${path}`)
      return { status: r.status ?? 200, headers: {}, body: JSON.stringify(r.body) }
    },
    logger: {},
    __calls: calls,
  } as unknown as SocialToolCtx & { __calls: string[] }
}

async function seedFacebook(db: MockDb): Promise<void> {
  await db.insert("sync_state", {
    platform: "facebook",
    account_external_id: "fb-user",
    source_type: "dm",
    active: true,
  })
  await db.insert("sync_state", {
    platform: "facebook",
    account_external_id: "fb-user",
    source_type: "discovery",
    active: true,
  })
}

function liveRoutes(over: Partial<Record<string, Route>> = {}): Record<string, Route> {
  const base: Record<string, Route> = {
    "/app": { body: { id: APP_ID } },
    "/me/accounts": { body: { data: [{ id: PAGE, access_token: "page-tok" }] } },
    [`/${PAGE}/subscribed_apps`]: {
      body: {
        data: [
          { id: "someone-else", subscribed_fields: ["feed", "messages"] },
          { id: APP_ID, subscribed_fields: ["feed", "messages"] },
        ],
      },
    },
    [`/${PAGE}/conversations`]: {
      body: {
        data: [
          {
            messages: {
              data: [{ from: { id: "fan-1" }, created_time: "2026-10-19T10:00:00+0000" }],
            },
          },
          // Our own reply is the newest event of this thread: Meta does not send it to us.
          {
            messages: { data: [{ from: { id: PAGE }, created_time: "2026-10-19T23:00:00+0000" }] },
          },
        ],
      },
    },
    [`/${PAGE}/feed`]: {
      body: {
        data: [
          {
            comments: {
              data: [
                { from: { id: PAGE }, created_time: "2026-10-19T22:00:00+0000" },
                { from: { id: "fan-2" }, created_time: "2026-10-19T12:00:00+0000" },
              ],
            },
          },
          {
            comments: {
              data: [{ from: { id: "fan-3" }, created_time: "2026-10-18T09:00:00+0000" }],
            },
          },
          {},
        ],
      },
    },
  }
  return { ...base, ...over } as Record<string, Route>
}

describe("probeWebhookUpstreamJob", () => {
  test("reports the newest inbound event across subscribed fields, never our own sends", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    const ctx = ctxWith(db, liveRoutes())
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({
      upstreamActivityAt: "2026-10-19T12:00:00+0000",
    })
    // One account seeded under two source types is probed once.
    expect(ctx.__calls.filter((u) => u.includes("/me/accounts"))).toHaveLength(1)
    const feed = ctx.__calls.find((u) => u.includes("/feed"))!
    expect(feed).toContain("order(reverse_chronological)")
    expect(feed).toContain("filter(stream)")
  })

  test("only fields our app subscribed count: messages-only ignores comments", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    const ctx = ctxWith(
      db,
      liveRoutes({
        [`/${PAGE}/subscribed_apps`]: {
          body: { data: [{ id: APP_ID, subscribed_fields: ["messages"] }] },
        },
      }),
    )
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({
      upstreamActivityAt: "2026-10-19T10:00:00+0000",
    })
    expect(ctx.__calls.some((u) => u.includes("/feed"))).toBe(false)
  })

  test("a Page subscribed only by another app has no sender: reports null", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    const ctx = ctxWith(
      db,
      liveRoutes({
        [`/${PAGE}/subscribed_apps`]: {
          body: { data: [{ id: "someone-else", subscribed_fields: ["feed", "messages"] }] },
        },
      }),
    )
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
  })

  test("no connected Facebook account: reports null without calling Graph", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      platform: "instagram",
      account_external_id: "ig-1",
      source_type: "dm",
      active: true,
    })
    await db.insert("sync_state", {
      platform: "facebook",
      account_external_id: "fb-gone",
      source_type: "dm",
      active: false,
    })
    const ctx = ctxWith(db, liveRoutes())
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
    expect(ctx.__calls).toEqual([])
  })

  test("an active account whose token is missing or expired is no report, never a quiet Page", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    const ctx = ctxWith(db, liveRoutes(), { token: null })
    const result = await probeWebhookUpstreamJob({}, ctx)
    expect("upstreamActivityAt" in result).toBe(false)
    expect(result).toMatchObject({ probed: false })
    expect(ctx.__calls).toEqual([])
  })

  test("an active account whose token Meta refuses is no report", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    const refused: Route = {
      status: 401,
      body: { error: { message: "Session has expired", code: 190 } },
    }
    const result = await probeWebhookUpstreamJob(
      {},
      ctxWith(db, liveRoutes({ "/app": refused, "/me/accounts": refused })),
    )
    expect(result).toMatchObject({ probed: false })
    expect("upstreamActivityAt" in result).toBe(false)
  })

  test("no managed Page, or only our own activity: reports null", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    expect(
      await probeWebhookUpstreamJob(
        {},
        ctxWith(db, liveRoutes({ "/me/accounts": { body: { data: [] } } })),
      ),
    ).toEqual({ upstreamActivityAt: null })
    const ownOnly = liveRoutes({
      [`/${PAGE}/conversations`]: {
        body: {
          data: [
            {
              messages: {
                data: [{ from: { id: PAGE }, created_time: "2026-10-19T23:00:00+0000" }],
              },
            },
          ],
        },
      },
      [`/${PAGE}/feed`]: {
        body: {
          data: [
            {
              comments: {
                data: [{ from: { id: PAGE }, created_time: "2026-10-19T22:00:00+0000" }],
              },
            },
          ],
        },
      },
    })
    expect(await probeWebhookUpstreamJob({}, ctxWith(db, ownOnly))).toEqual({
      upstreamActivityAt: null,
    })
  })

  test("Graph errors are no report, never a quiet Page", async () => {
    const failures: Array<[string, Route]> = [
      ["/me/accounts", { status: 500, body: { error: { message: "down", code: 2 } } }],
      ["/app", { status: 401, body: { error: { message: "expired", code: 190 } } }],
      [
        `/${PAGE}/subscribed_apps`,
        { status: 403, body: { error: { message: "no perm", code: 200 } } },
      ],
      [`/${PAGE}/conversations`, { status: 429, body: { error: { message: "limit", code: 32 } } }],
      // Graph sometimes answers 200 with an error envelope.
      [`/${PAGE}/feed`, { status: 200, body: { error: { message: "rate", code: 4 } } }],
    ]
    for (const [path, route] of failures) {
      const db = createMockDb()
      await seedFacebook(db)
      const result = await probeWebhookUpstreamJob({}, ctxWith(db, liveRoutes({ [path]: route })))
      expect("upstreamActivityAt" in result).toBe(false)
      expect(result).toMatchObject({ probed: false })
    }
  })

  test("a grant without pages_manage_metadata says to reconnect Facebook", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    const refused = liveRoutes({
      [`/${PAGE}/subscribed_apps`]: {
        status: 403,
        body: {
          error: {
            message: "(#200) Requires pages_manage_metadata permission to manage the object",
            code: 200,
          },
        },
      },
    })
    const result = await probeWebhookUpstreamJob({}, ctxWith(db, refused))
    expect(result).toMatchObject({ probed: false })
    const reason = "reason" in result ? result.reason : ""
    expect(reason).toContain("pages_manage_metadata")
    expect(reason).toContain("reconnect the Facebook account")
  })

  test("an unreachable Graph (fetch throws) is no report", async () => {
    const db = createMockDb()
    await seedFacebook(db)
    const ctx = ctxWith(db, liveRoutes())
    ctx.fetch = async () => {
      throw new Error("ECONNRESET")
    }
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ probed: false, reason: "ECONNRESET" })
  })
})
