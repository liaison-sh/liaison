// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NODE SESSION STORE (C4, D40, K21, K22). Rows and events of the owner's
// sessions, kept live by the socket and healed by pull:
//
// - `node_session` frames carry the public row, `lastSeq` included
//   (`applyRow`). A watched row whose `lastSeq` is above what this store holds
//   pulls the tail: the events' own frames go out ephemerally and a dropped
//   one is never re-sent (D40).
// - A49: a `node_session` frame `{ sessionId, deleted: true }` (an import
//   deleted from Liaison) drops the row and closes its tab (`applyRow`).
// - `node_session_event` frames carry one event (`applyEvent`). For a watched
//   session it is appended when it is the next seq, dropped when it is not new,
//   and a gap pulls everything after the last seq held.
// - `pull(id)` GETs `events?after=lastSeq` page after page until a page comes
//   back empty, one pull per session at a time.
// - A socket reconnect or a page resume (the resync bus) and a window focus
//   refetch every watched row and pull its events.
//
// Events are kept only for watched sessions (an open session view); any
// session's row is kept for the cards and lists. Each kept event records when
// this client received it (`clientReceivedAt`), from which the walk reads S5's
// latency.
//
// S53 (owner D20): the store holds the main thread only. Pulls ask for
// `scope=top` and move `lastSeq` to the answer's `through`, past the
// subagents' events in between; a subagent's event that still arrives (an
// older API's frame or page) advances the seq and is never kept. One
// subagent's events are held only while its drawer is open (`openSubagent`,
// pulled with `parent=<toolUseId>` and again whenever the row moves on) and
// released by `closeSubagent`. An open drawer holds them like the main thread
// (S56): a bounded window mutated in place, old large outputs elided, its
// trimmed earliest events loaded again on request (`loadEarlierSubagent`).
//
// S56 (owner D30, the memory budget): the main thread is held in a bounded
// window per watched session, outside Solid's store (a plain array mutated in
// place and a version signal; never a copy per batch):
//
// - the last FEED_WINDOW transcript events (trimmed TRIM_SLACK at a time);
//   older ones load again on demand (`loadEarlier`, a `before=` read);
// - the events no transcript line comes from and nothing reads one by one
//   (usage, task_*, todo) are folded on arrival (session-fold.ts: one entry per
//   subagent, running totals) and not held: the header, the panel, the plan
//   and the pending requests read the fold;
// - a tool output over ELIDE_MIN_CHARS older than the last ELIDE_KEEP held
//   events is elided to a stub (its line count, its size); the row reads it
//   again by seq when opened (`fetchEventOutput`). A tool call's input over
//   the same size is elided the same way, keeping its short fields (a path, a
//   command: the row's one-line argument), and read again by seq when its row
//   opens (`fetchEventInput`). The transcript model follows the replacement
//   through the window's journal;
// - an unwatched session's window is dropped.
//
// D33 (the reopen race): each watch of a session gets a new feed, numbered by
// a generation; views count (`watched` is a refcount, so a second view of the
// session, or a remount before the old view's cleanup, keeps the window). A
// pull belongs to the feed it started for: a page that comes back after its
// feed was dropped is discarded, never appended into the next watch's feed,
// and the next watch runs its own pull from its own last seq.
//
// S58 (owner D34, several sessions open): a view reports whether it is on
// screen (`showSession` / `hideSession`). Hidden for RELEASE_AFTER_MS, its
// windows (main thread and open drawers) are let go but for the screen the
// owner left and the open requests; the fold stays, so the header, the list
// and the panel still read. Shown again, the window reads back from the disk
// cache (session-disk-cache.ts, IndexedDB: every held event is written there
// at ingest), then the server for what the cache lacks. One byte budget
// (MEMORY_BUDGET_BYTES, each event's size estimated once from its payload's
// JSON) spans every window: past it the least recently viewed hidden session
// gives back its oldest events, then its window; one on screen never does.
// Long messages are stubs off the last screen too (TEXT_PREVIEW_CHARS kept);
// a stub row reads its content back (cache, then server) while on screen.
//
// D33 (the load-earlier race): a "load earlier" page is read below the
// window's anchor (`earlierAnchor`: where the next older page must end). If
// the window moved while the read was in flight (a live trim, a drop), the
// page no longer abuts it: it is discarded and read again below the new
// anchor, never spliced across a gap.

import type { FileChange, NodeSessionEvent } from "@liaison/shared"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { log } from "~/lib/logger"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { evictTabByEntity } from "~/modules/shell/tab-store"
import { resetStoppedOrphans } from "./header-info"
import {
  getFilesChanged,
  getSession,
  getSessionEvents,
  NODE_SESSION_EVENTS_LIMIT,
  type NodeSessionEventsPage,
  type NodeSessionRow,
  SESSION_ROUTES,
} from "./session-api"
import { clearDiskCache, diskCache } from "./session-disk-cache"
import { attachFold, EventFold, TASK_SUBTYPES } from "./session-fold"
import { attachJournal, countLines, type EventJournal } from "./transcript"

/** An event as this client holds it: the server's, plus when it arrived here. */
export type HeldSessionEvent = NodeSessionEvent & { clientReceivedAt: number }

interface SessionState {
  rows: Record<string, NodeSessionRow>
}

const [state, setState] = createStore<SessionState>({
  rows: {},
})

/** S56: the transcript events a watched session holds at most (then the oldest go). */
export const FEED_WINDOW = 2000
/** Trimmed this many at a time, so the window is not shifted on every event. */
export const TRIM_SLACK = 200
/**
 * S56, S58: the most recent held events (about a screen at the bottom) keep
 * their whole contents...
 */
export const ELIDE_KEEP = 40
/** ...and older outputs, inputs and messages longer than this are stubs (read back on screen). */
export const ELIDE_MIN_CHARS = 4096
/** S58: a long message's stub keeps this much of its start. */
const TEXT_PREVIEW_CHARS = 600
/** S58: one budget for every session's held events (main threads and drawers). */
export const MEMORY_BUDGET_BYTES = 64 * 2 ** 20
/** S58: a view hidden this long lets its events go (read back when shown). */
export const RELEASE_AFTER_MS = 30_000
/** S58: a released window keeps the screen the owner left, this many events. */
export const SCREEN_KEEP = 40
/** "Load earlier" raises a session's window by what it loaded, up to this. */
export const FEED_WINDOW_MAX = 10_000

/** Events no transcript line comes from: folded on arrival, never held (S56). */
function foldsOnly(e: NodeSessionEvent): boolean {
  if (e.type === "usage" || e.type === "todo") return true
  return e.type === "system" && TASK_SUBTYPES.has(String(e.payload?.subtype ?? ""))
}

const JOURNAL_MAX = 4096
let feedGenerations = 0

