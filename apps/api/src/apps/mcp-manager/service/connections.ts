// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side connection service for the mcp-manager AGENT tools (`add_connection`,
// `list_connections`). The REST surface (routes.ts) already creates connections for
// the Settings wizard; these two functions are the agent-callable equivalents for the
// `mcp-connector-add-erp` scenario (BL-169 #6 — drive impossible→0). They run host-side
// (called from the sandbox via the rpc-bridge `mcp_createConnection`/`mcp_listConnections`
// methods) because creating a connection requires AES-256-GCM secret encryption + an SSRF
// guard that cannot run inside the QuickJS handler sandbox.
//
// Both accept the caller's RLS-scoped `tx` (the bridge already runs inside
// `withRlsContext(actor, …)`), so the org_id + write-scope are enforced by RLS exactly
// like the REST path. The agent surface is intentionally narrower than the REST schema:
// http/sse transport + none/bearer auth (an external ERP/MCP server with an API key).
// OAuth flows stay UI-only (they need an interactive browser dance).
//
// Ownership (P3-T1): an `org` connection needs `mcp_manager:connection:write`; a
// `personal` one is owned by the creating user and needs only
// `mcp_manager:personal_connection:write`, which every member holds. A personal
// connection's tools are visible to its owner alone, so creating one grants the
// owner the connection's tool namespace (`mcp:<slug>`) and deleting it takes the
// grant back (`grantOwnerToolNamespace` / `revokeOwnerToolNamespace`).

import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { userScopeGrants, users } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { UnsafeOutboundUrlError, validateOutboundUrlNoDns } from "~/lib/outbound-fetch"
import { recomputePersonalAgentCeiling } from "~/modules/agent/directory/personal-agent"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { connectionToolNamespace } from "~/modules/mcp-client/naming"
import { mcpAllowsPrivateTargets } from "~/modules/mcp-client/transports/safe-fetch"
import { hasScope } from "~/modules/permissions/permissions"

export { connectionToolNamespace }

/** Org-shared connections: create, edit, test, delete. */
export const ORG_CONNECTION_WRITE_SCOPE = "mcp_manager:connection:write"
/** The caller's OWN connections; granted to every member by the manifest. */
export const PERSONAL_CONNECTION_WRITE_SCOPE = "mcp_manager:personal_connection:write"

/** Whether `scopes` may write a connection of this ownership. */
export function canWriteConnection(
  ownershipScope: "org" | "personal",
  scopes: readonly string[],
): boolean {
  const list = [...scopes]
  if (hasScope(ORG_CONNECTION_WRITE_SCOPE, list)) return true
  return ownershipScope === "personal" && hasScope(PERSONAL_CONNECTION_WRITE_SCOPE, list)
}

/**
 * Give the owner of a personal connection its tool namespace, in the caller's
 * transaction (the insert and the grant commit or roll back together). Projected
 * MCP tools require `mcp:<slug>:<tool>`; without this grant the owner's own agent
 * could never call the tools of the connection they just added. The grant flows
 * through every existing gate: the personal agent's ceiling is recomputed, a
 * shared room still floors it away, and a routine carries it only if its owner
 * puts it in the routine's scopes. Other users never hold it, and the tool
 * registry hides a personal connection's tools from them regardless.
 *
 * `user_scope_grants` lets any session of the org write a non-kernel scope (the
 * RLS check refuses only privileged ones), and a user may bump their own
 * `permission_version`, so this runs under the owner's own RLS context.
 */
export async function grantOwnerToolNamespace(
  tx: RlsClient,
  args: { orgId: string; userId: string; slug: string },
): Promise<void> {
  const scope = connectionToolNamespace(args.slug)
  const [grant] = await tx
    .insert(userScopeGrants)
    .values({ userId: args.userId, orgId: args.orgId, scope })
    .onConflictDoNothing()
    .returning({ id: userScopeGrants.id })
  if (!grant) return
  await afterOwnScopeChange(tx, args, scope, "grant")
}

/** Take the namespace back when the personal connection is deleted. */
export async function revokeOwnerToolNamespace(
  tx: RlsClient,
  args: { orgId: string; userId: string; slug: string },
): Promise<void> {
  const scope = connectionToolNamespace(args.slug)
  const [deleted] = await tx
    .delete(userScopeGrants)
    .where(
      and(
        eq(userScopeGrants.userId, args.userId),
        eq(userScopeGrants.orgId, args.orgId),
        eq(userScopeGrants.scope, scope),
      ),
    )
    .returning({ id: userScopeGrants.id })
  if (!deleted) return
  await afterOwnScopeChange(tx, args, scope, "revoke")
}

