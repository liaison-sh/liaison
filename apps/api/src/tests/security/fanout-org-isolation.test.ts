// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduler fan-out org isolation, enumerated.
//
// The job types are the fan-out templates of every installed app, read the way
// the scheduler reads them (fanoutReconcileSources -> fanoutTemplatesOf), with
// every bundled app installed. Each one is run for org A through the worker's
// own dispatch (JobsTestAccess.processJob, the fan-out job id included), with
// org B seeded alongside. For every job:
//   writes: the fingerprint of every org but A (count + digest of their rows
//     in every org-scoped table, from pg_catalog) is unchanged;
//   reads:  no row of org A carries org B's canary text afterwards (a read of
//     B that lands anywhere in A).
// Positive control: monitoring's assign-refs numbers org A's unnumbered
// incident, so the dispatch really ran an app job for A; B's stays unnumbered.
// A job that fails for want of a connection still counts: the assertion is
// about what it touched, whatever its outcome.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db"
import { fanoutJobId } from "~/infra/jobs/fanout"
import {
  type FanoutTemplate,
  fanoutReconcileSources,
  fanoutTemplatesOf,
} from "~/infra/jobs/fanout-runtime"
import { closeAllQueues, JobsTestAccess } from "~/infra/jobs/jobs"
import { reloadInstalledApps } from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import {
  closeIsolationScans,
  fingerprintDiff,
  type IsolationOrg,
  newIsolationOrg,
  orgFingerprint,
  orgScopedTables,
  seedOrgThroughApi,
  tablesMentioning,
} from "~/tests/helpers/org-isolation"
import { firstPartyAppTarball } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const JOB_TIMEOUT_MS = 30_000

interface BundledManifest {
  name: string
  scopes?: string[]
  connections?: Record<string, unknown>
  jobs?: unknown
}

function bundledManifests(): BundledManifest[] {
  const dir = join(REPO, "bundled-apps")
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      try {
        return [JSON.parse(readFileSync(join(dir, e.name, "app.manifest.json"), "utf8"))]
      } catch {
        return []
      }
    })
}

let installRoot = ""
let prevAppsDir: string | undefined
let a: IsolationOrg
let b: IsolationOrg
const canaryB = `canary-b-${crypto.randomUUID().slice(0, 12)}`
let templates: FanoutTemplate[] = []
const outcomes: string[] = []

async function seedIncident(orgId: string, title: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO app_monitoring.incidents (org_id, source, severity, title, first_seen_at, last_seen_at)
    VALUES (${orgId}::uuid, 'sec-invariant', 'warning', ${title}, now(), now())
    RETURNING id::text AS id`
  return String(row?.id)
}

beforeAll(async () => {
  await acquireTestLock()
  installRoot = mkdtempSync(join(tmpdir(), "fanout-isolation-apps-"))
  prevAppsDir = process.env.LIAISON_APPS_DIR
  process.env.LIAISON_APPS_DIR = installRoot
  a = await newIsolationOrg()
  b = await newIsolationOrg()
  for (const m of bundledManifests()) {
    if (fanoutTemplatesOf({ name: m.name, jobs: m.jobs }).length === 0) continue
    await installAppFromTarball({
      tarballPath: firstPartyAppTarball(m.name),
      installedBy: a.userId,
      grantedScopes: m.scopes ?? [],
      grantedConnections: Object.keys(m.connections ?? {}),
      requireSignature: false,
      approveUiFullAccess: true,
    })
  }
  await reloadInstalledApps(a.orgId)
  await reloadInstalledApps(b.orgId)

  const active = await fanoutReconcileSources.activeAppNames()
  for (const name of [...active].sort()) {
    const desc = await fanoutReconcileSources.installedDescriptor(name)
    if (desc) templates.push(...fanoutTemplatesOf(desc))
  }
  templates = templates.sort((x, y) => `${x.app}/${x.job}`.localeCompare(`${y.app}/${y.job}`))

  await seedOrgThroughApi(a, `canary-a-${crypto.randomUUID().slice(0, 12)}`)
  await seedOrgThroughApi(b, canaryB)
  await seedIncident(a.orgId, "unnumbered A")
  await seedIncident(b.orgId, `unnumbered ${canaryB}`)
}, 900_000)

afterAll(async () => {
  console.log(`fan-out isolation: ${templates.length} job types\n${outcomes.join("\n")}`)
  await shutdownWorkerPool()
  await closeAllQueues()
  await closeIsolationScans()
  if (prevAppsDir === undefined) delete process.env.LIAISON_APPS_DIR
  else process.env.LIAISON_APPS_DIR = prevAppsDir
  rmSync(installRoot, { recursive: true, force: true })
  await releaseTestLock()
}, 120_000)

describe("scheduler fan-out jobs stay inside their org", () => {
  it("enumerates every scheduled job of every bundled app from the scheduler's own templates", () => {
    const declared = bundledManifests()
      .flatMap((m) => fanoutTemplatesOf({ name: m.name, jobs: m.jobs }))
      .map((t) => `${t.app}/${t.job}`)
      .sort()
    expect(declared.length).toBeGreaterThan(0)
    expect(templates.map((t) => `${t.app}/${t.job}`)).toEqual(declared)
  })

  it("a job run for org A writes nothing of any other org and copies nothing of B into A", async () => {
    const aTables = await orgScopedTables()
    const leaks: string[] = []
    const epoch = Math.floor(Date.now() / 300_000) * 300_000
    for (const t of templates) {
      const before = await orgFingerprint(a.orgId, { others: true })
      let id = `test-${t.app}-${t.job}-${crypto.randomUUID().slice(0, 8)}`
      try {
        id = fanoutJobId(t.app, t.job, a.orgId, epoch)
      } catch {}
      let outcome = "ok"
      try {
        await Promise.race([
          JobsTestAccess.processJob(
            t.app,
            t.job,
            { orgId: a.orgId },
            `app-${t.app}`,
            undefined,
            id,
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timed out")), JOB_TIMEOUT_MS),
          ),
        ])
      } catch (err) {
        outcome = `error: ${String((err as Error).message).slice(0, 120)}`
      }
      outcomes.push(`  ${t.app}/${t.job}: ${outcome}`)
      const changed = fingerprintDiff(before, await orgFingerprint(a.orgId, { others: true }))
      if (changed.length > 0)
        leaks.push(`${t.app}/${t.job} wrote another org: ${changed.join("; ")}`)
      const copied = await tablesMentioning(canaryB, {
        tables: aTables,
        where: () => `x.org_id = '${a.orgId}'::uuid`,
      })
      if (Object.keys(copied).length > 0) {
        leaks.push(`${t.app}/${t.job} copied org B data into A: ${JSON.stringify(copied)}`)
      }
    }
    expect(leaks).toEqual([])

    // Positive control: the dispatch ran an app job for A, and only for A.
    const refs = await sql<{ org: string; numbered: boolean }[]>`
      SELECT org_id::text AS org, ref_number IS NOT NULL AS numbered
      FROM app_monitoring.incidents WHERE org_id IN (${a.orgId}::uuid, ${b.orgId}::uuid)`
    expect(refs.find((r) => r.org === a.orgId)?.numbered).toBe(true)
    expect(refs.find((r) => r.org === b.orgId)?.numbered).toBe(false)
  }, 1_800_000)
})
