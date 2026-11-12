// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App installs are instance-wide rows (apps_installed, apps_active_version,
// app_activation_events), so one test file's install used to change what the
// next file saw: a seeded social install granted its own outbound domains to
// every later social test, and a reset that emptied apps_installed (through its
// foreign key to the organizations) left the active version behind with no
// install record, which the sandbox reads as "nothing granted" and refuses
// every host. Two guards keep test files apart:
//   - the route-test reset empties all three tables, and
//   - a file that installs restores a snapshot of them when it ends.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import {
  appActivationEvents,
  appsActiveVersion,
  appsInstalled,
} from "~/db/schema/kernel/apps-installed"
import { getInstallTrust, resetInstallTrustCache } from "~/modules/apps/install-trust"
import { snapshotAppInstalls } from "~/tests/helpers/app-install-state"
import { acquireTestLock, releaseTestLock, truncateOrgTables } from "~/tests/route-test-setup"

const suffix = randomUUID().slice(0, 8)
const KEPT = `iso-kept-${suffix}`
const ADDED = `iso-added-${suffix}`
const RESET = `iso-reset-${suffix}`
const SHA = "a".repeat(64)

async function install(name: string, version: string): Promise<void> {
  await withSystemDb("test-app-install-isolation", async (db) => {
    await db.insert(appsInstalled).values({
      name,
      version,
      sourceUrl: `test://${name}-${version}`,
      sha256: SHA,
      installedBy: randomUUID(),
      grantedDomains: ["api.example.com"],
    })
    await db
      .insert(appsActiveVersion)
      .values({ name, version })
      .onConflictDoUpdate({
        target: appsActiveVersion.name,
        set: { previousVersion: drizzleSql`${appsActiveVersion.version}`, version },
      })
    await db.insert(appActivationEvents).values({
      app: name,
      fromVersion: null,
      toVersion: version,
      outcome: "activated",
      actorKind: "system",
    })
  })
}

async function counts(name: string) {
  const [row] = await sql<{ installed: number; active: number; events: number }[]>`
    SELECT
      (SELECT count(*)::int FROM kernel.apps_installed WHERE name = ${name}) AS installed,
      (SELECT count(*)::int FROM kernel.apps_active_version WHERE name = ${name}) AS active,
      (SELECT count(*)::int FROM kernel.app_activation_events WHERE app = ${name}) AS events`
  return row
}

describe("app installs do not outlive the test file that made them", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })

  afterAll(async () => {
    for (const name of [KEPT, ADDED, RESET]) {
      await sql`DELETE FROM kernel.app_activation_events WHERE app = ${name}`
      await sql`DELETE FROM kernel.apps_active_version WHERE name = ${name}`
      await sql`DELETE FROM kernel.apps_installed WHERE name = ${name}`
    }
    resetInstallTrustCache()
    await releaseTestLock()
  })

  it("a test reset empties the active version and its events along with the install record", async () => {
    await install(RESET, "1.0.0")
    expect((await getInstallTrust(RESET)).grantedDomains).toEqual(["api.example.com"])

    await truncateOrgTables()

    expect(await counts(RESET)).toEqual({ installed: 0, active: 0, events: 0 })
    // Nothing left that reads as an install with no grant.
    const trust = await getInstallTrust(RESET)
    expect(trust.installed).toBe(false)
    expect(trust.grantedDomains).toBeNull()
  })

  it("restoring a snapshot removes what was installed after it and keeps what was there before", async () => {
    await install(KEPT, "1.0.0")
    const snapshot = await snapshotAppInstalls()

    await install(ADDED, "1.0.0")
    await install(KEPT, "2.0.0")
    expect(await counts(KEPT)).toEqual({ installed: 2, active: 1, events: 2 })

    await snapshot.restore()

    expect(await counts(ADDED)).toEqual({ installed: 0, active: 0, events: 0 })
    expect(await counts(KEPT)).toEqual({ installed: 1, active: 1, events: 1 })
    const [active] = await sql<{ version: string; previous_version: string | null }[]>`
      SELECT version, previous_version FROM kernel.apps_active_version WHERE name = ${KEPT}`
    expect(active).toEqual({ version: "1.0.0", previous_version: null })
    expect((await getInstallTrust(ADDED)).installed).toBe(false)
    expect((await getInstallTrust(KEPT)).version).toBe("1.0.0")
  })
})
