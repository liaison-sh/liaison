// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared TypeScript types for the mcp-manager UI. Mirrors the backend response
// shapes from apps/api/src/apps/mcp-manager/* without dragging the server-side
// drizzle imports into the browser bundle.

export type McpTransport = "http" | "sse"
export type McpDefaultPolicy = "auto" | "gate_writes" | "gate_all"
export type McpAuthFlavor = "none" | "bearer" | "oauth_dcr" | "oauth_static"
export type McpManagedBy = "env" | "ui"
export type McpOwnershipScope = "org" | "personal"
export type McpAgentVisibility = "discoverable" | "hidden"
export type McpToolDecision = "auto" | "gate" | "deny"
/**
 * The list's `status`: `disabled` and `oauth_pending` come from the row, the
 * rest from its health. `needs_reauth` means the token was refused and could
 * not be refreshed: someone signs in again. `idle` is a row never dialled.
 */
export type McpConnectionStatus =
  | "connected"
  | "connecting"
  | "oauth_pending"
  | "needs_reauth"
  | "failed"
  | "disabled"
  | "idle"

export interface McpConnectionListItem {
  id: string
  slug: string
  displayName: string
  transport: McpTransport
  ownershipScope: McpOwnershipScope
  ownerUserId?: string | null
  managedBy: McpManagedBy
  agentVisibility: McpAgentVisibility
  exposeViaGateway: boolean
  connectionDefaultPolicy: McpDefaultPolicy
  rateCapPerMinute: number | null
  disabled: boolean
  status: McpConnectionStatus
  toolCount: number
  /** Milliseconds since the last tool call through this connection. */
  lastCallAgo?: number | string | null
  /** When the connection was last dialled (a test or a real call), ISO. */
  lastCheckedAt?: string | null
  /** The last dial's error, when that dial failed. */
  lastError?: string | null
  /** The stored credentials cannot be decrypted on this server (key changed). */
  secretsUnreadable?: boolean
  /** Names of the custom headers sent on every request; values never come back. */
  customHeaderNames?: string[]
}

/** Who can use an organization server: every member, or the listed roles and people. */
export interface McpConnectionAccess {
  mode: "everyone" | "restricted"
  roleIds: string[]
  userIds: string[]
}

export interface McpConnection extends McpConnectionListItem {
  httpUrl?: string | null
  authFlavor: McpAuthFlavor
  oauthMetadata?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
  /** When a person last completed the tools review; null = never reviewed. */
  toolsReviewedAt?: string | null
  /** Who can use an org server (personal servers: their owner only). */
  accessMode?: "everyone" | "restricted"
}

export interface McpConnectionsSummary {
  total: number
  connected: number
  failed: number
  disabled: number
  oauthPending: number
  /** Signed in once, the token was refused since: someone signs in again. */
  needsReauth: number
}

export interface McpConnectionCreateBody {
  slug: string
  displayName: string
  transport: McpTransport
  ownershipScope?: McpOwnershipScope
  httpUrl?: string
  authFlavor?: McpAuthFlavor
  bearerToken?: string
  oauthClientId?: string
  oauthClientSecret?: string
  /** oauth_static only — admin-provided issuer endpoints (no discovery). */
  oauthAuthorizationEndpoint?: string
  oauthTokenEndpoint?: string
  oauthScopes?: string[]
  /** Bearer and no-auth connections: name to value, sent on every request. */
  customHeaders?: Record<string, string>
  agentVisibility?: McpAgentVisibility
  exposeViaGateway?: boolean
  connectionDefaultPolicy?: McpDefaultPolicy
  /** `null` explicitly clears the cap (unlimited); omit to leave untouched on PATCH. */
  rateCapPerMinute?: number | null
}

export type McpConnectionPatchBody = Partial<
  Omit<McpConnectionCreateBody, "slug" | "transport" | "ownershipScope" | "customHeaders">
> & {
  /** A value sets the header, null removes it; headers left out are kept. */
  customHeaders?: Record<string, string | null>
  /** The tools review was completed (stamps `toolsReviewedAt`). */
  toolsReviewed?: true
}

/**
 * What `POST /probe` found at a server URL, before anything is saved: how
 * Liaison signs in to it. `dcr` and `cimd` register Liaison automatically,
 * `preregistered` needs a client the admin creates at the provider with
 * `callbackUrl` as its redirect, `bearer` takes a token, `none` is open.
 */
export type McpProbeMode = "none" | "bearer" | "dcr" | "cimd" | "preregistered"

export interface McpProbeResult {
  mode: McpProbeMode
  callbackUrl: string
  resource: string
  scopes: string[]
  requiresClientSecret: boolean
  issuer: string | null
}

export interface McpToolSummary {
  name: string
  description?: string
  /** The server marks it read-only and not destructive (its tools/list annotations). */
  readOnly?: boolean
  /** What each connection default gives this tool (the server's rule, default-policy.ts). */
  defaultDecisions?: Record<McpDefaultPolicy, "auto" | "gate">
  /** Its per-tool override, else the connection default's decision (GET /tools only). */
  effectiveDecision?: McpToolDecision
  /** Whether `effectiveDecision` is the tool's own override or the connection default's. */
  source?: McpDecisionSource
  /**
   * Set when Liaison could not register the tool (its input schema does not convert,
   * so its arguments could not be validated): why. Agents never see such a tool.
   */
  unavailableReason?: string
}

export type McpDecisionSource = "override" | "default"

export interface McpRoleOverride {
  roleId: string
  decision: McpToolDecision
}

export interface McpToolPolicy {
  toolName: string
  overrideDecision: McpToolDecision | null
  roleOverrides: McpRoleOverride[] | null
}

/** One tool's override in a bulk write; null returns the tool to the default. */
export interface McpToolPolicyBulkDecision {
  toolName: string
  overrideDecision: McpToolDecision | null
}

export interface McpToolPolicyUpsertBody {
  toolName: string
  overrideDecision?: McpToolDecision | null
  roleOverrides?: McpRoleOverride[]
}

export interface McpAuditQuery {
  from?: string
  to?: string
  decision?: string
  limit?: number
}

export interface McpAuditRow {
  id: string
  timestamp: string
  app: string
  entity: string
  action: string
  actorId: string | null
  actorType: string
  changes: Record<string, unknown>
}

export interface McpUsageReport {
  calls: number
  errors: number
  p95LatencyMs: number
  bytesIn: number
  bytesOut: number
  topTools: Array<{ toolName: string; calls: number }>
  windowMs: number
}

export type McpUsageWindow = "1h" | "24h" | "7d"

export interface McpTestConnectionResult {
  ok: boolean
  durationMs?: number
  toolCount?: number
  tools?: McpToolSummary[]
  error?: { message: string; code?: string }
}

export interface McpStartOAuthResult {
  authorizationUrl: string
}
