// SPDX-License-Identifier: FSL-1.1-ALv2
// The machine-wide heavy-job semaphore: LIAISON_TEST_SLOTS slots (default 2)
// shared by every test run, typecheck, docs check, Playwright run and app build
// on one machine, whichever checkout, session or CI runner starts it.
//
// History: test runs alone took a slot. Typechecks, builds and CI jobs ran
// beside them unrationed, and several sessions plus a CI runner on one machine
// drove its load far past its core count until it had to be restarted. So:
//
//   - one semaphore for every heavy job, not only test runs;
//   - FIFO: waiters are served in arrival order (a ticket file each), so a run
//     that started waiting first is not overtaken by one polling at a luckier
//     moment;
//   - a load gate at ACQUIRE only: a new job waits while the 1-minute load
//     average is at or above LIAISON_SLOT_MAX_LOAD (default 1.5x the cores on
//     macOS). A job that holds its slot is never paused or revoked, whatever
//     the load does after;
//   - anti-starvation: the load on a shared machine is mostly NOT this
//     semaphore's jobs (other projects' compilers, a VM, indexing), so a gate
//     at the core count kept free slots idle while eight waiters aged past
//     20 minutes. A waiter at the head of the queue that has waited
//     LIAISON_SLOT_STARVE_SEC (default 600) takes a FREE slot over the load
//     gate. Memory still holds it: the load cannot kill a run, memory can;
//   - two lanes: the heavy lane (LIAISON_TEST_SLOTS, default 2: suites, full
//     typechecks, builds, Playwright) and a light lane (LIAISON_LIGHT_SLOTS,
//     default 2: tsgo, Biome and other jobs of a minute or less), each with its
//     own slots and its own FIFO queue, so a 40-second tsgo check never waits
//     behind two hour-long suites. The light lane has the memory gate but no
//     load gate;
//   - a memory gate, also at ACQUIRE only: a new job waits while available
//     memory is below LIAISON_SLOT_MIN_FREE_MB or swap in use is above
//     LIAISON_SLOT_MAX_SWAP_MB. The load average does not see memory: a CI
//     step was SIGKILLed (exit 137) under memory pressure on a 16 GB Mac
//     whose load was fine;
//   - each record carries its pid AND that process's start time, so a pid the
//     system reused after the holder died (or after a reboot) reads as free;
//   - a slot leased to an ANCESTOR process covers its descendants: a CI job
//     whose runner leased a slot for the whole job runs its steps inside it.
//
// This file uses node builtins only: scripts/slots.ts and this file can be
// copied out of a checkout (a CI runner's job hook does) and still run.
//
// Files, all in slotDir() (TEST_SLOT_DIR, default <tmpdir>/liaison-test-slots):
//   slot-<i>.lock             a held heavy slot, i in [0, slots)
//   ticket-<ms>-<pid>.wait    a heavy waiter, in arrival order
//   light-<i>.lock            a held light slot
//   light-ticket-<ms>-<pid>.wait  a light waiter
// The old exclusive lock (<tmpdir>/liaison-test.lock) is read, never written:
// a live holder there counts as one occupied slot.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export interface LockRecord {
  pid: number
  startedAt: string
  cmd: string
  ns?: string
  /** The holder process's start time, as ProcessProbe.startTime reported it. */
  procStart?: string
  cwd?: string
}

/** How the semaphore sees processes. Injected in tests. */
export interface ProcessProbe {
  isAlive(pid: number): boolean
  /** An opaque start-time stamp for a running pid, or null when unknown. */
  startTime(pid: number): string | null
  /** The pids above this process, parent first. */
  ancestors(): number[]
}

export interface AcquireOptions {
  /** Identifies the holder in the lock file, the status and the waiting log lines. */
  cmd: string
  /** Which lane to queue in; "heavy" when omitted. */
  lane?: Lane
  /** The run namespace, recorded so a waiter can say who holds it. */
  ns?: string
  env?: NodeJS.ProcessEnv
  pollMs?: number
  logEveryMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
  /** Liveness only. Kept for callers that predate `probe`; `probe` wins. */
  isAlive?: (pid: number) => boolean
  probe?: Partial<ProcessProbe>
  /** The 1-minute load average. */
  loadAvg?: () => number
  /** CPU idle share (0..100) since the previous call; undefined until a first interval exists. */
  cpuIdle?: () => number | undefined
  /** Available memory and swap in use, or null when unreadable. Called once per poll. */
  memory?: () => MemorySample | null
  platform?: NodeJS.Platform
  /** The pid the slot is held for (a lease names another process). */
  pid?: number
  /** false: no exit/signal handlers (tests, and leases held for another pid). */
  installExitHandlers?: boolean
}

export interface TestLock {
  /** Absolute path of the slot file, or null when bypassed or inherited. */
  path: string | null
  /** The slot index held, or -1 when bypassed. */
  slot: number
  slots: number
  /** True when TEST_LOCK_SKIP made this a no-op handle. */
  bypassed: boolean
  /** True when an ancestor process holds the slot this process runs in. */
  inherited: boolean
  release(): void
}

