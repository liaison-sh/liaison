// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boot-time reconciliation of the search index (drift.ts): it must never block
// boot, never throw into it, never restructure the live index in place, and
// never make search unavailable while a rebuild runs.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"

const ARGS = { registeredReadScopes: ["kernel:threads:read"], dimensionFields: ["team"] }

let liveSettings: Record<string, unknown> = {}
let metaShape: string | null = null
let metaVersions: string | undefined
let numberOfDocuments = 42
let indexExists = true
let getIndexError: Error | null = null
let getSettingsCalls = 0

const updateSettingsMock = mock<(settings: unknown) => Promise<{ taskUid: number }>>(async () => ({
  taskUid: 1,
}))
const createIndexMock = mock<(name: string) => Promise<{ taskUid: number }>>(async () => {
  indexExists = true
  return { taskUid: 2 }
})
const waitForTaskMock = mock(async () => ({ status: "succeeded" }))

function indexHandle() {
  return {
    getSettings: async () => {
      getSettingsCalls++
      return liveSettings
    },
    getStats: async () => ({ numberOfDocuments }),
    getDocument: async () => {
      if (metaShape === null) throw new Error("document_not_found")
      return { shape: metaShape, catalog_versions: metaVersions }
    },
    updateSettings: updateSettingsMock,
  }
}

const enqueued: Array<{ jobName: string; jobId?: string }> = []
const spies: Array<{ mockRestore: () => void }> = []

async function loadDrift() {
  return await import("./drift")
}

beforeEach(async () => {
  enqueued.length = 0
  // Reset, not clear: a test's pending mockImplementationOnce must not leak.
  updateSettingsMock.mockReset()
  updateSettingsMock.mockImplementation(async () => ({ taskUid: 1 }))
  createIndexMock.mockClear()
  indexExists = true
  getIndexError = null
  numberOfDocuments = 42
  metaShape = null
  metaVersions = undefined
  getSettingsCalls = 0
  const { expectedSettings } = await loadDrift()
  liveSettings = expectedSettings(ARGS)

  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue("test_drift_idx"))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue({
      getIndex: async () => {
        if (getIndexError) throw getIndexError
        if (!indexExists) {
          const err = new Error("index_not_found") as Error & { code?: string }
          err.code = "index_not_found"
          throw err
        }
        return indexHandle()
      },
      index: () => indexHandle(),
      createIndex: createIndexMock,
      tasks: { waitForTask: waitForTaskMock },
    } as never),
  )
  spies.push(
    spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
      _app: string,
      jobName: string,
      _payload: unknown,
      opts?: { jobId?: string },
    ) => {
      enqueued.push({ jobName, jobId: opts?.jobId })
      return "job"
    }) as never),
  )
  spies.push(spyOn(jobsModule, "registerJobWorker").mockImplementation((() => {}) as never))
  ;(await loadDrift()).SearchDriftTestAccess.resetSearchReady()
})

afterEach(() => {
  for (const s of spies) s.mockRestore()
  spies.length = 0
})

