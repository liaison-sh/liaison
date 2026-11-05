// SPDX-License-Identifier: FSL-1.1-ALv2
//
// These tests spawn REAL processes and orphan them for real, because the bug
// they guard is a process-lifecycle bug: eight e2e API servers left behind by an
// aborted run kept serving, kept respawning sandbox workers, and starved the
// suite that ran after them into 30s timeouts. Asserting that a source file
// mentions a watchdog would not have caught it; asserting that an orphaned
// process actually dies does.
//
// The FIRST version of these tests only ever spawned a process that was already
// orphaned at birth (a shell backgrounded it and exited before Bun booted). That
// passed while the shipped watchdog was dead on arrival, because under Bun
// `process.ppid` is a startup snapshot: a process re-parented to init AFTER boot
// keeps reporting its original parent forever, and `process.ppid === 1` is then
// never true. `re-parented after boot` is the case that actually happens in a
// run, so it is now the case these tests drive.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { decideOrphaned, exitWhenOrphaned, isReaperProcess, readParentPid } from "~/lib/orphan-exit"

const LIB_DIR = import.meta.dir
const API_SRC = path.resolve(LIB_DIR, "..")
const REPO_ROOT = path.resolve(API_SRC, "../../..")
const ORPHAN_EXIT = path.join(LIB_DIR, "orphan-exit.ts")

// The control test deliberately leaves a process running with no watchdog, and
// cleaning up by pid alone was not enough: two `bun .../orphan-exit-*/child.ts`
// processes were found alive on the machine hours later. Three layers now stand
// between this file and a stray:
//   1. every pid it learns is killed in afterEach,
//   2. every temp dir it created is swept by command line, which also catches a
//      child whose pid file was never read and anything that child forked,
//   3. the child itself self destructs after CHILD_MAX_LIFETIME_MS, so even a
//      run aborted before afterEach (an OOM kill, a bail, a Ctrl C) leaves
//      nothing behind for longer than that.
// afterAll then asserts the machine is clean, because a cleanup nobody checks is
// how the first leak survived.
const CHILD_MAX_LIFETIME_MS = 60_000
/** The contract: an orphan is gone within this, however its harness died. */
const ORPHAN_DEADLINE_MS = 5_000

const tmpDirs: string[] = []
const strays: number[] = []
/** Every pid and dir this file ever created, never spliced: afterAll checks them. */
const everSpawned: number[] = []
const everDirs: string[] = []

function killPid(pid: number, signal: number): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

/**
 * Kills anything whose command line mentions `dir`. The temp dir name is unique
 * per spawn, so this can never reach another test's or another run's process,
 * and it does reach a child this file spawned but never identified.
 */
function sweepByCommandLine(dir: string): void {
  try {
    Bun.spawnSync({ cmd: ["pkill", "-9", "-f", dir], stdout: "ignore", stderr: "ignore" })
  } catch {
    /* pkill missing: the pid kill and the child self destruct still apply */
  }
}

function matchesCommandLine(dir: string): number[] {
  try {
    const out = Bun.spawnSync({ cmd: ["pgrep", "-f", dir], stdout: "pipe", stderr: "pipe" })
    return new TextDecoder()
      .decode(out.stdout)
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    return []
  }
}

afterEach(() => {
  for (const pid of strays.splice(0)) killPid(pid, 9)
  for (const dir of tmpDirs.splice(0)) {
    sweepByCommandLine(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})

afterAll(async () => {
  // Belt and braces: anything still listed, plus anything matching a dir we
  // created, dies here before we assert.
  for (const pid of everSpawned) killPid(pid, 9)
  for (const dir of everDirs) {
    sweepByCommandLine(dir)
    rmSync(dir, { recursive: true, force: true })
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && everSpawned.some(alive)) await Bun.sleep(50)

  expect(everSpawned.filter(alive)).toEqual([])
  expect(everDirs.flatMap(matchesCommandLine)).toEqual([])
  expect(everDirs.filter((dir) => existsSync(dir))).toEqual([])
}, 30_000)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return !alive(pid)
}

async function readPidFile(file: string, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const pid = Number(readFileSync(file, "utf8").trim())
      if (pid > 0) {
        strays.push(pid)
        everSpawned.push(pid)
        return pid
      }
    } catch {
      /* not written yet */
    }
    await Bun.sleep(50)
  }
  throw new Error(`nothing reported a pid into ${file}`)
}

