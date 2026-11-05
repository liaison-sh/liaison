// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The runtime safety net behind first-touch org setup (H3). Boot registers no
 * org, so every entry point awaits `awaitOrgApps(orgId)` before it reads the
 * org's registries. A path that forgot would read nothing and act as if the org
 * had no apps. This guard catches it on the miss: when an org-scoped registry
 * lookup (tools, entities, webhook handlers, file parents) finds nothing for an
 * org this process has not registered and is not registering:
 *
 * - outside production it throws `OrgNotSetUpError` naming the org, so the gap
 *   fails the test or dev run that hits it;
 * - in production it logs `org_registry_read_before_setup` with the stack,
 *   counts it for `/diag`, and starts the org's setup, so the next read finds
 *   the registries filled.
 *
 * Only a hit-less lookup checks: tests fill registries without registering the
 * org, and a hit cannot happen for an unregistered org outside tests. Installed
 * by the server once its boot is done (index.ts); unit tests and CLI processes
 * run without it.
 */
import { appsLogger as log } from "~/lib/logger"
import { UUID_RE } from "~/lib/uuid"
import {
  initializedOrgRuntimes,
  orgRuntimeInitPromises,
  orgsKnownMissing,
  orgsRegistering,
} from "~/modules/apps/app-registries"
import { setOrgRegistryMissHook } from "~/modules/apps/registries"

export class OrgNotSetUpError extends Error {
  readonly code = "org_not_set_up"
  constructor(readonly orgId: string) {
    super(
      `org ${orgId}: an org-scoped registry was read before the org was set up in this process (await awaitOrgApps first)`,
    )
    this.name = "OrgNotSetUpError"
  }
}

const stats = { readsBeforeSetup: 0 }

/** For `/diag`: registry reads that reached an org before its setup. */
export function orgRegistryGuardStats(): { readsBeforeSetup: number } {
  return { ...stats }
}

/**
 * Set up, being set up, or known not to exist (a deleted org: `awaitOrgApps`
 * found no row, so a miss is the right answer for a cleanup job or a late
 * delivery, not a missing ensure).
 */
function isSetUpOrSettingUp(orgId: string): boolean {
  return (
    initializedOrgRuntimes.has(orgId) ||
    orgRuntimeInitPromises.has(orgId) ||
    orgsRegistering.has(orgId) ||
    orgsKnownMissing.has(orgId)
  )
}

export function onOrgRegistryMiss(
  orgId: string,
  mode: "throw" | "heal" = process.env.NODE_ENV === "production" ? "heal" : "throw",
): void {
  if (!UUID_RE.test(orgId) || isSetUpOrSettingUp(orgId)) return
  stats.readsBeforeSetup++
  if (mode === "throw") throw new OrgNotSetUpError(orgId)
  log.error(
    { orgId, stack: new Error("registry read before setup").stack },
    "org_registry_read_before_setup",
  )
  void import("~/modules/apps/init")
    .then(({ awaitOrgApps }) => awaitOrgApps(orgId))
    .catch((err: unknown) => log.error({ err, orgId }, "Org setup after a registry miss failed"))
}

/** Arm the guard (the server, once booted). */
export function installOrgRegistryGuard(): void {
  setOrgRegistryMissHook((orgId) => onOrgRegistryMiss(orgId))
}

/** Test seam. */
export const OrgRegistryGuardTestAccess = {
  uninstall(): void {
    setOrgRegistryMissHook(undefined)
  },
  resetStats(): void {
    stats.readsBeforeSetup = 0
  },
}
