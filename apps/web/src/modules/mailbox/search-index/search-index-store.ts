// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the client search index can currently answer, and the one sentence that
// says so (blueprint task 10.4, spec section 5.5).
//
// The invariant this module carries: there is NO state in which search silently
// answers less than it claims. Building, rebuilding, reduced to a window,
// reduced to metadata, or locked, each has a banner. "No matches" is only ever
// allowed to mean "no matches", which is exactly what makes it trustworthy.

import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { IndexMode } from "~/modules/mailbox/search-index/adapter"

export type SearchIndexStatus =
  | "idle"
  | "locked"
  | "building"
  | "rebuilding"
  | "ready"
  | "reduced-window"
  | "metadata-only"
  /** The index cannot be built at all here, so search is off rather than empty. */
  | "unavailable"

export type SearchIndexDegradeReason = "quota" | "eviction" | "unavailable"

interface SearchIndexState {
  status: SearchIndexStatus
  mode: IndexMode
  indexed: number
  total: number | null
  windowMonths: number | null
  reason: SearchIndexDegradeReason | null
  /** True only when a search over this index may be presented as complete. */
  complete: boolean
}

const initial: SearchIndexState = {
  status: "idle",
  mode: "full",
  indexed: 0,
  total: null,
  windowMonths: null,
  reason: null,
  complete: false,
}

const [searchIndexStore, setSearchIndexStore] = createStore<SearchIndexState>({ ...initial })

export { searchIndexStore }

export function resetSearchIndexStore(): void {
  setSearchIndexStore({ ...initial })
}

export function reportIndexReady(): void {
  setSearchIndexStore({
    status: "ready",
    mode: "full",
    windowMonths: null,
    reason: null,
    complete: true,
  })
}

export function reportIndexBuildProgress(progress: {
  indexed: number
  total: number | null
  phase: "building" | "incremental" | "done"
}): void {
  if (progress.phase === "done") {
    reportIndexReady()
    setSearchIndexStore({ indexed: progress.indexed, total: progress.total })
    return
  }
  setSearchIndexStore({
    status: "building",
    indexed: progress.indexed,
    total: progress.total,
    complete: false,
  })
}

/** The index was there last session and is not now. A cache miss, not damage. */
export function reportIndexRebuilding(): void {
  setSearchIndexStore({ status: "rebuilding", reason: "eviction", complete: false })
}

/**
 * The index could not be built here at all: this deployment has no sealed
 * listing to read, or it refused. Search is then UNAVAILABLE, which is a
 * different sentence from "no matches" and the only honest one, since an
 * unbuilt index would answer every query with nothing.
 */
export function reportIndexUnavailable(): void {
  setSearchIndexStore({ status: "unavailable", reason: "unavailable", complete: false })
}

export function reportIndexLocked(): void {
  setSearchIndexStore({ status: "locked", complete: false })
}

export function reportIndexDegraded(input: {
  mode: "metadata-only" | "reduced-window"
  reason: SearchIndexDegradeReason
  windowMonths?: number
}): void {
  setSearchIndexStore({
    status: input.mode,
    mode: input.mode === "metadata-only" ? "metadata-only" : "full",
    reason: input.reason,
    windowMonths: input.windowMonths ?? null,
    complete: false,
  })
}

export interface SearchIndexBanner {
  status: SearchIndexStatus
  text: string
}

/** `null` means, and only means, that search is complete. */
export function searchIndexBanner(): SearchIndexBanner | null {
  const state = searchIndexStore
  switch (state.status) {
    case "building": {
      const of = state.total != null ? ` ${state.indexed} of ${state.total} messages` : ""
      return {
        status: "building",
        text: `Building your search index on this device. Search covers what has been indexed so far,${of}.`,
      }
    }
    case "rebuilding":
      return {
        status: "rebuilding",
        text: "Rebuilding your search index. This browser cleared it to free space, so results are incomplete until the rebuild finishes.",
      }
    case "metadata-only":
      return {
        status: "metadata-only",
        text: "There is not enough room on this device to search message text. Search still covers senders, dates, labels and attachment filenames.",
      }
    case "reduced-window":
      return {
        status: "reduced-window",
        text: `There is not enough room on this device for the whole mailbox, so search covers the last ${state.windowMonths ?? 12} months. Older mail is still there, it is just not searchable here.`,
      }
    case "unavailable":
      return {
        status: "unavailable",
        text: "Searching the text of your encrypted mail is not available on this device. Everything is still here to read, and searching by sender, date or label still works.",
      }
    case "locked":
      return {
        status: "locked",
        text: "Unlock your mailbox to search what is in it. Only you can open it, so the search runs here rather than on our servers.",
      }
    default:
      return null
  }
}

onSessionTeardown(resetSearchIndexStore)
