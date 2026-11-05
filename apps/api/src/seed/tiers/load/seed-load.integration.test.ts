// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The load tier against a real database, on a box in demo mode: N orgs, each
// a full demo world marked synthetic with its expiry; the bulk volume lands in
// exact counts, the founder reads every row back under RLS and the search
// index holds them; a re-run adopts everything and keeps the expiry; the visitor
// counts see the orgs as synthetic, and the demo reaper collects them once
// they expire, and not before.
//
//   bun run scripts/test-run.ts demo-seed --file "$PWD/apps/api/src/seed/tiers/load/seed-load.integration.test.ts"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { countVisitorOrgs, listExpiredDemoOrgs } from "~/modules/demo/demo-expiry"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, loadDemoMarker } from "~/modules/demo/demo-org"
import { reapExpiredDemoOrgs } from "~/modules/demo/demo-reset"
import { checkCatalogSearchDrift } from "~/modules/search/drift"
import { waitForMeiliTask } from "~/modules/search/meili-task"
import type { VolumeSpec } from "~/seed/bulk/volume"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { runSeedLoadCli, type SeedLoadResult, seedLoadOrgs } from "./seed-load"

const DB_URL = process.env.DATABASE_URL ?? ""
const PREFIX = `load-${crypto.randomUUID().slice(0, 6)}-`
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]
const NOW = new Date("2026-11-02T12:00:00.000Z")
const TTL_HOURS = 2
const VOLUME: VolumeSpec = { threads: 120, contacts: 300, tickets: 150, projects: 40 }
const HOUR = 3_600_000

type Rows = Array<Record<string, unknown>>
const rowsOf = (r: unknown): Rows =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Rows

let first: SeedLoadResult

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  // A load box runs in demo mode: the reaper and the visitor counts only exist there.
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "load-")), "apps")
  }
  for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())
  // A box's boot creates the search index with the catalog's settings; this
  // run namespace's may be missing or left keyless by an earlier run: start it
  // again the way boot does.
  const meili = getMeili()
  if (await meili.getIndex(effectiveIndexName()).catch(() => null)) {
    const dropped = await meili.deleteIndex(effectiveIndexName())
    await waitForMeiliTask(meili, (dropped as { taskUid?: number }).taskUid)
  }
  await checkCatalogSearchDrift()
  first = await seedLoadOrgs({
    orgs: 2,
    prefix: PREFIX,
    volume: VOLUME,
    ttlHours: TTL_HOURS,
    concurrency: 2,
    now: NOW,
  })
}, 1_200_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("the load tier", () => {
  it("seeds N orgs in full, slugs <prefix><i>, each with its founder", () => {
    expect(first.failures).toEqual([])
    expect(first.complete).toBe(true)
    expect(first.orgs.map((o) => o.slug)).toEqual([`${PREFIX}0`, `${PREFIX}1`])
    expect(new Set(first.orgs.map((o) => o.orgId)).size).toBe(2)
    for (const org of first.orgs) expect(org.adminEmail).toContain(`@${org.slug}.`)
  })

  it("marks every org a synthetic visitor with its expiry, and no load flag without the harness key", async () => {
    for (const org of first.orgs) {
      await invalidateDemoMarker(org.orgId)
      const marker = await loadDemoMarker(org.orgId)
      expect(marker?.variant).toBe("visitor")
      expect(marker?.synthetic).toBe(true)
      expect(marker?.expiresAt).toBe(new Date(NOW.getTime() + TTL_HOURS * HOUR).toISOString())
      expect(org.expiresAt).toBe(marker?.expiresAt as string)
      expect(org.loadHarness).toBe(false)
    }
  })

  it("writes the exact volume, read back in full by the founder under RLS and indexed for search", () => {
    const total = VOLUME.threads + VOLUME.contacts + VOLUME.tickets + VOLUME.projects
    for (const org of first.orgs) {
      const inv = org.volume?.invariant
      expect(inv?.counts).toEqual(VOLUME)
      expect(inv?.readBack).toEqual(VOLUME)
      expect(inv?.searchDocs ?? 0).toBeGreaterThanOrEqual(total)
    }
  })

  it("keeps the bulk rows inside their own org", async () => {
    const [a, b] = first.orgs
    const [row] = rowsOf(
      await withSystemDb("load-test-isolation", (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM kernel.threads
                       WHERE org_id = ${a?.orgId}::uuid AND created_by IN (
                         SELECT id FROM kernel.users WHERE org_id = ${b?.orgId}::uuid)`),
      ),
    )
    expect(Number(row?.n)).toBe(0)
  })

  it("is idempotent: a re-run adopts the orgs and rows and keeps the expiry", async () => {
    const again = await seedLoadOrgs({
      orgs: 2,
      prefix: PREFIX,
      volume: VOLUME,
      reindex: false,
      ttlHours: 48,
      now: new Date(NOW.getTime() + HOUR),
    })
    expect(again.complete).toBe(true)
    expect(again.orgs.map((o) => o.orgId)).toEqual(first.orgs.map((o) => o.orgId))
    expect(again.orgs.map((o) => o.expiresAt)).toEqual(first.orgs.map((o) => o.expiresAt))
    for (const org of again.orgs) expect(org.volume?.invariant.counts).toEqual(VOLUME)
  }, 600_000)

  it("counts as synthetic visitors and is reaped once expired, not before", async () => {
    const ids = first.orgs.map((o) => o.orgId)
    expect((await countVisitorOrgs(NOW)).synthetic).toBeGreaterThanOrEqual(2)
    const early = await listExpiredDemoOrgs(new Date(NOW.getTime() + TTL_HOURS * HOUR - 60_000))
    expect(early.filter((o) => ids.includes(o.orgId))).toEqual([])
    const late = new Date(NOW.getTime() + TTL_HOURS * HOUR + 60_000)
    expect((await listExpiredDemoOrgs(late)).map((o) => o.orgId)).toEqual(
      expect.arrayContaining(ids),
    )
    const reaped = await reapExpiredDemoOrgs(late, {
      externalDeps: { deleteObjects: async () => 0, countObjects: async () => 0 },
    })
    expect(reaped.collected.map((o) => o.orgId)).toEqual(expect.arrayContaining(ids))
    const [row] = rowsOf(
      await withSystemDb("load-test-reaped", (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM kernel.organizations
                       WHERE id = ANY(${`{${ids.join(",")}}`}::uuid[])`),
      ),
    )
    expect(Number(row?.n)).toBe(0)
  }, 600_000)
})

