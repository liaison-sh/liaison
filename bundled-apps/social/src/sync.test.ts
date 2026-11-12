// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B5 — discovery sync watermark crash-safety + watch poller cadence adaptation.
// A sync that throws mid-batch must leave sync_state.cursor unchanged (the
// watermark only advances after all upserts in the batch succeed).

import { describe, expect, test } from "bun:test"
import type { AdapterContext, DiscoverResult, PlatformAdapter } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"
import { readYoutubeQuotaStatus, runDiscoverySync, runWatchPoller } from "./sync"
import { createMockDb, type MockDb } from "./test-db"

const ISO = "2026-06-01T10:00:00.000Z"

// FLAT sandbox-bridge connections shape with a live token, so the sync engine's
// auth precondition is satisfied and the real discover/poll path runs. Pass
// `{ token: null }` to simulate a missing/expired token (the host throws / empty).
function ctxWith(db: MockDb, opts: { token?: string | null } = {}): SocialToolCtx {
  const token = opts.token === undefined ? "tok-live" : opts.token
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => "",
    })) as never,
    connections: {
      getToken: async (_name: string, _identifier?: string) => {
        if (!token) throw new Error("No access token stored")
        return token
      },
    },
    config: { get: async () => null },
    async emit() {},
  } as SocialToolCtx
}

type LogLine = { level: "debug" | "info" | "warn" | "error"; msg: string }

/** A logger that records every line with its level. */
function recordingLogger(lines: LogLine[]): NonNullable<SocialToolCtx["logger"]> {
  return {
    debug: (msg: string) => lines.push({ level: "debug", msg }),
    info: (msg: string) => lines.push({ level: "info", msg }),
    warn: (msg: string) => lines.push({ level: "warn", msg }),
    error: (msg: string) => lines.push({ level: "error", msg }),
  } as NonNullable<SocialToolCtx["logger"]>
}

const NO_TOKEN = /no oauth access token/i

function fakeAdapter(over: Partial<PlatformAdapter>): PlatformAdapter {
  return {
    platform: "youtube",
    async discover(): Promise<DiscoverResult> {
      return { findings: [], nextCursor: null, unitsConsumed: 0 }
    },
    async pollObject(): Promise<DiscoverResult> {
      return { findings: [], nextCursor: null, unitsConsumed: 0 }
    },
    ...over,
  } as PlatformAdapter
}

describe("runDiscoverySync watermark crash-safety (B5)", () => {
  test("advances sync_state.cursor only after the whole batch upserts", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      id: "ss-1",
      platform: "youtube",
      account_external_id: "acct-1",
      source_type: "discovery",
      cursor: "c0",
      active: true,
    })
    const adapter = fakeAdapter({
      async discover(_ctx: AdapterContext, _cursor: string | null): Promise<DiscoverResult> {
        return {
          findings: [
            { platform: "youtube", externalId: "v1", relation: "keyword_match", occurredAt: ISO },
          ],
          nextCursor: "c1",
          unitsConsumed: 100,
        }
      },
    })
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "acct-1" })
    const ss = (await db.findMany("sync_state", { where: { id: "ss-1" } }))[0] as { cursor: string }
    expect(ss.cursor).toBe("c1")
    expect(await db.count("finding", { where: { external_id: "v1" } })).toBe(1)
  })

  test("a throw mid-upsert leaves the cursor at its prior value (no partial advance)", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      id: "ss-1",
      platform: "youtube",
      account_external_id: "acct-1",
      source_type: "discovery",
      cursor: "c0",
      active: true,
    })
    const original = db.insert.bind(db)
    let calls = 0
    // Make the SECOND finding insert throw — the first already inserted.
    db.insert = (async (entity: string, data: Record<string, unknown>) => {
      if (entity === "finding") {
        calls += 1
        if (calls === 2) throw new Error("boom mid-batch")
      }
      return original(entity, data)
    }) as MockDb["insert"]
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        return {
          findings: [
            { platform: "youtube", externalId: "v1", relation: "keyword_match", occurredAt: ISO },
            { platform: "youtube", externalId: "v2", relation: "keyword_match", occurredAt: ISO },
          ],
          nextCursor: "c1",
          unitsConsumed: 100,
        }
      },
    })
    await expect(
      runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "acct-1" }),
    ).rejects.toThrow(/boom mid-batch/)
    const ss = (await db.findMany("sync_state", { where: { id: "ss-1" } }))[0] as { cursor: string }
    expect(ss.cursor).toBe("c0") // unchanged — watermark is crash-safe
  })

  test("a CONNECTION_LOST result does not advance the cursor", async () => {
    const db = createMockDb()
    await db.insert("sync_state", {
      id: "ss-1",
      platform: "youtube",
      account_external_id: "acct-1",
      source_type: "discovery",
      cursor: "c0",
      active: true,
    })
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        return { findings: [], nextCursor: "c9", unitsConsumed: 0, error: "CONNECTION_LOST" }
      },
    })
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "acct-1" })
    const ss = (await db.findMany("sync_state", { where: { id: "ss-1" } }))[0] as { cursor: string }
    expect(ss.cursor).toBe("c0")
  })
})

