// SPDX-License-Identifier: FSL-1.1-ALv2
// S23 (A4): the instance-wide derivations of the catalog, the `kernel.files`
// SELECT policy and the search index settings, are applied once by the locked
// setup step (`src/db/reconcile-catalog-boot.ts`), and a server process that
// has registered zero orgs leaves them byte-identical.
//
// Over one worker's schemas (createRoleCell, an EMPTY database, no org): run
// the setup step, snapshot the policy and the settings, run it again (M4: no
// policy DDL, no settings write), then boot an `api` and a `worker` and wait
// for /readyz. Before A4 every boot rewrote the policy from the orgs it had
// registered, here none: a kernel-only policy without the app parents.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  createRoleCell,
  jsonLogLines,
  type RoleCell,
  type RoleProcess,
} from "@liaison/test-helpers"
import { MeiliSearch } from "meilisearch"

// The parallel runner gives this file a private worker id; a plain `bun test`
// run takes one clear of the lanes (0-3), the helper tests (50-61, 99) and the
// other cell scenarios (70, 71, 73-78).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 72
const SETUP_STEP = ["src/db/reconcile-catalog-boot.ts", "--strict"]

interface PolicySnapshot {
  oid: number
  qual: string
  comment: string | null
}

async function readyz(p: RoleProcess): Promise<number> {
  return (await fetch(`${p.url}/readyz`)).status
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

describe("S23: catalog derivations are the setup step's, never a booting process's", () => {
  let cell: RoleCell
  let meili: MeiliSearch
  let indexUid: string
  let policyAfterSetup: PolicySnapshot
  let settingsAfterSetup: string
  const booted: RoleProcess[] = []

  async function policy(): Promise<PolicySnapshot> {
    const rows = await cell.db.sql.unsafe(
      `SELECT p.oid::int AS oid, pg_get_expr(p.polqual, p.polrelid) AS qual,
              obj_description(p.oid, 'pg_policy') AS comment
       FROM pg_policy p
       WHERE p.polrelid = '${cell.schemaPrefix}kernel.files'::regclass AND p.polname = 'files_select'`,
    )
    const row = rows[0]
    if (!row) throw new Error("kernel.files has no files_select policy")
    return {
      oid: Number(row.oid),
      qual: String(row.qual),
      comment: row.comment == null ? null : String(row.comment),
    }
  }

  async function settings(): Promise<string> {
    return JSON.stringify(await meili.index(indexUid).getSettings())
  }

  async function settingsWrites(): Promise<number> {
    const tasks = await meili.tasks.getTasks({
      indexUids: [indexUid],
      types: ["settingsUpdate"],
      limit: 1000,
    })
    return tasks.results.length
  }

  async function runSetupStep(): Promise<void> {
    const run = await cell.runOneShot(SETUP_STEP)
    if (run.exitCode !== 0) {
      throw new Error(`setup step exited ${run.exitCode}:\n${run.stderr.slice(-4000)}`)
    }
  }

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, [])
    meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST ?? "http://localhost:7700",
      apiKey: process.env.MEILISEARCH_API_KEY ?? "dev-master-key",
    })
    indexUid = `${cell.meiliIndexPrefix}liaison_search`
    await meili.deleteIndex(indexUid).catch(() => undefined)
  }, 120_000)

  afterAll(async () => {
    await meili?.deleteIndex(indexUid).catch(() => undefined)
    await cell?.teardown()
  }, 60_000)

  it("the setup step applies the catalog's policy and settings; a second run writes nothing (M4)", async () => {
    const orgs = await cell.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${cell.schemaPrefix}kernel.organizations`,
    )
    expect(orgs[0]?.n).toBe(0)

    await runSetupStep()
    policyAfterSetup = await policy()
    // The catalog's parents, not the kernel's alone: an in-tree app's is there.
    expect(policyAfterSetup.qual).toContain("'knowledge'")
    // Meilisearch applies settings asynchronously: wait until they are there.
    settingsAfterSetup =
      (await until(async () => {
        const s = await settings()
        return s.includes("participant_ids") ? s : undefined
      }, 30_000)) ?? ""
    expect(settingsAfterSetup).toContain("participant_ids")
    const writesBefore = await settingsWrites()

    await runSetupStep()
    expect(await policy()).toEqual(policyAfterSetup)
    expect(await settings()).toBe(settingsAfterSetup)
    expect(await settingsWrites()).toBe(writesBefore)
  }, 180_000)

  it("an api and a worker booting with zero orgs leave the policy and settings byte-identical (S23)", async () => {
    booted.push(await cell.spawn("worker"))
    booted.push(await cell.spawn("api"))
    for (const p of booted) {
      expect(await until(async () => ((await readyz(p)) === 200 ? true : undefined), 60_000)).toBe(
        true,
      )
    }
    // Let the leader's drift check, and any rebuild it schedules, settle.
    await Bun.sleep(3_000)

    expect(await policy()).toEqual(policyAfterSetup)
    expect(await settings()).toBe(settingsAfterSetup)
  }, 180_000)

  it("no booting process rewrote the files policy (the leader's check finds it unchanged)", () => {
    for (const p of booted) {
      const policyLines = jsonLogLines(p).filter(
        (l) =>
          l.msg === "Rebuilt files SELECT policy" ||
          l.msg === "Rebuilt files SELECT policy (admin fallback)",
      )
      expect(policyLines).toEqual([])
    }
  })
})
