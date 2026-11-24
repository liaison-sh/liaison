// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, spyOn } from "bun:test"
import {
  parseLinksBackfillArgv,
  runKnowledgeLinksBackfillCli,
} from "~/cli/knowledge-links-backfill"

describe("liaison knowledge links-backfill", () => {
  it("parses --org and --dry-run, refuses anything else", () => {
    const org = "00000000-0000-4000-8000-000000000001"
    expect(parseLinksBackfillArgv([])).toEqual({ ok: true, orgId: null, dryRun: false })
    expect(parseLinksBackfillArgv(["--org", org, "--dry-run"])).toEqual({
      ok: true,
      orgId: org,
      dryRun: true,
    })
    expect(parseLinksBackfillArgv(["--org", "nope"]).ok).toBe(false)
    expect(parseLinksBackfillArgv(["--execute"]).ok).toBe(false)
  })

  it("runs the backfill with the flags and prints its report", async () => {
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    const calls: unknown[] = []
    const report = { dryRun: true, documents: 3, documentsChanged: 1, versionsChanged: 2 }
    try {
      const code = await runKnowledgeLinksBackfillCli(["--dry-run"], {
        backfill: async (opts) => {
          calls.push(opts)
          return report
        },
      })
      expect(code).toBe(0)
      expect(calls).toEqual([{ dryRun: true }])
      expect(out).toHaveBeenCalledWith(`${JSON.stringify(report)}\n`)
    } finally {
      out.mockRestore()
    }
  })

  it("a bad argument exits 2 without running", async () => {
    const err = spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      let ran = false
      const code = await runKnowledgeLinksBackfillCli(["--bogus"], {
        backfill: async () => {
          ran = true
          return { dryRun: false, documents: 0, documentsChanged: 0, versionsChanged: 0 }
        },
      })
      expect(code).toBe(2)
      expect(ran).toBe(false)
    } finally {
      err.mockRestore()
    }
  })
})
