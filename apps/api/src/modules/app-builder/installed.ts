// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the app builder reads about installed apps, and its one cross-org sweep.
// kernel.apps_installed and apps_active_version have no RLS path for an org's
// person, so these reads run as the system, always narrowed to ONE org's own
// install (`org_id = <caller's org>`): the builder never sees another org's app.
//
//  - `activeCustomApp`: the org's custom app as it runs now (its active version,
//    its grants and its manifest on disk), or null when it was never published.
//  - `customAppInstalled`: whether the org has any install of a name (an app
//    installed by URL under a base a draft wants).
//  - `customAppBuiltByDraft`: whether an install of a name came from one draft
//    (its `source_url` is `builder:draft/<draftId>/<n>`).
//  - `writePublishedAudit` / `hasPublishedAudit`: the audit row of a publish.
//  - `pruneDraftStoreNamespaces`: the preview namespaces (`draft:<id>`) of the
//    data store whose last write is a day old (hourly kernel job).

import { and, eq, like, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { appDocuments, appDocumentUsage, auditLog } from "~/db/schema/kernel"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { rootLogger } from "~/lib/logger"
import { readInstalledManifest } from "~/modules/apps/activation"
import { declaredDomains } from "~/modules/apps/egress-grants"
import { writeAuditLog } from "~/modules/audit/service"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "app-builder/installed" })

/** A draft preview's namespace lives a day after its last write. */
export const DRAFT_STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface ActiveCustomApp {
  name: string
  version: string
  sha256: string
  sourceUrl: string | null
  grantedScopes: string[]
  grantedConnections: string[]
  grantedCapabilities: string[]
  grantedCrossAppCalls: string[]
  /** The outbound domains granted; a grandfathered row (NULL) reads as what its manifest declares. */
  grantedDomains: string[]
  /** The active version's manifest as installed, or null when this process cannot read it. */
  manifest: Record<string, unknown> | null
}

/** The org's own custom app `name` at its active version, or null. */
export async function activeCustomApp(
  orgId: string,
  name: string,
): Promise<ActiveCustomApp | null> {
  const [row] = await withSystemDb("app-builder:active-app", (db) =>
    db
      .select({
        version: appsInstalled.version,
        sha256: appsInstalled.sha256,
        sourceUrl: appsInstalled.sourceUrl,
        grantedScopes: appsInstalled.grantedScopes,
        grantedConnections: appsInstalled.grantedConnections,
        grantedCapabilities: appsInstalled.grantedCapabilities,
        grantedCrossAppCalls: appsInstalled.grantedCrossAppCalls,
        grantedDomains: appsInstalled.grantedDomains,
      })
      .from(appsActiveVersion)
      .innerJoin(
        appsInstalled,
        and(
          eq(appsInstalled.name, appsActiveVersion.name),
          eq(appsInstalled.version, appsActiveVersion.version),
        ),
      )
      .where(and(eq(appsActiveVersion.name, name), eq(appsInstalled.orgId, orgId)))
      .limit(1),
  )
  if (!row) return null
  const manifest = readInstalledManifest(name, row.version)
  return {
    name,
    version: row.version,
    sha256: row.sha256,
    sourceUrl: row.sourceUrl ?? null,
    grantedScopes: row.grantedScopes ?? [],
    grantedConnections: row.grantedConnections ?? [],
    grantedCapabilities: row.grantedCapabilities ?? [],
    grantedCrossAppCalls: row.grantedCrossAppCalls ?? [],
    grantedDomains: row.grantedDomains ?? declaredDomains(manifest ?? {}),
    manifest,
  }
}

/** Whether the org has any installed version of `name`. */
export async function customAppInstalled(orgId: string, name: string): Promise<boolean> {
  const [row] = await withSystemDb("app-builder:any-install", (db) =>
    db
      .select({ name: appsInstalled.name })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.orgId, orgId)))
      .limit(1),
  )
  return row !== undefined
}