/** A child that stays alive forever, optionally with the watchdog installed. */
function writeChild(dir: string, withWatchdog: boolean, pidFile: string, intervalMs = 200): string {
  const child = path.join(dir, "child.ts")
  writeFileSync(
    child,
    [
      `import { writeFileSync } from "node:fs"`,
      withWatchdog ? `import { exitWhenOrphaned } from ${JSON.stringify(ORPHAN_EXIT)}` : "",
      withWatchdog ? `exitWhenOrphaned({ intervalMs: ${intervalMs} })` : "",
      // A non-unref'd timer stands in for the server that keeps a real orphan
      // alive indefinitely.
      `setInterval(() => {}, 1000)`,
      // Dead man's switch. "Indefinitely" is only true for the length of the
      // test: an aborted run used to leave this process alive for hours.
      `setTimeout(() => process.exit(17), ${CHILD_MAX_LIFETIME_MS})`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
    ]
      .filter(Boolean)
      .join("\n"),
  )
  return child
}

/**
 * The real shape of the bug: a live harness spawns the child, and the harness is
 * then SIGKILLed, which re-parents the child AFTER it booted. `stdinMode` picks
 * which layer is under test: "pipe" is the death pipe a harness hands its
 * server, "ignore" leaves only the parent pid poll.
 * Returns the harness pid and the child pid.
 */
async function spawnHarnessThenKillIt(
  withWatchdog: boolean,
  stdinMode: "pipe" | "ignore",
  intervalMs = 200,
): Promise<{ harnessPid: number; childPid: number }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orphan-exit-"))
  tmpDirs.push(dir)
  everDirs.push(dir)
  const childPidFile = path.join(dir, "child-pid")
  const child = writeChild(dir, withWatchdog, childPidFile, intervalMs)
  const harness = path.join(dir, "harness.ts")
  writeFileSync(
    harness,
    [
      `Bun.spawn({`,
      `  cmd: ["bun", ${JSON.stringify(child)}],`,
      `  stdin: ${JSON.stringify(stdinMode)},`,
      `  stdout: "ignore",`,
      `  stderr: "ignore",`,
      `})`,
      `await Bun.sleep(${CHILD_MAX_LIFETIME_MS})`,
    ].join("\n"),
  )
  const proc = Bun.spawn({ cmd: ["bun", harness], stdout: "ignore", stderr: "ignore" })
  strays.push(proc.pid)
  everSpawned.push(proc.pid)
  const childPid = await readPidFile(childPidFile)
  // The watchdog must see a live parent first, or the test proves nothing.
  expect(alive(proc.pid)).toBe(true)
  killPid(proc.pid, 9)
  return { harnessPid: proc.pid, childPid }
}

/**
 * Spawn a process that is orphaned from birth: a shell backgrounds it and exits,
 * so the OS re-parents it to init (ppid 1) before Bun boots. Kept as a second
 * shape, not the main one: it is the only case the broken watchdog handled.
 */
