// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16.5 — Expose the kernel's Solid runtime on window globals BEFORE any
// plugin-app UI bundle is dynamic-imported. The import map in `index.html`
// resolves bare `solid-js{,/web,/store}` specifiers (used by plugin bundles
// the freeze tool externalizes) through shim files under
// `apps/web/public/_app-runtime/` that read these globals. This is what makes
// kernel + plugins share one Solid runtime — without it the plugin bundle
// would either fail to resolve `solid-js` in the browser or bring its own
// copy, producing two disconnected reactive graphs.
import * as solid from "solid-js"
import * as solidStore from "solid-js/store"
import * as solidWeb from "solid-js/web"
// biome-ignore lint/suspicious/noExplicitAny: window-global shim for plugin runtime sharing
;(globalThis as any).__liaisonSolid = solid
// biome-ignore lint/suspicious/noExplicitAny: window-global shim for plugin runtime sharing
;(globalThis as any).__liaisonSolidWeb = solidWeb
// biome-ignore lint/suspicious/noExplicitAny: window-global shim for plugin runtime sharing
;(globalThis as any).__liaisonSolidStore = solidStore

import { render } from "solid-js/web"
import App from "~/App"
import { buildHostServices } from "~/framework/host-services"
import { spaNavigate } from "~/framework/spa-navigate"
import { signalNativeReady } from "~/lib/native-bridge"
import "~/index.css"
import type { EnsureFreshTokenOptions } from "~/lib/auth-refresh"
import { startClientPolicy } from "~/lib/client-version"
import { accessToken, clearAuth } from "~/modules/auth/auth-store"
import { authManager, installResumeRefresh } from "~/modules/auth/createAuthManager"
import { startExternalLinkRouting } from "~/modules/desktop/external-links"
import { startNotificationRouteCapture } from "~/modules/notifications/open-route"
import { startThemeSync } from "~/modules/shell/theme-store"
import { addToast } from "~/modules/shell/toast-store"
import { startWebBuildWatch } from "~/modules/shell/web-update"
import { startKeyboardInset } from "~/primitives/keyboardInset"
import { completeRuntimeInit, initializeAuth } from "~/startup"

// Phase 16.6 — Expose host-services on the same window-global pattern used
// for the Solid runtime above. Plugin UI bundles `import { app, fetch } from
// "@liaison/host"` and the package-level resolvers read from this global at
// call time. Assigned BEFORE any plugin dynamic-import (which happens inside
// `initializeFrontendRuntime`'s `loadManifestApps`).
// biome-ignore lint/suspicious/noExplicitAny: window-global shim for plugin host services
;(globalThis as any).__liaisonHost = buildHostServices({
  getAccessToken: accessToken,
  ensureFreshToken: (opts?: EnsureFreshTokenOptions) =>
    authManager.ensureFreshToken(opts).then(() => undefined),
  pendingRefresh: authManager.pendingRefresh,
  onUnauthorized: () => clearAuth(),
  onError: (status, message) => addToast({ type: status >= 500 ? "error" : "warning", message }),
  inAppNavigate: spaNavigate,
})

// Chunk-load recovery: when the app server restarts (deploy, crash) mid
// session, an in-flight lazy `import()` fails with "error loading dynamically
// imported module" and the tab is left broken until a manual refresh. Reload
// once to pick the fresh index/chunks back up; the sessionStorage stamp keeps
// a genuinely broken asset from reload-looping (at most one auto-reload per
// minute per tab).
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    const msg = String((event.reason as Error | undefined)?.message ?? event.reason ?? "")
    const isChunkLoadFailure =
      /(error loading|failed to fetch) dynamically imported module/i.test(msg) ||
      /importing a module script failed/i.test(msg)
    if (!isChunkLoadFailure) return
    const key = "liaison:chunk-reload-at"
    const last = Number(sessionStorage.getItem(key) ?? 0)
    if (Date.now() - last < 60_000) return
    sessionStorage.setItem(key, String(Date.now()))
    window.location.reload()
  })
}

// Render-early (B1): await only the auth roundtrip (kernel app registration +
// restoreSession if a token exists), then paint the shell. Everything else
// (locale/billing/manifest loads + tab rehydration) runs in the background
// via `completeRuntimeInit()` — MainPanel already tracks
// `tabTypeRegistryVersion()` reactively, so tabs whose manifest app hasn't
// registered yet by the time `rehydrateTabs()` runs still resolve once it
// does. Blank-screen time drops from "auth + locale + billing + manifests,
// serially" to "auth" alone.
// The theme store pushes the resolved theme to the native status bar on
// creation and on every change after it, the OS appearance included. It runs
// before the first paint rather than whenever a settings screen first mounts.
startThemeSync()
// The page coming back (an app resumed, a laptop waking, a tab brought forward)
// refreshes an expired token before the stores resync, and their requests wait
// for it. Installed before any store adds a listener of its own.
installResumeRefresh()
// The native keyboard's height, from the shell: the web view is never told
// about the keyboard itself, so this is what lifts the page above it, the
// sign-in screen included (primitives/keyboardInset.ts). No-op in a browser.
startKeyboardInset()
// External links open in the system browser inside the desktop shell, where
// `target=_blank` opens nothing (modules/desktop/external-links.ts). Inert in
// a browser.
startExternalLinkRouting()
// Notice a newer deploy from this open tab (lib/web-build.ts). No-op in dev and
// inside the desktop and mobile shells, which update through their own channels.
startWebBuildWatch()
// A desktop or phone app asks its server, once, which versions it still
// supports, and names itself on its requests once it answered
// (lib/client-version.ts). No-op in a browser.
void startClientPolicy()
// A notification click that opened this window (`/?route=...` from the
// service worker) or a phone push tap (the shell pushes `/?route=...`): the
// parameter is taken off the URL before the router reads it, and the item
// opens once the shell is up (modules/notifications/open-route.ts).
startNotificationRouteCapture()

await initializeAuth()

render(() => <App />, document.getElementById("app")!)

// THE SHELL'S SPLASH COMES DOWN HERE, and nowhere earlier. A native wrapper
// draws a splash over the app until it is told the app has painted; told any
// earlier (or by a timer, which is what `launchAutoHide` is) it tears away
// onto a blank page while the bundle is still assembling. `render` above is
// synchronous, so by this line the shell is painted. No-op in a browser,
// which publishes no bridge at all (lib/native-bridge.ts).
signalNativeReady()

void completeRuntimeInit()
