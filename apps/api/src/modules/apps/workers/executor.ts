// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Workers executor: one app run on the remote V8 isolate loader.
//
//   1. admission (admission.ts): per-org queue, holdsTx cap, nested never queued
//   2. registerRun (run-registry.ts): the run's own bridge, built by the
//      dispatching code in its frame, behind a one-run bearer token
//   3. POST <loaderUrl>/run, signed v2 "cell->loader" (sign.ts), with the run token, the
//      bridge URL and the method list; the isolate calls back on
//      /api/app-bridge/<runId> (bridge-route.ts)
//   4. the loader's answer becomes the run's result, or an Error shaped like
//      the worker pool's for the same failure (a timeout is
//      "App execution timed out"; a handler's message, name, status and code,
//      and an app-sdk ToolError's safe/code/retryable, are kept)
//   5. finally: the token is revoked (settle) and the admission slot freed
//
// A failed attempt is classified (faults.ts). A loader-level fault is retried
// once, after a short jitter, only when the attempt made no bridge call (the
// count is the owner's, read after settle: nothing the app did can have
// happened twice) and the caller's remaining budget is at least twice what the
// attempt took; the retry is a new run (new id and token) inside the same
// deadline, so a webhook's delivery budget holds. Every attempt's outcome goes
// to the loader breaker; an app-level fault starts this org's app@version
// fallback (fallback.ts).
//
// Nothing secret goes in the request: the run token is the run's only
// credential and dies with it; provider secrets never leave this server
// (forWorkersRun, sandbox/bridge/secret-free.ts, applied by runApp).

import type { RunBody } from "@liaison/app-loader"
import { sandboxCancelledError } from "~/lib/failure-severity"
import { rootLogger } from "~/lib/logger"
import { type RunEntryKind, runLimits, workersLoaderLimits } from "~/modules/apps/run-limits"
import { type WorkersAdmission, workersAdmission } from "./admission"
import { bridgeUrlFor, type WorkersConfig } from "./config"
import {
  type AppFallbacks,
  appFallbacks as defaultAppFallbacks,
  loaderBreaker as defaultLoaderBreaker,
  type LoaderBreaker,
} from "./fallback"
import {
  CANCELLED_FAULT,
  CELL_FAULT,
  classifyLoaderAnswer,
  DEADLINE_FAULT,
  NETWORK_FAULT,
  type WorkersFault,
} from "./faults"
import { ensureRunOwnerReachable } from "./run-owner"
import { type RunBridge, type RunRegistry, runRegistry } from "./run-registry"
import { signCellRequestV2 } from "./sign"
import type { LoaderTimings } from "./timings"
import { parseWorkerLogs, type WorkerLogLine } from "./worker-logs"

const log = rootLogger.child({ module: "apps-workers-executor" })

/** The cell's own fetch to the loader outlives the run's deadline by this much. */
export const LOADER_FETCH_GRACE_MS = 5_000

export interface WorkersRunOptions {
  config: WorkersConfig
  appName: string
  orgId: string
  version: string
  /**
   * sha256 of the Worker module (the package's worker.js, recorded on the
   * installed row), not of the package.
   */
  bundleSha256: string
  exportName: string
  params: unknown
  extraArgs?: unknown[]
  /** The K6 approval literal (`ctx.approval`). */
  approval?: unknown
  bridge: RunBridge
  /** Default: the wall clock of the run's entry kind (run-limits.ts). */
  timeoutMs?: number
  /** The run's entry kind, whose row of the limit table the loader gets (default `tool`). */
  entryKind?: RunEntryKind
  signal?: AbortSignal
  holdsTx: boolean
  nested?: boolean
  nestedParentKey?: string
  /** This run is the loader breaker's half-open probe (planWorkersRun). */
  probe?: boolean
  /** Seams for tests. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  admission?: WorkersAdmission
  registry?: RunRegistry
  breaker?: LoaderBreaker
  appFallbacks?: AppFallbacks
  /** The retry's jitter in ms (default 50-250, never more than a tenth of what is left). */
  retryJitterMs?: (remainingMs: number) => number
  now?: () => number
}

