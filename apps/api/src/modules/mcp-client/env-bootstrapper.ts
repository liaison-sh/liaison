// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boot-time MCP env-var bootstrapper.
//
// Spec §3.1.1: converges the `mcp_connections` table to whatever
// `LIAISON_MCP_*` env vars are set. env-managed rows whose vars disappear are
// orphaned (`managedBy="ui"`, `displayName="[orphaned] …"`) rather than deleted
// so per-tool policy is preserved across the boot.

import { and, eq } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { users } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { type ParsedConnection, parseEnvConnections } from "~/modules/mcp-client/env-bootstrap"

const log = rootLogger.child({ module: "mcp-env-bootstrap" })

const ORPHAN_PREFIX = "[orphaned] "

/**
 * Build a per-flavor secrets blob suitable for AES-GCM encryption + storage in
 * `mcp_connections.secrets_encrypted`. Returns null when the connection has
 * nothing secret to persist (no bearer, no oauth client secret).
 */
function buildSecretsBlob(conn: ParsedConnection): Record<string, unknown> | null {
  const blob: Record<string, unknown> = {}
  if (conn.authFlavor === "bearer" && conn.bearerToken) {
    blob.bearerToken = conn.bearerToken
  }
  if (
    (conn.authFlavor === "oauth_dcr" || conn.authFlavor === "oauth_static") &&
    conn.oauthClientSecret
  ) {
    blob.oauthClientSecret = conn.oauthClientSecret
  }
  return Object.keys(blob).length === 0 ? null : blob
}

/**
 * Build the `oauth_metadata` JSON column from env-var-supplied OAuth coordinates.
 * Only `oauth_dcr` and `oauth_static` flavors populate this. Returns null when
 * no oauth fields are present so the column stays NULL for non-oauth flavors.
 */
function buildOAuthMetadata(conn: ParsedConnection): Record<string, unknown> | null {
  if (conn.authFlavor !== "oauth_dcr" && conn.authFlavor !== "oauth_static") {
    return null
  }
  const meta: Record<string, unknown> = {}
  if (conn.oauthClientId) meta.clientId = conn.oauthClientId
  if (conn.oauthAuthorizationUrl) meta.authorizationEndpoint = conn.oauthAuthorizationUrl
  if (conn.oauthTokenUrl) meta.tokenEndpoint = conn.oauthTokenUrl
  if (conn.oauthScopes) meta.scopes = conn.oauthScopes
  return Object.keys(meta).length === 0 ? null : meta
}

/**
 * Resolve `created_by` for an env-managed row. We need a real user id from the
 * target org because `mcp_connections.created_by` is NOT NULL with FK to
 * `kernel.users` and `onDelete: "restrict"`. Strategy: prefer the env-supplied
 * `OWNER_USER_ID` when present; otherwise pick any existing user in the org.
 * If the org has no users at boot time, this is a misconfiguration — log + skip.
 */
async function resolveCreatedBy(conn: ParsedConnection): Promise<string | null> {
  if (conn.ownerUserId) return conn.ownerUserId
  return await withSystemDb("env-bootstrap-resolve-user", async (db) => {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.orgId, conn.orgId))
      .limit(1)
    return rows[0]?.id ?? null
  })
}

interface UpsertRow {
  orgId: string
  slug: string
  displayName: string
  transport: ParsedConnection["transport"]
  ownershipScope: ParsedConnection["ownershipScope"]
  ownerUserId: string | null
  httpUrl: string
  authFlavor: ParsedConnection["authFlavor"]
  secretsEncrypted: string | null
  oauthMetadata: Record<string, unknown> | null
  agentVisibility: ParsedConnection["agentVisibility"]
  exposeViaGateway: boolean
  connectionDefaultPolicy: ParsedConnection["connectionDefaultPolicy"]
  rateCapPerMinute: number | null
  managedBy: "env"
  createdBy: string
}

function buildUpsertRow(conn: ParsedConnection, createdBy: string): UpsertRow {
  const blob = buildSecretsBlob(conn)
  const encrypted = blob
    ? encryptSecret(JSON.stringify(blob), encryptionKey, CryptoContext.mcpConnectionSecrets)
    : null
  return {
    orgId: conn.orgId,
    slug: conn.slug,
    displayName: conn.displayName,
    transport: conn.transport,
    ownershipScope: conn.ownershipScope,
    ownerUserId: conn.ownerUserId ?? null,
    httpUrl: conn.httpUrl,
    authFlavor: conn.authFlavor,
    secretsEncrypted: encrypted,
    oauthMetadata: buildOAuthMetadata(conn),
    agentVisibility: conn.agentVisibility,
    exposeViaGateway: conn.exposeViaGateway,
    connectionDefaultPolicy: conn.connectionDefaultPolicy,
    rateCapPerMinute: conn.rateCapPerMinute ?? null,
    managedBy: "env",
    createdBy,
  }
}

