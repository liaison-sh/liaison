// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S4: registering an org whose setup stamp matches (same build, same app
// versions, no app in error, every app row current) writes nothing to the
// org's persistent rows: `kernel.apps`, roles, grants, users, the
// organizations row. A mismatch writes once, runs the org setup hooks, and
// stamps the org only when every app registered. The Google login provider is
// reconciled on every first touch, whatever the stamp. Real database, real
// registration of the default catalog.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import { initializedOrgRuntimes, manifestRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg, getDefaultApps, orgSetupHookSeam, setUpOrg } from "~/modules/apps/init"
import { type AppDescriptor, appRegistrationStats, registerApps } from "~/modules/apps/runtime"
import { computeSetupStamp, setupBuildId } from "~/modules/apps/setup-stamp"
import { GOOGLE_ISSUER } from "~/modules/auth/google-login-provider"
import * as minimal from "~/seed/tiers/minimal"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let defaultApps: AppDescriptor[]

/** Every persistent row a registration may write for the org, keyed, with its xmin. */
async function orgRowVersions(): Promise<Map<string, string>> {
  const rows = await sql<{ k: string; x: string }[]>`
    SELECT 'apps:' || name AS k, xmin::text AS x FROM kernel.apps WHERE org_id = ${orgId}
    UNION ALL
    SELECT 'role:' || name, xmin::text FROM kernel.roles WHERE org_id = ${orgId}
    UNION ALL
    SELECT 'grant:' || r.name || ':' || g.scope, g.xmin::text
      FROM kernel.role_scope_grants g JOIN kernel.roles r ON r.id = g.role_id
      WHERE r.org_id = ${orgId}
    UNION ALL
    SELECT 'user:' || id::text, xmin::text FROM kernel.users WHERE org_id = ${orgId}
    UNION ALL
    SELECT 'org', xmin::text FROM kernel.organizations WHERE id = ${orgId}`
  return new Map(rows.map((r) => [r.k, r.x]))
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()])
  return [...keys].filter((k) => before.get(k) !== after.get(k)).sort()
}

async function storedStamp(): Promise<string | null> {
  const [row] = await sql<{ stamp: string | null }[]>`
    SELECT app_setup_stamp AS stamp FROM kernel.organizations WHERE id = ${orgId}`
  return row?.stamp ?? null
}

function expectedStamp(apps: ReadonlyArray<AppDescriptor>): string {
  return computeSetupStamp({
    buildId: setupBuildId(),
    apps: apps.map((a) => ({ name: a.name, version: String(a.version) })),
  })
}

/** The org's first-party Google login provider client secret, decrypted; null without a row. */
async function googleSecret(): Promise<string | null> {
  const [row] = await sql<{ secret: string }[]>`
    SELECT client_secret_encrypted AS secret FROM kernel.oauth_providers
    WHERE org_id = ${orgId} AND issuer_url = ${GOOGLE_ISSUER}`
  if (!row) return null
  return decryptSecret(row.secret, encryptionKey, CryptoContext.oauthProviderClientSecret)
}

/** The org as a fresh process sees it: in the database, absent from the registries. */
function forgetOrg(): void {
  resetOrgRuntimeForTest(orgId)
  manifestRegistry.deleteByPrefix([orgId])
}

/** Count the org setup hook runs while `fn` runs. */
async function countHookRuns(fn: () => Promise<unknown>): Promise<number> {
  const original = orgSetupHookSeam.runSetupHooks
  let runs = 0
  orgSetupHookSeam.runSetupHooks = async (id: string) => {
    if (id === orgId) runs++
    await original(id)
  }
  try {
    await fn()
  } finally {
    orgSetupHookSeam.runSetupHooks = original
  }
  return runs
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await minimal.secondOrg()).orgId
  defaultApps = await getDefaultApps()
})

afterAll(async () => {
  // Leave the org registered at the default catalog.
  forgetOrg()
  await ensureAppsForOrg(orgId)
  await releaseTestLock()
})

