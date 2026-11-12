// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSAsyncWASMModule,
} from "quickjs-emscripten"
import { newQuickJSAsyncWASMModuleFromVariant, newVariant, RELEASE_ASYNC } from "quickjs-emscripten"
import { appsLogger as log } from "~/lib/logger"
import { resolveSandboxMemoryLimit } from "~/modules/apps/run-limits"
import { installWebCrypto } from "~/modules/apps/sandbox/webcrypto-shim"

/**
 * The 1MB asyncify QuickJS WASM binary is compiled ONCE per process and the
 * compiled `WebAssembly.Module` (machine code, no state) is shared by every
 * slot. quickjs-emscripten's async variant has no built-in caching, so the
 * previous per-slot `newQuickJSAsyncWASMModule()` ran a full fresh compile of
 * asyncify-transformed code per slot -- 4x at boot plus one per timeout-destroy
 * replacement -- which kept JSC's WASM JIT worklist thread pegged at 100%
 * indefinitely on prod. Sharing compiled code preserves the per-slot isolation
 * documented on SandboxSlot: each slot still instantiates its OWN module
 * instance (own linear memory), so an emscripten abort still poisons only that
 * slot's instance.
 */
let sharedVariantPromise: Promise<ReturnType<typeof newVariant<typeof RELEASE_ASYNC>>> | null = null

function getSharedAsyncVariant(): NonNullable<typeof sharedVariantPromise> {
  sharedVariantPromise ??= (async () => {
    // The @jitl wasm package is a TRANSITIVE dep (of quickjs-emscripten), so it
    // is not visible from this file under Bun's isolated node_modules layout --
    // anchor the resolve at quickjs-emscripten's own resolution context.
    const requireHere = createRequire(import.meta.url)
    const requireQjs = createRequire(requireHere.resolve("quickjs-emscripten"))
    const wasmPath = requireQjs.resolve("@jitl/quickjs-wasmfile-release-asyncify/wasm")
    const wasmModule = await WebAssembly.compile(await readFile(wasmPath))
    return newVariant(RELEASE_ASYNC, { wasmModule })
  })()
  return sharedVariantPromise
}

/** Fresh module INSTANCE from the shared compiled WASM code. */
export async function newAsyncModuleFromSharedCompile(): Promise<QuickJSAsyncWASMModule> {
  return newQuickJSAsyncWASMModuleFromVariant(await getSharedAsyncVariant())
}

export interface SandboxSlot {
  id: number
  /**
   * Each slot owns its OWN WASM module instance. A single module shared across
   * slots is a process-wide single point of failure: destroying a timed-out
   * runtime whose GC list is non-empty (in-flight bridge promises leave live
   * handles) trips QuickJS's `list_empty(&rt->gc_obj_list)` assertion in
   * JS_FreeRuntime, which emscripten-aborts the module — and an aborted module
   * hangs EVERY subsequent execution in the process until restart. Per-slot
   * modules contain any abort to the one slot, and let a poisoned slot be
   * reclaimed by JS GC (drop the reference) instead of a native free.
   */
  module: QuickJSAsyncWASMModule
  runtime: QuickJSAsyncRuntime
  context: QuickJSAsyncContext
  overflow: boolean // true = not pooled, destroyed after use
}

export interface PoolStats {
  total: number
  available: number
  inUse: number
}

export interface SandboxPoolOptions {
  initialSize?: number
  maxSize?: number
  memoryLimitBytes?: number
  /** How long an acquire may queue when the pool is at maxSize before failing. */
  acquireTimeoutMs?: number
}

export interface SandboxPool {
  acquire(): Promise<SandboxSlot>
  release(slot: SandboxSlot): void
  destroy(slot: SandboxSlot): void
  stats(): PoolStats
  shutdown(): Promise<void>
}

// 32MB default heap. The original 8MB was "sufficient for business logic
// handlers" but not for sync jobs: one gmail message fetch (bridge-capped at
// 1MB) materializes the response string + its JSON.parse tree + the decoded
// base64 body simultaneously, and alongside a history.list page that peaked
// past 8MB — prod OOM-looped an incremental sync (2026-07-24). 32MB gives a
// single bounded message pipeline ~30x headroom; worst-case pool usage
// (24 slots x 32MB = 768MB) stays within the worker RSS recycling envelope.
// Env-overridable for emergency tuning without a redeploy.
const DEFAULT_MEMORY_LIMIT = resolveSandboxMemoryLimit()
const DEFAULT_MAX_STACK_SIZE = 256 * 1024 // 256KB stack

