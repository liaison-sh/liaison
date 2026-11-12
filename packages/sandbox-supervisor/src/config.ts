// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sandbox service's settings, from its environment. None is a secret:
// the service holds no key (the per-process keys it mints die with their
// processes) and every run brings its own token.
//
//   SANDBOX_BRIDGE_ORIGIN    the app's bridge listener (`http://host:port`), the
//                            only address a workerd process may reach. Required.
//   SANDBOX_HOST / _PORT     where the service listens (127.0.0.1:8790). In a
//                            container it listens on the sandbox network only.
//   SANDBOX_POOL_SIZE        workerd processes for top-level and nested runs (6)
//   SANDBOX_POOL_RESERVED    of those, kept for nested runs (2)
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
//
// Box sizes (worst case = processes x RSS cap; the measured charge is far below):
//   2 GB box (e.g. a 4 vCPU / 8 GB host sharing it): POOL_SIZE 6 (2 reserved)
//     + 2 overflow = 8 x 256 MiB = 2 GiB.
//   3 GB box (e.g. 4 vCPU / 16 GB): POOL_SIZE 10 (2 reserved) + 2 overflow
//     = 12 x 256 MiB = 3 GiB.

/** Nested runs deeper than this are refused (a cross-app call chain). */
export const MAX_NESTING_DEPTH = 4

export interface SupervisorConfig {
  host: string
  port: number
  bridgeOrigin: string
  poolSize: number
  reserved: number
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
}

export const DEFAULTS: Omit<SupervisorConfig, "bridgeOrigin"> = {
  host: "127.0.0.1",
  port: 8790,
  poolSize: 6,
  reserved: 2,
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
  if (origin.protocol !== "http:" || origin.origin !== bridgeOrigin.replace(/\/+$/, "")) {
    throw new Error("SANDBOX_BRIDGE_ORIGIN must be a plain http origin (http://host:port)")
  }
  const cfg: SupervisorConfig = {
    ...DEFAULTS,
    host: env.SANDBOX_HOST || DEFAULTS.host,
    port: int(env, "SANDBOX_PORT", DEFAULTS.port, 0),
    bridgeOrigin: origin.origin,
    poolSize: int(env, "SANDBOX_POOL_SIZE", DEFAULTS.poolSize, 1),
    reserved: int(env, "SANDBOX_POOL_RESERVED", DEFAULTS.reserved),
    overflow: int(env, "SANDBOX_POOL_OVERFLOW", DEFAULTS.overflow),
    spares: int(env, "SANDBOX_SPARES", DEFAULTS.spares),
    recycleRuns: int(env, "SANDBOX_RECYCLE_RUNS", DEFAULTS.recycleRuns, 1),
    idleMs: int(env, "SANDBOX_IDLE_MS", DEFAULTS.idleMs, 1),
    heapMb: int(env, "SANDBOX_HEAP_MB", DEFAULTS.heapMb, 16),
    rssCapMb: int(env, "SANDBOX_RSS_CAP_MB", DEFAULTS.rssCapMb, 32),
    pollMs: int(env, "SANDBOX_POLL_MS", DEFAULTS.pollMs, 5),
    killGraceMs: int(env, "SANDBOX_KILL_GRACE_MS", DEFAULTS.killGraceMs),
  }
  if (env.WORKERD_BIN) cfg.workerdBin = env.WORKERD_BIN
  if (cfg.reserved >= cfg.poolSize) {
    throw new Error("SANDBOX_POOL_RESERVED must leave at least one process for top-level runs")
  }
  return cfg
}
