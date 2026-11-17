// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { enabledFeaturesFor, isAppOffForOrg } from "~/modules/apps/org-apps"
import { seedLegalStarterTemplates } from "~/modules/documents/legal-templates/starters"

/**
 * Seed manifest-declared default saved views for one org. Idempotent: relies on
 * the partial unique index on (org_id, app, view_id, manifest_key) WHERE
 * is_default AND manifest_key IS NOT NULL to skip rows that already exist —
 * which preserves admin renames.
 */
export async function seedManifestDefaults(tx: PrivilegedDb, orgId: string): Promise<void> {
  await seedAgreementStarters(tx, orgId)
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

/**
 * An organisation using an app that declares `legalStarterTemplates` gets the starter
 * templates: kernel document templates in the classic legal layout
 * (modules/documents/legal-templates). Only the missing ones are added, so an organisation's own
 * edits, renames and archives stay; the corporate acts only while the feature the app names is on.
 */
async function seedAgreementStarters(tx: PrivilegedDb, orgId: string): Promise<void> {
  let wanted = false
  let corporateTemplates = false
  for (const [[regOrgId, appName], manifest] of manifestRegistry.entriesOf(orgId)) {
    const decl = manifest.legalStarterTemplates
    if (regOrgId !== orgId || !decl || isAppOffForOrg(orgId, appName)) continue
    wanted = true
    const feature = decl.corporateFeature
    if (
      feature &&
      enabledFeaturesFor(orgId).some((f) => f.app === appName && f.feature === feature)
    )
      corporateTemplates = true
  }
  if (wanted) await seedLegalStarterTemplates(tx, orgId, { corporateTemplates })
}
