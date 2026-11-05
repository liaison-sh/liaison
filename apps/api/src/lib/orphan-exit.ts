// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Orphan self-termination.
//
// Every long-lived process this repo spawns under a test harness (the e2e API
// server, the chaos api/worker, a sandbox worker) is torn down by its spawner
// on the happy path and by NOBODY otherwise. A harness killed without running
// teardown (a `timeout` SIGTERM, a crash, a `kill -9`, the memory guard killing
// the run's tree, an orchestrator that walks away) leaves the child re-parented
// to init, still serving, still running its job workers, still spawning
// children of its own. Those orphans accumulate across runs and starve whatever
// runs next: eight orphaned e2e API servers plus their sandbox pools were
// measured holding ~6 of 10 cores and 6.4 GB of RSS, which tripped the memory
// guard and killed the run that had just started.
//
// Two layers, because the first one was not enough:
//
//  1. The parent pipe. When the spawner gives us a pipe on fd 0 it holds the
//     only write end, so the kernel delivers EOF the instant that process dies,
//     by ANY means, SIGKILL included. No polling, no latency, no cooperation.
//  2. A poll of the REAL parent pid, as the portable fallback.
//
// Layer 2 used to be `process.ppid === 1` and that is exactly how this shipped
// broken: under Bun (1.3.11, Linux) `process.ppid` is a snapshot taken at
// startup and never updates, so a process re-parented to init after boot still
// reports its original parent forever. /proc/self/stat is live, and where /proc
// does not exist (macOS) the startup parent pid is probed for liveness instead,
// which catches the same death without needing a fresh ppid at all.
//
// This module imports node builtins ONLY, on purpose: the sandbox worker runs on
// a minimal env allowlist with no host secrets and would fatally fail `~/lib/env`
// parsing if it pulled the logger in, so it needs a dependency-free entry point.
// `parent-death-watchdog.ts` is the logger-aware wrapper for host processes.
import fs from "node:fs"

/**
 * The parent pid according to the kernel, read fresh on every call.
 *
 * `/proc/<pid>/stat` field 4 is the ppid, and the comm field (2) can itself
 * contain spaces and parentheses, so the scan starts after its LAST ")".
 * Falls back to `process.ppid` where /proc is absent (macOS), which is a
 * startup snapshot under Bun: `decideOrphaned` handles that by probing.
 */
export function readParentPid(pid: number | "self" = "self"): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const afterComm = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")
    const ppid = Number(afterComm[1])
    if (Number.isInteger(ppid) && ppid >= 0) return ppid
  } catch {
    /* no /proc, or the process is gone */
  }
  return process.ppid
}

/** True when `pid` still exists. EPERM counts as alive: it exists, not ours. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * The pure decision, so every branch is pinned by a unit test.
 *
 * Orphaned when the parent is init (re-parented: the real parent is gone),
 * when the parent pid CHANGED since startup (re-parented to a subreaper, which
 * is not pid 1 and so is invisible to a `=== 1` check), when the parent pid
 * we booted with no longer names a live process (the macOS path, where the
 * reported ppid is frozen at its startup value), or when the parent is a
 * reaper that is not pid 1 (`isReaper`). That last one is the process orphaned
 * BEFORE it booted: its startup parent is already the reaper, so the parent
 * never changes and never dies. On WSL every orphan goes to the distro's
 * `/init` relay, never to pid 1.
 */
export function decideOrphaned(
  startupParentPid: number,
  currentParentPid: number,
  alive: (pid: number) => boolean,
  isReaper: (pid: number) => boolean = () => false,
): boolean {
  if (currentParentPid <= 1) return true
  if (currentParentPid !== startupParentPid) return true
  if (isReaper(currentParentPid)) return true
  return !alive(currentParentPid)
}

/** Program names of the processes orphans are re-parented to. */
const REAPER_NAMES = new Set(["init", "systemd"])

/**
 * True when `pid` runs an init: `init`, WSL's `/init` relay, `systemd` (the
 * system one or a user manager acting as subreaper). Every process that calls
 * `exitWhenOrphaned` is spawned by a harness or by the API, never by one of
 * these, so having one as parent means the spawner is gone. Reads
 * /proc/<pid>/cmdline; false where /proc is absent.
 */
export function isReaperProcess(pid: number): boolean {
  try {
    const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? ""
    return REAPER_NAMES.has(argv0.slice(argv0.lastIndexOf("/") + 1))
  } catch {
    return false
  }
}

/** The parent pid this process booted with. Captured once, at import. */
export const STARTUP_PARENT_PID = readParentPid()

/** True when this process's parent is gone, however it went. */
export function isOrphaned(): boolean {
  return decideOrphaned(STARTUP_PARENT_PID, readParentPid(), processAlive, isReaperProcess)
}

export interface OrphanExitOptions {
  /** How often to check. Default 2s: cheap, and bounds orphan lifetime. */
  intervalMs?: number
  /** Called once just before exiting, for a log line. */
  onOrphaned?: (how: "pipe" | "ppid") => void
  /** Exit hook, overridable by tests. */
  exit?: (code: number) => void
}

/**
 * Exit the moment the pipe the spawner put on fd 0 reaches EOF, which happens
 * when the last process holding its write end dies. A no-op when fd 0 is not a
 * pipe (a tty, /dev/null, a file), so it costs nothing where it does not apply.
 *
 * @returns a stop() that detaches the watch.
 */
export function exitWhenParentPipeCloses(options: OrphanExitOptions = {}): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let isPipe = false
  try {
    const stat = fs.fstatSync(0)
    // Bun's `stdin: "pipe"` is a socketpair, not a FIFO, so testing isFIFO()
    // alone silently disabled this whole layer and left only the 2 s poll.
    isPipe = stat.isFIFO() || stat.isSocket()
  } catch {
    return () => {}
  }
  if (!isPipe) return () => {}

  let stopped = false
  const gone = (): void => {
    if (stopped) return
    stopped = true
    options.onOrphaned?.("pipe")
    exit(0)
  }
  const stdin = process.stdin as unknown as {
    on(event: string, fn: () => void): void
    resume(): void
    pause?(): void
    unref?(): void
    removeAllListeners?(event?: string): void
  }
  try {
    stdin.on("end", gone)
    stdin.on("close", gone)
    stdin.on("error", () => {})
    stdin.resume()
    // Never the reason the event loop stays alive: the server already is.
    stdin.unref?.()
  } catch {
    return () => {}
  }
  return () => {
    stopped = true
    try {
      stdin.pause?.()
      stdin.removeAllListeners?.("end")
      stdin.removeAllListeners?.("close")
    } catch {
      /* nothing to detach */
    }
  }
}

/**
 * Exit this process as soon as its parent disappears. Unconditional: call it
 * only from a process that is garbage the moment it is orphaned.
 *
 * @returns a stop() that clears the timer and detaches the pipe watch.
 */
export function exitWhenOrphaned(options: OrphanExitOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 2000
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const stopPipe = exitWhenParentPipeCloses(options)
  const timer = setInterval(() => {
    if (!isOrphaned()) return
    options.onOrphaned?.("ppid")
    exit(0)
  }, intervalMs)
  // Never the reason the event loop stays alive: the server already is.
  timer.unref?.()
  return () => {
    clearInterval(timer)
    stopPipe()
  }
}
