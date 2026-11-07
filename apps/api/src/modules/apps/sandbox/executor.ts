// SPDX-License-Identifier: FSL-1.1-ALv2
import type { QuickJSAsyncContext, QuickJSHandle } from "quickjs-emscripten"
import { sandboxCancelledError } from "~/lib/failure-severity"
import {
  applyTypedFailure,
  newBridgeRejection,
  typedBridgeFailure,
} from "~/modules/apps/sandbox/bridge-rejection"
import { SHIM_RULES } from "~/modules/apps/sandbox/ctx-shim"
import type { SandboxPool } from "~/modules/apps/sandbox/pool"

export interface ExecuteOptions {
  pool: SandboxPool
  bundleSource: string
  exportName: string
  params: unknown
  /**
   * Extra positional args appended after `(params, ctx)`. Optional —
   * defaults to none. Used by manifest webhook routing to pass `headers`
   * as the 3rd arg (handler signature `(payload, ctx, headers)`).
   */
  extraArgs?: unknown[]
  bridge: Record<string, (...args: any[]) => any>
  timeoutMs?: number
  /**
   * Cancellation signal from the caller (e.g. the incoming HTTP request).
   * Only observed BEFORE a slot is acquired: an already-aborted signal skips
   * acquiring a slot entirely. An in-flight execution is never interrupted
   * (mirrors the worker pool's contract in worker-pool.ts).
   */
  signal?: AbortSignal
}

/**
 * Per-handler sandbox execution ceiling. Production pins a tight 5s (and IGNORES the env override — a
 * hung/abusive third-party handler must never hold a worker). Non-production defaults to 60s but
 * honours LIAISON_SANDBOX_TIMEOUT_MS: the chaos `agent_run` handler runs an ENTIRE multi-turn agent
 * conversation inside ONE sandboxed execution, so a long export/customs scenario (10-15 Flash-Lite
 * turns) legitimately exceeds 60s and was being cut off ("App execution timed out") BEFORE its
 * turnBudget — the conductor's real completion boundary. Chaos sets a generous value so the agent
 * runs to its turnBudget instead of an arbitrary wall-clock.
 */
export function resolveSandboxDefaultTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.NODE_ENV === "production") return 5_000
  const override = Number(env.LIAISON_SANDBOX_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : 60_000
}

const DEFAULT_TIMEOUT_MS = resolveSandboxDefaultTimeoutMs()

/**
 * Hard upper bound on a manifest-declared per-tool `timeoutMs`. A known-heavy
 * fan-out read (shopify `home_load`, tickets `get`) legitimately needs more than
 * the tight 5s prod default, so the executor honours the tool's declared budget
 * unclamped by NODE_ENV — but a third-party manifest must never be able to pin a
 * worker for minutes, so the declared value is capped here. Env-overridable for
 * an exceptional deployment. Tools that declare nothing keep the tight default.
 * The bound is 120s: high enough not to reduce the legitimate long-running
 * declarations already shipped (invoicing PDF render 120s, boxtal label buys
 * 60s), low enough that a runaway third-party manifest can't pin a worker for
 * minutes on end.
 */
export function resolveSandboxMaxToolTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const override = Number(env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : 120_000
}

/**
 * Resolve the effective execution budget for a tool. `declared` is the manifest
 * `timeoutMs` (undefined when the tool declares nothing). A declared value is
 * honoured up to `resolveSandboxMaxToolTimeoutMs()` (and never below the base
 * default); undefined falls through to the base default. This is the single
 * chokepoint that lets a heavy tool raise its own ceiling in prod without
 * letting an arbitrary manifest hold a worker indefinitely.
 */
export function resolveToolTimeoutMs(
  declared: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0) return undefined
  const base = resolveSandboxDefaultTimeoutMs(env)
  const max = resolveSandboxMaxToolTimeoutMs(env)
  return Math.min(Math.max(declared, base), max)
}