/** S58: the bytes an event costs this client, estimated once at ingest (its payload's JSON). */
const sizes = new WeakMap<object, number>()
const EVENT_OVERHEAD = 256

function sizeOf(e: NodeSessionEvent): number {
  const known = sizes.get(e)
  if (known !== undefined) return known
  let chars = 0
  try {
    chars = JSON.stringify(e.payload ?? null)?.length ?? 0
  } catch {
    chars = 0
  }
  const bytes = chars * 2 + EVENT_OVERHEAD
  sizes.set(e, bytes)
  return bytes
}

/** S58: the bytes every held window holds, main threads and drawers (one budget). */
let heldBytes = 0

/**
 * S56: one watched session's main thread (or one open drawer's subagent): a
 * bounded window of held events (a plain array, mutated in place), the fold
 * of every event received, the journal of events replaced in place, and a
 * version signal for the view. S58: what it holds is counted against the
 * shared budget, and a background view's window is released (`release`) and
 * read back (`restore`) when it is shown again.
 */
class SessionFeed {
  /** D33: the watch this feed belongs to; a page read for another is discarded. */
  readonly generation = ++feedGenerations
  readonly events: HeldSessionEvent[] = []
  readonly fold = new EventFold()
  lastSeq = 0
  /** Main-thread events received, held or folded (monotonic). */
  received = 0
  /** Older main-thread events exist below the window (trimmed, or not loaded). */
  hasEarlier = false
  cap = FEED_WINDOW
  /** The seq the next "load earlier" reads below (null: the window's first). */
  loadBelow: number | null = null
  /** D33: bumped when the window's front is trimmed. */
  trims = 0
  /** S58: the bytes this window holds. */
  bytes = 0
  /** S58: the window was let go (a background view); new events are folded, not held. */
  released = false
  /** S58: bumped on every release and restore: a read for an older one is discarded. */
  releases = 0
  /** S58: the first seq the window held when it was released (where it reads back from). */
  restoreFrom: number | null = null
  /**
   * Batch-5 F6, F11: the last read back failed or came back short; the window
   * stays released (no hole) and the view says so, with a retry.
   */
  readBackFailed = false
  /**
   * F10: a restored window's events from here up to its first are still to be
   * read back (behind the screen, or again after a failure); null: none.
   */
  earlierFrom: number | null = null
  private hadEarlier = false
  private elideAt = 0
  private replaced: { v: number; e: HeldSessionEvent }[] = []
  private journalFloor = 0
  journalVersion = 0
  private readonly signal = createSignal(0, { equals: false })
  readonly journal: EventJournal

  /** `scope`: "" for the main thread, the Agent call's id for a drawer (the disk cache's key). */
  constructor(
    readonly sessionId: string,
    readonly scope: string,
  ) {
    attachFold(this.events, this.fold)
    const feed = this
    this.journal = {
      get version() {
        return feed.journalVersion
      },
      since(version: number) {
        if (version < feed.journalFloor) return null
        const out: HeldSessionEvent[] = []
        for (const r of feed.replaced) if (r.v > version) out.push(r.e)
        return out
      },
    }
    attachJournal(this.events, this.journal)
  }

  track(): void {
    this.signal[0]()
  }

  bump(): void {
    this.signal[1](0)
  }

  private account(delta: number): void {
    this.bytes += delta
    heldBytes += delta
  }

  /** Dropped (closed view, closed drawer): its bytes leave the budget. */
  dispose(): void {
    this.account(-this.bytes)
  }

  /**
   * Fold one event and hold it unless it folds only (or the window is
   * released); the held copy is returned for the disk cache, null when it
   * folds only.
   */
  ingest(e: NodeSessionEvent, now: number): HeldSessionEvent | null {
    this.received++
    this.fold.ingest(e)
    if (foldsOnly(e)) return null
    const held: HeldSessionEvent = { ...e, clientReceivedAt: now }
    if (this.released) {
      // Batch-5 F1, F2: a window that held nothing when it was released (a
      // session launched in a background tab, a drawer whose subagent had not
      // started) reads back from the first event that arrived since.
      if (this.restoreFrom === null) this.restoreFrom = held.seq
      return held
    }
    this.events.push(held)
    this.account(sizeOf(held))
    this.elide()
    if (this.events.length > this.cap + TRIM_SLACK) this.dropFront(this.events.length - this.cap)
    return held
  }

  private dropFront(n: number): void {
    const gone = this.events.splice(0, n)
    let freed = 0
    for (const e of gone) freed += sizeOf(e)
    this.account(-freed)
    this.elideAt = Math.max(0, this.elideAt - n)
    this.hasEarlier = true
    this.loadBelow = null
    this.trims++
  }

  /** D33: the seq the next older page must end below to abut the window. */
  earlierAnchor(): number {
    return this.loadBelow ?? this.events[0]?.seq ?? this.lastSeq + 1
  }

  /**
   * Older events loaded above the window (S56 "load earlier"), read below
   * `anchor` while the window had trimmed `trims` times. D33: false, and
   * nothing added, when the window has moved since (the page would leave a gap).
   */
  prepend(
    anchor: number,
    trims: number,
    older: HeldSessionEvent[],
    below: number,
    more: boolean,
  ): boolean {
    if (this.released || this.trims !== trims || this.earlierAnchor() !== anchor) return false
    this.loadBelow = below
    if (older.length > 0) {
      this.events.unshift(...older)
      let added = 0
      for (const e of older) added += sizeOf(e)
      this.account(added)
      this.elideAt = 0
      this.cap = Math.min(FEED_WINDOW_MAX, Math.max(this.cap, this.events.length))
      this.elide()
    }
    this.hasEarlier = more
    return true
  }

  private replaceAt(i: number, stub: HeldSessionEvent): void {
    this.account(sizeOf(stub) - sizeOf(this.events[i]))
    this.events[i] = stub
    this.journalVersion++
    this.replaced.push({ v: this.journalVersion, e: stub })
    if (this.replaced.length > JOURNAL_MAX) {
      const drop = this.replaced.length - JOURNAL_MAX / 2
      this.journalFloor = this.replaced[drop - 1].v
      this.replaced.splice(0, drop)
    }
  }

  private elide(): void {
    const stop = this.events.length - ELIDE_KEEP
    for (; this.elideAt < stop; this.elideAt++) {
      const stub = elidedStub(this.events[this.elideAt])
      if (stub) this.replaceAt(this.elideAt, stub)
    }
  }

  /** The window changed other than at its ends: the transcript rebuilds from it once. */
  private resetJournal(): void {
    this.journalVersion++
    this.journalFloor = this.journalVersion
    this.replaced = []
  }

  /** The seqs of the requests still waiting for a decision (never released, S58). */
  private openRequestSeqs(): Set<number> {
    return new Set(this.fold.pending().map((r) => r.seq))
  }

