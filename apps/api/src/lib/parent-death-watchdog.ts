// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Orphan self-termination for harness-spawned host processes.
//
// A harness (the QA chaos harness, and the e2e worker env in
// `packages/test-helpers/src/worker-env.ts`) spawns the api + worker via
// `Bun.spawn` and tears them down on normal completion. When the harness is
// killed without running teardown - a `timeout` SIGTERM, a crash, a `kill -9`,
// a CONNECT_TIMEOUT abort - the spawned children are re-parented to init and
// ORPHANED. Across runs these orphans accumulate, exhausting ports, DB
// connections and RAM, which degrades later runs: a CONNECT_TIMEOUT and a
// 7-orphan-world chaos stall, and later eight orphaned e2e servers that starved
// the web-unit suite behind them into 30s timeouts.
//
// The mechanism lives in `~/lib/orphan-exit` (dependency free so the sandbox
// worker can use it too). This module is the host-process wrapper: the env gate
// plus the log line.

import { rootLogger } from "~/lib/logger"
import { exitWhenOrphaned, STARTUP_PARENT_PID } from "~/lib/orphan-exit"

/**
 * Env vars that opt a spawned process into self-terminating when orphaned.
 * Exported so the spawners can be pinned against the name they actually set.
 *
 * `CHAOS_DEBUG` is the chaos harness's existing marker. `LIAISON_EXIT_WHEN_ORPHANED`
 * is the explicit opt-in every other harness sets, so a process is never
 * self-terminating by accident - notably a production server, which must stay
 * up under an init system that legitimately owns it as ppid 1.
 */
export const ORPHAN_EXIT_ENV_VARS = ["CHAOS_DEBUG", "LIAISON_EXIT_WHEN_ORPHANED"] as const

export function orphanExitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ORPHAN_EXIT_ENV_VARS.some((name) => env[name] === "1")
}

/**
 * If this process was spawned by a test harness (see `ORPHAN_EXIT_ENV_VARS`),
 * exit when its parent process dies. No-op otherwise, so a production process
 * never self-exits. Returns a stop() to clear the timer (e.g. for tests).
 */
export function exitWhenParentDies(intervalMs = 2000): () => void {
  if (!orphanExitEnabled()) return () => {}
  return exitWhenOrphaned({
    intervalMs,
    onOrphaned: (how) =>
      rootLogger.warn(
        { pid: process.pid, detectedBy: how, startupParentPid: STARTUP_PARENT_PID },
        "harness child orphaned (parent died) - self-terminating",
      ),
  })
}