export async function executeInSandbox(opts: ExecuteOptions): Promise<unknown> {
  const {
    pool,
    bundleSource,
    exportName,
    params,
    extraArgs,
    bridge,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = opts

  if (signal?.aborted) {
    throw sandboxCancelledError()
  }

  const slot = await pool.acquire()
  const ctx = slot.context
  let slotFinished = false
  let timedOut = false
  // Set once the slot is returned to the pool (destroyed or released). A host
  // bridge promise that resolves AFTER this point must not touch the QuickJS
  // context/runtime — on timeout the slot is destroyed (context + runtime
  // disposed), and a late marshal/resolve/dispose would operate on freed WASM
  // handles and can crash or corrupt the host process. After release the slot
  // is recycled, so a late callback would also corrupt the next execution.
  let disposed = false
  let timeout: ReturnType<typeof setTimeout> | null = null
  const bridgeHandles: QuickJSHandle[] = []
  let callValueHandle: QuickJSHandle | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true
      reject(new Error("App execution timed out"))
    }, timeoutMs)
  })

  // Set up timeout
  const deadline = Date.now() + timeoutMs
  slot.runtime.setInterruptHandler(() => Date.now() > deadline)

  try {
    // 1+2. One host bridge dispatcher plus the `__ctx` object, built in this
    // fresh context by a constant shim from data (see installBridgeAndCtx).
    // Bridge calls are bounded past the execution ceiling: they must settle
    // even after the handler as a whole has timed out, or their closures pin
    // the destroyed slot's WASM module forever (see bridgeCallWithTimeout).
    installBridgeAndCtx(ctx, bridge, bridgeHandles, () => disposed, timeoutMs + 10_000)

    // 3. Evaluate handler bundle (fresh module evaluation each time)
    const bundleResult = ctx.evalCode(bundleSource, "handler-bundle.js")
    if (bundleResult.error) {
      const err = ctx.dump(bundleResult.error)
      bundleResult.error.dispose()
      // QuickJS error dumps are objects ({name, message, stack}) — stringify so
      // the real failure reaches the log instead of "[object Object]".
      const detail =
        typeof err === "object" && err !== null
          ? `${(err as { name?: string }).name ?? "Error"}: ${(err as { message?: string }).message ?? JSON.stringify(err)}\n${(err as { stack?: string }).stack ?? ""}`
          : String(err)
      throw new Error(`Bundle evaluation error: ${detail}`)
    }
    bundleResult.value.dispose()

    // 4. Check export exists
    const fnHandle = ctx.getProp(ctx.global, exportName)
    const fnType = ctx.typeof(fnHandle)
    if (fnType !== "function") {
      fnHandle.dispose()
      throw new Error(`Export "${exportName}" not found in bundle (got ${fnType})`)
    }
    // 5. Call handler — callFunction returns synchronously; if the handler is async,
    //    the result is a QuickJS promise handle that we resolve via ctx.resolvePromise()
    const paramsHandle = marshalToContext(ctx, params)
    const ctxHandle = ctx.getProp(ctx.global, "__ctx")
    const extraHandles = (extraArgs ?? []).map((a) => marshalToContext(ctx, a))
    const callResult = ctx.callFunction(
      fnHandle,
      ctx.undefined,
      paramsHandle,
      ctxHandle,
      ...extraHandles,
    )
    fnHandle.dispose()
    paramsHandle.dispose()
    ctxHandle.dispose()
    for (const h of extraHandles) {
      try {
        h.dispose()
      } catch {
        /* ok */
      }
    }
    if (callResult.error) {
      const errVal = ctx.dump(callResult.error)
      try {
        callResult.error.dispose()
      } catch {
        /* ok */
      }
      const msg = typeof errVal === "object" && errVal?.message ? errVal.message : String(errVal)
      const sandboxStack =
        typeof errVal === "object" && typeof errVal?.stack === "string" ? errVal.stack : undefined
      throw new Error(sandboxStack ? `${msg}\n[sandbox] ${sandboxStack}` : msg)
    }
    callValueHandle = callResult.value

    // Check if the result is a promise (async handler)
    const promiseState = ctx.getPromiseState(callValueHandle)
    // A settled state hands out a new handle of its own, which would pin the context.
    if (!(promiseState as any).notAPromise) {
      if (promiseState.type === "fulfilled") promiseState.value.dispose()
      else if (promiseState.type === "rejected") promiseState.error.dispose()
    }
    let result: unknown
    if ((promiseState as any).notAPromise) {
      // Synchronous handler — dump directly
      result = ctx.dump(callValueHandle)
      try {
        callValueHandle.dispose()
        callValueHandle = null
      } catch {
        /* ok */
      }
    } else {
      // QuickJS async-function bodies run as microtasks. Without an awaited bridge
      // call to trigger executePendingJobs, an immediately-fulfilled handler's
      // promise stays pending. Pump the runtime on a 1ms interval until the
      // native promise returned by resolvePromise settles.
      slot.runtime.executePendingJobs()
      let settled = false
      const drainInterval = setInterval(() => {
        if (settled) return
        try {
          slot.runtime.executePendingJobs()
        } catch {
          /* ok — runtime may be torn down */
        }
      }, 1)
      let resolved: Awaited<ReturnType<typeof ctx.resolvePromise>>
      try {
        resolved = await Promise.race([ctx.resolvePromise(callValueHandle), timeoutPromise])
      } finally {
        settled = true
        clearInterval(drainInterval)
      }
      try {
        callValueHandle.dispose()
        callValueHandle = null
      } catch {
        /* ok */
      }
      if (resolved.error) {
        const errVal = ctx.dump(resolved.error)
        try {
          resolved.error.dispose()
        } catch {
          /* ok */
        }
        // Carry the QuickJS stack through — a bare "not a function" with only a
        // host-side stack is undiagnosable (the sandbox callsite is the signal).
        const msg = typeof errVal === "object" && errVal?.message ? errVal.message : String(errVal)
        const sandboxStack =
          typeof errVal === "object" && typeof errVal?.stack === "string" ? errVal.stack : undefined
        throw applyTypedFailure(
          new Error(sandboxStack ? `${msg}\n[sandbox] ${sandboxStack}` : msg),
          errVal,
        )
      }
      result = ctx.dump(resolved.value)
      try {
        resolved.value.dispose()
      } catch {
        /* ok */
      }
    }

    return result ?? null
  } catch (err: any) {
    if (timedOut || Date.now() > deadline) throw new Error("App execution timed out")
    throw err
  } finally {
    if (timeout) clearTimeout(timeout)
    if (callValueHandle) {
      try {
        callValueHandle.dispose()
      } catch {
        /* ok */
      }
    }
    for (const h of bridgeHandles) {
      try {
        h.dispose()
      } catch {
        /* ok */
      }
    }
    if (!slotFinished) {
      slotFinished = true
      // Mark disposed BEFORE returning the slot so any in-flight host bridge
      // promise that settles after this point short-circuits instead of
      // touching the (now freed or recycled) context.
      disposed = true
      if (timedOut) {
        pool.destroy(slot)
      } else {
        pool.release(slot)
      }
    }
  }
}

