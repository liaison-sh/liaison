// SPDX-License-Identifier: FSL-1.1-ALv2
import { INSTANCE_ID } from "~/infra/instance-id"
import { type LeaderLeaseOptions, RedisLeaderLease } from "~/infra/leader-lease"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { hostsJobs, isLeaderEligible, type LiaisonRole } from "~/lib/process-role"
import { isShuttingDown } from "~/lib/shutdown"

const log = rootLogger.child({ module: "leadership" })

// Two gates, two authorities.
//
// 1. JOBS GATE (per node): the BullMQ job workers run only on the node whose
//    database is the Patroni primary. In an active/standby HA deployment both
//    app stacks can briefly be up at once (during/after a failover); Patroni +
//    etcd quorum already elect exactly one primary, so we reuse that authority.
//    `SINGLETON_LEADER_URL` points at the LOCAL node's Patroni REST /leader
//    (e.g. http://host.docker.internal:8008/leader), so each node's app asks its
//    own Patroni. Several worker processes on the primary node run jobs at once.
//
// 2. SINGLETONS (per cell): process-wide loops that must run exactly once (the
//    transactional-outbox drain and the like) run in the ONE process holding
//    the Redis leader lease (infra/leader-lease.ts), among the processes that
//    share one Redis. A deployment whose Redis is node-local makes the cell the
//    node. A process contends for the lease only while the Patroni gate is off
//    or its node is the Patroni leader, so a standby never holds it.
//
// `isLeader()` FAILS CLOSED: it is true only once leadership has started, the
// process's role is lease-eligible, the lease is held, and Patroni agrees. A
// process that never started leadership never runs a singleton.
//
// The Patroni gate is OFF when `SINGLETON_LEADER_URL` is unset: the jobs gate
// is open and every eligible process may contend for the lease. With one
// process (role `all`), it takes the lease at boot and runs everything.

const DEFAULT_PROBE_INTERVAL_MS = 5_000
const DEFAULT_PROBE_TIMEOUT_MS = 2_000

export interface LeadershipMonitorOptions {
  /** Override the Patroni /leader URL (defaults to env.SINGLETON_LEADER_URL). */
  url?: string
  /** Poll interval in ms (default 5000). */
  probeIntervalMs?: number
  /** Per-probe timeout in ms (default 2000). */
  probeTimeoutMs?: number
}

export interface SingletonHooks {
  name: string
  onAcquired: () => void | Promise<void>
  onLost: () => void | Promise<void>
}

export interface StartLeadershipOptions {
  role: LiaisonRole
  /** Contend for the lease. Default: the role's eligibility; never true for `api`. */
  leaseEligible?: boolean
  /** The jobs gate (Patroni only): wire to the BullMQ workers' pause/resume. */
  onJobsGate?: (open: boolean) => void
  patroni?: LeadershipMonitorOptions
  lease?: Omit<LeaderLeaseOptions, "canContend">
}

let started = false
let eligible = false
let patroniLeader = false
let leaderUrl: string | null = null
let probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS
let timer: ReturnType<typeof setInterval> | null = null
// Raised by each stop: a probe in flight then belongs to a run that has ended.
let probeRun = 0
let onJobsGateCb: ((open: boolean) => void) | null = null
let lease: RedisLeaderLease | null = null

const hooks: SingletonHooks[] = []
const acquired = new Set<SingletonHooks>()
// Hook transitions run one at a time: a loss always completes before the next acquire.
let chain: Promise<void> = Promise.resolve()

/** Whether THIS process runs the cell's singletons right now. Sync + cheap. */
export function isLeader(): boolean {
  return started && eligible && patroniLeader && lease?.held() === true
}

// Has THIS process started leadership? Distinct from `isLeader()`: an `api`
// process has started it and never leads. Callers that must refuse to run in a
// process without leadership state (amendment A7) ask this.
/** True once `startLeadership` has run in THIS process (and not stopped). */
export function hasLeadershipMonitorStarted(): boolean {
  return started
}

async function runHook(h: SingletonHooks, phase: "onAcquired" | "onLost"): Promise<void> {
  try {
    await h[phase]()
    log.info(
      { singleton: h.name, instanceId: INSTANCE_ID },
      phase === "onAcquired" ? "singleton started" : "singleton stopped",
    )
  } catch (err) {
    log.error({ err, singleton: h.name, instanceId: INSTANCE_ID, phase }, "singleton hook failed")
  }
}

async function settle(): Promise<void> {
  if (isLeader()) {
    for (const h of hooks) {
      if (acquired.has(h)) continue
      acquired.add(h)
      await runHook(h, "onAcquired")
    }
    return
  }
  for (const h of [...acquired]) {
    acquired.delete(h)
    await runHook(h, "onLost")
  }
}

