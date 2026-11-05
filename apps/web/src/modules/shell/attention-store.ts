// SPDX-License-Identifier: FSL-1.1-ALv2

import type { AttentionFeedResponse, AttentionItem, AttentionProviderError } from "@liaison/shared"
import { createStore, reconcile } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { announceApiReady } from "~/lib/api-ready"

type AttentionState = {
  items: AttentionItem[]
  errors: AttentionProviderError[]
  loading: boolean
  /** Epoch ms of the last successful fetch — drives the "UPDATED Xm AGO" meta-line. */
  lastFetchedAt: number | null
}

const [state, setState] = createStore<AttentionState>({
  items: [],
  errors: [],
  loading: false,
  lastFetchedAt: null,
})

/**
 * The safety-net poll of the attention feed, per visible tab.
 *
 * The feed is kept fresh by live invalidation: every WS frame that can move it
 * (a new message, approval and scope requests, mail conversations, the
 * reader's own read marks from any device) calls `markStaleAndReload`, and a
 * tab coming back to the foreground reloads too. It cannot be removed
 * outright: part of the feed is computed at read time by the apps' attention
 * providers (due and overdue work, waiting tickets), which changes with the
 * clock and emits no event. At 60 s it cost ~200 feed requests per 30 min for
 * five users (design audit 2026-09-30, finding 18); 5 min bounds how stale a
 * time-driven row can get while the live paths carry everything else.
 */
export const ATTENTION_POLL_MS = 300_000

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let pollInterval: ReturnType<typeof setInterval> | null = null
let visibilityHandler: (() => void) | null = null
let apiRef: ApiClient | null = null

/**
 * Items the reader just resolved here (an approval they decided from its row),
 * by id, with when. The row leaves the feed at once instead of after the next
 * reload (a 2 s debounce plus the fetch: under load the decided row lingered
 * for seconds and read as an Approve that did nothing). A reload that STARTED
 * before the decision may still carry the item, so such a reload does not
 * bring it back; the first reload started after it is the server's word again.
 */
const resolvedLocally = new Map<string, number>()
/** Every load gets the next number; a decision records the latest one started. */
let loadSeq = 0

function resolveLocally(id: string): void {
  resolvedLocally.set(id, loadSeq)
  setState("items", (items) => items.filter((i) => i.id !== id))
}

async function load(api: ApiClient): Promise<void> {
  setState("loading", true)
  const seq = ++loadSeq
  try {
    const res = await api.getEnvelope<AttentionFeedResponse>("/attention-items")
    const hide = new Set<string>()
    for (const [id, at] of resolvedLocally) {
      if (seq <= at) hide.add(id)
      else resolvedLocally.delete(id)
    }
    if (hide.size > 0) res.data.items = res.data.items.filter((i) => !hide.has(i.id))
    // RECONCILE by id, never a wholesale replace. `<For>` keys rows by object
    // REFERENCE, so handing it a fresh array unmounts and remounts every row —
    // and this feed reloads on a 5 min poll, on tab focus, and on every WS echo.
    // An approval row expands IN PLACE into the full ApprovalCard, so a remount
    // threw away the operator's expansion AND the draft they were editing, every
    // minute, mid-sentence (prod, reported 2026-08-05: "constamment interrompu
    // par ce qui semble être un refresh ... n'enregistre pas les modifications").
    // Reconcile patches matching rows in place, so an untouched row keeps its
    // identity and its component state survives the refresh.
    setState("items", reconcile(res.data.items, { key: "id" }))
    setState({
      errors: res.data.errors,
      loading: false,
      lastFetchedAt: Date.now(),
    })
  } catch (err) {
    setState("loading", false)
    setState("errors", [
      {
        app: "_aggregator",
        reason: "error",
        message: (err as Error)?.message ?? "fetch failed",
      },
    ])
  }
}

// Debounce widened 500ms -> 2000ms: a reconnect/resync burst plus per-ticket WS
// echoes previously fired a refetch storm. 2s still reads as instant to a human
// while coalescing the burst into a single reload.
const MARK_STALE_DEBOUNCE_MS = 2_000

// Max-wait cap: this is a pure TRAILING debounce (clears + restarts on every
// call), so sustained traffic faster than one call per MARK_STALE_DEBOUNCE_MS
// starves the reload indefinitely — the `attention-invalidation` WS handler
// (bootstrap.ts) calls this on EVERY message:create, so a hot thread can do
// exactly that. Force a load once this many ms have elapsed since the first
// call in the current burst, even if calls keep arriving.
const MARK_STALE_MAX_WAIT_MS = 5_000

let firstPendingMarkStaleAt: number | null = null

function markStaleAndReload(api: ApiClient): void {
  const now = Date.now()
  if (firstPendingMarkStaleAt === null) firstPendingMarkStaleAt = now
  if (now - firstPendingMarkStaleAt >= MARK_STALE_MAX_WAIT_MS) {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    firstPendingMarkStaleAt = null
    void load(api)
    return
  }
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    firstPendingMarkStaleAt = null
    void load(api)
  }, MARK_STALE_DEBOUNCE_MS)
}

function setAttentionApi(api: ApiClient | null): void {
  apiRef = api
  // Final walk F3: a store waiting for the client loads now (lib/api-ready.ts).
  if (api) announceApiReady()
}

function getAttentionApi(): ApiClient | null {
  return apiRef
}

const isBrowser = typeof document !== "undefined" && typeof document.addEventListener === "function"

export const attentionStore = {
  get items() {
    return state.items
  },
  get errors() {
    return state.errors
  },
  get loading() {
    return state.loading
  },
  get lastFetchedAt() {
    return state.lastFetchedAt
  },
  attentionCount: () => state.items.length,
  attentionForApp: (app: string) => state.items.filter((i) => i.app === app),
  load,
  markStaleAndReload,
  resolveLocally,
  start(api: ApiClient) {
    if (pollInterval) clearInterval(pollInterval)
    if (isBrowser && visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler)
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    firstPendingMarkStaleAt = null
    apiRef = api
    void load(api)
    pollInterval = setInterval(() => {
      if (!isBrowser || document.visibilityState === "visible") {
        markStaleAndReload(api)
      }
    }, ATTENTION_POLL_MS)
    if (isBrowser) {
      visibilityHandler = () => {
        if (document.visibilityState === "visible") markStaleAndReload(api)
      }
      document.addEventListener("visibilitychange", visibilityHandler)
    }
  },
  stop() {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    firstPendingMarkStaleAt = null
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    if (isBrowser && visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler)
      visibilityHandler = null
    }
    apiRef = null
    setState({ items: [], errors: [], loading: false, lastFetchedAt: null })
  },
  _setForTest(s: Partial<AttentionState>) {
    setState(s)
  },
}

export { getAttentionApi, setAttentionApi }
