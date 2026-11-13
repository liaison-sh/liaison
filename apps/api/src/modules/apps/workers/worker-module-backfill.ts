// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installed app versions with no Worker module (`apps_installed.worker_sha256`
// NULL). A remote executor (the Workers loader, the self-hosted sandbox
// service) runs an installed version only as the Worker module its package
// carried (run-app.ts `resolveWorkersTarget`); a version recorded without one
// is refused there (`AppWorkerModuleMissingError`, worker-module-missing.ts), never run on QuickJS behind
// the operator's back.
//
//   backfillWorkerModules   every enabled version without a module gets the
//                           worker.js of its own package: the stored package
//                           (package-store.ts), else this image's baked catalog
//                           tarball, either one only when its sha256 is the
//                           row's. Nothing is built: a package that carried no
//                           worker.js (built before Worker modules were
//                           packaged) stays without, and is listed. Run at boot
//                           (reconcile-catalog-boot.ts) and by every upkeep.
//   countInstallsWithoutWorkerModule  the active versions still without one
//                           (/healthz `appsWithoutWorkerModule`).
//
// Core apps are server code (modules/apps/core) and never need one.

import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import { and, eq, isNull, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { appsLogger as log } from "~/lib/logger"
import { CORE_APP_NAMES } from "~/modules/apps/core/registry"

export interface WorkerModuleBackfill {
  /** `<name>@<version>` given the worker.js of its own package. */
  backfilled: string[]
  /** `<name>@<version>` whose package has none (or could not be read). */
  missing: Array<{ app: string; reason: string }>
}

/** Enabled installed versions with no module, core apps aside. */
async function rowsWithoutModule(): Promise<
  Array<{ name: string; version: string; sha256: string }>
> {
  const rows = await withSystemDb("worker-module-backfill:rows", (db) =>
    db
      .select({
        name: appsInstalled.name,
        version: appsInstalled.version,
        sha256: appsInstalled.sha256,
      })
      .from(appsInstalled)
      .where(and(isNull(appsInstalled.workerSha256), isNull(appsInstalled.disabledAt))),
  )
  return rows.filter((r) => !CORE_APP_NAMES.has(r.name))
}

export async function backfillWorkerModules(): Promise<WorkerModuleBackfill> {
  const backfilled: string[] = []
  const missing: WorkerModuleBackfill["missing"] = []
  for (const row of await rowsWithoutModule()) {
    const app = `${row.name}@${row.version}`
    try {
      const { readInstalledPackage } = await import("~/modules/apps/package-store")
      const { packageWorkerModule } = await import("~/modules/apps/install-service")
      const pkg = await readInstalledPackage(row.name, row.version, row.sha256)
      if (!pkg) {
        missing.push({ app, reason: "no stored package of this version" })
        continue
      }
      let module: { workerSha256: string | null; workerModule: Uint8Array | null }
      try {
        module = packageWorkerModule(pkg.stagingDir, undefined)
      } finally {
        rmSync(pkg.stagingDir, { recursive: true, force: true })
      }
      if (!module.workerSha256 || !module.workerModule) {
        missing.push({ app, reason: "its package carries no worker.js" })
        continue
      }
      const sha = createHash("sha256").update(module.workerModule).digest("hex")
      await withSystemDb("worker-module-backfill:record", (db) =>
        db
          .update(appsInstalled)
          .set({ workerSha256: sha, workerModule: module.workerModule })
          .where(
            and(
              eq(appsInstalled.name, row.name),
              eq(appsInstalled.version, row.version),
              eq(appsInstalled.sha256, row.sha256),
              isNull(appsInstalled.workerSha256),
            ),
          ),
      )
      backfilled.push(app)
    } catch (err) {
      missing.push({ app, reason: (err as Error).message })
    }
  }
  if (backfilled.length > 0) {
    log.info({ backfilled }, "App versions given the Worker module of their own package")
  }
  if (missing.length > 0) {
    log.error(
      { missing, count: missing.length },
      "App versions without a Worker module: on Workers or the sandbox service their runs are refused (app_worker_module_missing) until they are reinstalled from a package built by this release",
    )
  }
  return { backfilled, missing }
}

/** Active app versions (not core, not disabled) with no Worker module. */
export async function countInstallsWithoutWorkerModule(): Promise<number> {
  const [row] = await withSystemDb("worker-module-backfill:count", (db) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(appsActiveVersion)
      .innerJoin(
        appsInstalled,
        and(
          eq(appsInstalled.name, appsActiveVersion.name),
          eq(appsInstalled.version, appsActiveVersion.version),
        ),
      )
      .where(
        and(
          isNull(appsInstalled.workerSha256),
          isNull(appsInstalled.disabledAt),
          sql`${appsInstalled.name} NOT IN (${sql.join(
            [...CORE_APP_NAMES].map((n) => sql`${n}`),
            sql`, `,
          )})`,
        ),
      ),
  )
  return row?.n ?? 0
}
