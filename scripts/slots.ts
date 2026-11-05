#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The machine-wide heavy-job slots (scripts/lib/machine-slots.ts).
//
//   bun run slots                       who holds each slot (pid, age, cwd,
//                                       command), who waits in what order, the
//                                       load, available memory, swap and the gates
//   bun run slots -- --json             the same, as JSON
//   bun scripts/slots.ts lease --pid <pid> --cmd <text> [--wait-sec <s>]
//                                       holds a slot FOR ANOTHER PROCESS until it
//                                       exits or `release` runs (a CI runner's
//                                       job-started hook leases one for the job;
//                                       the job's own steps then run inside it).
//                                       Exits 0 when held, 75 when the wait ran out.
//   bun scripts/slots.ts release --pid <pid>
//                                       gives back what `lease` took for <pid>
//
// Imports nothing outside scripts/lib/machine-slots.ts, so the two files can be
// copied out of a checkout and run on their own.

import os from "node:os"
import {
  acquireSlot,
  formatStatus,
  liveHolders,
  liveWaiters,
  maxLoad,
  maxSwapMb,
  minFreeMb,
  readMemory,
  realProbe,
  releaseHeldBy,
  slotCount,
  slotDir,
} from "./lib/machine-slots"

const args = process.argv.slice(2).filter((a) => a !== "--")
const verb = args[0] && !args[0].startsWith("--") ? args[0] : "status"

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}

function pidFlag(): number {
  const pid = Number(flag("pid"))
  if (!Number.isInteger(pid) || pid <= 1) {
    console.error(`slots ${verb}: --pid <pid> is required`)
    process.exit(2)
  }
  return pid
}

if (verb === "status") {
  if (args.includes("--json")) {
    const now = Date.now()
    console.log(
      JSON.stringify(
        {
          dir: slotDir(),
          slots: slotCount(),
          load: os.loadavg()[0],
          maxLoad: maxLoad(),
          memory: readMemory(),
          minFreeMb: minFreeMb(),
          maxSwapMb: maxSwapMb(),
          holders: liveHolders(process.env, realProbe).map((h) => ({ slot: h.slot, ...h.record })),
          waiters: liveWaiters(process.env, realProbe).map((w) => w.record),
          at: new Date(now).toISOString(),
        },
        null,
        2,
      ),
    )
  } else {
    console.log(formatStatus())
  }
} else if (verb === "lease") {
  const pid = pidFlag()
  const waitSec = flag("wait-sec")
  const env = waitSec !== undefined ? { ...process.env, TEST_LOCK_WAIT_SEC: waitSec } : process.env
  try {
    const lock = await acquireSlot({
      cmd: flag("cmd") ?? `lease for pid ${pid}`,
      env,
      pid,
      installExitHandlers: false,
    })
    console.log(
      lock.bypassed
        ? "slots lease: TEST_LOCK_SKIP=1, no slot taken"
        : `slots lease: slot ${lock.slot} held for pid ${pid} until it exits or \`slots release --pid ${pid}\``,
    )
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(75)
  }
} else if (verb === "release") {
  const pid = pidFlag()
  const n = releaseHeldBy(pid)
  console.log(`slots release: ${n} file(s) released for pid ${pid}`)
} else {
  console.error(
    "usage: bun run slots [--json] | lease --pid <pid> --cmd <text> [--wait-sec <s>] | release --pid <pid>",
  )
  process.exit(2)
}