/**
 * Bound a host bridge call so its promise ALWAYS settles. An unsettled bridge
 * promise (hung DB acquire, wedged upstream HTTP) pins the whole QuickJS WASM
 * module via the resolve/reject closures — after a timeout-destroy the module
 * can never be garbage-collected, which is exactly the memory spiral observed
 * under load (leaked modules -> cgroup limit -> GC thrash -> more timeouts).
 * The underlying operation may still complete later; only the sandbox-facing
 * promise is abandoned, mirroring what the executor timeout already does to
 * the handler as a whole.
 */
function bridgeCallWithTimeout<T>(run: () => Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    Promise.resolve()
      .then(run)
      .finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`bridge call ${label} timed out after ${ms}ms`)),
        ms,
      )
    }),
  ])
}

/** A host bridge method that returns a promise (the sandbox gets a QuickJS promise). */
function isAsyncBridge(fn: unknown): boolean {
  return (
    (fn as { constructor?: { name?: string } } | undefined)?.constructor?.name === "AsyncFunction"
  )
}

/**
 * The `__ctx` shim's source. It is a CONSTANT: the same text for every call,
 * whatever the app, org, user or bridge, so it carries no caller data. What
 * differs per call (the bridge method names, the sync getters' values, the
 * approval envelope) reaches the fresh context as data (`specJson`, parsed
 * with JSON.parse), never as code.
 *
 * It used to be generated per call with one entry per bridge method (about
 * 200, so about 25 KB of source compiled per call), next to one host function
 * and one `__bridge_<name>` global per method: together most of the cost of a
 * sandboxed call. Now one host function (`dispatch`, bound to this call's
 * bridge) serves every method and each `__ctx` member is one closure over its
 * method name. No `__bridge_<name>` globals exist any more: `__ctx` is the
 * only way to the host.
 *
 * Members come in three kinds:
 *  - "a" (async) auto-detects two call shapes by inspecting the args.
 *    RAW shape (mail/tickets pattern): every arg is a primitive; the caller
 *    already serialized its structured data, args and return pass through.
 *    SDK shape (shopify / `@liaison/app-sdk` pattern): some arg is an object;
 *    non-primitive args are stringified, a string return best-effort parsed.
 *  - "st" (structured, async) always best-effort parses a string return: the
 *    generic kernel read/CRUD affordances (`ctx.kernel.*`, `ctx.db.*`) are
 *    documented to return already-parsed data, and their all-primitive-arg
 *    reads (`ctx.db.findOne(entity, id)`) would otherwise leak a JSON string.
 *  - "s" (sync) is the synchronous mirror of "a" for sync host bridges (crypto
 *    digests, pure helpers) that handlers call without await.
 * JSON.parse failures on the return fall back to the original string. The
 * intrinsics are captured before any bundle code runs, so a bundle replacing
 * a prototype method cannot bend how its own calls reach the host.
 */
