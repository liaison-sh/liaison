// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apps[].appSecrets` — app-held secrets a person gives Liaison (a webhook
 * endpoint's signing secret the provider shows once in its dashboard), by key,
 * written through the SAME path as the app's settings page
 * (`setAppSecret`, `~/modules/apps/connections/app-secrets.ts`): the key must be
 * one of the connection's `appSecretFields` (and `appSecretConfigKeys`), the
 * value must have the declared shape. Any refusal is a usage error (exit 2),
 * raised before the first key is written.
 *
 * The connection: the entry's `connection.name` when it has one, else the app's
 * only connection that declares settable secrets (several: name it).
 *
 * An empty value (an unset `${VAR:-}`) means "not provided yet": skipped and
 * reported as pending, never stored and never clearing a stored one.
 *
 * Idempotent: the stored value is decrypted HERE, compared with the file's, and
 * an equal one is reported `unchanged` and not written, so a re-run does not
 * roll the secret (each roll displaces the previous value, which keeps
 * verifying only for a while). Neither value is ever logged or reported.
 */

import { ConfigError } from "~/cli/config/parse"
import type { PendingItem, ProvisionContext } from "~/cli/provisioners/types"
import { readAppConfig } from "~/modules/apps/app-config"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  AppSecretError,
  appSecretValueProblem,
  connectionDeclFor,
  setAppSecret,
  settableAppSecretFields,
  settableField,
} from "~/modules/apps/connections/app-secrets"
import { decryptConnectionConfigValue } from "~/modules/apps/connections/service"
import { ensureAppsForOrg } from "~/modules/apps/init"

type ConnectionDecl = ReturnType<typeof connectionDeclFor>

/** What one key would do: `set` (none stored), `roll` (another stored), `unchanged`, `skip` (empty). */
export type AppSecretAction = "set" | "roll" | "unchanged" | "skip"

/** The connections of a registered app whose declaration lets a person set secrets. */
function connectionsWithSettableSecrets(orgId: string, appName: string): string[] {
  const out: string[] = []
  for (const [raw, decl] of connectionConfigRegistry.snapshotUnder([orgId, appName])) {
    const conn = raw.split("\0").at(-1) ?? ""
    if (conn !== "" && settableAppSecretFields(decl).length > 0) out.push(conn)
  }
  return out.sort()
}

/**
 * The connection an app's secrets belong to, or null when the app's connections
 * are not registered for the org (yet). Throws a ConfigError when the app is
 * registered but no single connection takes them.
 */
export function resolveAppSecretsConnection(
  orgId: string,
  appName: string,
  explicit: string | undefined,
): { connectionName: string; decl: ConnectionDecl } | null {
  if (explicit) {
    const decl = connectionConfigRegistry.get([orgId, appName, explicit])
    return decl ? { connectionName: explicit, decl } : null
  }
  if (connectionConfigRegistry.snapshotUnder([orgId, appName]).size === 0) return null
  const candidates = connectionsWithSettableSecrets(orgId, appName)
  const [only] = candidates
  if (candidates.length === 1 && only) {
    return { connectionName: only, decl: connectionDeclFor(orgId, appName, only) }
  }
  throw new ConfigError(
    candidates.length === 0
      ? `apps.${appName}.appSecrets: app '${appName}' declares no secret a person sets`
      : `apps.${appName}.appSecrets: app '${appName}' has several connections taking secrets (${candidates.join(", ")}): name one with connection.name`,
  )
}

/** Throw a ConfigError for the first key or value the declaration refuses. Never quotes a value. */
export function assertAppSecretsAllowed(
  appName: string,
  decl: ConnectionDecl,
  secrets: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(secrets)) {
    const label = `apps.${appName}.appSecrets.${key}`
    let problem: string | null
    try {
      const field = settableField(decl, key)
      problem = value === "" ? null : appSecretValueProblem(field, value)
    } catch (err) {
      if (err instanceof AppSecretError) throw new ConfigError(`${label}: ${err.message}`)
      throw err
    }
    if (problem) throw new ConfigError(`${label}: ${problem}`)
  }
}

/** Per key: what writing the file's value would do against the stored config. */
async function secretActions(
  ctx: ProvisionContext,
  orgId: string,
  appName: string,
  connectionName: string,
  decl: ConnectionDecl,
  secrets: Record<string, string>,
): Promise<Array<[string, AppSecretAction]>> {
  // An org-filtered read; `sys` works before the org provisioner sets ctx.orgId (a plan).
  const stored = await ctx.sys("cli-app-secrets-read", (tx) => readAppConfig(tx, orgId, appName))
  return Object.entries(secrets).map(([key, value]): [string, AppSecretAction] => {
    if (value === "") return [key, "skip"]
    const raw = stored[key]
    if (typeof raw !== "string" || raw.length === 0) return [key, "set"]
    const current = decryptConnectionConfigValue(orgId, appName, key, raw, undefined, {
      [connectionName]: decl,
    })
    return [key, current === value.trim() ? "unchanged" : "roll"]
  })
}

