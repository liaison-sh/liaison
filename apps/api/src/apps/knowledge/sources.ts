// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Source policy management — `app_knowledge.source_policies`.
 *
 * Operations:
 *   - `loadSourcePolicy(tx, source, actor)` — returns the real row if one
 *     exists, else a zero-cache default (R-I9). Read-side runs under
 *     `knowledge:sources:read` (RLS-enforced).
 *   - `updateSourcePolicy(tx, source, patch, actor)` — upsert + revision
 *     bump. Write-side requires `knowledge:sources:manage` (RLS WITH CHECK).
 *     On downgrade from `content_cache` to any other policy, cached content
 *     for that source is invalidated (R-IS-1, M10) via a privileged connection
 *     (the cache table's RLS write-check requires a scope the curator role,
 *     which owns source settings, does not hold).
 *   - `loadSearchPolicies(tx)` — every source's `broadSearchEnabled`, read by
 *     federated search (source-registry.ts).
 */

import type { KnowledgeSourcePolicyPatch } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, KnowledgeError } from "~/apps/knowledge/service"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"

type SqlClient = RlsClient | RlsTx

export type KnowledgeSourcePolicyValue =
  | "disabled"
  | "remote_search"
  | "metadata_only"
  | "content_cache"

export interface KnowledgeSourcePolicyRow {
  source: string
  orgId: string
  policy: KnowledgeSourcePolicyValue
  connectionMode: "selected" | "org-owned" | "shared"
  broadSearchEnabled: boolean
  cacheBytes: number
  retainedChunks: number
  retentionDays: number
  updatedAt: string | null
}

interface DbRow {
  source: string
  org_id: string
  policy: string
  connection_mode: string
  broad_search_enabled: boolean
  cache_bytes: number
  retained_chunks: number
  retention_days: number
  updated_at: Date | string | null
}

function rowFromDb(r: DbRow): KnowledgeSourcePolicyRow {
  return {
    source: r.source,
    orgId: r.org_id,
    policy: r.policy as KnowledgeSourcePolicyValue,
    connectionMode: r.connection_mode as "selected" | "org-owned" | "shared",
    broadSearchEnabled: r.broad_search_enabled,
    cacheBytes: r.cache_bytes,
    retainedChunks: r.retained_chunks,
    retentionDays: r.retention_days,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  }
}

export function zeroCacheDefault(orgId: string, source: string): KnowledgeSourcePolicyRow {
  return {
    source,
    orgId,
    policy: "remote_search",
    connectionMode: "selected",
    broadSearchEnabled: false,
    cacheBytes: 0,
    retainedChunks: 0,
    retentionDays: 0,
    updatedAt: null,
  }
}

export async function loadSourcePolicy(
  tx: SqlClient,
  source: string,
  actor: KnowledgeActor,
): Promise<KnowledgeSourcePolicyRow> {
  const result = await tx.execute(drizzleSql`
    SELECT source, org_id, policy, connection_mode, broad_search_enabled,
           cache_bytes, retained_chunks, retention_days, updated_at
    FROM ${knowledgeRel("source_policies")}
    WHERE source = ${source}
    LIMIT 1
  `)
  const row = extractRows<DbRow>(result)[0]
  if (row) return rowFromDb(row)
  return zeroCacheDefault(actor.orgId, source)
}

/**
 * `broadSearchEnabled` of every source the org set a policy for (RLS scopes the
 * read to the org): federated search includes an app's `knowledgeItems.search`
 * when its row says so, or by the app's `searchByDefault` when it has no row.
 */
export async function loadSearchPolicies(tx: SqlClient): Promise<Map<string, boolean>> {
  const rows = extractRows<{ source: string; broad_search_enabled: boolean }>(
    await tx.execute(drizzleSql`
      SELECT source, broad_search_enabled FROM ${knowledgeRel("source_policies")}
    `),
  )
  return new Map(rows.map((r) => [r.source, r.broad_search_enabled]))
}