/**
 * Run the env-var bootstrap convergence pass.
 *
 * Idempotent: re-running with the same env produces the same DB state. Run by
 * the leader on lease acquire (index.ts `initMcpClient`): one process at a
 * time converges the rows; each upsert is one statement on the (org_id, slug)
 * unique key, so an overlapping run never fails on a duplicate.
 *
 * `envVars` defaults to `process.env` so production wiring is `await runEnvBootstrap()`.
 */
export async function runEnvBootstrap(
  envVars: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<void> {
  const parsed = parseEnvConnections(envVars)
  const desiredSlugs = new Set(parsed.map((p) => `${p.orgId}:${p.slug}`))

  for (const conn of parsed) {
    const createdBy = await resolveCreatedBy(conn)
    if (!createdBy) {
      log.error(
        { orgId: conn.orgId, slug: conn.slug },
        "env-bootstrap: cannot resolve created_by — no users in target org and no OWNER_USER_ID supplied; skipping",
      )
      continue
    }

    await withSystemDb("env-bootstrap-upsert", async (db) => {
      const [current] = await db
        .select({ managedBy: mcpConnections.managedBy })
        .from(mcpConnections)
        .where(and(eq(mcpConnections.orgId, conn.orgId), eq(mcpConnections.slug, conn.slug)))
      if (current?.managedBy === "ui") {
        log.warn(
          { slug: conn.slug, orgId: conn.orgId },
          "env-managed connection overwrote ui-managed row",
        )
      }
      const row = buildUpsertRow(conn, createdBy)
      // One statement on the (org_id, slug) unique key: two runs at once (two
      // leaders in turn, a rolling deploy) converge on one row, never a
      // unique violation.
      const [written] = await db
        .insert(mcpConnections)
        .values(row)
        .onConflictDoUpdate({
          target: [mcpConnections.orgId, mcpConnections.slug],
          set: {
            managedBy: "env",
            transport: row.transport,
            displayName: row.displayName,
            httpUrl: row.httpUrl,
            authFlavor: row.authFlavor,
            secretsEncrypted: row.secretsEncrypted,
            oauthMetadata: row.oauthMetadata,
            ownershipScope: row.ownershipScope,
            ownerUserId: row.ownerUserId,
            agentVisibility: row.agentVisibility,
            exposeViaGateway: row.exposeViaGateway,
            connectionDefaultPolicy: row.connectionDefaultPolicy,
            rateCapPerMinute: row.rateCapPerMinute,
            updatedAt: new Date(),
          },
        })
        .returning({ id: mcpConnections.id })
      // Every process projects its own copy of the org's connections (from the
      // org's first touch): the event makes the ones that already did project
      // again (mcp-client `applyMcpConnectionEvent`), so no peer keeps a missing
      // or stale env connection until its restart.
      if (written) await queueEnvSyncedEvent(db, written.id, conn.orgId, conn.slug, !current)
    })
  }

  // Orphan: any env-managed row whose `(orgId, slug)` is no longer in desiredSlugs.
  // Demote to UI ownership and prefix `displayName` (idempotently — don't double-prefix
  // if the row was already orphaned in a prior boot).
  await withSystemDb("env-bootstrap-orphans", async (db) => {
    const candidates = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.managedBy, "env"))
    for (const row of candidates) {
      if (!desiredSlugs.has(`${row.orgId}:${row.slug}`)) {
        const newName = row.displayName.startsWith(ORPHAN_PREFIX)
          ? row.displayName
          : `${ORPHAN_PREFIX}${row.displayName}`
        await db
          .update(mcpConnections)
          .set({
            managedBy: "ui",
            displayName: newName,
            updatedAt: new Date(),
          })
          .where(eq(mcpConnections.id, row.id))
        await queueEnvSyncedEvent(db, row.id, row.orgId, row.slug, false)
        log.info(
          { slug: row.slug, orgId: row.orgId },
          "env-managed connection orphaned (env var removed)",
        )
      }
    }
  })
}

/** The connection event peers re-project an env-managed connection from. */
async function queueEnvSyncedEvent(
  db: PrivilegedDb,
  connectionId: string,
  orgId: string,
  slug: string,
  created: boolean,
): Promise<void> {
  await db.queueEvent({
    app: "mcp_manager",
    entity: "connection",
    action: created ? "created" : "updated",
    entityId: connectionId,
    orgId,
    actorId: null,
    actorType: "system",
    data: { slug, envSynced: true },
  })
}
