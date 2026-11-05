// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The setup step applies the catalog's instance-wide derivations (A4): the
// kernel.files SELECT policy and the search index check. It runs before every
// server start, so a second run with the same catalog must write nothing: no
// policy DDL, no Meilisearch settings write (M4). And a rebuild requested with
// no org registered (an activation in a fresh process) builds every catalog
// parent, not a kernel-only policy (S23).
import { afterAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { applyCatalogDerivations } from "~/db/reconcile-catalog-boot"
import { filesSelectPolicyRebuildStats, rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { catalogFileParents, currentCatalog } from "~/modules/apps/catalog-derivations"
import type { AppDescriptor } from "~/modules/apps/runtime"

const FIXTURE_APP = "fxcatalogbump"

/** A catalog bump: an app whose entity's files hang off a real table. */
const bumpedApp: AppDescriptor = {
  name: FIXTURE_APP,
  version: "1.0.0",
  _format: "manifest",
  entities: {
    member: {
      labelField: "name",
      handlePrefix: "m",
      fileParent: {
        tableName: "users",
        schemaRef: "kernel",
        joinOn: "id",
        readScope: `${FIXTURE_APP}:members:read`,
        writeScope: `${FIXTURE_APP}:members:write`,
      },
    },
  },
}

async function livePolicy(): Promise<{ oid: number; qual: string } | undefined> {
  const rows = await sql<{ oid: number; qual: string }[]>`
    SELECT p.oid::int AS oid, pg_get_expr(p.polqual, p.polrelid) AS qual
    FROM pg_policy p
    WHERE p.polrelid = 'kernel.files'::regclass AND p.polname = 'files_select'`
  return rows[0]
}

/** Settings writes Meilisearch has recorded for the live index. */
async function settingsWrites(): Promise<number> {
  const tasks = await getMeili().tasks.getTasks({
    indexUids: [effectiveIndexName()],
    types: ["settingsUpdate"],
    limit: 1000,
  })
  return tasks.results.length
}

async function tableExists(schemaRef: string, tableName: string): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${`"${schemaRef}"."${tableName}"`}) IS NOT NULL AS present`
  return row?.present === true
}

afterAll(async () => {
  await rebuildFilesSelectPolicy()
})

describe("the setup step's catalog derivations", () => {
  it("applies a new catalog app's file parent", async () => {
    const catalog = await currentCatalog()
    expect(await applyCatalogDerivations([...catalog, bumpedApp])).toBe(true)
    expect((await livePolicy())?.qual).toContain(`'${FIXTURE_APP}'`)

    // The next catalog without it drops it again.
    expect(await applyCatalogDerivations(catalog)).toBe(true)
    expect((await livePolicy())?.qual).not.toContain(`'${FIXTURE_APP}'`)
  }, 60_000)

  it("fails when the policy could not be applied (kernel.files lock never granted)", async () => {
    const catalog = await currentCatalog()
    expect(await applyCatalogDerivations(catalog)).toBe(true)
    const holder = await sql.reserve()
    try {
      await holder`BEGIN`
      await holder`SELECT 1 FROM kernel.files LIMIT 1`
      expect(
        await applyCatalogDerivations([...catalog, bumpedApp], {
          lockTimeoutMs: 100,
          maxAttempts: 2,
          backoffMs: 10,
        }),
      ).toBe(false)
    } finally {
      await holder`ROLLBACK`
      holder.release()
    }
    expect((await livePolicy())?.qual).not.toContain(`'${FIXTURE_APP}'`)
  }, 60_000)

  it("a second run with the same catalog issues no policy DDL and no search settings write", async () => {
    expect(await applyCatalogDerivations()).toBe(true)
    // Meili applies settings asynchronously: let the first run's tasks land.
    await Bun.sleep(500)
    const policyBefore = await livePolicy()
    const appliedBefore = filesSelectPolicyRebuildStats.applied
    const writesBefore = await settingsWrites()

    expect(await applyCatalogDerivations()).toBe(true)
    await Bun.sleep(500)

    expect(filesSelectPolicyRebuildStats.applied).toBe(appliedBefore)
    expect(await livePolicy()).toEqual(policyBefore)
    expect(await settingsWrites()).toBe(writesBefore)
  }, 60_000)

  it("a rebuild with no org registered builds every catalog parent whose table exists", async () => {
    resetAppRegistries()
    await rebuildFilesSelectPolicy()
    const qual = (await livePolicy())?.qual ?? ""
    const parents = catalogFileParents(await currentCatalog())
    const present = []
    for (const p of parents) {
      if (await tableExists(p.schemaRef, p.tableName)) present.push(p)
    }
    // More than the kernel's own three: the app parents are there.
    expect(present.length).toBeGreaterThan(3)
    for (const p of present) {
      expect(qual).toContain(`'${p.app}'`)
      expect(qual).toContain(`'${p.entityType}'`)
    }
  }, 60_000)
})