export const DEFAULT_POLL_MS = 2_000
export const DEFAULT_LOG_EVERY_MS = 60_000
export const DEFAULT_WAIT_SEC = 3600
export const DEFAULT_SLOTS = 2
export const DEFAULT_LIGHT_SLOTS = 2
/** The macOS load gate, per core. */
export const DARWIN_LOAD_PER_CORE = 1.5
/** A head-of-queue waiter older than this takes a free slot over the load gate. */
export const DEFAULT_STARVE_SEC = 600

/**
 * heavy: test suites and files, full typechecks, builds, Playwright.
 * light: tsgo, Biome and other jobs of about a minute that need no database.
 */
export type Lane = "heavy" | "light"
export const LANES: readonly Lane[] = ["heavy", "light"]

/** The file name prefixes of a lane's slots and tickets. */
export function laneFiles(lane: Lane): { slot: string; ticket: string } {
  return lane === "light"
    ? { slot: "light-", ticket: "light-ticket-" }
    : { slot: "slot-", ticket: "ticket-" }
}
/** A load at or above this idle share is I/O wait (indexing, disk), not CPU work: it does not hold a job back. */
export const DEFAULT_MIN_IDLE_PCT = 25

export function slotDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_SLOT_DIR || path.join(os.tmpdir(), "liaison-test-slots")
}

/** The old machine-wide exclusive lock. Read only: a live holder occupies one slot. */
export function legacyLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_LOCK_PATH || path.join(os.tmpdir(), "liaison-test.lock")
}

export function slotCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LIAISON_TEST_SLOTS)
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_SLOTS
}

/** The light lane's slots: LIAISON_LIGHT_SLOTS, default 2. */
export function lightSlotCount(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LIAISON_LIGHT_SLOTS)
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_LIGHT_SLOTS
}

export function laneSlotCount(lane: Lane, env: NodeJS.ProcessEnv = process.env): number {
  return lane === "light" ? lightSlotCount(env) : slotCount(env)
}

/**
 * How long (ms) a head-of-queue waiter waits on the load gate before it takes a
 * free slot anyway; 0 means never. LIAISON_SLOT_STARVE_SEC ("off" or 0: never).
 */
export function starveMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LIAISON_SLOT_STARVE_SEC
  if (raw === "off") return 0
  const n = Number(raw)
  return (
    (raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : DEFAULT_STARVE_SEC) *
    1000
  )
}

/**
 * Classifies a command for --slot-only: tsgo and Biome runs are light, anything
 * else (tsc, builds, tests) is heavy. A caller can always ask for the light lane
 * explicitly.
 */
export function isLightCommand(cmd: readonly string[]): boolean {
  return (
    cmd.some((token) => {
      const base = path.basename(token)
      return (
        base === "tsgo" || base === "biome" || token === "@biomejs/biome" || token === "--tool=tsgo"
      )
    }) || cmd.some((token, i) => token === "--tool" && cmd[i + 1] === "tsgo")
  )
}

/**
 * The load average at or above which a new job waits; 0 means no gate.
 *
 * Set: LIAISON_SLOT_MAX_LOAD (0 or "off" disables it). Unset: 1.5x the core count on macOS,
 * off elsewhere. The load is the whole machine's, and on a shared Mac most of it is other
 * work (another project's compiler, a VM, indexing) that a waiting job neither caused nor can
 * wait out: at 1x the cores, free slots sat idle for hours. Memory, not load, is what kills a
 * run, and the memory gate guards that on its own. A developer Mac is where sessions, CI runners and the owner's own
 * work share one machine. On Linux the usual hosts are CI and containers, where
 * the load average is the whole host's (a container sees its neighbours' load)
 * and counts tasks blocked on I/O: a fixed threshold there would stall a run on
 * load it neither caused nor can wait out. A Linux workstation opts in by
 * setting the variable.
 */
