// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How an app job handler gets its database context.
//
// `ambient` (legacy): the worker opens ONE RLS transaction around the whole
// handler run and hands it over as `_tx`. Every write commits or rolls back
// together -- but the connection is pinned, and every row the handler touches
// stays LOCKED, for the handler's entire wall-clock, including its sandboxed
// network I/O. Two jobs sharing a cron second that UPDATE the same row then
// serialize on that lock: prod 2026-08 -> 2026-09, the social watch-poller's
// quota write waited on discovery-sync's row lock for the rest of discovery's
// run and was killed by statement_timeout every quarter hour.
//
// `session` (default for sandboxed manifest jobs): NO ambient transaction. The
// worker hands over an RlsSession as `_session`; the sandbox bridge opens a
// short RLS transaction PER BRIDGE CALL (createSessionRpcBridge), exactly like
// tool handlers since bridge-owned transactions landed. Pool demand and lock
// hold time become proportional to SQL time, not handler wall-clock. Separate
// bridge calls no longer roll back together when the handler later throws --
// a job that needs whole-run atomicity (gap-free document numbering, an
// all-or-nothing snapshot rewrite) declares `atomic: true` in its manifest
// and keeps `ambient`.
import { type ActorContext, createRlsSession, withRlsContext } from "~/db/rls"
import { type PinnedJobsGate, pinnedJobsGate } from "~/infra/jobs/pinned-jobs-gate"

/** The transaction client withRlsContext hands its callback (not exported by rls.ts). */
type RlsTx = Parameters<Parameters<typeof withRlsContext>[1]>[0]

export type JobTxMode = "ambient" | "session"

export interface JobContextDeps {
  withRlsContext: <T>(
    ctx: ActorContext,
    fn: (tx: RlsTx) => Promise<T>,
    opts?: { pool?: "jobs" },
  ) => Promise<T>
  createRlsSession: typeof createRlsSession
  /** Admission of whole-run jobs-pool holders (ambient jobs); default the process's gate. */
  pinned?: PinnedJobsGate
}

const defaultDeps: JobContextDeps = {
  withRlsContext: (ctx, fn, opts) => withRlsContext(ctx, fn, opts as never),
  createRlsSession,
  pinned: pinnedJobsGate,
}

/**
 * Run `handlerFn` for an app job under `rlsCtx`, in the registered
 * transaction mode. The payload the handler receives is `data` plus exactly
 * one of `_tx` (ambient) or `_session` (session). Both modes use the
 * background `jobs` pool so app crons stay off the interactive request/MCP
 * pool.
 */
export async function dispatchAppJobWithContext(
  handlerFn: (payload: any) => Promise<void>,
  data: Record<string, unknown>,
  rlsCtx: ActorContext,
  txMode: JobTxMode,
  deps: JobContextDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<void> {
  if (txMode === "session") {
    const session = deps.createRlsSession(rlsCtx, { pool: "jobs" } as never)
    await handlerFn({ ...data, _session: session })
    return
  }
  // Ambient: the transaction holds a jobs connection for the whole run, so it
  // waits for admission first (infra/jobs/pinned-jobs-gate.ts).
  const run = () =>
    deps.withRlsContext(
      rlsCtx,
      async (tx) => {
        await handlerFn({ ...data, _tx: tx })
      },
      { pool: "jobs" },
    )
  await (deps.pinned ? deps.pinned.run("ambient-job", run, signal) : run())
}
