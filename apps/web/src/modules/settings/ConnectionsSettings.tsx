// SPDX-License-Identifier: FSL-1.1-ALv2
//
// You > Connected tools (settings overhaul S16): first Liaison used from
// Claude, Cursor and other AI tools over MCP (connect info and the connected
// clients), then the viewer's own MCP servers, the second block only for
// holders of mcp_manager:personal_connection:write. Organisation-wide MCP
// servers are on the Connectors page.
import { type Component, Show } from "solid-js"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { MyMcpConnectionsPage } from "~/modules/mcp-manager/MyMcpConnectionsPage"
import McpSettings from "./McpSettings"

export const PERSONAL_MCP_SCOPE = "mcp_manager:personal_connection:write"

const ConnectionsSettings: Component = () => {
  const i18n = useI18n()
  return (
    <div data-testid="connections-settings">
      <div class="mb-6">
        <h1 class="text-lg font-semibold text-text">
          {i18n.t("kernel.nav.section.connectedTools")}
        </h1>
        <p class="text-sm text-text-secondary">{i18n.t("kernel.settingsUi.connectionsIntro")}</p>
      </div>
      <section data-testid="connections-clients">
        <McpSettings />
      </section>
      <Show when={canAccessScope(PERSONAL_MCP_SCOPE)}>
        <section
          data-testid="connections-personal-servers"
          class="mt-10 border-t border-border pt-6"
        >
          <MyMcpConnectionsPage />
        </section>
      </Show>
    </div>
  )
}

export default ConnectionsSettings
