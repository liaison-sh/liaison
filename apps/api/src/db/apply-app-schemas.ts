// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Applies the in-tree apps' manifest schemas to the database DATABASE_URL names,
// without setting up any org: the tables and columns an app's manifest declares
// (on top of what the migrations create) exist as soon as this returns.
//
// The schema is applied by the registration itself (`registerApps`), so it can
// never drift from what an org's setup applies. The registration runs for a
// throwaway org with `skipOrgRows` (no kernel.apps row, no settings, no roles),
// and the org is deleted afterwards: the database is left with the app schemas
// and nothing else.
//
// Used to build the test template database (scripts/lib/test-template.ts), so a
// test that reads an app table gets the manifest's shape whether or not another
// test registered the apps in the same database first.
//
//   MIGRATION_DATABASE_URL / DATABASE_URL=... bun src/db/apply-app-schemas.ts

import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import apiConnectionsManifest from "../../../../bundled-apps/api-connector/app.manifest.json"
import { getDefaultApps } from "~/modules/apps/init"
import { registerApps } from "~/modules/apps/runtime"

/**
 * The api-connector catalog app as a descriptor registered from its source
 * (the sandbox builds its handlers from `bundled-apps/api-connector/handlers.ts`), for the test
 * template and for tests that register the app for their org.
 */
export function apiConnectorSourceDescriptor(): Awaited<ReturnType<typeof getDefaultApps>>[number] {
  return {
    ...apiConnectionsManifest,
    _format: "manifest" as const,
    // As the image's own catalog tarball is: the platform vouches for its code.
    _firstParty: true,
    // An installed bundle's path shape (`<name>/<version>/bundle.js`): the
    // sandbox builds it from the app's source (bundle-loader.ts, outside production).
    _bundlePath: new URL(
      `../../../../bundled-apps/.source/api-connector/${apiConnectionsManifest.version}/bundle.js`,
      import.meta.url,
    ).pathname,
  } as unknown as Awaited<ReturnType<typeof getDefaultApps>>[number]
}

/** The throwaway org the registration runs for; deleted before exit. */
export const APPLY_APP_SCHEMAS_ORG_ID = "00000000-0000-4000-8000-0000a990c4e0"

export async function applyAppSchemas(): Promise<{ apps: string[] }> {
  const orgId = APPLY_APP_SCHEMAS_ORG_ID
  const organizations = sql`${sql(schemaRef("kernel"))}.organizations`
  await sql`
    INSERT INTO ${organizations} (id, name, slug)
    VALUES (${orgId}, 'app schema build', 'app-schema-build')
    ON CONFLICT DO NOTHING`
  try {
    // The catalog app whose tables the platform's API connections read
    // (modules/apps/connections/api/store.ts): its schema is part of what a
    // test reading those tables needs, registered from its manifest the same way.
    const apps = [...(await getDefaultApps()), apiConnectorSourceDescriptor()]
    const { failedApps } = await registerApps(apps, orgId, { skipOrgRows: true })
    if (failedApps.length > 0) {
      throw new Error(`app schemas not applied: ${failedApps.join(", ")} failed to register`)
    }
    return { apps: apps.map((a) => a.name) }
  } finally {
    await sql`DELETE FROM ${organizations} WHERE id = ${orgId}`
  }
}

if (import.meta.main) {
  const t0 = Date.now()
  try {
    const { apps } = await applyAppSchemas()
    console.log(
      `app schemas applied (${apps.length} apps: ${apps.join(", ")}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    )
    process.exit(0)
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err)
    process.exit(1)
  }
}
