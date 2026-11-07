// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app-code half of a Workers run: call one handler export of an app
// module with a fresh ctx whose bridge calls go to `dispatch`. No Cloudflare
// import and no Node import: it is bundled into the app's Worker module
// (worker-entry.ts wraps it in a WorkerEntrypoint) and into worker-core.js,
// which a plain JS host (the test fake loader) imports directly.
//
// Request: the loader's `/run` body (wire protocol). Only these fields are
// read: `exportName`, `params`, `extraArgs`, `approval`, `bridgeMethods`.
// The loader should not pass `runToken` / `bridgeUrl` to the isolate: the
// Bridge stub it hands to `run(req, bridge)` holds them.
//
// Result (JSON-safe, the body of the loader's answer minus what only the
// loader knows, `loadMs` and `cold`):
//   {ok:true, result, timings:{runMs, bridgeCalls, bridgeMsTotal, sleepMs, sleepExact},
//    logs?, logsDropped?}
//   {ok:false, error:{message, status?, code?, name?, safe?, retryable?, kind:"handler"},
//    timings:{...}, logs?, logsDropped?}
// `logs` (see "Console capture"): [{level, msg, at, shared?}], present when the
// run's code logged anything; `logsDropped` counts lines past the cap.
// `result` is the handler's return through JSON (undefined -> null), as the
// QuickJS subprocess dumps it. The error fields follow the subprocess's IPC
// error message (sandbox-worker.ts): `status`/`code` for a typed 4xx/5xx
// throw, `name` of a non-ToolError throw, `safe`/`code`/`retryable` for an
// app-sdk ToolError. A missing or invalid export is a handler error with the
// subprocess's own message.
//
// Bridge contract (`runWithBridge`, used by worker-entry.ts and the fake
// loader): `bridge.call(method, args)` resolves with the cell's 200 reply
// body, parsed and unchanged: `{data}`, `{}` (undefined data) or
// `{error, errorStatus?, errorCode?}`. `bridgeReplyData` turns that into what
// createCtx's dispatch must do: resolve with `data`, or reject with
// `{message: error, status: errorStatus, code: errorCode}` (createCtx then
// rejects the handler's call with the plain message, or an Error with
// status/code, exactly like the subprocess). A non-200 cell answer (401, 403,
// 404, 409, 410, 504) or a network failure is the Bridge's to throw: it
// rejects the handler's call with that error's message (and its numeric
// `status`/`code` when it carries them; across Workers RPC only the message
// is guaranteed to survive).

import { type CtxDispatch, createCtx } from "../sandbox/ctx-shim"

// -- Sleep accounting ----------------------------------------------------------
//
// `sleepMs`: how long the app's code waited in its own timers during the run
// (an app paces itself with `setTimeout`, e.g. a provider's throttle wait), so
// a measurement can tell waiting from work. While at least one run is in
// flight in this isolate, `globalThis.setTimeout` is wrapped: a timer scheduled
// then is charged, when it fires, the time it actually waited, to every run in
// flight when it was scheduled. Runs of one cached module share the isolate's
// globals, so a run that overlapped another reports `sleepExact: false` (its
// sleepMs is then an upper bound). The original timer is put back when the
// last run ends (unless someone else replaced it meanwhile). Nothing about the
// timer's behaviour changes: same delay, same arguments, same return value.

interface SleepMeter {
  sleepMs: number
  exact: boolean
}

type TimerFn = (fn: unknown, ms?: unknown, ...rest: unknown[]) => unknown

const inFlight = new Set<SleepMeter>()
let originalSetTimeout: TimerFn | undefined
let wrappedSetTimeout: TimerFn | undefined

function startSleepMeter(): SleepMeter {
  const meter: SleepMeter = { sleepMs: 0, exact: true }
  if (inFlight.size > 0) {
    meter.exact = false
    for (const m of inFlight) m.exact = false
  }
  inFlight.add(meter)
  const g = globalThis as { setTimeout?: TimerFn }
  if (inFlight.size === 1 && typeof g.setTimeout === "function" && !wrappedSetTimeout) {
    const original = g.setTimeout
    const wrapper: TimerFn = function (
      this: unknown,
      fn: unknown,
      ms?: unknown,
      ...rest: unknown[]
    ) {
      if (typeof fn !== "function" || inFlight.size === 0) {
        return original.call(this, fn, ms, ...rest)
      }
      const charged = [...inFlight]
      const scheduled = Date.now()
      return original.call(
        this,
        (...a: unknown[]) => {
          const waited = Math.max(0, Date.now() - scheduled)
          for (const m of charged) m.sleepMs += waited
          return (fn as (...x: unknown[]) => unknown)(...a)
        },
        ms,
        ...rest,
      )
    }
    originalSetTimeout = original
    wrappedSetTimeout = wrapper
    g.setTimeout = wrapper
  }
  return meter
}