describe("runWatchPoller cadence adaptation (B5)", () => {
  test("polls a due watch, ingests its comments, and sets a HOT cadence on activity", async () => {
    const db = createMockDb()
    // The poller resolves the platform's token via its active discovery sync_state
    // (which carries the connected account_external_id), so seed that row.
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      active: true,
    })
    await db.insert("watched_object", {
      id: "w-1",
      platform: "youtube",
      external_id: "v1",
      object_type: "youtube_video",
      status: "active",
      cadence_seconds: 86400,
      priority: 50,
      next_poll_at: "2020-01-01T00:00:00.000Z", // overdue
    })
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "youtube",
              externalId: "c-1",
              relation: "comment_on_our_content",
              parentExternalId: "v1",
              occurredAt: ISO,
            },
          ],
          nextCursor: null,
          unitsConsumed: 1,
        }
      },
    })
    await runWatchPoller(ctxWith(db), { adapters: { youtube: adapter }, now: new Date(ISO) })
    expect(await db.count("finding", { where: { external_id: "c-1" } })).toBe(1)
    const w = (await db.findMany("watched_object", { where: { id: "w-1" } }))[0] as {
      cadence_seconds: number
      last_polled_at: string | null
    }
    expect(w.cadence_seconds).toBe(300) // HOT — activity seen
    expect(w.last_polled_at).not.toBeNull()
  })

  test("skips decayed watches", async () => {
    const db = createMockDb()
    await db.insert("watched_object", {
      id: "w-1",
      platform: "youtube",
      external_id: "v1",
      object_type: "youtube_video",
      status: "decayed",
      next_poll_at: "2020-01-01T00:00:00.000Z",
    })
    let polled = false
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        polled = true
        return { findings: [], nextCursor: null, unitsConsumed: 1 }
      },
    })
    await runWatchPoller(ctxWith(db), { adapters: { youtube: adapter }, now: new Date(ISO) })
    expect(polled).toBe(false)
  })
})

describe("runWatchPoller auto_hot comment relation-honesty (incident fix)", () => {
  // The org does NOT own an auto_hot (keyword-promoted) video — its comments
  // are only kept when the comment text itself mentions an enabled monitor
  // term (verbatim phrase), reclassified to `mention_in_comment`. Every other
  // comment on that video is ambient chatter and gets dropped. A `manual`
  // watch (operator explicitly asked to watch it) keeps full capture as
  // `comment_on_our_content`.
  async function seedYtAccountAndTerm(db: MockDb, term = "tessera touch"): Promise<void> {
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      active: true,
    })
    await db.insert("monitor_term", {
      id: "term-1",
      kind: "keyword",
      value: term,
      platform: null,
      enabled: true,
    })
  }

  test("auto_hot watch: a comment with NO term mention is dropped", async () => {
    const db = createMockDb()
    await seedYtAccountAndTerm(db)
    await db.insert("watched_object", {
      id: "w-1",
      platform: "youtube",
      external_id: "F7QCSn8QibE",
      object_type: "youtube_video",
      status: "active",
      reason: "auto_hot",
      cadence_seconds: 86400,
      priority: 50,
      next_poll_at: "2020-01-01T00:00:00.000Z",
    })
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "youtube",
              externalId: "c-1",
              relation: "comment_on_our_content",
              parentExternalId: "F7QCSn8QibE",
              contentText: "great synth!",
              occurredAt: ISO,
            },
          ],
          nextCursor: null,
          unitsConsumed: 1,
        }
      },
    })
    await runWatchPoller(ctxWith(db), { adapters: { youtube: adapter }, now: new Date(ISO) })
    expect(await db.count("finding", { where: { external_id: "c-1" } })).toBe(0)
  })

  test("auto_hot watch: a comment mentioning the monitor term is ingested as mention_in_comment", async () => {
    const db = createMockDb()
    await seedYtAccountAndTerm(db)
    await db.insert("watched_object", {
      id: "w-1",
      platform: "youtube",
      external_id: "F7QCSn8QibE",
      object_type: "youtube_video",
      status: "active",
      reason: "auto_hot",
      cadence_seconds: 86400,
      priority: 50,
      next_poll_at: "2020-01-01T00:00:00.000Z",
    })
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "youtube",
              externalId: "c-2",
              relation: "comment_on_our_content",
              parentExternalId: "F7QCSn8QibE",
              contentText: "I love my tessera touch",
              occurredAt: ISO,
            },
          ],
          nextCursor: null,
          unitsConsumed: 1,
        }
      },
    })
    await runWatchPoller(ctxWith(db), { adapters: { youtube: adapter }, now: new Date(ISO) })
    expect(await db.count("finding", { where: { external_id: "c-2" } })).toBe(1)
    const [f] = (await db.findMany("finding", { where: { external_id: "c-2" } })) as Array<{
      relation: string
      metadata?: { matchedTerms?: string[] }
    }>
    expect(f?.relation).toBe("mention_in_comment")
    expect(f?.metadata?.matchedTerms).toEqual(["term-1"])
  })

  test("manual watch: all comments are kept as comment_on_our_content, no filtering", async () => {
    const db = createMockDb()
    await seedYtAccountAndTerm(db)
    await db.insert("watched_object", {
      id: "w-1",
      platform: "youtube",
      external_id: "vid-manual",
      object_type: "youtube_video",
      status: "active",
      reason: "manual",
      cadence_seconds: 86400,
      priority: 50,
      next_poll_at: "2020-01-01T00:00:00.000Z",
    })
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "youtube",
              externalId: "c-3",
              relation: "comment_on_our_content",
              parentExternalId: "vid-manual",
              contentText: "nothing to do with any term",
              occurredAt: ISO,
            },
          ],
          nextCursor: null,
          unitsConsumed: 1,
        }
      },
    })
    await runWatchPoller(ctxWith(db), { adapters: { youtube: adapter }, now: new Date(ISO) })
    expect(await db.count("finding", { where: { external_id: "c-3" } })).toBe(1)
    const [f] = (await db.findMany("finding", { where: { external_id: "c-3" } })) as Array<{
      relation: string
    }>
    expect(f?.relation).toBe("comment_on_our_content")
  })
})

