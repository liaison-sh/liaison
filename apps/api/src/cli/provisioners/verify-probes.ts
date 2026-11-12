// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The connection health check of `liaison config verify` and of the check
 * `config apply` runs after it applied a connection.
 *
 * It is the app's own declarative `provisioning.verify` handler
 * (app-provisioning.ts): one cheap authenticated read through the app's
 * connection, run as an ordinary sandboxed run of the app, the credential
 * added host-side by `ctx.fetch` auth. The CLI never decrypts the stored
 * credential and holds no per-app probe code. An app that declares no
 * `verify` handler is reported SKIPPED, never a failure.
 */

/** Successful probe outcome: a non-secret identity string only. */
export interface VerifyProbeResult {
  identity: string
}

export interface VerifyProbeInput {
  orgId: string
  appName: string
  /** The app's `apps[].provision` block, when the config file has one. */
  provision?: Record<string, unknown>
}

/**
 * Check one app's connection. Null: the app declares no live check. Throws
 * (with a message safe to print, no secret) when the check fails.
 */
export type VerifyProbe = (input: VerifyProbeInput) => Promise<VerifyProbeResult | null>

/** The production probe: the app's `provisioning.verify` handler. */
export const appVerifyProbe: VerifyProbe = async ({ orgId, appName, provision }) => {
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  const { appSurfaceRegistry } = await import("~/modules/apps/app-surface")
  const { runAppProvisioningVerify } = await import("~/modules/apps/app-provisioning")
  await ensureAppsForOrg(orgId)
  if (!appSurfaceRegistry.get([orgId, appName])?.provisioning?.verify) return null
  const verified = await runAppProvisioningVerify({ orgId, appName, config: provision ?? {} })
  if (!verified) return null
  if (!verified.ok) {
    throw new Error(verified.problems.join("; ") || `${appName} verify failed`)
  }
  return { identity: verified.identity ?? "ok" }
}