  /**
   * S58: let the window go (a background view, or the budget). Kept: the
   * screen the owner left (SCREEN_KEEP events from `screenFirst`, else the
   * last ones), its large contents as stubs, and every open request. New
   * events are folded, not held, until `restore`.
   */
  release(screenFirst?: number): void {
    if (this.released) return
    const open = this.openRequestSeqs()
    const first = this.events[0]?.seq ?? null
    let start = Math.max(0, this.events.length - SCREEN_KEEP)
    if (screenFirst !== undefined) {
      const i = this.events.findIndex((e) => e.seq >= screenFirst)
      if (i >= 0) start = Math.min(i, start)
    }
    const keep: HeldSessionEvent[] = []
    for (let i = 0; i < this.events.length; i++) {
      const e = this.events[i]
      if ((i >= start && i < start + SCREEN_KEEP) || open.has(e.seq)) keep.push(elidedStub(e) ?? e)
    }
    if (this.restoreFrom === null && this.earlierFrom !== null) {
      // F10: released again before the part above its screen read back: it
      // reads back from where the window began (whether more lay above it is
      // what the last release recorded).
      this.restoreFrom = first === null ? this.earlierFrom : Math.min(this.earlierFrom, first)
      this.earlierFrom = null
    } else if (this.restoreFrom === null) {
      this.restoreFrom = first
      this.hadEarlier = this.hasEarlier
    } else if (first !== null) {
      // F8: released again before its read back landed: it still reads back
      // from where the window began the first time.
      this.restoreFrom = Math.min(this.restoreFrom, first)
    }
    this.events.splice(0, this.events.length, ...keep)
    let bytes = 0
    for (const e of keep) bytes += sizeOf(e)
    this.account(bytes - this.bytes)
    this.elideAt = keep.length
    this.released = true
    this.releases++
    this.loadBelow = null
    this.trims++
    this.resetJournal()
  }

  /**
   * S58: a read back begins: new events are held again; the token discards a
   * stale read. `screen`: the first seq the released window kept (F10: read
   * back first).
   */
  unrelease(): { from: number | null; to: number; token: number; screen: number | null } {
    const screen = this.events[0]?.seq ?? null
    this.released = false
    this.releases++
    return { from: this.restoreFrom, to: this.lastSeq, token: this.releases, screen }
  }

  /**
   * F10: the events above the screen a read back restored first, put back in
   * front of the window (read below `anchor` while it had trimmed `trims`
   * times; false, and nothing added, when the window moved since).
   */
  restoreEarlier(anchor: number, trims: number, older: HeldSessionEvent[], below: number): boolean {
    return this.prepend(anchor, trims, older, below, this.hadEarlier)
  }

  /** S58: the read back failed (offline): released again, read back on the next show. */
  relapse(): void {
    this.released = true
    this.releases++
  }

  /**
   * S58: the window read back (`got`: every held event from where it was,
   * in seq order, up to the seq it had then), merged with the events that
   * arrived since. `gapBelow`: the read began above where the window began.
   */
  restore(got: HeldSessionEvent[], gapBelow: boolean): void {
    this.restoreFrom = null
    if (got.length === 0) {
      this.hasEarlier = this.hadEarlier
      return
    }
    const top = got[got.length - 1].seq
    const merged = got.concat(this.events.filter((e) => e.seq > top))
    this.events.splice(0, this.events.length, ...merged)
    let bytes = 0
    for (const e of merged) bytes += sizeOf(e)
    this.account(bytes - this.bytes)
    this.hasEarlier = this.hadEarlier || gapBelow
    if (this.events.length > this.cap + TRIM_SLACK) {
      this.dropFront(this.events.length - this.cap)
    }
    this.elideAt = 0
    this.loadBelow = null
    this.trims++
    this.resetJournal()
    this.elide()
  }

  /**
   * S58 (the budget): let go of up to `need` bytes of the oldest held events,
   * never past the first open request. The bytes freed.
   */
  evictFront(need: number): number {
    if (this.released || need <= 0) return 0
    const open = this.openRequestSeqs()
    let n = 0
    let freed = 0
    while (n < this.events.length - 1 && freed < need && !open.has(this.events[n].seq)) {
      freed += sizeOf(this.events[n])
      n++
    }
    if (n > 0) this.dropFront(n)
    return freed
  }
}

/** F10: a tool call's input is measured once (a read back and the window's elide both ask). */
const inputSizes = new WeakMap<object, number>()

function inputChars(input: object): number {
  const known = inputSizes.get(input)
  if (known !== undefined) return known
  const chars = JSON.stringify(input).length
  inputSizes.set(input, chars)
  return chars
}

/** S56: an input's string fields up to this long stay in its stub (a path, a command). */
const INPUT_FIELD_KEEP = 300

/**
 * S56: the stub of an old event too large to hold (a tool result's output, a
 * tool call's input), or null to keep it whole. An input keeps its short
 * scalar fields, so the row's one-line argument still reads. S58: a long
 * message (the owner's, the model's text or thinking) keeps its first
 * TEXT_PREVIEW_CHARS; the row reads the rest when it scrolls into view.
 */
function elidedStub(e: HeldSessionEvent): HeldSessionEvent | null {
  if (e.type === "tool_result") {
    const output = e.payload?.output
    if (typeof output !== "string" || output.length <= ELIDE_MIN_CHARS) return null
    return {
      ...e,
      payload: {
        ...e.payload,
        output: "",
        elided: { chars: output.length, lines: countLines(output) },
      },
    }
  }
  if (e.type === "tool_call") {
    const input = e.payload?.input
    if (!input || typeof input !== "object" || Array.isArray(input)) return null
    const chars = inputChars(input)
    if (chars <= ELIDE_MIN_CHARS) return null
    const kept: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof v === "string") kept[k] = v.length <= INPUT_FIELD_KEEP ? v : ""
      else if (typeof v === "number" || typeof v === "boolean" || v === null) kept[k] = v
    }
    return { ...e, payload: { ...e.payload, input: kept, inputElided: { chars } } }
  }
  if (e.type === "assistant_text" || e.type === "thinking" || e.type === "user_message") {
    const text = e.payload?.text
    if (typeof text !== "string" || text.length <= ELIDE_MIN_CHARS) return null
    return {
      ...e,
      payload: {
        ...e.payload,
        text: text.slice(0, TEXT_PREVIEW_CHARS),
        textElided: { chars: text.length },
      },
    }
  }
  return null
}

const feeds = new Map<string, SessionFeed>()
/** Bumped when a feed comes or goes: a reader of a session with none re-reads. */
const [feedsVersion, setFeedsVersion] = createSignal(0)

function feedOf(id: string): SessionFeed | undefined {
  const feed = feeds.get(id)
  if (feed) feed.track()
  else feedsVersion()
  return feed
}