describe("runWatchPoller YouTube quota enforcement (C1 / §9 #3)", () => {
  // With a small daily budget B, the poller polls highest-priority YouTube
  // watches first, defers the rest (count logged), persists the running unit
  // total, and never lets consumed exceed B.
  async function seedYtBudgetState(db: MockDb, consumed: number): Promise<void> {
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      cursor: null,
      active: true,
      units_consumed_today: consumed,
      units_window_date: ISO.slice(0, 10),
    })
    // The poller's own ledger row (created at connection time alongside discovery).
    await db.insert("sync_state", {
      id: "yt-watch",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "watch",
      cursor: null,
      active: true,
      units_consumed_today: 0,
      units_window_date: ISO.slice(0, 10),
    })
  }
  function ytWatch(id: string, priority: number): Record<string, unknown> {
    return {
      id,
      platform: "youtube",
      external_id: id,
      object_type: "youtube_video",
      status: "active",
      priority,
      next_poll_at: "2020-01-01T00:00:00.000Z",
    }
  }

  test("with B nearly spent, only the highest-priority watch polls; the rest defer (counted + logged)", async () => {
    const db = createMockDb()
    // Cap 10; already spent 9 → exactly 1 unit (1 comment poll) remains.
    await seedYtBudgetState(db, 9)
    await db.insert("watched_object", ytWatch("w-high", 90))
    await db.insert("watched_object", ytWatch("w-low", 10))
    const warnings: string[] = []
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        return { findings: [], nextCursor: null, unitsConsumed: 1 }
      },
    })
    const ctx = ctxWith(db)
    ctx.logger = { warn: (m: string) => warnings.push(m) }
    const res = await runWatchPoller(ctx, {
      adapters: { youtube: adapter },
      now: new Date(ISO),
      dailyBudget: 10,
    })
    expect(res.polled).toBe(1) // only w-high fit
    expect(res.deferred).toBe(1) // w-low deferred
    expect(warnings.some((w) => /defer/i.test(w))).toBe(true)
    // The poller's own spend is persisted on ITS ledger row (the youtube `watch`
    // sync_state row), and discovery's share + the poller's share never exceed B.
    const disc = (await db.findMany("sync_state", { where: { id: "yt-disc" } }))[0] as {
      units_consumed_today: number
    }
    const ledger = (await db.findMany("sync_state", { where: { id: "yt-watch" } }))[0] as {
      units_consumed_today: number
    }
    expect(disc.units_consumed_today).toBe(9) // untouched by the poller
    expect(ledger.units_consumed_today).toBe(1)
    expect(disc.units_consumed_today + ledger.units_consumed_today).toBeLessThanOrEqual(10)
    // The deferred (low-priority) watch was NOT polled → its cadence is untouched.
    const low = (await db.findMany("watched_object", { where: { id: "w-low" } }))[0] as {
      last_polled_at: string | null
    }
    expect(low.last_polled_at ?? null).toBeNull()
  })

  test("a fresh day resets the consumed counter (window_date rollover)", async () => {
    const db = createMockDb()
    // Counter from a PRIOR day — should reset to 0, so the watch polls.
    // `active: true` is required so the poller's token-resolution path finds the
    // platform's connected account (via accountIdForPlatform) and a token resolves.
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      active: true,
      units_consumed_today: 9999,
      units_window_date: "2020-01-01",
    })
    await db.insert("watched_object", ytWatch("w-1", 50))
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        return { findings: [], nextCursor: null, unitsConsumed: 1 }
      },
    })
    const res = await runWatchPoller(ctxWith(db), {
      adapters: { youtube: adapter },
      now: new Date(ISO),
      dailyBudget: 10,
    })
    expect(res.polled).toBe(1)
    expect(res.deferred).toBe(0)
    // No `watch` ledger row was seeded (a pre-ledger connection): the poller
    // creates it and persists today's spend there; the stale discovery counter
    // is simply ignored (prior day) and left alone.
    const [ledger] = (await db.findMany("sync_state", {
      where: { platform: "youtube", source_type: "watch" },
    })) as Array<{
      units_consumed_today: number
      units_window_date: string
      account_external_id: string
    }>
    // Narrowing, not decoration: `expect(...).toBeDefined()` does not narrow the
    // destructured row for tsc, and the bundled-app build runs `tsc --noEmit`.
    if (!ledger) throw new Error("sync.test: expected a watch ledger row to exist")
    expect(ledger.account_external_id).toBe("chan-1")
    expect(ledger.units_consumed_today).toBe(1) // reset then spent 1
    expect(ledger.units_window_date).toBe(ISO.slice(0, 10))
    const disc = (await db.findMany("sync_state", { where: { id: "yt-disc" } }))[0] as {
      units_consumed_today: number
      units_window_date: string
    }
    expect(disc.units_consumed_today).toBe(9999)
    expect(disc.units_window_date).toBe("2020-01-01")
  })

  // REGRESSION (prod, one failed poller tick per quarter hour): discovery-sync
  // and watch-poller fire on the same cron second and each job runs in ONE
  // ambient transaction. When the poller persisted its spend onto the
  // DISCOVERY row, its UPDATE queued behind discovery's row lock for the rest
  // of discovery's run and was killed by statement_timeout (57014). The poller
  // must therefore never write the discovery row: reads never block, and each
  // writer locks only its own ledger.
  test("the poller never writes the discovery sync_state row (separate ledgers, no row-lock contention with discovery-sync)", async () => {
    const db = createMockDb()
    await seedYtBudgetState(db, 100)
    await db.insert("watched_object", ytWatch("w-1", 50))
    await db.insert("watched_object", ytWatch("w-2", 40))
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        return { findings: [], nextCursor: null, unitsConsumed: 1 }
      },
    })
    const writes: Array<{ id: string; data: Record<string, unknown> }> = []
    const rawUpdate = db.update.bind(db)
    db.update = async (entity, id, data) => {
      if (entity === "sync_state") writes.push({ id, data })
      return rawUpdate(entity, id, data)
    }
    const res = await runWatchPoller(ctxWith(db), {
      adapters: { youtube: adapter },
      now: new Date(ISO),
      dailyBudget: 9000,
    })
    expect(res.polled).toBe(2)
    expect(writes.map((w) => w.id)).toEqual(["yt-watch"])
    expect(writes[0]!.data.units_consumed_today).toBe(2)
    const disc = (await db.findMany("sync_state", { where: { id: "yt-disc" } }))[0] as {
      units_consumed_today: number
    }
    expect(disc.units_consumed_today).toBe(100)
    // Budget still spans both ledgers: a second tick starts from 100 + 2, so
    // with B = 103 exactly one more fresh due watch fits and the other defers.
    await db.insert("watched_object", ytWatch("w-3", 60))
    await db.insert("watched_object", ytWatch("w-4", 30))
    const second = await runWatchPoller(ctxWith(db), {
      adapters: { youtube: adapter },
      now: new Date(ISO),
      dailyBudget: 103,
    })
    expect(second.polled).toBe(1)
    expect(second.deferred).toBe(1)
  })
})