async function afterOwnScopeChange(
  tx: RlsClient,
  args: { orgId: string; userId: string },
  scope: string,
  action: "grant" | "revoke",
): Promise<void> {
  await tx.queueEvent({
    app: "kernel",
    entity: "user_scope",
    action,
    entityId: args.userId,
    orgId: args.orgId,
    actorId: args.userId,
    data: { targetUserId: args.userId, scope },
  })
  await tx
    .update(users)
    .set({ permissionVersion: drizzleSql`permission_version + 1` })
    .where(and(eq(users.id, args.userId), eq(users.orgId, args.orgId)))
  invalidateAuthCache(args.userId)
  await recomputePersonalAgentCeiling(tx, { userId: args.userId, orgId: args.orgId })
}

const SLUG_MAX = 32

export interface AddMcpConnectionInput {
  /** User-facing connection name, e.g. "Inventory ERP". */
  displayName: string
  /** The MCP server endpoint (https). Required for http/sse. */
  httpUrl: string
  /** Streamable HTTP (default) or SSE. */
  transport?: "http" | "sse"
  /** "bearer" (an API key/token) or "none". Defaults to bearer iff a token is given. */
  authFlavor?: "none" | "bearer"
  /** The bearer API key — stored AES-256-GCM-encrypted, never in plaintext. */
  bearerToken?: string
  /** Optional slug; derived from displayName when omitted. */
  slug?: string
  /** Whether the server's tools are discoverable to the agent once dialed. */
  agentVisibility?: "discoverable" | "hidden"
  /** Default per-tool policy. gate_writes = read auto, write needs approval. */
  connectionDefaultPolicy?: "auto" | "gate_writes" | "gate_all"
  /** "personal" = the actor's own connection; "org" (default) = shared. */
  ownershipScope?: "org" | "personal"
}

export interface McpConnectionSummary {
  id: string
  slug: string
  displayName: string
  transport: string
  httpUrl: string | null
  authFlavor: string
  agentVisibility: string
  connectionDefaultPolicy: string
  ownershipScope: string
  disabled: boolean
  createdAt: string
}

export type CreateMcpConnectionResult =
  | { ok: true; connection: McpConnectionSummary }
  | { ok: false; error: { code: string; message: string } }

interface ConnectionRowShape {
  id: string
  slug: string
  displayName: string
  transport: string
  httpUrl: string | null
  authFlavor: string
  agentVisibility: string
  connectionDefaultPolicy: string
  ownershipScope: string
  disabled: boolean
  createdAt: Date | string
}

/** Lowercase-kebab a display name into a DB-legal slug (≤32, [a-z0-9-]). */
export function deriveSlug(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "")
  return base.length > 0 ? base : "mcp-connection"
}

function toSummary(row: ConnectionRowShape): McpConnectionSummary {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.displayName,
    transport: row.transport,
    httpUrl: row.httpUrl,
    authFlavor: row.authFlavor,
    agentVisibility: row.agentVisibility,
    connectionDefaultPolicy: row.connectionDefaultPolicy,
    ownershipScope: row.ownershipScope,
    disabled: row.disabled,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }
}

/**
 * Whether `scopes` may ask for a connection of this ownership, or why not.
 * `add_connection` declares only the personal scope (every member holds it), so
 * the ORG case is refused here: at stage time by the tool's preflight, before an
 * approval exists (A31: org connections keep mcp_manager:connection:write), and
 * again when the approved call runs.
 */
export function checkConnectionWriteAllowed(
  requested: unknown,
  scopes: readonly string[],
): { code: string; message: string } | null {
  const ownershipScope = requested ?? "org"
  if (ownershipScope !== "org" && ownershipScope !== "personal") {
    return { code: "invalid_ownership", message: "ownershipScope must be 'org' or 'personal'" }
  }
  if (canWriteConnection(ownershipScope, scopes)) return null
  return {
    code: "forbidden",
    message:
      ownershipScope === "org"
        ? "an org-shared MCP connection needs mcp_manager:connection:write; add it as a personal connection instead (ownershipScope: 'personal')"
        : "adding a personal MCP connection needs mcp_manager:personal_connection:write",
  }
}