/**
 * Whether the org's installs of `name` include one a publish of `draftId`
 * made: how a publish whose install landed but whose draft marking did not is
 * recognised as the draft's own (publish.ts assertPublishIdentity).
 */
export async function customAppBuiltByDraft(
  orgId: string,
  name: string,
  draftId: string,
): Promise<boolean> {
  const [row] = await withSystemDb("app-builder:built-by-draft", (db) =>
    db
      .select({ name: appsInstalled.name })
      .from(appsInstalled)
      .where(
        and(
          eq(appsInstalled.name, name),
          eq(appsInstalled.orgId, orgId),
          like(appsInstalled.sourceUrl, `builder:draft/${draftId}/%`),
        ),
      )
      .limit(1),
  )
  return row !== undefined
}

/** Whether the publish audit row of these exact bytes of `appName` was written. */
export async function hasPublishedAudit(input: {
  orgId: string
  appName: string
  sha256: string
}): Promise<boolean> {
  const [row] = await withPrivilegedDb(input.orgId, "app-builder:publish-audit-read", (db) =>
    db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, input.orgId),
          eq(auditLog.app, input.appName),
          eq(auditLog.action, "app.custom.published"),
          sql`${auditLog.metadata}->>'sha256' = ${input.sha256}`,
        ),
      )
      .limit(1),
  )
  return row !== undefined
}

/** The audit row of a publish: which draft version, which bytes, decided by whom. */
export async function writePublishedAudit(input: {
  orgId: string
  actorId: string
  appName: string
  appVersion: string
  draftId: string
  n: number
  sha256: string
  approvalRequestId?: string | null
}): Promise<void> {
  await withPrivilegedDb(input.orgId, "app-builder:publish-audit", (db) =>
    writeAuditLog(db, {
      orgId: input.orgId,
      actorId: input.actorId,
      actorType: "user",
      app: input.appName,
      entityType: "app_install",
      action: "app.custom.published",
      metadata: {
        version: input.appVersion,
        draftId: input.draftId,
        n: input.n,
        sha256: input.sha256,
        ...(input.approvalRequestId ? { approvalRequestId: input.approvalRequestId } : {}),
      },
    }),
  )
}

/**
 * Wipes every draft preview namespace (`draft:<id>`) whose newest document is
 * older than a day: its documents and counters, whole. An org being moved keeps
 * its namespaces until the move ends.
 */
export async function pruneDraftStoreNamespaces(
  opts: { now?: Date; maxAgeMs?: number } = {},
): Promise<{ namespaces: number }> {
  const cutoff = new Date(
    (opts.now ?? new Date()).getTime() - (opts.maxAgeMs ?? DRAFT_STORE_MAX_AGE_MS),
  )
  const result = await sweepSkippingMoving((notMoving) =>
    withSystemDb("app-builder:draft-store-retention", (db) =>
      db.execute(sql`
        WITH stale AS (
          SELECT org_id, app FROM ${appDocuments}
          WHERE app LIKE 'draft:%' AND ${notMoving(sql`org_id`)}
          GROUP BY org_id, app
          HAVING max(updated_at) < ${cutoff.toISOString()}::timestamptz
        ),
        docs AS (
          DELETE FROM ${appDocuments} d USING stale s
          WHERE d.org_id = s.org_id AND d.app = s.app
          RETURNING d.org_id
        ),
        usage AS (
          DELETE FROM ${appDocumentUsage} u USING stale s
          WHERE u.org_id = s.org_id AND u.app = s.app
          RETURNING u.org_id
        )
        SELECT (SELECT count(*) FROM stale)::int AS namespaces,
               (SELECT count(*) FROM docs)::int AS docs,
               (SELECT count(*) FROM usage)::int AS usage
      `),
    ),
  )
  const namespaces = Number(extractRows<{ namespaces: number }>(result)[0]?.namespaces ?? 0)
  if (namespaces > 0) log.info({ namespaces }, "draft preview store namespaces wiped")
  return { namespaces }
}
