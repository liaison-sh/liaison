// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A trail of every time MainPanel builds or tears down a tab's content, for
// tests that need to say WHY a tab body was rebuilt (a visual test that saw a
// skeleton again 150 ms after the page had loaded). It is off unless a test
// installed the trail array first (`window.__LIAISON_TAB_TRAIL__ = []`, from a
// Playwright init script or a unit test), so in production every call here is
// one property read and returns; nothing is recorded and no effect is created.
//
// Three things can rebuild a tab's content in MainPanel, and each is traced:
//   - "for-item":    the `<For>` item for the tab was recreated (its store entry
//                    changed identity), which rebuilds the wrapper and all below.
//   - "active-gate": the `hasTabBeenActive` gate (`<Show when={everActive()}>`)
//                    flipped, which builds or drops the whole tab body.
//   - "keyed-show":  the keyed `<Show>` on the registered component re-keyed (the
//                    registry handed back a different component), which rebuilds
//                    the page itself.

import { createEffect, createMemo, onCleanup, untrack } from "solid-js"

export type TabTrailCause = "for-item" | "active-gate" | "keyed-show"
export type TabTrailEvent = "created" | "disposed" | "source-changed"

export interface TabTrailEntry {
  /** Wall-clock time, HH:MM:SS.mmm, so it lines up with a Playwright trail. */
  at: string
  tab: string
  cause: TabTrailCause
  event: TabTrailEvent
  detail?: string
}

declare global {
  interface Window {
    __LIAISON_TAB_TRAIL__?: TabTrailEntry[]
  }
}

function trailArray(): TabTrailEntry[] | null {
  if (typeof window === "undefined") return null
  return window.__LIAISON_TAB_TRAIL__ ?? null
}

/** True when a test installed the trail. */
export function tabTrailActive(): boolean {
  return trailArray() !== null
}

function record(
  tab: string,
  cause: TabTrailCause,
  event: TabTrailEvent,
  detail: string | undefined,
): void {
  const trail = trailArray()
  if (!trail) return
  trail.push({ at: new Date().toISOString().slice(11, 23), tab, cause, event, detail })
}

/**
 * Call inside the reactive scope being watched: records its creation now and
 * its disposal when the owner cleans up. Returns null so it can sit in JSX. A scope that is created twice for the
 * same tab with a disposal between is a rebuild.
 */
export function traceTabScope(tabId: string, cause: TabTrailCause, detail?: string): null {
  if (!tabTrailActive()) return null
  record(tabId, cause, "created", detail)
  onCleanup(() => record(tabId, cause, "disposed", detail))
  return null
}

/**
 * Records every change of the reactive source behind a cause (the gate's
 * value, the registered component), with the old and new value as text. The
 * first read is not a change. Creates no effect when the trail is off.
 */
export function traceTabSource(
  tabId: string,
  cause: TabTrailCause,
  source: () => unknown,
  describe: (value: unknown) => string = String,
): void {
  if (!tabTrailActive()) return
  // A memo, so a signal that fires without the value changing is not a change.
  const value = createMemo(source)
  let previous = untrack(value)
  createEffect(() => {
    const next = value()
    if (next === previous) return
    record(tabId, cause, "source-changed", `${describe(previous)} -> ${describe(next)}`)
    previous = next
  })
}

/** The trail as lines, oldest first (what a failing test attaches). */
export function formatTabTrail(trail: readonly TabTrailEntry[]): string {
  return trail
    .map((e) => `${e.at} ${e.tab} ${e.cause} ${e.event}${e.detail ? ` ${e.detail}` : ""}`)
    .join("\n")
}
