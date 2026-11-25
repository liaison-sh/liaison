// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The switches inside apps (`kernel.org_app_features`) the services worlds turn on.
 * Every one of them is off in a workspace until an admin turns it on (Settings > Apps,
 * or `liaison config apply` `apps[].features`); the `saas` and `studio` demo worlds sell
 * services, so their seed turns them on and the demo shows companies, deals, client
 * reports and recurring billing. `products` turns none on. The standard (dev and QA) world
 * turns them on too, so a developer's workspace shows everything.
 */
import { withPrivilegedDb } from "~/db/privileged"
import { orgAppFeatures } from "~/db/schema/kernel"
import { noteOrgAppsChanged } from "~/modules/apps/org-apps"

export interface DemoFeatureSwitch {
  app: string
  feature: string
}

export const SERVICES_DEMO_FEATURES: readonly DemoFeatureSwitch[] = [
  { app: "contacts", feature: "companies" },
  { app: "projects", feature: "deals" },
  { app: "projects", feature: "client_reports" },
  { app: "invoicing", feature: "recurring" },
]

/**
 * Turn on `features` in a seeded org, as its first state (no actor, no event). Returns
 * `app.feature` for each one. Seed only, never reached from a request.
 */
export async function turnOnSeedFeatures(
  orgId: string,
  features: readonly DemoFeatureSwitch[],
): Promise<string[]> {
  if (features.length === 0) return []
  await withPrivilegedDb(orgId, "seed:features-on", (tx) =>
    tx
      .insert(orgAppFeatures)
      .values(features.map((f) => ({ orgId, appName: f.app, feature: f.feature, enabled: true })))
      .onConflictDoUpdate({
        target: [orgAppFeatures.orgId, orgAppFeatures.appName, orgAppFeatures.feature],
        set: { enabled: true },
      }),
  )
  await noteOrgAppsChanged(orgId)
  return features.map((f) => `${f.app}.${f.feature}`)
}