const CTX_SHIM_SOURCE = `(function (dispatch, specJson) {
  var reflectApply = Reflect.apply;
  var parse = JSON.parse;
  var stringify = JSON.stringify;
  var spec = parse(specJson);
  function isPrimitive(a) {
    var t = typeof a;
    return t === "string" || t === "number" || t === "boolean";
  }
  function callArgs(name, args, marshal) {
    var out = [name];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      out[i + 1] = !marshal || a === null || a === undefined || isPrimitive(a) ? a : stringify(a);
    }
    return out;
  }
  function sdkShape(args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (a !== null && a !== undefined && !isPrimitive(a)) return true;
    }
    return false;
  }
  function parsed(result) {
    if (typeof result !== "string") return result;
    try { return parse(result); } catch (e) { return result; }
  }
  var MAKE = {
    a: function (name) {
      return async function () {
        if (!sdkShape(arguments)) return await reflectApply(dispatch, null, callArgs(name, arguments, false));
        return parsed(await reflectApply(dispatch, null, callArgs(name, arguments, true)));
      };
    },
    st: function (name) {
      return async function () {
        return parsed(await reflectApply(dispatch, null, callArgs(name, arguments, true)));
      };
    },
    s: function (name) {
      return function () {
        if (!sdkShape(arguments)) return reflectApply(dispatch, null, callArgs(name, arguments, false));
        return parsed(reflectApply(dispatch, null, callArgs(name, arguments, true)));
      };
    }
  };
  function constant(value) {
    return function () { return value; };
  }
  var made = new Map();
  function member(kind, name) {
    var key = kind + ":" + name;
    var fn = made.get(key);
    if (!fn) { fn = MAKE[kind](name); made.set(key, fn); }
    return fn;
  }
  var ctx = {};
  for (var j = 0; j < spec.syncGetters.length; j++) {
    ctx[spec.syncGetters[j][0]] = constant(spec.syncGetters[j][1]);
  }
  ctx.approval = spec.approval;
  for (var k = 0; k < spec.flat.length; k++) {
    ctx[spec.flat[k][0]] = member(spec.flat[k][1], spec.flat[k][0]);
  }
  for (var g = 0; g < spec.groups.length; g++) {
    var group = {};
    var members = spec.groups[g][1];
    for (var m = 0; m < members.length; m++) {
      group[members[m][0]] = member(members[m][1], members[m][2]);
    }
    ctx[spec.groups[g][0]] = group;
  }
  return ctx;
})`

/** Data the constant shim builds `__ctx` from; see buildCtxSpec. */
interface CtxSpec {
  /** Pre-baked synchronous getters, `[name, value]`, in this order. */
  syncGetters: Array<[string, string]>
  /** The K6 `ctx.approval` field (null on first entry). */
  approval: unknown
  /** Flat members, `[name, "a" | "s"]` (async `__wrap` / sync `__wrapSync`). */
  flat: Array<[string, "a" | "s"]>
  /** Nested groups, `[group, [member, "a" | "st", bridgeName][]]`. */
  groups: Array<[string, Array<[string, "a" | "st", string]>]>
}

/**
 * Install this call's bridge and `__ctx` in its fresh context: ONE host
 * function (`dispatch`), bound to this call's bridge only, then the constant
 * shim builds `__ctx` from data.
 *
 * `dispatch` answers only the bridge's own method names (a Map built from
 * `Object.entries(bridge)`, so no prototype name such as `constructor` can
 * reach the host), which is exactly the set of host functions the context had
 * before, one per name. It is passed to the shim as an argument and never
 * stored on the global object.
 */
