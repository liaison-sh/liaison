// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated-tool approval summarizer for mcp-manager (a TRUSTED, in-tree host app).
// Mirrors the tickets/mail convention: a `summarizers.ts` sibling of `handlers.ts`
// that the host's `loadTrustedBundleFunction` resolves by export name from the
// manifest's `summarizer` field. Pure (no DB / no fetch) so it is safe to run
// synchronously at gate time.

interface ApprovalSummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null
}

/**
 * Summary for mcp-manager `add_connection`. SECURITY-SENSITIVE: this connects an
 * EXTERNAL MCP server the agent will later be able to call tools on, so the card
 * names the exact endpoint, the transport, and whether a bearer token is being
 * stored (never the token value itself) so the reviewer can judge the exposure
 * before approving.
 */
export function summarizeAddConnection(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const displayName = str(p.displayName) ?? "(unnamed connection)"
  const httpUrl = str(p.httpUrl) ?? "(no URL given)"
  const transport = str(p.transport) ?? "http"
  const authFlavor = str(p.authFlavor) ?? (str(p.bearerToken) ? "bearer" : "none")
  const visibility = str(p.agentVisibility) ?? "discoverable"
  const defaultPolicy = str(p.connectionDefaultPolicy) ?? "gate_writes"
  const personal = str(p.ownershipScope) === "personal"

  const lines: string[] = [
    personal
      ? "Ownership: personal (only you, your agent and your routines will see its tools)"
      : "Ownership: shared with the whole org",
    `Transport: ${transport}`,
    `Auth: ${authFlavor === "bearer" ? "bearer token (stored encrypted, never shown)" : "none"}`,
    `Agent visibility once dialed: ${visibility}`,
    `Default per-tool policy: ${defaultPolicy}`,
    "SECURITY-SENSITIVE: this connects an external server whose tools the agent can later call — verify the URL and sender before approving.",
  ]

  return Promise.resolve({
    kind: "add_connection",
    title: `Connect ${personal ? "personal " : ""}external MCP server "${displayName}" at ${httpUrl}`,
    subtitle: "Pending approval, not live until approved and tested",
    lines,
  })
}
