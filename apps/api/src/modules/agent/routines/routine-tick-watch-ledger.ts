// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PER-TICK WEB_WATCH GROUND-TRUTH LEDGER — the data backbone of the routine
// OUTPUT-COMPLETENESS GUARD (BL-275, competitor-price-and-spec-watch).
//
// THE BUG THIS EXISTS FOR. A recurring routine tick that calls `web_watch` and
// receives a non-empty `newItems` (the SERVER-COMPUTED only-NEW set, the tool's
// authoritative cross-tick diff) sometimes still OMITS one of those changes from
// the prose it posts — under 2-parallel CPU load a flash-lite tick variably
// narrates only a SUBSET of the tool-confirmed changes (e.g. it reports the new
// Pressfield SKU but drops the Corvane price change, or vice-versa), even though the
// data pipeline is provably correct every run (web_watch returns both changes,
// the watermark is trimmed, the running doc is updated). The prose-rendering is
// the only residual. The recurring-tick directive + the result-level
// `changeDirective` are ADVISORY (prose the model can still ignore); neither the
// reasoning ladder (medium nor high) closes it under parallel load.
//
// THE GUARD (general, not scenario-coded). The TOOL knows, for each `web_watch`
// call this tick, the exact `newItems` it returned (the ground truth). This
// ledger records every source for which `web_watch` returned `newItemCount > 0`.
// After the tick posts, the invoker DRAINS the ledger and checks the posted
// prose against the tool-confirmed changes; if a confirmed change is OMITTED, it
// re-prompts the tick ONCE to revise its post so it reports EVERY tool-confirmed
// change. Bounded to one retry; inert when the tick already reported everything.
//
// This is the routine analogue of the l710/l713 "classify server-side, the tick
// RENDERS the discrimination" doctrine: completeness must not depend on the
// cheap model rendering perfectly under load — the worker holds the tool ground
// truth and enforces that the output reflects it.
//
// SCOPING. The ledger is keyed on `routineId` — unique per routine instance
// (each chaos world / each real routine has its own). A routine's ticks are
// serialized by the `routine-lock:<id>` Redis lock, so no two ticks of the SAME
// routine run concurrently; parallel ticks of DIFFERENT routines have DIFFERENT
// routineIds and never collide. The invoker RESETS the ledger at tick start and
// DRAINS it at tick end, so a stale entry from an earlier tick can never leak
// into a later one. Bounded in size; process-local (the same worker that runs
// the tick reads it back — no cross-process need).

import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "routine-tick-watch-ledger" })

/** One source's tool-confirmed changes for a tick (recorded only when newItemCount > 0). */
export interface WatchLedgerEntry {
  /** The `key` the watch diffed under (one stable key per watched URL). */
  key: string
  /** The watched URL. */
  url: string
  /** The SERVER-COMPUTED only-NEW set web_watch returned for this source this tick. */
  newItems: unknown[]
  /** newItems.length (always > 0 for a recorded entry). */
  newItemCount: number
}

interface TickLedger {
  /** Sources with tool-confirmed changes (newItemCount > 0) this tick. */
  changes: WatchLedgerEntry[]
  /** Total web_watch calls this tick (ANY count, incl. 0-new + unreachable) — proves the tick actually
   *  POLLED its sources. A watch routine that posts "no new items" with `calls === 0` never polled (the
   *  execution-skip failure) and is re-prompted to actually call web_watch. */
  calls: number
  /** Total SUCCESSFUL web_fetch calls this tick — proves a DOC-DEDUP watch tick actually FETCHED its
   *  changelog/news/blog sources rather than FABRICATING the "new items" from memory (the competitor-
   *  firmware-news-watch fabrication fail: the tick wrote invented releases — "Ostra 2.x" — into the doc
   *  without ever fetching the real pages). A doc-dedup tick that appended new items with `fetchCalls === 0`
   *  fabricated → re-prompted once to actually web_fetch the sources. */
  fetchCalls: number
}

