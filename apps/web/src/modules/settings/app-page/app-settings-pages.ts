// SPDX-License-Identifier: FSL-1.1-ALv2
// Which apps have a declarative settings page, with what they need to render
// it. The app registration (define-app, from the manifests feed) registers an
// entry per app that declares `settings`; `AppSettingsPage` (one app) and
// `ConnectorsPage` (every `kind: "connector"`) read it. Reactive.
import { createStore, produce, reconcile } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { AppSettingsPageEntry } from "./types"

type StoredEntry = Omit<AppSettingsPageEntry, "exports">

const [pages, setPages] = createStore<Record<string, StoredEntry>>({})
// The export bags live outside the store: an in-tree app's is an ES module
// namespace (sealed, null prototype) and an isolated app's is the frame proxy,
// and a store would try to wrap either in its own proxy (a sealed object
// cannot take one: the whole settings page crashed). They are handed back as is.
const exportBags = new Map<string, Record<string, unknown>>()

function withExports(entry: StoredEntry | undefined): AppSettingsPageEntry | undefined {
  if (!entry) return undefined
  const exports = exportBags.get(entry.appId)
  return exports ? { ...entry, exports } : { ...entry }
}

/** Add or replace an app's settings page. */
export function registerAppSettingsPage(entry: AppSettingsPageEntry): void {
  const { exports, ...rest } = entry
  if (exports) exportBags.set(entry.appId, exports)
  else exportBags.delete(entry.appId)
  setPages(entry.appId, reconcile(rest))
}

/** Drop an app's settings page (the app was unregistered). */
export function unregisterAppSettingsPage(appId: string): void {
  exportBags.delete(appId)
  setPages(
    produce((s) => {
      delete s[appId]
    }),
  )
}

/** Reactive: one app's entry, or undefined. */
export function appSettingsPage(appId: string): AppSettingsPageEntry | undefined {
  return withExports(pages[appId])
}

/** Reactive: every registered entry, by app id. */
export function appSettingsPages(): AppSettingsPageEntry[] {
  return Object.values(pages)
    .sort((a, b) => a.appId.localeCompare(b.appId))
    .map((p) => withExports(p) as AppSettingsPageEntry)
}

/** Empty the registry: at the end of a session (the next one registers its own
 *  apps from the manifests feed again), and between tests. */
export function resetAppSettingsPages(): void {
  exportBags.clear()
  setPages(reconcile({}))
}

onSessionTeardown(resetAppSettingsPages)
