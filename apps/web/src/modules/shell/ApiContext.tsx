// SPDX-License-Identifier: FSL-1.1-ALv2
import { useNavigate } from "@solidjs/router"
import { createContext, type ParentComponent, useContext } from "solid-js"
import { noteAppsChanged } from "~/framework/unavailable-apps"
import { createApiClient } from "~/lib/api-client"
import { socketReconnecting } from "~/lib/socket-state"
import { accessToken, clearAuth } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import { useI18n } from "~/modules/i18n/i18n-context"
import { addToast } from "~/modules/shell/toast-store"

type ApiClient = ReturnType<typeof createApiClient>

export const ApiContext = createContext<ApiClient>()

export const ApiProvider: ParentComponent = (props) => {
  const navigate = useNavigate()
  const auth = authManager
  const i18n = useI18n()

  // `api` is referenced from the 403 handler's "Request access" action, but it
  // is only created below — capture it via a ref so the closure can reach it.
  let apiRef: ApiClient

  const api = createApiClient({
    getAccessToken: accessToken,
    ensureFreshToken: auth.ensureFreshToken,
    pendingRefresh: auth.pendingRefresh,
    onUnauthorized: () => {
      clearAuth()
      navigate("/login", { replace: true })
    },
    // Restricted away from an app (S20) or the app turned Off (S19): its entry
    // leaves the shell now; a 403 itself toasts "You no longer have access"
    // (api-client).
    onAppRestricted: noteAppsChanged,
    // A read that fails while the socket reconnects raises no toast (S26).
    isReconnecting: socketReconnecting,
    onError: (status, message, details) => {
      const missingScope =
        status === 403 && details && typeof details.missingScope === "string"
          ? (details.missingScope as string)
          : undefined
      const requestable =
        status === 403 && !!details && (details as { requestable?: unknown }).requestable === true

      // Scope-named denial → actionable toast that lets the user request access
      // in one click. The backend dedupes repeat requests (a success toast either way).
      if (missingScope && requestable) {
        addToast({
          type: "error",
          message: i18n.t("kernel.permissionDenied", { scope: missingScope }),
          action: {
            label: i18n.t("kernel.requestAccess"),
            onClick: () => {
              apiRef
                .post("/scope-requests", {
                  scopes: [missingScope],
                  reason: "Requested from a denied action",
                })
                .then(() =>
                  addToast({ type: "success", message: i18n.t("kernel.accessRequested") }),
                )
                .catch(() =>
                  addToast({ type: "error", message: i18n.t("kernel.accessRequestFailed") }),
                )
            },
          },
        })
        return
      }
      addToast({ message, type: "error" })
    },
  })
  apiRef = api

  return <ApiContext.Provider value={api}>{props.children}</ApiContext.Provider>
}

export function useApi(): ApiClient {
  const ctx = useContext(ApiContext)
  if (!ctx) throw new Error("useApi must be used within ApiProvider")
  return ctx
}

/** Like useApi but returns undefined when no provider is mounted (test paths). */
export function useOptionalApi(): ApiClient | undefined {
  return useContext(ApiContext)
}