const ledger = new Map<string, TickLedger>()
const LEDGER_CAP = 2000

function getOrInit(routineId: string): TickLedger {
  let l = ledger.get(routineId)
  if (!l) {
    if (ledger.size >= LEDGER_CAP) {
      const oldest = ledger.keys().next().value
      if (oldest !== undefined) ledger.delete(oldest)
    }
    l = { changes: [], calls: 0, fetchCalls: 0 }
    ledger.set(routineId, l)
  }
  return l
}

/**
 * Reset the ledger for a routine at tick start. Clears any stale entry from a
 * prior tick of the same routine so a later tick's completeness check sees ONLY
 * this tick's tool-confirmed changes + call count. Idempotent.
 */
export function beginWatchLedger(routineId: string): void {
  ledger.delete(routineId)
}

/** Record that web_watch was CALLED this tick (any result — incl. 0-new / unreachable). Proves the tick
 *  polled. No-op when routineId is falsy. */
export function recordWatchCall(routineId: string): void {
  if (!routineId) return
  getOrInit(routineId).calls += 1
}

/** Record a SUCCESSFUL web_fetch this tick (the fetch returned real content). Proves a DOC-DEDUP watch tick
 *  actually fetched its sources rather than fabricating items from memory. No-op when routineId is falsy. */
export function recordFetchCall(routineId: string): void {
  if (!routineId) return
  getOrInit(routineId).fetchCalls += 1
}

/**
 * Record a source's tool-confirmed changes for the current tick. Called by the
 * `web_watch` tool ONLY when it returned `newItemCount > 0` (a real change). If
 * the same key is recorded twice in a tick (a re-poll — the idempotency cache
 * returns the SAME newItems), the latest record REPLACES the prior one for that
 * key, so a re-poll does not double-count. No-op when `routineId` is falsy.
 */
export function recordWatchChange(routineId: string, entry: WatchLedgerEntry): void {
  if (!routineId || entry.newItemCount <= 0) return
  const l = getOrInit(routineId)
  // Replace any prior record for the SAME key (re-poll idempotency) — never duplicate a source.
  l.changes = l.changes.filter((e) => e.key !== entry.key)
  l.changes.push(entry)
}

/**
 * Drain (read + clear) the tick's tool-confirmed changes for a routine. Returns
 * the recorded entries (empty array when the tick had no `newItemCount > 0`
 * sources — the guard is then inert). Clearing on drain guarantees the next tick
 * of the same routine starts clean even if `beginWatchLedger` is somehow skipped.
 */
export function drainWatchLedger(routineId: string): WatchLedgerEntry[] {
  const l = ledger.get(routineId)
  ledger.delete(routineId)
  return l?.changes ?? []
}

/**
 * Drain (read + clear) BOTH the tick's tool-confirmed changes AND the web_watch call count. Used by the
 * invoker to enforce TWO invariants on a watch tick: (1) it must POLL — `calls === 0` for a routine whose
 * prompt names web_watch is an execution-skip; (2) it must not OMIT a confirmed change from its prose.
 */
export function drainWatchLedgerFull(routineId: string): {
  changes: WatchLedgerEntry[]
  calls: number
  fetchCalls: number
} {
  const l = ledger.get(routineId)
  ledger.delete(routineId)
  return { changes: l?.changes ?? [], calls: l?.calls ?? 0, fetchCalls: l?.fetchCalls ?? 0 }
}

/**
 * Stable, low-entropy identity TOKENS for one tool-confirmed change item — the
 * SHORT scalar fields (SKU, model name, price, reviewer, date, rating, title)
 * that MUST appear in the tick's prose if the change was reported. Mirrors the
 * web_watch `itemIdentity` philosophy (short scalars are stable signal; long
 * free-text bodies are paraphrasable and excluded). Returned as an array of the
 * individual token strings so the coverage check can require the SALIENT ones to
 * be present in the post (not a single brittle concatenation).
 */
