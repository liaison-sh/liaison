// SPDX-License-Identifier: FSL-1.1-ALv2
// Runtime enforcement of the "always leave the reserve free" rule (8 GiB for a
// whole suite, 2 GiB for a single-file run, see mem-budget.ts).
//
// `mem-budget.ts` is the PLAN: it sizes every parallelism knob so one suite run
// fits in what the machine has. Nothing enforced the plan at runtime, and the
// OOM that killed this 16 GB Mac did not come from the plan being wrong. It
// came from memory the plan never saw: eight orphaned e2e API servers still
// serving, a second suite launched beside the first, a browser and a simulator
// open. The plan was respected and the machine still died.
//
// So this module samples the real machine while the run is in flight. Every
// 2 s it reads system available memory and the RSS sum of the runner's whole
// process tree. If available memory stays under the reserve, or the tree grows
// past its own budget, it says so loudly with numbers, kills the tree and makes
// the runner exit non-zero. A run that cannot fit stops as a failed run with an
// explanation, instead of as an OOM killer log line nobody reads.
//
// The decision is pure (`decideMemGuard`) and every parser is pure, so the
// thresholds and the hysteresis are pinned by unit tests at exact numbers. Only
// the sampling and the killing touch the machine.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const KIB = 1024
const MIB = 1024 * KIB

/** Poll interval. Fast enough to beat the OOM killer, cheap enough to ignore. */
export const DEFAULT_POLL_MS = 2_000
/**
 * Withheld from the trip threshold so the guard does not fire while available
 * memory merely grazes the reserve. The run trips at reserve minus this.
 */
export const HYSTERESIS_BYTES = 512 * MIB
/** Consecutive low samples required before the guard acts. */
export const LOW_SAMPLES_TO_TRIP = 2
/** Exit code the runner uses when the guard stopped the run. */
export const MEM_GUARD_EXIT_CODE = 99
/** File written next to the suite logs when the guard trips. */
export const TRIP_FILE_NAME = "memory-guard-tripped.json"

// ── Pure decision ──────────────────────────────────────────────────────

export interface MemSample {
  /** System available memory, bytes. */
  availableBytes: number
  /** RSS summed over the runner's whole process tree, bytes. */
  treeRssBytes: number
  /** macOS only: the kernel's memory pressure level (kern.memorystatus_vm_pressure_level,
   *  1 normal, 2 warn, 4 critical). Absent where it cannot be read. */
  pressureLevel?: number
}

/** macOS pressure level at or above which low available memory counts (2 = warn). */
export const DARWIN_PRESSURE_WARN = 2

export interface MemGuardThresholds {
  /** The reserve the run promised to leave free, bytes. */
  reserveBytes: number
  /** Subtracted from the reserve before comparing. */
  hysteresisBytes: number
  /** Ceiling for the tree's own RSS, bytes. Zero or less disables the check. */
  budgetBytes: number
  /** Consecutive low-available samples required to trip. */
  lowSamplesToTrip: number
}

export type TripReason = "available" | "tree-rss"

export interface MemGuardDecision {
  trip: boolean
  reason: TripReason | null
  /** Consecutive low-available samples including this one. */
  lowStreak: number
  /** The available-memory floor actually compared against, bytes. */
  floorBytes: number
}

/**
 * Decides what one sample means. Stateless: the caller carries `lowStreak`
 * forward, so a test can drive any sequence of samples by hand.
 *
 * A tree over its budget trips on the FIRST sample: that is the run's own
 * accounting being wrong, it will not recover by waiting. A low available
 * reading needs `lowSamplesToTrip` in a row, because a single dip can be one
 * compile, one page cache flush or one unrelated process exiting a moment later.
 */
export function decideMemGuard(
  sample: MemSample,
  thresholds: MemGuardThresholds,
  lowStreakBefore = 0,
): MemGuardDecision {
  const floorBytes = Math.max(0, thresholds.reserveBytes - thresholds.hysteresisBytes)
  // On macOS a reading under the reserve counts only while the kernel itself reports
  // pressure: on a 16 GB Mac shared by several sessions, available memory sits under
  // an 8 GiB reserve at normal pressure, and the guard killed runs of a few hundred MB.
  const kernelCalm =
    sample.pressureLevel !== undefined && sample.pressureLevel < DARWIN_PRESSURE_WARN
  const low = sample.availableBytes < floorBytes && !kernelCalm
  const lowStreak = low ? lowStreakBefore + 1 : 0

  if (thresholds.budgetBytes > 0 && sample.treeRssBytes > thresholds.budgetBytes) {
    return { trip: true, reason: "tree-rss", lowStreak, floorBytes }
  }
  if (low && lowStreak >= Math.max(1, thresholds.lowSamplesToTrip)) {
    return { trip: true, reason: "available", lowStreak, floorBytes }
  }
  return { trip: false, reason: null, lowStreak, floorBytes }
}

