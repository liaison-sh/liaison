// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apps[].config` — non-secret app config keys written through the SAME
 * allowlist as the kernel route `PUT /api/apps/:app/config/:key`
 * (`~/modules/apps/app-config.ts`): a key must be declared in the installed
 * app's manifest `configKeys`, a connection secret key is refused, and the
 * value must match the declared type. Any refusal is a usage error (exit 2),
 * raised before the first key is written. Idempotent: an equal stored value is
 * reported `unchanged` and not written.
 */

import { ConfigError } from "~/cli/config/parse"
import type { ProvisionContext } from "~/cli/provisioners/types"
import { checkAppConfigWriteForOrg, writeAppConfigKey } from "~/modules/apps/app-config"
import { ensureAppsForOrg } from "~/modules/apps/init"

export interface AppConfigApplyResult {
  changed: string[]
  unchanged: string[]
}

/** Throw a ConfigError for the first key the allowlist refuses. */
export function assertAppConfigAllowed(
  orgId: string,
  appName: string,
  config: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(config)) {
    const check = checkAppConfigWriteForOrg(orgId, appName, key, value)
    if (!check.ok) throw new ConfigError(`apps.${appName}.config.${key}: ${check.message}`)
  }
}

export async function applyAppConfig(
  ctx: ProvisionContext,
  appName: string,
  config: Record<string, unknown>,
): Promise<AppConfigApplyResult> {
  // The allowlist reads the app's registered manifest; registration is warmed
  // by the org provisioner (a no-op then) or by the catalog install above.
  await ensureAppsForOrg(ctx.orgId)
  assertAppConfigAllowed(ctx.orgId, appName, config)
  const result: AppConfigApplyResult = { changed: [], unchanged: [] }
  for (const [key, value] of Object.entries(config)) {
    const label = `apps.${appName}.config.${key}`
    const { changed } = await writeAppConfigKey({
      orgId: ctx.orgId,
      appName,
      key,
      value,
      actorId: ctx.actor.userId || null,
      actorType: "user",
      source: "config-apply",
    })
    ctx.log(`app '${appName}': config '${key}' ${changed ? "written" : "already set"}`)
    ;(changed ? result.changed : result.unchanged).push(label)
  }
  return result
}
