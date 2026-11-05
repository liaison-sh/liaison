// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A manifest job with a `schedule` is one scheduler per (app, job), fanned out
// over orgs (infra/jobs/fanout.ts): registering an org's app registers its
// handler and adds no scheduler. Drives the real registerApps path; only the
// out-of-process worker pool is stubbed.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { readJobMetrics } from "~/infra/jobs/fanout-keys"
import { closeAllQueues, createAppQueue, getPhysicalQueue, JobsTestAccess } from "~/infra/jobs/jobs"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import * as workerPool from "~/modules/apps/sandbox/worker-pool"

const ORG_A = "00000000-0000-0000-0000-0000001f0a01"
const ORG_B = "00000000-0000-0000-0000-0000001f0a02"
const ORG_UNREGISTERED = "00000000-0000-0000-0000-0000001f0a03"
const APP = "scheduled-fanout-app"
const JOB = "nightly-sync"

describe("registerApps: a scheduled manifest job registers its handler, no scheduler", () => {
  let bundleDir: string
  const executed: Array<{ exportName: string; orgId: unknown }> = []
  const spies: Array<{ mockRestore(): void }> = []
  const manifest = () => ({
    name: APP,
    version: "1.0.0",
    _format: "manifest" as const,
    _bundlePath: join(bundleDir, "handlers.js"),
    jobs: { [JOB]: { handler: "nightlySync", schedule: "0 3 * * *" } },
  })
  const schedulerCount = async () =>
    (await createAppQueue(APP).getJobSchedulersCount()) +
    (await getPhysicalQueue("kernel-cron").getJobSchedulersCount())

  beforeAll(async () => {
    for (const [id, slug] of [
      [ORG_A, "scheduled-fanout-a"],
      [ORG_B, "scheduled-fanout-b"],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${id}, 'Scheduled Fanout Org', ${slug}) ON CONFLICT (id) DO NOTHING`
    }
    bundleDir = mkdtempSync(join(tmpdir(), "scheduled-fanout-"))
    writeFileSync(
      join(bundleDir, "handlers.js"),
      "function nightlySync() {}\nexport { nightlySync };\n",
    )
    spies.push(spyOn(workerPool, "initWorkerPool").mockResolvedValue(undefined))
    spies.push(
      spyOn(workerPool, "getWorkerPool").mockReturnValue({
        execute: async (req: { exportName: string; params: { orgId?: unknown } }) => {
          executed.push({ exportName: req.exportName, orgId: req.params.orgId })
          return null
        },
      } as unknown as ReturnType<typeof workerPool.getWorkerPool>),
    )
  })

  afterAll(async () => {
    for (const s of spies) s.mockRestore()
    for (const org of [ORG_A, ORG_B]) await teardownAppRegistrations(org, APP).catch(() => {})
    resetAppRegistries()
    rmSync(bundleDir, { recursive: true, force: true })
    await createAppQueue(APP).obliterate({ force: true })
    await closeAllQueues()
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
  })

  it("registering an org's app upserts no scheduler", async () => {
    const before = await schedulerCount()
    await registerApps([manifest() as never], ORG_A)
    await registerApps([manifest() as never], ORG_B)
    expect(await schedulerCount()).toBe(before)
  })

  it("a scheduled job's handler is registered for (app, job) and runs a fan-out job for any org", async () => {
    const handler = JobsTestAccess.getHandler(APP, JOB)
    expect(handler).toBeDefined()
    executed.length = 0
    // The handler last registered by org B's registration runs org A's job as org A.
    await handler!({ orgId: ORG_A })
    await handler!({ orgId: ORG_B })
    expect(executed).toEqual([
      { exportName: "nightlySync", orgId: ORG_A },
      { exportName: "nightlySync", orgId: ORG_B },
    ])
  })

  it("the not-installed refusal does not run the handler, does not throw and counts", async () => {
    const handler = JobsTestAccess.getHandler(APP, JOB)
    executed.length = 0
    const before = (await readJobMetrics()).fanout_skip_not_registered ?? 0
    await handler!({ orgId: ORG_UNREGISTERED })
    expect(executed).toEqual([])
    expect((await readJobMetrics()).fanout_skip_not_registered).toBe(before + 1)
  })
})
