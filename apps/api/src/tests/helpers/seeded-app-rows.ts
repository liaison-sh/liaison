// SPDX-License-Identifier: FSL-1.1-ALv2
// Apps a test seeds straight into kernel.apps_installed + apps_active_version
// (no package, no install root) must not outlive the test file: the unit runner
// runs several files in one shard database, and an instance-wide reader of the
// active versions (the boot materialiser, `materialiseActiveVersions`) would
// find a version with no stored package and report it failed.
import { inArray } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion } from "~/db/schema/kernel"

export interface SeededApps {
  /** Remember an app name the test seeded; returns it. */
  track(name: string): string
  /** Deactivate every tracked app (its `apps_installed` rows may stay referenced). */
  cleanup(): Promise<void>
}

export function seededApps(): SeededApps {
  const names = new Set<string>()
  return {
    track(name) {
      names.add(name)
      return name
    },
    async cleanup() {
      if (names.size === 0) return
      const list = [...names]
      names.clear()
      await withSystemDb("test-seeded-apps-cleanup", (db) =>
        db.delete(appsActiveVersion).where(inArray(appsActiveVersion.name, list)),
      )
    },
  }
}