const subKey = (sessionId: string, toolUseId: string) => `${sessionId}\u0000${toolUseId}`
/** S53: the open subagent drawers, by session; and how far each one's read is complete. */
const openSubagents = new Map<string, Set<string>>()
const subThrough = new Map<string, number>()
/** S53, S56: an open drawer's events, by `subKey`: a bounded window like the main thread's. */
const drawers = new Map<string, SessionFeed>()
/** Bumped when a drawer's window comes or goes. */
const [drawersVersion, setDrawersVersion] = createSignal(0)

/** D33: the open views per watched session (a refcount: the window goes with the last). */
const watched = new Map<string, number>()
/** The running pull per session, with the feed it reads for. */
const pulling = new Map<string, { feed: SessionFeed; run: Promise<void> }>()
/** A pull asked for while one runs: run once more after it. */
const pullAgain = new Set<string>()

type Api = Pick<ApiClient, "get">
let apiOf: () => Api | null = () => null

/** Where the store's reads go (the kernel API client; null while signed out). */
export function setSessionStoreApi(getter: () => Api | null): void {
  apiOf = getter
}

const EMPTY: HeldSessionEvent[] = []

export const sessionStore = {
  row(id: string): NodeSessionRow | undefined {
    return state.rows[id]
  },
  /** The held window of the main thread (S56: bounded; the same array as it moves on). */
  events(id: string): HeldSessionEvent[] {
    return feedOf(id)?.events ?? EMPTY
  },
  lastSeq(id: string): number {
    return feedOf(id)?.lastSeq ?? 0
  },
  /** S56: main-thread events received so far, held or folded (grows; the view counts new ones). */
  received(id: string): number {
    return feedOf(id)?.received ?? 0
  },
  /** S56: older main-thread events exist on the server above the held window. */
  hasEarlier(id: string): boolean {
    return feedOf(id)?.hasEarlier ?? false
  },
  isWatched(id: string): boolean {
    return watched.has(id)
  },
  /** S53: one subagent's events, held only while its drawer is open. */
  subagentEvents(sessionId: string, toolUseId: string): HeldSessionEvent[] {
    const drawer = drawers.get(subKey(sessionId, toolUseId))
    if (!drawer) {
      drawersVersion()
      return EMPTY
    }
    drawer.track()
    return drawer.events
  },
  /** S56 (batch-4 F6): older events of that subagent exist above its drawer's window. */
  subagentHasEarlier(sessionId: string, toolUseId: string): boolean {
    const drawer = drawers.get(subKey(sessionId, toolUseId))
    if (!drawer) {
      drawersVersion()
      return false
    }
    drawer.track()
    return drawer.hasEarlier
  },
  /** Every row held, any session (the Sessions list groups them; P2-T06). */
  rows(): NodeSessionRow[] {
    return Object.values(state.rows)
  },
  /** S58: the session's window was let go (a background view); it reads back when shown. */
  isReleased(id: string): boolean {
    return feedOf(id)?.released ?? false
  },
  /** Batch-5 F6, F11: the main thread's read back failed or came back short (retry: `retryReadBack`). */
  readBackFailed(id: string): boolean {
    return feedOf(id)?.readBackFailed ?? false
  },
  /** The same for an open drawer's subagent. */
  subagentReadBackFailed(sessionId: string, toolUseId: string): boolean {
    const drawer = drawers.get(subKey(sessionId, toolUseId))
    if (!drawer) {
      drawersVersion()
      return false
    }
    drawer.track()
    return drawer.readBackFailed
  },
  /** S58: the bytes every held window holds together (the shared budget's measure). */
  heldBytes(): number {
    return heldBytes
  },
  /** S58: the bytes one session's windows hold (its main thread and open drawers). */
  sessionBytes(id: string): number {
    let total = feeds.get(id)?.bytes ?? 0
    for (const drawer of drawers.values()) if (drawer.sessionId === id) total += drawer.bytes
    return total
  },
}

function isRow(data: unknown): data is NodeSessionRow {
  return !!data && typeof (data as { id?: unknown }).id === "string"
}

/** A49: the deleted frame's data, `{ ownerUserId, sessionId, deleted: true }`. */
function deletedId(data: unknown): string | null {
  const d = data as { sessionId?: unknown; deleted?: unknown } | null
  return d?.deleted === true && typeof d.sessionId === "string" ? d.sessionId : null
}

/**
 * A49: a session deleted from Liaison leaves the store and the list, and its
 * open tab closes (its view lets its window go as it unmounts).
 */
export function removeSessionRow(id: string): void {
  if (state.rows[id]) setState("rows", id, undefined as unknown as NodeSessionRow)
  evictTabByEntity("kernel:session", id)
}

/** A `node_session` frame or a fetched row; the deleted frame removes it (A49). */
export function applyRow(data: unknown): void {
  const deleted = deletedId(data)
  if (deleted) {
    removeSessionRow(deleted)
    return
  }
  if (!isRow(data)) return
  setState("rows", data.id, data)
  if (watched.has(data.id) && (data.lastSeq ?? 0) > sessionStore.lastSeq(data.id)) {
    void pull(data.id)
  }
  // S53: an open drawer streams its subagent while the session moves on.
  for (const toolUseId of openSubagents.get(data.id) ?? []) {
    if ((data.lastSeq ?? 0) > (subThrough.get(subKey(data.id, toolUseId)) ?? 0)) {
      void pullSubagent(data.id, toolUseId)
    }
  }
}

/**
 * Append the main thread's events that follow on from the last seq held;
 * never a duplicate, never a subagent's event (S53: those only advance the
 * seq). `through` (a scoped read, S53) says the page is complete up to there:
 * its seqs need not be contiguous, and the store moves on to `through`.
 * Without it every seq must follow on, and a hole is a gap.
 */
function appendEvents(
  feed: SessionFeed,
  incoming: readonly NodeSessionEvent[],
  through?: number,
): boolean {
  const before = feed.lastSeq
  let last = before
  let gap = false
  let sorted = true
  for (let i = 1; i < incoming.length; i++) {
    if (incoming[i].seq < incoming[i - 1].seq) sorted = false
  }
  const list = sorted ? incoming : [...incoming].sort((a, b) => a.seq - b.seq)
  const now = Date.now()
  let changed = false
  const toDisk: HeldSessionEvent[] = []
  for (const e of list) {
    if (e.seq <= last) continue
    if (through === undefined && e.seq > last + 1) {
      gap = true
      break
    }
    last = e.seq
    if (!e.parentToolUseId) {
      const held = feed.ingest(e, now)
      if (held) toDisk.push(held)
      changed = true
    }
  }
  if (through !== undefined && through > last) last = through
  if (changed || last !== before) {
    feed.lastSeq = last
    feed.bump()
  }
  // S58: what this batch covered goes to the disk cache, complete for (before, last].
  if (last > before) writeToDisk(feed, toDisk, before, last)
  enforceBudget()
  return gap
}