export async function createMcpConnection(args: {
  tx: RlsClient
  orgId: string
  actor: UserContext
  input: AddMcpConnectionInput
}): Promise<CreateMcpConnectionResult> {
  const { tx, orgId, actor, input } = args

  const refusal = checkConnectionWriteAllowed(input.ownershipScope, actor.scopes ?? [])
  if (refusal) return { ok: false, error: refusal }
  const ownershipScope = input.ownershipScope ?? "org"

  const displayName = (input.displayName ?? "").trim()
  if (!displayName) {
    return {
      ok: false,
      error: { code: "missing_display_name", message: "displayName is required" },
    }
  }
  const transport = input.transport ?? "http"
  if (transport !== "http" && transport !== "sse") {
    return {
      ok: false,
      error: {
        code: "unsupported_transport",
        message: "MCP connections are remote servers reached over http or sse",
      },
    }
  }
  const httpUrl = (input.httpUrl ?? "").trim()
  if (!httpUrl) {
    return {
      ok: false,
      error: { code: "missing_url", message: "httpUrl is required for an http/sse MCP server" },
    }
  }
  // SSRF guard — reject private/loopback/non-HTTPS targets at persist time (re-validated
  // again at dial time). allowPrivateHostsInTest only loosens under the test allowance.
  try {
    validateOutboundUrlNoDns(httpUrl, { allowPrivateHostsInTest: mcpAllowsPrivateTargets() })
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      return { ok: false, error: { code: "unsafe_url", message: err.message } }
    }
    throw err
  }

  const authFlavor: "none" | "bearer" = input.authFlavor ?? (input.bearerToken ? "bearer" : "none")
  if (authFlavor !== "none" && authFlavor !== "bearer") {
    return {
      ok: false,
      error: {
        code: "unsupported_auth",
        message:
          "the agent can only configure 'none' or 'bearer' auth; OAuth connections use the wizard",
      },
    }
  }
  const secretsEncrypted =
    authFlavor === "bearer" && input.bearerToken
      ? encryptSecret(
          JSON.stringify({ bearerToken: input.bearerToken }),
          encryptionKey,
          CryptoContext.mcpConnectionSecrets,
        )
      : null

  const slug = (input.slug?.trim() || deriveSlug(displayName)).slice(0, SLUG_MAX)
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return {
      ok: false,
      error: {
        code: "invalid_slug",
        message: "slug must be lowercase alphanumeric + hyphens (1-32 chars)",
      },
    }
  }

  const agentVisibility = input.agentVisibility ?? "discoverable"
  const connectionDefaultPolicy = input.connectionDefaultPolicy ?? "gate_writes"

  // Pre-check the (org, slug) uniqueness BEFORE inserting so the common collision path
  // answers without a write. A concurrent creator can still win between this read and
  // the INSERT; that race is settled by ON CONFLICT DO NOTHING below, never by catching
  // a 23505: the caller's transaction (the sandbox tool tx) keeps running after we
  // return, and a caught unique violation would leave it aborted (25P02).
  const clash = await tx
    .select({ id: mcpConnections.id })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.orgId, orgId), eq(mcpConnections.slug, slug)))
    .limit(1)
  const slugTaken = {
    ok: false as const,
    error: {
      code: "slug_exists",
      message: `a connection named "${displayName}" (slug ${slug}) already exists — pick a different name`,
    },
  }
  if (clash.length > 0) return slugTaken

  const [row] = await tx
    .insert(mcpConnections)
    .values({
      orgId, // derived from the RLS actor — never trusted from the agent
      slug,
      displayName,
      transport,
      ownershipScope,
      ownerUserId: ownershipScope === "personal" ? actor.userId : null,
      httpUrl,
      authFlavor,
      secretsEncrypted,
      oauthMetadata: null,
      agentVisibility,
      exposeViaGateway: true,
      connectionDefaultPolicy,
      managedBy: "ui",
      disabled: false,
      createdBy: actor.userId,
    })
    // (org_id, slug) is uq_mcp_connections_org_slug: a racing creator's row makes this
    // insert a no-op instead of an error, so the transaction stays usable.
    .onConflictDoNothing({ target: [mcpConnections.orgId, mcpConnections.slug] })
    .returning({
      id: mcpConnections.id,
      slug: mcpConnections.slug,
      displayName: mcpConnections.displayName,
      transport: mcpConnections.transport,
      httpUrl: mcpConnections.httpUrl,
      authFlavor: mcpConnections.authFlavor,
      agentVisibility: mcpConnections.agentVisibility,
      connectionDefaultPolicy: mcpConnections.connectionDefaultPolicy,
      ownershipScope: mcpConnections.ownershipScope,
      disabled: mcpConnections.disabled,
      createdAt: mcpConnections.createdAt,
    })

  if (!row) return slugTaken

  if (ownershipScope === "personal") {
    await grantOwnerToolNamespace(tx, { orgId, userId: actor.userId, slug })
  }

  await tx.queueEvent({
    app: "mcp_manager",
    entity: "connection",
    action: "created",
    entityId: row.id,
    orgId,
    actorId: actor.userId,
    actorType: "user",
    data: { slug, transport, ownershipScope },
  })

  return { ok: true, connection: toSummary(row) }
}

export async function listMcpConnections(args: {
  tx: RlsClient
  orgId: string
}): Promise<McpConnectionSummary[]> {
  const rows = await args.tx
    .select({
      id: mcpConnections.id,
      slug: mcpConnections.slug,
      displayName: mcpConnections.displayName,
      transport: mcpConnections.transport,
      httpUrl: mcpConnections.httpUrl,
      authFlavor: mcpConnections.authFlavor,
      agentVisibility: mcpConnections.agentVisibility,
      connectionDefaultPolicy: mcpConnections.connectionDefaultPolicy,
      ownershipScope: mcpConnections.ownershipScope,
      disabled: mcpConnections.disabled,
      createdAt: mcpConnections.createdAt,
    })
    .from(mcpConnections)
    .where(eq(mcpConnections.orgId, args.orgId))
    .orderBy(mcpConnections.createdAt)
  return rows.map(toSummary)
}