/**
 * JSC options every process that runs QuickJS WASM must START with: the API
 * server (its trusted in-process pool) and every sandbox worker. JSC reads
 * them once at process start, so they can only be set in the launch env.
 *
 * Once a QuickJS execution has run hot, JSC tiers the asyncify WASM module up
 * to its optimizing OMG compiler on a background JIT thread, and compiling
 * those very large functions allocates native memory the process never gets
 * back. Measured on one QuickJS loop in plain bun: 360 MB to 3.3 GB RSS in 40 s
 * with the default tiers, flat at 100 MB with OMG off, about 10% fewer
 * iterations. The compile keeps growing after the execution has returned (544
 * MB to 2.7 GB in 22 s of idle), which is how an e2e server reached 7 GB and a
 * sandbox worker went far past its RSS ceiling while nothing was running in
 * it. The baseline BBQ JIT stays on.
 */
export const QUICKJS_HOST_JSC_ENV: Readonly<Record<string, string>> = Object.freeze({
  BUN_JSC_useOMGJIT: "0",
})

// Concurrency ceiling for the trusted (in-process) sandbox pool. Env-overridable
// so a saturated prod node can be widened without a redeploy. Default 24: raised
// from the original 12 after prod saturation (inUse:13 queued:10 -> acquire
// failures on tickets:get / shopify:home_load). Keep comfortably BELOW the DB
// pool size — every running sandbox execution can hold one RLS transaction, so
// this cap is also what stops sandbox saturation from starving the DB pool.
const DEFAULT_POOL_MAX_SIZE = 24
export function resolveSandboxPoolMaxSize(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.SANDBOX_POOL_MAX_SIZE)
  return Number.isFinite(override) && override > 0 ? Math.floor(override) : DEFAULT_POOL_MAX_SIZE
}

// Globals that bypass QuickJS memory tracking by allocating directly in WASM linear memory.
// Must be removed from every fresh context before app code runs.
const BLOCKED_GLOBALS = [
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]
const HARDEN_SCRIPT = BLOCKED_GLOBALS.map((g) => `delete globalThis.${g}`).join(";")

let nextSlotId = 0

function hardenContext(ctx: QuickJSAsyncContext): void {
  const result = ctx.evalCode(HARDEN_SCRIPT, "sandbox-harden.js")
  if (result.error) {
    result.error.dispose()
  } else {
    result.value.dispose()
  }
  // WebCrypto (webcrypto-shim.ts): the crypto primitive apps share with Workers.
  installWebCrypto(ctx)
}

async function createSlot(memoryLimit: number, overflow = false): Promise<SandboxSlot> {
  const module = await newAsyncModuleFromSharedCompile()
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(memoryLimit)
  runtime.setMaxStackSize(DEFAULT_MAX_STACK_SIZE)
  const context = runtime.newContext()
  hardenContext(context)
  return { id: nextSlotId++, module, runtime, context, overflow }
}

function disposeSlot(slot: SandboxSlot): void {
  try {
    slot.runtime.executePendingJobs()
  } catch {
    /* ok */
  }
  try {
    slot.context.dispose()
  } catch {
    /* already disposed */
  }
  try {
    slot.runtime.dispose()
  } catch {
    /* already disposed */
  }
}

// Global singleton pool for the process
let globalPool: SandboxPool | null = null

export async function initSandboxPool(opts: SandboxPoolOptions = {}): Promise<void> {
  if (globalPool) return
  globalPool = await createSandboxPool(opts)
}

export function getSandboxPool(): SandboxPool {
  if (!globalPool) throw new Error("Sandbox pool not initialized — call initSandboxPool() first")
  return globalPool
}

export async function shutdownSandboxPool(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return
  }
  if (globalPool) {
    await globalPool.shutdown()
    globalPool = null
  }
}

