// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { registerKnowledgeJobs } from "~/apps/knowledge/knowledge-jobs"
import { closeAllQueues, listOrglessScheduledJobs } from "~/infra/jobs/jobs"
import { registerKernelJobs } from "~/infra/jobs/kernel-jobs"
import { registerDigestScheduledJobs } from "~/modules/attention/digest-jobs"
import { registerStateMaterializerScheduledJob } from "~/modules/attention/state-materializer"
import { registerOrphanGcScheduledJob } from "~/modules/files/orphan-gc"
import { registerImportUploadReaper } from "~/modules/imports/uploads/reaper"
import { registerMailboxBackfillJobs } from "~/modules/mailbox-crypto/backfill-job"
import {
  JOB_INFRASTRUCTURE_FILES,
  ORGLESS_JOB_AUDIT,
  ORGLESS_WORKER_AUDIT,
  type OrglessJobEntry,
} from "~/modules/org/transfer-state/orgless-jobs"

const SRC = join(import.meta.dir, "../../..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(path)
    }
  }
  return out
}

/** The registrar names as code: not in an import, a comment or a string. */
const REGISTRAR_NAME =
  /\b(registerJobWorker|registerScheduledJob|registerSingleton|upsertJobScheduler)\b/

function usesRegistrar(text: string): boolean {
  const code = text
    .replace(/import\s[^;]*?from\s+"[^"]+"/gs, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/"[^"\n]*"/g, '""')
  return REGISTRAR_NAME.test(code)
}
const READS_MOVING_SET = /\bmovingOrgIds\(\)|\bsweepSkippingMoving\(|\bwriteUnlessMoving\(/

const allEntries = (): Array<[string, OrglessJobEntry]> => [
  ...Object.entries(ORGLESS_JOB_AUDIT),
  ...Object.entries(ORGLESS_WORKER_AUDIT),
]

describe("org-less jobs and the transfer hold", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("every registered scheduled job without an org payload is audited, and nothing audited is gone", async () => {
    await registerKernelJobs()
    await registerKnowledgeJobs()
    await registerStateMaterializerScheduledJob()
    await registerDigestScheduledJobs()
    await registerOrphanGcScheduledJob()
    await registerImportUploadReaper()
    await registerMailboxBackfillJobs()
    const registered = listOrglessScheduledJobs()
    expect(registered.filter((key) => !(key in ORGLESS_JOB_AUDIT))).toEqual([])
    // A key audited but never registered is stale (a renamed or removed job), or hides
    // a registrar this test does not call. Demo jobs register on a demo box only.
    const demoOnly = new Set(["kernel:demo-reset", "kernel:demo-reap", "kernel:demo-pool-refill"])
    const stale = Object.keys(ORGLESS_JOB_AUDIT).filter(
      (key) => !registered.includes(key) && !demoOnly.has(key),
    )
    expect(stale).toEqual([])
  })

  it("every file that registers a worker, a scheduler or a singleton is audited", () => {
    const registrars = sourceFiles(SRC)
      .map((file) => relative(SRC, file))
      .filter((file) => !JOB_INFRASTRUCTURE_FILES.includes(file))
      .filter((file) => usesRegistrar(readFileSync(join(SRC, file), "utf8")))
    expect(registrars.filter((file) => !(file in ORGLESS_WORKER_AUDIT))).toEqual([])
    // An entry for a file that registers nothing (any more) is stale.
    const stale = Object.keys(ORGLESS_WORKER_AUDIT).filter((file) => !registrars.includes(file))
    expect(stale).toEqual([])
  })

  it("no entry is left unaudited, and every audited entry says why", () => {
    for (const [key, entry] of allEntries()) {
      if (entry.status === "audited") {
        expect([key, entry.reason.trim().length > 0]).toEqual([key, true])
      } else {
        expect([key, entry.status]).toEqual([key, "skips-moving"])
        expect([key, entry.sources.length > 0]).toEqual([key, true])
      }
    }
  })

  it("an entry that skips moving orgs reads the moving set in every source it names", () => {
    for (const [key, entry] of allEntries()) {
      if (entry.status !== "skips-moving") continue
      for (const source of entry.sources) {
        const text = readFileSync(join(SRC, source), "utf8")
        expect([key, source, READS_MOVING_SET.test(text)]).toEqual([key, source, true])
      }
    }
  })

  it("the shared skip helper reads movingOrgIds()", () => {
    const text = readFileSync(join(import.meta.dir, "skip-moving.ts"), "utf8")
    expect(/\bmovingOrgIds\(\)/.test(text)).toBe(true)
  })
})
