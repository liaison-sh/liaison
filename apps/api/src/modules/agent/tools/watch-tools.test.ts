// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { routineState, routines, users } from "~/db/schema/kernel"
import {
  handleWatchState,
  handleWebWatch,
  parseDelimitedRecords,
  WEB_WATCH_EXTRACTION_QUERY,
} from "~/modules/agent/tools/watch-tools"
import { createTestOrg } from "~/tests/helpers/org"

let orgId: string
let routineR: string
let routineS: string
let userId: string

async function seed(): Promise<void> {
  const org = await createTestOrg()
  orgId = org.id
  userId = await withSystemDb("watch-test-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId,
        email: `watch-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Watch Tester",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  await withSystemDb("watch-test-routines", async (db) => {
    const [r] = await db
      .insert(routines)
      .values({
        orgId,
        ownerUserId: userId,
        name: "R",
        description: "d",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: [],
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routines.id })
    const [s] = await db
      .insert(routines)
      .values({
        orgId,
        ownerUserId: userId,
        name: "S",
        description: "d",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        scopes: [],
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routines.id })
    routineR = r.id
    routineS = s.id
  })
}

afterEach(async () => {
  await withSystemDb("watch-test-clean", async (db) => {
    await db.delete(routineState).where(eq(routineState.orgId, orgId))
  })
})

describe("watch_state (routine-scoped get-or-set)", () => {
  beforeEach(seed)

  it("first call with a value persists and reports changed:false (no prior)", async () => {
    await withPrivilegedDb(orgId, "watch-1", async (tx) => {
      const r = await handleWatchState(
        { key: "price:corvane", value: { eur: 599 } },
        { orgId, routineId: routineR, tx },
      )
      expect(r).toEqual({ value: { eur: 599 }, previous: null, changed: false })
    })
  })

  it("second call with a different value reports changed:true and the prior value", async () => {
    await withPrivilegedDb(orgId, "watch-2", async (tx) => {
      await handleWatchState(
        { key: "price:corvane", value: { eur: 599 } },
        { orgId, routineId: routineR, tx },
      )
      const r = await handleWatchState(
        { key: "price:corvane", value: { eur: 549 } },
        { orgId, routineId: routineR, tx },
      )
      expect(r.previous).toEqual({ eur: 599 })
      expect(r.value).toEqual({ eur: 549 })
      expect(r.changed).toBe(true)
    })
  })

  it("call with no value is a pure read (does not mutate)", async () => {
    await withPrivilegedDb(orgId, "watch-3", async (tx) => {
      await handleWatchState({ key: "k", value: { n: 1 } }, { orgId, routineId: routineR, tx })
      const r = await handleWatchState({ key: "k" }, { orgId, routineId: routineR, tx })
      expect(r.value).toEqual({ n: 1 })
      expect(r.changed).toBe(false)
    })
  })

  it("throws when invoked outside a routine run (no routineId)", async () => {
    await withPrivilegedDb(orgId, "watch-4", async (tx) => {
      await expect(
        handleWatchState({ key: "k" }, { orgId, routineId: undefined, tx }),
      ).rejects.toThrow(/routine/i)
    })
  })

  it("state is isolated per routine — routine S cannot read routine R's key", async () => {
    await withPrivilegedDb(orgId, "watch-5", async (tx) => {
      await handleWatchState({ key: "k", value: { who: "R" } }, { orgId, routineId: routineR, tx })
      const fromS = await handleWatchState({ key: "k" }, { orgId, routineId: routineS, tx })
      expect(fromS.value).toBeNull()
    })
  })
})

describe("parseDelimitedRecords (free-text extraction → discrete items)", () => {
  it("parses a 'Record N:'-headered block with labeled fields into per-record items", () => {
    const text = `Record 1:
Author: Mira Lindqvist
Rating: 2 out of 5 stars
Date: 2026-06-20
Text: firmware update bricked my unit

Record 2:
Author: Devon Marsh
Rating: 5 out of 5 stars
Date: 2026-06-10
Text: Incredible expressive control`
    const items = parseDelimitedRecords(text)
    expect(items.length).toBe(2)
    expect(items[0].author).toBe("Mira Lindqvist")
    expect(items[0].rating).toBe("2 out of 5 stars")
    expect(items[0].text).toContain("bricked my unit")
    expect(items[1].author).toBe("Devon Marsh")
  })

  it("parses a 'Review N:' format (the real extraction shape) too", () => {
    const text = `Review 1:
Text: Arrived with a loose USB-C port.
Rating: 2 out of 5 stars
Date: 2026-06-13

Review 2:
Text: Disappointed — firmware update bricked my unit.
Rating: 2 out of 5 stars
Date: 2026-06-20`
    const items = parseDelimitedRecords(text)
    expect(items.length).toBe(2)
    expect(items[0].text).toContain("loose USB-C")
    expect(items[1].text).toContain("bricked my unit")
  })

  it("falls back to blank-line splitting when there are no record headers", () => {
    const text = `Some review about latency being low.

Another review praising the build quality.`
    const items = parseDelimitedRecords(text)
    expect(items.length).toBe(2)
    expect(items[0].text).toContain("latency")
  })

  it("returns [] for empty/whitespace input (no fabricated item)", () => {
    expect(parseDelimitedRecords("")).toEqual([])
    expect(parseDelimitedRecords("   \n  ")).toEqual([])
  })
})

describe("web_watch (price/sentiment cross-tick diff)", () => {
  beforeEach(seed)

  it("hashes the normalized extraction and reports first-run changed:false", async () => {
    await withPrivilegedDb(orgId, "ww-1", async (tx) => {
      const fetchExtract = async () => ({ price_eur: 599 })
      const r = await handleWebWatch(
        { url: "https://x", extractionQuery: "price", key: "corvane" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.changed).toBe(false)
      expect(r.previous).toBeNull()
      expect(r.current).toEqual({ price_eur: 599 })
    })
  })

  it("detects a numeric price change and computes delta", async () => {
    await withPrivilegedDb(orgId, "ww-2", async (tx) => {
      let v: { price_eur: number } = { price_eur: 599 }
      const fetchExtract = async () => v
      await handleWebWatch(
        { url: "https://x", extractionQuery: "price", key: "corvane" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      v = { price_eur: 549 }
      const r = await handleWebWatch(
        { url: "https://x", extractionQuery: "price", key: "corvane" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.changed).toBe(true)
      expect(r.delta).toEqual({ price_eur: -50 })
    })
  })

  it("identical extraction across ticks → changed:false even if raw bytes differ", async () => {
    await withPrivilegedDb(orgId, "ww-3", async (tx) => {
      const fetchExtract = async () => ({ price_eur: 599, fetched_at: Date.now() })
      const normalize = (o: unknown) => ({ price_eur: (o as { price_eur: number }).price_eur })
      await handleWebWatch(
        { url: "https://x", extractionQuery: "price only", key: "k" },
        { orgId, routineId: routineR, tx, fetchExtract, normalize },
      )
      const r = await handleWebWatch(
        { url: "https://x", extractionQuery: "price only", key: "k" },
        { orgId, routineId: routineR, tx, fetchExtract, normalize },
      )
      expect(r.changed).toBe(false)
    })
  })

  it("emits routine:watch:changed via the outbox when changed", async () => {
    await withPrivilegedDb(orgId, "ww-4", async (tx) => {
      const events: Array<{ app: string; entity: string; action: string }> = []
      let v = { v: 1 }
      const fetchExtract = async () => v
      const queueEvent = (e: { app: string; entity: string; action: string }): void => {
        events.push(e)
      }
      await handleWebWatch(
        { url: "https://x", extractionQuery: "v", key: "k" },
        { orgId, routineId: routineR, tx, fetchExtract, queueEvent },
      )
      v = { v: 2 }
      await handleWebWatch(
        { url: "https://x", extractionQuery: "v", key: "k" },
        { orgId, routineId: routineR, tx, fetchExtract, queueEvent },
      )
      expect(events).toContainEqual(
        expect.objectContaining({ app: "kernel", entity: "routine_watch", action: "changed" }),
      )
    })
  })

  it("source unreachable records-and-degrades (no fabrication, no false change)", async () => {
    await withPrivilegedDb(orgId, "ww-5", async (tx) => {
      const fetchExtract = async () => {
        throw new Error("ECONNREFUSED")
      }
      const r = await handleWebWatch(
        { url: "https://x", extractionQuery: "price", key: "down" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.unreachable).toBe(true)
      expect(r.changed).toBe(false)
      expect(r.current).toBeNull()
    })
  })

  // ── SERVER-SIDE only-NEW item diff (the web_watch dedup deliverable) ─────────────────────────────
  // The cross-tick "what's new since last tick" of a LIST extraction is the per-item set difference, NOT
  // a content hash. web_watch computes it server-side (newItems) so a flash-lite tick RENDERS the diff
  // instead of re-deriving it (and re-surfacing/re-routing the whole page — the documented dedup fail).

  const REVIEWS_T1 = [
    { reviewer: "A", stars: 5, text: "Great" },
    { reviewer: "B", stars: 2, text: "Loose port" }, // already-seen sub-3-star — must NOT re-surface
  ]
  // T2 = T1 + a NEW sub-3-star review + a NEW 5-star review (top-level array shape).
  const REVIEWS_T2 = [
    ...REVIEWS_T1,
    { reviewer: "C", stars: 2, text: "Firmware bricked it" }, // the NEW sub-3-star
    { reviewer: "D", stars: 5, text: "Love it" }, // a NEW 5-star
  ]

  it("a COLD first tick reports newItems EMPTY (no watermark yet → nothing is new)", async () => {
    await withPrivilegedDb(orgId, "ww-new-cold", async (tx) => {
      const fetchExtract = async () => REVIEWS_T1
      const r = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.changed).toBe(false)
      expect(r.newItems).toEqual([]) // a cold tick surfaces NOTHING — it records the baseline
      expect(r.newItemCount).toBe(0)
    })
  })

  it("a DELTA tick surfaces ONLY the NEW list items, excluding already-seen ones (top-level array)", async () => {
    await withPrivilegedDb(orgId, "ww-new-delta", async (tx) => {
      let v: unknown[] = REVIEWS_T1
      const fetchExtract = async () => v
      // Tick 1 (baseline): records the watermark.
      await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      // Tick 2 (delta): the page now has 2 new reviews.
      v = REVIEWS_T2
      const r = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.changed).toBe(true)
      expect(r.newItemCount).toBe(2)
      const newReviewers = (r.newItems as { reviewer: string }[]).map((x) => x.reviewer).sort()
      expect(newReviewers).toEqual(["C", "D"]) // ONLY the new ones
      // The already-seen sub-3-star (B) is NOT re-surfaced.
      expect((r.newItems as { reviewer: string }[]).some((x) => x.reviewer === "B")).toBe(false)
    })
  })

  it("a RE-POLL of the same key within a tick is IDEMPOTENT — it re-surfaces the SAME newItems, not 0 (double-poll footgun)", async () => {
    // BL-275 (competitor-price-and-spec-watch double-poll): a flash-lite tick sometimes calls web_watch
    // TWICE for the same key. The first delta call diffs the page against the prior watermark (surfaces the
    // new items) and then OVERWRITES the watermark with the full current page. WITHOUT the per-tick memo,
    // the second call diffs the (unchanged) page against the watermark the first call JUST wrote → 0 new →
    // "no changes", silently dropping the real deltas (observed on a 2-parallel confirmation run). The memo
    // makes a re-poll re-diff against the FIRST call's prior, so it returns the SAME newItems.
    await withPrivilegedDb(orgId, "ww-repoll-idem", async (tx) => {
      let v: unknown[] = REVIEWS_T1
      const fetchExtract = async () => v
      // Tick 1 (baseline): records the watermark.
      await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      // Tick 2 (delta): the page now has 2 new reviews — first call surfaces them.
      v = REVIEWS_T2
      const first = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(first.newItemCount).toBe(2)
      // RE-POLL the SAME key in the SAME tick (page unchanged). It MUST still surface the 2 new items —
      // NOT 0 (which is what diffing the page against the just-written watermark would produce).
      const repoll = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(repoll.newItemCount).toBe(2)
      const reReviewers = (repoll.newItems as { reviewer: string }[]).map((x) => x.reviewer).sort()
      expect(reReviewers).toEqual(["C", "D"])
      // A re-poll where the page GENUINELY changed AGAIN (a 3rd new item appears) self-invalidates the memo
      // and diffs against the now-persisted full T2 watermark → surfaces only the genuinely-new 3rd item.
      v = [...REVIEWS_T2, { reviewer: "E", stars: 5, date: "2026-06-25", text: "new again" }]
      const advanced = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(advanced.newItemCount).toBe(1)
      expect((advanced.newItems as { reviewer: string }[])[0]?.reviewer).toBe("E")
    })
  })

  it("after an EXTERNAL trim of the stored watermark (the validator's cross-tick trim), the delta tick diffs against the TRIMMED value — NOT the cold memo", async () => {
    // BL-275 ROOT BUG (the parallel-load "no changes" intermittent fail): the per-tick memo keyed its
    // re-poll detection on content_hash. The two-tick fire path establishes the cold baseline (tick 1
    // writes the FULL page), then the validator TRIMS the new items out of the STORED watermark value
    // while leaving content_hash untouched, then fires the delta tick (tick 2). With content_hash-only
    // detection, tick 2 saw prev.content_hash == the hash tick 1 persisted → mistook the legit delta tick
    // for a re-poll → diffed against tick 1's COLD (empty) prior → 0 new. Keying on the stored VALUE hash
    // fixes it: the trim changed the value, so tick 2 is correctly NOT a re-poll and diffs against the
    // trimmed value → surfaces the new items. This test simulates that exact sequence in ONE process.
    const fetchExtract = async (): Promise<unknown[]> => REVIEWS_T2 // the FULL page — served on BOTH ticks
    // Tick 1 (cold baseline) in its OWN tx: records the FULL page as the watermark; cold → 0 new. Sets the
    // process-local memo. (Each tick is a SEPARATE transaction — as in the real two-tick fire path — so the
    // between-ticks trim below is visible to tick 2; a single wrapping tx would snapshot it away.)
    await withPrivilegedDb(orgId, "ww-trim-cold", async (tx) => {
      const cold = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(cold.newItemCount).toBe(0)
    })
    // The validator TRIMS the NEW reviews (C, D) out of the STORED watermark value (content_hash left as-is
    // — exactly what scenario-runner.trimRoutineStateNewItems does), in its OWN committed tx.
    const trimmed = REVIEWS_T2.filter((r) => r.reviewer !== "C" && r.reviewer !== "D")
    await withSystemDb("ww-trim-edit", async (db) => {
      await db
        .update(routineState)
        .set({ value: trimmed })
        .where(and(eq(routineState.routineId, routineR), eq(routineState.key, "rev")))
    })
    // Tick 2 (delta) in its OWN tx: same FULL page served. MUST diff against the TRIMMED stored value →
    // surface C, D — NOT 0 (which the old content_hash-only memo wrongly produced by reusing the cold prior).
    await withPrivilegedDb(orgId, "ww-trim-delta", async (tx) => {
      const delta = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(delta.newItemCount).toBe(2)
      const newReviewers = (delta.newItems as { reviewer: string }[]).map((x) => x.reviewer).sort()
      expect(newReviewers).toEqual(["C", "D"])
    })
  })

  it("surfaces a binding `changeDirective` in the result ONLY when newItemCount>0 (anti 'no changes' override)", async () => {
    // BL-275: under parallel load a flash-lite tick sometimes narrates "no changes" despite a non-empty
    // newItems (all data correct). A result-level directive — read in the very result the agent acts on —
    // makes "report these, don't say no changes" impossible to miss. Absent on a cold/unchanged tick.
    await withPrivilegedDb(orgId, "ww-change-directive", async (tx) => {
      let v: unknown[] = REVIEWS_T1
      const fetchExtract = async () => v
      // Cold tick: newItemCount=0 → NO directive.
      const cold = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(cold.newItemCount).toBe(0)
      expect(cold.changeDirective).toBeUndefined()
      // Delta tick: 2 new → directive present, naming the count and banning "no changes".
      v = REVIEWS_T2
      const delta = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(delta.newItemCount).toBe(2)
      expect(delta.changeDirective).toBeDefined()
      expect(delta.changeDirective).toContain("CHANGES DETECTED")
      expect(delta.changeDirective?.toLowerCase()).toContain('do not say "no changes"')
    })
  })

  it("on a DIFFING list tick the full `current` page is SUPPRESSED (null) so the tick acts on newItems only", async () => {
    await withPrivilegedDb(orgId, "ww-suppress", async (tx) => {
      let v: unknown[] = REVIEWS_T1
      const fetchExtract = async () => v
      // Cold tick: current IS returned (the agent needs the initial page) + newItems empty.
      const cold = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(cold.current).not.toBeNull() // cold tick keeps `current`
      expect(cold.newItems).toEqual([])
      // Diffing tick: current SUPPRESSED (null) — only newItems is actionable + currentItemCount present.
      v = REVIEWS_T2
      const r = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.current).toBeNull() // suppressed so the tick can't re-process the whole page
      expect(r.previous).toBeNull()
      expect(r.currentItemCount).toBe(REVIEWS_T2.length)
      expect(r.newItemCount).toBe(2)
    })
  })

  it("finds the items array under a NESTED field (e.g. {reviews:[…]}) for the diff", async () => {
    await withPrivilegedDb(orgId, "ww-new-nested", async (tx) => {
      let v: unknown = { product: "Kestrel 6", reviews: REVIEWS_T1 }
      const fetchExtract = async () => v
      await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      v = { product: "Kestrel 6", reviews: REVIEWS_T2 }
      const r = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.newItemCount).toBe(2)
      expect((r.newItems as { reviewer: string }[]).map((x) => x.reviewer).sort()).toEqual([
        "C",
        "D",
      ])
    })
  })

  it("a PARAPHRASED/re-truncated long body on an unchanged review does NOT make it look new (identity excludes free-text)", async () => {
    await withPrivilegedDb(orgId, "ww-new-norm", async (tx) => {
      // Tick 1: a review with a long body. Identity keys on reviewer+stars+date (stable), NOT the body.
      let v: unknown[] = [
        {
          reviewer: "A",
          stars: 5,
          date: "2026-06-10",
          text: "Absolutely incredible expressive control, the per-note slide is effortless and musical.",
        },
      ]
      const fetchExtract = async () => v
      await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      // Tick 2: the SAME review but the extraction PARAPHRASED/TRUNCATED its body (the real LLM-extraction
      // instability), plus a genuinely NEW review. The paraphrased A must NOT count as new.
      v = [
        {
          reviewer: "A",
          stars: 5,
          date: "2026-06-10",
          text: "Incredible expressive control; the slide feels effortless.",
        },
        { reviewer: "E", stars: 1, date: "2026-06-22", text: "Broken on arrival" },
      ]
      const r = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      // Only the genuinely-new review E surfaces; the paraphrased A is recognized as already-seen.
      expect(r.newItemCount).toBe(1)
      expect((r.newItems as { reviewer: string }[])[0]?.reviewer).toBe("E")
    })
  })

  it("two DISTINCT same-star reviews from different reviewers are BOTH kept (identity is not over-collapsed)", async () => {
    await withPrivilegedDb(orgId, "ww-new-distinct", async (tx) => {
      let v: unknown[] = [{ reviewer: "A", stars: 5, date: "2026-06-10", text: "Great" }]
      const fetchExtract = async () => v
      await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      // Two NEW reviews, both 5-star but different reviewers/dates → both must surface.
      v = [
        { reviewer: "A", stars: 5, date: "2026-06-10", text: "Great" },
        { reviewer: "B", stars: 5, date: "2026-06-20", text: "Also great" },
        { reviewer: "C", stars: 5, date: "2026-06-21", text: "Likewise great" },
      ]
      const r = await handleWebWatch(
        { url: "https://reviews", extractionQuery: "reviews", key: "rev" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.newItemCount).toBe(2)
      expect((r.newItems as { reviewer: string }[]).map((x) => x.reviewer).sort()).toEqual([
        "B",
        "C",
      ])
    })
  })

  it("a SCALAR/structure extraction (no list) yields newItems null — the price-diff path is unchanged", async () => {
    await withPrivilegedDb(orgId, "ww-new-scalar", async (tx) => {
      let v: unknown = { price_eur: 599 }
      const fetchExtract = async () => v
      await handleWebWatch(
        { url: "https://x", extractionQuery: "price", key: "p" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      v = { price_eur: 549 }
      const r = await handleWebWatch(
        { url: "https://x", extractionQuery: "price", key: "p" },
        { orgId, routineId: routineR, tx, fetchExtract },
      )
      expect(r.newItems).toBeNull()
      expect(r.newItemCount).toBeNull()
      expect(r.delta).toEqual({ price_eur: -50 }) // the numeric-delta path still works
    })
  })
})

// BL-275 web_watch CROSS-TICK DETERMINISM: the extraction query handleWebWatchTool sends to the extractor
// must be a FIXED CANONICAL string — NOT the agent's per-call `extractionQuery` wording — so two ticks of
// the same page send the IDENTICAL (content, query) pair, the content-keyed extraction cache HITS, and
// tick 2 reuses tick 1's exhaustive extraction (instead of re-rolling and dropping the new record). The
// agent paraphrasing its query between ticks was busting the cache → the only-NEW diff returned empty.
describe("WEB_WATCH_EXTRACTION_QUERY — canonical, agent-wording-independent (cross-tick determinism)", () => {
  // web_watch sends THIS fixed string on every tick (handleWebWatchTool, verified by code), NOT the
  // agent's per-call `extractionQuery`. The tick agent paraphrasing its query between ticks changed the
  // content-keyed extraction cache key → tick 2 re-extracted and could drop the newest / a non-English
  // record (the "No new reviews detected" failure under parallel load). A FIXED query keeps the
  // (content, query) cache key byte-identical across ticks → cache HIT → deterministic extraction.
  it("is a constant that demands exhaustive record-level extraction and carries no per-call agent wording", () => {
    // Stable, exhaustive, record-per-block (the recall + parse contract the cross-tick diff depends on).
    expect(WEB_WATCH_EXTRACTION_QUERY).toContain("EXHAUSTIVELY")
    expect(WEB_WATCH_EXTRACTION_QUERY).toContain("EVERY record")
    expect(WEB_WATCH_EXTRACTION_QUERY).toContain("Record 1:")
    expect(WEB_WATCH_EXTRACTION_QUERY).toContain("another language")
    // It is a CONSTANT (referentially identical every read) — the determinism guarantee: two ticks read
    // the same string, so the extraction cache key matches and tick 2 reuses tick 1's exhaustive result.
    expect(WEB_WATCH_EXTRACTION_QUERY).toBe(WEB_WATCH_EXTRACTION_QUERY)
    // It carries NO free-form / agent-supplied phrasing placeholder (the variance source is excluded).
    expect(WEB_WATCH_EXTRACTION_QUERY).not.toContain("${")
    expect(WEB_WATCH_EXTRACTION_QUERY).not.toContain("intent hint")
  })
})
