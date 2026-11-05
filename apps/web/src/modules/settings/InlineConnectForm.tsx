// SPDX-License-Identifier: FSL-1.1-ALv2
// The connect form of one app connection, inline in that app's settings card
// (GitLab, Database): fixing a dead token happens where the card says it is
// dead, not on another page. ConnectAppDialog is content-only, so the card
// embeds it, driven by the connection the app declares (loaded here: the card
// never went through Settings > Apps).

import { type Component, createResource, Show } from "solid-js"
import { useApi } from "~/modules/shell/ApiContext"
import { appsStore } from "./apps-store"
import { ConnectAppDialog } from "./ConnectAppDialog"

export const InlineConnectForm: Component<{
  appName: string
  connectionName: string
  /** A connection was saved: the card re-probes. */
  onConnected: () => void
  onClose: () => void
}> = (props) => {
  const api = useApi()
  const [connection] = createResource(async () => {
    await appsStore.loadConnections(api, props.appName)
    return (
      appsStore.connectionsFor(props.appName).find((c) => c.name === props.connectionName) ?? null
    )
  })
  return (
    <div
      class="rounded-sm border border-border p-3"
      data-testid={`${props.appName}-inline-connect`}
    >
      <Show when={connection()}>
        {(conn) => (
          <ConnectAppDialog
            api={api}
            appName={props.appName}
            connectionName={props.connectionName}
            connConfig={conn()}
            onClose={() => props.onClose()}
            onSuccess={() => props.onConnected()}
          />
        )}
      </Show>
    </div>
  )
}
