// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser wiring of lib/web-build.ts: one watcher for the page, fed by the
// API client's responses, by focus and visibility, and by SPA navigation.

import {
  createWebBuildWatcher,
  insideAppShell,
  installWebBuildWatcher,
  pageHasUnsavedWork,
  pageWebBuildId,
  WEB_BUILD_ID_PATH,
  type WebBuildWatcher,
} from "~/lib/web-build"
import { inFlightUploadCount } from "~/modules/files/file-service"

let watcher: WebBuildWatcher | null = null

/** The page's watcher, or null before `startWebBuildWatch` ran (dev, tests). */
export function webBuildWatcher(): WebBuildWatcher | null {
  return watcher
}

function sessionStore(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/** Starts watching for a newer deploy. A no-op in dev and inside a shell. */
export function startWebBuildWatch(): void {
  if (watcher !== null || typeof window === "undefined" || import.meta.env.DEV) return
  if (insideAppShell()) return
  // Outside a shell the page is served by its own API's origin, and
  // `build-id.txt` sits beside index.html at the site root.
  const idUrl = new URL(WEB_BUILD_ID_PATH, window.location.origin).href
  watcher = createWebBuildWatcher({
    compiledId: pageWebBuildId(),
    inShell: insideAppShell,
    hasUnsavedWork: () => pageHasUnsavedWork(inFlightUploadCount),
    reload: () => window.location.reload(),
    storage: sessionStore(),
    fetchServerId: async () => {
      const res = await fetch(idUrl, { cache: "no-store", credentials: "omit" })
      if (!res.ok) return null
      return (await res.text()).trim() || null
    },
  })
  installWebBuildWatcher(watcher)
  const w = watcher
  document.addEventListener("visibilitychange", () =>
    w.onVisibilityChange(document.visibilityState === "visible"),
  )
  window.addEventListener("focus", () => w.onFocus())
}