function writeToDisk(feed: SessionFeed, held: HeldSessionEvent[], from: number, to: number): void {
  diskCache.write(feed.sessionId, feed.scope, held, held.map(sizeOf), from, to)
}

/** A `node_session_event` frame: `{ ownerUserId, sessionId, ...event }`. */
export function applyEvent(data: unknown): void {
  const frame = data as (NodeSessionEvent & { sessionId?: unknown }) | null
  if (!frame || typeof frame.sessionId !== "string" || typeof frame.seq !== "number") return
  const sessionId = frame.sessionId
  if (!watched.has(sessionId)) return
  const {
    sessionId: _sessionId,
    ownerUserId: _owner,
    ...event
  } = frame as typeof frame & {
    ownerUserId?: unknown
  }
  const feed = feeds.get(sessionId)
  if (feed && appendEvents(feed, [event as NodeSessionEvent])) void pull(sessionId)
}

/**
 * Every event after the last seq held, page after page, until a page is
 * empty, into the session's current feed. D33: a pull belongs to that feed; a
 * pull still running for a dropped feed (a view closed and opened again) is
 * left to discard its pages, and this one starts afresh.
 */
export function pull(id: string): Promise<void> {
  const feed = feeds.get(id)
  if (!feed) return Promise.resolve()
  const running = pulling.get(id)
  if (running?.feed === feed) {
    pullAgain.add(id)
    return running.run
  }
  pullAgain.delete(id)
  const current = () => feeds.get(id) === feed
  const run: Promise<void> = (async () => {
    const api = apiOf()
    if (!api) return
    for (let page = 0; page < 1000; page++) {
      const page = await getSessionEvents(api, id, feed.lastSeq, { top: true })
      // Unwatched meanwhile (a closed view, a sign-out) or watched again (a
      // newer feed): this page is not this watch's, keep nothing.
      if (!current()) return
      const before = feed.lastSeq
      appendEvents(feed, page.events, page.through)
      if (page.events.length === 0) return
      // Nothing usable in the page (a hole the server cannot fill): stop.
      if (feed.lastSeq === before) return
    }
  })()
    .catch((err) => log.warn({ err, sessionId: id }, "pulling node session events failed"))
    .finally(() => {
      if (pulling.get(id)?.run !== run) return
      pulling.delete(id)
      if (pullAgain.delete(id) && current()) void pull(id)
    })
  pulling.set(id, { feed, run })
  return run
}

const subPulling = new Map<string, Promise<void>>()
const subPullAgain = new Set<string>()

/** S53: one subagent's events after what its drawer holds, page after page. */
function pullSubagent(sessionId: string, toolUseId: string): Promise<void> {
  const key = subKey(sessionId, toolUseId)
  const running = subPulling.get(key)
  if (running) {
    subPullAgain.add(key)
    return running
  }
  const isOpen = () => openSubagents.get(sessionId)?.has(toolUseId) === true
  const run = (async () => {
    const api = apiOf()
    if (!api) return
    for (let page = 0; page < 1000; page++) {
      const from = subThrough.get(key) ?? 0
      const read = await getSessionEvents(api, sessionId, from, { parent: toolUseId })
      // Closed meanwhile: keep nothing.
      if (!isOpen()) return
      const mine = read.events
        .filter((e) => e.parentToolUseId === toolUseId && e.seq > from)
        .sort((a, b) => a.seq - b.seq)
      const to = Math.max(from, read.through ?? 0, read.events.at(-1)?.seq ?? 0)
      subThrough.set(key, to)
      let drawer = drawers.get(key)
      if (mine.length > 0) {
        if (!drawer) {
          drawer = new SessionFeed(sessionId, toolUseId)
          // S58: a drawer opened in a released (background) view is released too.
          if (feeds.get(sessionId)?.released) drawer.release()
          drawers.set(key, drawer)
          setDrawersVersion((v) => v + 1)
        }
        const now = Date.now()
        const held: HeldSessionEvent[] = []
        for (const e of mine) {
          const h = drawer.ingest(e, now)
          if (h) held.push(h)
        }
        drawer.lastSeq = mine[mine.length - 1].seq
        drawer.bump()
        writeToDisk(drawer, held, from, to)
        enforceBudget()
      } else if (drawer && to > from) {
        writeToDisk(drawer, [], from, to)
      }
      // A short page is the end: the server read through `through`.
      if (read.events.length < NODE_SESSION_EVENTS_LIMIT || to === from) return
    }
  })()
    .catch((err) => log.warn({ err, sessionId, toolUseId }, "pulling a subagent's events failed"))
    .finally(() => {
      subPulling.delete(key)
      if (subPullAgain.delete(key) && isOpen()) void pullSubagent(sessionId, toolUseId)
    })
  subPulling.set(key, run)
  return run
}

/** S53: a subagent's drawer opened: load its events and stream them while it stays open. */
export function openSubagent(sessionId: string, toolUseId: string): Promise<void> {
  const open = openSubagents.get(sessionId) ?? new Set<string>()
  open.add(toolUseId)
  openSubagents.set(sessionId, open)
  return pullSubagent(sessionId, toolUseId)
}

/** S53: its drawer closed: release every event of that subagent. */
export function closeSubagent(sessionId: string, toolUseId: string): void {
  const key = subKey(sessionId, toolUseId)
  const open = openSubagents.get(sessionId)
  open?.delete(toolUseId)
  if (open && open.size === 0) openSubagents.delete(sessionId)
  subThrough.delete(key)
  subPullAgain.delete(key)
  const drawer = drawers.get(key)
  if (drawer) {
    drawer.dispose()
    drawers.delete(key)
    setDrawersVersion((v) => v + 1)
  }
}

/** S53 (D29): the server's Files changed summary (null: unavailable, the caller falls back). */
export function fetchFilesChanged(id: string, hunks: boolean): Promise<FileChange[] | null> {
  const api = apiOf()
  return api ? getFilesChanged(api, id, hunks) : Promise.resolve(null)
}

async function refetchRow(id: string): Promise<void> {
  const api = apiOf()
  if (!api) return
  try {
    applyRow(await getSession(api, id))
  } catch (err) {
    log.warn({ err, sessionId: id }, "refetching a node session failed")
  }
}

/**
 * Keep a session's events live (an open view): load its row and every event
 * once. D33: views count; the first one makes the session's feed (a new
 * generation).
 */
export async function watchSession(id: string): Promise<void> {
  watched.set(id, (watched.get(id) ?? 0) + 1)
  if (!feeds.has(id)) {
    feeds.set(id, new SessionFeed(id, ""))
    setFeedsVersion((v) => v + 1)
  }
  await refetchRow(id)
  await pull(id)
}

