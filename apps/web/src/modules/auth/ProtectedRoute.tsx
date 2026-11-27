// SPDX-License-Identifier: FSL-1.1-ALv2

import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect, lazy, type ParentComponent, Show } from "solid-js"
import { isNativeShell } from "~/lib/native-bridge"
import {
  hasSession,
  isAuthenticated,
  isRestoringSession,
  noteUnreachableBounce,
  secondFactorRequired,
  serverUnreachable,
} from "~/modules/auth/auth-store"
import { WorkspaceUnreachable, workspaceRetrying } from "~/modules/auth/WorkspaceUnreachable"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ApiProvider } from "~/modules/shell/ApiContext"

const SecondFactorEnrollment = lazy(() => import("~/modules/auth/SecondFactorEnrollment"))

export const ProtectedRoute: ParentComponent = (props) => {
  const i18n = useI18n()
  const location = useLocation()
  const navigate = useNavigate()

  /**
   * A SIGNED-IN PHONE WHOSE SERVER DOES NOT ANSWER STAYS SIGNED IN. The phone
   * keeps its session through a cold launch with no network; the sign-in page
   * FX11 sends a shell to (for the desktop's address field, which the phone
   * does not have) read as signed out there. It waits on its own screen and
   * opens as soon as the server answers. A phone with no session flag has
   * nothing to wait for and still goes to /login.
   */
  const waitingForServer = () =>
    !isAuthenticated() &&
    isNativeShell() &&
    hasSession() &&
    (serverUnreachable() || workspaceRetrying())

  createEffect(() => {
    if (waitingForServer()) return
    // A SHELL POINTED AT A SERVER THAT DOES NOT ANSWER GOES TO /login (FX11).
    // The retry loop keeps running behind it, but the only screen that can
    // change the address lives there, and this one has nothing to show but a
    // splash that never ends.
    if (serverUnreachable() && !isAuthenticated()) {
      const returnTo = encodeURIComponent(location.pathname + location.search)
      // The login surface only moves the user back when the move away was
      // ours, which is here and nowhere else.
      noteUnreachableBounce()
      navigate(`/login?returnTo=${returnTo}`, { replace: true })
      return
    }
    if (isRestoringSession()) return
    // Don't redirect if there's a stored session — a restore retry is pending
    if (hasSession() && !isAuthenticated()) return
    if (!isAuthenticated()) {
      const returnTo = encodeURIComponent(location.pathname + location.search)
      navigate(`/login?returnTo=${returnTo}`, { replace: true })
    }
  })

  return (
    <Show
      when={isAuthenticated()}
      fallback={
        <Show when={!waitingForServer()} fallback={<WorkspaceUnreachable />}>
          <Show
            when={!serverUnreachable() && (isRestoringSession() || hasSession())}
            fallback={null}
          >
            <div class="flex min-h-screen items-center justify-center">
              <p class="text-sm text-text-secondary">{i18n.t("kernel.restoringSession")}</p>
            </div>
          </Show>
        </Show>
      }
    >
      {/* An administrator the org requires a second factor of, without one:
          the session holds nothing until they set it up. */}
      <Show
        when={!secondFactorRequired()}
        fallback={
          <ApiProvider>
            <SecondFactorEnrollment />
          </ApiProvider>
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}
