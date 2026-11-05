// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The import transform pool: its own sandbox worker pool, never the app pool.
 *
 * A transform is agent- or admin-written code that turns an export (a CSV, a
 * zip of JSON files, an API's pages) into import records. It runs in the same
 * out-of-process QuickJS sandbox as untrusted app handlers, but on a separate,
 * small pool so a long import can never take the workers an app tool call is
 * waiting for. Every call is background work (no slot reserved for
 * interactive calls), has a 32 MiB heap and a per-call budget that goes
 * through `resolveToolTimeoutMs` (capped at 120 s).
 *
 * The pool starts on first use and is shut down with the server
 * (`lib/server.ts`); its workers also exit on their own when the API process
 * is gone (orphan exit).
 */
import { resolveToolTimeoutMs } from "~/modules/apps/sandbox/executor"
import { SandboxWorkerPool } from "~/modules/apps/sandbox/worker-pool"

/** Heap limit of one transform call (the sandbox's production default). */
export const TRANSFORM_MEMORY_LIMIT_BYTES = 32 * 1024 * 1024

const DEFAULT_POOL_SIZE = 2
const MAX_POOL_SIZE = 8
const DEFAULT_CALL_BUDGET_MS = 30_000

/** Worker count from `LIAISON_TRANSFORM_POOL_SIZE` (default 2, at most 8). */
export function resolveTransformPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.LIAISON_TRANSFORM_POOL_SIZE)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_POOL_SIZE
  return Math.min(MAX_POOL_SIZE, Math.floor(n))
}

/**
 * Budget of one transform call: `LIAISON_TRANSFORM_CALL_BUDGET_MS` (default
 * 30 s) through `resolveToolTimeoutMs`, so never below the sandbox's base
 * budget and never above its 120 s ceiling.
 */
export function resolveTransformCallBudgetMs(
  declared?: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromEnv = Number(env.LIAISON_TRANSFORM_CALL_BUDGET_MS)
  const wanted =
    declared ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_CALL_BUDGET_MS)
  return (
    resolveToolTimeoutMs(wanted, env) ??
    resolveToolTimeoutMs(DEFAULT_CALL_BUDGET_MS, env) ??
    DEFAULT_CALL_BUDGET_MS
  )
}

let pool: SandboxWorkerPool | null = null
let initPromise: Promise<SandboxWorkerPool> | null = null

/** The transform pool, started on first use (concurrent callers share one start). */
export async function getTransformPool(): Promise<SandboxWorkerPool> {
  if (!initPromise) {
    const size = resolveTransformPoolSize()
    const created = new SandboxWorkerPool({
      size,
      maxSize: size,
      reservedInteractive: 0,
      maxNestedOverflow: 0,
      memoryLimitBytes: TRANSFORM_MEMORY_LIMIT_BYTES,
    })
    pool = created
    initPromise = created
      .init()
      .then(() => created)
      .catch((err) => {
        if (pool === created) {
          pool = null
          initPromise = null
        }
        throw err
      })
  }
  return initPromise
}

/** Stop the transform pool's workers (server shutdown, tests). */
export async function shutdownTransformPool(): Promise<void> {
  const current = pool
  pool = null
  initPromise = null
  if (current) await current.shutdown()
}