/**
 * S56: an unwatched session's window is dropped (a view opening it again pulls
 * it). D33: only when its last view closes.
 */
export function unwatchSession(id: string): void {
  const views = (watched.get(id) ?? 0) - 1
  if (views > 0) {
    watched.set(id, views)
    return
  }
  watched.delete(id)
  forgetVisibility(id)
  for (const toolUseId of [...(openSubagents.get(id) ?? [])]) closeSubagent(id, toolUseId)
  const feed = feeds.get(id)
  if (feed) {
    feed.dispose()
    feeds.delete(id)
    setFeedsVersion((v) => v + 1)
  }
}

/**
 * S58: which sessions a view shows. A session with no entry was never shown
 * or hidden by a view (a caller that only watches it): it is treated as on
 * screen, never released nor evicted.
 */
interface Visibility {
  /** Views showing it now. */
  shown: number
  /** When it was last on screen (the budget's least recently viewed). */
  viewedAt: number
  /** The first seq on the screen the owner left (undefined: the bottom). */
  screenFirst?: number
  timer?: ReturnType<typeof setTimeout>
}
const visibility = new Map<string, Visibility>()

function isShown(id: string): boolean {
  const v = visibility.get(id)
  return !v || v.shown > 0
}

function forgetVisibility(id: string): void {
  clearTimeout(visibility.get(id)?.timer)
  visibility.delete(id)
}

/** The session's windows: its main thread's and its open drawers'. */
function windowsOf(id: string): SessionFeed[] {
  const out: SessionFeed[] = []
  const main = feeds.get(id)
  if (main) out.push(main)
  for (const drawer of drawers.values()) if (drawer.sessionId === id) out.push(drawer)
  return out
}

/**
 * S58: a view shows the session (its tab active, the document visible). A
 * release pending for it is cancelled; a released window reads back, from
 * the disk cache first, then the server.
 */
export function showSession(id: string): void {
  const v = visibility.get(id) ?? { shown: 0, viewedAt: 0 }
  clearTimeout(v.timer)
  v.timer = undefined
  v.shown++
  v.viewedAt = Date.now()
  visibility.set(id, v)
  rehydrateSession(id)
}

/**
 * S58: a view stops showing the session (another tab or route, the document
 * hidden). After RELEASE_AFTER_MS hidden its windows are let go, keeping the
 * screen the owner left (`screenFirst`: the first seq on it; undefined, the
 * bottom) and the open requests; the fold (header, list, panel) stays.
 */
export function hideSession(id: string, screenFirst?: number): void {
  const v = visibility.get(id)
  if (!v) {
    if (!watched.has(id)) return
    visibility.set(id, { shown: 0, viewedAt: Date.now(), screenFirst })
  } else {
    v.shown = Math.max(0, v.shown - 1)
    v.viewedAt = Date.now()
    v.screenFirst = screenFirst
  }
  const entry = visibility.get(id) as Visibility
  if (entry.shown > 0 || !watched.has(id)) return
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = undefined
    if (entry.shown > 0) return
    releaseSession(id)
  }, RELEASE_AFTER_MS)
}

function releaseSession(id: string): void {
  const screenFirst = visibility.get(id)?.screenFirst
  for (const f of windowsOf(id)) {
    f.release(f.scope === "" ? screenFirst : undefined)
    f.bump()
  }
}

/** How a window reads back: its current feed, its server read, which events are its own. */
interface WindowReader {
  current: () => SessionFeed | undefined
  read: (api: Api, after: number) => Promise<NodeSessionEventsPage>
  mine: (e: NodeSessionEvent) => boolean
}

function readerOf(f: SessionFeed): WindowReader {
  const id = f.sessionId
  if (f.scope === "") {
    return {
      current: () => feeds.get(id),
      read: (api, after) => getSessionEvents(api, id, after, { top: true }),
      mine: (e) => !e.parentToolUseId,
    }
  }
  const key = subKey(id, f.scope)
  const toolUseId = f.scope
  return {
    current: () => drawers.get(key),
    read: (api, after) => getSessionEvents(api, id, after, { parent: toolUseId }),
    mine: (e) => e.parentToolUseId === toolUseId,
  }
}

function rehydrateSession(id: string): void {
  for (const f of windowsOf(id)) {
    if (f.released) void rehydrate(f, readerOf(f))
    // F10, F6: the part above the screen did not read back: it is read again.
    else if (f.earlierFrom !== null) void fillEarlier(f, readerOf(f))
  }
}

/**
 * The running read back per window, with the release it reads for: a quick
 * hide and show does not read twice. Batch-5 F8: a window released again
 * while its read ran (that read is stale and discards itself) starts a new one.
 */
const rehydrating = new WeakMap<SessionFeed, { token: number; run: Promise<void> }>()

/** F10: the disk cache is read back this many events at a time. */
const DISK_CHUNK = 200

/**
 * S58: the held events of (after, upTo] of a window, read back: from the disk
 * cache in chunks while it covers them from where the read stands, then from
 * the server (`read`, forward) for the rest. F10: each event's size is the one
 * stored, and every event but the last ELIDE_KEEP read so far is a stub at
 * once, so a long read back never holds every payload whole. `complete`: it
 * reached `upTo`; null when the read went stale.
 */
async function readBack(
  feed: SessionFeed,
  first: number,
  upTo: number,
  read: (api: Api, after: number) => Promise<NodeSessionEventsPage>,
  mine: (e: NodeSessionEvent) => boolean,
  stale: () => boolean,
): Promise<{ events: HeldSessionEvent[]; complete: boolean } | null> {
  const got: HeldSessionEvent[] = []
  let whole = 0
  const stubOld = () => {
    for (; whole < got.length - ELIDE_KEEP; whole++) {
      const stub = elidedStub(got[whole])
      if (stub) got[whole] = stub
    }
  }
  let after = first - 1
  while (after < upTo) {
    const chunk = await diskCache.read<HeldSessionEvent>(
      feed.sessionId,
      feed.scope,
      after + 1,
      upTo,
      DISK_CHUNK,
    )
    if (stale()) return null
    // The cache must hold the events from where the read stands, else the server reads them.
    if (!chunk || chunk.lo !== after + 1) break
    for (let i = 0; i < chunk.events.length; i++) {
      sizes.set(chunk.events[i], chunk.bytes[i])
      got.push(chunk.events[i])
    }
    stubOld()
    after = chunk.hi
    if (chunk.events.length < DISK_CHUNK) break
  }
  const api = apiOf()
  let failed = false
  try {
    for (let page = 0; after < upTo && api && page < 1000; page++) {
      const read1 = await read(api, after)
      if (stale()) return null
      const now = Date.now()
      const held = read1.events
        .filter((e) => mine(e) && e.seq > after && e.seq <= upTo && !foldsOnly(e))
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...e, clientReceivedAt: now }))
      const next = Math.min(
        upTo,
        Math.max(read1.through ?? 0, read1.events.at(-1)?.seq ?? 0, held.at(-1)?.seq ?? 0),
      )
      if (next <= after) break
      writeToDisk(feed, held, after, next)
      for (const e of held) got.push(e)
      stubOld()
      after = next
      if (read1.events.length === 0) break
    }
  } catch (err) {
    failed = true
    log.warn({ err, sessionId: feed.sessionId }, "reading a released session back failed")
  }
  if (stale()) return null
  return { events: got, complete: !failed && after >= upTo }
}