function installBridgeAndCtx(
  ctx: QuickJSAsyncContext,
  bridge: Record<string, (...args: any[]) => any>,
  handles: QuickJSHandle[],
  isDisposed: () => boolean,
  bridgeCallTimeoutMs: number,
): void {
  const methods = new Map<string, (...args: any[]) => any>(Object.entries(bridge))
  const dispatch = ctx.newFunction("__bridge_dispatch", (nameHandle, ...argHandles) => {
    const name = ctx.typeof(nameHandle) === "string" ? ctx.getString(nameHandle) : undefined
    const fn = name === undefined ? undefined : methods.get(name)
    if (name === undefined || !fn) throw new Error("Unknown bridge method")
    const args = argHandles.map((h) => ctx.dump(h))
    if (!isAsyncBridge(fn)) {
      // Sync bridge: return the value directly
      return marshalToContext(ctx, fn(...args))
    }
    // Async bridge: return a QuickJS promise, resolve it when host work completes
    const deferred = ctx.newPromise()
    bridgeCallWithTimeout(() => fn(...args), bridgeCallTimeoutMs, name)
      .then((result) => {
        // The slot may have been destroyed/released while this host call
        // was in flight (e.g. execution timed out). Touching the disposed
        // context here would operate on freed WASM handles.
        if (isDisposed()) return
        const handle = marshalToContext(ctx, result)
        deferred.resolve(handle)
        handle.dispose()
      })
      .catch((err) => {
        if (isDisposed()) return
        const errHandle = newBridgeRejection(
          ctx,
          err?.message ?? String(err),
          typedBridgeFailure(err),
        )
        deferred.reject(errHandle)
        errHandle.dispose()
      })
      .finally(() => {
        if (isDisposed()) return
        // Resume the QuickJS event loop to process the resolved promise
        ctx.runtime.executePendingJobs()
      })
    return deferred.handle
  })
  handles.push(dispatch)

  const shim = ctx.evalCode(CTX_SHIM_SOURCE, "ctx-shim.js")
  if (shim.error) {
    const err = ctx.dump(shim.error)
    shim.error.dispose()
    throw new Error(`Context shim error: ${err}`)
  }
  const specHandle = ctx.newString(JSON.stringify(buildCtxSpec(bridge)))
  const built = ctx.callFunction(shim.value, ctx.undefined, dispatch, specHandle)
  shim.value.dispose()
  specHandle.dispose()
  if (built.error) {
    const err = ctx.dump(built.error)
    built.error.dispose()
    throw new Error(`Context shim error: ${err}`)
  }
  ctx.setProp(ctx.global, "__ctx", built.value)
  built.value.dispose()
}

/**
 * The per-call data of the `__ctx` shim. Mirrors sandbox-worker.ts — see that
 * file for the full design rationale. Flat + nested forms are both exposed.
 */
