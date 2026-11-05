// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The app runtime's registries (`skillRegistry`, `toolRegistry`, the
 * `registeredApps` / `initializedOrgRuntimes` bookkeeping) are MODULE-LEVEL and
 * therefore shared by every test file in a `bun test` process. Any test that
 * drives a real agent turn calls `ensureAppsForOrg(orgId)` under the hood
 * (`agent-service.ts` `runAgentChat`), which registers every bundled app plus
 * its app-shipped SKILLS under that orgId — and those entries outlive the file.
 *
 * A later file asserting "this org has no apps and no skills" then reads
 * another file's registrations and fails in a multi-file run while passing
 * alone. Call this in the polluting file's `afterAll` (leave the process as you
 * found it) and in the asserting file's `beforeAll` (establish the
 * precondition rather than assume it).
 */
import {
  initializedOrgRuntimes,
  registeredApps,
  registeredAppVersions,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"

export function resetOrgRuntimeForTest(orgId: string): void {
  skillRegistry.deleteByPrefix([orgId])
  toolRegistry.deleteByPrefix([orgId])
  const prefix = `${orgId}:`
  for (const key of [...registeredApps]) {
    if (key.startsWith(prefix)) registeredApps.delete(key)
  }
  for (const key of [...registeredAppVersions.keys()]) {
    if (key.startsWith(prefix)) registeredAppVersions.delete(key)
  }
  initializedOrgRuntimes.delete(orgId)
}