/**
 * S58: read a released window back: every held event from where it began up
 * to the seq it had, from the disk cache, and what the cache lacks from the
 * server, then merged with what arrived since. F10: incrementally: first the
 * screen it kept and what came after it (the part on screen), restored at
 * once; then, behind it, the events above that screen, put back in front of
 * the window (already stubs); if that second read fails, the window simply
 * has earlier events to load. A read for a window dropped or released again
 * meanwhile is discarded.
 */
function rehydrate(feed: SessionFeed, reader: WindowReader): Promise<void> {
  const running = rehydrating.get(feed)
  if (running && running.token === feed.releases && !feed.released) return running.run
  const { current, read, mine } = reader
  const { from, to, token, screen } = feed.unrelease()
  const stale = () => current() !== feed || feed.releases !== token
  const run = (async () => {
    if (from === null) {
      feed.readBackFailed = false
      feed.restore([], false)
      feed.bump()
      return
    }
    const split = Math.max(from, screen ?? from)
    const near = await readBack(feed, split, to, read, mine, stale)
    if (!near) return
    // F6, F11: a read back that failed, or stopped short of the seq the window
    // had, is not merged (it would leave a silent hole): the window stays
    // released, and the view shows that part could not be loaded, with a retry.
    if (!near.complete) {
      feed.relapse()
      feed.readBackFailed = true
      feed.bump()
      return
    }
    feed.readBackFailed = false
    feed.restore(near.events, split > from)
    feed.bump()
    enforceBudget()
    if (split <= from) return
    // F10: the rest, above the screen, behind it.
    feed.earlierFrom = from
    await readEarlierBack(feed, reader, stale)
  })().finally(() => {
    if (rehydrating.get(feed)?.run === run) rehydrating.delete(feed)
  })
  rehydrating.set(feed, { token, run })
  return run
}

/**
 * F10: the events between where a restored window began (`earlierFrom`) and
 * the screen it read back first, read back and put in front of it. Failed:
 * the window says so (F6: a Retry, or the next show, reads it again). The
 * window moved meanwhile (a live trim): it has earlier events to load instead.
 */
async function readEarlierBack(
  feed: SessionFeed,
  reader: WindowReader,
  stale: () => boolean,
): Promise<void> {
  const from = feed.earlierFrom
  if (from === null) return
  const anchor = feed.earlierAnchor()
  const trims = feed.trims
  if (anchor <= from) {
    feed.earlierFrom = null
    return
  }
  const far = await readBack(feed, from, anchor - 1, reader.read, reader.mine, stale)
  if (!far) return
  if (!far.complete) {
    feed.readBackFailed = true
    feed.bump()
    return
  }
  feed.earlierFrom = null
  feed.readBackFailed = false
  feed.restoreEarlier(anchor, trims, far.events, from)
  feed.bump()
  enforceBudget()
}

/** F10, F6: read the part above the screen again (a show, a Retry). */
function fillEarlier(feed: SessionFeed, reader: WindowReader): Promise<void> {
  const running = rehydrating.get(feed)
  if (running && running.token === feed.releases) return running.run
  const token = feed.releases
  const stale = () => reader.current() !== feed || feed.releases !== token
  const run = readEarlierBack(feed, reader, stale).finally(() => {
    if (rehydrating.get(feed)?.run === run) rehydrating.delete(feed)
  })
  rehydrating.set(feed, { token, run })
  return run
}

/** Batch-5 F11: read a window that failed to read back again (the view's Retry). */
export function retryReadBack(id: string): Promise<void> {
  rehydrateSession(id)
  return settleSession(id)
}

/** Tests: the running read backs of a session's windows. */
export function settleSession(id: string): Promise<void> {
  return Promise.all(windowsOf(id).map((f) => rehydrating.get(f)?.run ?? Promise.resolve())).then(
    () => undefined,
  )
}

/**
 * S58: one budget (MEMORY_BUDGET_BYTES) over every session's held events.
 * Past it, the least recently viewed session that is not on screen gives
 * back first: its oldest held events (never past an open request), then its
 * whole window (a release: the screen it left and its open requests stay). A
 * session on screen is never touched.
 */
function enforceBudget(): void {
  if (heldBytes <= MEMORY_BUDGET_BYTES) return
  const target = MEMORY_BUDGET_BYTES * 0.9
  const viewedAt = (f: SessionFeed) => visibility.get(f.sessionId)?.viewedAt ?? 0
  const candidates = [...feeds.values(), ...drawers.values()]
    .filter((f) => !isShown(f.sessionId) && f.events.length > 0)
    .sort((a, b) => viewedAt(a) - viewedAt(b))
  for (const f of candidates) {
    if (f.evictFront(heldBytes - target) > 0) f.bump()
    if (heldBytes <= target) return
  }
  for (const f of candidates) {
    if (!f.released) {
      // Batch-5 F7: a main thread keeps the screen its owner left, as on the timer.
      f.release(f.scope === "" ? visibility.get(f.sessionId)?.screenFirst : undefined)
      f.bump()
    }
    if (heldBytes <= target) return
  }
}

/** The running "load earlier" per window (a session's, or a drawer's `subKey`), with its feed. */
const loadingEarlier = new Map<string, { feed: SessionFeed; run: Promise<void> }>()
/** D33: a page the moving window no longer abuts is read again this many times at most. */
const EARLIER_ATTEMPTS = 3

/**
 * S56: one page of the events above a window (`before=` its anchor), added in
 * front of it. A page shorter than the limit was the start. D33: a page read
 * for a dropped feed (a closed view or drawer) is discarded; one the window
 * moved away from meanwhile is read again below the new anchor.
 */
