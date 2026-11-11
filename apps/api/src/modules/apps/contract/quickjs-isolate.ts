// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contract harness's QuickJS executor: one QuickJS context, hardened like
// a pool slot (sandbox/pool.ts), evaluates the app's script bundle ONCE; every
// run then installs its own bridge and `__ctx` (the executor's own shim,
// sandbox/executor.ts) and calls the export in that same context. Unlike a
// production QuickJS run, which evaluates the bundle afresh per call, module
// state therefore survives from run to run, as it does in a Workers isolate.
//
// Limits: the heap is the context runtime's memory limit; the wall clock is
// an interrupt handler on a deadline (the production executor's mechanism)
// plus a check between event-loop turns.

import type { QuickJSHandle } from "quickjs-emscripten"
import { installBridgeAndCtx, marshalToContext } from "~/modules/apps/sandbox/executor"
import { createSandboxPool, type SandboxPool, type SandboxSlot } from "~/modules/apps/sandbox/pool"
import {
  type ContractExecutor,
  type ContractIsolate,
  type ContractRunOutcome,
  type ContractRunRequest,
  type ContractSource,
  VIRTUAL_TIME_PRELUDE,
} from "./isolate"

/** Bridge calls of a run must settle within this, past the run's own deadline. */
const BRIDGE_CALL_GRACE_MS = 10_000

function evalOrThrow(slot: SandboxSlot, code: string, file: string, label: string): void {
  const r = slot.context.evalCode(code, file)
  if (r.error) {
    const err = slot.context.dump(r.error)
    r.error.dispose()
    const msg =
      typeof err === "object" && err !== null
        ? `${(err as { name?: string }).name ?? "Error"}: ${(err as { message?: string }).message ?? JSON.stringify(err)}`
        : String(err)
    throw new Error(`${label}: ${msg}`)
  }
  r.value.dispose()
}

function callContract(slot: SandboxSlot, method: "reset" | "sleepMs" | "tick"): unknown {
  const ctx = slot.context
  const contract = ctx.getProp(ctx.global, "__contract")
  const fn = ctx.getProp(contract, method)
  const r = ctx.callFunction(fn, contract)
  fn.dispose()
  contract.dispose()
  if (r.error) {
    const err = ctx.dump(r.error)
    r.error.dispose()
    throw new Error(`timer callback failed: ${JSON.stringify(err)}`)
  }
  const value = ctx.dump(r.value)
  r.value.dispose()
  return value
}

function errorMessage(value: unknown): string {
  if (typeof value === "object" && value !== null && "message" in value) {
    return String((value as { message: unknown }).message)
  }
  return String(value)
}

function isOutOfMemory(message: string): boolean {
  return /out of memory/i.test(message)
}

class QuickJsContractIsolate implements ContractIsolate {
  constructor(
    private readonly pool: SandboxPool,
    private readonly slot: SandboxSlot,
  ) {}

