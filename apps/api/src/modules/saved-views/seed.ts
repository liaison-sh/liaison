// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { manifestRegistry } from "~/modules/apps/app-registries"

/**
 * Seed manifest-declared default saved views for one org. Idempotent: relies on
 * the partial unique index on (org_id, app, view_id, manifest_key) WHERE
 * is_default AND manifest_key IS NOT NULL to skip rows that already exist —
 * which preserves admin renames.
 */
export async function seedManifestDefaults(tx: PrivilegedDb, orgId: string): Promise<void> {
  const savedViewsTable = drizzleSql.raw(`${schemaRef("kernel")}.saved_views`)
  for (const [[regOrgId, appName], manifest] of manifestRegistry.entriesOf(orgId)) {
    if (regOrgId !== orgId) continue
    if (!manifest.savedViews) continue
    for (const [viewId, decl] of Object.entries(manifest.savedViews)) {
      for (const def of decl.defaults) {
        await tx.execute(drizzleSql`
          INSERT INTO ${savedViewsTable}
            (org_id, app, view_id, manifest_key, name, payload, owner_user_id, shared_with_org, is_default)
          VALUES
            (${orgId}, ${appName}, ${viewId}, ${def.key}, ${def.name},
             ${JSON.stringify(def.payload)}::jsonb, NULL, true, true)
          ON CONFLICT (org_id, app, view_id, manifest_key)
          WHERE is_default = true AND manifest_key IS NOT NULL
          DO NOTHING
        `)
      }
    }
  }
}