describe("org setup stamp (S4)", () => {
  it("the first registration stamps the org once every app registered", async () => {
    expect(initializedOrgRuntimes.has(orgId)).toBe(true)
    expect(await storedStamp()).toBe(expectedStamp(defaultApps))
  })

  it("S4: a matching stamp writes nothing", async () => {
    const before = await orgRowVersions()
    const writesBefore = appRegistrationStats.orgRowWrites
    forgetOrg()
    const hookRuns = await countHookRuns(() => ensureAppsForOrg(orgId))
    expect(initializedOrgRuntimes.has(orgId)).toBe(true)
    expect(manifestRegistry.get([orgId, defaultApps[0]?.name ?? ""])).toBeDefined()
    expect(changedKeys(before, await orgRowVersions())).toEqual([])
    expect(appRegistrationStats.orgRowWrites - writesBefore).toBe(0)
    // The org setup hooks run on a mismatch only.
    expect(hookRuns).toBe(0)
  })

  it("S4: one app version change re-runs the writes once", async () => {
    const [first, ...rest] = defaultApps
    if (!first) throw new Error("no default app")
    const bumped: AppDescriptor[] = [{ ...first, version: `${first.version}-stamp` }, ...rest]

    const before = await orgRowVersions()
    const writesBefore = appRegistrationStats.orgRowWrites
    forgetOrg()
    const hookRuns = await countHookRuns(() => setUpOrg(orgId, { apps: bumped }))
    const afterBump = await orgRowVersions()
    expect(changedKeys(before, afterBump)).toContain(`apps:${first.name}`)
    expect(appRegistrationStats.orgRowWrites - writesBefore).toBeGreaterThan(0)
    expect(hookRuns).toBe(1)
    expect(await storedStamp()).toBe(expectedStamp(bumped))

    // The next registration at the same versions changes nothing.
    const writesAgain = appRegistrationStats.orgRowWrites
    forgetOrg()
    const hookRunsAgain = await countHookRuns(() => setUpOrg(orgId, { apps: bumped }))
    expect(changedKeys(afterBump, await orgRowVersions())).toEqual([])
    expect(appRegistrationStats.orgRowWrites - writesAgain).toBe(0)
    expect(hookRunsAgain).toBe(0)

    // Back to the default catalog: a mismatch again, written once.
    forgetOrg()
    await ensureAppsForOrg(orgId)
    expect(await storedStamp()).toBe(expectedStamp(defaultApps))
  })

  it("a stale stamp over current app schemas writes beside the lane; only a schema change waits in it", async () => {
    let laneRuns = 0
    const lane = <T>(task: () => Promise<T>): Promise<T> => {
      laneRuns++
      return task()
    }

    // Stale stamp, every app schema current: the org's rows are written, the
    // org is stamped, and nothing enters the lane.
    await sql`UPDATE kernel.organizations SET app_setup_stamp = NULL WHERE id = ${orgId}`
    const writesBefore = appRegistrationStats.orgRowWrites
    const ddlBefore = appRegistrationStats.ddlTransactions
    forgetOrg()
    await setUpOrg(orgId, {}, lane)
    expect(initializedOrgRuntimes.has(orgId)).toBe(true)
    expect(appRegistrationStats.orgRowWrites - writesBefore).toBe(defaultApps.length)
    expect(appRegistrationStats.ddlTransactions - ddlBefore).toBe(0)
    expect(laneRuns).toBe(0)
    expect(await storedStamp()).toBe(expectedStamp(defaultApps))

    // One app's version changes its schema stamp: that app's registration, and
    // only it, runs in the lane.
    const [first, ...rest] = defaultApps
    if (!first) throw new Error("no default app")
    const bumped: AppDescriptor[] = [{ ...first, version: `${first.version}-lane` }, ...rest]
    forgetOrg()
    await setUpOrg(orgId, { apps: bumped }, lane)
    expect(laneRuns).toBe(1)
    expect(await storedStamp()).toBe(expectedStamp(bumped))

    // Back to the default catalog.
    forgetOrg()
    await ensureAppsForOrg(orgId)
    expect(await storedStamp()).toBe(expectedStamp(defaultApps))
  })

  it("the Google login provider is reconciled on every first touch, whatever the stamp", async () => {
    const saved = { id: env.GOOGLE_OAUTH_CLIENT_ID, secret: env.GOOGLE_OAUTH_CLIENT_SECRET }
    env.GOOGLE_OAUTH_CLIENT_ID = "stamp-test.apps.googleusercontent.com"
    env.GOOGLE_OAUTH_CLIENT_SECRET = "stamp-test-secret-1"
    try {
      forgetOrg()
      await ensureAppsForOrg(orgId)
      expect(await googleSecret()).toBe("stamp-test-secret-1")
      const stamp = await storedStamp()

      // A secret rotation with the stamp still matching reaches the stored provider.
      env.GOOGLE_OAUTH_CLIENT_SECRET = "stamp-test-secret-2"
      forgetOrg()
      const hookRuns = await countHookRuns(() => ensureAppsForOrg(orgId))
      expect(hookRuns).toBe(0)
      expect(await storedStamp()).toBe(stamp)
      expect(await googleSecret()).toBe("stamp-test-secret-2")

      // A provider row an admin deleted is restored at the next first touch.
      await sql`DELETE FROM kernel.oauth_providers
                WHERE org_id = ${orgId} AND issuer_url = ${GOOGLE_ISSUER}`
      forgetOrg()
      await ensureAppsForOrg(orgId)
      expect(await googleSecret()).toBe("stamp-test-secret-2")
    } finally {
      env.GOOGLE_OAUTH_CLIENT_ID = saved.id
      env.GOOGLE_OAUTH_CLIENT_SECRET = saved.secret
      await sql`DELETE FROM kernel.oauth_providers
                WHERE org_id = ${orgId} AND issuer_url = ${GOOGLE_ISSUER}`
    }
  })

  it("an errored app keeps today's recovery", async () => {
    const [first] = defaultApps
    if (!first) throw new Error("no default app")
    await sql`UPDATE kernel.apps SET status = 'error', problem_code = 'registration_failed'
              WHERE org_id = ${orgId} AND name = ${first.name}`
    const writesBefore = appRegistrationStats.orgRowWrites
    forgetOrg()
    await ensureAppsForOrg(orgId)
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.apps WHERE org_id = ${orgId} AND name = ${first.name}`
    expect(row?.status).toBe("active")
    expect(appRegistrationStats.orgRowWrites - writesBefore).toBeGreaterThan(0)
    expect(await storedStamp()).toBe(expectedStamp(defaultApps))
  })

  it("an app that fails to register leaves the stamp unwritten", async () => {
    const invalid: AppDescriptor = {
      _format: "manifest",
      name: "stamp-test-invalid",
      version: "1.0.0",
      notAManifestField: true,
    }
    await sql`UPDATE kernel.organizations SET app_setup_stamp = NULL WHERE id = ${orgId}`
    forgetOrg()
    const result = await setUpOrg(orgId, { extraApps: [invalid] })
    expect(result.failedApps).toContain("stamp-test-invalid")
    expect(await storedStamp()).toBeNull()
    await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId} AND name = 'stamp-test-invalid'`
  })

  it("failedApps names invalid and dependency-rejected apps", async () => {
    const [first] = defaultApps
    if (!first) throw new Error("no default app")
    const invalid: AppDescriptor = {
      _format: "manifest",
      name: "stamp-test-invalid",
      version: "1.0.0",
      notAManifestField: true,
    }
    const orphan: AppDescriptor = {
      ...first,
      dependencies: { required: ["stamp-test-missing-dependency"] },
    }
    const { failedApps } = await registerApps([invalid, orphan], orgId)
    expect([...failedApps].sort()).toEqual([first.name, "stamp-test-invalid"].sort())
    await sql`DELETE FROM kernel.apps WHERE org_id = ${orgId} AND name = 'stamp-test-invalid'`
  })
})