export function maxLoad(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  cores: number = os.cpus().length,
): number {
  const raw = env.LIAISON_SLOT_MAX_LOAD
  if (raw !== undefined && raw !== "") {
    if (raw === "off") return 0
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return platform === "darwin" ? Math.max(1, Math.round(cores * DARWIN_LOAD_PER_CORE)) : 0
}

/**
 * The CPU idle share at or above which a load over the gate does not hold a job back:
 * macOS counts tasks waiting on the disk in the load average, so an indexing burst can
 * push it past the core count while the CPUs sit idle. LIAISON_SLOT_MIN_IDLE (percent);
 * "off" means the load alone decides.
 */
export function minIdlePct(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LIAISON_SLOT_MIN_IDLE
  if (raw === "off") return null
  const n = Number(raw)
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 && n <= 100
    ? n
    : DEFAULT_MIN_IDLE_PCT
}

/** Idle share of all CPUs between two calls, from the kernel's per-core tick counters. */
export function cpuIdleSampler(): () => number | undefined {
  let prev: { idle: number; total: number } | null = null
  return () => {
    let idle = 0
    let total = 0
    for (const c of os.cpus()) {
      idle += c.times.idle
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
    }
    const last = prev
    prev = { idle, total }
    if (last === null || total <= last.total) return undefined
    return ((idle - last.idle) / (total - last.total)) * 100
  }
}

// ---------------------------------------------------------------------------
// Memory gate

export interface MemorySample {
  /** Memory a new job can get without the system paging: free plus reclaimable caches. */
  availableMb: number
  /** Swap in use. */
  swapUsedMb: number
  /** macOS only: the kernel's memory pressure level (kern.memorystatus_vm_pressure_level,
   *  1 normal, 2 warn, 4 critical), the signal jetsam acts on. */
  pressureLevel?: number
}

/**
 * 1 GB on macOS, a backstop only: the live gate there is the kernel's pressure
 * level (`DARWIN_PRESSURE_WARN`). Free plus cached-file pages leave out the
 * inactive pages macOS reclaims by compressing, so on a busy 16 GB Mac they sit
 * near 2.5 GB at normal pressure with most of the memory reclaimable; a 3 GB
 * floor there held every job back for hours while the kernel reported normal.
 */
export const DEFAULT_MIN_FREE_MB_DARWIN = 1024
/**
 * A new job waits at this kernel pressure level or above (2 = warn, 4 = critical).
 * The kernel raises warn when it can no longer hand out memory without heavy
 * compression or swapping, ahead of the critical level at which jetsam kills
 * processes (a CI step died with SIGKILL, exit 137, under such pressure).
 */
export const DARWIN_PRESSURE_WARN = 2
/**
 * 4 GB. macOS swap stays allocated long after the pressure that caused it has
 * passed (pages come back only when touched): the machine sat at 4.8 GB of swap
 * with most of its memory free and every job held for hours. So on macOS swap
 * counts only while the kernel reports warn or critical pressure; stale swap
 * under normal pressure holds nothing.
 */
export const DEFAULT_MAX_SWAP_MB_DARWIN = 4096

function mbSetting(raw: string | undefined, fallback: number): number {
  if (raw !== undefined && raw !== "") {
    if (raw === "off") return 0
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return fallback
}

/**
 * The available memory (MB) below which a new job waits; 0 means no gate.
 * LIAISON_SLOT_MIN_FREE_MB ("off" or 0 disables it). Unset: 1024 on macOS, off
 * elsewhere (CI and container hosts, where the host's memory is not the job's).
 */
export function minFreeMb(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  return mbSetting(
    env.LIAISON_SLOT_MIN_FREE_MB,
    platform === "darwin" ? DEFAULT_MIN_FREE_MB_DARWIN : 0,
  )
}

/**
 * The swap in use (MB) above which a new job waits; 0 means no gate.
 * LIAISON_SLOT_MAX_SWAP_MB ("off" or 0 disables it). Unset: 4096 on macOS, off elsewhere.
 */
export function maxSwapMb(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): number {
  return mbSetting(
    env.LIAISON_SLOT_MAX_SWAP_MB,
    platform === "darwin" ? DEFAULT_MAX_SWAP_MB_DARWIN : 0,
  )
}

const MB = 1024 * 1024

/** Parses `sysctl -n hw.pagesize vm.page_free_count vm.page_speculative_count vm.page_pageable_external_count vm.page_purgeable_count vm.swapusage kern.memorystatus_vm_pressure_level`. */
export function parseDarwinSysctl(out: string): MemorySample | null {
  const lines = out.trim().split("\n")
  const [pageSize, free, speculative, external, purgeable] = lines.slice(0, 5).map(Number)
  const swap = /used = ([\d.]+)([KMG])/.exec(lines[5] ?? "")
  if (![pageSize, free, speculative, external, purgeable].every((n) => Number.isFinite(n)) || !swap)
    return null
  const unit = { K: 1 / 1024, M: 1, G: 1024 }[swap[2] as "K" | "M" | "G"]
  const pressure = Number(lines[6])
  return {
    availableMb:
      (((free ?? 0) + (speculative ?? 0) + (external ?? 0) + (purgeable ?? 0)) * (pageSize ?? 0)) /
      MB,
    swapUsedMb: Number(swap[1]) * unit,
    ...(lines[6] !== undefined && Number.isFinite(pressure) ? { pressureLevel: pressure } : {}),
  }
}

/** Parses /proc/meminfo: MemAvailable, and SwapTotal - SwapFree. */
export function parseMeminfo(text: string): MemorySample | null {
  const kb = (key: string) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)
    return m ? Number(m[1]) : null
  }
  const avail = kb("MemAvailable")
  if (avail === null) return null
  return {
    availableMb: avail / 1024,
    swapUsedMb: ((kb("SwapTotal") ?? 0) - (kb("SwapFree") ?? 0)) / 1024,
  }
}

/**
 * Reads available memory and swap once.
 *
 * macOS: one `sysctl` call (about 2 ms) for the kernel's pressure level, free +
 * speculative + file-backed (pageable external) + purgeable pages, and
 * vm.swapusage. The pressure level is the live gate: it is what the kernel itself
 * acts on. The page sum (Activity Monitor's free plus cached files, pages handed
 * out without compressing anything) is only a low backstop, since it leaves out
 * the inactive pages macOS reclaims by compressing. `memory_pressure`'s
 * percentage is not used: it counts compressible memory and read 65% free during
 * the pressure of a SIGKILL. No node builtin reads these (os.freemem() is the free
 * list only), so one subprocess per poll is the cheapest read.
 * Linux: /proc/meminfo MemAvailable, the kernel's own estimate. Elsewhere: os.freemem(), no swap.
 */
