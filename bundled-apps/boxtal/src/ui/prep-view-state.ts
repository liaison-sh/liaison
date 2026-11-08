// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure decisions for the "To prepare" grid's stale-while-revalidate paint: what to show first,
// whether a background refresh runs, what the banner says, and which rows a refresh drop holds
// for an exit transition instead of yanking out from under the pointer. Extracted the same way
// prep-row-logic.ts extracts pollTick -- this app has no DOM/jsdom harness, so every decision that
// would otherwise only be checkable by eyeballing a render lives here as plain data in, plain data
// out, and PrepGrid.tsx just calls it.

import type { PrepListResult, PrepRow } from "./prep-row-logic"

// ── Cache-first open + unconditional background refresh ─────────────────────

export interface PrepOpenPlan {
  /** What to paint immediately: the cached value if one exists, or null to go straight to a live
   *  read with nothing to show in the meantime. */
  paint: PrepListResult | null
  /**
   * A live read always follows, warm cache or not. This is a constant, not a computed decision,
   * and it is named and returned anyway (rather than just being "the code always calls the
   * fetch") so the ONE THING this whole rework exists to guarantee -- that opening the page never
   * again serves a cache entry and stops there -- is a value a test can pin. The bug this
   * replaces was exactly a cache that served once per mount and then sat there for the life of
   * the tab.
   */
  refreshNow: true
}

export function planPrepListOpen(cached: PrepListResult | null): PrepOpenPlan {
  return { paint: cached, refreshNow: true }
}

// ── The refresh banner + empty-state decision ────────────────────────────────

export type PrepBannerKind = "refreshing" | "empty_refreshing" | "failed"

export interface PrepBanner {
  kind: PrepBannerKind
  message: string
}

export type PrepEmptyState = "none" | "loading" | "load_error"

export interface GridViewStateInput {
  /** Whether the worklist currently has any rows at all (before client-side filtering). */
  hasRows: boolean
  /** A live read is in flight right now, whether the first one or a later background refresh. */
  refreshing: boolean
  /** The most recent read (initial or background) ended in an error. */
  failed: boolean
  /** The server's own `last_sync_at` for the rows on screen, formatted by the caller's own
   *  Date.toLocaleString conventions elsewhere -- this module only needs the raw value to decide
   *  whether it has anything to say about "when". */
  lastSyncAt: string | null
}

export interface GridViewState {
  banner: PrepBanner | null
  empty: PrepEmptyState
}

function syncedAtLabel(lastSyncAt: string | null): string {
  if (!lastSyncAt) return "an earlier sync"
  const d = new Date(lastSyncAt)
  if (Number.isNaN(d.getTime())) return "an earlier sync"
  return d.toLocaleString()
}

/**
 * Decides the banner and the empty-state branch for one render. Five cases, in the order the spec
 * names them:
 *   - refreshing, cached rows shown: say the rows are last known data, say when, say a refresh is
 *     running.
 *   - refreshing, nothing cached: never say "nothing to prepare" -- that is a claim about the
 *     order book, and a refresh that has not landed yet has not earned it. A distinct loading
 *     state instead.
 *   - failed, cached rows present: keep the rows, say the refresh failed and when the shown data
 *     is from.
 *   - failed, nothing cached: the existing "could not load" empty state.
 *   - neither refreshing nor failed: no banner, the caller's own rows/empty rendering decides.
 */
export function gridViewState(input: GridViewStateInput): GridViewState {
  const { hasRows, refreshing, failed, lastSyncAt } = input

  if (failed && !hasRows) return { banner: null, empty: "load_error" }

  if (failed && hasRows) {
    return {
      banner: {
        kind: "failed",
        message: `The refresh failed. Showing last known data from ${syncedAtLabel(lastSyncAt)}.`,
      },
      empty: "none",
    }
  }

  if (refreshing && !hasRows) {
    return {
      banner: {
        kind: "empty_refreshing",
        message: "Nothing is cached yet. The queue is loading.",
      },
      empty: "loading",
    }
  }

  if (refreshing && hasRows) {
    return {
      banner: {
        kind: "refreshing",
        message: `Showing last known data from ${syncedAtLabel(lastSyncAt)}. Refreshing now.`,
      },
      empty: "none",
    }
  }

  return { banner: null, empty: "none" }
}

// ── Row exit transition (mirrors TicketsInbox, apps/web/src/modules/tickets/TicketsInbox.tsx) ──
//
// A refresh that drops or reorders rows must not reflow the table under the operator's cursor.
// TicketsInbox solves the same problem for its own list (EXIT_TRANSITION_MS = 220: a row leaving
// stays rendered, is made non-interactive immediately, and collapses over that window unless it
// reappears first, which cancels the exit). This app cannot import that module (bundled-app
// purity forbids reaching into apps/web), so the same mechanism is reimplemented here: the pure
// merge/cancel decision in `reconcileExitingRows`, with the actual setTimeout scheduling left to
// PrepGrid.tsx (a timer is a side effect, not a decision).

export const EXIT_TRANSITION_MS = 220

export interface ExitReconcileResult {
  /** The list to render this tick: `current`, plus any row still mid-exit re-inserted at ~its
   *  last known position. */
  merged: PrepRow[]
  /** Keys newly dropped by `current` this tick that were not already exiting -- start their
   *  transition. */
  toExit: string[]
  /** Keys that were exiting but are back in `current` -- cancel their pending removal. */
  toCancel: string[]
}

export function reconcileExitingRows(
  current: PrepRow[],
  prevDisplay: PrepRow[],
  exiting: ReadonlySet<string>,
): ExitReconcileResult {
  const currentByKey = new Map(current.map((row) => [row.order_key, row]))
  const prevIndexByKey = new Map(prevDisplay.map((row, i) => [row.order_key, i]))

  const toCancel: string[] = []
  for (const key of exiting) if (currentByKey.has(key)) toCancel.push(key)

  const merged: PrepRow[] = [...current]
  const toExit: string[] = []
  for (const row of prevDisplay) {
    if (currentByKey.has(row.order_key)) continue
    if (!exiting.has(row.order_key)) toExit.push(row.order_key)
    const idx = prevIndexByKey.get(row.order_key) ?? merged.length
    merged.splice(Math.min(idx, merged.length), 0, row)
  }

  return { merged, toExit, toCancel }
}

/** A row mid-exit is held on screen but must not be actionable: this is the one predicate that
 *  decides it, so the "not interactive" half of the requirement is itself a pinned fact instead
 *  of a class name nobody checks. */
export function rowIsInteractive(exiting: boolean): boolean {
  return !exiting
}

// ── Per-row UI state that survives a row re-read ─────────────────────────────

/**
 * Flip one row's open/closed flag in a set keyed by `order_key`.
 *
 * Why the grid keeps a row's folds HERE, keyed by order key, and not in a signal created inside
 * the row: `<For>` keys rows by object reference, and every read of a row (the background refresh
 * that follows a cache-first paint, a poll tick, a mutation's own re-read) hands back a NEW
 * object for it. The row's DOM is then rebuilt and any signal created inside it starts over: a
 * fold the person had just opened snapped shut under their pointer when the refresh landed.
 */
export function toggleRowKey(keys: ReadonlySet<string>, orderKey: string, open?: boolean): Set<string> {
  const next = new Set(keys)
  const want = open ?? !next.has(orderKey)
  if (want) next.add(orderKey)
  else next.delete(orderKey)
  return next
}
