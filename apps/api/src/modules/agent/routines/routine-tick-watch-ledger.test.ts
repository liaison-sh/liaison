// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression tests for the routine OUTPUT-COMPLETENESS GUARD (BL-275,
// competitor-price-and-spec-watch). The guard's job: a routine tick must not
// OMIT a tool-confirmed web_watch change from its posted prose. Under 2-parallel
// load a flash-lite tick variably reports only a SUBSET of the tool-confirmed
// changes; the guard records each web_watch call's `newItems` and, after the
// post, detects when a source's changes are absent from the prose and re-prompts.
//
// FAILS-WITHOUT / PASSES-WITH framing: an omitting post (a post that drops one of
// two tool-confirmed sources) must be detected as omitted (the guard fires); a
// complete post that reflects both sources must be detected as complete (the
// guard is inert — no needless re-prompt).

import { afterEach, describe, expect, it } from "bun:test"
import {
  beginWatchLedger,
  buildCompletenessReprompt,
  buildDocDedupFabricationReprompt,
  buildExecutionSkipReprompt,
  drainWatchLedger,
  drainWatchLedgerFull,
  findOmittedSources,
  itemSalientTokens,
  promptUsesWebWatch,
  recordFetchCall,
  recordWatchCall,
  recordWatchChange,
  type WatchLedgerEntry,
} from "~/modules/agent/routines/routine-tick-watch-ledger"

// The two real tool-confirmed changes the competitor-watch tick must surface:
// a Corvane price change + a brand-new Pressfield SKU. Shaped like the parsed web_watch
// items (the per-record objects the cross-tick diff keys on).
const corvanePriceChange: WatchLedgerEntry = {
  key: "competitor-corvane",
  url: "https://example.test/corvane/prices",
  newItems: [{ product: "Corvane Tideboard CREST 2", price: "$1399", sku: "CORVANE-CREST2" }],
  newItemCount: 1,
}
const pressfieldNewSku: WatchLedgerEntry = {
  key: "competitor-pressfield",
  url: "https://example.test/pressfield/products",
  newItems: [{ product: "Pressfield Flux 2", sku: "PRESSFIELD-FLUX2", price: "$349" }],
  newItemCount: 1,
}

describe("routine completeness guard — findOmittedSources (BL-275 parallel-load prose omission)", () => {
  it("FAILS-WITHOUT: a post that DROPS the Corvane price change is detected as omitted", () => {
    // The tick reported ONLY the new Pressfield SKU and declared nothing else changed — the exact
    // parallel-load failure: a tool-confirmed source absent from the prose.
    const omittingPost =
      "Changes detected this week: new SKU Pressfield Flux 2 (PRESSFIELD-FLUX2) at $349. " +
      "No other changes — all other competitors remain current."
    const omitted = findOmittedSources([corvanePriceChange, pressfieldNewSku], omittingPost)
    expect(omitted.map((o) => o.key)).toEqual(["competitor-corvane"])
  })

  it("PASSES-WITH: a post that reports BOTH tool-confirmed changes is complete (guard inert)", () => {
    const completePost =
      "What changed this week:\n" +
      "- Corvane Tideboard CREST 2 price changed to $1399 (sku CORVANE-CREST2).\n" +
      "- New SKU: Pressfield Flux 2 (PRESSFIELD-FLUX2) listed at $349.\n" +
      "All other watched competitors are unchanged."
    const omitted = findOmittedSources([corvanePriceChange, pressfieldNewSku], completePost)
    expect(omitted).toEqual([])
  })

  it("detects BOTH sources omitted when the post declares 'no changes' despite confirmed changes", () => {
    const denialPost = "No price or SKU changes detected this week across the watched competitors."
    const omitted = findOmittedSources([corvanePriceChange, pressfieldNewSku], denialPost)
    expect(omitted.map((o) => o.key).sort()).toEqual([
      "competitor-corvane",
      "competitor-pressfield",
    ])
  })

  it("tolerates paraphrase of ONE field — a post that abbreviates is still recognized as complete", () => {
    // "$1399" rendered as "1399" / model name abbreviated, but the SKU + the other source are present.
    const paraphrased =
      "Corvane CREST2 repriced to 1399 dollars. New Pressfield listing PRESSFIELD-FLUX2 (Flux 2, $349)."
    const omitted = findOmittedSources([corvanePriceChange, pressfieldNewSku], paraphrased)
    expect(omitted).toEqual([])
  })
})