/** What a run reports besides its result (for the run timing line). */
export interface WorkersRunInfo {
  runId?: string
  loader?: LoaderTimings
  sleepMs?: number
  sleepExact?: boolean
  /** Attempts made (2 when retried). */
  attempts?: number
  /** Bridge calls of every attempt, as the run's owner counted them. */
  bridgeCalls?: number
  /** The fault of the failing (last) attempt. */
  fault?: WorkersFault
  /** Console lines and uncaught errors the run's code produced (worker-core.ts). */
  logs?: WorkerLogLine[]
  /** Lines the isolate dropped past its per-run cap. */
  logsDropped?: number
}

interface LoaderError {
  message?: unknown
  kind?: unknown
  status?: unknown
  code?: unknown
  name?: unknown
  safe?: unknown
  retryable?: unknown
}

interface LoaderAnswer {
  ok?: unknown
  result?: unknown
  error?: LoaderError
  timings?: Record<string, unknown>
  logs?: unknown
  logsDropped?: unknown
}

function loaderTimings(t: Record<string, unknown> | undefined): LoaderTimings | undefined {
  if (!t || typeof t !== "object") return undefined
  const out: LoaderTimings = {}
  for (const k of ["loadMs", "runMs", "bridgeCalls", "bridgeMsTotal", "workerRunMs"] as const) {
    if (typeof t[k] === "number") out[k] = t[k] as number
  }
  if (typeof t.cold === "boolean") out.cold = t.cold
  return out
}

/** A loader `{ok:false}` error -> the Error the worker pool raises for the same failure. */
export function errorFromLoader(error: LoaderError | undefined, httpStatus: number): Error {
  const message = typeof error?.message === "string" ? error.message : "Unknown sandbox error"
  const kind = typeof error?.kind === "string" ? error.kind : `http_${httpStatus}`
  if (kind === "timeout") return new Error("App execution timed out")
  if (kind === "handler") {
    if (error?.safe === true) {
      const e = new Error(message) as Error & { safe: true; code: string; retryable: boolean }
      e.name = "ToolError"
      e.safe = true
      e.code = typeof error.code === "string" ? error.code : "tool_error"
      e.retryable = error.retryable === true
      if (typeof error.status === "number") (e as Error & { status?: number }).status = error.status
      return e
    }
    const e = new Error(message) as Error & { status?: number; code?: string }
    if (typeof error?.name === "string" && error.name) e.name = error.name.slice(0, 64)
    if (typeof error?.status === "number") {
      e.status = error.status
      if (typeof error.code === "string") e.code = error.code
    }
    return e
  }
  // The loader refused or could not run the module: an infrastructure fault,
  // never the app's own error (no status, so it is not mistaken for one).
  const e = new WorkersRunError(
    `App loader could not run the app (${kind}, HTTP ${httpStatus}): ${message}`,
    classifyLoaderAnswer(httpStatus, error?.kind, error?.code),
  )
  return e
}

/** The loader refused or could not run the module, or could not be reached. */
export class WorkersRunError extends Error {
  constructor(
    message: string,
    readonly fault: WorkersFault,
  ) {
    super(message)
    this.name = "WorkersRunError"
  }
}

/** Final outcomes the loader never answered (faults.ts). */
const UNANSWERED_KINDS = new Set(["cancelled", "deadline", "cell"])

const RETRY_JITTER_MIN_MS = 50
const RETRY_JITTER_SPAN_MS = 200

