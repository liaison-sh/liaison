// SPDX-License-Identifier: FSL-1.1-ALv2
// `liaison org export <org> [--wait]` (S3.1): the operator queues a whole-org
// export for the server's worker and, with --wait, follows it to the end.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { runOrgExportCli } from "~/cli/org-export"
import { deleteObject } from "~/infra/storage/object-storage"
import { processOrgExportJob } from "~/modules/export/org-archive/job"
import { getOrgExport } from "~/modules/export/org-archive/store"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let slug = ""
let orgId = ""
const keys: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  slug = `oexp-cli-${crypto.randomUUID().slice(0, 8)}`
  orgId = (await ensureOrg({ slug, name: "Export CLI Org" })).orgId
}, 60_000)

afterAll(async () => {
  for (const k of keys) await deleteObject(k).catch(() => undefined)
  await releaseTestLock()
})

describe("liaison org export", () => {
  it("queues an export for the server and, with --wait, reports the finished archive", async () => {
    const enqueued: string[] = []
    const res = await runOrgExportCli([slug, "--wait"], {
      // The server's worker, played in-process (the CLI never hosts jobs).
      enqueue: async (p) => {
        enqueued.push(p.exportId)
        void processOrgExportJob(p)
      },
      pollMs: 100,
    })
    expect(res.exitCode).toBe(0)
    expect(enqueued.length).toBe(1)
    const report = res.report as Record<string, any>
    expect(report.exportId).toBe(enqueued[0])
    expect(report.status).toBe("completed")
    expect(String(report.objectKey)).toStartWith(`orgs/${orgId}/exports/${enqueued[0]}-`)
    keys.push(report.objectKey)
    expect(report.bytes).toBeGreaterThan(0)
    expect(report.tables).toBeGreaterThan(10)
  })

  it("without --wait returns the queued id; a second request is refused with it", async () => {
    const first = await runOrgExportCli([orgId], { enqueue: async () => undefined })
    expect(first.exitCode).toBe(0)
    const report = first.report as Record<string, any>
    expect(report.status).toBe("queued")
    const second = await runOrgExportCli([slug], { enqueue: async () => undefined })
    expect(second.exitCode).toBe(1)
    expect((second.report as Record<string, any>).runningId).toBe(report.exportId)
  })

  it("a failed enqueue fails the row (QUEUE_FAILED), so the org can export again (K6)", async () => {
    const s2 = `oexp-cli-q-${crypto.randomUUID().slice(0, 8)}`
    const org2 = (await ensureOrg({ slug: s2, name: "Export CLI Queue Org" })).orgId
    const err = await runOrgExportCli([s2], {
      enqueue: async () => {
        throw new Error("connect ECONNREFUSED redis.internal:6379")
      },
    }).catch((e) => e)
    expect(err).not.toBeInstanceOf(Error)
    const res = err as Awaited<ReturnType<typeof runOrgExportCli>>
    expect(res.exitCode).toBe(1)
    const exportId = String((res.report as Record<string, unknown>).exportId)
    const row = await getOrgExport(org2, exportId)
    expect(row?.status).toBe("failed")
    expect(row?.error).toBe("QUEUE_FAILED")
    const again = await runOrgExportCli([s2], { enqueue: async () => undefined })
    expect(again.exitCode).toBe(0)
  })

  it("refuses a missing or unknown org with usage (exit 2)", async () => {
    expect((await runOrgExportCli([], {})).exitCode).toBe(2)
    expect((await runOrgExportCli(["no-such-org-slug-x"], {})).exitCode).toBe(2)
  })
})
