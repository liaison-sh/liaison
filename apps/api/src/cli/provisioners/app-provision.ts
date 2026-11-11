// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apps[].provision`: the app's own setup as data, applied by the app.
 *
 * The block is validated against the JSON Schema the app's manifest declares
 * (`provisioning.schema`, modules/apps/app-provisioning.ts); a refusal is a
 * usage error (exit 2) raised before anything is written. Apply runs the app's
 * provisioning handler as a sandboxed run of the app; the plan of a live org
 * (agent tool path) runs it as a dry run, which reports what would change.
 * The handler reports `changed` lines; none means the stored setup already
 * matches the file (`unchanged`).
 */

import { ConfigError } from "~/cli/config/parse"
import type { ProvisionContext } from "~/cli/provisioners/types"
import {
  appHasProvisioning,
  ProvisioningError,
  provisionConfigErrors,
  runAppProvisioning,
} from "~/modules/apps/app-provisioning"
import { ensureAppsForOrg } from "~/modules/apps/init"

/** Throw a ConfigError when the app declares no provisioning or the block fails its schema. */
export function assertProvisionValid(
  orgId: string,
  appName: string,
  provision: Record<string, unknown>,
): void {
  if (!appHasProvisioning(orgId, appName)) {
    throw new ConfigError(`apps.${appName}.provision: the app declares no provisioning`)
  }
  const errors = provisionConfigErrors(orgId, appName, provision)
  if (errors.length > 0) {
    throw new ConfigError(`apps.${appName}.provision: ${errors.join("; ")}`)
  }
}

async function run(
  ctx: ProvisionContext,
  appName: string,
  provision: Record<string, unknown>,
  dryRun: boolean,
): Promise<string[]> {
  await ensureAppsForOrg(ctx.orgId)
  assertProvisionValid(ctx.orgId, appName, provision)
  try {
    const { changed } = await runAppProvisioning({
      orgId: ctx.orgId,
      appName,
      config: provision,
      dryRun,
    })
    return changed
  } catch (err) {
    if (err instanceof ProvisioningError) throw new ConfigError(err.message)
    throw err
  }
}

/** Plan lines of a live org: what the handler would change (dry run). */
export async function planAppProvision(
  ctx: ProvisionContext,
  appName: string,
  provision: Record<string, unknown>,
): Promise<string[]> {
  const changed = await run(ctx, appName, provision, true)
  return changed.map((line) => `provision app '${appName}': ${line}`)
}

export async function applyAppProvision(
  ctx: ProvisionContext,
  appName: string,
  provision: Record<string, unknown>,
): Promise<{ changed: string[]; unchanged: string[] }> {
  const changed = await run(ctx, appName, provision, false)
  const label = `apps.${appName}.provision`
  ctx.log(
    `app '${appName}': provision ${changed.length > 0 ? `applied (${changed.join(", ")})` : "already set"}`,
  )
  return changed.length > 0
    ? { changed: changed.map((line) => `${label}: ${line}`), unchanged: [] }
    : { changed: [], unchanged: [label] }
}
