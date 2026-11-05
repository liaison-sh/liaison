// SPDX-License-Identifier: FSL-1.1-ALv2
// D13 (TIC-04 stack defect): the search index settings (filterable fields) were
// applied once, at API boot, from the apps registered THEN. An org whose apps
// register later (the QA seed installed tickets 22 s after boot) never got the
// tickets dimension and ACL fields made filterable, so every free-text ticket
// search failed "Attribute `sensitivity` is not filterable" (503
// SEARCH_UNAVAILABLE) until a restart. Registering apps at runtime now extends
// the index settings, idempotently.
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { enableApp } from "~/modules/apps/enabled-apps"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  detectDrift,
  ensureSearchSettingsCover,
  ensureSearchSettingsCoverCatalog,
  expectedSettings,
  primeSearchSettings,
  SearchDriftTestAccess,
} from "~/modules/search/drift"

// The live index: what the last settings update wrote.
let live: ReturnType<typeof expectedSettings> = expectedSettings({
  registeredReadScopes: ["kernel:threads:read"],
  dimensionFields: [],
  aclFieldNames: [],
})
const updateSettingsMock = mock(async (settings: ReturnType<typeof expectedSettings>) => {
  live = settings
  return { taskUid: 1 }
})
const index = {
  uid: "test_runtime_install_idx",
  getSettings: async () => live,
  updateSettings: updateSettingsMock,
}
const spies: Array<{ mockRestore: () => void }> = []
const orgIds: string[] = []

async function newOrg(): Promise<string> {
  const slug = `drift-rt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const id = await withSystemDb(
    "drift-runtime-install",
    async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'DriftRt', ${slug}) RETURNING id
      `),
      )[0]!.id,
  )
  orgIds.push(id)
  return id
}

beforeAll(() => {
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(index.uid))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue({
      getIndex: async () => index,
      createIndex: async () => ({ taskUid: 2 }),
      waitForTask: async () => ({ status: "succeeded" }),
      // biome-ignore lint/suspicious/noExplicitAny: test double
    } as any),
  )
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job"))
})

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  // Module state another file in the same process must not inherit.
  SearchDriftTestAccess.resetAppliedSettings()
  SearchDriftTestAccess.resetSearchReady()
  await withSystemDb("drift-runtime-install-cleanup", async (tx) => {
    for (const id of orgIds) {
      await tx.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${id}`)
    }
  })
})

describe("search index settings follow apps registered after boot", () => {
  it("does nothing before boot has applied the settings (boot's drift pass covers it)", async () => {
    SearchDriftTestAccess.resetAppliedSettings()
    updateSettingsMock.mockClear()
    const changed = await ensureSearchSettingsCover({
      registeredReadScopes: ["tickets:tickets:read"],
      dimensionFields: ["sensitivity"],
      aclFieldNames: [],
    })
    expect(changed).toBe(false)
    expect(updateSettingsMock).not.toHaveBeenCalled()
  })

  it("settings follow the catalog: an org registering or enabling apps writes nothing", async () => {
    // The setup step applied the catalog's settings; a booting process takes
    // them as covered, with no org registered (S23).
    const { catalogSearchInputs, currentCatalog } = await import(
      "~/modules/apps/catalog-derivations"
    )
    live = expectedSettings(catalogSearchInputs(await currentCatalog()).settings)
    await primeSearchSettings()
    updateSettingsMock.mockClear()
    // The tickets fields are there before any org registered tickets (TIC-04).
    expect(live.filterableAttributes).toEqual(
      expect.arrayContaining(["sensitivity", "team", "org_wide", "acl_user_ids"]),
    )

    // The seed creates orgs and registers their apps, and enables one: no write.
    await ensureAppsForOrg(await newOrg(), {})
    const second = await newOrg()
    await ensureAppsForOrg(second, {})
    await enableApp(second, "tickets")
    expect(updateSettingsMock).not.toHaveBeenCalled()
  }, 60_000)

  it("a catalog change in this process widens the settings once", async () => {
    // A process whose settings were computed from a narrower catalog.
    await detectDrift({
      registeredReadScopes: ["kernel:threads:read"],
      dimensionFields: [],
      aclFieldNames: [],
    })
    live = expectedSettings({
      registeredReadScopes: ["kernel:threads:read"],
      dimensionFields: [],
      aclFieldNames: [],
    })
    updateSettingsMock.mockClear()
    expect(await ensureSearchSettingsCoverCatalog()).toBe(true)
    expect(updateSettingsMock).toHaveBeenCalledTimes(1)
    expect(live.filterableAttributes).toEqual(
      expect.arrayContaining(["sensitivity", "team", "org_id", "required_scopes"]),
    )
    expect(await ensureSearchSettingsCoverCatalog()).toBe(false)
    expect(updateSettingsMock).toHaveBeenCalledTimes(1)
  }, 60_000)
})
