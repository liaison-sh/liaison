// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP Manager agent tools: a core app's server module (modules/apps/core/registry.ts).
// The agent can ADD an http/sse MCP connection (gated, admin approval) and LIST
// existing connections, besides the UI/REST wizard. Connection creation needs
// host-side secret encryption and an SSRF guard, so these handlers delegate to the
// `mcp_createConnection` / `mcp_listConnections` host methods of their typed ctx
// (modules/apps/core/ctx.ts), called directly in the API process.

import type { CoreCtx } from "~/modules/apps/core/ctx"

export interface McpManagerMethods {
  mcp_createConnection: (paramsJson: string) => Promise<string>
  mcp_listConnections: (paramsJson: string) => Promise<string>
  mcp_checkConnectionWrite: (paramsJson: string) => Promise<string>
}

type McpManagerCtx = CoreCtx<McpManagerMethods>

// add_connection (GATED). On approval the connection is persisted; the agent must NOT
// claim the server's tools are usable yet — they become discoverable after the
// connection is tested + its access policy is set (connect→test→policy→discover).
export async function addConnection(params: unknown, ctx: McpManagerCtx): Promise<unknown> {
  return JSON.parse(await ctx.mcp_createConnection(JSON.stringify(params ?? {})))
}

// add_connection preflight (stage time): an org connection needs
// mcp_manager:connection:write, refused before an approval is queued (A31).
export async function addConnectionPreflight(
  params: unknown,
  ctx: McpManagerCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.mcp_checkConnectionWrite(JSON.stringify(params ?? {})))
}

// list_connections (read-only).
export async function listConnections(params: unknown, ctx: McpManagerCtx): Promise<unknown> {
  return JSON.parse(await ctx.mcp_listConnections(JSON.stringify(params ?? {})))
}
