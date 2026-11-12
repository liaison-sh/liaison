// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The instance's app install state, put back the way a test file found it.
//
// An install (a catalog app, a seeded world's apps, an uploaded package) writes
// three instance-wide tables: `apps_installed` (the package and its grants),
// `apps_active_version` (which version runs) and `app_activation_events`. None of
// them is per org, so an install outlives the test that made it and changes what
// every later test in the same database sees: the app's outbound domains become
// whatever that install granted, and a later reset that empties `apps_installed`
// (it cascades from the organizations) leaves an active version with no install
// record, which the sandbox treats as "nothing granted" and refuses every host.
//
// A file that installs apps takes a snapshot before its first install and
// restores it in `afterAll`:
//
//   const installs = await snapshotAppInstalls()
//   ...
//   afterAll(() => installs.restore())
//
// `restore` removes the rows the file added and puts back the active versions it
// changed. Rows that were there before stay untouched.
import { sql as drizzleSql, inArray, notInArray } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import {
  appActivationEvents,
  appsActiveVersion,
  appsInstalled,
} from "~/db/schema/kernel/apps-installed"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"

type ActiveRow = typeof appsActiveVersion.$inferSelect

export interface AppInstallSnapshot {
  /** Remove what was installed since the snapshot and put back the active versions. */
  restore(): Promise<void>
}

function installKey(name: string, version: string): string {
  return `${name}@${version}`
}

export async function snapshotAppInstalls(): Promise<AppInstallSnapshot> {
  const before = await withSystemDb("test-app-install-snapshot", async (db) => ({
    active: await db.select().from(appsActiveVersion),
    installed: await db
      .select({ name: appsInstalled.name, version: appsInstalled.version })
      .from(appsInstalled),
    events: await db.select({ id: appActivationEvents.id }).from(appActivationEvents),
  }))
  const installedKeys = new Set(before.installed.map((r) => installKey(r.name, r.version)))
  const eventIds = before.events.map((r) => r.id)
  const activeByName = new Map<string, ActiveRow>(before.active.map((r) => [r.name, r]))

  return {
    async restore() {
      await withSystemDb("test-app-install-restore", async (db) => {
        // Activation events the file added.
        if (eventIds.length === 0) await db.delete(appActivationEvents)
        else
          await db.delete(appActivationEvents).where(notInArray(appActivationEvents.id, eventIds))

        // Install records the file added.
        const now = await db
          .select({ name: appsInstalled.name, version: appsInstalled.version })
          .from(appsInstalled)
        for (const row of now) {
          if (installedKeys.has(installKey(row.name, row.version))) continue
          await db
            .delete(appsInstalled)
            .where(
              drizzleSql`${appsInstalled.name} = ${row.name} AND ${appsInstalled.version} = ${row.version}`,
            )
        }

        // Active versions: drop the ones the file added, put back the ones it moved.
        const activeNow = await db.select().from(appsActiveVersion)
        const added = activeNow.filter((r) => !activeByName.has(r.name)).map((r) => r.name)
        if (added.length > 0) {
          await db.delete(appsActiveVersion).where(inArray(appsActiveVersion.name, added))
        }
        for (const row of before.active) {
          const current = activeNow.find((r) => r.name === row.name)
          if (
            current &&
            current.version === row.version &&
            current.previousVersion === row.previousVersion &&
            current.orgId === row.orgId
          ) {
            continue
          }
          await db
            .insert(appsActiveVersion)
            .values(row)
            .onConflictDoUpdate({
              target: appsActiveVersion.name,
              set: {
                version: row.version,
                previousVersion: row.previousVersion,
                orgId: row.orgId,
                updatedAt: row.updatedAt,
              },
            })
        }
      })
      resetInstallTrustCache()
    },
  }
}