function stopSleepMeter(meter: SleepMeter): void {
  inFlight.delete(meter)
  if (inFlight.size > 0 || !wrappedSetTimeout) return
  const g = globalThis as { setTimeout?: TimerFn }
  if (g.setTimeout === wrappedSetTimeout) g.setTimeout = originalSetTimeout
  wrappedSetTimeout = undefined
  originalSetTimeout = undefined
}

// -- Console capture -------------------------------------------------------------
//
// Every run first logs `__liaison_run <runId>` at debug level on the real
// console (the loader's inline tail correlates the run's CPU time by it; it is
// never part of `logs`). Then, while at least one run is in flight in this
// isolate, `console.{log,info,warn,error,debug}` are wrapped: a line goes to
// the run's `logs` instead of the isolate's console (the cell decides where it
// is written), and an uncaught error or unhandled rejection is kept as an
// error line. Per run at most 200 lines and 64 KiB (a line is cut at 4 KiB);
// past that lines are counted in `logsDropped`. Runs of one cached module
// share the isolate's globals, so a line logged while several runs are in
// flight cannot be told apart: it goes to each of them marked `shared: true`
// (the cell never files a shared line under one run's access tags). The
// originals are put back when the last run ends (unless replaced meanwhile).

export const RUN_CONSOLE_MAX_LINES = 200
export const RUN_CONSOLE_MAX_BYTES = 64 * 1024
export const RUN_CONSOLE_LINE_MAX_BYTES = 4 * 1024
export const RUN_MARKER = "__liaison_run"

export type WorkerLogLevel = "debug" | "info" | "warn" | "error"

export interface WorkerLogLine {
  level: WorkerLogLevel
  msg: string
  /** Epoch ms. */
  at: number
  /** Logged while other runs shared the isolate: not attributable to this run alone. */
  shared?: true
}

interface LogMeter {
  lines: WorkerLogLine[]
  bytes: number
  dropped: number
}

const CONSOLE_METHODS: ReadonlyArray<readonly [string, WorkerLogLevel]> = [
  ["log", "info"],
  ["info", "info"],
  ["warn", "warn"],
  ["error", "error"],
  ["debug", "debug"],
]

type ConsoleFn = (...args: unknown[]) => void
type ConsoleLike = Record<string, unknown>
type EventTargetLike = {
  addEventListener?: (type: string, fn: (ev: unknown) => void) => void
  removeEventListener?: (type: string, fn: (ev: unknown) => void) => void
}

/** The isolate's console object (read through Reflect: the lib's Console type has no index). */
function currentConsole(): ConsoleLike | undefined {
  const c: unknown = Reflect.get(globalThis, "console")
  return c !== null && typeof c === "object" ? (c as ConsoleLike) : undefined
}

const logMeters = new Set<LogMeter>()
let savedConsole: Map<string, unknown> | undefined
let wrappedConsole: Map<string, ConsoleFn> | undefined
let errorListener: ((ev: unknown) => void) | undefined
let rejectionListener: ((ev: unknown) => void) | undefined

const encoder = typeof TextEncoder === "function" ? new TextEncoder() : undefined
function byteLength(text: string): number {
  return encoder ? encoder.encode(text).length : text.length * 3
}

function cutBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (byteLength(text.slice(0, mid)) <= max) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo)
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`
  if (a === undefined) return "undefined"
  if (typeof a === "function") return `[function ${(a as { name?: string }).name || "anonymous"}]`
  if (typeof a === "bigint") return `${a}n`
  try {
    const text = JSON.stringify(a)
    return text === undefined ? String(a) : text
  } catch {
    try {
      return String(a)
    } catch {
      return "[unprintable]"
    }
  }
}

function captureLine(level: WorkerLogLevel, args: unknown[]): void {
  let msg: string
  try {
    msg = cutBytes(args.map(formatArg).join(" "), RUN_CONSOLE_LINE_MAX_BYTES)
  } catch {
    msg = "[unprintable]"
  }
  const shared = logMeters.size > 1
  const size = byteLength(msg)
  const at = Date.now()
  for (const meter of logMeters) {
    if (meter.lines.length >= RUN_CONSOLE_MAX_LINES || meter.bytes + size > RUN_CONSOLE_MAX_BYTES) {
      meter.dropped++
      continue
    }
    meter.bytes += size
    meter.lines.push(shared ? { level, msg, at, shared: true } : { level, msg, at })
  }
}

function errorText(prefix: string, value: unknown): string {
  const v = value as { message?: unknown; stack?: unknown } | null
  if (v && typeof v === "object" && typeof v.stack === "string") return `${prefix}: ${v.stack}`
  if (v && typeof v === "object" && typeof v.message === "string") return `${prefix}: ${v.message}`
  return `${prefix}: ${formatArg(value)}`
}

function startLogMeter(runId: unknown): LogMeter {
  const c = currentConsole()
  if (typeof runId === "string" && c && typeof c.debug === "function") {
    // The real console, never captured (the inline tail reads it).
    const realDebug = (savedConsole?.get("debug") ?? c.debug) as ConsoleFn
    try {
      realDebug.call(c, `${RUN_MARKER} ${runId}`)
    } catch {
      /* a console that throws loses the marker, never the run */
    }
  }
  const meter: LogMeter = { lines: [], bytes: 0, dropped: 0 }
  logMeters.add(meter)
  if (logMeters.size === 1 && c && !wrappedConsole) {
    savedConsole = new Map()
    wrappedConsole = new Map()
    for (const [name, level] of CONSOLE_METHODS) {
      savedConsole.set(name, c[name])
      const wrapper: ConsoleFn = (...args: unknown[]) => captureLine(level, args)
      wrappedConsole.set(name, wrapper)
      c[name] = wrapper
    }
    const g = globalThis as EventTargetLike
    if (typeof g.addEventListener === "function") {
      errorListener = (ev) =>
        captureLine("error", [errorText("Uncaught", (ev as { error?: unknown })?.error ?? ev)])
      rejectionListener = (ev) =>
        captureLine("error", [
          errorText("Unhandled rejection", (ev as { reason?: unknown })?.reason),
        ])
      g.addEventListener("error", errorListener)
      g.addEventListener("unhandledrejection", rejectionListener)
    }
  }
  return meter
}

function stopLogMeter(meter: LogMeter): void {
  logMeters.delete(meter)
  if (logMeters.size > 0 || !wrappedConsole) return
  const c = currentConsole()
  if (c && savedConsole) {
    for (const [name] of CONSOLE_METHODS) {
      if (c[name] === wrappedConsole.get(name)) c[name] = savedConsole.get(name)
    }
  }
  const g = globalThis as EventTargetLike
  if (typeof g.removeEventListener === "function") {
    if (errorListener) g.removeEventListener("error", errorListener)
    if (rejectionListener) g.removeEventListener("unhandledrejection", rejectionListener)
  }
  errorListener = undefined
  rejectionListener = undefined
  wrappedConsole = undefined
  savedConsole = undefined
}

/** The `/run` body fields the isolate reads. */
export interface WorkerRunRequest {
  exportName: string
  params: unknown
  extraArgs?: unknown[]
  approval?: unknown
  bridgeMethods: string[]
  [key: string]: unknown
}

export interface WorkerRunTimings {
  runMs: number
  bridgeCalls: number
  bridgeMsTotal: number
  /** Time spent waiting in the app's own timers (see "Sleep accounting"). */
  sleepMs: number
  /** False when another run shared the isolate meanwhile. */
  sleepExact: boolean
}

export interface WorkerRunError {
  message: string
  status?: number
  code?: string
  name?: string
  safe?: true
  retryable?: boolean
  kind: "handler"
}

interface WorkerRunLogs {
  logs?: WorkerLogLine[]
  logsDropped?: number
}

export type WorkerRunResult =
  | ({ ok: true; result: unknown; timings: WorkerRunTimings } & WorkerRunLogs)
  | ({ ok: false; error: WorkerRunError; timings: WorkerRunTimings } & WorkerRunLogs)

/** A cell `/api/app-bridge` 200 reply body. */
export type BridgeReply =
  | { data?: unknown }
  | { error: string; errorStatus?: number; errorCode?: string }

export interface WorkerBridge {
  call(method: string, args: unknown[]): Promise<unknown>
}

/** The same check the subprocess applies before it evaluates a call. */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

/** A bridge reply body -> the call's data, or the rejection createCtx expects. */
export function bridgeReplyData(reply: unknown): unknown {
  if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
    throw { message: "Malformed app bridge reply" }
  }
  const r = reply as { data?: unknown; error?: unknown; errorStatus?: unknown; errorCode?: unknown }
  if (Object.hasOwn(r, "error")) {
    const failure: { message: string; status?: number; code?: string } = {
      message: typeof r.error === "string" ? r.error : String(r.error),
    }
    if (typeof r.errorStatus === "number") failure.status = r.errorStatus
    if (typeof r.errorCode === "string") failure.code = r.errorCode
    throw failure
  }
  return r.data
}

function handlerError(err: unknown): WorkerRunError {
  const e = err as
    | { message?: unknown; name?: unknown; status?: unknown; code?: unknown; retryable?: unknown }
    | null
    | undefined
  const isObj = e !== null && typeof e === "object"
  let message: string
  try {
    message = isObj && e.message ? String(e.message) : String(err)
  } catch {
    message = "Unknown sandbox error"
  }
  const out: WorkerRunError = { message, kind: "handler" }
  if (!isObj) return out
  const safe = e.name === "ToolError"
  const status = e.status
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status < 600) {
    out.status = status
    if (!safe && typeof e.code === "string") out.code = e.code
  }
  if (safe) {
    out.safe = true
    out.code = typeof e.code === "string" ? e.code : "tool_error"
    out.retryable = e.retryable === true
  } else if (typeof e.name === "string") {
    out.name = e.name.slice(0, 64)
  }
  return out
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

/**
 * Run `mod[req.exportName](req.params, ctx, ...req.extraArgs)` with a ctx
 * built for this call only (an app may key state on the ctx object), and
 * answer with a JSON-safe result. Never throws.
 */
export async function runHandler(
  mod: Record<string, unknown>,
  req: WorkerRunRequest,
  dispatch: CtxDispatch,
): Promise<WorkerRunResult> {
  const logMeter = startLogMeter(req.runId)
  let answer: WorkerRunResult
  try {
    answer = await runHandlerInner(mod, req, dispatch)
  } finally {
    stopLogMeter(logMeter)
  }
  if (logMeter.lines.length > 0) answer.logs = logMeter.lines
  if (logMeter.dropped > 0) answer.logsDropped = logMeter.dropped
  return answer
}

async function runHandlerInner(
  mod: Record<string, unknown>,
  req: WorkerRunRequest,
  dispatch: CtxDispatch,
): Promise<WorkerRunResult> {
  const started = Date.now()
  let bridgeCalls = 0
  let bridgeMsTotal = 0
  let meter: SleepMeter | undefined
  const timings = (): WorkerRunTimings => ({
    runMs: Date.now() - started,
    bridgeCalls,
    bridgeMsTotal,
    sleepMs: meter?.sleepMs ?? 0,
    sleepExact: meter?.exact ?? true,
  })
  // Every bridge call the run started, awaited or not. A handler may fire a
  // call and return (`ctx.logger.info(...)` without await is the documented
  // pattern): the isolate drops I/O still pending once `run` returns, so the
  // run waits for them first, as the QuickJS executors' calls land before the
  // run ends. Their outcome is the handler's own business: a rejection the
  // handler never looked at does not change the result.
  const inflight = new Set<Promise<unknown>>()
  const counted: CtxDispatch = (method, args) => {
    bridgeCalls++
    const t0 = Date.now()
    const call = (async () => {
      try {
        return await dispatch(method, args)
      } finally {
        bridgeMsTotal += Date.now() - t0
      }
    })()
    inflight.add(call)
    const forget = () => inflight.delete(call)
    call.then(forget, forget)
    return call
  }
  const settleInflight = async (): Promise<void> => {
    while (inflight.size > 0) await Promise.allSettled([...inflight])
  }

  const exportName = req.exportName
  if (typeof exportName !== "string" || !SAFE_IDENTIFIER_RE.test(exportName)) {
    return {
      ok: false,
      error: { message: `Invalid export name: "${String(exportName)}"`, kind: "handler" },
      timings: timings(),
    }
  }
  const fn = Object.hasOwn(mod, exportName) ? mod[exportName] : undefined
  if (typeof fn !== "function") {
    return {
      ok: false,
      error: { message: `Export "${exportName}" not found (got ${typeof fn})`, kind: "handler" },
      timings: timings(),
    }
  }

  meter = startSleepMeter()
  try {
    const ctx = createCtx(req.bridgeMethods ?? [], req.approval ?? null, counted)
    let value: unknown
    try {
      value = await (fn as (...a: unknown[]) => unknown)(
        jsonSafe(req.params),
        ctx,
        ...(req.extraArgs ?? []),
      )
    } finally {
      await settleInflight()
    }
    let result: unknown
    try {
      result = jsonSafe(value)
    } catch (err) {
      return {
        ok: false,
        error: {
          message: `Handler result is not serializable: ${(err as Error).message}`,
          kind: "handler",
        },
        timings: timings(),
      }
    }
    return { ok: true, result, timings: timings() }
  } catch (err) {
    return { ok: false, error: handlerError(err), timings: timings() }
  } finally {
    stopSleepMeter(meter)
  }
}

/** runHandler over a loader Bridge (the contract in this file's header). */
export function runWithBridge(
  mod: Record<string, unknown>,
  req: WorkerRunRequest,
  bridge: WorkerBridge,
): Promise<WorkerRunResult> {
  return runHandler(mod, req, async (method, args) =>
    bridgeReplyData(await bridge.call(method, args)),
  )
}