export function itemSalientTokens(item: unknown): string[] {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    const s = String(item).trim()
    return s ? [s] : []
  }
  const obj = item as Record<string, unknown>
  const tokens: string[] = []
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === "number" || typeof v === "boolean") {
      tokens.push(String(v))
    } else if (typeof v === "string") {
      const t = v.trim()
      // Short, content-bearing scalars (a SKU, a model name, a price, a date,
      // a rating) — the salient identity. Skip long free-text bodies (> 60
      // chars) the model legitimately paraphrases, and trivially-short noise.
      if (t.length >= 2 && t.length <= 60) tokens.push(t)
    }
  }
  return tokens
}

/** Normalize text for substring matching: lowercase + collapse whitespace, and DROP currency/quote/comma
 *  punctuation that the post legitimately reformats ("$1,399" → "1399", "CREST 2" → "crest2"). Keeps letters
 *  + digits so a token like "corvanecrest2" still matches a post that writes "Corvane CREST2". This is the
 *  paraphrase-tolerant comparison surface — it must recognize an ABBREVIATED reference while still treating
 *  an ENTIRELY ABSENT source (zero tokens present) as omitted. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[$€£¥,]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim()
}

/**
 * Which recorded sources are OMITTED from the posted prose. A source counts as
 * REPORTED when at least ONE of its new items is RECOGNIZABLY present — i.e. at
 * least one of that item's salient tokens (its SKU, model name, price, date)
 * appears in the post's normalized text. A source whose every confirmed change
 * is ENTIRELY ABSENT from the post (zero salient tokens found) is OMITTED and
 * triggers the one-shot completeness re-prompt.
 *
 * Why "≥1 salient token present per source" rather than "every token of every
 * item": the post legitimately paraphrases — it may abbreviate a long model name
 * ("Corvane Tideboard CREST 2" → "Corvane CREST2"), reformat a price ("$1,399" → "1399
 * dollars"), or restate one field — so requiring full literal coverage would
 * FALSE-POSITIVE on a complete-but-paraphrased post (a needless re-prompt). The
 * ACTUAL failure this guards against is a source dropped WHOLESALE (the
 * parallel-load omission: an entire competitor's change absent from the prose),
 * which shows as ZERO of the source's salient tokens appearing. The normalized
 * comparison (currency/punctuation-stripped, alnum-only) makes an abbreviated
 * reference still match while a truly-absent source still reads as omitted.
 */
export function findOmittedSources(
  entries: WatchLedgerEntry[],
  postedText: string,
): WatchLedgerEntry[] {
  const hay = norm(postedText)
  const omitted: WatchLedgerEntry[] = []
  for (const entry of entries) {
    let anyTokenPresent = false
    for (const item of entry.newItems) {
      const tokens = itemSalientTokens(item)
        .map(norm)
        .filter((t) => t.length >= 3) // ≥3 normalized alnum chars → meaningful identity, not noise
      if (tokens.some((t) => hay.includes(t))) {
        anyTokenPresent = true
        break
      }
    }
    if (!anyTokenPresent) {
      omitted.push(entry)
      log.info(
        { key: entry.key, url: entry.url, newItemCount: entry.newItemCount },
        "routine completeness guard: source's tool-confirmed changes OMITTED from posted prose",
      )
    }
  }
  return omitted
}

/** True when the routine PROMPT names the web_watch tool — i.e. its load-bearing deliverable is a
 *  web_watch poll. Used to scope the execution-skip guard to watch routines only (a non-watch routine
 *  legitimately makes zero web_watch calls). Matches the tool token in any common spelling. */
export function promptUsesWebWatch(prompt: string | null | undefined): boolean {
  if (!prompt) return false
  return /\bweb[_\s-]?watch\b/i.test(prompt)
}

