// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dev-server supervisor's ONE job is that no server outlives its harness.
// Both exits are covered here with a cheap marker child instead of a real Vite:
// a SIGTERM to the supervisor (what `ViteServer.kill()` sends), and the death
// pipe closing (what happens when the harness is SIGKILLed and never calls
// kill() at all). Before the `wait`-on-background-`cat` fix the first case left
// the child running: bash deferred the trap until the foreground `cat`
// returned, which it never did, so the supervisor was SIGKILLed 2 s later and
// the child was orphaned to pid 1.
import { afterEach, expect, it } from "bun:test"
import { viteSupervisorScript } from "./vite"

const MARKER = "liaison-vite-supervisor-test-child"

/** Pids of the marker children still alive (the marker is in their argv). */
function markerPids(): string[] {
  const out = Bun.spawnSync({ cmd: ["pgrep", "-f", MARKER] })
  return new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
}

async function waitForMarkerGone(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (markerPids().length === 0) return true
    await Bun.sleep(100)
  }
  return false
}

function spawnSupervisor() {
  // `sleep` stands in for the dev server: long-lived, cheap, and identifiable.
  return Bun.spawn({
    cmd: ["/bin/bash", "-c", viteSupervisorScript(`bash -c 'exec -a ${MARKER} sleep 600'`)],
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
}

afterEach(() => {
  // Never leave a marker child behind, whatever the assertions did.
  for (const pid of markerPids()) {
    try {
      process.kill(Number(pid), 9)
    } catch {
      /* already gone */
    }
  }
})

it("a SIGTERM to the supervisor kills the server child, not just the supervisor", async () => {
  const proc = spawnSupervisor()
  let started = false
  for (let i = 0; i < 50 && !started; i++) {
    started = markerPids().length > 0
    if (!started) await Bun.sleep(100)
  }
  expect(started).toBe(true)

  proc.kill("SIGTERM")
  // The supervisor's own cleanup must do this; 3 s covers its 0.5 s TERM/KILL
  // step with room, and is well under the 2 s after which kill() escalates to
  // SIGKILL in production (which would orphan the child if the trap never ran).
  expect(await waitForMarkerGone(3_000)).toBe(true)
  await proc.exited
})

it("closing the death pipe kills the server child even with no signal sent", async () => {
  const proc = spawnSupervisor()
  let started = false
  for (let i = 0; i < 50 && !started; i++) {
    started = markerPids().length > 0
    if (!started) await Bun.sleep(100)
  }
  expect(started).toBe(true)

  // What a SIGKILLed harness does: the write end goes away, nothing is signalled.
  proc.stdin.end()
  expect(await waitForMarkerGone(3_000)).toBe(true)
  await proc.exited
})