export async function createSandboxPool(opts: SandboxPoolOptions = {}): Promise<SandboxPool> {
  const initialSize = opts.initialSize ?? 4
  // Hard concurrency ceiling — REPLACES the old grow-to-32-plus-overflow
  // model. Unbounded growth under CPU saturation makes every execution slower
  // (dozens of QuickJS modules thrash the cores and the cgroup memory limit),
  // which times out more handlers, which spawned MORE slots — the observed
  // death spiral. Keep this comfortably BELOW the DB pool size: every running
  // sandbox execution can hold one RLS transaction, so the cap is also what
  // stops sandbox saturation from starving the DB pool.
  const maxSize = opts.maxSize ?? resolveSandboxPoolMaxSize()
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? 15_000
  const memoryLimit = opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT

  const available: SandboxSlot[] = []
  const inUse = new Set<number>()
  const waiters: Array<{
    resolve: (slot: SandboxSlot) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }> = []
  let totalPooled = 0
  let shutdownCalled = false

  function handOff(slot: SandboxSlot): boolean {
    const waiter = waiters.shift()
    if (!waiter) return false
    clearTimeout(waiter.timer)
    inUse.add(slot.id)
    waiter.resolve(slot)
    return true
  }

  // Pre-warm slots (each carries its own WASM module — see SandboxSlot)
  for (let i = 0; i < initialSize; i++) {
    const slot = await createSlot(memoryLimit)
    available.push(slot)
    totalPooled++
  }

  return {
    async acquire(): Promise<SandboxSlot> {
      if (shutdownCalled) throw new Error("Pool is shut down")

      if (available.length > 0) {
        const slot = available.pop()!
        inUse.add(slot.id)
        return slot
      }

      if (totalPooled < maxSize) {
        const slot = await createSlot(memoryLimit)
        totalPooled++
        inUse.add(slot.id)
        return slot
      }

      // At the ceiling: queue with a bounded wait instead of spawning overflow
      // modules. A saturated pool fails fast (callers retry at the job layer)
      // rather than compounding the saturation.
      log.warn(
        { maxSize, inUse: inUse.size, queued: waiters.length + 1 },
        "Sandbox pool saturated — queuing acquire",
      )
      return new Promise<SandboxSlot>((resolve, reject) => {
        const waiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const idx = waiters.indexOf(waiter)
            if (idx >= 0) waiters.splice(idx, 1)
            reject(
              new Error(
                `Sandbox pool saturated: no slot freed within ${acquireTimeoutMs}ms (${maxSize} in use)`,
              ),
            )
          }, acquireTimeoutMs),
        }
        waiters.push(waiter)
      })
    },

    release(slot: SandboxSlot): void {
      inUse.delete(slot.id)
      if (slot.overflow) {
        disposeSlot(slot)
        return
      }
      // Drain pending QuickJS jobs then reset context for reuse
      try {
        slot.runtime.executePendingJobs()
      } catch {
        /* ok */
      }
      try {
        slot.context.dispose()
      } catch {
        /* ok */
      }
      slot.context = slot.runtime.newContext()
      hardenContext(slot.context)
      if (!handOff(slot)) available.push(slot)
    },

    destroy(slot: SandboxSlot): void {
      inUse.delete(slot.id)
      // destroy() is the abandon-in-flight path (executor timeout). The runtime
      // very likely still holds live GC objects (pending bridge promises,
      // undisposed handles) — calling JS_FreeRuntime on it trips QuickJS's
      // gc_obj_list assertion, which emscripten-aborts the WASM module. Since
      // the slot owns its module, we simply DROP every reference and let the
      // JS GC reclaim the whole module instance; no native free, no abort.
      if (!slot.overflow) {
        totalPooled--
        // Create replacement asynchronously
        createSlot(memoryLimit)
          .then((replacement) => {
            if (!shutdownCalled) {
              totalPooled++
              if (!handOff(replacement)) available.push(replacement)
            } else {
              disposeSlot(replacement)
            }
          })
          .catch((err) => {
            log.error({ err }, "Sandbox pool: failed to create replacement slot")
          })
      }
    },

    stats(): PoolStats {
      return { total: totalPooled, available: available.length, inUse: inUse.size }
    },

    async shutdown(): Promise<void> {
      shutdownCalled = true
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error("Pool is shut down"))
      }
      for (const slot of available) disposeSlot(slot)
      available.length = 0
      totalPooled = 0
      inUse.clear()
    },
  }
}
