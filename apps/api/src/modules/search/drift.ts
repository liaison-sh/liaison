// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boot-time reconciliation of the unified search index, and search readiness.
//
// NEVER BLOCKS, NEVER TAKES SEARCH DOWN
// -------------------------------------
// This used to apply a settings change to the LIVE index at boot and wait for
// it (up to 10 minutes on 764k documents), let a timeout escape into the boot
// `process.exit(1)`, and hold every search surface "unavailable" until a full
// reindex finished hours later. Now:
//
//   - the only thing boot waits for is a few small reads (and, for an index
//     that does not exist at all, its creation);
//   - a live index that exists SERVES, whatever its settings or shape: a
//     difference schedules a rebuild into a shadow index that is swapped in
//     atomically when complete (reindex.ts), so search never goes away and the
//     live index is never restructured in place;
//   - every failure is logged and swallowed. A Meili that is down at boot
//     costs search until it is back, never the process.
//
// Readiness (`isSearchReady`) is "the live index exists and holds a built
// index", re-checked lazily when false, so a process that did not run the
// rebuild still sees it land.

import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { registerSingleton } from "~/infra/leadership"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { JobRetryLaterError } from "~/lib/failure-severity"
import { searchLogger as log } from "~/lib/logger"
import type { AppDescriptor } from "~/modules/apps/runtime"
import {
  expectedSettings,
  INDEX_META_DOC_ID,
  type SettingsInputs,
  settingsMatch,
} from "~/modules/search/index-shape"
import { waitForMeiliTask } from "~/modules/search/meili-task"
import { REBUILD_JOB, REBUILD_JOB_OPTIONS, runReindex } from "~/modules/search/reindex"

export { expectedSettings } from "~/modules/search/index-shape"

let _ready = false
let readyCheckedAt = 0
let readyCheck: Promise<void> | null = null
const READY_RECHECK_MS = 5_000

/**
 * What the index settings were last computed from in this process: the
 * catalog's inputs at boot (`primeSearchSettings`) or at a drift check, widened
 * by every catalog change here. Null until boot has run (tests, CLIs), in which
 * case a catalog change writes nothing: the setup step applies the settings.
 */
let _applied: { scopes: Set<string>; dims: Set<string>; acl: Set<string> } | null = null
let _coverQueue: Promise<unknown> = Promise.resolve()

function recordApplied(args: SettingsInputs): void {
  _applied = {
    scopes: new Set(args.registeredReadScopes),
    dims: new Set(args.dimensionFields),
    acl: new Set(args.aclFieldNames ?? []),
  }
}

/**
 * True when the live index can answer. When false, a background probe (at
 * most every few seconds) looks again, so a rebuild finished by another
 * process, or a Meili that came back, turns search on without a restart.
 */
export function isSearchReady(): boolean {
  if (!_ready && !readyCheck && Date.now() - readyCheckedAt > READY_RECHECK_MS) {
    readyCheckedAt = Date.now()
    readyCheck = probeReady()
      .catch(() => undefined)
      .finally(() => {
        readyCheck = null
      })
  }
  return _ready
}

/** A live index that holds a built index (a meta document, or any document). */
async function probeReady(): Promise<void> {
  const index = getMeili().index(effectiveIndexName())
  const stats = (await index.getStats()) as { numberOfDocuments?: number }
  if ((stats.numberOfDocuments ?? 0) > 0) _ready = true
}

async function readMeta(
  index: ReturnType<ReturnType<typeof getMeili>["index"]>,
): Promise<{ shape: string | null; versions?: Record<string, string> }> {
  try {
    const meta = (await index.getDocument(INDEX_META_DOC_ID)) as {
      shape?: unknown
      catalog_versions?: unknown
    }
    const { parseCatalogVersions } = await import("~/modules/apps/catalog-derivations")
    return {
      shape: typeof meta?.shape === "string" ? meta.shape : null,
      versions: parseCatalogVersions(meta?.catalog_versions),
    }
  } catch {
    return { shape: null }
  }
}

function isIndexNotFound(err: unknown): boolean {
  const direct = (err as { code?: string }).code
  const fromCause = (err as { cause?: { code?: string } }).cause?.code
  if (direct === "index_not_found" || fromCause === "index_not_found") return true
  return /index_not_found|not found/i.test(String((err as Error)?.message ?? ""))
}

