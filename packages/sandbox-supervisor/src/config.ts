// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sandbox service's settings, from its environment. None is a secret:
// the service holds no key (the per-process keys it mints die with their
// processes) and every run brings its own token.
//
//   SANDBOX_BRIDGE_ORIGIN    the app's bridge listener (`http://host:port`), the
//                            only address a workerd process may reach. Required.
//   SANDBOX_BRIDGE_ADDRESS   host:port bridge calls are sent to, when it is not the
//                            origin's own (a proxy in front of the listener)
//   SANDBOX_HOST / _PORT     where the service listens (127.0.0.1:8790). In a
//                            container it listens on the sandbox network only.
//   SANDBOX_POOL_SIZE        workerd processes for top-level and nested runs
//                            (default: sized from the service's memory and
//                            CPUs, autoPoolSize below; 6 on a 2 GiB, 2 CPU box)
//   SANDBOX_POOL_RESERVED    of those, kept for nested runs (default: a third
//                            of the pool, 1 to 4, none under 3; 2 of 6)
//   SANDBOX_POOL_RESERVED_INTERACTIVE  of the top-level rest, kept for
//                            interactive runs (tool calls, attention computes,
//                            summarizers, page reads): background runs (jobs,
//                            events, syncs) may hold at most POOL_SIZE -
//                            RESERVED - RESERVED_INTERACTIVE processes
//                            (default: a third of the pool, at least 1; 2 of
//                            6, so a pool of 6 runs 2 background runs at once
//                            and always has 2 for interactive ones; at least
//                            one process is left for background runs)
//   SANDBOX_SERVICE_MEM_LIMIT / SANDBOX_SERVICE_CPUS  the service's memory
//                            (2g, 1536m, bytes) and CPUs (2, 1.5) the pool is
//                            sized from; the compose file passes its container
//                            limits. Unset: the cgroup's, else the host's.
//   SANDBOX_POOL_OVERFLOW    extra processes only nested runs may start when the
//                            pool is full, so a chain of depth 4 never waits (2)
//   SANDBOX_SPARES           blank processes kept started (1)
//   SANDBOX_RECYCLE_RUNS     runs a process serves before it is replaced (100)
//   SANDBOX_IDLE_MS          a process idle this long is stopped (120000)
//   SANDBOX_HEAP_MB          V8 heap of each process (--max-old-space-size, 128)
//   SANDBOX_RSS_CAP_MB       a process over this resident size is killed (256)
//   SANDBOX_POLL_MS          how often a running process's CPU and memory are read
//                            (20 on Linux, 100 elsewhere: no /proc there)
//   SANDBOX_KILL_GRACE_MS    past a run's deadline before its process is killed (1000)
//   WORKERD_BIN              the workerd binary (default: the pinned npm package's)
//   SANDBOX_ALLOW_OPEN_NETWORK=1  run although the service reaches more than the
//                            bridge port (no firewall step; network-check.ts)
//   SANDBOX_PROBE_APP_PORTS  app ports that must not answer (3000)
//   SANDBOX_PROBE_GATEWAY_PORTS  host ports that must not answer
//                            (22,80,443,2375,3000,5432,6379)
//   SANDBOX_PROCESS_UID_BASE / _COUNT  each workerd process runs as its own
//                            uid from this range (40000, 64), with a private
//                            directory, when the service runs as root on Linux
//                            (the compose file: root with SETUID, SETGID, KILL,
//                            CHOWN, DAC_OVERRIDE only). SANDBOX_PROCESS_UIDS=off
//                            turns it off (every process then shares one uid).
//
// Sizing: unless SANDBOX_POOL_SIZE says otherwise, the pool is sized from what
// the service may use: its memory limit (the cgroup's, else the host's) over
// the RSS cap is the worst case of processes (pool + overflow), and at most
// PROCS_PER_CPU processes per CPU (the cgroup's quota, else the host's CPUs);
// runs mostly wait on their bridge, so a CPU carries several. The reserves
// follow the size. Explicit settings always win. The compose file passes the
// container's own limits (SANDBOX_SERVICE_MEM_LIMIT, SANDBOX_SERVICE_CPUS: 2g, 1.5, ...),
// which then come first: under gVisor the cgroup files may be absent.
//   1 GiB, 1 CPU   pool 2 (no nested reserve: nested runs take the overflow;
//                  1 interactive, 1 background) + 2 overflow
//   2 GiB, 2 CPUs  pool 6 (2 nested, 2 interactive, 2 background) + 2 overflow
//   3 GiB, 3 CPUs  pool 10 (3, 3, 4) + 2
//   8 GiB, 4 CPUs  pool 16 (4, 5, 7) + 2

