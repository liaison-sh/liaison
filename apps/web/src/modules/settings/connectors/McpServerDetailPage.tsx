// SPDX-License-Identifier: FSL-1.1-ALv2
// One org MCP server (`/settings/connectors/mcp/<id>`): its page in sections
// (Tools & policy, Activity, Usage on the managed edition, Configuration),
// under a way back to Connectors, where removing it also returns.
import { useLocation, useNavigate } from "@solidjs/router"
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ConnectionDetail } from "~/modules/mcp-manager/ConnectionDetail"
import { Button } from "~/ui/Button"
import { CONNECTORS_HREF } from "./ConnectorsPage"

/** The server id in `/settings/connectors/mcp/<id>`, or null. */
export function mcpServerIdFromPath(pathname: string): string | null {
  const m = /^\/settings\/connectors\/mcp\/([^/]+)\/?$/.exec(pathname)
  return m ? decodeURIComponent(m[1]) : null
}

export const McpServerDetailPage: Component = () => {
  const i18n = useI18n()
  const location = useLocation()
  const navigate = useNavigate()
  const id = () => mcpServerIdFromPath(location.pathname)
  return (
    <div data-testid="mcp-server-detail-page">
      <Button
        size="sm"
        variant="ghost"
        class="-ml-2 mb-3"
        data-testid="mcp-server-detail-back"
        onClick={() => navigate(CONNECTORS_HREF)}
      >
        ‹ {i18n.t("kernel.settingsPage.connectors.title")}
      </Button>
      <Show when={id()} keyed>
        {(connectionId) => (
          <ConnectionDetail
            connectionId={connectionId}
            onRemoved={() => navigate(CONNECTORS_HREF)}
          />
        )}
      </Show>
    </div>
  )
}