async function enqueueRebuild(reason: string): Promise<void> {
  try {
    await enqueueAppJob("kernel", REBUILD_JOB, { reason }, REBUILD_JOB_OPTIONS)
    log.info({ reason }, "Search index rebuild scheduled")
  } catch (err) {
    log.warn({ err, reason }, "Could not schedule the search index rebuild; the next boot will")
  }
}

/**
 * The boot pass. Returns quickly and never throws (see the header).
 * `fingerprint` is the shape the catalog calls for (`catalogSearchInputs`);
 * without it only settings are compared.
 */
export async function detectDrift(
  args: SettingsInputs & { fingerprint?: string; catalogVersions?: Record<string, string> },
): Promise<void> {
  recordApplied(args)
  try {
    const meili = getMeili()
    const indexName = effectiveIndexName()
    const expected = expectedSettings(args)
    let index: ReturnType<typeof meili.index>
    try {
      await meili.getIndex(indexName)
      index = meili.index(indexName)
    } catch (err) {
      if (!isIndexNotFound(err)) throw err
      // Nothing to serve yet: create an EMPTY index with the settings (instant
      // on an empty index), and build the real one in the background.
      log.info({ indexName }, "Search index missing: creating it and scheduling a rebuild")
      const created = await meili.createIndex(indexName, { primaryKey: "id" })
      await waitForMeiliTask(meili, (created as { taskUid?: number }).taskUid, {
        timeoutMs: 60_000,
      })
      const applied = await meili.index(indexName).updateSettings(expected)
      await waitForMeiliTask(meili, (applied as { taskUid?: number }).taskUid, {
        timeoutMs: 60_000,
      })
      await enqueueRebuild("index_missing")
      return
    }

    // The index exists: it serves from here on, whatever follows.
    const [stats, meta] = await Promise.all([
      index.getStats() as Promise<{ numberOfDocuments?: number }>,
      readMeta(index),
    ])
    const fingerprint = meta.shape
    if ((stats.numberOfDocuments ?? 0) > 0 || fingerprint) _ready = true

    const wanted = args.fingerprint ?? null
    // The stored derivation first: the meta document's fingerprint hashes the
    // settings and every registration's shape, so a match means the index was
    // built for exactly these inputs, and no settings call is needed.
    if (wanted !== null && fingerprint === wanted) return
    // Built from a newer catalog: this process is an older release still
    // running during a rolling deploy. Its rebuild would undo the new fields.
    if (args.catalogVersions && meta.versions) {
      const { supersedingApp } = await import("~/modules/apps/catalog-derivations")
      const newer = await supersedingApp(meta.versions, args.catalogVersions)
      if (newer) {
        log.info(
          {
            indexName,
            app: newer,
            stored: meta.versions[newer],
            ours: args.catalogVersions[newer],
          },
          "Search index was built from a newer catalog than this process's: left as is",
        )
        return
      }
    }
    const settings = await index.getSettings()
    const settingsDrift = !settingsMatch(settings, expected)
    const shapeDrift = wanted !== null && fingerprint !== wanted
    if (settingsDrift || shapeDrift) {
      log.info(
        { indexName, settingsDrift, shapeDrift, have: fingerprint, want: wanted },
        "Search index differs from the expected shape: rebuilding in the background",
      )
      await enqueueRebuild(settingsDrift ? "settings_drift" : "shape_drift")
    }
  } catch (err) {
    log.error({ err }, "Search index check failed at boot; search serves whatever index exists")
  }
}

/**
 * Widen the live index settings to cover `args` (an org's registrations, read
 * after its apps registered at runtime: a seed creating an org, a catalog
 * install, an app enabled). Without this an app registered later never got its
 * dimension and ACL fields made filterable, and every search filtering on them
 * failed "not filterable" until a restart (TIC-04).
 *
 * Idempotent and additive: only the union with what is already applied is
 * written, nothing when it adds no field, and never before boot has applied
 * the settings. Returns whether it wrote settings. Never throws: a failure is
 * logged and retried by the next registration.
 */