/**
 * Build the one-shot EXECUTION-SKIP re-prompt for a watch tick that posted a result WITHOUT calling
 * web_watch at all (the watermark proves no poll happened). Deterministic + bounded (one retry). It does
 * NOT name any data/source the tick lacks — it only tells the tick to actually CALL the tool its own
 * prompt specifies before concluding anything. GENERAL (no scenario specifics).
 */
export function buildExecutionSkipReprompt(): string {
  return (
    `[YOU DID NOT POLL — your routine's prompt watches external sources via web_watch, but this tick made ` +
    `ZERO web_watch calls and yet concluded a result. A watch tick MUST call web_watch (exactly once per ` +
    `source key) to obtain this tick's cross-tick diff BEFORE it can report what changed — you cannot ` +
    `conclude "no new items" / "no changes" for a source you never polled. Call web_watch now for EACH ` +
    `source the prompt names, then fold every returned newItems into the running doc's "what changed" ` +
    `section and post the corrected result. A tick that narrates a conclusion without calling web_watch ` +
    `is a FAILED tick.]`
  )
}

/**
 * Build the one-shot DOC-DEDUP anti-fabrication RE-PROMPT (competitor-firmware-news-watch). The tick wrote
 * "new items" into the running watch doc but made ZERO web_fetch calls this tick — so those items were
 * FABRICATED from memory, not read from the real sources. Steer the tick to actually fetch each source and
 * re-derive the new items from the fetched content (correcting the doc). GENERAL: names no scenario entity.
 */
export function buildDocDedupFabricationReprompt(): string {
  return (
    `[YOU DID NOT FETCH — your routine appends only the NEW items from each external changelog/news/blog ` +
    `source, but this tick made ZERO web_fetch calls and yet wrote "new" items into the running doc. Items ` +
    `you did not FETCH are FABRICATED — you cannot record a release you never read from its source page. ` +
    `web_fetch EACH source URL the prompt names NOW, build the list of dated items from the FETCHED ` +
    `content, dedup it against the prior doc body, and CORRECT the running doc so it records EXACTLY the ` +
    `real new items from the fetched pages (remove any item you invented). Then file the roadmap-overlap ` +
    `task only for a real new release that overlaps. A tick that writes items it never fetched is a FAILED ` +
    `tick.]`
  )
}

/**
 * Build the one-shot completeness RE-PROMPT naming the omitted sources and the
 * exact `newItems` web_watch returned for each — a deterministic, bounded steer
 * (one retry) that makes the tool ground truth impossible to drop. GENERAL: it
 * is populated entirely from the tool result (no scenario specifics hardcoded).
 */
export function buildCompletenessReprompt(omitted: WatchLedgerEntry[]): string {
  const lines = omitted.map((e) => {
    const items = e.newItems
      .map((it) => {
        if (it !== null && typeof it === "object" && !Array.isArray(it)) {
          const obj = it as Record<string, unknown>
          return Object.entries(obj)
            .filter(([, v]) => v != null && String(v).trim().length > 0)
            .map(([k, v]) => `${k}: ${String(v).trim()}`)
            .join(", ")
        }
        return String(it)
      })
      .map((s) => `    - ${s}`)
      .join("\n")
    return `  • source key="${e.key}" (${e.url}) — web_watch returned ${e.newItemCount} NEW item(s):\n${items}`
  })
  return (
    `[COMPLETENESS CHECK — YOUR POST OMITTED TOOL-CONFIRMED CHANGES. web_watch's diff this tick is the ` +
    `authoritative ground truth, and your posted message did NOT report the change(s) below. You MUST ` +
    `report EVERY change web_watch returned this tick — omitting any is a FAILED tick. Revise/extend the ` +
    `running doc's "what changed" section so it includes ALL of these changes (in addition to any you ` +
    `already reported), then post the corrected result. Do not drop, summarize-away, or defer any:\n` +
    `${lines.join("\n")}\n` +
    `Report each of the above as a change for its source now.]`
  )
}