describe("liaison seed --tier load (flags)", () => {
  const calls: unknown[] = []
  const fake = (async (opts: unknown) => {
    calls.push(opts)
    return { orgs: [], failures: [], complete: true }
  }) as typeof seedLoadOrgs

  it("refuses a missing or bad --orgs, an unknown shape and a bad volume count with exit 2", async () => {
    for (const argv of [
      [],
      ["--orgs", "0"],
      ["--orgs", "x"],
      ["--orgs", "2", "--shape", "standard-plus"],
      ["--orgs", "2", "--volume", "--threads", "-1"],
      ["--orgs", "2", "--passwords-env", "LOAD_TIER_TEST_UNSET_VAR"],
    ]) {
      expect((await runSeedLoadCli(argv, { seed: fake })).exitCode).toBe(2)
    }
    expect(calls).toEqual([])
  })

  it("passes the flags through: volume defaults overridden per kind, reindex on unless refused", async () => {
    const res = await runSeedLoadCli(
      [
        "--orgs",
        "3",
        "--prefix",
        "p-",
        "--volume",
        "--tickets",
        "7",
        "--no-reindex",
        "--concurrency",
        "2",
      ],
      { seed: fake },
    )
    expect(res.exitCode).toBe(0)
    expect(calls.at(-1)).toMatchObject({
      orgs: 3,
      prefix: "p-",
      shape: "demo",
      volume: { threads: 1100, contacts: 5000, tickets: 7, projects: 1000 },
      reindex: false,
      concurrency: 2,
    })
    await runSeedLoadCli(["--orgs=1"], { seed: fake })
    expect(calls.at(-1)).toMatchObject({ orgs: 1, volume: undefined, reindex: true })
  })
})
