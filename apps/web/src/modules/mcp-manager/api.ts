// SPDX-License-Identifier: FSL-1.1-ALv2
//
// mcp-manager API helpers. Wraps the shared ApiClient (~/lib/api-client) — the
// codebase convention. One helper per UI action covering the four router
// surfaces (connections CRUD, policy, oauth, audit/usage) so the components in
// McpConnectionsList / wizard / detail tabs / org overview don't speak HTTP
// directly.
import type { ApiClient } from "~/lib/api-client"
import type {
  McpAuditQuery,
  McpAuditRow,
  McpConnection,
  McpConnectionAccess,
  McpConnectionCreateBody,
  McpConnectionListItem,
  McpConnectionPatchBody,
  McpConnectionsSummary,
  McpProbeResult,
  McpStartOAuthResult,
  McpTestConnectionResult,
  McpToolPolicy,
  McpToolPolicyBulkDecision,
  McpToolPolicyUpsertBody,
  McpToolSummary,
  McpUsageReport,
  McpUsageWindow,
} from "~/modules/mcp-manager/types"
import { runShellOAuth, type ShellStartParams } from "~/modules/settings/oauth-connect"

const BASE = "/apps/mcp-manager"

// ── Connections (Task 19 — mcpManagerRoutes) ───────────────────────────────

export function listConnections(api: ApiClient, _orgId?: string): Promise<McpConnectionListItem[]> {
  return api.get<McpConnectionListItem[]>(`${BASE}/connections`)
}

export function getConnection(api: ApiClient, id: string): Promise<McpConnection> {
  return api.get<McpConnection>(`${BASE}/connections/${encodeURIComponent(id)}`)
}

export function createConnection(
  api: ApiClient,
  body: McpConnectionCreateBody,
): Promise<McpConnection> {
  return api.post<McpConnection>(`${BASE}/connections`, body)
}

export function patchConnection(
  api: ApiClient,
  id: string,
  body: McpConnectionPatchBody,
): Promise<McpConnection> {
  return api.patch<McpConnection>(`${BASE}/connections/${encodeURIComponent(id)}`, body)
}

export function deleteConnection(api: ApiClient, id: string): Promise<{ ok: true }> {
  return api.delete<{ ok: true }>(`${BASE}/connections/${encodeURIComponent(id)}`)
}

export function testConnection(api: ApiClient, id: string): Promise<McpTestConnectionResult> {
  return api.post<McpTestConnectionResult>(`${BASE}/connections/${encodeURIComponent(id)}/test`)
}

/**
 * The tools Liaison holds for a connection from its last dial (no new dial):
 * empty until the connection has been reached once on this server.
 */
export function listConnectionTools(api: ApiClient, id: string): Promise<McpToolSummary[]> {
  return api.get<McpToolSummary[]>(`${BASE}/connections/${encodeURIComponent(id)}/tools`)
}

/**
 * Asks the server how Liaison signs in to the MCP server at `url`. Nothing is
 * saved. A URL the server refuses, or a discovery that fails, throws the
 * server's message (an ApiError), which says what to change.
 */
export function probeMcpServer(api: ApiClient, url: string): Promise<McpProbeResult> {
  return api.post<McpProbeResult>(`${BASE}/probe`, { url })
}

/** Who can use an organization server (admin only): everyone, or listed roles and people. */
export function getConnectionAccess(api: ApiClient, id: string): Promise<McpConnectionAccess> {
  return api.get<McpConnectionAccess>(`${BASE}/connections/${encodeURIComponent(id)}/access`)
}

export function setConnectionAccess(
  api: ApiClient,
  id: string,
  access: McpConnectionAccess,
): Promise<McpConnectionAccess> {
  const restricted = access.mode === "restricted"
  return api.put<McpConnectionAccess>(`${BASE}/connections/${encodeURIComponent(id)}/access`, {
    mode: access.mode,
    roleIds: restricted ? access.roleIds : [],
    userIds: restricted ? access.userIds : [],
  })
}

export function disableConnection(api: ApiClient, id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(`${BASE}/connections/${encodeURIComponent(id)}/disable`)
}

export function enableConnection(api: ApiClient, id: string): Promise<{ ok: true }> {
  return api.post<{ ok: true }>(`${BASE}/connections/${encodeURIComponent(id)}/enable`)
}

/** Derives a sidebar-friendly summary from the live list. The backend does not
 *  yet expose a dedicated summary endpoint; the sidebar badge cares only about
 *  failed + disabled + oauth_pending counts (cheap to compute client-side). */
export async function getConnectionsSummary(
  api: ApiClient,
  orgId?: string,
): Promise<McpConnectionsSummary> {
  const rows = await listConnections(api, orgId)
  let connected = 0
  let failed = 0
  let disabled = 0
  let oauthPending = 0
  let needsReauth = 0
  for (const r of rows) {
    if (r.disabled) disabled++
    else if (r.status === "failed") failed++
    else if (r.status === "needs_reauth") needsReauth++
    else if (r.status === "oauth_pending") oauthPending++
    else if (r.status === "connected") connected++
  }
  return { total: rows.length, connected, failed, disabled, oauthPending, needsReauth }
}

// ── Tool policy (Task 20 — PUT/GET /:id/policy on mcpManagerRoutes) ────────

