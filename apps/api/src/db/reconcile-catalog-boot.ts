// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Boot-time first-party catalog reconcile.
 *
 * Why this exists: `apps_installed` / `apps_active_version` are DB rows —
 * durable across a container rebuild — while the unpacked `.liaisonapp`
 * bundle under the install root (`/var/lib/liaison/apps/<name>/<version>/`)
 * lives on the CONTAINER FILESYSTEM. A fresh image rebuild (or a
 * non-persisted install-root volume) starts with an EMPTY install root even
 * though the DB still believes every previously-enabled catalog app
 * (boxtal/invoicing/ads/pennylane/shopify/social/...) is installed. The
 * runtime then silently fails to load those apps — they vanish from the Apps
 * UI until an operator manually reinstalls them.
 *
 * `reconcileCatalogApps` (modules/apps/catalog.ts) repairs both the on-disk
 * bundle and the DB row for every catalog app enabled by at least one org, by
 * re-running the same idempotent `installCatalogApp` install path the Apps UI
 * uses. This script is the boot CMD wiring for it: run once, right after
 * migrations apply and before the server starts accepting traffic.
 *
 * FAIL-SOFT ON SERVER START: a reconcile error is logged loudly (stderr + a fatal
 * log line) but must NEVER block server startup — losing a bundled app's
 * on-disk bundle is recoverable (reinstall from Apps UI), while refusing to
 * boot the whole API because of it is not an acceptable trade. This mirrors
 * the existing best-effort boot steps in index.ts (e.g. Google login
 * provider reconcile, MCP-client boot). The deploy's `migrate` one-shot is
 * the exception: it runs with `--strict` (reconcileExitCode below).
 *
 * `installedBy` attribution: reconcileCatalogApps prefers the previously
 * installed app's own `installedBy` when a stale row exists (the common
 * case). NIL_UUID is only the fallback for an enabled-but-never-installed
 * app with no prior row to inherit from — same sentinel already used for
 * "no real human actor" attribution elsewhere (cli/tickets/import.ts,
 * db/rls.ts, db/privileged.ts).
 */

// This one-shot script is not a job host (infra/jobs/jobs.ts,
// hostJobWorkers): app registration records handlers but creates no BullMQ
// worker, so it never consumes the server's queue jobs.
import { withMigrationLease } from "~/db/migrate"
import {
  type FilesSelectPolicyRebuildOptions,
  rebuildFilesSelectPolicy,
} from "~/infra/boot-phase10"
import { appsLogger as log } from "~/lib/logger"
import { runAgentBaseCeilingReconcile } from "~/modules/agent/directory/reconcile-base-ceilings"
import { reconcileCatalogApps } from "~/modules/apps/catalog"
import {
  catalogFileParents,
  catalogVersions,
  currentCatalog,
} from "~/modules/apps/catalog-derivations"
import { materialiseActiveVersions } from "~/modules/apps/package-store"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { backfillWorkerModules } from "~/modules/apps/workers/worker-module-backfill"
import { checkCatalogSearchDrift, registerReindexWorker } from "~/modules/search/drift"

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/**
 * The reconcile writes instance-wide rows (`apps_installed`,
 * `apps_active_version`) and unpacks into the install root every replica
 * shares, so replicas that start together take turns: it runs under the
 * migration lease when the privileged URL is in the environment (the image
 * entrypoint passes it to this step only). Without it, or when the lease
 * cannot be set up, the reconcile runs unserialised, as before, and says so.
 */
async function underMigrationLease<T>(fn: () => Promise<T>): Promise<T> {
  const url = process.env.MIGRATION_DATABASE_URL
  if (!url) {
    log.warn(
      "Boot catalog reconcile: MIGRATION_DATABASE_URL unset, running without the migration lease",
    )
    return fn()
  }
  let started = false
  try {
    return await withMigrationLease(
      url,
      () => {
        started = true
        return fn()
      },
      {
        log: (line) => log.info(line),
        onLost: (reason) =>
          log.error(
            { reason },
            "Boot catalog reconcile: lost the migration lease; another replica may reconcile too",
          ),
      },
    )
  } catch (err) {
    if (started) throw err
    log.warn(
      { err },
      "Boot catalog reconcile: could not take the migration lease, running without it",
    )
    return fn()
  }
}

/**
 * Run the reconcile and say whether every catalog app ended on this image's
 * version (or was left alone because a newer release moved it ahead). False when
 * an app failed or the reconcile itself threw; both are logged here.
 */