describe("runDiscoverySync auto-watch (C2 / §9 #6)", () => {
  async function seedDiscState(db: MockDb): Promise<void> {
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      cursor: null,
      active: true,
    })
  }

  test("a YouTube keyword-match video with ≥20 comments is promoted to a watched_object within the cycle", async () => {
    const db = createMockDb()
    await seedDiscState(db)
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "youtube",
              externalId: "vid-1",
              relation: "keyword_match",
              commentCount: 42,
              occurredAt: ISO,
            },
          ],
          nextCursor: "c1",
          unitsConsumed: 100,
        }
      },
    })
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "chan-1" })
    expect(
      await db.count("watched_object", { where: { platform: "youtube", external_id: "vid-1" } }),
    ).toBe(1)
    const w = (await db.findMany("watched_object", { where: { external_id: "vid-1" } }))[0] as {
      reason: string
      object_type: string
    }
    expect(w.reason).toBe("auto_hot")
    expect(w.object_type).toBe("youtube_video")
  })

  test("auto-watch promotion populates watched_object.title from the finding's contentText (incident fix)", async () => {
    const db = createMockDb()
    await seedDiscState(db)
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "youtube",
              externalId: "vid-titled",
              relation: "keyword_match",
              commentCount: 42,
              contentText: "Fabrikam TESSERA Touch review",
              occurredAt: ISO,
            },
          ],
          nextCursor: "c1",
          unitsConsumed: 100,
        }
      },
    })
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "chan-1" })
    const w = (
      await db.findMany("watched_object", { where: { external_id: "vid-titled" } })
    )[0] as {
      title: string | null
    }
    expect(w.title).toBe("Fabrikam TESSERA Touch review")
  })

  test("a YouTube keyword-match video BELOW the comment threshold is NOT auto-watched", async () => {
    const db = createMockDb()
    await seedDiscState(db)
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        return {
          findings: [
            {
              platform: "youtube",
              externalId: "vid-2",
              relation: "keyword_match",
              commentCount: 3,
              occurredAt: ISO,
            },
          ],
          nextCursor: "c1",
          unitsConsumed: 100,
        }
      },
    })
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "chan-1" })
    expect(await db.count("watched_object", { where: { external_id: "vid-2" } })).toBe(0)
  })

  test("discovery folds its YouTube search.list units into the daily counter (reserves the slice the poller budgets against)", async () => {
    const db = createMockDb()
    // Seed the window to the quota day (Pacific) of the injected clock, so the
    // run treats it as "same day" and accumulates rather than rolling over.
    const today = "2026-06-01"
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      cursor: null,
      active: true,
      units_consumed_today: 100,
      units_window_date: today,
    })
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        return { findings: [], nextCursor: "c1", unitsConsumed: 100 }
      },
    })
    // Same day as the seeded window_date, so the 100-unit search.list cost
    // accumulates onto the prior 100.
    await runDiscoverySync(ctxWith(db), {
      adapter,
      accountExternalId: "chan-1",
      now: new Date(ISO),
    })
    const ss = (await db.findMany("sync_state", { where: { id: "yt-disc" } }))[0] as {
      units_consumed_today: number
    }
    expect(ss.units_consumed_today).toBe(200)
  })
})

