// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 12.1: the backfill job must register in EXACTLY ONE process, and must
// refuse to boot in a process that has not started the leadership monitor.
//
// The rule this pins (blueprint amendment A7): `registerKernelJobs()` is called
// from `index.ts`, `index.e2e.ts` and any dedicated job worker, so anything put in
// `kernel-jobs.ts` registers everywhere. The backfill therefore lives on its
// own and is called from `index.ts` only, immediately after
// `startLeadership`, so it rides the already-gated BullMQ path.
//
// The startup assertion FAILS CLOSED. A process that never started leadership
// has never armed the Patroni jobs gate, so the job would run on every node and
// seal every mailbox there. A hard throw at boot is the correct outcome; a
// silently skipped backfill is worse than a refused boot.

import { afterEach, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { LeadershipTestAccess, startLeadership } from "~/infra/leadership"
import {
  MAILBOX_BACKFILL_JOB_NAME,
  MAILBOX_PURGE_JOB_NAME,
  registerMailboxBackfillWorker,
} from "~/modules/mailbox-crypto/backfill-job"

const API_SRC = path.resolve(import.meta.dir, "../..")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full)
    }
  }
  return out
}

describe("Task 12.1: the backfill registers in exactly one process", () => {
  afterEach(async () => {
    await LeadershipTestAccess.reset()
  })

  it("non-vacuity: the static sweep reads a real, non-empty apps/api source tree", () => {
    const files = walk(API_SRC)
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.endsWith("/index.ts"))).toBe(true)
    expect(files.some((f) => f.endsWith("/infra/jobs/kernel-jobs.ts"))).toBe(true)
  })

  it("is referenced exactly once outside its own module and its tests, from index.ts", () => {
    const hits: string[] = []
    for (const file of walk(API_SRC)) {
      if (file.includes("mailbox-crypto/backfill-job")) continue
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue
      if (readFileSync(file, "utf8").includes("registerMailboxBackfillWorker")) hits.push(file)
    }
    expect(hits).toHaveLength(1)
    expect(hits[0]).toBe(path.join(API_SRC, "index.ts"))
  })

  it("is registered immediately after the leadership monitor starts, not before it", () => {
    const entry = readFileSync(path.join(API_SRC, "index.ts"), "utf8")
    const monitorAt = entry.indexOf("startLeadership(")
    const registerAt = entry.indexOf("registerMailboxBackfillWorker(")
    expect(monitorAt).toBeGreaterThan(-1)
    expect(registerAt).toBeGreaterThan(monitorAt)
    // Nothing between them but whitespace and comments: "immediately after" is
    // the property, because anything that can throw in between leaves the job
    // unregistered on a node that IS the leader.
    const between = entry
      .slice(entry.indexOf("\n", monitorAt) + 1, entry.lastIndexOf("\n", registerAt) + 1)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && l !== "/**")
    expect(between).toEqual([])
  })

  it("is NOT reachable from kernel-jobs.ts, which every entrypoint calls", () => {
    const kernelJobs = readFileSync(path.join(API_SRC, "infra/jobs/kernel-jobs.ts"), "utf8")
    expect(kernelJobs).not.toContain("registerMailboxBackfillWorker")
    expect(kernelJobs).not.toContain("mailbox-crypto/backfill-job")
    // The entrypoints that call registerKernelJobs, named so a future
    // third one does not quietly reintroduce the double fire.
    for (const entry of ["index.ts", "../test-support/index.e2e.ts"]) {
      expect(readFileSync(path.join(API_SRC, entry), "utf8")).toContain("registerKernelJobs")
    }
  })

  it("throws at boot when this process never started the leadership monitor", async () => {
    await LeadershipTestAccess.reset()
    await expect(registerMailboxBackfillWorker()).rejects.toThrow(/leadership monitor/i)
  })

  it("registers exactly one worker for the mailbox-backfill job name once the monitor started", async () => {
    await startLeadership({
      role: "all",
      patroni: { url: undefined },
      lease: { key: `backfill-registration-test:${crypto.randomUUID()}` },
    })
    const scheduled: string[] = []
    const workers: string[] = []
    await registerMailboxBackfillWorker({
      registerScheduled: async (appName, jobName) => {
        scheduled.push(`${appName}:${jobName}`)
        return jobName
      },
      registerWorker: (appName, jobName) => {
        workers.push(`${appName}:${jobName}`)
      },
    })
    expect(scheduled).toEqual([`kernel:${MAILBOX_BACKFILL_JOB_NAME}`])
    expect(MAILBOX_BACKFILL_JOB_NAME).toBe("mailbox-backfill")
    // The purge rides the same leader-gated site but has NO cron: it is admin
    // invoked, per user, and destructive work must never fire on a schedule.
    expect(workers).toEqual([`kernel:${MAILBOX_PURGE_JOB_NAME}`])
    expect(MAILBOX_PURGE_JOB_NAME).toBe("mailbox-purge")
  })
})
