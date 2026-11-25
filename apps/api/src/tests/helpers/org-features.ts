// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Turn on switches inside apps (`kernel.org_app_features`) for a test's org, as an admin
 * would from Settings > Apps. Every such feature is off in a new workspace, so a test that
 * exercises companies, deals, client reports or recurring billing turns them on. The rows are
 * written directly (the org's apps need not be registered yet) and the org's cached state is
 * read again.
 */
import { withPrivilegedDb } from "~/db/privileged"
import { orgAppFeatures } from "~/db/schema/kernel"
import { noteOrgAppsChanged } from "~/modules/apps/org-apps"

export const SERVICES_FEATURES = [
  ["contacts", "companies"],
  ["projects", "deals"],
  ["projects", "client_reports"],
  ["invoicing", "recurring"],
] as const

export async function turnOnOrgFeatures(
  orgId: string,
  features: ReadonlyArray<readonly [app: string, feature: string]> = SERVICES_FEATURES,
): Promise<void> {
  await withPrivilegedDb(orgId, "test-org-features-on", (tx) =>
    tx
      .insert(orgAppFeatures)
      .values(features.map(([appName, feature]) => ({ orgId, appName, feature, enabled: true })))
      .onConflictDoUpdate({
        target: [orgAppFeatures.orgId, orgAppFeatures.appName, orgAppFeatures.feature],
        set: { enabled: true },
      }),
  )
  await noteOrgAppsChanged(orgId)
}
