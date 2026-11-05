// SPDX-License-Identifier: FSL-1.1-ALv2
//
// In-app SPA navigation ref. @solidjs/router's `useNavigate` is only available
// inside a Router context (mounted in <App>), but the host-services bridge is
// built at boot in index.tsx — before render. <App> registers the router
// navigate here once the Router has mounted; until then (and in non-browser
// contexts) callers fall back to a full-page assign.

import { createSignal } from "solid-js"

let routerNavigate: ((path: string) => void) | null = null

/** Called by <App> once the Router context is available. */
export function setRouterNavigate(fn: (path: string) => void): void {
  routerNavigate = fn
}

/**
 * Navigate within the SPA without a full page reload. Falls back to
 * `window.location.assign` before the router has registered (or in SSR/tests).
 */
export function spaNavigate(path: string): void {
  if (routerNavigate) {
    routerNavigate(path)
  } else if (typeof window !== "undefined") {
    window.location.assign(path)
  }
}

/** The page's path and query as the window has them now ("" outside a browser). */
function windowPath(): string {
  return typeof window !== "undefined" ? `${window.location.pathname}${window.location.search}` : ""
}

const [routePath, setRoutePath] = createSignal(windowPath())

/**
 * The page's path and query, reactive: <App> sets it on every route change. An
 * app's frame is sent it (isolated-app.tsx), since the frame's own location is
 * its document's, never the page's.
 */
export function pagePath(): string {
  return routePath()
}

/** Called by <App> on every route change (and by tests). */
export function setPagePath(path: string): void {
  setRoutePath(path)
}