async function spawnOrphanAtBirth(withWatchdog: boolean): Promise<number> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orphan-exit-"))
  tmpDirs.push(dir)
  everDirs.push(dir)
  const pidFile = path.join(dir, "pid")
  const child = writeChild(dir, withWatchdog, pidFile)
  const sh = Bun.spawn(["sh", "-c", `bun ${JSON.stringify(child)} >/dev/null 2>&1 &`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  await sh.exited
  return await readPidFile(pidFile)
}

describe("readParentPid", () => {
  it("reports the live parent pid, not a startup snapshot", () => {
    // On Linux this reads /proc and must agree with the kernel right now; where
    // /proc is absent it falls back to process.ppid, which is correct while the
    // parent is still alive (this test's own parent is).
    expect(readParentPid()).toBe(process.ppid)
    expect(readParentPid(process.pid)).toBe(process.ppid)
  })
})

describe("decideOrphaned", () => {
  const liveParent = () => true
  const deadParent = () => false

  it("calls init re-parenting an orphan", () => {
    expect(decideOrphaned(42, 1, liveParent)).toBe(true)
    expect(decideOrphaned(42, 0, liveParent)).toBe(true)
  })

  it("calls a CHANGED parent pid an orphan (re-parented to a subreaper, not pid 1)", () => {
    expect(decideOrphaned(42, 77, liveParent)).toBe(true)
  })

  it("calls a dead startup parent an orphan even when the reported ppid is stale", () => {
    // The macOS path: the ppid never updates, so liveness of the original
    // parent is the only signal.
    expect(decideOrphaned(42, 42, deadParent)).toBe(true)
  })

  it("is false while the original parent is alive", () => {
    expect(decideOrphaned(42, 42, liveParent)).toBe(false)
  })

  it("calls a reaper parent an orphan even when it was the parent from birth", () => {
    // Orphaned before it booted: on WSL the reaper is the distro's /init relay,
    // never pid 1, and it neither changes nor dies.
    const reaper = (pid: number) => pid === 930
    expect(decideOrphaned(930, 930, liveParent, reaper)).toBe(true)
    expect(decideOrphaned(42, 42, liveParent, reaper)).toBe(false)
  })
})

describe("isReaperProcess", () => {
  it("is false for an ordinary process: this test's own", () => {
    expect(isReaperProcess(process.pid)).toBe(false)
  })

  it("is false for a pid that names no process", () => {
    expect(isReaperProcess(2 ** 22 + 7)).toBe(false)
  })
})

describe("exitWhenOrphaned", () => {
  it("returns a stop() that clears the timer", () => {
    let exited = false
    const stop = exitWhenOrphaned({ intervalMs: 60_000, exit: () => (exited = true) })
    expect(typeof stop).toBe("function")
    stop()
    expect(exited).toBe(false)
  })

  // The poll interval is set far beyond the deadline, so ONLY the pipe can kill
  // this one: Bun's `stdin: "pipe"` is a socketpair and not a FIFO, and gating
  // the watch on isFIFO() alone silently left the poll doing all the work.
  it("kills a child re-parented when its harness is SIGKILLed, via the death pipe alone", async () => {
    const { childPid } = await spawnHarnessThenKillIt(true, "pipe", 600_000)
    expect(await waitForExit(childPid, ORPHAN_DEADLINE_MS)).toBe(true)
  }, 40_000)

  it("kills a child re-parented when its harness is SIGKILLed, with no pipe at all", async () => {
    const { childPid } = await spawnHarnessThenKillIt(true, "ignore")
    expect(await waitForExit(childPid, ORPHAN_DEADLINE_MS)).toBe(true)
  }, 40_000)

  it("control: without the watchdog the same re-parented child runs on forever", async () => {
    const { childPid } = await spawnHarnessThenKillIt(false, "pipe")
    await Bun.sleep(2_000)
    expect(alive(childPid)).toBe(true)
  }, 40_000)

  it("kills a process that was already orphaned at birth", async () => {
    const pid = await spawnOrphanAtBirth(true)
    expect(await waitForExit(pid, ORPHAN_DEADLINE_MS)).toBe(true)
  }, 40_000)
})

// Wiring pins. The mechanism above is useless unwired, and every process that
// needs it was spawned by code that did not call it - which is how the leak
// shipped in the first place.
describe("orphan-exit wiring", () => {
  it("the e2e API server entrypoint installs the watchdog", () => {
    const src = readFileSync(path.join(API_SRC, "../test-support/index.e2e.ts"), "utf8")
    expect(src).toContain("exitWhenParentDies()")
  })

  it("the e2e worker env opts its spawned server in and gives it a death pipe", () => {
    const src = readFileSync(
      path.join(REPO_ROOT, "packages/test-helpers/src/worker-env.ts"),
      "utf8",
    )
    expect(src).toContain('LIAISON_EXIT_WHEN_ORPHANED: "1"')
    expect(src).toContain('stdin: "pipe"')
  })

  it("the sandbox worker installs it unconditionally and is spawned with a death pipe", () => {
    const src = readFileSync(path.join(API_SRC, "modules/apps/sandbox/sandbox-worker.ts"), "utf8")
    expect(src).toContain("exitWhenOrphaned()")
    const pool = readFileSync(path.join(API_SRC, "modules/apps/sandbox/worker-pool.ts"), "utf8")
    expect(pool).toContain('stdin: "pipe"')
  })

  it("orphan-exit.ts imports node builtins only (the sandbox worker has no host env)", () => {
    const src = readFileSync(ORPHAN_EXIT, "utf8")
    const sources = [...src.matchAll(/^\s*import .*from "([^"]+)"/gm)].map((m) => m[1])
    expect(sources.filter((source) => !source.startsWith("node:"))).toEqual([])
  })
})