describe("routine completeness guard — ledger lifecycle (record / drain / idempotency)", () => {
  const RID = "00000000-0000-0000-0000-0000000000aa"
  afterEach(() => {
    // Clear any state so tests don't leak into one another.
    drainWatchLedger(RID)
  })

  it("records sources with newItemCount>0 and drains them once (drain clears)", () => {
    beginWatchLedger(RID)
    recordWatchChange(RID, corvanePriceChange)
    recordWatchChange(RID, pressfieldNewSku)
    const drained = drainWatchLedger(RID)
    expect(drained.map((e) => e.key).sort()).toEqual([
      "competitor-corvane",
      "competitor-pressfield",
    ])
    // Second drain is empty — drain clears.
    expect(drainWatchLedger(RID)).toEqual([])
  })

  it("does NOT record a newItemCount=0 source (an unchanged source is never enforced)", () => {
    beginWatchLedger(RID)
    recordWatchChange(RID, { key: "unchanged", url: "u", newItems: [], newItemCount: 0 })
    expect(drainWatchLedger(RID)).toEqual([])
  })

  it("a same-tick RE-POLL of the SAME key REPLACES (never double-counts) the entry", () => {
    beginWatchLedger(RID)
    recordWatchChange(RID, corvanePriceChange)
    // Re-poll of the same key returns the same newItems (idempotency cache) — record again.
    recordWatchChange(RID, corvanePriceChange)
    const drained = drainWatchLedger(RID)
    expect(drained.filter((e) => e.key === "competitor-corvane")).toHaveLength(1)
  })

  it("beginWatchLedger clears a stale entry from a prior tick of the same routine", () => {
    recordWatchChange(RID, corvanePriceChange)
    beginWatchLedger(RID) // start of a NEW tick — prior tick's record must be gone
    expect(drainWatchLedger(RID)).toEqual([])
  })
})

