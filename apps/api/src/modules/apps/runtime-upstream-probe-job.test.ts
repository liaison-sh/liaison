// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandboxed app's scheduled job named by the manifest's `webhookHealth.probe`
// has its result stored as an upstream-activity report when it runs; any other
// job's result is not. Drives the real registerApps path and runs the exact
// handler a BullMQ worker would run; only the out-of-process worker pool is
// stubbed (its execute returns what the probe export would have returned).
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { redis } from "~/lib/redis"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps, teardownAppRegistrations } from "~/modules/apps/runtime"
import * as workerPool from "~/modules/apps/sandbox/worker-pool"
import { resetWebhookIngestHealth } from "~/modules/webhooks/ingest-health"
import {
  readUpstreamActivity,
  readUpstreamProbeFailures,
} from "~/modules/webhooks/upstream-activity"

const TEST_ORG = "00000000-0000-0000-0000-000000120077"
const APP = "upstream-probe-job-app"
const PROBE_JOB = "probe-upstream"
const OTHER_JOB = "nightly-sync"
const ACTIVITY_AT = "2026-10-01T12:00:00.000Z"

describe("registerApps: the webhookHealth probe job records upstream activity", () => {
  let bundleDir: string
  let executeCalls: string[]
  let probeResult: unknown = { upstreamActivityAt: ACTIVITY_AT }
  const spies: Array<{ mockRestore(): void }> = []

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Upstream Probe Job Org', 'upstream-probe-job')
      ON CONFLICT (id) DO NOTHING`
    bundleDir = mkdtempSync(join(tmpdir(), "upstream-probe-"))
    writeFileSync(
      join(bundleDir, "handlers.js"),
      "function probeUpstream() {}\nfunction nightlySync() {}\nexport { probeUpstream, nightlySync };\n",
    )
    executeCalls = []
    spies.push(spyOn(workerPool, "initWorkerPool").mockResolvedValue(undefined))
    spies.push(
      spyOn(workerPool, "getWorkerPool").mockReturnValue({
        execute: async (req: { exportName: string }) => {
          executeCalls.push(req.exportName)
          return req.exportName === "probeUpstream"
            ? probeResult
            : { upstreamActivityAt: ACTIVITY_AT }
        },
      } as unknown as ReturnType<typeof workerPool.getWorkerPool>),
    )
  })

  afterEach(async () => {
    await redis.del(`webhook-upstream:${APP}`, `webhook-upstream-failure:${APP}`)
    probeResult = { upstreamActivityAt: ACTIVITY_AT }
  })

  afterAll(async () => {
    for (const s of spies) s.mockRestore()
    await teardownAppRegistrations(TEST_ORG, APP).catch(() => {})
    resetAppRegistries()
    resetWebhookIngestHealth()
    rmSync(bundleDir, { recursive: true, force: true })
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("the probe job's result lands in the upstream report, another job's does not", async () => {
    const manifest = {
      name: APP,
      version: "1.0.0",
      _format: "manifest" as const,
      _bundlePath: join(bundleDir, "handlers.js"),
      jobs: {
        [PROBE_JOB]: { handler: "probeUpstream", schedule: "*/15 * * * *" },
        [OTHER_JOB]: { handler: "nightlySync", schedule: "0 3 * * *" },
      },
      webhooks: { inbound: { verify: "verifyInbound", handler: "handleInbound" } },
      webhookHealth: { probe: PROBE_JOB },
    }
    await registerApps([manifest as any], TEST_ORG)

    const other = JobsTestAccess.getHandler(APP, OTHER_JOB)
    const probe = JobsTestAccess.getHandler(APP, PROBE_JOB)
    expect(other).toBeDefined()
    expect(probe).toBeDefined()

    // A job not named by webhookHealth.probe: it runs, but nothing is recorded.
    await other!({ orgId: TEST_ORG })
    expect(executeCalls).toEqual(["nightlySync"])
    expect((await readUpstreamActivity([APP])).has(APP)).toBe(false)

    // The probe job: its `{ upstreamActivityAt }` becomes the app's report.
    const before = Date.now()
    await probe!({ orgId: TEST_ORG })
    expect(executeCalls).toEqual(["nightlySync", "probeUpstream"])
    const report = (await readUpstreamActivity([APP])).get(APP)
    expect(report).toBeDefined()
    expect(report!.activityAtMs).toBe(Date.parse(ACTIVITY_AT))
    expect(report!.probedAtMs).toBeGreaterThanOrEqual(before)
  })

  it("a probe that could not look records why, and its next report clears it", async () => {
    const probe = JobsTestAccess.getHandler(APP, PROBE_JOB)
    expect(probe).toBeDefined()

    probeResult = { probed: false, reason: "403 (#200) Requires pages_manage_metadata permission" }
    await probe!({ orgId: TEST_ORG })
    expect((await readUpstreamActivity([APP])).has(APP)).toBe(false)
    expect((await readUpstreamProbeFailures([APP])).get(APP)?.reason).toBe(
      "403 (#200) Requires pages_manage_metadata permission",
    )

    probeResult = { upstreamActivityAt: ACTIVITY_AT }
    await probe!({ orgId: TEST_ORG })
    expect((await readUpstreamActivity([APP])).has(APP)).toBe(true)
    expect((await readUpstreamProbeFailures([APP])).has(APP)).toBe(false)
  })
})
