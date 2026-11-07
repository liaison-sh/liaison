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
//   {ok:true, result, timings:{runMs, bridgeCalls, bridgeMsTotal}}
//   {ok:false, error:{message, status?, code?, name?, safe?, retryable?, kind:"handler"},
//    timings:{...}}
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

export type WorkerRunResult =
  | { ok: true; result: unknown; timings: WorkerRunTimings }
  | { ok: false; error: WorkerRunError; timings: WorkerRunTimings }

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
  const started = Date.now()
  let bridgeCalls = 0
  let bridgeMsTotal = 0
  const timings = (): WorkerRunTimings => ({
    runMs: Date.now() - started,
    bridgeCalls,
    bridgeMsTotal,
  })
  const counted: CtxDispatch = async (method, args) => {
    bridgeCalls++
    const t0 = Date.now()
    try {
      return await dispatch(method, args)
    } finally {
      bridgeMsTotal += Date.now() - t0
    }
  }

  const name = req.exportName
  if (typeof name !== "string" || !SAFE_IDENTIFIER_RE.test(name)) {
    return {
      ok: false,
      error: { message: `Invalid export name: "${String(name)}"`, kind: "handler" },
      timings: timings(),
    }
  }
  const fn = Object.hasOwn(mod, name) ? mod[name] : undefined
  if (typeof fn !== "function") {
    return {
      ok: false,
      error: { message: `Export "${name}" not found (got ${typeof fn})`, kind: "handler" },
      timings: timings(),
    }
  }

  try {
    const ctx = createCtx(req.bridgeMethods ?? [], req.approval ?? null, counted)
    const value = await (fn as (...a: unknown[]) => unknown)(
      jsonSafe(req.params),
      ctx,
      ...(req.extraArgs ?? []),
    )
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