export async function runReconcileCatalogBoot(): Promise<boolean> {
  try {
    const { result, derivationsOk } = await underMigrationLease(async () => {
      // A fresh container's install root is empty: every active version this
      // release runs comes back from the package store first (package-store.ts),
      // uploaded apps and versions ahead of this image's catalog included.
      const stored = await materialiseActiveVersions()
      if (stored.materialised.length > 0) {
        log.info(
          { materialised: stored.materialised },
          "Boot: app versions fetched from the package store",
        )
      }
      if (stored.failed.length > 0) {
        log.error({ failed: stored.failed }, "Boot: app versions missing from the package store")
      }
      const result = await reconcileCatalogApps({ fallbackInstalledBy: NIL_UUID })
      // Every enabled version with no Worker module gets its own package's
      // worker.js when it has one; the rest are listed (their runs are refused
      // on Workers and the sandbox service until reinstalled).
      const modules = await backfillWorkerModules().catch((err) => {
        log.error({ err }, "Boot: the Worker module back-fill failed")
        return null
      })
      if (modules) {
        log.info(
          { backfilled: modules.backfilled.length, withoutWorkerModule: modules.missing.length },
          "Boot: app versions and their Worker modules",
        )
      }
      return { result, derivationsOk: await applyCatalogDerivations() }
    })
    if (!derivationsOk) return false
    if (result.failed.length > 0) {
      log.error(
        { failed: result.failed, repaired: result.repaired, ok: result.ok },
        "Boot catalog reconcile: some app install(s) failed and stay on their previous version",
      )
      return false
    }
    if (result.repaired.length > 0) {
      log.warn(
        { repaired: result.repaired, ok: result.ok },
        "Boot catalog reconcile: repaired drifted/missing app install(s)",
      )
    } else {
      log.info({ ok: result.ok }, "Boot catalog reconcile: all enabled catalog apps consistent")
    }
    return true
  } catch (err) {
    log.error({ err }, "Boot catalog reconcile failed — continuing startup without it")
    return false
  }
}

/**
 * The instance-wide derivations of the installed catalog (A4), applied once per
 * catalog by this locked setup step, never by a server process from the orgs it
 * registered (catalog-derivations.ts):
 *
 * - the `kernel.files` SELECT policy from the catalog's file parents. Its stamp
 *   makes a run with the same catalog issue no DDL (boot-phase10.ts);
 * - the search index check on the catalog's settings and shape fingerprint. The
 *   stored fingerprint is compared before any settings call, so a run with the
 *   same catalog writes nothing; a difference schedules a background rebuild.
 *   Meilisearch unreachable is logged, and the leader repeats the check.
 *
 * Both derivations record the catalog's app versions. A process whose catalog
 * holds an app at an OLDER version than the recorded one (an old release
 * restarting during a rolling deploy) leaves them as they are ("superseded"),
 * so it cannot revert the new release's parents and search fields. Left open:
 * a search rebuild job the new leader scheduled may still run on an old
 * worker; the new leader's next check schedules it again.
 *
 * Returns false when the policy could not be applied ("skipped": the
 * `kernel.files` lock never granted, or a throw; logged). The leader re-checks
 * the policy on each lease acquire, so a server start does not wait for the
 * next deploy. `apps` defaults to the catalog on disk.
 */
export async function applyCatalogDerivations(
  apps?: readonly AppDescriptor[],
  policyLockOpts: Pick<
    FilesSelectPolicyRebuildOptions,
    "lockTimeoutMs" | "maxAttempts" | "backoffMs"
  > = {},
): Promise<boolean> {
  let catalog: readonly AppDescriptor[]
  try {
    catalog = apps ?? (await currentCatalog())
  } catch (err) {
    log.error({ err }, "Setup step: reading the installed catalog failed")
    return false
  }
  let ok = true
  try {
    const outcome = await rebuildFilesSelectPolicy({
      ...policyLockOpts,
      parents: catalogFileParents(catalog),
      catalogVersions: catalogVersions(catalog),
    })
    if (outcome === "skipped") {
      // Not applied: the policy stays as it was, so a new app's files stay
      // unreadable until it is. Fail the step (a `--strict` deploy stops here);
      // a server start goes on, and its leader retries on lease acquire.
      log.error(
        { outcome, alert: "files_select_policy_not_applied" },
        "Setup step: the files SELECT policy could not be applied",
      )
      ok = false
    } else {
      log.info({ outcome }, "Setup step: files SELECT policy from the catalog")
    }
  } catch (err) {
    log.error({ err }, "Setup step: applying the files SELECT policy from the catalog failed")
    ok = false
  }
  // The check may schedule the rebuild job: its handler must be known here
  // (this process hosts no worker; the server's worker runs it).
  registerReindexWorker()
  await checkCatalogSearchDrift(catalog)
  return ok
}

/**
 * The exit code of this step. A server start (`serve`) is fail-soft: it exits 0
 * whatever happened, so one broken app never keeps the API down. The `migrate`
 * one-shot of a deploy passes `--strict` and exits 1 when an app failed: the
 * deploy stops there, before any new process starts, instead of rolling out an
 * image whose apps stay on files the new kernel may refuse. The usual cause is a
 * bundled app rebuilt with other files under a version already installed; a
 * version directory is never rewritten, so the fix is to raise the app's version.
 */
export function reconcileExitCode(ok: boolean, strict: boolean): number {
  return ok || !strict ? 0 : 1
}

// Guard the executable body so importing this module for unit tests does not
// run the reconcile. Mirrors db/migrate.ts's import.meta.main pattern.
if (import.meta.main) {
  const strict = process.argv.includes("--strict")
  const ok = await runReconcileCatalogBoot()
  // Stored copies of the common agent base catch up with the constant on every
  // start (reconcile-base-ceilings.ts). Fail-soft in both modes: a stale
  // ceiling narrows an agent, it breaks nothing, so it never stops a deploy.
  await runAgentBaseCeilingReconcile()
  if (!ok && strict) {
    console.error(
      "[reconcile-catalog-boot] a catalog app did not install (log above). If it says a version directory already holds different files, the image carries a changed app under a version already installed: raise that app's version and rebuild the image.",
    )
  }
  process.exit(reconcileExitCode(ok, strict))
}