// REGRESSION (auth threading): the per-account OAuth token MUST be resolved via
// the host connections accessor and passed into the adapter's AdapterContext.
// Before the fix, `accessToken` was never threaded (the call was unauthenticated,
// masked by `as never`), so every page 401'd → CONNECTION_LOST and the watermark
// never advanced — silently.
describe("runDiscoverySync auth token threading", () => {
  async function seedDisc(db: MockDb): Promise<void> {
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      cursor: "c0",
      active: true,
    })
  }

  test("passes the resolved access token into the adapter context", async () => {
    const db = createMockDb()
    await seedDisc(db)
    let seenToken: string | undefined = "UNSET"
    const adapter = fakeAdapter({
      async discover(ctx: AdapterContext): Promise<DiscoverResult> {
        seenToken = ctx.accessToken
        return { findings: [], nextCursor: "c1", unitsConsumed: 0 }
      },
    })
    await runDiscoverySync(ctxWith(db, { token: "tok-live" }), {
      adapter,
      accountExternalId: "chan-1",
    })
    expect(seenToken).toBe("tok-live")
    expect((seenToken ?? "").length).toBeGreaterThan(0)
    // The watermark advanced (the authenticated page succeeded).
    const ss = (await db.findMany("sync_state", { where: { id: "yt-disc" } }))[0] as {
      cursor: string
    }
    expect(ss.cursor).toBe("c1")
  })

  // An account with no OAuth token is an expected state (never connected, or a
  // disconnect), not an error: a demo instance's seeded orgs logged ~100
  // error-level lines per 15 minutes for it, burying real errors. It is said
  // ONCE, at info, and every later tick skips it at debug until a token is back.
  test("a missing/expired token skips the account without calling the adapter or advancing the watermark", async () => {
    const db = createMockDb()
    await seedDisc(db)
    let called = false
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        called = true
        return { findings: [], nextCursor: "c1", unitsConsumed: 0 }
      },
    })
    const lines: LogLine[] = []
    const ctx = ctxWith(db, { token: null })
    ctx.logger = recordingLogger(lines)
    const res = await runDiscoverySync(ctx, { adapter, accountExternalId: "chan-1" })
    expect(called).toBe(false) // never made an unauthenticated call
    expect(res).toEqual({ ingested: 0, unitsConsumed: 0 })
    // Watermark untouched: nothing was read.
    const ss = (await db.findMany("sync_state", { where: { id: "yt-disc" } }))[0] as {
      cursor: string
    }
    expect(ss.cursor).toBe("c0")
  })

  test("a missing token is logged once at info, never as an error, and again only after a token came back", async () => {
    const db = createMockDb()
    await seedDisc(db)
    const adapter = fakeAdapter({})
    const lines: LogLine[] = []
    const noToken = ctxWith(db, { token: null })
    noToken.logger = recordingLogger(lines)
    for (let tick = 0; tick < 3; tick++) {
      await runDiscoverySync(noToken, { adapter, accountExternalId: "chan-1" })
    }
    const said = lines.filter((l) => NO_TOKEN.test(l.msg))
    expect(said.filter((l) => l.level === "error" || l.level === "warn")).toEqual([])
    expect(said.filter((l) => l.level === "info")).toHaveLength(1)

    // The token comes back, then goes again: that is a new state, said once more.
    const withToken = ctxWith(db, { token: "tok-live" })
    withToken.logger = recordingLogger(lines)
    await runDiscoverySync(withToken, { adapter, accountExternalId: "chan-1" })
    await runDiscoverySync(noToken, { adapter, accountExternalId: "chan-1" })
    expect(lines.filter((l) => NO_TOKEN.test(l.msg) && l.level === "info")).toHaveLength(2)
  })
})