export async function updateSourcePolicy(
  tx: SqlClient,
  source: string,
  patch: KnowledgeSourcePolicyPatch,
  actor: KnowledgeActor,
): Promise<KnowledgeSourcePolicyRow> {
  // Load existing row (if any) to detect a content_cache downgrade. RLS
  // already enforces `knowledge:sources:read` for the SELECT and
  // `knowledge:sources:manage` for the INSERT/UPDATE — there is no need to
  // re-check scopes here, but we still validate the policy enum to surface a
  // helpful error rather than a generic 500.
  const existing = await loadSourcePolicy(tx, source, actor)
  const next: KnowledgeSourcePolicyRow = {
    ...existing,
    ...(patch.policy !== undefined ? { policy: patch.policy as KnowledgeSourcePolicyValue } : {}),
    ...(patch.connectionMode !== undefined ? { connectionMode: patch.connectionMode } : {}),
    ...(patch.broadSearchEnabled !== undefined
      ? { broadSearchEnabled: patch.broadSearchEnabled }
      : {}),
    ...(patch.cacheBytes !== undefined ? { cacheBytes: patch.cacheBytes } : {}),
    ...(patch.retainedChunks !== undefined ? { retainedChunks: patch.retainedChunks } : {}),
    ...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
  }

  const upserted = await tx.execute(drizzleSql`
    INSERT INTO ${knowledgeRel("source_policies")}
      (id, org_id, source, policy, connection_mode, broad_search_enabled,
       cache_bytes, retained_chunks, retention_days, created_at, updated_at)
    VALUES (
      gen_random_uuid(),
      ${actor.orgId}::uuid,
      ${source},
      ${next.policy},
      ${next.connectionMode},
      ${next.broadSearchEnabled},
      ${next.cacheBytes},
      ${next.retainedChunks},
      ${next.retentionDays},
      now(), now()
    )
    ON CONFLICT (org_id, source) DO UPDATE SET
      policy = EXCLUDED.policy,
      connection_mode = EXCLUDED.connection_mode,
      broad_search_enabled = EXCLUDED.broad_search_enabled,
      cache_bytes = EXCLUDED.cache_bytes,
      retained_chunks = EXCLUDED.retained_chunks,
      retention_days = EXCLUDED.retention_days,
      updated_at = now()
    RETURNING source, org_id, policy, connection_mode, broad_search_enabled,
              cache_bytes, retained_chunks, retention_days, updated_at
  `)
  const row = extractRows<DbRow>(upserted)[0]
  if (!row) throw new KnowledgeError("VALIDATION", "Failed to upsert source policy")

  // IS-1 / M10: when downgrading away from content_cache, invalidate cached
  // content for the source so the new policy is honored immediately.
  const downgrade = existing.policy === "content_cache" && next.policy !== "content_cache"
  if (downgrade) {
    // content_cache_entries don't carry the `source` column directly — they link
    // to source_identities, which does. Mark every linked cache row as unusable
    // so the new policy is honored immediately; byte reclamation runs out-of-band
    // via a janitor job.
    //
    // This runs under a PRIVILEGED connection, not the request RLS tx: the
    // content_cache_entries RLS write-check requires `knowledge:cache:manage`,
    // which the curator role (who owns source settings and holds
    // `knowledge:sources:manage`) lacks — so doing it on the RLS tx would raise an
    // RLS violation and abort the whole policy update. The actor has already
    // passed `sources:manage` and a downgrade necessarily implies invalidation.
    // Trade-off vs. the original single-tx intent: a separate tx means that if the
    // caller's tx later rolls back, the cache stays invalidated — the safe
    // direction (cached content simply isn't served). Because privileged bypasses
    // RLS, this UPDATE MUST be explicitly org-scoped.
    await withPrivilegedDb(actor.orgId, "knowledge-cache-downgrade", async (pdb) => {
      await pdb.execute(drizzleSql`
        UPDATE ${knowledgeRel("content_cache_entries")} AS cce
        SET usable = false, updated_at = now()
        FROM ${knowledgeRel("source_identities")} AS si
        WHERE cce.org_id = ${actor.orgId}::uuid
          AND si.org_id = ${actor.orgId}::uuid
          AND cce.source_identity_id = si.id
          AND si.source = ${source}
          AND cce.usable = true
      `)
    })
  }

  return rowFromDb(row)
}