import { existsSync, readFileSync } from "node:fs"
import { availableParallelism, totalmem } from "node:os"
import {
  DEFAULT_APP_PORTS,
  DEFAULT_GATEWAY_PORTS,
  type NetworkCheckMode,
  networkCheckMode,
  parsePorts,
} from "./network-check"

/** Nested runs deeper than this are refused (a cross-app call chain). */
export const MAX_NESTING_DEPTH = 4

export interface SupervisorConfig {
  host: string
  port: number
  bridgeOrigin: string
  /** host:port the bridge calls go to (default: the origin's). */
  bridgeAddress?: string
  poolSize: number
  /** Processes kept for nested runs. */
  reserved: number
  /** Top-level processes kept for interactive runs (background runs may not hold them). */
  reservedInteractive: number
  overflow: number
  spares: number
  recycleRuns: number
  idleMs: number
  heapMb: number
  rssCapMb: number
  pollMs: number
  killGraceMs: number
  maxDepth: number
  workerdBin?: string
  /** Where process configs go (a fresh temp dir by default). */
  workDir?: string
  /** Off only in a probe that shows what a limit prevents. */
  killEnabled: boolean
  /** The firewall self-check (network-check.ts). */
  networkCheck: NetworkCheckMode
  probeAppPorts: number[]
  probeGatewayPorts: number[]
  /** One uid per workerd process, from this range; null: all share the service's uid. */
  processUids: { base: number; count: number } | null
  /** How the pool was sized (readSupervisorConfig); absent for a config built in code. */
  sizing?: PoolSizing
}

/** What the service may use, and where each figure came from. */
export interface ServiceLimits {
  memoryMb: number
  memorySource: "env" | "cgroup" | "host"
  cpus: number
  cpuSource: "env" | "cgroup" | "host"
}

/** `2g`, `1536m`, `512k` or bytes (compose's mem_limit forms) in MiB; null when unset or invalid. */
export function parseMemoryMb(raw: string | undefined): number | null {
  if (!raw) return null
  const m = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? "").toLowerCase()
  const bytes =
    n *
    (unit === "t"
      ? 1024 ** 4
      : unit === "g"
        ? 1024 ** 3
        : unit === "m"
          ? 1024 ** 2
          : unit === "k"
            ? 1024
            : 1)
  const mb = Math.floor(bytes / (1024 * 1024))
  return mb > 0 ? mb : null
}

/** The limits the environment states (the compose file passes the container's own). */
export function envServiceLimits(
  env: NodeJS.ProcessEnv,
  detected: () => ServiceLimits = detectServiceLimits,
): ServiceLimits {
  const memoryMb = parseMemoryMb(env.SANDBOX_SERVICE_MEM_LIMIT)
  if (env.SANDBOX_SERVICE_MEM_LIMIT && memoryMb === null) {
    throw new Error(
      "SANDBOX_SERVICE_MEM_LIMIT must be a size such as 2g, 1536m or a number of bytes",
    )
  }
  const cpus = env.SANDBOX_SERVICE_CPUS ? Number(env.SANDBOX_SERVICE_CPUS) : null
  if (cpus !== null && !(Number.isFinite(cpus) && cpus > 0)) {
    throw new Error("SANDBOX_SERVICE_CPUS must be a positive number such as 2 or 1.5")
  }
  const base = memoryMb !== null && cpus !== null ? null : detected()
  return {
    memoryMb: memoryMb ?? (base as ServiceLimits).memoryMb,
    memorySource: memoryMb !== null ? "env" : (base as ServiceLimits).memorySource,
    cpus: cpus ?? (base as ServiceLimits).cpus,
    cpuSource: cpus !== null ? "env" : (base as ServiceLimits).cpuSource,
  }
}