export function readMemory(platform: NodeJS.Platform = process.platform): MemorySample | null {
  try {
    if (platform === "darwin") {
      const out = execFileSync(
        "sysctl",
        [
          "-n",
          "hw.pagesize",
          "vm.page_free_count",
          "vm.page_speculative_count",
          "vm.page_pageable_external_count",
          "vm.page_purgeable_count",
          "vm.swapusage",
          "kern.memorystatus_vm_pressure_level",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      )
      return parseDarwinSysctl(out)
    }
    if (platform === "linux") return parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8"))
    return { availableMb: os.freemem() / MB, swapUsedMb: 0 }
  } catch {
    return null
  }
}

/** A memory reader that reads at most once per `ttlMs`: one read per poll, shared with the status line. */
export function memorySampler(
  read: () => MemorySample | null = () => readMemory(),
  ttlMs = 1_000,
  now: () => number = () => Date.now(),
): () => MemorySample | null {
  let at = Number.NEGATIVE_INFINITY
  let last: MemorySample | null = null
  return () => {
    const t = now()
    if (t - at >= ttlMs) {
      last = read()
      at = t
    }
    return last
  }
}

/** Why memory holds a new job back, or null when it does not. */
export function memoryHold(
  sample: MemorySample | null,
  minFree: number,
  maxSwap: number,
): string | null {
  if (sample === null) return null
  const avail = Math.round(sample.availableMb)
  const swap = Math.round(sample.swapUsedMb)
  if (sample.pressureLevel !== undefined && sample.pressureLevel >= DARWIN_PRESSURE_WARN)
    return `macOS memory pressure is ${sample.pressureLevel >= 4 ? "critical" : "warn"} (available memory ${avail} MB, swap used ${swap} MB)`
  if (minFree > 0 && sample.availableMb < minFree)
    return `available memory ${avail} MB is below LIAISON_SLOT_MIN_FREE_MB ${minFree} (swap used ${swap} MB)`
  // Under normal kernel pressure (macOS), swap in use is a past spike, not a reason to wait.
  const calm = sample.pressureLevel !== undefined && sample.pressureLevel < DARWIN_PRESSURE_WARN
  if (maxSwap > 0 && sample.swapUsedMb > maxSwap && !calm)
    return `swap used ${swap} MB is above LIAISON_SLOT_MAX_SWAP_MB ${maxSwap} (available memory ${avail} MB)`
  return null
}

function memoryGateText(env: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  const minFree = minFreeMb(env, platform)
  const maxSwap = maxSwapMb(env, platform)
  if (minFree <= 0 && maxSwap <= 0) return "no memory gate"
  const parts: string[] = []
  if (minFree > 0) parts.push(`available < ${minFree} MB`)
  if ((platform ?? process.platform) === "darwin") parts.push("kernel pressure warn or critical")
  if (maxSwap > 0)
    parts.push(
      (platform ?? process.platform) === "darwin"
        ? `swap > ${maxSwap} MB under pressure`
        : `swap > ${maxSwap} MB`,
    )
  return `new jobs wait at ${parts.join(" or ")}`
}

// ---------------------------------------------------------------------------
// Admission

export interface GateInput {
  lane: Lane
  /** This waiter's place in its lane's queue, 0 first. */
  position: number
  /** Free slots in the lane right now. */
  freeSlots: number
  load: number
  /** The load gate, 0 for none. */
  maxLoad: number
  /** CPU idle share since the last poll, undefined until measured. */
  idlePct: number | undefined
  minIdlePct: number | null
  /** How long this waiter has waited. */
  waitedMs: number
  /** The anti-starvation age, 0 for never. */
  starveMs: number
  /** Why memory holds a job back (memoryHold), or null. */
  memHold: string | null
}

export interface GateDecision {
  /** May claim a free slot now. */
  admit: boolean
  /** Why not, when this waiter's turn has come but a gate holds it. Empty when it is not its turn. */
  reasons: string[]
  /** Admitted over the load gate by the anti-starvation rule. */
  starved: boolean
}

/**
 * The admission rule, pure. A waiter may claim when its turn has come (FIFO: one of the first
 * `freeSlots` in its lane's queue), memory is fine, and either the load is under the gate,
 * the CPUs are idle enough that the load is I/O wait, the lane is light, or the waiter has
 * starved past `starveMs`.
 */
export function gateDecision(g: GateInput): GateDecision {
  if (g.position >= g.freeSlots) return { admit: false, reasons: [], starved: false }
  const reasons: string[] = []
  if (g.memHold !== null) reasons.push(g.memHold)
  const idleOk = g.minIdlePct !== null && g.idlePct !== undefined && g.idlePct >= g.minIdlePct
  const overLoad = g.lane === "heavy" && g.maxLoad > 0 && g.load >= g.maxLoad && !idleOk
  const starved = overLoad && g.starveMs > 0 && g.waitedMs >= g.starveMs
  if (overLoad && !starved)
    reasons.push(
      `load ${g.load.toFixed(1)} is at or above LIAISON_SLOT_MAX_LOAD ${g.maxLoad} and the CPUs are busy (${g.idlePct === undefined ? "idle not measured yet" : `${g.idlePct.toFixed(0)}% idle`})${g.starveMs > 0 ? `; a free slot is taken anyway after ${Math.round(g.starveMs / 1000)}s of waiting` : ""}`,
    )
  return { admit: reasons.length === 0, reasons, starved: starved && reasons.length === 0 }
}

// ---------------------------------------------------------------------------
// Process probe

/** A process state from `ps -o stat=` or /proc/<pid>/stat is a zombie (Z) or dead (X). */
export function isDeadProcessState(state: string | null | undefined): boolean {
  const c = state?.trim()[0]
  return c === "Z" || c === "X"
}

function realProcessState(pid: number): string | null {
  if (process.platform === "linux") return procStatFields(pid)?.[0] ?? null
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

function realIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false
  }
  // A zombie still answers kill(pid, 0) until its parent reaps it, but it holds
  // nothing: a killed run whose parent never waited kept a slot for 40 minutes.
  return !isDeadProcessState(realProcessState(pid))
}

