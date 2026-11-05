// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveLocale } from "@liaison/shared"
import { Route, Router, useLocation, useNavigate } from "@solidjs/router"
import { type Component, createEffect, ErrorBoundary, lazy, on, Suspense } from "solid-js"
import { setPagePath, setRouterNavigate } from "~/framework/spa-navigate"
import { ProtectedRoute } from "~/modules/auth/ProtectedRoute"
import DesktopUpdateCard from "~/modules/desktop/DesktopUpdateCard"
import { I18nProvider, useI18n } from "~/modules/i18n/i18n-context"
import ClientVersionNotice from "~/modules/shell/ClientVersionNotice"
import CompatModeNotice from "~/modules/shell/CompatModeNotice"
import { Shell } from "~/modules/shell/Shell"
import WebUpdateBanner from "~/modules/shell/WebUpdateBanner"
import { webBuildWatcher } from "~/modules/shell/web-update"

// Auth pages (outside shell)
const Login = lazy(() => import("~/modules/auth/Login"))
const MagicLinkVerify = lazy(() => import("~/modules/auth/MagicLinkVerify"))
const TotpVerify = lazy(() => import("~/modules/auth/TotpVerify"))
const Register = lazy(() => import("~/modules/auth/Register"))
const ResetPassword = lazy(() => import("~/modules/auth/ResetPassword"))
const ResetPasswordConfirm = lazy(() => import("~/modules/auth/ResetPasswordConfirm"))
const OAuthComplete = lazy(() => import("~/modules/auth/OAuthComplete"))
// The device grant verification page. The API builds every verificationUri as
// `<base>/auth/device?code=<userCode>`, so this path is a contract with it.
const DeviceApproval = lazy(() => import("~/modules/auth/DeviceApproval"))
const ConnectLink = lazy(() => import("~/modules/settings/ConnectLink"))
// The public demo entry. It renders its two doors only when the SERVER says
// this is a demo deployment, so the route is inert on every other install.
const DemoEntryRoute = lazy(() => import("~/modules/demo/DemoEntryRoute"))
const DemoUnsubscribe = lazy(() => import("~/modules/demo/DemoUnsubscribe"))
const DemoVerifyRoute = lazy(() => import("~/modules/demo/DemoVerifyRoute"))

// Shell wraps with auth protection — tab system handles content rendering
const ProtectedShell: Component = () => {
  // Register the SPA router navigate so the plugin host bridge can navigate
  // in-app without a full page reload. The host bridge is built at boot (before
  // the Router mounts), so it reads this lazily via spa-navigate.
  setRouterNavigate(useNavigate())
  // A navigation is a safe moment to pick up a newer deploy (lib/web-build.ts).
  const location = useLocation()
  // The page's route, for what reads it outside the router (an app's frame).
  createEffect(() => setPagePath(`${location.pathname}${location.search}`))
  createEffect(
    on(
      () => location.pathname,
      () => webBuildWatcher()?.onNavigate(),
      { defer: true },
    ),
  )
  return (
    <ProtectedRoute>
      <Shell />
    </ProtectedRoute>
  )
}

/**
 * The last guard in the app: whatever escapes every local boundary lands here.
 *
 * It must ALWAYS paint something. The panel therefore offers two ways out, not
 * one: `reset` re-renders the tree (enough for a transient failure), and
 * Reload re-fetches the document (the only way out when the shell itself is
 * what threw and re-rendering it would only throw again).
 */
export function AppErrorFallback(err: unknown, reset: () => void) {
  const i18n = useI18n()
  const message = import.meta.env.PROD
    ? "An unexpected error occurred."
    : err instanceof Error
      ? err.message
      : String(err)
  return (
    <div
      data-testid="app-error-fallback"
      class="flex min-h-screen items-center justify-center bg-bg p-8"
    >
      <div class="max-w-md text-center">
        <h1 class="mb-2 text-lg font-semibold text-text">{i18n.t("kernel.somethingWentWrong")}</h1>
        <p class="mb-4 text-sm text-text-secondary">{message}</p>
        <div class="flex items-center justify-center gap-2">
          <button
            onClick={reset}
            class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-accent/90"
          >
            {i18n.t("kernel.common.retry")}
          </button>
          <button
            data-testid="app-error-reload"
            onClick={() => location.reload()}
            class="rounded-md border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-hover"
          >
            {i18n.t("kernel.reloadPage")}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The root <Suspense>'s fallback, and the reason it has one at all.
 *
 * A Solid Suspense boundary with NO fallback renders NOTHING while it is
 * suspended, and this one sits above the entire shell: a single resource read
 * that had no closer boundary (a dock conversation, a phone push) emptied the
 * document for as long as the read was pending, which under a 429 is seconds.
 * Local boundaries keep that from reaching here; this makes "reaching here"
 * survivable rather than blank.
 */
function AppSuspenseFallback() {
  const i18n = useI18n()
  return (
    <div
      data-testid="app-suspense-fallback"
      class="flex min-h-screen items-center justify-center bg-bg p-8 text-sm text-text-tertiary"
    >
      {i18n.t("kernel.loading")}
    </div>
  )
}

const App: Component = () => {
  const initialLocale = resolveLocale(
    null,
    typeof navigator !== "undefined" ? navigator.language : null,
  )
  return (
    <ErrorBoundary fallback={AppErrorFallback}>
      <I18nProvider initialLocale={initialLocale}>
        <Suspense fallback={<AppSuspenseFallback />}>
          <Router>
            {/* Auth routes — no shell */}
            <Route path="/login" component={Login} />
            <Route path="/login/magic" component={MagicLinkVerify} />
            <Route path="/login/totp" component={TotpVerify} />
            <Route path="/register" component={Register} />
            <Route path="/reset-password" component={ResetPassword} />
            <Route path="/reset-password/confirm" component={ResetPasswordConfirm} />
            <Route path="/login/oauth-complete" component={OAuthComplete} />
            <Route path="/auth/device" component={DeviceApproval} />
            {/* A one-time link to connect one's own account: never signs anyone in. */}
            <Route path="/connect/link" component={ConnectLink} />
            <Route path="/demo" component={DemoEntryRoute} />
            <Route path="/demo/unsubscribe" component={DemoUnsubscribe} />
            {/* The code mail's link: shows a Confirm button, never verifies on open. */}
            <Route path="/demo/verify" component={DemoVerifyRoute} />

            {/* Protected routes — shell layout with tab system */}
            <Route path="/*" component={ProtectedShell} />
          </Router>
        </Suspense>
        {/* Every screen, signed in or not: an update in progress covers the window. */}
        <DesktopUpdateCard />
        <WebUpdateBanner />
        <CompatModeNotice />
        <ClientVersionNotice />
      </I18nProvider>
    </ErrorBoundary>
  )
}

export default App