describe("detectDrift", () => {
  it("creates a missing index, schedules a rebuild, and is not ready until one lands", async () => {
    indexExists = false
    const drift = await loadDrift()
    await drift.detectDrift(ARGS)
    expect(createIndexMock).toHaveBeenCalledTimes(1)
    expect(updateSettingsMock).toHaveBeenCalledTimes(1)
    expect(enqueued.map((j) => j.jobName)).toEqual(["search-reindex-full"])
    expect(drift.isSearchReady()).toBe(false)
  })

  it("settings drift schedules a rebuild and NEVER restructures the live index in place", async () => {
    liveSettings = { ...liveSettings, filterableAttributes: ["org_id"] }
    const drift = await loadDrift()
    await drift.detectDrift(ARGS)
    // The old pass called updateSettings on the live index and waited for it
    // (minutes on 764k documents), then held search unavailable for the
    // reindex. Now the live index serves as it is while the shadow is built.
    expect(updateSettingsMock).not.toHaveBeenCalled()
    expect(enqueued.map((j) => j.jobName)).toEqual(["search-reindex-full"])
    expect(drift.isSearchReady()).toBe(true)
  })

  it("never waits for a settings task at boot, however long Meili would take", async () => {
    liveSettings = { ...liveSettings, filterableAttributes: ["org_id"] }
    // A settings task that never finishes: boot must not be waiting on it.
    updateSettingsMock.mockImplementationOnce(() => new Promise(() => {}))
    const drift = await loadDrift()
    const done = await Promise.race([
      drift.detectDrift(ARGS).then(() => "returned"),
      new Promise((r) => setTimeout(() => r("blocked"), 2_000)),
    ])
    expect(done).toBe("returned")
  })

  it("a Meili failure at boot is logged, never thrown into the boot sequence", async () => {
    getIndexError = new Error("connect ECONNREFUSED")
    const drift = await loadDrift()
    // The old pass rethrew, and the boot's catch called process.exit(1).
    await expect(drift.detectDrift(ARGS)).resolves.toBeUndefined()
    expect(enqueued).toEqual([])
  })

  it("is ready and schedules nothing when settings and shape both match", async () => {
    const drift = await loadDrift()
    metaShape = "the-catalog-shape"
    await drift.detectDrift({ ...ARGS, fingerprint: "the-catalog-shape" })
    expect(enqueued).toEqual([])
    expect(updateSettingsMock).not.toHaveBeenCalled()
    expect(drift.isSearchReady()).toBe(true)
  })

  it("a document shape the builders no longer produce schedules a rebuild while serving", async () => {
    metaShape = "an-older-shape"
    const drift = await loadDrift()
    await drift.detectDrift({ ...ARGS, fingerprint: "the-catalog-shape" })
    expect(enqueued.map((j) => j.jobName)).toEqual(["search-reindex-full"])
    expect(drift.isSearchReady()).toBe(true)
  })

  it("an index built from a newer catalog is left alone by an older release's check", async () => {
    metaShape = "the-newer-shape"
    metaVersions = JSON.stringify({ mail: "2.0.0" })
    const drift = await loadDrift()
    await drift.detectDrift({
      ...ARGS,
      fingerprint: "the-older-shape",
      catalogVersions: { mail: "1.9.0" },
    })
    expect(enqueued).toEqual([])
    // The same catalog version (another change) still rebuilds.
    await drift.detectDrift({
      ...ARGS,
      fingerprint: "the-older-shape",
      catalogVersions: { mail: "2.0.0" },
    })
    expect(enqueued.map((j) => j.jobName)).toEqual(["search-reindex-full"])
  })

  it("a process that did not run the rebuild sees it land without a restart", async () => {
    indexExists = false
    const drift = await loadDrift()
    await drift.detectDrift(ARGS)
    expect(drift.isSearchReady()).toBe(false)
    // The rebuild ran elsewhere and swapped a populated index in.
    numberOfDocuments = 10
    drift.SearchDriftTestAccess.expireReadyProbe()
    drift.isSearchReady()
    await new Promise((r) => setTimeout(r, 20))
    expect(drift.isSearchReady()).toBe(true)
  })
})

describe("expectedSettings: the per-write cost", () => {
  it("filters only on what some query filters on", async () => {
    const { expectedSettings } = await loadDrift()
    const s = expectedSettings({ ...ARGS, aclFieldNames: ["org_wide", "acl_user_ids"] })
    // Unique per document or never filtered on: each was a facet database
    // Meili updated on every write (entity_id and the self-valued dedupe_key
    // had one value per document).
    for (const gone of ["entity_id", "author_agent_id", "participant_agent_ids"]) {
      expect(s.filterableAttributes).not.toContain(gone)
    }
    for (const kept of [
      "org_id",
      "read_scope",
      "participant_ids",
      "dedupe_key",
      "parent_type",
      "required_scopes",
      "thread_id",
      "created_at",
      "has_vector",
      "team",
      "org_wide",
      "acl_user_ids",
    ]) {
      expect(s.filterableAttributes).toContain(kept)
    }
    expect(s.sortableAttributes).toEqual(["created_at"])
    expect(s.pagination).toEqual({ maxTotalHits: 10_000 })
  })
})

describe("the catalog drift check (setup step and leader)", () => {
  // A catalog with one searchable entity beyond the kernel's.
  const catalog = [
    {
      name: "fxdrift",
      version: "1.0.0",
      entities: {
        note: {
          labelField: "title",
          handlePrefix: "n",
          searchable: true,
          tableName: "notes",
          readScope: "fxdrift:notes:read",
          permissionFields: { readScope: "fxdrift:notes:read", dimensionFields: ["team"] },
        },
      },
    },
  ]

  it("compares the stored fingerprint before any settings call, and enqueues nothing when it matches", async () => {
    const { catalogSearchInputs } = await import("~/modules/apps/catalog-derivations")
    const drift = await loadDrift()
    metaShape = catalogSearchInputs(catalog).fingerprint
    await drift.checkCatalogSearchDrift(catalog)
    expect(getSettingsCalls).toBe(0)
    expect(updateSettingsMock).not.toHaveBeenCalled()
    expect(enqueued).toEqual([])
  })

  it("with no stored fingerprint yet, matching settings are not rewritten", async () => {
    const { catalogSearchInputs } = await import("~/modules/apps/catalog-derivations")
    const drift = await loadDrift()
    liveSettings = drift.expectedSettings(catalogSearchInputs(catalog).settings)
    await drift.checkCatalogSearchDrift(catalog)
    expect(getSettingsCalls).toBe(1)
    expect(updateSettingsMock).not.toHaveBeenCalled()
    // The index lacks its build (no meta document): one deduplicated rebuild.
    expect(enqueued.map((j) => j.jobName)).toEqual(["search-reindex-full"])
  })
})