export interface PoolSizing extends ServiceLimits {
  /** Which of the pool settings came from the environment, the rest were derived. */
  fromEnv: Array<"poolSize" | "reserved" | "reservedInteractive">
}

/** Processes one CPU carries: runs mostly wait on their bridge. */
export const PROCS_PER_CPU = 4
/** The largest pool sized by itself (a bigger one is set explicitly). */
export const MAX_AUTO_POOL = 32

const UNLIMITED = 2 ** 60

function readNumber(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trim() : null
  } catch {
    return null
  }
}

/**
 * The service's memory and CPU limits: the cgroup's (v2, else v1), else the
 * host's. Under gVisor the sandbox's own view (/proc/meminfo, the CPUs it
 * shows) is already the container's limit, which the host fallback reads.
 */
export function detectServiceLimits(
  read: (path: string) => string | null = readNumber,
  host: { memoryBytes: number; cpus: number } = {
    memoryBytes: totalmem(),
    cpus: availableParallelism(),
  },
): ServiceLimits {
  let memoryBytes: number | null = null
  const v2mem = read("/sys/fs/cgroup/memory.max")
  if (v2mem && v2mem !== "max" && Number(v2mem) > 0) memoryBytes = Number(v2mem)
  if (memoryBytes === null) {
    const v1mem = Number(read("/sys/fs/cgroup/memory/memory.limit_in_bytes") ?? Number.NaN)
    if (Number.isFinite(v1mem) && v1mem > 0 && v1mem < UNLIMITED) memoryBytes = v1mem
  }
  let cpus: number | null = null
  const v2cpu = read("/sys/fs/cgroup/cpu.max")
  if (v2cpu) {
    const [quota, period] = v2cpu.split(/\s+/)
    if (quota !== "max" && Number(quota) > 0 && Number(period) > 0) {
      cpus = Number(quota) / Number(period)
    }
  }
  if (cpus === null) {
    const quota = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") ?? Number.NaN)
    const period = Number(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us") ?? Number.NaN)
    if (quota > 0 && period > 0) cpus = quota / period
  }
  const hostMb = Math.floor(host.memoryBytes / (1024 * 1024))
  const cgroupMb = memoryBytes === null ? null : Math.floor(memoryBytes / (1024 * 1024))
  return {
    // A cgroup limit above the host's memory is no limit.
    memoryMb: cgroupMb !== null && cgroupMb < hostMb ? cgroupMb : hostMb,
    memorySource: cgroupMb !== null && cgroupMb < hostMb ? "cgroup" : "host",
    cpus: cpus !== null && cpus < host.cpus ? cpus : host.cpus,
    cpuSource: cpus !== null && cpus < host.cpus ? "cgroup" : "host",
  }
}

/**
 * The pool a service of these limits runs: as many processes as its memory
 * holds at the RSS cap, less the overflow, and at most PROCS_PER_CPU a CPU;
 * at least 2, at most MAX_AUTO_POOL.
 */
export function autoPoolSize(limits: ServiceLimits, rssCapMb: number, overflow: number): number {
  const byMemory = Math.floor(limits.memoryMb / rssCapMb) - overflow
  const byCpu = Math.floor(limits.cpus * PROCS_PER_CPU)
  return Math.max(2, Math.min(MAX_AUTO_POOL, byMemory, byCpu))
}

/**
 * The reserves of a pool of this size: a third each (nested at most 4), at
 * least 1; a pool under 3 keeps none for nested runs (they take the overflow),
 * so its interactive reserve is real.
 */
export function autoReserves(poolSize: number): { reserved: number; reservedInteractive: number } {
  const third = Math.floor(poolSize / 3)
  return {
    reserved: poolSize < 3 ? 0 : Math.min(4, Math.max(1, third)),
    reservedInteractive: Math.max(1, third),
  }
}

export const DEFAULTS: Omit<SupervisorConfig, "bridgeOrigin"> = {
  host: "127.0.0.1",
  port: 8790,
  poolSize: 6,
  reserved: 2,
  reservedInteractive: 2,
  overflow: 2,
  spares: 1,
  recycleRuns: 100,
  idleMs: 120_000,
  heapMb: 128,
  rssCapMb: 256,
  pollMs: process.platform === "linux" ? 20 : 100,
  killGraceMs: 1_000,
  maxDepth: MAX_NESTING_DEPTH,
  killEnabled: true,
  networkCheck: "off",
  probeAppPorts: DEFAULT_APP_PORTS,
  probeGatewayPorts: DEFAULT_GATEWAY_PORTS,
  processUids: null,
}

/**
 * One uid per process when the service may switch to it: root on Linux (the
 * compose file), unless SANDBOX_PROCESS_UIDS=off. The range must hold every
 * process the pool may run at once.
 */
export function readProcessUids(
  env: NodeJS.ProcessEnv,
  maxProcs: number,
  isRoot: boolean = process.platform === "linux" && process.getuid?.() === 0,
): SupervisorConfig["processUids"] {
  if (env.SANDBOX_PROCESS_UIDS === "off" || !isRoot) return null
  const base = int(env, "SANDBOX_PROCESS_UID_BASE", 40_000, 1_000)
  const count = int(env, "SANDBOX_PROCESS_UID_COUNT", 64, 1)
  if (count < maxProcs) {
    throw new Error(
      `SANDBOX_PROCESS_UID_COUNT (${count}) must cover every process the pool may run at once (${maxProcs})`,
    )
  }
  return { base, count }
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 0): number {
  const raw = env[key]
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) throw new Error(`${key} must be an integer >= ${min}`)
  return n
}