/** Queue a hook reconciliation against the current `isLeader()`; resolves when it ran. */
function recompute(): Promise<void> {
  chain = chain.then(settle, settle)
  return chain
}

/** Run `onAcquired` while this process leads, `onLost` when it stops leading. */
export function registerSingleton(h: SingletonHooks): void {
  hooks.push(h)
  void recompute()
}

async function probeOnce(): Promise<boolean> {
  if (!leaderUrl) return true
  try {
    const res = await fetch(leaderUrl, {
      method: "GET",
      signal: AbortSignal.timeout(probeTimeoutMs),
    })
    // Patroni REST: 200 on the leader, 503 on a replica/unknown.
    return res.status === 200
  } catch {
    // Can't confirm leadership (Patroni unreachable / timeout). Fail toward NOT
    // leader: a paused outbox lags (events persist and deliver once leadership
    // resolves, and the watchdog /diag alerts on the lag), which is strictly
    // safer than risking a double-fire by assuming leadership we can't verify.
    return false
  }
}

function applyPatroni(next: boolean): void {
  if (!started || next === patroniLeader) return
  patroniLeader = next
  log.warn(
    { patroniLeader: next, leaderUrl },
    next
      ? "Node became Patroni leader -- starting job workers"
      : "Node lost Patroni leadership -- pausing job workers and singletons",
  )
  onJobsGateCb?.(next)
  void recompute()
}

/**
 * Start leadership for this process. The jobs gate (`onJobsGate`) follows
 * Patroni for job-hosting roles; lease-eligible processes contend for the
 * leader lease; singleton hooks run on transitions of `isLeader()`.
 */
export async function startLeadership(opts: StartLeadershipOptions): Promise<void> {
  if (started) throw new Error("startLeadership: leadership already started in this process")
  // A process shutting down never takes the lease (a SIGTERM during boot).
  if (isShuttingDown()) return
  started = true
  eligible = isLeaderEligible(opts.role) && (opts.leaseEligible ?? true)
  const jobHost = hostsJobs(opts.role)
  onJobsGateCb = jobHost ? (opts.onJobsGate ?? null) : null

  if (!jobHost && !eligible) {
    log.info({ role: opts.role }, "Leadership started: this role runs no jobs and no singletons")
    return
  }

  leaderUrl = opts.patroni?.url ?? env.SINGLETON_LEADER_URL ?? null
  probeTimeoutMs = opts.patroni?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const intervalMs = opts.patroni?.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS

  if (!leaderUrl) {
    // Gate off: this node is the leader, no polling. Announce so the jobs gate runs.
    patroniLeader = true
    onJobsGateCb?.(true)
    log.info("Patroni gating OFF (SINGLETON_LEADER_URL unset) -- jobs gate open")
  } else {
    log.info(
      { leaderUrl, probeIntervalMs: intervalMs },
      "Patroni gating ON -- probing local Patroni /leader",
    )
    // Start NON-leader and announce it so the jobs gate pauses, then probe
    // immediately so the real leader starts without a probe-interval wait.
    patroniLeader = false
    onJobsGateCb?.(false)
    const run = probeRun
    const applyProbe = (next: boolean) => {
      if (run === probeRun) applyPatroni(next)
    }
    applyProbe(await probeOnce())
    timer = setInterval(() => {
      void probeOnce()
        .then(applyProbe)
        .catch((err) => log.error({ err }, "Leadership probe failed"))
    }, intervalMs)
    // Never keep the event loop alive solely for this probe.
    ;(timer as { unref?: () => void }).unref?.()
  }

  if (!eligible) return
  const l = new RedisLeaderLease(
    { ...opts.lease, canContend: () => started && patroniLeader },
    () => recompute(),
  )
  lease = l
  await l.start()
}

/**
 * Stop leadership: `isLeader()` turns false, every acquired hook's `onLost` is
 * awaited, then the lease is released.
 */
export async function stopLeadership(): Promise<void> {
  probeRun++
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  const l = lease
  lease = null
  // `lease = null` already makes isLeader() false; the lease's loss callback
  // awaits the hooks before its compare-and-delete release.
  if (l) await l.stop()
  started = false
  eligible = false
  patroniLeader = false
  leaderUrl = null
  onJobsGateCb = null
  await recompute()
}

export const LeadershipTestAccess = {
  /** Stop leadership and forget every registered singleton. */
  async reset(): Promise<void> {
    await stopLeadership()
    hooks.length = 0
    acquired.clear()
    chain = Promise.resolve()
  },
}