function loadEarlierInto(
  key: string,
  current: () => SessionFeed | undefined,
  route: (before: number) => string,
  mine: (e: NodeSessionEvent) => boolean,
): Promise<void> {
  const feed = current()
  // S58: a released window reads back first (it is shown again); nothing to load above it.
  if (!feed || feed.released) return Promise.resolve()
  const running = loadingEarlier.get(key)
  if (running?.feed === feed) return running.run
  const run: Promise<void> = (async () => {
    const api = apiOf()
    if (!api) return
    for (let attempt = 0; attempt < EARLIER_ATTEMPTS; attempt++) {
      const first = feed.earlierAnchor()
      const trims = feed.trims
      const page = await api.get<{ events?: NodeSessionEvent[] }>(route(first))
      if (current() !== feed) return
      const now = Date.now()
      const older = (page?.events ?? [])
        .filter((e) => mine(e) && e.seq < first && !foldsOnly(e))
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ ...e, clientReceivedAt: now }))
      const read = page?.events ?? []
      const below = read.reduce((m, e) => Math.min(m, e.seq), first)
      const more = read.length >= NODE_SESSION_EVENTS_LIMIT && below > 1
      if (feed.prepend(first, trims, older, below, more)) {
        feed.bump()
        return
      }
    }
  })()
    .catch((err) => log.warn({ err, key }, "loading earlier session events failed"))
    .finally(() => {
      if (loadingEarlier.get(key)?.run === run) loadingEarlier.delete(key)
    })
  loadingEarlier.set(key, { feed, run })
  return run
}

/** S56: the main-thread events above the held window, one page (`before=`, `scope=top`). */
export function loadEarlier(id: string): Promise<void> {
  return loadEarlierInto(
    id,
    () => feeds.get(id),
    (before) => SESSION_ROUTES.eventsBefore(id, before),
    (e) => !e.parentToolUseId,
  )
}

/**
 * S56 (batch-4 F6): an open drawer's events above its window, one page
 * (`before=`, `parent=`): a long subagent's earliest events, trimmed from the
 * drawer, load again on request like the main thread's.
 */
export function loadEarlierSubagent(sessionId: string, toolUseId: string): Promise<void> {
  const key = subKey(sessionId, toolUseId)
  return loadEarlierInto(
    key,
    () => drawers.get(key),
    (before) =>
      SESSION_ROUTES.eventsBefore(sessionId, before, NODE_SESSION_EVENTS_LIMIT, {
        parent: toolUseId,
      }),
    (e) => e.parentToolUseId === toolUseId,
  )
}

/**
 * Batch-5 F12: the last few stub payloads read back, so a row scrolling out
 * of view and back does not read again (the server, without IndexedDB). A
 * few entries only: what it holds is outside the budget. Cleared on sign-out.
 */
const PAYLOAD_MEMO_MAX = 16
const payloadMemo = new Map<string, Record<string, unknown>>()

function rememberPayload(key: string, payload: Record<string, unknown>): void {
  payloadMemo.delete(key)
  payloadMemo.set(key, payload)
  while (payloadMemo.size > PAYLOAD_MEMO_MAX) {
    const oldest = payloadMemo.keys().next().value
    if (oldest === undefined) break
    payloadMemo.delete(oldest)
  }
}

/**
 * S56: an elided event's payload, read again by its seq (the range read
 * `after=<seq-1>&limit=1`, in the main thread or, for a drawer, its
 * subagent's `parent`); null when it cannot be read now. Not kept: the row
 * that asked holds it while it is open.
 */
async function fetchEventPayload(
  id: string,
  seq: number,
  parent?: string,
): Promise<Record<string, unknown> | null> {
  const key = `${id}\u0000${parent ?? ""}\u0000${seq}`
  const memo = payloadMemo.get(key)
  if (memo) {
    rememberPayload(key, memo)
    return memo
  }
  // S58: the disk cache first (no network, nothing held), then the server.
  const cached = await diskCache.readOne(id, parent ?? "", seq)
  if (cached?.payload) {
    rememberPayload(key, cached.payload)
    return cached.payload
  }
  const api = apiOf()
  if (!api) return null
  try {
    const page = await api.get<{ events?: NodeSessionEvent[] }>(
      SESSION_ROUTES.events(id, Math.max(0, seq - 1), 1, parent ? { parent } : { top: true }),
    )
    const payload = page?.events?.find((x) => x.seq === seq)?.payload ?? null
    if (payload) rememberPayload(key, payload)
    return payload
  } catch (err) {
    log.warn({ err, sessionId: id, seq }, "reading an elided event failed")
    return null
  }
}

/** S56: an elided tool output, read again by its event's seq. */
export async function fetchEventOutput(
  id: string,
  seq: number,
  parent?: string,
): Promise<string | null> {
  const output = (await fetchEventPayload(id, seq, parent))?.output
  return typeof output === "string" ? output : null
}

/** S58: a long message's whole text, read again by its seq (cache, then server). */
export async function fetchEventText(
  id: string,
  seq: number,
  parent?: string,
): Promise<string | null> {
  const text = (await fetchEventPayload(id, seq, parent))?.text
  return typeof text === "string" ? text : null
}

/** S56: an elided tool input, read again by its call's seq. */
export async function fetchEventInput(
  id: string,
  seq: number,
  parent?: string,
): Promise<unknown | null> {
  const payload = await fetchEventPayload(id, seq, parent)
  return payload && "input" in payload ? payload.input : null
}

/** Reconnect, resume or focus: every watched row again, and its events. */
export async function resyncWatchedSessions(): Promise<void> {
  await Promise.all(
    [...watched.keys()].map(async (id) => {
      await refetchRow(id)
      await pull(id)
      if (isShown(id)) rehydrateSession(id)
    }),
  )
}

let uninstall: (() => void) | null = null

/** Wire the resync bus (socket reconnect, page resume) and window focus. Idempotent. */
export function installSessionStoreSync(): void {
  if (uninstall) return
  const onResync = () => void resyncWatchedSessions()
  const unsubscribe = subscribeResync(onResync)
  const win = typeof window !== "undefined" ? window : null
  win?.addEventListener("focus", onResync)
  uninstall = () => {
    unsubscribe()
    win?.removeEventListener("focus", onResync)
  }
}

/**
 * Sign-out: forget every row and event the previous user's sessions left here.
 * The API getter and the resync wiring stay: bootstrap installs them once per
 * page, and the getter already reads the current client.
 */
export function resetSessionData(): void {
  for (const v of visibility.values()) clearTimeout(v.timer)
  visibility.clear()
  heldBytes = 0
  payloadMemo.clear()
  void clearDiskCache()
  watched.clear()
  pulling.clear()
  pullAgain.clear()
  openSubagents.clear()
  subThrough.clear()
  subPulling.clear()
  subPullAgain.clear()
  loadingEarlier.clear()
  if (feeds.size > 0) {
    feeds.clear()
    setFeedsVersion((v) => v + 1)
  }
  if (drawers.size > 0) {
    drawers.clear()
    setDrawersVersion((v) => v + 1)
  }
  setState({ rows: {} })
  resetStoppedOrphans()
}

onSessionTeardown(resetSessionData)

/** Tests: forget everything, the wiring included. */
export function resetSessionStore(): void {
  uninstall?.()
  uninstall = null
  apiOf = () => null
  resetSessionData()
}
