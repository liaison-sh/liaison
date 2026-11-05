// SPDX-License-Identifier: FSL-1.1-ALv2
// The kernel connect dialog, opened from anywhere: an app's settings pane
// (`app.openConnectDialog` in @liaison/host), Settings > Apps and its
// `?connect=` deep link all go through `openConnectDialog` here, and the one
// `<ConnectDialogHost/>` mounted in the Shell renders it over the current page.
// The credential form (token, API key, database URL) or the OAuth sign-in is
// `ConnectAppDialog`, driven by the app's declared connections.

import type { ConnectDialogResult } from "@liaison/host"
import { type Component, createSignal, onCleanup, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Dialog } from "~/ui/Dialog"
import { type AppConnectionConfig, appsStore, primaryConnection } from "./apps-store"
import { ConnectAppDialog } from "./ConnectAppDialog"

/** The dialog the host is showing: one connection of one app. */
export interface ConnectDialogRequest {
  appName: string
  connectionName: string
  connConfig: AppConnectionConfig
}

interface PendingRequest extends ConnectDialogRequest {
  resolve: (result: ConnectDialogResult) => void
}

const [pending, setPending] = createSignal<PendingRequest | null>(null)

/** Reactive: the open request, or null when no dialog is open. */
export function connectDialogRequest(): ConnectDialogRequest | null {
  return pending()
}

/** Close the open dialog and answer its caller. No-op when none is open. */
export function settleConnectDialog(result: ConnectDialogResult): void {
  const current = pending()
  if (!current) return
  setPending(null)
  current.resolve(result)
}

/**
 * Open the connect dialog for `appName`. The app's connections are fetched
 * first (the store may be empty: an app's settings pane never loaded Settings >
 * Apps), then `connectionName` must be one of them; without it the app's
 * primary connection is used, else its first. Resolves when the dialog closes.
 * `api` is undefined only in tests that seed the store themselves.
 */
export async function openConnectDialog(
  api: ApiClient | undefined,
  appName: string,
  opts?: { connectionName?: string },
): Promise<ConnectDialogResult> {
  if (api) await appsStore.loadConnections(api, appName)
  const all = appsStore.connectionsFor(appName)
  const named = opts?.connectionName
  if (named !== undefined && !all.some((c) => c.name === named)) {
    throw new Error(
      `openConnectDialog("${appName}"): "${named}" is not one of ${appName}'s connections`,
    )
  }
  const wanted = named ?? primaryConnection(all) ?? all[0]?.name
  const connConfig = all.find((c) => c.name === wanted)
  if (!connConfig) {
    throw new Error(`openConnectDialog("${appName}"): the app declares no connection`)
  }
  // A newer request replaces a dialog still open; its caller learns nothing connected.
  settleConnectDialog({ connected: false })
  return new Promise((resolve) => {
    setPending({ appName, connectionName: connConfig.name, connConfig, resolve })
  })
}

/** Mounted once in the Shell, beside the other page-level dialogs. */
export const ConnectDialogHost: Component = () => {
  const api = useOptionalApi()
  onCleanup(() => settleConnectDialog({ connected: false }))
  return (
    <Dialog
      open={pending() !== null}
      onOpenChange={(open) => !open && settleConnectDialog({ connected: false })}
    >
      <Dialog.Content>
        <Show when={pending()} keyed>
          {(request) => (
            <ConnectAppDialog
              api={api}
              appName={request.appName}
              connectionName={request.connectionName}
              connConfig={request.connConfig}
              onClose={() => settleConnectDialog({ connected: false })}
              onSuccess={() => settleConnectDialog({ connected: true })}
              onRedirect={() => settleConnectDialog({ connected: false, redirected: true })}
            />
          )}
        </Show>
      </Dialog.Content>
    </Dialog>
  )
}
