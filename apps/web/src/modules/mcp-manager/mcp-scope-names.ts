// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An MCP server's permissions are `mcp:<slug>` (all its tools) and
// `mcp:<slug>:<tool>` (one tool). The roles pages show them as the server's
// name, never the identifier, and link to the server's page.
import { type Accessor, createResource } from "solid-js"
import { canAccessScope } from "~/modules/auth/auth-store"
import { listConnections } from "~/modules/mcp-manager/api"
import type { McpConnectionListItem } from "~/modules/mcp-manager/types"
import { useApi } from "~/modules/shell/ApiContext"

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface McpScopeRef {
  slug: string
  /** Set for a one-tool grant. */
  tool?: string
}

/** `mcp:<slug>` or `mcp:<slug>:<tool>`; null for any other scope. */
export function parseMcpScope(scope: string): McpScopeRef | null {
  const m = /^mcp:([a-z0-9][a-z0-9-]*)(?::(.+))?$/.exec(scope)
  if (!m) return null
  return m[2] ? { slug: m[1], tool: m[2] } : { slug: m[1] }
}

/** The page of the org server behind a slug. */
export function mcpServerHref(id: string): string {
  return `/settings/connectors/mcp/${encodeURIComponent(id)}`
}

/** The workspace's MCP servers by slug (every member may read the list). */
export function useMcpServersBySlug(): Accessor<Map<string, McpConnectionListItem>> {
  const api = useApi()
  const [servers] = createResource(async () => {
    if (!canAccessScope("mcp_manager:connection:read")) return []
    try {
      return await listConnections(api)
    } catch {
      return []
    }
  })
  return () => new Map((servers.latest ?? []).map((s) => [s.slug, s]))
}

/** What an `mcp:` grant reads as: the server's name (and the tool for a one-tool grant). */
export function mcpScopeLabel(
  scope: string,
  servers: Map<string, McpConnectionListItem>,
  t: Translate,
): string | undefined {
  const ref = parseMcpScope(scope)
  if (!ref) return undefined
  const name = servers.get(ref.slug)?.displayName ?? ref.slug
  const server = t("kernel.mcpUi.mcpScopeLabel", { name })
  return ref.tool
    ? `${server} · ${t("kernel.mcpUi.roleServerOneTool", { tool: ref.tool })}`
    : server
}