function planLine(appName: string, key: string, action: AppSecretAction): string {
  switch (action) {
    case "set":
      return `set app '${appName}' secret '${key}'`
    case "roll":
      return `roll app '${appName}' secret '${key}' (the stored one keeps verifying for a while)`
    case "unchanged":
      return `app '${appName}' secret '${key}' unchanged`
    case "skip":
      return `app '${appName}' secret '${key}': not provided (empty), skipped`
  }
}

/**
 * Plan lines, never a value. Checked against the declaration and compared with
 * the stored value when the app's connections are registered for `orgId`; else
 * (an org or an app this run creates) one `set` line per key, checked in apply.
 * `changesOnly`: leave out the unchanged keys (the tool path counts changes).
 */
export async function planAppSecrets(
  ctx: ProvisionContext,
  orgId: string,
  appName: string,
  explicitConnection: string | undefined,
  secrets: Record<string, string>,
  opts: { changesOnly?: boolean } = {},
): Promise<string[]> {
  const resolved = orgId ? resolveAppSecretsConnection(orgId, appName, explicitConnection) : null
  if (!resolved) {
    return Object.entries(secrets).map(([key, value]) =>
      planLine(appName, key, value === "" ? "skip" : "set"),
    )
  }
  assertAppSecretsAllowed(appName, resolved.decl, secrets)
  const actions = await secretActions(
    ctx,
    orgId,
    appName,
    resolved.connectionName,
    resolved.decl,
    secrets,
  )
  return actions
    .filter(([, action]) => !(opts.changesOnly && action === "unchanged"))
    .map(([key, action]) => planLine(appName, key, action))
}

export interface AppSecretsApplyResult {
  changed: string[]
  unchanged: string[]
  pending: PendingItem[]
}

export async function applyAppSecrets(
  ctx: ProvisionContext,
  appName: string,
  explicitConnection: string | undefined,
  secrets: Record<string, string>,
): Promise<AppSecretsApplyResult> {
  await ensureAppsForOrg(ctx.orgId)
  const resolved = resolveAppSecretsConnection(ctx.orgId, appName, explicitConnection)
  if (!resolved) {
    throw new ConfigError(
      explicitConnection
        ? `apps.${appName}.appSecrets: connection '${explicitConnection}' is not declared by app '${appName}' (is the app installed?)`
        : `apps.${appName}.appSecrets: app '${appName}' is not installed or declares no connection`,
    )
  }
  const { connectionName, decl } = resolved
  assertAppSecretsAllowed(appName, decl, secrets)
  const actions = await secretActions(ctx, ctx.orgId, appName, connectionName, decl, secrets)
  const result: AppSecretsApplyResult = { changed: [], unchanged: [], pending: [] }
  for (const [key, action] of actions) {
    const label = `apps.${appName}.appSecrets.${key}`
    if (action === "skip") {
      ctx.log(`app '${appName}': secret '${key}' not provided (empty), skipped`)
      result.pending.push({
        kind: "credentials",
        app: appName,
        connection: connectionName,
        action: `give ${label} a value and re-run config apply, or set it on the app's settings page`,
        message: `Secret '${key}' of '${appName}/${connectionName}' was not provided (empty)`,
      })
      continue
    }
    if (action === "unchanged") {
      ctx.log(`app '${appName}': secret '${key}' already set`)
      result.unchanged.push(label)
      continue
    }
    try {
      const { rolled } = await setAppSecret({
        orgId: ctx.orgId,
        appName,
        connectionName,
        key,
        value: secrets[key],
      })
      ctx.log(`app '${appName}': secret '${key}' ${rolled ? "rolled" : "set"}`)
    } catch (err) {
      if (err instanceof AppSecretError) throw new ConfigError(`${label}: ${err.message}`)
      throw err
    }
    result.changed.push(label)
  }
  return result
}

/** Which of `keys` hold a value on the server (yes or no, never the value). */
export async function appSecretsSetOnServer(
  ctx: ProvisionContext,
  orgId: string,
  appName: string,
  keys: string[],
): Promise<Record<string, boolean>> {
  const stored = await ctx.sys("cli-app-secrets-status", (tx) => readAppConfig(tx, orgId, appName))
  return Object.fromEntries(
    keys.map((k) => [k, typeof stored[k] === "string" && (stored[k] as string).length > 0]),
  )
}
