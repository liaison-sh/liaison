// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apps[].features`: the switches an admin turns on inside an app for the workspace
 * (`kernel.org_app_features`), written as Settings > Apps > <app> > Features writes
 * them (`setAdminOrgAppFeature`): the feature must be one the app declares and does
 * not derive from its own data, and the actor must hold its declared `adminScope`.
 * A feature left out of the file is left as it is. Idempotent: a switch already in
 * the asked position is reported `unchanged` and not written.
 */

import { ConfigError } from "~/cli/config/parse"
import type { ProvisionContext } from "~/cli/provisioners/types"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  listAdminFeatures,
  OrgFeatureError,
  setAdminOrgAppFeature,
} from "~/modules/apps/org-features"

/** The admin features of the app by name, or a ConfigError naming the first unknown one. */
async function checkedFeatures(
  orgId: string,
  appName: string,
  features: Record<string, boolean>,
): Promise<Map<string, boolean>> {
  const listed = await listAdminFeatures(orgId, appName)
  if (listed === null)
    throw new ConfigError(`apps.${appName}.features: ${appName} is not installed`)
  const current = new Map(listed.map((f) => [f.feature, f.enabled]))
  for (const name of Object.keys(features)) {
    if (!current.has(name)) {
      throw new ConfigError(
        `apps.${appName}.features.${name}: not a feature of ${appName} an admin switches (its features: ${[...current.keys()].join(", ") || "none"})`,
      )
    }
  }
  return current
}

/** One line per switch that would change, for a dry run of an org that has the app. */
export async function planAppFeatures(
  ctx: ProvisionContext,
  appName: string,
  features: Record<string, boolean>,
): Promise<string[]> {
  await ensureAppsForOrg(ctx.orgId)
  const current = await checkedFeatures(ctx.orgId, appName, features)
  const lines: string[] = []
  for (const [name, enabled] of Object.entries(features)) {
    if (current.get(name) !== enabled) {
      lines.push(`turn ${enabled ? "on" : "off"} app '${appName}' feature '${name}'`)
    }
  }
  return lines
}

/** Write each switch; `changed` / `unchanged` name `apps.<app>.features.<name>`. */
export async function applyAppFeatures(
  ctx: ProvisionContext,
  appName: string,
  features: Record<string, boolean>,
): Promise<{ changed: string[]; unchanged: string[] }> {
  await ensureAppsForOrg(ctx.orgId)
  await checkedFeatures(ctx.orgId, appName, features)
  const changed: string[] = []
  const unchanged: string[] = []
  for (const [name, enabled] of Object.entries(features)) {
    const key = `apps.${appName}.features.${name}`
    try {
      const r = await setAdminOrgAppFeature({
        orgId: ctx.orgId,
        app: appName,
        feature: name,
        enabled,
        actor: { userId: ctx.actor.userId || null, scopes: ctx.actor.scopes },
      })
      if (r.changed) {
        ctx.log(`app '${appName}': feature '${name}' ${enabled ? "on" : "off"}`)
        changed.push(key)
      } else {
        unchanged.push(key)
      }
    } catch (err) {
      if (err instanceof OrgFeatureError) throw new ConfigError(`${key}: ${err.message}`)
      throw err
    }
  }
  return { changed, unchanged }
}
