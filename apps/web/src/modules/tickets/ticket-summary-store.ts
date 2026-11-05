// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket summary store — collapse LRU + WS-driven status updates.
import { createStore, produce } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"

interface SummaryUiState {
  collapsed: Record<string, boolean>
  touchedAt: Record<string, number>
  // backend-projected status (mirrored from ticket:summary_updated WS event)
  statusByTicketId: Record<string, "idle" | "generating" | "error">
}

const MAX_COLLAPSE_ENTRIES = 200
let hydratedKey: string | null = null

const [ticketSummaryStore, setTicketSummaryStore] = createStore<SummaryUiState>({
  collapsed: {},
  touchedAt: {},
  statusByTicketId: {},
})

export { ticketSummaryStore }

function storageKey(): string {
  return `tickets.summaryCollapsed.${userFromToken()?.userId ?? "anonymous"}`
}

function trimEntries(collapsed: Record<string, boolean>, touchedAt: Record<string, number>): void {
  const keep = Object.keys(touchedAt)
    .sort((a, b) => (touchedAt[b] ?? 0) - (touchedAt[a] ?? 0))
    .slice(0, MAX_COLLAPSE_ENTRIES)
  const keepSet = new Set(keep)
  for (const id of Object.keys(collapsed)) {
    if (!keepSet.has(id)) delete collapsed[id]
  }
  for (const id of Object.keys(touchedAt)) {
    if (!keepSet.has(id)) delete touchedAt[id]
  }
}

function persist(): void {
  if (typeof localStorage === "undefined") return
  const payload: Record<string, { collapsed: boolean; lastTouched: number }> = {}
  for (const [ticketId, collapsed] of Object.entries(ticketSummaryStore.collapsed)) {
    payload[ticketId] = {
      collapsed,
      lastTouched: ticketSummaryStore.touchedAt[ticketId] ?? Date.now(),
    }
  }
  localStorage.setItem(storageKey(), JSON.stringify(payload))
}

function hydrate(): void {
  const key = storageKey()
  if (hydratedKey === key) return
  hydratedKey = key
  if (typeof localStorage === "undefined") return
  let collapsed: Record<string, boolean> = {}
  let touchedAt: Record<string, number> = {}
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === "object") {
      for (const [ticketId, value] of Object.entries(parsed as Record<string, any>)) {
        collapsed[ticketId] = !!value?.collapsed
        touchedAt[ticketId] = Number(value?.lastTouched ?? 0)
      }
      trimEntries(collapsed, touchedAt)
    }
  } catch {
    collapsed = {}
    touchedAt = {}
  }
  setTicketSummaryStore(
    produce((s) => {
      s.collapsed = collapsed
      s.touchedAt = touchedAt
    }),
  )
}

export function isCollapsed(ticketId: string): boolean {
  hydrate()
  // Collapsed by DEFAULT: a ticket with no explicit entry renders its summary
  // folded; only an explicit user expand (stored false) opens it.
  return ticketSummaryStore.collapsed[ticketId] ?? true
}

export function toggleSummary(ticketId: string): void {
  hydrate()
  setTicketSummaryStore(
    produce((s) => {
      const wasCollapsed = s.collapsed[ticketId] ?? true
      s.collapsed[ticketId] = !wasCollapsed
      s.touchedAt[ticketId] = Date.now()
      trimEntries(s.collapsed, s.touchedAt)
    }),
  )
  persist()
}

export function handleTicketSummaryEvent(data: any): void {
  if (!data) return
  const id = data.ticketId ?? data.id
  if (!id) return
  setTicketSummaryStore(
    produce((s) => {
      let status = data.status ?? data.summaryStatus
      // A completed-generation broadcast carries the final summary text; if the
      // producer omits the terminal status, treat the presence of a final
      // summary as "idle" so the card never gets stuck on "Generating…".
      if (
        typeof status !== "string" &&
        (typeof data.summary === "string" || typeof data.summaryText === "string")
      ) {
        status = "idle"
      }
      if (typeof status === "string") {
        s.statusByTicketId[id] = status as SummaryUiState["statusByTicketId"][string]
      }
    }),
  )
}

export function resetTicketSummaryStore(): void {
  setTicketSummaryStore({
    collapsed: {},
    touchedAt: {},
    statusByTicketId: {},
  })
  hydratedKey = null
}

onSessionTeardown(resetTicketSummaryStore)
