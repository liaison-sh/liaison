// SPDX-License-Identifier: FSL-1.1-ALv2
// The apps a person hid from their sidebar (0293): the desktop and tablet rail
// and the phone Work list leave them out. Search, the command palette, links,
// tours, Settings and notifications still reach every app: hiding is a display
// preference, never access.
//
// Server-persisted per person through the dedicated
// `PUT /user/preferences/hidden-apps` partial endpoint, never the full-replace
// `PUT /user/preferences` (the trap home-card-layout.ts documents), so another
// device shows the same sidebar. Read once per session at startup. A change
// made elsewhere (another device, an admin, the person's agent) arrives as a
// `kernel:read_state` frame of kind `hidden_sidebar_apps` and is applied as is.

import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface PreferencesApi {
  get: <T>(path: string) => Promise<T>
  put: (path: string, body: unknown) => Promise<unknown>
}

const [hidden, setHidden] = createSignal<string[]>([])
let hydration: Promise<void> | null = null
let changedLocally = false
let boundApi: PreferencesApi | undefined
// Bumped at teardown: an answer started under a previous session is dropped.
let epoch = 0
// Saves go out one at a time, each carrying the list as it is when it leaves,
// so the last one stored is the last change made. `confirmed` is the list the
// server last stored, which a failed save falls back to.
let saveChain: Promise<unknown> = Promise.resolve()
let pendingSaves = 0
let confirmed: string[] = []

function readList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((e): e is string => typeof e === "string")
}

/** The ids hidden from the sidebar, in the order they were hidden. */
export function hiddenSidebarApps(): string[] {
  return hidden()
}

export function isHiddenFromSidebar(id: string): boolean {
  return hidden().includes(id)
}

/** Fetch the person's list once per session. A local change made while the
 *  GET is in flight wins over the (older) server answer. */
export function hydrateSidebarVisibility(api: PreferencesApi | undefined): Promise<void> {
  if (!api) return Promise.resolve()
  boundApi = api
  if (hydration) return hydration
  const started = epoch
  hydration = api
    .get<{ hiddenSidebarApps?: unknown }>("/user/preferences")
    .then((prefs) => {
      if (started !== epoch || changedLocally) return
      confirmed = readList(prefs?.hiddenSidebarApps) ?? []
      setHidden(confirmed)
    })
    .catch(() => {
      // Non-critical: nothing hidden for now, the next session retries.
    })
  return hydration
}

/**
 * Replace the whole list. Optimistic; the PUT carries the full list. `api`
 * defaults to the client the session hydrated with. Resolves false when the
 * save failed: the list goes back to what the server last stored (unless a
 * newer change is already on its way) and the caller says so.
 */
export function setHiddenSidebarApps(list: string[], api?: PreferencesApi): Promise<boolean> {
  changedLocally = true
  setHidden([...new Set(list)])
  const client = api ?? boundApi
  if (!client) return Promise.resolve(false)
  const started = epoch
  pendingSaves += 1
  const save = saveChain.then(() => {
    if (started !== epoch) return false
    return client
      .put("/user/preferences/hidden-apps", { hiddenSidebarApps: hidden() })
      .then((res) => {
        if (started !== epoch) return true
        const stored = readList(
          (res as { hiddenSidebarApps?: unknown } | null | undefined)?.hiddenSidebarApps,
        )
        confirmed = stored ?? [...hidden()]
        return true
      })
      .catch(() => {
        if (started === epoch && pendingSaves === 1) setHidden(confirmed)
        return false
      })
  })
  saveChain = save
  return save.finally(() => {
    if (started === epoch) pendingSaves -= 1
  })
}

export function hideFromSidebar(id: string, api?: PreferencesApi): Promise<boolean> {
  if (isHiddenFromSidebar(id)) return Promise.resolve(true)
  return setHiddenSidebarApps([...hidden(), id], api)
}

export function showInSidebar(id: string, api?: PreferencesApi): Promise<boolean> {
  if (!isHiddenFromSidebar(id)) return Promise.resolve(true)
  return setHiddenSidebarApps(
    hidden().filter((e) => e !== id),
    api,
  )
}

/** A change made elsewhere, relayed over the socket: the list as stored. While
 *  one of this window's own saves is on its way, the frame is (or is older
 *  than) its echo and the local list already holds the newer state. */
export function applyRemoteSidebarVisibility(data: Record<string, unknown>): void {
  const list = readList(data.hiddenSidebarApps)
  if (!list) return
  confirmed = list
  if (pendingSaves > 0) return
  changedLocally = true
  setHidden(list)
}

/** Session teardown: the next login reads its own list. */
export function resetSidebarVisibility(): void {
  epoch += 1
  hydration = null
  changedLocally = false
  boundApi = undefined
  saveChain = Promise.resolve()
  pendingSaves = 0
  confirmed = []
  setHidden([])
}
onSessionTeardown(resetSidebarVisibility)
