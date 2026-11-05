// SPDX-License-Identifier: FSL-1.1-ALv2
// The process-wide shutdown phases (lib/shutdown.ts), registered once by
// index.ts. The listener's own phases (readiness, stop, HTTP drain, sockets)
// are registered by createServer; the job drain by infra/jobs/jobs.ts.
//
// after-drain order:  0 drains (HTTP, jobs, turns, approvals)
//                     5 the listener cuts what is left (turn streams included)
//                    10 event-handler flush   20 outbox stop
//                    30 background app registration   40 search rebuild lock
//                    50 sandbox worker pool   55 transform pool
//                    60 instance heartbeat (releaseOwned)
//                    90 internal listener (a draining turn may still
//                       receive a forwarded mailbox answer)
//                    95 Postgres pool   97 jobs still running handed back
//                   100 Redis connections
import { sql } from "~/db"
import { registerJobShutdownPhases } from "~/infra/jobs/jobs"
import {
  bootQuiet,
  msSinceShutdownBegan,
  registerShutdownPhase,
  shutdownBudgets,
} from "~/lib/shutdown"
import {
  AFTER_DRAIN_DEADLINE_MS,
  LEADERSHIP_STOP_MS,
  SHUTDOWN_ORDER,
  TURN_HANDOFF_TOOL_SETTLE_MS,
  turnHandoffMs,
} from "~/lib/shutdown-budget"

/** How long the approvals in flight at the signal may take to terminalize. */
const APPROVALS_DRAIN_MS = 30_000

export function registerProcessShutdownPhases(opts: { internalListener?: { stop(): void } }): void {
  // From t0: no new approval execution claims; the open ones finish below.
  registerShutdownPhase({
    name: "approvals-refuse",
    at: "t0",
    run: async () => {
      const { beginDraining } = await import("~/modules/approvals/drain")
      beginDraining()
    },
  })
  // From t0: singletons stop (the outbox's in-flight batch ends first), then
  // the lease is released, so another worker takes them within one tick.
  registerShutdownPhase({
    name: "leadership",
    at: "t0",
    deadlineMs: LEADERSHIP_STOP_MS,
    run: async () => {
      const { stopLeadership } = await import("~/infra/leadership")
      await stopLeadership()
    },
  })
  registerShutdownPhase({
    name: "approvals-drain",
    at: "after-drain",
    order: SHUTDOWN_ORDER.drain,
    deadlineMs: APPROVALS_DRAIN_MS + 1_000,
    run: async () => {
      const { drainApprovalsForShutdown } = await import("~/modules/approvals/drain")
      const budget = Math.min(APPROVALS_DRAIN_MS, shutdownBudgets().httpDrainMs)
      await drainApprovalsForShutdown(Math.max(0, budget - msSinceShutdownBegan()))
    },
  })
  // Running agent turns finish, up to SHUTDOWN_TURN_DRAIN_MS from t0. Past it
  // they hand off and resume elsewhere (turn-handoff.ts, turn-resume.ts).
  registerShutdownPhase({
    name: "turns-drain",
    at: "after-drain",
    order: SHUTDOWN_ORDER.drain,
    deadlineMs:
      shutdownBudgets().turnDrainMs + turnHandoffMs(shutdownBudgets().turnSettleMs) + 1_000,
    run: async () => {
      const { drainTurns } = await import("~/modules/agent/runtime/turn-handoff")
      const budget = Math.max(0, shutdownBudgets().turnDrainMs - msSinceShutdownBegan())
      await drainTurns(budget, shutdownBudgets().turnSettleMs, TURN_HANDOFF_TOOL_SETTLE_MS)
    },
  })
  // The job drain is the job module's own (infra/jobs/jobs.ts).
  registerJobShutdownPhases()
  registerShutdownPhase({
    name: "event-flush",
    at: "after-drain",
    order: SHUTDOWN_ORDER.eventFlush,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.eventFlush,
    run: async () => {
      const { flushEventHandlers } = await import("~/infra/events/event-bus")
      await flushEventHandlers()
    },
  })
  registerShutdownPhase({
    name: "outbox",
    at: "after-drain",
    order: SHUTDOWN_ORDER.outbox,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.outbox,
    run: async () => {
      const { stopOutboxWorker } = await import("~/infra/events/outbox-worker")
      await stopOutboxWorker()
    },
  })
  // A search rebuild still running was handed back by the job drain: hand its
  // lock back too, or the next boot's rebuild waits out the lock TTL.
  registerShutdownPhase({
    name: "search-rebuild-lock",
    at: "after-drain",
    order: SHUTDOWN_ORDER.rebuildLock,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.rebuildLock,
    run: async () => {
      const { releaseRebuildLockForShutdown } = await import("~/modules/search/reindex")
      await releaseRebuildLockForShutdown()
    },
  })
  registerShutdownPhase({
    name: "sandbox-pool",
    at: "after-drain",
    order: SHUTDOWN_ORDER.sandboxPool,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.sandboxPool,
    run: async () => {
      const { shutdownWorkerPool } = await import("~/modules/apps/sandbox/worker-pool")
      await shutdownWorkerPool()
    },
  })
  registerShutdownPhase({
    name: "transform-pool",
    at: "after-drain",
    order: SHUTDOWN_ORDER.transformPool,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.transformPool,
    run: async () => {
      const { shutdownTransformPool } = await import("~/modules/imports/transforms/pool")
      await shutdownTransformPool()
    },
  })
  // Delete this process's heartbeat record and run its own cleanup hooks
  // (sockets, slots, live turns) before the pools close.
  registerShutdownPhase({
    name: "instance-heartbeat",
    at: "after-drain",
    order: SHUTDOWN_ORDER.heartbeat,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.heartbeat,
    run: async () => {
      const { stopInstanceHeartbeat } = await import("~/infra/instance-registry")
      await stopInstanceHeartbeat({ releaseOwned: true })
    },
  })
  const internalListener = opts.internalListener
  if (internalListener) {
    registerShutdownPhase({
      name: "internal-listener",
      at: "after-drain",
      order: SHUTDOWN_ORDER.internalListener,
      deadlineMs: AFTER_DRAIN_DEADLINE_MS.internalListener,
      run: () => internalListener.stop(),
    })
  }
  // Postgres first: a job still running past its drain can no longer write,
  // then the job module hands it back (97), then Redis closes.
  registerShutdownPhase({
    name: "pg-pool",
    at: "after-drain",
    order: SHUTDOWN_ORDER.pgPool,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.pgPool,
    run: async () => {
      // A boot step still running at the signal goes on to its next halt first.
      await bootQuiet()
      await sql.end({ timeout: 5 })
    },
  })
  registerShutdownPhase({
    name: "pools",
    at: "after-drain",
    order: SHUTDOWN_ORDER.pools,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.pools,
    run: async () => {
      const { redis, redisBullMQ, redisSub } = await import("~/lib/redis")
      await bootQuiet()
      redis.disconnect()
      redisSub.disconnect()
      redisBullMQ.disconnect()
    },
  })
}