function defaultJitter(remainingMs: number): number {
  const jitter = RETRY_JITTER_MIN_MS + Math.floor(Math.random() * RETRY_JITTER_SPAN_MS)
  return Math.min(jitter, Math.floor(remainingMs / 10))
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

interface AttemptOutcome {
  ok: boolean
  result?: unknown
  error?: Error
  fault?: WorkersFault
  bridgeCalls: number
  ms: number
}

/** Run one export on the loader. `onInfo` gets the run's id and timings, whatever the outcome. */
export async function executeOnWorkers(
  opts: WorkersRunOptions,
  onInfo?: (info: WorkersRunInfo) => void,
): Promise<unknown> {
  const admission = opts.admission ?? workersAdmission
  const breaker = opts.breaker ?? defaultLoaderBreaker
  const fallbacks = opts.appFallbacks ?? defaultAppFallbacks
  const now = opts.now ?? Date.now
  const limits = runLimits(opts.entryKind ?? "tool")
  const timeoutMs = opts.timeoutMs ?? limits.wallMs
  const deadlineAt = now() + timeoutMs
  const info: WorkersRunInfo = { attempts: 0, bridgeCalls: 0 }

  // Bridge calls come back through the public address: this process must be a reachable owner.
  await ensureRunOwnerReachable()
  let release: (() => void) | undefined
  try {
    release = await admission.acquire({
      orgId: opts.orgId,
      holdsTx: opts.holdsTx,
      nested: opts.nested === true,
      ...(opts.nestedParentKey !== undefined ? { nestedParentKey: opts.nestedParentKey } : {}),
      waitMs: timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
      appName: opts.appName,
    })
    let probe = opts.probe === true
    for (;;) {
      const attemptTimeout = Math.max(1, deadlineAt - now())
      const outcome = await attemptOnWorkers(opts, attemptTimeout, info)
      info.attempts = (info.attempts ?? 0) + 1
      info.bridgeCalls = (info.bridgeCalls ?? 0) + outcome.bridgeCalls
      const fault = outcome.fault
      if (fault) info.fault = fault
      else delete info.fault
      // The breaker hears every attempt: a loader-level fault, or an answer
      // from the loader. An attempt that ended without either (the caller's
      // abort, this cell's own deadline or fault) tells it nothing; a probe's
      // lease then runs out by itself.
      if (fault?.class === "loader") breaker.record("loader_fault", probe)
      else if (!fault || !UNANSWERED_KINDS.has(fault.kind)) breaker.record("answered", probe)
      probe = false
      if (fault?.class === "app") {
        fallbacks.mark(AppFallbacksKey(opts), fault.kind)
      }
      if (outcome.ok) return outcome.result
      const remaining = deadlineAt - now()
      const retry =
        fault?.class === "loader" &&
        info.attempts === 1 &&
        outcome.bridgeCalls === 0 &&
        info.bridgeCalls === 0 &&
        breaker.state() === "closed" &&
        !opts.signal?.aborted &&
        remaining >= 2 * outcome.ms
      if (!retry) throw outcome.error
      const jitter = (opts.retryJitterMs ?? defaultJitter)(remaining)
      if (remaining - jitter < 2 * outcome.ms) throw outcome.error
      log.warn(
        {
          app: opts.appName,
          orgId: opts.orgId,
          kind: fault.kind,
          attemptMs: outcome.ms,
          remainingMs: remaining,
          jitterMs: jitter,
        },
        "App loader fault before any bridge call; retrying once",
      )
      await sleep(jitter, opts.signal)
      if (opts.signal?.aborted) throw sandboxCancelledError()
    }
  } finally {
    release?.()
    onInfo?.(info)
  }
}

function AppFallbacksKey(opts: WorkersRunOptions): string {
  return `${opts.orgId}:${opts.appName}@${opts.version}`
}

/** One registration + /run round trip. Never throws: the outcome says what happened. */
async function attemptOnWorkers(
  opts: WorkersRunOptions,
  timeoutMs: number,
  info: WorkersRunInfo,
): Promise<AttemptOutcome> {
  const registry = opts.registry ?? runRegistry
  const fetchImpl = opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))
  const now = opts.now ?? Date.now
  const started = now()
  let run: ReturnType<RunRegistry["registerRun"]> | undefined
  let bridgeCalls = 0
  const done = (o: Omit<AttemptOutcome, "bridgeCalls" | "ms">): AttemptOutcome => {
    if (run) {
      // Settled before the count is read: no later call can land on this run.
      const stats = run.settle()
      run = undefined
      bridgeCalls = stats.bridgeCalls
      info.loader = info.loader ?? {}
      // The cell's own view of the bridge, when the loader said nothing.
      info.loader.bridgeCalls ??= stats.bridgeCalls
      info.loader.bridgeMsTotal ??= stats.bridgeMsTotal
    }
    return { ...o, bridgeCalls, ms: now() - started }
  }
  try {
    // Exactly what the pool hands its subprocess: every key of the bridge.
    const bridgeMethods = Object.keys(opts.bridge)
    run = registry.registerRun({
      bridge: opts.bridge,
      bridgeMethods,
      orgId: opts.orgId,
      appName: opts.appName,
      version: opts.version,
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    info.runId = run.runId
    delete info.loader
    delete info.logs
    delete info.logsDropped
    // The loader's wire body (@liaison/app-loader protocol.ts), typed so a
    // field the loader requires cannot go missing here.
    const runBody: RunBody = {
      runId: run.runId,
      orgId: opts.orgId,
      app: opts.appName,
      version: opts.version,
      sha256: opts.bundleSha256,
      exportName: opts.exportName,
      params: opts.params ?? null,
      extraArgs: opts.extraArgs ?? [],
      approval: opts.approval ?? null,
      bridgeMethods,
      bridgeUrl: bridgeUrlFor(opts.config, run.runId),
      runToken: run.runToken,
      deadlineMs: timeoutMs,
      limits: workersLoaderLimits(runLimits(opts.entryKind ?? "tool")),
    }
    const body = JSON.stringify(runBody)
    const runUrl = `${opts.config.loaderUrl}/run`
    const headers = {
      "content-type": "application/json",
      ...signCellRequestV2({
        cellId: opts.config.cellId,
        cellKey: opts.config.loaderKey,
        direction: "cell->loader",
        method: "POST",
        path: new URL(runUrl).pathname,
        body,
      }),
    }
    const fetchTimeout = AbortSignal.timeout(timeoutMs + LOADER_FETCH_GRACE_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, fetchTimeout]) : fetchTimeout

    let res: Response
    let text: string
    try {
      res = await fetchImpl(runUrl, { method: "POST", headers, body, signal })
      text = await res.text()
    } catch (err) {
      if (opts.signal?.aborted) {
        return done({ ok: false, error: sandboxCancelledError(), fault: CANCELLED_FAULT })
      }
      if (fetchTimeout.aborted) {
        return done({
          ok: false,
          error: new Error("App execution timed out"),
          fault: DEADLINE_FAULT,
        })
      }
      log.error(
        { err, app: opts.appName, orgId: opts.orgId, runId: run.runId },
        "App loader unreachable",
      )
      return done({
        ok: false,
        error: new WorkersRunError(
          `App loader unreachable: ${(err as Error)?.message ?? String(err)}`,
          NETWORK_FAULT,
        ),
        fault: NETWORK_FAULT,
      })
    }

    let answer: LoaderAnswer | null = null
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        answer = parsed as LoaderAnswer
      }
    } catch {
      answer = null
    }
    const t = answer?.timings
    const lt = loaderTimings(t)
    if (lt) info.loader = lt
    if (t && typeof t.sleepMs === "number") info.sleepMs = t.sleepMs
    if (t && typeof t.sleepExact === "boolean") info.sleepExact = t.sleepExact
    const logs = parseWorkerLogs(answer?.logs)
    if (logs.length > 0) info.logs = logs
    if (typeof answer?.logsDropped === "number" && answer.logsDropped > 0) {
      info.logsDropped = Math.floor(answer.logsDropped)
    }

    if (res.status === 200 && answer?.ok === true) {
      return done({ ok: true, result: answer.result === undefined ? null : answer.result })
    }
    const err = errorFromLoader(answer?.error, res.status)
    const fault =
      err instanceof WorkersRunError
        ? err.fault
        : classifyLoaderAnswer(res.status, answer?.error?.kind, answer?.error?.code)
    if (err instanceof WorkersRunError) {
      log.error(
        {
          app: opts.appName,
          orgId: opts.orgId,
          runId: run.runId,
          status: res.status,
          kind: answer?.error?.kind,
          faultClass: fault.class,
          code: answer?.error?.code,
          message: answer?.error?.message ?? text.slice(0, 200),
        },
        "App loader refused or failed the run",
      )
    }
    return done({ ok: false, error: err, fault })
  } catch (err) {
    // A fault of this cell (registration, signing): never the app's, never retried.
    return done({
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      fault: CELL_FAULT,
    })
  }
}