describe("routine completeness guard — EXECUTION-SKIP detection (web_watch call count)", () => {
  const RID = "00000000-0000-0000-0000-0000000000bb"
  afterEach(() => {
    drainWatchLedgerFull(RID)
  })

  it("FAILS-WITHOUT a call: a watch tick that made ZERO web_watch calls is detected (calls===0)", () => {
    beginWatchLedger(RID)
    // No recordWatchCall — the tick never polled (the execution-skip: concluded "no new items" blind).
    const { changes, calls } = drainWatchLedgerFull(RID)
    expect(calls).toBe(0)
    expect(changes).toEqual([])
    // The invoker fires the skip guard for a web_watch routine when calls===0.
    expect(
      promptUsesWebWatch("each tick call web_watch(url, query, key) for each competitor page"),
    ).toBe(true)
  })

  it("PASSES-WITH a call: a tick that polled records calls>0 (skip guard inert)", () => {
    beginWatchLedger(RID)
    recordWatchCall(RID)
    recordWatchCall(RID) // two sources polled
    const { calls } = drainWatchLedgerFull(RID)
    expect(calls).toBe(2)
  })

  it("recordWatchChange also implies the source was polled — counted alongside calls", () => {
    beginWatchLedger(RID)
    recordWatchCall(RID)
    recordWatchChange(RID, corvanePriceChange)
    const { changes, calls } = drainWatchLedgerFull(RID)
    expect(calls).toBe(1)
    expect(changes.map((c) => c.key)).toEqual(["competitor-corvane"])
  })

  it("promptUsesWebWatch is true only for a prompt naming web_watch (scopes the skip guard to watch routines)", () => {
    expect(promptUsesWebWatch("call web_watch over the product pages")).toBe(true)
    expect(promptUsesWebWatch("call web-watch over the pages")).toBe(true)
    expect(promptUsesWebWatch("summarize the open tickets each morning")).toBe(false)
    expect(promptUsesWebWatch("")).toBe(false)
    expect(promptUsesWebWatch(null)).toBe(false)
  })

  it("buildExecutionSkipReprompt tells the tick to actually CALL web_watch before concluding (no scenario data)", () => {
    const r = buildExecutionSkipReprompt().toLowerCase()
    expect(r).toContain("did not poll")
    expect(r).toContain("web_watch")
    expect(r).toContain("call web_watch")
  })

  // DOC-DEDUP anti-fabrication (BL-275, competitor-firmware-news-watch): a doc-dedup watch tick that wrote
  // "new items" into its running doc with fetchCalls===0 FABRICATED them. recordFetchCall counts real
  // fetches; the guard re-prompts when a doc-dedup tick wrote items but fetched nothing.
  it("FAILS-WITHOUT a fetch: a doc-dedup tick that wrote items with fetchCalls===0 trips the guard", () => {
    beginWatchLedger(RID)
    // No recordFetchCall — the tick never fetched, yet (hypothetically) wrote items.
    const { fetchCalls } = drainWatchLedgerFull(RID)
    expect(fetchCalls).toBe(0)
  })

  it("PASSES-WITH fetches: a tick that fetched its sources records fetchCalls>0 (guard inert)", () => {
    beginWatchLedger(RID)
    recordFetchCall(RID)
    recordFetchCall(RID)
    recordFetchCall(RID) // three sources fetched
    const { fetchCalls } = drainWatchLedgerFull(RID)
    expect(fetchCalls).toBe(3)
  })

  it("recordFetchCall is a no-op for a falsy routineId (interactive-chat fetch is never counted)", () => {
    expect(() => recordFetchCall("")).not.toThrow()
  })

  it("buildDocDedupFabricationReprompt tells the tick to actually web_fetch + remove invented items (no scenario data)", () => {
    const r = buildDocDedupFabricationReprompt().toLowerCase()
    expect(r).toContain("did not fetch")
    expect(r).toContain("web_fetch")
    expect(r).toContain("fabricated")
    expect(r).toContain("invented")
    // GENERIC — names no scenario entity.
    expect(r).not.toContain("ostra")
    expect(r).not.toContain("corvane")
    expect(r).not.toContain("kestrel")
  })
})

describe("routine completeness guard — itemSalientTokens + reprompt are populated from tool ground truth", () => {
  it("itemSalientTokens surfaces the SKU / model / price (short scalars), excludes long free-text", () => {
    const tokens = itemSalientTokens({
      product: "Pressfield Flux 2",
      sku: "PRESSFIELD-FLUX2",
      price: "$349",
      body: "x".repeat(200), // long free-text → paraphrasable → excluded
    })
    expect(tokens).toContain("Pressfield Flux 2")
    expect(tokens).toContain("PRESSFIELD-FLUX2")
    expect(tokens).toContain("$349")
    expect(tokens.some((t) => t.length > 60)).toBe(false)
  })

  it("buildCompletenessReprompt names every omitted source + its exact newItems (no scenario hardcoding)", () => {
    const reprompt = buildCompletenessReprompt([corvanePriceChange])
    expect(reprompt).toContain("competitor-corvane")
    expect(reprompt).toContain("Corvane Tideboard CREST 2")
    expect(reprompt).toContain("$1399")
    // It is an explicit, bounded completeness steer — names the omission + demands every change.
    expect(reprompt.toLowerCase()).toContain("omitted")
    expect(reprompt.toLowerCase()).toContain("every change")
  })
})