  async run(req: ContractRunRequest): Promise<ContractRunOutcome> {
    const { slot } = this
    const ctx = slot.context
    const started = Date.now()
    const deadline = started + req.limits.wallMs
    let disposed = false
    const handles: QuickJSHandle[] = []
    slot.runtime.setInterruptHandler(() => Date.now() > deadline)
    const done = (o: Omit<ContractRunOutcome, "wallMs" | "sleepMs">): ContractRunOutcome => {
      let sleepMs = 0
      try {
        sleepMs = Number(callContract(slot, "sleepMs")) || 0
      } catch {
        /* the context is unusable; report no sleep */
      }
      return { ...o, wallMs: Date.now() - started, sleepMs }
    }
    try {
      callContract(slot, "reset")
      installBridgeAndCtx(
        ctx,
        req.bridge,
        handles,
        () => disposed,
        req.limits.wallMs + BRIDGE_CALL_GRACE_MS,
      )
      const fn = ctx.getProp(ctx.global, req.exportName)
      if (ctx.typeof(fn) !== "function") {
        fn.dispose()
        return done({ ok: false, error: `Export "${req.exportName}" not found in bundle` })
      }
      const argHandles = [
        marshalToContext(ctx, req.params),
        ctx.getProp(ctx.global, "__ctx"),
        ...(req.extraArgs ?? []).map((a) => marshalToContext(ctx, a)),
      ]
      const call = ctx.callFunction(fn, ctx.undefined, ...argHandles)
      fn.dispose()
      for (const h of argHandles) if (h.alive) h.dispose()
      if (call.error) {
        const err = errorMessage(ctx.dump(call.error))
        call.error.dispose()
        if (Date.now() > deadline) return done({ ok: false, error: err, overrun: "wall" })
        return done({ ok: false, error: err, ...(isOutOfMemory(err) ? { overrun: "memory" } : {}) })
      }
      const value = call.value
      const state = ctx.getPromiseState(value)
      if ((state as { notAPromise?: boolean }).notAPromise) {
        const result = ctx.dump(value)
        value.dispose()
        return done({ ok: true, result: jsonSafe(result) })
      }
      if (state.type === "fulfilled") state.value.dispose()
      else if (state.type === "rejected") state.error.dispose()
      const native = ctx.resolvePromise(value)
      value.dispose()
      let settled = false
      const settledPromise = native.then((r) => {
        settled = true
        return r
      })
      // Pump: run pending jobs; when nothing is left to run and no bridge call
      // is in flight, fire the next virtual timer; past the deadline, stop.
      while (!settled) {
        slot.runtime.executePendingJobs()
        if (settled) break
        if (Date.now() > deadline) {
          return done({ ok: false, error: "App execution timed out", overrun: "wall" })
        }
        await new Promise((r) => setImmediate(r))
        if (settled) break
        if (!slot.runtime.hasPendingJob() && !this.bridgeBusy(req)) {
          const fired = callContract(slot, "tick")
          if (!fired && !this.bridgeBusy(req)) {
            // Nothing can move it: give in-flight host promises one more turn.
            await new Promise((r) => setTimeout(r, 1))
            slot.runtime.executePendingJobs()
            if (!settled && !slot.runtime.hasPendingJob() && !this.bridgeBusy(req)) {
              await new Promise((r) => setTimeout(r, 5))
              slot.runtime.executePendingJobs()
              if (!settled && !slot.runtime.hasPendingJob() && !this.bridgeBusy(req)) {
                return done({ ok: false, error: "Run never settled (nothing left to wait on)" })
              }
            }
          }
        }
      }
      const resolved = await settledPromise
      if (resolved.error) {
        const err = errorMessage(ctx.dump(resolved.error))
        resolved.error.dispose()
        return done({ ok: false, error: err, ...(isOutOfMemory(err) ? { overrun: "memory" } : {}) })
      }
      const result = ctx.dump(resolved.value)
      resolved.value.dispose()
      return done({ ok: true, result: jsonSafe(result) })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (Date.now() > deadline) return done({ ok: false, error: message, overrun: "wall" })
      return done({
        ok: false,
        error: message,
        ...(isOutOfMemory(message) ? { overrun: "memory" } : {}),
      })
    } finally {
      disposed = true
      for (const h of handles) {
        try {
          h.dispose()
        } catch {
          /* ok */
        }
      }
    }
  }

  /** In-flight async bridge calls of the current run (counted by the bridge, see harness.ts). */
  private bridgeBusy(req: ContractRunRequest): boolean {
    const counter = (req.bridge as { [INFLIGHT]?: () => number })[INFLIGHT]
    return typeof counter === "function" ? counter() > 0 : false
  }

  dispose(): void {
    this.pool.destroy(this.slot)
    void this.pool.shutdown()
  }
}

/** A bridge may expose its in-flight call count under this symbol (replay-bridge.ts). */
export const INFLIGHT = Symbol.for("liaison.contract.inflight")

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null
  const text = JSON.stringify(value)
  return text === undefined ? null : JSON.parse(text)
}

export const quickJsContractExecutor: ContractExecutor = {
  name: "quickjs",
  async open(source: ContractSource, opts: { memoryBytes: number }): Promise<ContractIsolate> {
    if (source.script === undefined) throw new Error("the QuickJS executor needs a script bundle")
    const pool = await createSandboxPool({
      initialSize: 1,
      maxSize: 1,
      memoryLimitBytes: opts.memoryBytes,
    })
    const slot = await pool.acquire()
    const isolate = new QuickJsContractIsolate(pool, slot)
    try {
      evalOrThrow(slot, VIRTUAL_TIME_PRELUDE, "contract-prelude.js", "Prelude error")
      // The bundle's top level runs once, under a generous deadline of its own.
      const evalDeadline = Date.now() + 30_000
      slot.runtime.setInterruptHandler(() => Date.now() > evalDeadline)
      evalOrThrow(slot, source.script, "handler-bundle.js", "Bundle evaluation error")
    } catch (err) {
      isolate.dispose()
      throw err
    }
    return isolate
  },
}