const isSet = (env: NodeJS.ProcessEnv, key: string) => env[key] !== undefined && env[key] !== ""

export function readSupervisorConfig(
  env: NodeJS.ProcessEnv = process.env,
  detected: () => ServiceLimits = detectServiceLimits,
): SupervisorConfig {
  const bridgeOrigin = env.SANDBOX_BRIDGE_ORIGIN ?? ""
  let origin: URL
  try {
    origin = new URL(bridgeOrigin)
  } catch {
    throw new Error("SANDBOX_BRIDGE_ORIGIN must be the app's bridge listener, http://host:port")
  }
  if (
    origin.protocol !== "http:" ||
    (bridgeOrigin !== origin.origin && bridgeOrigin !== `${origin.origin}/`)
  ) {
    throw new Error("SANDBOX_BRIDGE_ORIGIN must be a plain http origin (http://host:port)")
  }
  const cfg: SupervisorConfig = {
    ...DEFAULTS,
    host: env.SANDBOX_HOST || DEFAULTS.host,
    port: int(env, "SANDBOX_PORT", DEFAULTS.port, 0),
    bridgeOrigin: origin.origin,
    overflow: int(env, "SANDBOX_POOL_OVERFLOW", DEFAULTS.overflow),
    spares: int(env, "SANDBOX_SPARES", DEFAULTS.spares),
    recycleRuns: int(env, "SANDBOX_RECYCLE_RUNS", DEFAULTS.recycleRuns, 1),
    idleMs: int(env, "SANDBOX_IDLE_MS", DEFAULTS.idleMs, 1),
    heapMb: int(env, "SANDBOX_HEAP_MB", DEFAULTS.heapMb, 16),
    rssCapMb: int(env, "SANDBOX_RSS_CAP_MB", DEFAULTS.rssCapMb, 32),
    pollMs: int(env, "SANDBOX_POLL_MS", DEFAULTS.pollMs, 5),
    killGraceMs: int(env, "SANDBOX_KILL_GRACE_MS", DEFAULTS.killGraceMs),
    // Sized below.
    poolSize: DEFAULTS.poolSize,
    reserved: DEFAULTS.reserved,
    reservedInteractive: DEFAULTS.reservedInteractive,
    networkCheck: networkCheckMode(env),
    probeAppPorts: parsePorts(
      env.SANDBOX_PROBE_APP_PORTS,
      DEFAULT_APP_PORTS,
      "SANDBOX_PROBE_APP_PORTS",
    ),
    probeGatewayPorts: parsePorts(
      env.SANDBOX_PROBE_GATEWAY_PORTS,
      DEFAULT_GATEWAY_PORTS,
      "SANDBOX_PROBE_GATEWAY_PORTS",
    ),
  }
  const fromEnv: PoolSizing["fromEnv"] = []
  const service = envServiceLimits(env, detected)
  if (isSet(env, "SANDBOX_POOL_SIZE")) {
    cfg.poolSize = int(env, "SANDBOX_POOL_SIZE", DEFAULTS.poolSize, 1)
    fromEnv.push("poolSize")
  } else {
    cfg.poolSize = autoPoolSize(service, cfg.rssCapMb, cfg.overflow)
  }
  const auto = autoReserves(cfg.poolSize)
  if (isSet(env, "SANDBOX_POOL_RESERVED")) {
    cfg.reserved = int(env, "SANDBOX_POOL_RESERVED", DEFAULTS.reserved)
    fromEnv.push("reserved")
  } else {
    cfg.reserved = Math.min(auto.reserved, cfg.poolSize - 1)
  }
  if (isSet(env, "SANDBOX_POOL_RESERVED_INTERACTIVE")) {
    cfg.reservedInteractive = int(
      env,
      "SANDBOX_POOL_RESERVED_INTERACTIVE",
      DEFAULTS.reservedInteractive,
    )
    fromEnv.push("reservedInteractive")
  } else {
    cfg.reservedInteractive = auto.reservedInteractive
  }
  cfg.sizing = { ...service, fromEnv }
  cfg.processUids = readProcessUids(env, cfg.poolSize + cfg.overflow)
  if (env.WORKERD_BIN) cfg.workerdBin = env.WORKERD_BIN
  if (env.SANDBOX_BRIDGE_ADDRESS) {
    if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(env.SANDBOX_BRIDGE_ADDRESS)) {
      throw new Error("SANDBOX_BRIDGE_ADDRESS must be host:port")
    }
    cfg.bridgeAddress = env.SANDBOX_BRIDGE_ADDRESS
  }
  if (cfg.reserved >= cfg.poolSize) {
    throw new Error("SANDBOX_POOL_RESERVED must leave at least one process for top-level runs")
  }
  return cfg
}

/** How many processes each kind of top-level run may hold at once (pool.ts). */
export interface LaneCaps {
  /** Interactive top-level runs: every process but the nested reserve. */
  interactive: number
  /** Background top-level runs: that, less the interactive reserve (at least 1). */
  background: number
}

/**
 * The lane caps of a pool. A reserve too large for a small pool shrinks: a
 * top-level run always has one process, and so does a background one.
 */
export function laneCaps(
  cfg: Pick<SupervisorConfig, "poolSize" | "reserved" | "reservedInteractive">,
): LaneCaps {
  const interactive = Math.max(1, cfg.poolSize - cfg.reserved)
  const background = Math.max(1, interactive - cfg.reservedInteractive)
  return { interactive, background }
}
