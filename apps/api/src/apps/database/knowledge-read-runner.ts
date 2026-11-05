// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side read runner binding the database Knowledge adapter's deps
// (`runRead` / `hasRead`) to the REAL database-app machinery: the connections
// credential store, the pooled DbTransport, and the db-core curated-reads
// catalog. This is the production wiring `createDatabaseKnowledgeAdapter`
// consumes — the app-to-app seam.
//
// It REUSES the database app's existing code (buildTransport / getOrBuildTransport
// pool, getCredentialsForConnection, resolveDatabaseCatalog) — it does NOT open
// a bespoke `pg` client, and it never interpolates a schema identifier into SQL
// (curated reads own all SQL). If no database connection exists for the org,
// `hasRead` returns false and `runRead` throws NOT_CONNECTED — which the adapter
// swallows into an empty/unsupported result (non-throwing IO contract).

import {
  buildTransport,
  CONNECTION_IDENTIFIER,
  type DatabaseCredentials,
  getOrBuildTransport,
  pinCallerOrg,
  resolveDatabaseCatalog,
} from "~/apps/database/bridge"
import { DbTransportError } from "~/apps/database/transport"
import type { RlsClient } from "~/db"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "database-knowledge-read-runner" })

export interface DatabaseKnowledgeReadRunner {
  runRead(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ rows: Record<string, unknown>[] }>
  hasRead(name: string): boolean
}

export interface DatabaseKnowledgeReadRunnerInput {
  tx: RlsClient
  orgId: string
  userId: string
  identifier?: string
}

/**
 * Build a request-scoped `{ runRead, hasRead }` bound to the caller's tx/org/
 * user. Catalog resolution is synchronous (in-tree adapter or mounted YAML),
 * so `hasRead` can answer without touching credentials — it reflects the
 * connected catalog's declared reads. `runRead` resolves creds + pools a
 * transport lazily on first call; a missing connection surfaces as a thrown
 * NOT_CONNECTED error for the adapter to swallow.
 */
export function createDatabaseKnowledgeReadRunner(
  input: DatabaseKnowledgeReadRunnerInput,
): DatabaseKnowledgeReadRunner {
  const { tx, orgId, userId, identifier = CONNECTION_IDENTIFIER } = input

  // Resolve the catalog once for this request. If catalog resolution itself is
  // misconfigured (unknown adapter / unreadable YAML), treat the source as
  // capability-less rather than crashing the whole sync registry build.
  let catalog: ReturnType<typeof resolveDatabaseCatalog> | null = null
  try {
    catalog = resolveDatabaseCatalog()
  } catch (err) {
    log.warn({ err, orgId }, "database knowledge: catalog resolution failed; source disabled")
    catalog = null
  }

  const hasRead = (name: string): boolean => Boolean(catalog?.reads[name])

  const runRead = async (
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ rows: Record<string, unknown>[] }> => {
    if (!catalog) {
      throw new DbTransportError("No database catalog available", "not_connected")
    }
    const read = catalog.reads[name]
    if (!read) {
      throw new DbTransportError(`Unknown read "${name}"`, "not_connected")
    }
    const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
    const raw = await getCredentialsForConnection(
      tx,
      orgId,
      userId,
      "database",
      "database",
      identifier,
      // Org-owned only, as in the bridge: the pooled transport is org-wide.
      { actorType: "system", ownerType: "org" },
    )
    const creds: DatabaseCredentials = {
      connectionString: raw.connectionString,
      gateUrl: raw.gateUrl,
      gateToken: raw.gateToken,
    }
    const transport = await getOrBuildTransport(orgId, creds, buildTransport, identifier)
    const result = await transport.runRead(read, name, pinCallerOrg(catalog, params, orgId))
    return { rows: result.rows }
  }

  return { runRead, hasRead }
}
