// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Apps this person cannot use in the workspace (S19, S20): turned Off or
// removed by an admin, or restricted to other roles and people. Fed by
// `unavailableApps` on `GET /api/apps/manifests` (which already omits their
// entries), and refreshed when the server broadcasts `kernel:org_app:update`.
// An in-tree app the shell registers itself keeps its registration, so an open
// tab still resolves and renders the unavailable notice; what goes is its nav.
import { createSignal } from "solid-js"

const [unavailableApps, setUnavailableAppsSignal] = createSignal<ReadonlySet<string>>(new Set())

/** Reactive: is this app unavailable to the viewer? `kernel` never is. */
export function isAppUnavailable(appId: string | undefined): boolean {
  if (!appId || appId === "kernel") return false
  return unavailableApps().has(appId)
}

/** Replace the set (manifest sync, session teardown, tests). */
export function setUnavailableApps(names: readonly string[]): void {
  setUnavailableAppsSignal(new Set(names))
}

// The apps this person can use changed under the open session: a request was
// refused because they lost an app (`403 app_restricted`, `410 app_disabled`),
// or this admin added, removed or turned an app On or Off. The shell resyncs
// its manifests so the app's entry comes or goes at once. The API client and
// the workspace app store report it; the bootstrap listens.
const appsChangedListeners = new Set<() => void>()

/** Run `fn` whenever the apps this person can use may have changed. */
export function onAppsChanged(fn: () => void): () => void {
  appsChangedListeners.add(fn)
  return () => appsChangedListeners.delete(fn)
}

/** Report that the apps this person can use may have changed. */
export function noteAppsChanged(): void {
  for (const fn of appsChangedListeners) fn()
}
