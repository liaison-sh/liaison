// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, spyOn } from "bun:test"
import {
  parsePurgeArgv,
  runPurgeDeletedMessageAttachmentsCli,
} from "~/cli/files-purge-deleted-message-attachments"

const ORG_A = "00000000-0000-0000-0000-00000000000a"
const ORG_B = "00000000-0000-0000-0000-00000000000b"

describe("liaison files purge-deleted-message-attachments", () => {
  it("parses --org and --dry-run, refuses anything else", () => {
    expect(parsePurgeArgv([])).toEqual({ ok: true, orgId: null, dryRun: false })
    expect(parsePurgeArgv(["--dry-run", "--org", ORG_A])).toEqual({
      ok: true,
      orgId: ORG_A,
      dryRun: true,
    })
    expect(parsePurgeArgv(["--org", "nope"]).ok).toBe(false)
    expect(parsePurgeArgv(["--execute"]).ok).toBe(false)
  })

  it("runs every org (or only --org), passes --dry-run through, reports totals as JSON", async () => {
    const out = spyOn(process.stdout, "write").mockImplementation(() => true)
    const calls: Array<{ orgId: string; dryRun: boolean }> = []
    const purge = async (p: { orgId: string; dryRun: boolean }) => {
      calls.push(p)
      return { orgId: p.orgId, files: p.orgId === ORG_A ? 2 : 0, messages: 1 }
    }
    try {
      const code = await runPurgeDeletedMessageAttachmentsCli(["--dry-run"], {
        purge,
        listOrgIds: async () => [ORG_A, ORG_B],
      })
      expect(code).toBe(0)
      expect(calls).toEqual([
        { orgId: ORG_A, dryRun: true },
        { orgId: ORG_B, dryRun: true },
      ])
      const report = JSON.parse(String(out.mock.calls.at(-1)?.[0]))
      expect(report).toEqual({
        dryRun: true,
        files: 2,
        orgs: [{ orgId: ORG_A, files: 2, messages: 1 }],
      })

      calls.length = 0
      await runPurgeDeletedMessageAttachmentsCli(["--org", ORG_B], {
        purge,
        listOrgIds: async () => {
          throw new Error("must not list orgs when --org is given")
        },
      })
      expect(calls).toEqual([{ orgId: ORG_B, dryRun: false }])
    } finally {
      out.mockRestore()
    }
  })
})