/** /proc/<pid>/stat fields after the command name (which may hold spaces). */
function procStatFields(pid: number): string[] | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")
  } catch {
    return null
  }
}

let bootId: string | undefined
function linuxBootId(): string {
  if (bootId === undefined) {
    try {
      bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    } catch {
      bootId = ""
    }
  }
  return bootId
}

function realStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (process.platform === "linux") {
    // Field 22 (starttime, clock ticks since boot); index 19 after the name.
    const f = procStatFields(pid)
    return f?.[19] ? `${linuxBootId()}:${f[19]}` : null
  }
  try {
    // An absolute wall-clock start ("Mon Nov  2 19:31:05 2026"): a pid reused
    // after a reboot or a recycle carries another one.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function realAncestors(): number[] {
  const parentOf = new Map<number, number>()
  if (process.platform === "linux") {
    const out: number[] = []
    let pid = process.ppid
    for (let i = 0; i < 64 && pid > 1; i++) {
      out.push(pid)
      const f = procStatFields(pid)
      pid = f ? Number(f[1]) : 0
    }
    return out
  }
  try {
    const table = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    for (const line of table.split("\n")) {
      const [p, pp] = line.trim().split(/\s+/).map(Number)
      if (p && pp !== undefined) parentOf.set(p, pp)
    }
  } catch {
    return [process.ppid]
  }
  const out: number[] = []
  let pid = process.ppid
  for (let i = 0; i < 64 && pid > 1; i++) {
    out.push(pid)
    pid = parentOf.get(pid) ?? 0
  }
  return out
}

export const realProbe: ProcessProbe = {
  isAlive: realIsAlive,
  startTime: realStartTime,
  ancestors: realAncestors,
}

/**
 * The probe for a call. A caller that injects only `isAlive` (older tests,
 * fake pids) gets no start-time or ancestry lookups against the real system.
 */
export function resolveProbe(opts: Pick<AcquireOptions, "isAlive" | "probe">): ProcessProbe {
  const injected = opts.probe?.isAlive ?? opts.isAlive
  if (injected) {
    return {
      isAlive: injected,
      startTime: opts.probe?.startTime ?? (() => null),
      ancestors: opts.probe?.ancestors ?? (() => []),
    }
  }
  return { ...realProbe, ...opts.probe }
}

/** A record's holder is alive: its pid runs, and it is the same process that wrote it. */
export function holderAlive(r: LockRecord, probe: ProcessProbe): boolean {
  if (!probe.isAlive(r.pid)) return false
  if (!r.procStart) return true
  const now = probe.startTime(r.pid)
  return now === null || now === r.procStart
}

// ---------------------------------------------------------------------------
// Files

export function readRecord(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LockRecord>
    if (typeof parsed.pid !== "number") return null
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
      cmd: typeof parsed.cmd === "string" ? parsed.cmd : "",
      ...(typeof parsed.ns === "string" ? { ns: parsed.ns } : {}),
      ...(typeof parsed.procStart === "string" ? { procStart: parsed.procStart } : {}),
      ...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
    }
  } catch {
    return null
  }
}

/** Creates the file exclusively. Returns false when it already exists. */
export function tryCreate(file: string, record: LockRecord): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const fd = fs.openSync(file, "wx")
    try {
      fs.writeFileSync(fd, JSON.stringify(record))
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false
    throw err
  }
}

/**
 * One claim attempt on an exclusive file. Returns null on success, else the
 * live holder. A dead (or unreadable) holder's file is removed and retried once.
 */
export function claimOnce(
  file: string,
  record: LockRecord,
  probe: ProcessProbe,
  log: (m: string) => void,
): LockRecord | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryCreate(file, record)) return null
    const held = readRecord(file)
    if (held && holderAlive(held, probe)) return held
    log(
      `machine slots: replacing a stale ${path.basename(file)} held by ${held ? `pid ${held.pid}` : "an unreadable record"}`,
    )
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* another waiter got there first */
    }
  }
  return readRecord(file) ?? { pid: -1, startedAt: "", cmd: "unknown" }
}