// ── Pure parsers ───────────────────────────────────────────────────────

/** Linux: MemAvailable from /proc/meminfo, in bytes. Null when absent. */
export function parseMemAvailable(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)
  if (!match) return null
  return Number(match[1]) * KIB
}

export interface VmStat {
  pageSizeBytes: number
  freePages: number
  inactivePages: number
  speculativePages: number
  purgeablePages: number
  /**
   * Free plus inactive plus speculative plus purgeable, in bytes: the pool a
   * new allocation can draw on without paging anything out. `Pages free`
   * already excludes speculative pages (read-ahead the kernel drops first),
   * and purgeable pages are volatile caches apps marked as discardable, so all
   * four are reclaimable on demand. Counting only free plus inactive left the
   * guard reading about half of what Activity Monitor calls available and
   * killing a 0.7 GB run on a 16 GiB Mac that reported 36 % free.
   */
  availableBytes: number
}

/** macOS: `vm_stat` output. Null when the shape is not what we expect. */
export function parseVmStat(text: string): VmStat | null {
  const pageSize = /page size of (\d+) bytes/.exec(text)
  if (!pageSize) return null
  const pages = (label: string): number => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?$`, "m").exec(text)
    return m ? Number(m[1]) : 0
  }
  const pageSizeBytes = Number(pageSize[1])
  const freePages = pages("free")
  const inactivePages = pages("inactive")
  const speculativePages = pages("speculative")
  const purgeablePages = pages("purgeable")
  return {
    pageSizeBytes,
    freePages,
    inactivePages,
    speculativePages,
    purgeablePages,
    availableBytes: (freePages + inactivePages + speculativePages + purgeablePages) * pageSizeBytes,
  }
}

export interface ProcRow {
  pid: number
  ppid: number
  rssBytes: number
  command: string
}

/**
 * Parses `ps -eo pid=,ppid=,rss=,args=`. The command is everything after the
 * three numbers, so spaces in it are kept verbatim rather than splitting the row.
 * `rss` is KiB on both Linux and macOS.
 */
export function parsePsOutput(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * KIB,
      command: match[4].trim(),
    })
  }
  return rows
}

/**
 * The rows for `rootPid` and every descendant of it, parents before children.
 * Cycle safe (a ppid loop from pid reuse cannot make this spin) and it never
 * walks upward, so an ancestor of the runner is never in the returned set.
 */
export function collectTree(rows: ProcRow[], rootPid: number): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.ppid)
    if (siblings) siblings.push(row)
    else byParent.set(row.ppid, [row])
  }
  const root = rows.find((r) => r.pid === rootPid)
  const out: ProcRow[] = root ? [root] : []
  const seen = new Set<number>(root ? [root.pid] : [])
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift() as number
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      out.push(child)
      queue.push(child.pid)
    }
  }
  return out
}

export function sumRss(rows: ProcRow[]): number {
  return rows.reduce((total, row) => total + row.rssBytes, 0)
}

export function topProcesses(rows: ProcRow[], count = 5): ProcRow[] {
  return [...rows].sort((a, b) => b.rssBytes - a.rssBytes).slice(0, count)
}

const mb = (bytes: number): number => Math.round(bytes / MIB)

/** The one loud line, numbers included. No dash punctuation. */
export function formatTripLine(
  reason: TripReason,
  sample: MemSample,
  decision: MemGuardDecision,
  thresholds: MemGuardThresholds,
): string {
  if (reason === "tree-rss") {
    return (
      `MEMORY GUARD TRIPPED: the run's process tree is using ${mb(sample.treeRssBytes)} MB, ` +
      `over its budget of ${mb(thresholds.budgetBytes)} MB. Killing the tree.`
    )
  }
  return (
    `MEMORY GUARD TRIPPED: only ${mb(sample.availableBytes)} MB of memory is available, ` +
    `under the floor of ${mb(decision.floorBytes)} MB ` +
    `(reserve ${mb(thresholds.reserveBytes)} MB minus ${mb(thresholds.hysteresisBytes)} MB of hysteresis) ` +
    `for ${decision.lowStreak} samples in a row. The tree is using ${mb(sample.treeRssBytes)} MB. ` +
    `Killing the tree.`
  )
}

