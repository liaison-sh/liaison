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

import { readFileSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
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

/**
 * A provision block may name a file next to the config file where a value is
 * long (an adapter document): `{ $file: "adapters/crm.yaml" }` is replaced by
 * that file's text before the app sees the block. The path is relative to the
 * config file's directory and may not leave it. An agent's config tool has no
 * config directory: a `$file` there is refused.
 */
export function resolveProvisionFiles(
  value: unknown,
  configDir: string | undefined,
  where: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => resolveProvisionFiles(v, configDir, `${where}[${i}]`))
  }
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === "$file") {
    const path = record.$file
    if (typeof path !== "string" || path === "") {
      throw new ConfigError(`${where}: $file names a file path`)
    }
    if (!configDir) throw new ConfigError(`${where}: $file needs a config file; pass the content inline`)
    if (isAbsolute(path)) throw new ConfigError(`${where}: '${path}' must be relative to the config file directory`)
    const base = resolve(configDir)
    const target = resolve(base, path)
    const rel = relative(base, target)
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new ConfigError(`${where}: '${path}' escapes the config file directory`)
    }
    try {
      return readFileSync(target, "utf8")
    } catch (err) {
      throw new ConfigError(
        `${where}: cannot read '${path}': ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return Object.fromEntries(
    keys.map((k) => [k, resolveProvisionFiles(record[k], configDir, `${where}.${k}`)]),
  )
}

async function runProvisionBlock(
  ctx: ProvisionContext,
  appName: string,
  rawProvision: Record<string, unknown>,
  dryRun: boolean,
): Promise<string[]> {
  const provision = resolveProvisionFiles(
    rawProvision,
    ctx.toolPath ? undefined : ctx.configDir,
    `apps.${appName}.provision`,
  ) as Record<string, unknown>
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
  const changed = await runProvisionBlock(ctx, appName, provision, true)
  return changed.map((line) => `provision app '${appName}': ${line}`)
}

export async function applyAppProvision(
  ctx: ProvisionContext,
  appName: string,
  provision: Record<string, unknown>,
): Promise<{ changed: string[]; unchanged: string[] }> {
  const changed = await runProvisionBlock(ctx, appName, provision, false)
  const label = `apps.${appName}.provision`
  ctx.log(
    `app '${appName}': provision ${changed.length > 0 ? `applied (${changed.join(", ")})` : "already set"}`,
  )
  return changed.length > 0
    ? { changed: changed.map((line) => `${label}: ${line}`), unchanged: [] }
    : { changed: [], unchanged: [label] }
}
