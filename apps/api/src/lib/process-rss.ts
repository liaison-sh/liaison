// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A process's resident memory, read from the host. Imports nothing of the API
// (no configuration, no logger): the render service (modules/pdf-render) runs
// it with no secret in its environment.

import { readFileSync } from "node:fs"

/**
 * Resident set size of a live process in bytes, or null when it cannot be read
 * (the process is gone, or the platform offers no source).
 *
 * Sampled from the host, never self-reported: a worker stuck in a synchronous
 * QuickJS loop never yields its event loop, so it could not report on itself.
 * Linux reads VmRSS from /proc/<pid>/status, one procfs read and no child
 * process, which is what production (a Linux container) and the dev box run.
 * macOS has no procfs and asks `ps`, one short-lived child per sample, paid
 * only while a worker is busy.
 */
export async function readProcessRssBytes(pid: number): Promise<number | null> {
  try {
    if (process.platform === "linux") {
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))
      return match ? Number(match[1]) * 1024 : null
    }
    if (process.platform === "darwin") {
      const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      })
      const out = (await new Response(ps.stdout).text()).trim()
      await ps.exited
      const kb = Number(out)
      return out !== "" && Number.isFinite(kb) ? kb * 1024 : null
    }
  } catch {
    // The process exited between the check and the read.
  }
  return null
}
