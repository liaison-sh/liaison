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
//   SANDBOX_POOL_SIZE        workerd processes for top-level and nested runs (6)
//   SANDBOX_POOL_RESERVED    of those, kept for nested runs (2)
//   SANDBOX_POOL_RESERVED_INTERACTIVE  of the top-level rest, kept for
//                            interactive runs (tool calls, attention computes,
//                            summarizers, page reads): background runs (jobs,
//                            events, syncs) may hold at most POOL_SIZE -
//                            RESERVED - RESERVED_INTERACTIVE processes (2, so
//                            a pool of 6 runs 2 background runs at once and
//                            always has 2 for interactive ones; at least one
//                            process is left for background runs)
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
// Box sizes (worst case = processes x RSS cap; the measured charge is far below):
//   2 GB box (e.g. a 4 vCPU / 8 GB host sharing it): POOL_SIZE 6 (2 reserved)
//     + 2 overflow = 8 x 256 MiB = 2 GiB.
//   3 GB box (e.g. 4 vCPU / 16 GB): POOL_SIZE 10 (2 reserved) + 2 overflow
//     = 12 x 256 MiB = 3 GiB.

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

export function readSupervisorConfig(env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
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
    poolSize: int(env, "SANDBOX_POOL_SIZE", DEFAULTS.poolSize, 1),
    reserved: int(env, "SANDBOX_POOL_RESERVED", DEFAULTS.reserved),
    reservedInteractive: int(
      env,
      "SANDBOX_POOL_RESERVED_INTERACTIVE",
      DEFAULTS.reservedInteractive,
    ),
    overflow: int(env, "SANDBOX_POOL_OVERFLOW", DEFAULTS.overflow),
    spares: int(env, "SANDBOX_SPARES", DEFAULTS.spares),
    recycleRuns: int(env, "SANDBOX_RECYCLE_RUNS", DEFAULTS.recycleRuns, 1),
    idleMs: int(env, "SANDBOX_IDLE_MS", DEFAULTS.idleMs, 1),
    heapMb: int(env, "SANDBOX_HEAP_MB", DEFAULTS.heapMb, 16),
    rssCapMb: int(env, "SANDBOX_RSS_CAP_MB", DEFAULTS.rssCapMb, 32),
    pollMs: int(env, "SANDBOX_POLL_MS", DEFAULTS.pollMs, 5),
    killGraceMs: int(env, "SANDBOX_KILL_GRACE_MS", DEFAULTS.killGraceMs),
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
