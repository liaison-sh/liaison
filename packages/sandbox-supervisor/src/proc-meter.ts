// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A workerd process's CPU time and resident memory, read by the supervisor
// while a run is on it. workerd meters neither per run (its tail reports a
// CPU time of 0), so this is THE meter: the CPU limit is the process's
// user + system time since the run started, the memory limit its RSS.
//
// Linux reads /proc/<pid>/stat and /statm (cheap: polled every 20 ms). Other
// systems (a developer's Mac) ask `ps`, which costs a spawn per read.

import { readFileSync } from "node:fs"

export interface ProcSample {
  cpuMs: number
  rssMb: number
}

const CLK_TCK = 100
const PAGE = 4096

function linuxSample(pid: number): ProcSample {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  // Fields after the command name, which may hold spaces: utime is 14th, stime 15th.
  const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  const cpuMs = ((Number(f[11]) + Number(f[12])) * 1000) / CLK_TCK
  const statm = readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")
  return { cpuMs, rssMb: (Number(statm[1]) * PAGE) / 1024 / 1024 }
}

/** `ps` TIME: [[dd-]hh:]mm:ss[.cc] */
export function parsePsTime(s: string): number {
  const t = s.trim()
  let days = 0
  let rest = t
  const dash = t.indexOf("-")
  if (dash > 0) {
    days = Number(t.slice(0, dash))
    rest = t.slice(dash + 1)
  }
  const parts = rest.split(":").map(Number)
  let secs = 0
  for (const p of parts) secs = secs * 60 + p
  return Math.round((days * 86_400 + secs) * 1000)
}

async function psSample(pid: number): Promise<ProcSample> {
  const p = Bun.spawn(["ps", "-o", "time=,rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = (await new Response(p.stdout).text()).trim()
  await p.exited
  const [time, rss] = out.split(/\s+/)
  if (!time || !rss) throw new Error(`no such process ${pid}`)
  return { cpuMs: parsePsTime(time), rssMb: Number(rss) / 1024 }
}

export async function sampleProcess(pid: number): Promise<ProcSample> {
  return process.platform === "linux" ? linuxSample(pid) : psSample(pid)
}
