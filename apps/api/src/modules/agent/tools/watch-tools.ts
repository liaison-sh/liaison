// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Market-intelligence routine tools. `watch_state` is a routine-scoped
// get-or-set over kernel.routine_state; `web_watch` fetches+extracts a page,
// hashes the NORMALIZED extraction (not raw HTML), diffs it against the prior
// tick's value, and emits `routine:watch:changed` on actual change. Both are
// reachable only inside a routine tick (gated at buildToolSet by the run
// frame's routineId); the `if (!ctx.routineId) throw` here is belt-and-braces.

import type { SQL } from "drizzle-orm"
import { sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import {
  recordWatchCall,
  recordWatchChange,
} from "~/modules/agent/routines/routine-tick-watch-ledger"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { handleWebFetch } from "~/modules/agent/tools/web-tools"

const log = rootLogger.child({ module: "watch-tools" })

type Json = unknown

/**
 * The narrow tx surface these handlers use — both `RlsClient` and
 * `PrivilegedDb` (and the test's privileged tx) satisfy it. Avoids forcing a
 * brand on callers that legitimately run privileged (the routine worker).
 */
export interface WatchTx {
  execute: (query: SQL) => Promise<unknown>
  queueEvent: (event: AppEvent) => Promise<void>
}

export interface WatchCtx {
  orgId: string
  routineId?: string
  tx: WatchTx
}

interface PriorRow {
  value: Json
  content_hash: string | null
}

async function readState(
  ctx: WatchCtx,
  key: string,
): Promise<{ value: Json; content_hash: string | null } | null> {
  // schemaRef("kernel") resolves to THIS world's prefixed kernel schema (e.g. chaos_<run>_kernel). The
  // privileged tx (used by the tool adapter for load-robust persistence) does NOT inherit the request
  // connection's chaos search_path, so an unqualified `kernel.routine_state` would resolve to the literal
  // `kernel` schema — SHARED across parallel chaos worlds → cross-world watermark collisions on the
  // (routine_id,key) PK (the 2-parallel-load regression). Qualify with schemaRef so every world writes its
  // OWN routine_state. In prod/unit (SCHEMA_PREFIX unset) schemaRef("kernel") === "kernel" — unchanged.
  const K = sql.raw(schemaRef("kernel"))
  const result = await ctx.tx.execute(sql`
    SELECT value, content_hash FROM ${K}.routine_state
     WHERE routine_id = ${ctx.routineId}::uuid AND org_id = ${ctx.orgId}::uuid AND key = ${key}
     LIMIT 1
  `)
  const rows = extractRows<PriorRow>(result)
  return rows[0] ?? null
}

async function writeState(
  ctx: WatchCtx,
  key: string,
  value: Json,
  contentHash: string | null,
): Promise<void> {
  // schemaRef("kernel") — see readState: qualify with THIS world's prefixed schema so the privileged
  // write lands in the per-world routine_state, not a literal `kernel` shared across parallel worlds.
  const K = sql.raw(schemaRef("kernel"))
  await ctx.tx.execute(sql`
    INSERT INTO ${K}.routine_state (routine_id, org_id, key, value, content_hash, updated_at)
    VALUES (${ctx.routineId}::uuid, ${ctx.orgId}::uuid, ${key}, ${JSON.stringify(value)}::jsonb, ${contentHash}, now())
    ON CONFLICT (routine_id, key)
    DO UPDATE SET value = EXCLUDED.value, content_hash = EXCLUDED.content_hash, updated_at = now()
  `)
}

// --- watch_state (H1) ------------------------------------------------------

export async function handleWatchState(
  p: { key: string; value?: Json },
  ctx: WatchCtx,
): Promise<{ value: Json; previous: Json; changed: boolean }> {
  if (!ctx.routineId) throw new Error("watch_state is only available inside a routine run")
  const prior = await readState(ctx, p.key)
  const previous = prior?.value ?? null
  if (p.value === undefined) {
    // pure read — never mutates
    return { value: previous, previous: null, changed: false }
  }
  const changed = previous !== null && JSON.stringify(previous) !== JSON.stringify(p.value)
  await writeState(ctx, p.key, p.value, null)
  return { value: p.value, previous, changed }
}

// --- web_watch (H2) --------------------------------------------------------

/**
 * PER-TICK IDEMPOTENCY CACHE (BL-275, competitor-price-and-spec-watch double-poll footgun).
 *
 * web_watch's cross-tick diff is non-idempotent across a SINGLE tick: the FIRST call for a (routineId,key)
 * diffs the page against the persisted prior watermark and then OVERWRITES that watermark with the full
 * current page. If a flash-lite tick calls web_watch a SECOND time for the SAME key (it does, under
 * variance/parallel load), the second call diffs the (unchanged) page against the watermark the FIRST call
 * just wrote — current == watermark → newItemCount = 0 → "no new changes", silently dropping the real
 * deltas (observed: a 2-parallel confirmation run reported 0-new across all sources after a re-poll).
 *
 * Fix: remember, per (routineId,key), the PRIOR watermark the tick's FIRST web_watch diffed against and the
 * hash it then persisted. On a later call, if the page is unchanged since our own write (current hash ==
 * the hash we persisted), we re-diff against the CACHED prior instead of our just-written watermark — so a
 * re-poll returns the SAME newItems as the first call (idempotent within the tick). The cache is keyed on
 * our last-persisted hash, so it self-invalidates the instant the page genuinely changes or a real NEXT
 * tick runs (its persisted watermark differs), and it is scoped to THIS worker process. Bounded in size.
 */
interface TickWatchMemo {
  /** The prior watermark VALUE the tick's first web_watch for this key diffed against (pre-first-write). */
  priorValue: Json
  /** The prior watermark content_hash (pre-first-write) — preserved so `changed` stays correct on re-poll. */
  priorContentHash: string | null
  /** A stableHash of the VALUE this process LAST persisted for this key. A re-poll is recognized ONLY when
   *  the live stored watermark VALUE still hashes to this — so an EXTERNAL edit of the stored value between
   *  our writes (the validator's cross-tick TRIM, which mutates `value` while leaving `content_hash`
   *  untouched) is NOT mistaken for a re-poll: that trim is the legitimate baseline→delta transition and
   *  MUST diff against the trimmed value, not our cold prior. Keying on the value hash (not content_hash)
   *  is the fix — content_hash alone let a trimmed delta tick wrongly reuse the cold tick's empty diff. */
  persistedValueHash: string
}
const tickWatchMemo = new Map<string, TickWatchMemo>()
const TICK_WATCH_MEMO_CAP = 2000
function memoKey(routineId: string, key: string): string {
  return `${routineId}\u0000${key}`
}

export interface WebWatchCtx extends WatchCtx {
  fetchExtract: (args: { url: string; mode: "extract"; extractionQuery: string }) => Promise<Json>
  normalize?: (raw: Json) => Json
  queueEvent?: (e: {
    app: string
    entity: string
    action: string
    entityId: string
    data: Record<string, unknown>
  }) => void | Promise<void>
}

function stableHash(value: Json): string {
  // Stable JSON stringify (sorted keys) so key-order churn does not flip the
  // hash, then a small non-crypto rolling hash (the diff is structural; a
  // collision merely under-reports a change, never fabricates one).
  const json = stableStringify(value)
  let h = 5381
  for (let i = 0; i < json.length; i++) h = (h * 33) ^ json.charCodeAt(i)
  return (h >>> 0).toString(16)
}

function stableStringify(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`
}

function diffNumeric(prev: Json, current: Json): Record<string, number> | null {
  if (
    prev === null ||
    current === null ||
    typeof prev !== "object" ||
    typeof current !== "object" ||
    Array.isArray(prev) ||
    Array.isArray(current)
  ) {
    return null
  }
  const p = prev as Record<string, unknown>
  const c = current as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const k of Object.keys(c)) {
    if (typeof c[k] === "number" && typeof p[k] === "number") {
      out[k] = (c[k] as number) - (p[k] as number)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function structureDriftDetected(prev: Json, current: Json): boolean {
  if (prev === null || current === null) return false
  if (typeof prev !== "object" || typeof current !== "object") return false
  if (Array.isArray(prev) || Array.isArray(current))
    return Array.isArray(prev) !== Array.isArray(current)
  const a = Object.keys(prev as Record<string, unknown>)
    .sort()
    .join(",")
  const b = Object.keys(current as Record<string, unknown>)
    .sort()
    .join(",")
  return a !== b
}

// --- only-NEW item diff (server-side classification) ------------------------
//
// For a LIST extraction (the common watch shape: a page's reviews / news items /
// prices), "what's new since last tick" is the per-ITEM set difference of the
// current list vs the prior tick's list — NOT a content hash (which only says
// SOMETHING changed) nor a numeric delta. A flash-lite tick that has to re-derive
// that difference from `current` vs `previous` itself does it unreliably (it
// re-summarizes / re-routes the WHOLE page — the documented dedup failure). So we
// compute the NEW items server-side and return them directly, the l710/l713
// "classify server-side, the tick RENDERS the discrimination" doctrine applied to
// web_watch. `newItems` is the authoritative only-NEW list the tick should act on;
// items already seen last tick are excluded.

/** Find the "items array" in an extraction value: the value itself if it's an array,
 *  else the FIRST array-valued field (reviews / items / news / prices / entries …).
 *  Returns null when no list is present (a scalar/structure extraction — no item diff). */
function findItemsArray(value: Json): unknown[] | null {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      if (Array.isArray(v)) return v
    }
  }
  return null
}

/** Normalize a string for stable comparison: lowercase, collapse whitespace, strip punctuation. */
function normToken(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.,;:!?'"()\-–—]+/g, "")
    .trim()
}

/** A stable identity string for one list item, used to decide "already seen". The CHALLENGE: the
 *  extraction model can re-PARAPHRASE / re-truncate a long free-text field (a review BODY) between ticks
 *  even at temperature 0 (the delta page has more rows, which shifts formatting), so keying identity on
 *  the FULL item makes an unchanged item look new — the only-NEW diff then re-surfaces seen items (the
 *  documented dedup failure). FIX: for an OBJECT item, key on its STABLE LOW-ENTROPY scalar fields — the
 *  numbers/booleans + SHORT strings (≤40 normalized chars: a reviewer name, a date, a star rating, a
 *  title) — and EXCLUDE long free-text bodies (the paraphrasable part). For a review {reviewer,stars,
 *  date,text}, identity collapses to reviewer+stars+date (highly stable), so a re-worded body never makes
 *  a seen review look new, while a genuinely-new review (new reviewer/date) still differs. A primitive or
 *  array item keys on its whole normalized JSON (no free-text field to exclude). If an object has NO
 *  short-scalar field (all long text), fall back to a normalized prefix of the whole item so identity is
 *  still stable-ish rather than maximally brittle. */
function itemIdentity(item: unknown): string {
  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>
    const parts: string[] = []
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k]
      if (typeof v === "number" || typeof v === "boolean") {
        parts.push(`${k}=${v}`)
      } else if (typeof v === "string") {
        const n = normToken(v)
        // Short strings (names, dates, ratings, titles) are STABLE identity signal; long free-text
        // (a review body) is paraphrasable → excluded from identity.
        if (n.length > 0 && n.length <= 40) parts.push(`${k}=${n}`)
      }
    }
    if (parts.length > 0) return parts.join("|")
    // No short-scalar field → fall back to a normalized prefix of the whole (stable-ish) rather than the
    // full free text (which would be maximally brittle to paraphrase).
    return normToken(stableStringify(item as Json)).slice(0, 120)
  }
  return normToken(stableStringify(item as Json))
}

/** The items present in `current`'s list but NOT in `previous`'s list — the only-NEW
 *  set. Returns null when EITHER side has no list (no item-level diff is meaningful),
 *  so the caller falls back to the whole `current` (the prior, list-less behavior). */
function computeNewItems(prev: Json, current: Json): unknown[] | null {
  const currentItems = findItemsArray(current)
  if (currentItems === null) return null
  // No prior list (cold tick / prior was list-less) ⇒ nothing is "new since last tick"
  // — a cold tick must surface NOTHING (it has no watermark to diff against), which is
  // exactly the baseline-tick semantics. Return an empty new-set, NOT the whole page.
  const prevItems = findItemsArray(prev)
  if (prevItems === null) return []
  const seen = new Set(prevItems.map(itemIdentity))
  return currentItems.filter((it) => !seen.has(itemIdentity(it)))
}

export async function handleWebWatch(
  p: { url: string; extractionQuery: string; key: string },
  ctx: WebWatchCtx,
): Promise<{
  current: Json
  previous: Json
  changed: boolean
  delta?: Record<string, number> | null
  /**
   * SERVER-SIDE only-NEW classification (l710/l713 doctrine). For a LIST extraction, the items present
   * in `current` but NOT in the prior tick's list — the authoritative "new since last tick" set the tick
   * should act on (summarize / route), so a flash-lite tick RENDERS the diff instead of re-deriving it
   * from current-vs-previous (which it does unreliably → re-summarizes/re-routes the whole page). null
   * when the extraction has no list (a scalar/structure watch — no per-item diff applies; use `current`).
   * On a COLD tick (no prior watermark) this is an EMPTY array — nothing is "new since last tick".
   */
  newItems: unknown[] | null
  /** Count of `newItems` (0 on a cold/unchanged tick; null when no list extraction). */
  newItemCount: number | null
  /** Total items in the current page (for transparency when the full `current` list is suppressed on a
   *  diffing list tick). null when no list extraction. */
  currentItemCount?: number | null
  unreachable: boolean
  /** When `unreachable`, the REAL reason the fetch/extract failed (the fetcher's error message + the URL)
   *  — surfaced to the tick (and thus the transcript + judge) so a "no new reviews / unreachable" outcome
   *  is diagnosable rather than a swallowed black box (e.g. an SSRF-blocked / 404 URL the agent mis-typed
   *  vs a genuinely unreachable page). The agent must still record-and-degrade, never fabricate. */
  unreachableReason?: string
  confidence: "high" | "low"
  /** A binding, result-level instruction the tick MUST act on — present ONLY when newItemCount > 0. The
   *  recurring-tick preamble already tells the agent the diff is authoritative, but under parallel CPU load
   *  a flash-lite tick sometimes still narrates "no changes" despite a non-empty newItems (the data is all
   *  correct: complete extraction, watermark trimmed, full after-state — the model just overrides the tool
   *  result). Echoing the directive HERE, in the very result the agent reads to decide its prose, makes the
   *  "report these exact new items, do NOT say no changes" instruction impossible to miss. */
  changeDirective?: string
}> {
  if (!ctx.routineId) throw new Error("web_watch is only available inside a routine run")
  const prev = await readState(ctx, p.key)
  let raw: Json
  try {
    raw = await ctx.fetchExtract({
      url: p.url,
      mode: "extract",
      extractionQuery: p.extractionQuery,
    })
  } catch (err) {
    // record-and-degrade: keep prior state, flag low confidence, never fabricate — but SURFACE the real
    // cause (the fetcher's error + the URL) so a swallowed unreachable can't hide a mis-typed/blocked URL.
    const reason = err instanceof Error ? err.message : String(err)
    log.warn(
      { err, url: p.url, key: p.key, routineId: ctx.routineId },
      "web_watch fetch/extract failed",
    )
    return {
      current: null,
      previous: prev?.value ?? null,
      changed: false,
      newItems: null,
      newItemCount: null,
      unreachable: true,
      unreachableReason: `${reason} (url=${p.url})`,
      confidence: "low",
    }
  }
  const current = ctx.normalize ? ctx.normalize(raw) : raw
  const hash = stableHash(current)
  // PER-TICK IDEMPOTENCY: if THIS process already web_watched this key and then persisted a watermark that
  // is STILL the live watermark (prev.content_hash === the hash we persisted) AND the page is unchanged
  // since (current hash === that persisted hash), this is a RE-POLL within the same tick. Diff against the
  // FIRST call's PRIOR watermark (cached) instead of our own just-written one, so the re-poll surfaces the
  // SAME newItems — never the empty diff of (page vs the page we just stored). Self-invalidates the moment
  // the live watermark differs from what we wrote (a genuine next tick, or the page changed).
  const mkey = memoKey(ctx.routineId, p.key)
  const memo = tickWatchMemo.get(mkey)
  // A TRUE same-tick RE-POLL requires the live stored watermark VALUE to be byte-identical to what THIS
  // process last wrote (the value hash matches) AND the page to be unchanged since (current hash ==
  // persisted value hash). Keying on the VALUE hash (not content_hash) is load-bearing: the validator's
  // cross-tick TRIM mutates the stored `value` while leaving `content_hash` untouched — that is the
  // legitimate baseline→delta transition, NOT a re-poll, so it must diff against the trimmed value. (The
  // earlier content_hash-only check mistook a trimmed delta tick for a re-poll → diffed against the cold
  // prior → 0 new → the "no changes detected" parallel-load failure.)
  const storedValueHash = prev?.value != null ? stableHash(prev.value as Json) : null
  const isRepollOfOurWrite =
    memo != null && storedValueHash === memo.persistedValueHash && hash === memo.persistedValueHash
  const diffPrevValue = isRepollOfOurWrite ? memo.priorValue : (prev?.value ?? null)
  const diffPrevHash = isRepollOfOurWrite ? memo.priorContentHash : (prev?.content_hash ?? null)
  const changed = diffPrevHash != null && diffPrevHash !== hash
  // Compute the only-NEW item set BEFORE overwriting the watermark (it diffs current vs the PRIOR value).
  const newItems = computeNewItems(diffPrevValue, current)
  const newItemCount = newItems === null ? null : newItems.length
  // FORENSIC (BL-275 cross-tick diff triage): log the per-tick item counts so a "no new reviews" miss is
  // legible in the worker log — current (this fetch) vs prior (watermark) vs the computed new set. A
  // cross-tick drop shows as current<prior or newItemCount=0 despite a known delta.
  log.info(
    {
      key: p.key,
      url: p.url,
      routineId: ctx.routineId,
      currentItems: Array.isArray(current) ? current.length : null,
      priorItems: Array.isArray(diffPrevValue) ? (diffPrevValue as unknown[]).length : null,
      priorContentHash: diffPrevHash,
      currentContentHash: hash,
      changed,
      newItemCount,
      // True when this is a same-tick RE-POLL re-diffed against the first call's prior (the double-poll
      // footgun fix) rather than the freshly-written watermark.
      idempotentRepoll: isRepollOfOurWrite,
    },
    "web_watch cross-tick diff",
  )
  await writeState(ctx, p.key, current, hash)
  // Record/refresh the per-tick memo so a RE-POLL of this key (within the same tick) re-diffs against the
  // FIRST call's prior watermark, not the one we just wrote. On the first call we capture the pre-write
  // prior; on a re-poll we PRESERVE that original prior (do not advance it to our own write). `persistedHash`
  // tracks what we last wrote so the memo self-invalidates when the live watermark differs (next real tick).
  if (tickWatchMemo.size >= TICK_WATCH_MEMO_CAP && !tickWatchMemo.has(mkey)) {
    // Bound the cache — evict the oldest entry (insertion order) before inserting a new key.
    const oldest = tickWatchMemo.keys().next().value
    if (oldest !== undefined) tickWatchMemo.delete(oldest)
  }
  tickWatchMemo.set(mkey, {
    priorValue: diffPrevValue,
    priorContentHash: diffPrevHash,
    // We just persisted `current` as the watermark value; its hash IS the value hash a true re-poll must
    // match. (current's stableHash == `hash`.) The page is also unchanged in a re-poll, so current hash ==
    // this, satisfying both halves of isRepollOfOurWrite next call — while a between-ticks trim of the
    // stored value changes storedValueHash → correctly NOT a re-poll.
    persistedValueHash: hash,
  })
  const delta = changed ? diffNumeric(diffPrevValue, current) : null
  const confidence = structureDriftDetected(diffPrevValue, current) ? "low" : "high"
  if (changed && ctx.queueEvent) {
    await ctx.queueEvent({
      app: "kernel",
      entity: "routine_watch",
      action: "changed",
      entityId: p.key,
      data: { url: p.url, routineId: ctx.routineId, delta, newItemCount },
    })
  }
  // ⛔ ANTI-RE-PROCESS PAYLOAD SHAPING: on a DIFFING LIST tick (a list extraction WITH a prior
  // watermark), SUPPRESS the bulky full `current`/`previous` lists from the returned payload — return
  // `newItems` as the ONLY actionable item set (plus counts for transparency). Why: a flash-lite tick
  // handed both `newItems` AND the full `current` page reliably re-processes the WHOLE page (re-summarize
  // / re-route every review — the documented dedup failure), no matter how emphatic the instruction. By
  // not RETURNING the full page on a diffing tick, "act on only the new items" becomes the path of least
  // resistance — there is no full page in the result to accidentally process. Unchanged for: a COLD tick
  // (newItems empty, but the agent needs `current` to establish a baseline view), and SCALAR/structure
  // extractions (no list → newItems null → the price-diff path returns `current` as before).
  // Binding result-level directive when this watch found NEW items — see the `changeDirective` field doc.
  const changeDirective =
    newItemCount != null && newItemCount > 0
      ? `CHANGES DETECTED for this source (newItemCount=${newItemCount}): the \`newItems\` above ARE this ` +
        `tick's changes since last week — report EACH of them as a change for this source and fold them ` +
        `into the running doc's 'What changed this week' section. Do NOT say "no changes" / "nothing new" ` +
        `/ "remains current" for THIS source — newItems is non-empty, so that would contradict this result.`
      : undefined
  const currentItems = findItemsArray(current)
  // Use diffPrevValue (the prior we actually diffed against — the cached first-call prior on a re-poll) so
  // a re-poll is still recognized as a diffing list tick and keeps suppressing the full `current` page.
  const isDiffingListTick = currentItems !== null && findItemsArray(diffPrevValue) !== null
  if (isDiffingListTick) {
    return {
      current: null, // suppressed — act on `newItems` only (see ANTI-RE-PROCESS note above)
      previous: null,
      changed,
      delta,
      newItems,
      newItemCount,
      currentItemCount: currentItems.length,
      unreachable: false,
      confidence,
      ...(changeDirective ? { changeDirective } : {}),
    }
  }
  return {
    current,
    previous: diffPrevValue,
    changed,
    delta,
    newItems,
    newItemCount,
    currentItemCount: currentItems === null ? null : currentItems.length,
    unreachable: false,
    confidence,
    ...(changeDirective ? { changeDirective } : {}),
  }
}

// --- Registered-tool adapters ----------------------------------------------
//
// The kernel passes an `AppContext` ({ userId, orgId, db, emit, ... }). The
// routineId is read from the current run frame (the routine tick sets it; the
// buildToolSet filter keeps these tools invisible to non-routine runs). These
// adapters build the pure-handler ctx and wire the real fetch/extract + outbox.

interface KernelToolCtx {
  orgId: string
  userId: string
  db: RlsClient
}

/**
 * Parse a delimited free-text extraction (e.g. "Record 1:\nAuthor: …\nRating: …\nText: …\n\nRecord 2: …")
 * into structured items — the discrete per-record objects web_watch's cross-tick diff keys on. Robust to
 * the common shapes the extraction model emits: it splits into BLOCKS on a "Record/Review/Item N:" header
 * OR a blank-line boundary, then pulls "Label: value" pairs within each block into fields. A block with
 * no labeled fields but some text becomes `{ text: <the block> }`. Deterministic (no LLM), so the same
 * extracted text yields the same items every tick.
 */
export function parseDelimitedRecords(text: string): Record<string, string>[] {
  if (!text.trim()) return []
  // Split on a record header (Record/Review/Item/Entry N[:.)]) that starts a line, else on blank lines.
  const headerRe = /(?:^|\n)\s*(?:record|review|item|entry)\s*#?\s*\d+\s*[:.)]?/i
  let blocks: string[]
  if (headerRe.test(text)) {
    blocks = text
      .split(/(?:^|\n)\s*(?:record|review|item|entry)\s*#?\s*\d+\s*[:.)]?/i)
      .map((b) => b.trim())
      .filter(Boolean)
  } else {
    blocks = text
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .filter(Boolean)
  }
  const items: Record<string, string>[] = []
  for (const block of blocks) {
    const item: Record<string, string> = {}
    const unlabeled: string[] = []
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trim()
      if (!line) continue
      const m = line.match(/^([A-Za-z][A-Za-z _-]{0,24}?)\s*[:=]\s*(.+)$/)
      if (m) {
        const key = m[1].trim().toLowerCase().replace(/\s+/g, "_")
        item[key] = m[2].trim()
      } else {
        unlabeled.push(line)
      }
    }
    if (unlabeled.length > 0 && !item.text) item.text = unlabeled.join(" ")
    if (Object.keys(item).length > 0) items.push(item)
  }
  return items
}

function routineIdOrThrow(toolName: string): string {
  const frame = currentRunContext()
  if (!frame?.routineId) {
    throw new Error(`${toolName} is only available inside a routine run`)
  }
  return frame.routineId
}

/**
 * A `WatchTx` that runs each state op in its OWN SHORT PRIVILEGED transaction (org-scoped,
 * BYPASSRLS as liaison_admin). Why PRIVILEGED: `kernel.routine_state` is per-routine internal scratch
 * (keyed by routine_id+org_id), documented in the schema as "written/read by the privileged routine
 * worker" — NOT request-RLS user data. Writing it via the tick's RLS client depended on the
 * `app.current_org_id` GUC being set on the (pooled) connection, which under PARALLEL routine-tick load
 * intermittently failed → a "storage error" that broke web_watch's cross-tick diff (the 2-parallel
 * confirmation regression: state never persisted → every tick saw a cold diff → re-summarized the whole
 * page). A privileged, org-scoped write sets the GUC + BYPASSRLS itself, so it is robust under load.
 * Why SHORT/per-op (not one tx wrapping the whole handler): web_watch's fetch+extract is a multi-second
 * LLM call — holding a privileged connection across it would EXHAUST the privileged pool under parallel
 * load (the very contention we are fixing). So each read/write/queueEvent opens + closes its own brief
 * privileged tx; the slow fetch runs between them holding NO connection.
 */
function privilegedWatchTx(orgId: string): WatchTx {
  return {
    execute: (query: SQL) =>
      withPrivilegedDb(orgId, "routine-watch-state", (tx) => tx.execute(query)),
    queueEvent: (event: AppEvent) =>
      withPrivilegedDb(orgId, "routine-watch-event", (tx) => tx.queueEvent(event)),
  }
}

export function handleWatchStateTool(
  params: { key: string; value?: Json },
  ctx: KernelToolCtx,
): Promise<{ value: Json; previous: Json; changed: boolean }> {
  const routineId = routineIdOrThrow("watch_state")
  return handleWatchState(params, { orgId: ctx.orgId, routineId, tx: privilegedWatchTx(ctx.orgId) })
}

/**
 * The FIXED CANONICAL extraction query web_watch sends to the extractor on EVERY tick — deliberately
 * independent of the agent's per-call `extractionQuery` wording. web_watch's cross-tick only-NEW diff
 * keys on the page's RECORDS, and is corrupted if the cheap extraction model drops a record on one tick
 * but not the next. The content-keyed extraction cache makes a byte-identical page deterministic — but
 * ONLY if the (content, query) pair is identical across ticks. The tick agent PARAPHRASES its query
 * between ticks, which changed the cache key → tick 2 re-extracted and could drop the newest / a
 * non-English record (the observed "No new reviews detected" failure under parallel load). Pinning the
 * query to this constant makes both ticks send the identical pair → the cache HITS → tick 2 reuses tick
 * 1's exhaustive extraction → the diff is stable. The instruction extracts EVERY record with the generic
 * labeled fields any watch (reviews / prices / posts) diffs on, so the agent's free-form intent is
 * redundant (and is intentionally excluded to keep the query byte-stable).
 */
export const WEB_WATCH_EXTRACTION_QUERY =
  "Extract EVERY record/item on this page (e.g. each customer review, product/SKU listing, price entry, " +
  "post, or changelog entry) EXHAUSTIVELY — do NOT summarize, sample, paraphrase-merge, or skip ANY, " +
  "including the LAST record, very short records, and records written in another language (e.g. German). " +
  "Count the records on the page and emit exactly that many blocks. Output EACH record SEPARATELY as its " +
  "own block. For EACH record, copy the record's OWN labeled fields VERBATIM — use the exact field labels " +
  "and values shown on the page (e.g. if a product block shows 'Product:', 'SKU:', 'Price:', emit those; " +
  "if a review shows author/rating/date/body, emit those). One 'Label: value' pair per line. Example " +
  "shape (use the PAGE's actual labels, not these):\nRecord 1:\nProduct: <as shown>\nSKU: <as shown>\n" +
  "Price: <as shown>\n\nRecord 2:\nAuthor: <as shown>\nRating: <as shown>\nDate: <as shown>\nText: <as " +
  "shown>\n\nSeparate records with a blank line. Do not merge multiple records into one block, and do not " +
  "drop a record because its fields differ from another record's."

export async function handleWebWatchTool(
  params: { url: string; extractionQuery: string; key: string },
  ctx: KernelToolCtx,
): Promise<Awaited<ReturnType<typeof handleWebWatch>>> {
  const routineId = routineIdOrThrow("web_watch")
  // COMPLETENESS GUARD ground truth (part 1): record that web_watch was CALLED this tick (any result).
  // The invoker uses this to detect the execution-SKIP failure — a watch tick that posts a conclusion
  // WITHOUT ever polling (calls === 0 for a routine whose prompt names web_watch). Recorded before the
  // fetch so even an unreachable/0-new call counts as "the tick polled".
  recordWatchCall(routineId)
  const fetchExtract = async (args: {
    url: string
    mode: "extract"
    extractionQuery: string
  }): Promise<Json> => {
    // web_watch's cross-tick only-NEW diff is PER-ITEM (findItemsArray + itemIdentity), so it needs the
    // page's records (reviews / news / prices) as DISCRETE objects. The free-text extraction reliably
    // returns them as a delimited block ("Review 1:\nText: …\nRating: …\nDate: …\n\nReview 2: …"); we ask
    // for that record-per-line shape and PARSE it into structured items in-process — deterministic and
    // robust (no schema'd-output fragility, which intermittently returned empty objects / errored and
    // left the watermark unwritten). The parse splits on blank-line / "Record N:" boundaries and pulls
    // labeled fields, so each item carries author/rating/date/text the diff + the validator-trim key on.
    //
    // COMPLETENESS is load-bearing for the cross-tick diff: if the cheap extraction model OMITS a record
    // (observed dropping the NEWEST / a non-English review on one tick but not the next), the diff of
    // (this tick) vs (prior tick) is corrupted — a dropped NEW record never surfaces as "new", and a
    // record present last tick but dropped this tick spuriously looks "removed". So instruct the extractor
    // to enumerate EVERY record exhaustively — including the last one, short ones, and non-English ones —
    // and to never summarize, sample, or skip any (the recall failure that broke the only-NEW dedup).
    //
    // DETERMINISM ACROSS TICKS: use the FIXED CANONICAL query (WEB_WATCH_EXTRACTION_QUERY), NOT the
    // agent's per-call `extractionQuery` wording. See the constant's doc — the agent paraphrasing its
    // query between ticks busted the content-keyed extraction cache (tick 2 re-extracted + dropped a
    // record). A fixed query makes both ticks send the IDENTICAL (content, query) pair → cache HIT.
    const r = await handleWebFetch(
      {
        url: args.url,
        mode: "extract",
        extractionQuery: WEB_WATCH_EXTRACTION_QUERY,
      },
      { orgId: ctx.orgId },
    )
    if ("error" in r) throw new Error(r.error)
    // Strip the <external-content> prompt-injection wrapper, then parse the delimited records into items.
    const unwrapped = r.content
      .replace(/^\s*<external-content[^>]*>\s*/i, "")
      .replace(/\s*<\/external-content>\s*$/i, "")
      .trim()
    const items = parseDelimitedRecords(unwrapped)
    // Surface the items array (the per-item diff basis). If parsing found nothing (an unexpected shape),
    // fall back to the wrapped content so the tick still has SOMETHING (graded as a non-list watch).
    return items.length > 0 ? items : { content: unwrapped }
  }
  const tx = privilegedWatchTx(ctx.orgId)
  const result = await handleWebWatch(params, {
    orgId: ctx.orgId,
    routineId,
    tx,
    fetchExtract,
    queueEvent: (e) =>
      tx.queueEvent({
        app: e.app,
        entity: e.entity,
        action: e.action,
        entityId: e.entityId,
        data: e.data,
        orgId: ctx.orgId,
        actorId: ctx.userId,
        actorType: "agent",
      }),
  })
  // COMPLETENESS GUARD ground truth: record this source's tool-confirmed changes (only when web_watch
  // returned newItemCount > 0) into the per-tick ledger. The invoker DRAINS it after the tick posts and
  // re-prompts ONCE if any tool-confirmed change is missing from the posted prose (the parallel-load
  // prose-omission residual). Recorded regardless of whether the diffing-list payload suppressed `current`
  // — `newItems`/`newItemCount` are present on both payload shapes. Idempotent on a same-tick re-poll
  // (recordWatchChange replaces the entry for an existing key, never double-counts).
  if (result.newItemCount != null && result.newItemCount > 0 && Array.isArray(result.newItems)) {
    recordWatchChange(routineId, {
      key: params.key,
      url: params.url,
      newItems: result.newItems,
      newItemCount: result.newItemCount,
    })
  }
  return result
}