describe("runWatchPoller auth token threading", () => {
  function seedWatch(db: MockDb): Promise<{ id: string }> {
    return db.insert("watched_object", {
      id: "w-1",
      platform: "youtube",
      external_id: "v1",
      object_type: "youtube_video",
      status: "active",
      cadence_seconds: 86400,
      priority: 50,
      next_poll_at: "2020-01-01T00:00:00.000Z",
    })
  }
  async function seedYtAccount(db: MockDb): Promise<void> {
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      active: true,
    })
  }

  test("passes the resolved access token into pollObject", async () => {
    const db = createMockDb()
    await seedYtAccount(db)
    await seedWatch(db)
    let seenToken: string | undefined = "UNSET"
    const adapter = fakeAdapter({
      async pollObject(ctx: AdapterContext): Promise<DiscoverResult> {
        seenToken = ctx.accessToken
        return { findings: [], nextCursor: null, unitsConsumed: 1 }
      },
    })
    const res = await runWatchPoller(ctxWith(db, { token: "tok-live" }), {
      adapters: { youtube: adapter },
      now: new Date(ISO),
    })
    expect(seenToken).toBe("tok-live")
    expect(res.polled).toBe(1)
  })

  test("a missing token skips the poll (no unauthenticated call, no cadence churn) without an error line", async () => {
    const db = createMockDb()
    await seedYtAccount(db)
    await seedWatch(db)
    let called = false
    const adapter = fakeAdapter({
      async pollObject(): Promise<DiscoverResult> {
        called = true
        return { findings: [], nextCursor: null, unitsConsumed: 1 }
      },
    })
    await db.insert("watched_object", {
      id: "w-2",
      platform: "youtube",
      external_id: "v2",
      object_type: "youtube_video",
      status: "active",
      cadence_seconds: 86400,
      priority: 50,
      next_poll_at: "2020-01-01T00:00:00.000Z",
    })
    const lines: LogLine[] = []
    const ctx = ctxWith(db, { token: null })
    ctx.logger = recordingLogger(lines)
    const res = await runWatchPoller(ctx, { adapters: { youtube: adapter }, now: new Date(ISO) })
    expect(called).toBe(false)
    expect(res.polled).toBe(0)
    // One debug line for the platform this tick, not an error per watch: the
    // account's discovery sync is what says (once) that it has no token.
    const said = lines.filter((l) => NO_TOKEN.test(l.msg))
    expect(said).toHaveLength(1)
    expect(said[0]?.level).toBe("debug")
    // Cadence untouched — the watch was not polled.
    const w = (await db.findMany("watched_object", { where: { id: "w-1" } }))[0] as {
      cadence_seconds: number
      last_polled_at: string | null
    }
    expect(w.cadence_seconds).toBe(86400)
    expect(w.last_polled_at ?? null).toBeNull()
  })
})

