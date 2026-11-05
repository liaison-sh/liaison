// SPDX-License-Identifier: FSL-1.1-ALv2
//
// APPS THIS BUILD RUNS IN COMPATIBILITY MODE. Zero domain imports.
//
// The desktop and phone apps carry no app UI of their own: a first-party app's
// UI comes from the server (verified by the desktop shell, or framed), so it
// always matches the server's version. What can still be older than the server
// is this build's settings renderer: a settings page whose manifest uses a
// block or field type this build does not know is drawn with a placeholder in
// its place. That means the app is older than its server and should be updated.
//
// The bootstrap notes each such app here; the shell's notice
// (modules/shell/compat-mode-notice.ts) reads the list. A browser tab never
// notes anything: it loads the server's own UIs and always matches.

import { createSignal } from "solid-js"

export type CompatReason = "settings"

export interface CompatApp {
  app: string
  reason: CompatReason
  /** The server's version of the app (the manifest's), or null when unknown. */
  serverVersion: string | null
}

const [entries, setEntries] = createSignal<CompatApp[]>([])

/** Every app running in compatibility mode, in a stable order. Reactive. */
export function compatModeApps(): CompatApp[] {
  return entries()
}

/** Note an app (once per app and reason; a later note replaces the earlier one). */
export function noteCompatMode(entry: CompatApp): void {
  setEntries((list) =>
    [...list.filter((e) => !(e.app === entry.app && e.reason === entry.reason)), entry].sort(
      (a, b) => a.app.localeCompare(b.app) || a.reason.localeCompare(b.reason),
    ),
  )
}

/** Forget an app: it was unregistered, or is being registered again. */
export function clearCompatMode(app?: string): void {
  setEntries((list) => (app === undefined ? [] : list.filter((e) => e.app !== app)))
}

/** One key per set of apps and versions: "Not now" is remembered against it. */
export function compatModeKey(list: CompatApp[]): string {
  return list.map((e) => `${e.app}@${e.serverVersion ?? "?"}:${e.reason}`).join(",")
}
