// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DECLARATIVE PROVISIONING: an app's org-level setup as data.
//
// An app declares `provisioning` in its manifest: a JSON Schema for its setup
// block, the handler that applies it, and optionally a handler that checks it
// live. `liaison config apply` validates the config file's `apps[].provision`
// block against the schema and runs the handler; `config apply --dry-run` and
// `config verify` run it with `dryRun: true` (what would change = drift), and
// `config verify` runs the `verify` handler when declared (a live check, e.g.
// one authenticated call through the app's connection).
//
// The handlers run as an ordinary sandboxed run of the app (a sandboxed app never
// runs in-process), as the app itself under its own scopes, one short
// transaction per bridge call: the same rules as its jobs. There is no host code
// per app: what the app sets up lives in its own data (store, schema, config).
//
//   handler({ config, dryRun }) -> { changed: string[] }
//   verify({ config })          -> { ok: boolean, problems?: string[], identity?: string }

import { createRlsSession } from "~/db/rls"
import { appBridgeManifest } from "~/modules/apps/app-registries"
import { type AppSurface, appSurfaceRegistry } from "~/modules/apps/app-surface"
import { createParamValidatorCache } from "~/modules/apps/param-validator"
import { runLimits } from "~/modules/apps/run-limits"

const compiled = createParamValidatorCache({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
})

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvisioningError"
  }
}

export interface ProvisionOutcome {
  changed: string[]
}

export interface ProvisionVerifyOutcome {
  ok: boolean
  problems: string[]
  identity?: string
}

function surfaceWithProvisioning(
  orgId: string,
  appName: string,
): AppSurface & {
  provisioning: NonNullable<AppSurface["provisioning"]>
} {
  const surface = appSurfaceRegistry.get([orgId, appName])
  if (!surface?.provisioning) {
    throw new ProvisioningError(`app '${appName}' declares no provisioning in its manifest`)
  }
  return surface as AppSurface & { provisioning: NonNullable<AppSurface["provisioning"]> }
}

/** Whether the registered app declares provisioning. */
export function appHasProvisioning(orgId: string, appName: string): boolean {
  return Boolean(appSurfaceRegistry.get([orgId, appName])?.provisioning)
}

/** Problems of a provision block against the app's schema; empty when it is valid. */
export function provisionConfigErrors(orgId: string, appName: string, config: unknown): string[] {
  const { provisioning } = surfaceWithProvisioning(orgId, appName)
  const validate = compiled(provisioning.schema)
  if (validate(config)) return []
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
}

/** Test seam: replaces the sandbox run. */
export type ProvisionExecutor = (args: {
  surface: AppSurface
  orgId: string
  exportName: string
  params: unknown
  /** A dry run or a verify: the bridge refuses every write. */
  readOnly: boolean
}) => Promise<unknown>

/**
 * The bridge a provisioning handler runs on: the app itself, under its own
 * scopes, one short transaction per call. `readOnly` (a dry run, `config
 * verify`) marks it a read-only run, so the bridge refuses every write: "writes
 * nothing" is enforced, not a promise of the handler.
 */
export async function provisionBridge(
  appName: string,
  orgId: string,
  readOnly: boolean,
): Promise<Record<string, unknown>> {
  const { createSessionRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
  const manifest = appBridgeManifest(orgId, appName) ?? { name: appName }
  const session = createRlsSession(
    { actorType: "system", orgId, purpose: "job", scopes: [`${appName}:*`] },
    { pool: "jobs" },
  )
  return createSessionRpcBridge(
    appName,
    `system:${appName}`,
    orgId,
    session,
    manifest as Parameters<typeof createSessionRpcBridge>[4],
    undefined,
    "system",
    undefined,
    readOnly ? { readOnlyRunOverride: true } : undefined,
  )
}

const defaultProvisionExecutor: ProvisionExecutor = async ({
  surface,
  orgId,
  exportName,
  params,
  readOnly,
}) => {
  const { runApp } = await import("~/modules/apps/sandbox/run-app")
  const appName = surface.appName
  const bridge = await provisionBridge(appName, orgId, readOnly)
  return runApp({
    trusted: surface.trusted,
    appName,
    orgId,
    bundlePath: surface.bundlePath,
    exportName,
    entry: `provision:${exportName}`,
    params,
    bridge,
    timeoutMs: runLimits("provision").wallMs,
    priority: "background",
    appId: appName,
    holdsTx: false,
  })
}

let provisionExecutor: ProvisionExecutor = defaultProvisionExecutor

export const AppProvisioningTestAccess = {
  setExecutor(fn: ProvisionExecutor | null): void {
    provisionExecutor = fn ?? defaultProvisionExecutor
  },
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

/**
 * Validate `config` and run the app's provisioning handler. `dryRun`: the handler
 * reports what it would change and writes nothing.
 */
export async function runAppProvisioning(input: {
  orgId: string
  appName: string
  config: Record<string, unknown>
  dryRun: boolean
}): Promise<ProvisionOutcome> {
  const surface = surfaceWithProvisioning(input.orgId, input.appName)
  const errors = provisionConfigErrors(input.orgId, input.appName, input.config)
  if (errors.length > 0) {
    throw new ProvisioningError(`apps.${input.appName}.provision: ${errors.join("; ")}`)
  }
  const result = await provisionExecutor({
    surface,
    exportName: surface.provisioning.handler,
    orgId: input.orgId,
    params: { config: input.config, dryRun: input.dryRun },
    readOnly: input.dryRun,
  })
  const changed = stringList((result as { changed?: unknown } | null)?.changed)
  return { changed }
}

/** Run the app's `verify` handler; null when the app declares none. */
export async function runAppProvisioningVerify(input: {
  orgId: string
  appName: string
  config: Record<string, unknown>
}): Promise<ProvisionVerifyOutcome | null> {
  const surface = surfaceWithProvisioning(input.orgId, input.appName)
  if (!surface.provisioning.verify) return null
  const result = (await provisionExecutor({
    surface,
    exportName: surface.provisioning.verify,
    orgId: input.orgId,
    params: { config: input.config },
    readOnly: true,
  })) as { ok?: unknown; problems?: unknown; identity?: unknown } | null
  return {
    ok: result?.ok === true,
    problems: stringList(result?.problems),
    ...(typeof result?.identity === "string" ? { identity: result.identity } : {}),
  }
}