export function ensureSearchSettingsCover(args: SettingsInputs): Promise<boolean> {
  const run = _coverQueue.then(async () => {
    const applied = _applied
    if (!applied) return false
    const scopes = new Set([...applied.scopes, ...args.registeredReadScopes])
    const dims = new Set([...applied.dims, ...args.dimensionFields])
    const acl = new Set([...applied.acl, ...(args.aclFieldNames ?? [])])
    if (
      scopes.size === applied.scopes.size &&
      dims.size === applied.dims.size &&
      acl.size === applied.acl.size
    ) {
      return false
    }
    const union = {
      registeredReadScopes: [...scopes],
      dimensionFields: [...dims],
      aclFieldNames: [...acl],
    }
    const expected = expectedSettings(union)
    try {
      const meili = getMeili()
      const index = await meili.getIndex(effectiveIndexName())
      const current = await index.getSettings()
      if (!settingsMatch(current, expected)) {
        const task = await index.updateSettings(expected)
        await waitForMeiliTask(meili, (task as { taskUid?: number }).taskUid)
        log.info(
          { dimensionFields: union.dimensionFields, aclFieldNames: union.aclFieldNames },
          "Search index settings extended for apps registered at runtime",
        )
      }
      recordApplied(union)
      return true
    } catch (err) {
      log.warn({ err }, "Search index settings update after app registration failed")
      return false
    }
  })
  _coverQueue = run.catch(() => undefined)
  return run
}

/**
 * `ensureSearchSettingsCover` for the installed catalog: after a catalog change
 * in this process (an install, an upgrade, a version switch). Settings follow
 * the catalog, never one org's registrations.
 */
export async function ensureSearchSettingsCoverCatalog(): Promise<boolean> {
  const { catalogSearchInputs, currentCatalog } = await import("~/modules/apps/catalog-derivations")
  return ensureSearchSettingsCover(catalogSearchInputs(await currentCatalog()).settings)
}

/**
 * The drift check on the catalog's inputs (settings and shape fingerprint):
 * what the setup step runs once per catalog, and the leader again on each
 * lease acquire (the fallback when the setup step could not reach Meili).
 * Never throws; a rebuild it schedules is deduplicated (`REBUILD_JOB_OPTIONS`).
 */
export async function checkCatalogSearchDrift(apps?: readonly AppDescriptor[]): Promise<void> {
  try {
    const { catalogSearchInputs, currentCatalog } = await import(
      "~/modules/apps/catalog-derivations"
    )
    const catalog = catalogSearchInputs(apps ?? (await currentCatalog()))
    await detectDrift({
      ...catalog.settings,
      fingerprint: catalog.fingerprint,
      catalogVersions: catalog.versions,
    })
  } catch (err) {
    log.error({ err }, "Search drift check on the catalog failed")
  }
}

/**
 * Every process at boot: take the catalog's settings inputs as what the index
 * already covers (the setup step applied them), so a later catalog change in
 * this process widens only what is new, and probe whether a built index is
 * there to serve. Reads only; never throws.
 */
export async function primeSearchSettings(): Promise<void> {
  try {
    const { catalogSearchInputs, currentCatalog } = await import(
      "~/modules/apps/catalog-derivations"
    )
    recordApplied(catalogSearchInputs(await currentCatalog()).settings)
  } catch (err) {
    log.warn({ err }, "Reading the catalog's search inputs at boot failed")
  }
  await probeReady().catch((err) =>
    log.warn({ err }, "Search index readiness probe at boot failed; it retries lazily"),
  )
}

/** The leader runs the catalog drift check once per lease acquire. */
export function registerSearchDriftCheck(): void {
  registerSingleton({
    name: "search-drift-check",
    onAcquired: () => {
      void checkCatalogSearchDrift()
    },
    onLost: () => {},
  })
}

let reindexRegistered = false

export function registerReindexWorker(): void {
  if (reindexRegistered) return
  reindexRegistered = true
  registerJobWorker("kernel", REBUILD_JOB, async () => {
    const result = await runReindex()
    // Held by another rebuild, or by a crashed one whose lock has not expired
    // yet: fail, so the queue retries later (REBUILD_JOB_OPTIONS), instead of
    // completing as if the index had been rebuilt. An expected wait, logged at
    // warn by the job worker; exhausting the retries still logs at error.
    if (!result.swapped) {
      throw new JobRetryLaterError("search rebuild lock is held; retrying later", "lock_held")
    }
    _ready = true
  })
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const SearchDriftTestAccess = {
  resetSearchReady(): void {
    _ready = false
    readyCheckedAt = Date.now()
  },
  /** Let the next `isSearchReady` probe Meili now. */
  expireReadyProbe(): void {
    readyCheckedAt = 0
  },
  setSearchReady(ready: boolean): void {
    _ready = ready
  },
  resetReindexRegistration(): void {
    reindexRegistered = false
  },
  resetAppliedSettings(): void {
    _applied = null
  },
}
