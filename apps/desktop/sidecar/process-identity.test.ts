// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A process named by its pid AND its start time (process-identity.ts), so the
// sign-in's watchdog never mistakes a reused pid for the process it watches.

import { describe, expect, it } from "bun:test"
import { identityReader, parseLinuxStat, parsePsLine } from "./process-identity"

describe("reading a process's identity", () => {
  it("takes the start time out of /proc/<pid>/stat, whatever the command is called", () => {
    const fields = (state: string) =>
      `4242 (claude (auth) x) ${state} 1 4242 4242 0 -1 4194304 100 0 0 0 5 2 0 0 20 0 7 0 987654 123456 789`
    expect(parseLinuxStat(fields("S"))).toBe("linux:987654")
    expect(parseLinuxStat(fields("Z"))).toBeNull()
    expect(parseLinuxStat("garbage")).toBeNull()
  })

  it("takes the start date out of ps, and a zombie is no process", () => {
    expect(parsePsLine("Ss   Thu Sep 24 17:54:52 2026    \n")).toBe("ps:Thu_Sep_24_17:54:52_2026")
    expect(parsePsLine("Z    Thu Sep 24 17:54:52 2026")).toBeNull()
    expect(parsePsLine("")).toBeNull()
  })

  it.skipIf(process.platform === "win32")(
    "on this machine: a live process has a stable identity, a finished one has none",
    async () => {
      const identity = identityReader()
      expect(identity).not.toBeNull()
      const read = identity as (pid: number) => string | null
      const child = Bun.spawn(["sleep", "30"])
      const first = read(child.pid)
      expect(first).not.toBeNull()
      expect(read(child.pid)).toBe(first)
      child.kill("SIGKILL")
      await child.exited
      expect(read(child.pid)).toBeNull()
    },
  )
})
