// SPDX-License-Identifier: FSL-1.1-ALv2
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Worker-local maintenance-flag fixture for Phase 14 E2E (A5, W5).
 *
 * Tests pass `MAINTENANCE_FLAG_PATH` + `MAINTENANCE_VERSION_PATH` to the API
 * worker via `serverEnv` so the production middleware reads worker-isolated
 * paths under ${TMPDIR}/liaison-test/${workerId}/.
 */

interface MaintenanceFlagPaths {
  flagPath: string
  versionPath: string
  dir: string
}

export function maintenanceFlagPaths(workerId: number | string): MaintenanceFlagPaths {
  const dir = path.join(os.tmpdir(), "liaison-test", String(workerId))
  return {
    dir,
    flagPath: path.join(dir, "maintenance"),
    versionPath: path.join(dir, "maintenance-version"),
  }
}

export function setMaintenanceFlag(
  workerId: number | string,
  targetVersion: string,
): MaintenanceFlagPaths {
  const paths = maintenanceFlagPaths(workerId)
  fs.mkdirSync(paths.dir, { recursive: true })
  // Write the version file *first* — the middleware reads flag presence as the
  // gate, so flag-after-version eliminates the race where the page reads an
  // empty version file.
  fs.writeFileSync(paths.versionPath, targetVersion)
  fs.writeFileSync(paths.flagPath, "")
  return paths
}

export function clearMaintenanceFlag(workerId: number | string): void {
  const paths = maintenanceFlagPaths(workerId)
  try {
    fs.rmSync(paths.flagPath, { force: true })
  } catch {
    /* noop */
  }
  try {
    fs.rmSync(paths.versionPath, { force: true })
  } catch {
    /* noop */
  }
}