export function formatTopProcesses(rows: ProcRow[]): string[] {
  return topProcesses(rows).map(
    (row) =>
      `  pid ${row.pid} (parent ${row.ppid}) ${mb(row.rssBytes)} MB : ${row.command.slice(0, 120)}`,
  )
}

// ── Sampling the real machine ──────────────────────────────────────────

/** System available memory in bytes, or null when it cannot be read. */
export function readAvailableBytes(platform: string = process.platform): number | null {
  try {
    if (platform === "linux") {
      return parseMemAvailable(fs.readFileSync("/proc/meminfo", "utf8"))
    }
    if (platform === "darwin") {
      const out = Bun.spawnSync({ cmd: ["vm_stat"], stdout: "pipe", stderr: "pipe" })
      if (out.exitCode !== 0) return null
      return parseVmStat(new TextDecoder().decode(out.stdout))?.availableBytes ?? null
    }
  } catch {
    return null
  }
  // Unknown platform: os.freemem() understates on Linux and macOS but is the
  // only portable reading, and understating means the guard errs toward firing.
  const free = os.freemem()
  return Number.isFinite(free) && free > 0 ? free : null
}

/** macOS: the kernel's memory pressure level, or undefined elsewhere or when unreadable. */
export function readPressureLevel(platform: string = process.platform): number | undefined {
  if (platform !== "darwin") return undefined
  try {
    const out = Bun.spawnSync({
      cmd: ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (out.exitCode !== 0) return undefined
    const level = Number(new TextDecoder().decode(out.stdout).trim())
    return Number.isFinite(level) && level > 0 ? level : undefined
  } catch {
    return undefined
  }
}

export function readProcessTable(): ProcRow[] {
  try {
    const out = Bun.spawnSync({
      cmd: ["ps", "-eo", "pid=,ppid=,rss=,args="],
      stdout: "pipe",
      stderr: "pipe",
    })
    if (out.exitCode !== 0) return []
    return parsePsOutput(new TextDecoder().decode(out.stdout))
  } catch {
    return []
  }
}

// ── Killing the tree ───────────────────────────────────────────────────

export interface KillTreeOptions {
  /** Never signalled. Defaults to this process, which must live to report. */
  excludePid?: number
  /** Grace period between SIGTERM and SIGKILL. */
  graceMs?: number
  /** First-pass rows. Later passes always re-read, so a stale set cannot pin them. */
  rows?: ProcRow[]
  /** Re-scan passes after the first. Each one catches children born since. */
  passes?: number
  kill?: (pid: number, signal: number) => void
  sleep?: (ms: number) => Promise<void>
  readTable?: () => ProcRow[]
  log?: (message: string) => void
}

function defaultKill(pid: number, signal: number): void {
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone, or not ours */
  }
}

function aliveNow(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * SIGTERM every process in `rootPid`'s tree (children first so a parent cannot
 * respawn one), wait out the grace period, then SIGKILL whatever is left, then
 * RE-SCAN and do it again until nothing new appears.
 *
 * The re-scan is not belt and braces, it is the fix for a measured leak: one
 * snapshot was taken, and in the 5 s between it and the SIGKILL pass the
 * harnesses still running spawned seven more e2e API servers plus the next
 * suite's child. Those were never in the list, so they were never signalled,
 * survived the run they belonged to, and the next run inherited 6.4 GB of them.
 * A pid born after the snapshot is still inside the tree; only re-reading the
 * process table can see it.
 *
 * Returns every pid it signalled, across all passes.
 */
export async function killProcessTree(
  rootPid: number,
  options: KillTreeOptions = {},
): Promise<number[]> {
  const exclude = options.excludePid ?? process.pid
  const graceMs = options.graceMs ?? 5_000
  const kill = options.kill ?? defaultKill
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const readTable = options.readTable ?? readProcessTable
  const passes = Math.max(1, options.passes ?? 3)
  const signalled: number[] = []
  const seen = new Set<number>()

  for (let pass = 0; pass < passes; pass++) {
    const rows =
      pass === 0
        ? (options.rows ?? collectTree(readTable(), rootPid))
        : collectTree(readTable(), rootPid)
    // Deepest first: collectTree returns parents before children, so reversing it
    // signals leaves before the parents that could restart them. pid 1 and our own
    // pid are never candidates.
    const pids = rows
      .map((row) => row.pid)
      .filter((pid) => pid > 1 && pid !== exclude)
      .reverse()
    const fresh = pids.filter((pid) => !seen.has(pid))
    if (pass > 0 && fresh.length > 0) {
      options.log?.(
        `memory guard: ${fresh.length} process(es) appeared after the first sweep, killing those too`,
      )
    }
    for (const pid of pids) {
      if (!seen.has(pid)) {
        seen.add(pid)
        signalled.push(pid)
      }
      kill(pid, 15)
    }
    if (pids.length > 0) await sleep(graceMs)
    for (const pid of pids) {
      if (aliveNow(pid)) {
        options.log?.(`memory guard: pid ${pid} ignored SIGTERM, sending SIGKILL`)
        kill(pid, 9)
      }
    }
    // Nothing left and nothing new: the tree is gone, stop early.
    if (pids.length === 0) break
  }
  return signalled
}

/**
 * SIGKILL `rootPid` and every descendant, synchronously, deepest first.
 *
 * For an exit path, where there is no time to await a grace period. Killing only
 * the direct child is not enough and was measured: a runner that died mid
 * playwright suite killed its `bunx playwright test` child and left that child's
 * own test workers, and the API servers they had spawned, running for 15 minutes.
 * Returns the pids it signalled.
 */
export function killProcessTreeNow(
  rootPid: number,
  options: {
    excludePid?: number
    rows?: ProcRow[]
    kill?: (pid: number, signal: number) => void
  } = {},
): number[] {
  const exclude = options.excludePid ?? process.pid
  const kill = options.kill ?? defaultKill
  const rows = options.rows ?? collectTree(readProcessTable(), rootPid)
  const pids = rows
    .map((row) => row.pid)
    .filter((pid) => pid > 1 && pid !== exclude)
    .reverse()
  for (const pid of pids) kill(pid, 9)
  return pids
}

// ── The sampler ────────────────────────────────────────────────────────

export interface MemGuardOptions {
  /** Spendable budget for the tree, MiB, from computeMemBudget(). */
  budgetMb: number
  /** The reserve the run promised to leave free, MiB, from computeMemBudget(). */
  reserveMb: number
  /** Where `memory-guard-tripped.json` goes. Can be refined later via setLogDir. */
  logDir: string
  /** What the guard is protecting, for the report. */
  label: string
  rootPid?: number
  env?: NodeJS.ProcessEnv
  pollMs?: number
  log?: (message: string) => void
  exit?: (code: number) => void
  /**
   * Called synchronously at the very start of a trip, BEFORE any killing. The
   * runner uses it to stop starting new suites: the composite `full` loop sits
   * in `await child.exited`, so killing the tree resolves that await and the
   * loop cheerfully spawned the NEXT suite while the guard was still inside its
   * 5 s grace period. That child outlived the runner and kept writing to the
   * run log, which is what made a dead runner look like a 12 minute stall.
   */
  onTrip?: (reason: TripReason) => void
  readAvailable?: () => number | null
  /** macOS pressure level; default `readPressureLevel()` on the real machine only. */
  readPressure?: () => number | undefined
  readTable?: () => ProcRow[]
  killTree?: (rootPid: number) => Promise<number[]>
}

export interface MemGuardHandle {
  /** False when TEST_MEM_GUARD=0 made this a no-op handle. */
  armed: boolean
  /** Point the trip report at the per-run log directory once it exists. */
  setLogDir(dir: string): void
  stop(): void
}

export function memGuardPollMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TEST_MEM_GUARD_POLL_MS)
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : DEFAULT_POLL_MS
}

