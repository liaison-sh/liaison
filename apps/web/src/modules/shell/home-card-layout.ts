// SPDX-License-Identifier: FSL-1.1-ALv2
// Home card order/collapse store (Task 8, liaison-messaging-visibility).
//
// Server-persisted via the dedicated `PUT /user/preferences/home-cards`
// partial endpoint (Task 7) — never the full-replace `PUT /user/preferences`,
// which would null this field on every Settings -> Attention save (the same
// trap `updateTheme` documents). Optimistic local update on every reorder /
// collapse toggle, with a debounced PUT so a burst of drags fires exactly one
// request.

import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export const CARD_IDS = ["approvals", "messages", "mail", "feed"] as const
export type CardId = (typeof CARD_IDS)[number]

const DEFAULT_ORDER: CardId[] = [...CARD_IDS]
const KNOWN_IDS = new Set<string>(CARD_IDS)

export interface HomeCardLayoutPayload {
  order: string[]
  collapsed: string[]
}

interface HomeCardLayoutState {
  order: CardId[]
  collapsed: CardId[]
}

const [state, setState] = createStore<HomeCardLayoutState>({
  order: [...DEFAULT_ORDER],
  collapsed: [],
})

/** Unknown ids (older client, forward/backward compat) are dropped from the
 *  displayed order; any known id missing from the persisted order is appended
 *  in its default-order position — a card can never silently disappear. */
function normalizeOrder(persisted: string[] | undefined | null): CardId[] {
  const known = (persisted ?? []).filter((id): id is CardId => KNOWN_IDS.has(id))
  const missing = DEFAULT_ORDER.filter((id) => !known.includes(id))
  return [...known, ...missing]
}

function normalizeCollapsed(persisted: string[] | undefined | null): CardId[] {
  return (persisted ?? []).filter((id): id is CardId => KNOWN_IDS.has(id))
}

export function cardOrder(): CardId[] {
  return state.order
}

export function isCardCollapsed(id: CardId): boolean {
  return state.collapsed.includes(id)
}

let apiRef: ApiClient | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const PERSIST_DEBOUNCE_MS = 1_000

function persist(): void {
  if (!apiRef) return
  if (debounceTimer) clearTimeout(debounceTimer)
  const api = apiRef
  // Snapshot the payload NOW (call time), not when the timer fires: a
  // concurrent hydrateHomeCardLayout() (Home remount within the debounce
  // window) can no longer smuggle stale server data into this PUT by
  // mutating `state` out from under a closure that reads it late.
  const payload: HomeCardLayoutPayload = {
    order: [...state.order],
    collapsed: [...state.collapsed],
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    api.put("/user/preferences/home-cards", payload).catch(() => {
      // Non-critical — local order is kept; the next change retries the PUT.
    })
  }, PERSIST_DEBOUNCE_MS)
}

/** Called once at Home mount with the API client + the server's current
 *  layout (null for a fresh user, or a stale/unknown-id row from an older
 *  client). Does NOT itself trigger a PUT — hydration is not a user change.
 *
 *  Skips overwriting local state while a debounced PUT is pending: that PUT
 *  already carries the user's latest reorder/collapse (as of `persist()`'s
 *  own snapshot, see above), so applying an older server snapshot here would
 *  clobber it in the store between the change and the PUT actually landing
 *  (e.g. a tab close+reopen, or this GET resolving late on first mount). */
export function hydrateHomeCardLayout(
  api: ApiClient,
  layout: HomeCardLayoutPayload | null | undefined,
): void {
  apiRef = api
  if (debounceTimer) return
  if (!layout) {
    setState({ order: [...DEFAULT_ORDER], collapsed: [] })
    return
  }
  setState({
    order: normalizeOrder(layout.order),
    collapsed: normalizeCollapsed(layout.collapsed),
  })
}

/** Move `draggedId` to the position of `targetId` within the current order. */
export function reorderCards(draggedId: CardId, targetId: CardId): void {
  if (draggedId === targetId) return
  setState(
    produce((s) => {
      const wasBefore = s.order.indexOf(draggedId) < s.order.indexOf(targetId)
      const next = s.order.filter((id) => id !== draggedId)
      const targetIdx = next.indexOf(targetId)
      if (targetIdx === -1) return
      next.splice(wasBefore ? targetIdx + 1 : targetIdx, 0, draggedId)
      s.order = next
    }),
  )
  persist()
}

export function toggleCardCollapsed(id: CardId): void {
  setState(
    produce((s) => {
      const idx = s.collapsed.indexOf(id)
      if (idx === -1) s.collapsed.push(id)
      else s.collapsed.splice(idx, 1)
    }),
  )
  persist()
}

// --- Drag interaction state — shared across HomeCard instances so the
// dragged/drop-target styling and the drop handler live in one place. ---
const [draggedId, setDraggedId] = createSignal<CardId | null>(null)
const [dropTargetId, setDropTargetId] = createSignal<CardId | null>(null)

export { draggedId, dropTargetId }

export function beginCardDrag(id: CardId): void {
  setDraggedId(id)
}

export function setCardDropTarget(id: CardId | null): void {
  setDropTargetId(id)
}

export function endCardDrag(): void {
  setDraggedId(null)
  setDropTargetId(null)
}

/** Session teardown (I-WEB-1): reset to defaults and forget the API ref /
 *  pending timer / drag state on logout, same as every other module-scope
 *  store, so the next login's Home mount hydrates cleanly instead of
 *  inheriting the previous user's order/collapse or an in-flight PUT. */
export function resetHomeCardLayout(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  apiRef = null
  setState({ order: [...DEFAULT_ORDER], collapsed: [] })
  setDraggedId(null)
  setDropTargetId(null)
}
onSessionTeardown(resetHomeCardLayout)