describe("YouTube quota budget across discovery and watch polls", () => {
  // 2026-10-20 is daylight time: Pacific midnight = 07:00 UTC, so 05:00 UTC is
  // still the Pacific day 2026-10-19 and the next reset is 2026-10-20T07:00Z.
  const NOW = new Date("2026-10-20T05:00:00.000Z")
  const QUOTA_DAY = "2026-10-19"
  const RESET = "2026-10-20T07:00:00.000Z"

  async function seed(
    db: MockDb,
    opts: { discoveryUnits?: number; watchUnits?: number; lastSyncedAt?: string | null } = {},
  ) {
    await db.insert("sync_state", {
      id: "yt-disc",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "discovery",
      cursor: null,
      active: true,
      units_consumed_today: opts.discoveryUnits ?? 0,
      units_window_date: QUOTA_DAY,
      last_synced_at: opts.lastSyncedAt ?? null,
      metadata: { kernel_public_base_url: "https://x.example" },
    })
    await db.insert("sync_state", {
      id: "yt-watch",
      platform: "youtube",
      account_external_id: "chan-1",
      source_type: "watch",
      cursor: null,
      active: true,
      units_consumed_today: opts.watchUnits ?? 0,
      units_window_date: QUOTA_DAY,
    })
    await db.insert("monitor_term", {
      id: "t1",
      kind: "keyword",
      value: "kestrel",
      platform: null,
      enabled: true,
    })
    await db.insert("monitor_term", {
      id: "t2",
      kind: "keyword",
      value: "resonant",
      platform: null,
      enabled: true,
    })
  }
  async function addWatch(db: MockDb, id: string, priority = 50) {
    await db.insert("watched_object", {
      id,
      platform: "youtube",
      external_id: id,
      object_type: "youtube_video",
      status: "active",
      cadence_seconds: 3600,
      priority,
      next_poll_at: "2020-01-01T00:00:00.000Z",
    })
  }
  function countingAdapter(
    over: { discover?: () => DiscoverResult; poll?: () => DiscoverResult } = {},
  ) {
    const calls = { discover: 0, poll: 0 }
    const adapter = fakeAdapter({
      async discover(): Promise<DiscoverResult> {
        calls.discover += 1
        return over.discover?.() ?? { findings: [], nextCursor: "c1", unitsConsumed: 229 }
      },
      async pollObject(): Promise<DiscoverResult> {
        calls.poll += 1
        return over.poll?.() ?? { findings: [], nextCursor: null, unitsConsumed: 1 }
      },
    })
    return { adapter, calls }
  }
  const row = async (db: MockDb, id: string) =>
    (await db.findMany("sync_state", { where: { id } }))[0] as {
      units_consumed_today: number
      units_window_date: string
      cursor: string | null
      metadata: Record<string, unknown>
    }

  test("discovery share spent -> discovery skipped (no API call) while watches still poll", async () => {
    const db = createMockDb()
    await seed(db, { discoveryUnits: 2900 }) // 2900 + ~229 estimate > 3000 share
    await addWatch(db, "w-1")
    const { adapter, calls } = countingAdapter()
    const ctx = ctxWith(db)
    await runDiscoverySync(ctx, { adapter, accountExternalId: "chan-1", now: NOW })
    expect(calls.discover).toBe(0)
    expect(
      ((await row(db, "yt-disc")).metadata.youtube_quota as { discovery_skipped: string })
        .discovery_skipped,
    ).toBe("budget")
    // Other metadata keys survive the quota write.
    expect((await row(db, "yt-disc")).metadata.kernel_public_base_url).toBe("https://x.example")
    const res = await runWatchPoller(ctx, { adapters: { youtube: adapter }, now: NOW })
    expect(res.polled).toBe(1)
    expect(res.deferred).toBe(0)
  })

  test("total cap nearly spent by watches -> discovery skipped even with share left", async () => {
    const db = createMockDb()
    await seed(db, { discoveryUnits: 0, watchUnits: 8900 })
    const { adapter, calls } = countingAdapter()
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "chan-1", now: NOW })
    expect(calls.discover).toBe(0)
  })

  test("discovery runs at most once per 2 hours", async () => {
    const db = createMockDb()
    await seed(db, { lastSyncedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() })
    const { adapter, calls } = countingAdapter()
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "chan-1", now: NOW })
    expect(calls.discover).toBe(0)
    const later = new Date(NOW.getTime() + 61 * 60 * 1000)
    await runDiscoverySync(ctxWith(db), { adapter, accountExternalId: "chan-1", now: later })
    expect(calls.discover).toBe(1)
    expect((await row(db, "yt-disc")).units_consumed_today).toBe(229)
  })

  test("discovery quotaExceeded -> nothing is spent until the Pacific-midnight reset", async () => {
    const db = createMockDb()
    await seed(db)
    await addWatch(db, "w-1")
    const { adapter, calls } = countingAdapter({
      discover: () => ({
        findings: [],
        nextCursor: "c-partial",
        unitsConsumed: 100,
        quotaExhausted: true,
      }),
    })
    const ctx = ctxWith(db)
    await runDiscoverySync(ctx, { adapter, accountExternalId: "chan-1", now: NOW })
    const disc = await row(db, "yt-disc")
    expect((disc.metadata.youtube_quota as { exhausted_until: string }).exhausted_until).toBe(RESET)
    expect(disc.units_consumed_today).toBe(100)
    expect(disc.cursor).toBe("c-partial")
    // Watches: no poll call at all, every due watch deferred, cadence untouched.
    const res = await runWatchPoller(ctx, { adapters: { youtube: adapter }, now: NOW })
    expect(calls.poll).toBe(0)
    expect(res.deferred).toBe(1)
    const w = (await db.findMany("watched_object", { where: { id: "w-1" } }))[0] as {
      last_polled_at?: string | null
    }
    expect(w.last_polled_at ?? null).toBeNull()
    // Discovery past its cadence but before the reset: still blocked.
    const beforeReset = new Date(Date.parse(RESET) - 60_000)
    await runDiscoverySync(ctx, { adapter, accountExternalId: "chan-1", now: beforeReset })
    expect(calls.discover).toBe(1)
    const status = await readYoutubeQuotaStatus(ctx, beforeReset)
    expect(status?.exhaustedUntil).toBe(RESET)
    expect(status?.remaining).toBe(0)
    // After the reset: a new quota day, counters at 0, everything runs again.
    const afterReset = new Date(Date.parse(RESET) + 60_000)
    const fresh = await readYoutubeQuotaStatus(ctx, afterReset)
    expect(fresh).toMatchObject({
      day: "2026-10-20",
      consumed: 0,
      remaining: 9000,
      exhaustedUntil: null,
    })
    const polled = await runWatchPoller(ctx, { adapters: { youtube: adapter }, now: afterReset })
    expect(polled.polled).toBe(1)
  })

  test("a watch poll answered quotaExceeded stops the tick and leaves every watch's cadence alone", async () => {
    const db = createMockDb()
    await seed(db)
    await addWatch(db, "w-1", 90)
    await addWatch(db, "w-2", 10)
    const { adapter, calls } = countingAdapter({
      poll: () => ({ findings: [], nextCursor: null, unitsConsumed: 0, quotaExhausted: true }),
    })
    const ctx = ctxWith(db)
    const res = await runWatchPoller(ctx, { adapters: { youtube: adapter }, now: NOW })
    expect(calls.poll).toBe(1) // the second watch is not even tried
    expect(res.polled).toBe(0)
    expect(res.deferred).toBe(2)
    for (const id of ["w-1", "w-2"]) {
      const w = (await db.findMany("watched_object", { where: { id } }))[0] as {
        cadence_seconds: number
        last_polled_at?: string | null
      }
      expect(w.cadence_seconds).toBe(3600)
      expect(w.last_polled_at ?? null).toBeNull()
    }
    const ledger = await row(db, "yt-watch")
    expect((ledger.metadata.youtube_quota as { exhausted_until: string }).exhausted_until).toBe(
      RESET,
    )
    // Discovery sees the poller's exhaustion and spends nothing.
    await runDiscoverySync(ctx, { adapter, accountExternalId: "chan-1", now: NOW })
    expect(calls.discover).toBe(0)
  })

  test("a watch whose poll only returns already-ingested comments cools down (not hot forever)", async () => {
    const db = createMockDb()
    await seed(db)
    await addWatch(db, "w-1")
    const same: DiscoverResult = {
      findings: [
        {
          platform: "youtube",
          externalId: "c-old",
          relation: "comment_on_our_content",
          parentExternalId: "w-1",
          occurredAt: ISO,
        },
      ],
      nextCursor: null,
      unitsConsumed: 1,
    }
    const { adapter } = countingAdapter({ poll: () => same })
    const ctx = ctxWith(db)
    await runWatchPoller(ctx, { adapters: { youtube: adapter }, now: NOW })
    const first = (await db.findMany("watched_object", { where: { id: "w-1" } }))[0] as {
      cadence_seconds: number
    }
    expect(first.cadence_seconds).toBe(300) // new comment -> hot
    await db.update("watched_object", "w-1", { next_poll_at: "2020-01-01T00:00:00.000Z" })
    await runWatchPoller(ctx, { adapters: { youtube: adapter }, now: NOW })
    const second = (await db.findMany("watched_object", { where: { id: "w-1" } }))[0] as {
      cadence_seconds: number
    }
    expect(second.cadence_seconds).toBe(3600) // nothing new -> warm
  })

  test("readYoutubeQuotaStatus sums both ledgers on the Pacific day", async () => {
    const db = createMockDb()
    await seed(db, { discoveryUnits: 458, watchUnits: 1200 })
    const status = await readYoutubeQuotaStatus(ctxWith(db), NOW)
    expect(status).toEqual({
      day: QUOTA_DAY,
      resetsAt: RESET,
      googleDailyLimit: 10000,
      cap: 9000,
      consumed: 1658,
      remaining: 9000 - 1658,
      discovery: { consumed: 458, share: 3000, skipped: null },
      watch: { consumed: 1200, deferred: 0 },
      exhaustedUntil: null,
    })
  })
})