export function memGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TEST_MEM_GUARD !== "0"
}

/**
 * Starts the sampler. Call it right after the run lock is acquired, so every
 * moment the run holds the machine is covered.
 */
export function startMemGuard(options: MemGuardOptions): MemGuardHandle {
  const env = options.env ?? process.env
  const log = options.log ?? ((message: string) => console.error(message))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const rootPid = options.rootPid ?? process.pid
  const pollMs = options.pollMs ?? memGuardPollMs(env)
  let logDir = options.logDir

  if (!memGuardEnabled(env)) {
    log(
      "memory guard DISABLED by TEST_MEM_GUARD=0. Nothing will stop this run from taking the whole machine.",
    )
    return { armed: false, setLogDir: () => {}, stop: () => {} }
  }

  const thresholds: MemGuardThresholds = {
    reserveBytes: Math.max(0, Math.floor(options.reserveMb)) * MIB,
    hysteresisBytes: HYSTERESIS_BYTES,
    budgetBytes: Math.max(0, Math.floor(options.budgetMb)) * MIB,
    lowSamplesToTrip: LOW_SAMPLES_TO_TRIP,
  }
  const readAvailable = options.readAvailable ?? (() => readAvailableBytes())
  // An injected availability reader (tests) gets no real pressure reading beside it.
  const readPressure =
    options.readPressure ?? (options.readAvailable ? () => undefined : () => readPressureLevel())
  const readTable = options.readTable ?? readProcessTable
  const killTree = options.killTree ?? ((pid: number) => killProcessTree(pid, { log, readTable }))

  let lowStreak = 0
  let tripped = false
  let stopped = false

  async function trip(
    reason: TripReason,
    sample: MemSample,
    decision: MemGuardDecision,
    rows: ProcRow[],
  ): Promise<void> {
    tripped = true
    clearInterval(timer)
    try {
      options.onTrip?.(reason)
    } catch (err) {
      log(`memory guard: onTrip hook threw: ${err}`)
    }
    log("")
    log(formatTripLine(reason, sample, decision, thresholds))
    log(`memory guard: largest processes in the run's tree (root pid ${rootPid})`)
    for (const line of formatTopProcesses(rows)) log(line)

    const report = {
      trippedAt: new Date().toISOString(),
      reason,
      label: options.label,
      rootPid,
      pollMs,
      lowStreak: decision.lowStreak,
      availableMb: mb(sample.availableBytes),
      floorMb: mb(decision.floorBytes),
      reserveMb: mb(thresholds.reserveBytes),
      hysteresisMb: mb(thresholds.hysteresisBytes),
      treeRssMb: mb(sample.treeRssBytes),
      budgetMb: mb(thresholds.budgetBytes),
      treeSize: rows.length,
      top: topProcesses(rows).map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        rssMb: mb(row.rssBytes),
        command: row.command.slice(0, 400),
      })),
    }
    try {
      fs.mkdirSync(logDir, { recursive: true })
      fs.writeFileSync(path.join(logDir, TRIP_FILE_NAME), `${JSON.stringify(report, null, 2)}\n`)
      log(`memory guard: wrote ${path.join(logDir, TRIP_FILE_NAME)}`)
    } catch (err) {
      log(`memory guard: could not write the trip report: ${err}`)
    }

    const killed = await killTree(rootPid)
    log(`memory guard: signalled ${killed.length} processes (SIGTERM, then SIGKILL after 5 s)`)
    log(
      `Run stopped by the memory guard: the machine did not have the ${mb(thresholds.reserveBytes)} MB this run promised to leave free. Close what else is running, or raise TEST_MEM_RESERVE_MB, then run it again.`,
    )
    exit(MEM_GUARD_EXIT_CODE)
  }

  async function tick(): Promise<void> {
    if (tripped || stopped) return
    const availableBytes = readAvailable()
    const rows = collectTree(readTable(), rootPid)
    // No reading means no judgement: an unreadable /proc or a failed ps must
    // never be mistaken for a machine that is out of memory.
    if (availableBytes === null || rows.length === 0) return
    const pressureLevel = readPressure()
    const sample: MemSample = {
      availableBytes,
      treeRssBytes: sumRss(rows),
      ...(pressureLevel !== undefined ? { pressureLevel } : {}),
    }
    const decision = decideMemGuard(sample, thresholds, lowStreak)
    lowStreak = decision.lowStreak
    if (decision.trip && decision.reason) await trip(decision.reason, sample, decision, rows)
  }

  const timer = setInterval(() => {
    void tick()
  }, pollMs)
  // The guard must never be the reason the runner stays alive after the suite
  // finished.
  timer.unref?.()

  return {
    armed: true,
    setLogDir(dir: string) {
      logDir = dir
    },
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

/** One line for the startup banner, next to formatMemBudget's table. */
export function formatMemGuard(
  budgetMb: number,
  reserveMb: number,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!memGuardEnabled(env)) return "memory guard: DISABLED (TEST_MEM_GUARD=0)"
  const floorMb = Math.max(0, reserveMb - HYSTERESIS_BYTES / MIB)
  return (
    `memory guard: armed, polling every ${memGuardPollMs(env)} ms, ` +
    `trips under ${floorMb} MB available for ${LOW_SAMPLES_TO_TRIP} samples ` +
    `or over ${budgetMb} MB of tree RSS`
  )
}