/** Removes `file` once, only while it still carries `pid`'s record. */
export function releaser(file: string, pid: number, install: boolean): () => void {
  let released = false
  const release = () => {
    if (released) return
    released = true
    const held = readRecord(file)
    // Only our own record: a stale-takeover race must not delete the record of
    // whoever legitimately owns it now.
    if (held && held.pid !== pid) return
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* best effort */
    }
  }
  if (install) {
    process.on("exit", release)
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        release()
        process.exit(signal === "SIGINT" ? 130 : 143)
      })
    }
  }
  return release
}

export function describeHolder(r: LockRecord): string {
  const ns = r.ns ? ` ns=${r.ns}` : ""
  return `pid ${r.pid}${ns} (${r.cmd || "unknown"}) since ${r.startedAt || "?"}`
}

// ---------------------------------------------------------------------------
// State

export interface SlotHolder {
  slot: number
  file: string
  record: LockRecord
}

/** Live slot holders of a lane. Dead holders' files are left for the next claimer to replace. */
export function liveHolders(
  env: NodeJS.ProcessEnv = process.env,
  probe: ProcessProbe = realProbe,
  lane: Lane = "heavy",
): SlotHolder[] {
  const slotRe = new RegExp(`^${laneFiles(lane).slot}(\\d+)\\.lock$`)
  const out: SlotHolder[] = []
  const dir = slotDir(env)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const m = slotRe.exec(name)
    if (!m) continue
    const file = path.join(dir, name)
    const record = readRecord(file)
    if (record && holderAlive(record, probe)) out.push({ slot: Number(m[1]), file, record })
  }
  return out.sort((a, b) => a.slot - b.slot)
}

export interface Waiter {
  file: string
  record: LockRecord
}

/** A lane's waiters in arrival order. A dead waiter's ticket is removed (except `keep`). */
export function liveWaiters(
  env: NodeJS.ProcessEnv = process.env,
  probe: ProcessProbe = realProbe,
  keep?: string,
  lane: Lane = "heavy",
): Waiter[] {
  const ticketRe = new RegExp(`^${laneFiles(lane).ticket}\\d+-\\d+\\.wait$`)
  const dir = slotDir(env)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: Waiter[] = []
  for (const name of names.filter((n) => ticketRe.test(n)).sort()) {
    const file = path.join(dir, name)
    const record = readRecord(file)
    if (file === keep || (record && holderAlive(record, probe))) {
      if (record) out.push({ file, record })
      continue
    }
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* best effort */
    }
  }
  return out
}

/** Who holds what right now: one line per live slot holder, plus the legacy lock. */
export function describeSlots(
  env: NodeJS.ProcessEnv = process.env,
  isAliveOrProbe: ((pid: number) => boolean) | ProcessProbe = realProbe,
): string[] {
  const probe =
    typeof isAliveOrProbe === "function"
      ? resolveProbe({ isAlive: isAliveOrProbe })
      : isAliveOrProbe
  const lines = LANES.flatMap((lane) =>
    liveHolders(env, probe, lane).map(
      (h) => `${lane === "light" ? "light slot" : "slot"} ${h.slot}: ${describeHolder(h.record)}`,
    ),
  )
  const legacy = readRecord(legacyLockPath(env))
  if (legacy && holderAlive(legacy, probe))
    lines.push(`legacy exclusive lock: ${describeHolder(legacy)}`)
  return lines
}

function age(startedAt: string, now: number): string {
  const t = Date.parse(startedAt)
  if (!Number.isFinite(t)) return "?"
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 120) return `${s}s`
  if (s < 7200) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

function line(r: LockRecord, now: number): string {
  return `pid ${r.pid}, ${age(r.startedAt, now)}, cwd ${r.cwd ?? "?"}, ${r.cmd || "unknown"}`
}

