// SPDX-License-Identifier: FSL-1.1-ALv2
import { withPrivilegedDb } from "~/db/privileged"
import { seedManifestDefaults } from "~/modules/saved-views/seed"

/**
 * Backfill one org's manifest-declared default saved views. Called on startup
 * for each org, once its apps are registered (they declare the defaults).
 * Idempotent.
 */
export async function runBackfillForOrg(orgId: string): Promise<void> {
  await withPrivilegedDb(orgId, "saved-views-backfill", async (tx) => {
    await seedManifestDefaults(tx, orgId)
  })
}
