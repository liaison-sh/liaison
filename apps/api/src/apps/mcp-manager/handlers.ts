// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MCP Manager agent tools (BL-169 #6 — drive impossible→0). The agent can now
// conversationally ADD an http/sse MCP connection (gated → admin approval) and LIST
// existing connections, instead of only the UI/REST wizard. Connection creation needs
// host-side AES secret encryption + an SSRF guard, so these thin sandboxed handlers
// delegate to the rpc-bridge `mcp_createConnection` / `mcp_listConnections` host methods
// (mirrors the knowledge/projects handler→bridge pattern). The handler functions are
// resolved by manifest export NAME; Bun's transpiler promotes top-level function
// declarations to global so the sandbox loader finds them.
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

import type {} from "node:buffer"

interface McpManagerSandboxCtx {
  mcp_createConnection: (paramsJson: string) => Promise<string>
  mcp_listConnections: (paramsJson: string) => Promise<string>
  mcp_checkConnectionWrite: (paramsJson: string) => Promise<string>
}

// add_connection (GATED). On approval the connection is persisted; the agent must NOT
// claim the server's tools are usable yet — they become discoverable after the
// connection is tested + its access policy is set (connect→test→policy→discover).
async function addConnection(params: unknown, ctx: McpManagerSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.mcp_createConnection(JSON.stringify(params ?? {})))
}

// add_connection preflight (stage time): an org connection needs
// mcp_manager:connection:write, refused before an approval is queued (A31).
async function addConnectionPreflight(
  params: unknown,
  ctx: McpManagerSandboxCtx,
): Promise<unknown> {
  return JSON.parse(await ctx.mcp_checkConnectionWrite(JSON.stringify(params ?? {})))
}

// list_connections (read-only).
async function listConnections(params: unknown, ctx: McpManagerSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.mcp_listConnections(JSON.stringify(params ?? {})))
}