/** The `bun run slots` report: holders, waiters in order, load and the gate. */
export function formatStatus(
  opts: {
    env?: NodeJS.ProcessEnv
    probe?: ProcessProbe
    now?: number
    load?: number
    /** Defaults to a live read when a memory gate is on. */
    memory?: MemorySample | null
    platform?: NodeJS.Platform
  } = {},
): string {
  const env = opts.env ?? process.env
  const probe = opts.probe ?? realProbe
  const now = opts.now ?? Date.now()
  const load = opts.load ?? os.loadavg()[0] ?? 0
  const gate = maxLoad(env, opts.platform)
  const slots = slotCount(env)
  const holders = liveHolders(env, probe)
  const memory = opts.memory !== undefined ? opts.memory : readMemory(opts.platform)
  const memLine =
    memory === null
      ? "memory unreadable"
      : `available memory ${Math.round(memory.availableMb)} MB, swap used ${Math.round(memory.swapUsedMb)} MB${memory.pressureLevel === undefined ? "" : `, pressure ${memory.pressureLevel >= 4 ? "critical" : memory.pressureLevel >= DARWIN_PRESSURE_WARN ? "warn" : "normal"}`}`
  const starve = starveMs(env)
  const out: string[] = [
    `machine slots: ${holders.length}/${slots} held, load ${load.toFixed(1)} (${gate > 0 ? `new heavy jobs wait at ${gate}${starve > 0 ? `, or ${Math.round(starve / 1000)}s at most when a slot is free` : ""}` : "no load gate"}), ${slotDir(env)}`,
    `  memory: ${memLine} (${memoryGateText(env, opts.platform)})`,
  ]
  for (let i = 0; i < slots; i++) {
    const h = holders.find((x) => x.slot === i)
    out.push(`  slot ${i}: ${h ? line(h.record, now) : "free"}`)
  }
  for (const h of holders.filter((x) => x.slot >= slots))
    out.push(`  slot ${h.slot} (above LIAISON_TEST_SLOTS): ${line(h.record, now)}`)
  const legacy = readRecord(legacyLockPath(env))
  if (legacy && holderAlive(legacy, probe))
    out.push(`  legacy exclusive lock: ${line(legacy, now)}`)
  const waiters = liveWaiters(env, probe)
  out.push(waiters.length === 0 ? "  waiting: none" : `  waiting (served in this order):`)
  waiters.forEach((w, i) => {
    out.push(`    ${i + 1}. ${line(w.record, now)}`)
  })
  const lightSlots = lightSlotCount(env)
  const lightHolders = liveHolders(env, probe, "light")
  out.push(
    `light lane (tsgo, Biome; memory gate, no load gate): ${lightHolders.length}/${lightSlots} held`,
  )
  for (let i = 0; i < lightSlots; i++) {
    const h = lightHolders.find((x) => x.slot === i)
    out.push(`  light ${i}: ${h ? line(h.record, now) : "free"}`)
  }
  const lightWaiters = liveWaiters(env, probe, undefined, "light")
  out.push(lightWaiters.length === 0 ? "  waiting: none" : `  waiting (served in this order):`)
  lightWaiters.forEach((w, i) => {
    out.push(`    ${i + 1}. ${line(w.record, now)}`)
  })
  return out.join("\n")
}

// ---------------------------------------------------------------------------
// Acquire / release

function ticketName(ms: number, pid: number, lane: Lane): string {
  return `${laneFiles(lane).ticket}${String(ms).padStart(15, "0")}-${String(pid).padStart(10, "0")}.wait`
}

/**
 * Waits for a slot, then returns a handle that releases it on `release()` and
 * (unless installExitHandlers is false) on exit, SIGINT and SIGTERM.
 *
 * Throws when TEST_LOCK_WAIT_SEC elapses without a slot: a timeout is a real
 * condition worth reporting, not something to run through.
 */