function buildCtxSpec(bridge: Record<string, (...args: any[]) => unknown>): CtxSpec {
  const names = Object.keys(bridge)
  // `approval` is the K6 data field (pre-baked as a sync `approval` member
  // below), NOT a method group. Without this guard the `approval_record*`
  // bridge methods build a nested `approval: { recordStarted, ... }` object that,
  // assigned after the data field, shadows it with a truthy method container —
  // breaking `if (!ctx.approval)`. The flat `approval_record*` methods stay
  // callable as `ctx.approval_record*`.
  // Both sets come from the one rule table the worker pool and Workers read
  // (ctx-shim.ts SHIM_RULES), so the three executors parse alike.
  const RESERVED_GROUPS = new Set(SHIM_RULES.reservedGroups)
  // Structured-return groups (`ctx.kernel.*`, `ctx.db.*`, `ctx.bulk.*`,
  // `ctx.store.*`) go through `__wrapStructured` (always parse a string
  // return), see CTX_SHIM_SOURCE.
  const STRUCTURED_RETURN_GROUPS = new Set(SHIM_RULES.structuredReturnGroups)
  const nested = new Map<string, Array<[string, "a" | "st", string]>>()
  for (const m of names) {
    const splitAt = m.indexOf("_")
    if (splitAt > 0 && splitAt < m.length - 1) {
      const group = m.slice(0, splitAt)
      if (RESERVED_GROUPS.has(group)) continue
      const member = m.slice(splitAt + 1)
      if (!nested.has(group)) nested.set(group, [])
      nested.get(group)!.push([member, STRUCTURED_RETURN_GROUPS.has(group) ? "st" : "a", m])
    }
  }
  // SDK-contract alias: the host bridge exposes logging as `log_*`, which the
  // loop groups into `ctx.log.*`. But `AppContext.logger` is the documented
  // accessor (packages/app-sdk types) and every bundled app calls `ctx.logger.*`
  // (several NON-optionally). Without this alias `ctx.logger` is undefined →
  // optional `ctx.logger?.warn?.()` silently no-ops (this is what hid the Shopify
  // webhook-registration failure) and non-optional `ctx.logger.warn()` THROWS in
  // the live sandbox. Mirror the `log` group as `logger` so both names resolve.
  if (nested.has("log") && !nested.has("logger")) {
    nested.set("logger", nested.get("log")!.slice())
  }
  // Synchronous-getter pre-bake. `getUserId` / `getOrgId` are declared
  // synchronous in the bundle's TS interface, but `__wrap` is async — so a
  // call site like `JSON.stringify({ createdBy: ctx.getUserId() })` would
  // serialize a pending Promise as `{}`. Read the values off the bridge now
  // and hand them to the shim as constants. The flat bridge entries with the
  // same name are left out so the constant getters win.
  const SYNC_GETTER_NAMES = new Set(["getUserId", "getOrgId"])
  const syncGetters: Array<[string, string]> = []
  for (const syncName of SYNC_GETTER_NAMES) {
    if (syncName in bridge) {
      const fn = bridge[syncName] as () => unknown
      const value = (() => {
        try {
          return fn()
        } catch {
          return ""
        }
      })()
      syncGetters.push([syncName, typeof value === "string" ? value : ""])
    }
  }
  // Phase 17 fix C5 — pre-bake `ctx.approval` as a synchronous field. The
  // bridge exposes `_approvalContext_get` (async, leading-underscore so it's
  // flat-form only) returning a JSON-stringified envelope. The K6 spec
  // contract is a *synchronously readable* field — handlers branch on
  // `if (ctx.approval)` to distinguish first-entry from post-approval
  // re-invocation. Without this pre-bake, that branch always evaluates the
  // bridge method (a function) as truthy → handlers fall into the "first
  // entry" path even post-approval → infinite approval loops.
  const APPROVAL_FIELD = "_approvalContext_get"
  let approval: unknown = null
  if (APPROVAL_FIELD in bridge) {
    const fn = bridge[APPROVAL_FIELD] as () => unknown
    try {
      const result = fn()
      // The bridge method is async; if it returns a Promise, fall back to
      // null (Promise is non-pre-bakeable). At construction time the
      // approvalContext is already available in closure so this path returns
      // the JSON-stringified envelope synchronously.
      const isPromise =
        result != null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
      if (!isPromise && typeof result === "string") approval = JSON.parse(result)
    } catch {
      approval = null
    }
  }
  // Filter the leading-underscore bridge method so it doesn't leak as a flat
  // bridge entry; the synchronous `approval` field is the SDK surface.
  const HIDDEN_NAMES = new Set([APPROVAL_FIELD])
  // Sync host bridges (non-AsyncFunction, e.g. crypto digests, pure helpers)
  // must stay synchronous — handlers call them as `ctx.foo(...)` without await
  // per the SDK contract. Wrapping them in the async `__wrap` would return a
  // pending Promise that JSON-serializes as `{}`. Route them through the
  // synchronous mirror `__wrapSync` (same raw/SDK marshalling, no await).
  const flat = names
    .filter((name) => !SYNC_GETTER_NAMES.has(name) && !HIDDEN_NAMES.has(name))
    .map((name): [string, "a" | "s"] => [name, isAsyncBridge(bridge[name]) ? "a" : "s"])
  return { syncGetters, approval, flat, groups: Array.from(nested.entries()) }
}

function marshalToContext(ctx: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === undefined || value === null) return ctx.undefined
  if (typeof value === "string") return ctx.newString(value)
  if (typeof value === "number") return ctx.newNumber(value)
  if (typeof value === "boolean") return value ? ctx.true : ctx.false
  // For objects/arrays, serialize via JSON round-trip
  const json = JSON.stringify(value)
  const result = ctx.evalCode(`(${json})`)
  if (result.error) {
    result.error.dispose()
    return ctx.undefined
  }
  return result.value
}