export function listToolPolicies(api: ApiClient, connectionId: string): Promise<McpToolPolicy[]> {
  return api.get<McpToolPolicy[]>(`${BASE}/connections/${encodeURIComponent(connectionId)}/policy`)
}

export function patchToolPolicy(
  api: ApiClient,
  connectionId: string,
  body: McpToolPolicyUpsertBody,
): Promise<{ ok: true }> {
  return api.put<{ ok: true }>(
    `${BASE}/connections/${encodeURIComponent(connectionId)}/policy`,
    body,
  )
}

/** Several tools' overrides in one request and one transaction; role overrides are kept. */
export function bulkSetToolPolicies(
  api: ApiClient,
  connectionId: string,
  decisions: McpToolPolicyBulkDecision[],
): Promise<{ ok: true; count: number }> {
  return api.put<{ ok: true; count: number }>(
    `${BASE}/connections/${encodeURIComponent(connectionId)}/policy/bulk`,
    { decisions },
  )
}

export function deleteToolPolicy(
  api: ApiClient,
  connectionId: string,
  toolName: string,
): Promise<{ ok: true }> {
  // The backend models delete as an upsert with overrideDecision=null +
  // roleOverrides=[]. No separate DELETE endpoint exists — this matches the
  // PUT shape that clears the row.
  return patchToolPolicy(api, connectionId, {
    toolName,
    overrideDecision: null,
    roleOverrides: [],
  })
}

// ── OAuth (Task 21 — mcpManagerOAuthRoutes) ────────────────────────────────

/**
 * Starts the sign-in and returns the provider's authorization URL, which every
 * caller opens in a new window. The server refuses non-https endpoints; this
 * check keeps a `javascript:` / `data:` value from ever reaching `window.open`
 * even if a response is forged or an older server answers.
 */
export async function startOAuth(
  api: ApiClient,
  connectionId: string,
  shell?: ShellStartParams,
): Promise<McpStartOAuthResult> {
  const path = `${BASE}/connections/${encodeURIComponent(connectionId)}/oauth/start`
  const result = await (shell
    ? api.post<McpStartOAuthResult>(path, shell)
    : api.post<McpStartOAuthResult>(path))
  let safe = false
  try {
    const url = new URL(result.authorizationUrl)
    // https only; plain http just for a provider on this machine (local development).
    safe =
      url.protocol === "https:" ||
      (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
  } catch {
    // Not a URL at all: refused below.
  }
  if (!safe) {
    throw new Error("The sign-in provider returned an unsafe authorization URL")
  }
  return result
}

/**
 * Signs in to an MCP server. In a browser tab the provider opens through
 * `open` (a new tab), bound to this browser by the server's cookie. In the
 * desktop or mobile shell, which cannot hold that cookie, the flow runs the
 * shell's way (settings/oauth-connect.ts): the system browser or the phone's
 * authentication session, bound to a PKCE verifier this window keeps, and the
 * server stores the tokens only once this window redeems the handoff link.
 * Answers `opened` (a browser tab now on the provider), `connected` (the shell
 * finished) or `cancelled` (the sheet was closed).
 */
export async function signInToMcp(
  api: ApiClient,
  connectionId: string,
  open: (url: string) => unknown,
): Promise<"opened" | "connected" | "cancelled"> {
  const outcome = await runShellOAuth({
    start: async (params) => (await startOAuth(api, connectionId, params)).authorizationUrl,
    redeem: (redemption) => api.post<{ connectionId: string }>(`${BASE}/oauth/handoff`, redemption),
  })
  switch (outcome.kind) {
    case "connected":
      return "connected"
    case "cancelled":
      return "cancelled"
    case "no-redirect":
      throw new Error("The sign-in provider returned no authorization URL")
    case "not-a-shell": {
      const { authorizationUrl } = await startOAuth(api, connectionId)
      open(authorizationUrl)
      return "opened"
    }
  }
}

// ── Audit (Task 22 — mcpManagerAuditRoutes) ────────────────────────────────

function buildAuditQuery(q: McpAuditQuery): string {
  const sp = new URLSearchParams()
  if (q.from) sp.set("from", q.from)
  if (q.to) sp.set("to", q.to)
  if (q.decision) sp.set("decision", q.decision)
  if (typeof q.limit === "number") sp.set("limit", String(q.limit))
  const s = sp.toString()
  return s ? `?${s}` : ""
}

export function getConnectionAudit(
  api: ApiClient,
  connectionId: string,
  q: McpAuditQuery = {},
): Promise<McpAuditRow[]> {
  return api.get<McpAuditRow[]>(
    `${BASE}/connections/${encodeURIComponent(connectionId)}/audit${buildAuditQuery(q)}`,
  )
}

export function getOrgAudit(api: ApiClient, q: McpAuditQuery = {}): Promise<McpAuditRow[]> {
  return api.get<McpAuditRow[]>(`${BASE}/audit${buildAuditQuery(q)}`)
}

export function getConnectionUsage(
  api: ApiClient,
  connectionId: string,
  opts: { window?: McpUsageWindow } = {},
): Promise<McpUsageReport> {
  const w = opts.window ?? "24h"
  return api.get<McpUsageReport>(
    `${BASE}/connections/${encodeURIComponent(connectionId)}/usage?window=${w}`,
  )
}