export async function acquireSlot(opts: AcquireOptions): Promise<TestLock> {
  const env = opts.env ?? process.env
  const log = opts.log ?? ((m: string) => console.log(m))
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const probe = resolveProbe(opts)
  const loadAvg = opts.loadAvg ?? (() => os.loadavg()[0] ?? 0)
  const cpuIdle = opts.cpuIdle ?? cpuIdleSampler()
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const logEveryMs = opts.logEveryMs ?? DEFAULT_LOG_EVERY_MS
  const waitSecRaw = Number(env.TEST_LOCK_WAIT_SEC)
  const waitMs =
    (Number.isFinite(waitSecRaw) && waitSecRaw >= 0 && env.TEST_LOCK_WAIT_SEC !== ""
      ? waitSecRaw
      : DEFAULT_WAIT_SEC) * 1000
  const pid = opts.pid ?? process.pid
  const install = opts.installExitHandlers ?? true
  const lane: Lane = opts.lane ?? "heavy"
  const files = laneFiles(lane)
  const slots = laneSlotCount(lane, env)
  const starve = starveMs(env)
  const gate = maxLoad(env, opts.platform)
  const minIdle = minIdlePct(env)
  const minFree = minFreeMb(env, opts.platform)
  const maxSwap = maxSwapMb(env, opts.platform)
  const memGated = minFree > 0 || maxSwap > 0
  const memory = opts.memory ?? memorySampler(() => readMemory(opts.platform))
  let memUnreadableLogged = false
  cpuIdle()

  if (env.TEST_LOCK_SKIP === "1") {
    log("")
    log("!! TEST_LOCK_SKIP=1 : the machine wide slots are BYPASSED.")
    log("!! Each run sizes its workers from its share of RAM; running more jobs")
    log("!! than there are slots can exhaust RAM and overload the machine.")
    log("")
    return { path: null, slot: -1, slots, bypassed: true, inherited: false, release() {} }
  }

  // A slot leased to a process above us (a CI job's runner, a wrapper that
  // spawned us) already accounts for this work.
  if (opts.pid === undefined) {
    const above = new Set(probe.ancestors())
    if (above.size > 0) {
      // Either lane: a tsgo step inside a suite's tree is inside that suite's slot.
      const covering = LANES.flatMap((l) => liveHolders(env, probe, l)).find((h) =>
        above.has(h.record.pid),
      )
      if (covering) {
        return {
          path: null,
          slot: covering.slot,
          slots,
          bypassed: false,
          inherited: true,
          release() {},
        }
      }
    }
  }

  const dir = slotDir(env)
  fs.mkdirSync(dir, { recursive: true })
  const procStart = probe.startTime(pid)
  const record: LockRecord = {
    pid,
    startedAt: new Date(now()).toISOString(),
    cmd: opts.cmd,
    ...(opts.ns ? { ns: opts.ns } : {}),
    ...(procStart ? { procStart } : {}),
    cwd: process.cwd(),
  }

  // Take a ticket: our place in the queue.
  let ticket = ""
  for (let ms = now(); ; ms++) {
    ticket = path.join(dir, ticketName(ms, pid, lane))
    if (tryCreate(ticket, record)) break
  }
  const dropTicket = releaser(ticket, pid, false)
  const onExit = () => dropTicket()
  if (install) process.on("exit", onExit)

  const start = now()
  let lastLogged = start - logEveryMs
  try {
    for (;;) {
      const queue = liveWaiters(env, probe, ticket, lane)
      const position = Math.max(
        0,
        queue.findIndex((w) => w.file === ticket),
      )

      // A live holder of the old exclusive lock is a run this semaphore cannot
      // see the size of: count it as one slot. Never touch its file.
      const legacy = readRecord(legacyLockPath(env))
      const legacyHeld =
        lane === "heavy" && legacy !== null && legacy.pid !== pid && holderAlive(legacy, probe)
      const capacity = Math.max(1, slots - (legacyHeld ? 1 : 0))
      const held = new Set(liveHolders(env, probe, lane).map((h) => h.slot))
      const free: number[] = []
      for (let i = 0; i < capacity; i++) if (!held.has(i)) free.push(i)

      const load = loadAvg()
      const idle = cpuIdle()
      // Memory is read only when a gate is on, and once per poll.
      const sample = memGated && position < free.length ? memory() : null
      if (memGated && position < free.length && sample === null && !memUnreadableLogged) {
        memUnreadableLogged = true
        log(
          "machine slots: available memory is unreadable here; the memory gate does not hold this job",
        )
      }
      const memHold = memoryHold(sample, minFree, maxSwap)
      const waited = now() - start
      // FIFO: the first `free.length` waiters may claim; the rest wait their turn.
      const decision = gateDecision({
        lane,
        position,
        freeSlots: free.length,
        load,
        maxLoad: gate,
        idlePct: idle,
        minIdlePct: minIdle,
        waitedMs: waited,
        starveMs: starve,
        memHold,
      })
      if (decision.admit) {
        for (const i of free) {
          const file = path.join(dir, `${files.slot}${i}.lock`)
          if (claimOnce(file, record, probe, log) === null) {
            if (decision.starved)
              log(
                `machine slots: load ${load.toFixed(1)} is over the gate ${gate}, but this job waited ${Math.round(waited / 1000)}s with a slot free and memory fine: it takes ${lane === "light" ? "light " : ""}slot ${i}`,
              )
            dropTicket()
            if (install) process.off("exit", onExit)
            return {
              path: file,
              slot: i,
              slots,
              bypassed: false,
              inherited: false,
              release: releaser(file, pid, install),
            }
          }
        }
      }

      const holders = describeSlots(env, probe)
      const why =
        decision.reasons.length > 0
          ? decision.reasons.join("; ")
          : `${free.length === 0 ? `all ${slots} ${lane === "light" ? "light " : ""}slots held` : `${free.length} of ${slots} ${lane === "light" ? "light " : ""}slots free`}${position > 0 ? `, ${position} waiter(s) ahead` : ""}`
      if (waited >= waitMs) {
        throw new Error(
          `machine slots: no slot after ${Math.round(waited / 1000)}s (${why}). Held by:\n  ${holders.join("\n  ") || "nobody"}\nSee \`bun run slots\`. Wait, or set TEST_LOCK_SKIP=1 only if you are certain the holders are not running.`,
        )
      }
      if (now() - lastLogged >= logEveryMs) {
        lastLogged = now()
        log(
          `machine slots: waiting (${why}), ${Math.round(waited / 1000)}s so far. Held by:\n  ${holders.join("\n  ") || "nobody"}`,
        )
      }
      await sleep(pollMs)
    }
  } finally {
    // On success the ticket is already gone; on a throw it must go too.
    dropTicket()
    if (install) process.off("exit", onExit)
  }
}

/**
 * Runs a preflight step while holding `lock`; when it fails (throws, or
 * returns false), releases the slot AT ONCE so a run that cannot start (its
 * infrastructure is down) does not keep a slot others wait for.
 */
export async function releaseOnFailure<T>(
  lock: Pick<TestLock, "release">,
  step: () => T | Promise<T>,
): Promise<T> {
  let result: T
  try {
    result = await step()
  } catch (err) {
    lock.release()
    throw err
  }
  if (result === false) lock.release()
  return result
}

/** Removes every slot and ticket held for `pid` (a lease's end). Returns how many. */
export function releaseHeldBy(pid: number, env: NodeJS.ProcessEnv = process.env): number {
  const dir = slotDir(env)
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const name of names) {
    if (
      !/^(slot-\d+\.lock|ticket-\d+-\d+\.wait|light-\d+\.lock|light-ticket-\d+-\d+\.wait)$/.test(
        name,
      )
    )
      continue
    const file = path.join(dir, name)
    if (readRecord(file)?.pid !== pid) continue
    try {
      fs.rmSync(file, { force: true })
      n++
    } catch {
      /* best effort */
    }
  }
  return n
}
