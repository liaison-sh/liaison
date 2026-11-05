// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { decideErrorToast } from "~/modules/approvals/decide-error"
import { isDecisionUndone, queueDecision } from "~/modules/approvals/decision-queue"

export interface ScopeRequestRow {
  id: string
  requestedBy: string
  requestedByName?: string | null
  requestedByType: "user" | "agent"
  /** The agent that asked, when an agent turn filed this. */
  agentId?: string | null
  agentName?: string | null
  targetUserId: string
  requestedScopes: string[]
  grantedScopes?: string[] | null
  reason?: string | null
  status: "pending" | "approved" | "denied" | "expired" | "cancelled"
  decisionReason?: string | null
  createdAt: string
  updatedAt: string
}

interface ScopeRequestsState {
  byId: Record<string, ScopeRequestRow>
  ids: string[]
  loading: boolean
}

const [state, setState] = createStore<ScopeRequestsState>({
  byId: {},
  ids: [],
  loading: false,
})

let pollInterval: ReturnType<typeof setInterval> | null = null
const inFlightDecide = new Set<string>()
const isBrowser = typeof document !== "undefined"
let visibilityHandler: (() => void) | null = null

function upsert(s: ScopeRequestsState, row: ScopeRequestRow): void {
  if (!s.byId[row.id]) s.ids.push(row.id)
  s.byId[row.id] = row
}

/**
 * Prune rows whose status has left "pending" (approved/denied/expired/
 * cancelled) once we hear about the terminal state from a poll response —
 * the endpoint only ever returns `status=pending` rows, so anything
 * previously loaded that's absent from a fresh poll has moved on. Without
 * this the `byId`/`ids` maps only ever grow across a long admin session.
 */
function pruneNoLongerPending(s: ScopeRequestsState, freshRows: ScopeRequestRow[]): void {
  const freshIds = new Set(freshRows.map((r) => r.id))
  for (const id of [...s.ids]) {
    if (freshIds.has(id)) continue
    const row = s.byId[id]
    if (row && row.status !== "pending") {
      delete s.byId[id]
      s.ids = s.ids.filter((existingId) => existingId !== id)
    }
  }
}

export function pendingRequests(): ScopeRequestRow[] {
  return state.ids
    .map((id) => state.byId[id])
    .filter((r): r is ScopeRequestRow => Boolean(r) && r.status === "pending")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

export function getById(id: string): ScopeRequestRow | undefined {
  return state.byId[id]
}

export async function load(api: ApiClient): Promise<void> {
  setState("loading", true)
  try {
    const rows = await api.get<ScopeRequestRow[]>("/scope-requests?status=pending")
    setState(
      produce((s) => {
        for (const row of rows) upsert(s, row)
        pruneNoLongerPending(s, rows)
      }),
    )
  } finally {
    setState("loading", false)
  }
}

const inFlightLoads = new Map<string, Promise<ScopeRequestRow | undefined>>()

/** One request by id, read once and kept: the card a conversation shows under the agent's ask. */
export function ensureLoaded(api: ApiClient, id: string): Promise<ScopeRequestRow | undefined> {
  const existing = state.byId[id]
  if (existing) return Promise.resolve(existing)
  const inFlight = inFlightLoads.get(id)
  if (inFlight) return inFlight
  const promise = api
    .get<ScopeRequestRow>(`/scope-requests/${id}`)
    .then((row) => {
      if (row?.id) setState(produce((s) => upsert(s, row)))
      return row
    })
    .finally(() => inFlightLoads.delete(id))
  inFlightLoads.set(id, promise)
  return promise
}

export function markStaleAndReload(api: ApiClient): void {
  void load(api)
}

/**
 * Approve or deny a request. On success the row's status is advanced locally so
 * the deciding admin gets instant feedback (the WS broadcast that follows is a
 * no-op merge). On failure the error text (e.g. "Cannot approve: you don't hold
 * …") is returned so the caller can surface it inline.
 */
export async function decide(
  api: ApiClient,
  id: string,
  decision: "approve" | "deny",
  reason?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (inFlightDecide.has(id)) return { ok: true }
  inFlightDecide.add(id)
  try {
    // Failures surface inline (e.g. "you don't hold <scope>"); postDecision
    // skips the global toast so an admin lacking the scope isn't also offered
    // to request it.
    // Behind the Undo window (decision-queue.ts).
    await queueDecision<{ status: "approved" | "denied" }>(
      api,
      "scope-request",
      id,
      decision === "deny" ? { decision, reason } : { decision },
    )
    // NOTE: we deliberately do NOT advance the store row's status here. The item
    // component surfaces its own "approved/denied" label locally so it stays
    // mounted (a status change would drop it from `pendingRequests()` and unmount
    // the row mid-feedback). The next poll / WS `update` removes it for real.
    return { ok: true }
  } catch (err) {
    // Undone: nothing was sent and the row stays as it was.
    if (isDecisionUndone(err)) return { ok: false, error: "" }
    // A server fault's message is the bare "Internal server error"; the shared
    // mapping names the failure and its reference instead.
    const error =
      err instanceof ApiError && err.status >= 500
        ? decideErrorToast(err).toast.message
        : err instanceof Error
          ? err.message
          : "Decision failed"
    return { ok: false, error }
  } finally {
    inFlightDecide.delete(id)
  }
}

export function handleWsCreate(row: ScopeRequestRow): void {
  if (!row?.id) return
  setState(produce((s) => upsert(s, row)))
}

export function handleWsUpdate(row: ScopeRequestRow): void {
  if (!row?.id) return
  setState(
    produce((s) => {
      if (s.byId[row.id]) s.byId[row.id] = row
    }),
  )
}

export const scopeRequestsStore = {
  get loading() {
    return state.loading
  },
  pendingRequests,
  getById,
  load,
  ensureLoaded,
  decide,
  markStaleAndReload,
  handleWsCreate,
  handleWsUpdate,
  start(api: ApiClient) {
    if (pollInterval) clearInterval(pollInterval)
    if (isBrowser && visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler)
    }
    void load(api)
    pollInterval = setInterval(() => {
      if (!isBrowser || document.visibilityState === "visible") {
        void load(api)
      }
    }, 60_000)
    if (isBrowser) {
      visibilityHandler = () => {
        if (document.visibilityState === "visible") void load(api)
      }
      document.addEventListener("visibilitychange", visibilityHandler)
    }
  },
  stop() {
    if (pollInterval) {
      clearInterval(pollInterval)
      pollInterval = null
    }
    if (isBrowser && visibilityHandler) {
      document.removeEventListener("visibilitychange", visibilityHandler)
      visibilityHandler = null
    }
    setState({ byId: {}, ids: [], loading: false })
  },
  _setForTest(rows: ScopeRequestRow[]) {
    setState(
      produce((s) => {
        for (const row of rows) upsert(s, row)
      }),
    )
  },
}

export function resetScopeRequestsStore(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  if (isBrowser && visibilityHandler) {
    document.removeEventListener("visibilitychange", visibilityHandler)
    visibilityHandler = null
  }
  inFlightDecide.clear()
  setState({ byId: {}, ids: [], loading: false })
}

onSessionTeardown(resetScopeRequestsStore)
