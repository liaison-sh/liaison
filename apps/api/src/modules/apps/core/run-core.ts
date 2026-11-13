// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Runs one handler of a core app's server module (registry.ts) in this
// process: the module's named export, called with the run's params, a typed
// host ctx over the run's bridge (ctx.ts) and any extra args. No sandbox, no
// shim, no bundle. runApp calls it for every entry kind (tools, preflights,
// jobs, events, webhooks, exports, attention).

import { sandboxCancelledError } from "~/lib/failure-severity"
import {
  CORE_OPEN_TRANSACTION,
  type CoreApproval,
  type CoreCtx,
  type OpenTransaction,
} from "~/modules/apps/core/ctx"
import type { CoreAppModule } from "~/modules/apps/core/registry"
import { resolveSandboxDefaultTimeoutMs } from "~/modules/apps/run-limits"

type Bridge = Record<string, (...args: any[]) => any>

export interface RunCoreOptions {
  module: CoreAppModule
  appName: string
  exportName: string
  params: unknown
  extraArgs?: unknown[]
  bridge: Bridge
  /** The bridge runs on a transaction held for the whole run. */
  holdsTx: boolean
  approval?: CoreApproval | null
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * A run's stop line. Once the run timed out or was cancelled, every ctx call
 * throws, so a handler still running settles at its next host call and does
 * nothing more, as a sandboxed run stops at its deadline. The error says
 * "interrupted", as the sandbox's deadline error does.
 */
export interface RunFence {
  stopped: Error | null
}

/** The bridge, with each method refusing once the fence is down. */
function fencedBridge(bridge: Bridge, fence: RunFence | undefined): Bridge {
  if (!fence) return bridge
  const fenced: Bridge = {}
  for (let o: object | null = bridge; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Reflect.ownKeys(o)) {
      if (key === "constructor" || Object.hasOwn(fenced, key)) continue
      const value = (bridge as Record<PropertyKey, unknown>)[key]
      Object.defineProperty(fenced, key, {
        enumerable: typeof key === "string",
        value:
          typeof value === "function"
            ? (...args: unknown[]) => {
                if (fence.stopped) throw fence.stopped
                return (value as (...a: unknown[]) => unknown)(...args)
              }
            : value,
      })
    }
  }
  return fenced
}

/** The ctx of a run: the bridge's methods, `approval`, and `transaction`. */
export function coreCtxOf(
  bridge: Bridge,
  holdsTx: boolean,
  approval: CoreApproval | null,
  fence?: RunFence,
): CoreCtx<Bridge> {
  const ctx = Object.create(fencedBridge(bridge, fence)) as CoreCtx<Bridge> &
    Record<string, unknown>
  Object.defineProperty(ctx, "approval", { value: approval, enumerable: false })
  Object.defineProperty(ctx, "transaction", {
    enumerable: false,
    value: <T>(fn: (c: CoreCtx<Bridge>) => Promise<T>): Promise<T> => {
      if (fence?.stopped) return Promise.reject(fence.stopped)
      if (holdsTx) return fn(ctx)
      const open = (bridge as { [CORE_OPEN_TRANSACTION]?: OpenTransaction })[CORE_OPEN_TRANSACTION]
      if (!open) {
        return Promise.reject(new Error("ctx.transaction: this run has no transaction to open"))
      }
      return open((txBridge) => fn(coreCtxOf(txBridge, true, approval, fence)))
    },
  })
  return ctx
}

export async function runCoreHandler(opts: RunCoreOptions): Promise<unknown> {
  if (opts.signal?.aborted) throw sandboxCancelledError()
  const mod = await opts.module.load()
  const fn = mod[opts.exportName]
  if (typeof fn !== "function") {
    throw new Error(`Export "${opts.exportName}" not found in core app ${opts.appName}`)
  }
  const fence: RunFence = { stopped: null }
  const ctx = coreCtxOf(opts.bridge, opts.holdsTx, opts.approval ?? null, fence)
  const timeoutMs = opts.timeoutMs ?? resolveSandboxDefaultTimeoutMs()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const run = Promise.resolve().then(() => fn(opts.params, ctx, ...(opts.extraArgs ?? [])))
  try {
    const result = await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          fence.stopped = new Error("App execution timed out (interrupted)")
          reject(new Error("App execution timed out"))
        }, timeoutMs)
        if (opts.signal) {
          onAbort = () => {
            fence.stopped = sandboxCancelledError()
            reject(fence.stopped)
          }
          opts.signal.addEventListener("abort", onAbort, { once: true })
        }
      }),
    ])
    // The same value a sandboxed run answers: plain JSON data, undefined as null.
    return result === undefined ? null : JSON.parse(JSON.stringify(result))
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort)
    // The run is over: work it left behind reaches the host no more.
    fence.stopped ??= new Error("App execution ended (interrupted)")
    // A handler that outlives its timeout settles in the background; its error is
    // not the run's.
    run.catch(() => {})
  }
}
