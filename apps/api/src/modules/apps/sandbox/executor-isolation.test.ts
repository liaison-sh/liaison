// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Per-call isolation of the in-process sandbox executor, and the cost of a
 * call's setup. Every call runs in a fresh QuickJS context: nothing one call
 * evaluates (globals, module variables, prototype changes, pending jobs, the
 * bridge it was given) may be seen by a later call, whatever its org, user or
 * rights. The bridge and `__ctx` are built per call from ONE host function and
 * a constant shim source, so no caller data is ever compiled into code.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { QuickJSAsyncContext } from "quickjs-emscripten"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { createSandboxPool, type SandboxPool, type SandboxSlot } from "~/modules/apps/sandbox/pool"

/** A bridge shaped like a real one: identity getters plus async and sync methods. */
function bridgeFor(orgId: string, userId: string, calls: string[] = []) {
  return {
    getOrgId: () => orgId,
    getUserId: () => userId,
    record: async (v: string) => {
      calls.push(v)
      return "ok"
    },
    whoami: async () => JSON.stringify({ orgId, userId }),
    digest_sha: (v: string) => `digest:${v}`,
    db_findOne: async (entity: string, id: string) => JSON.stringify({ entity, id, orgId }),
    tickets_get: async (id: string) => JSON.stringify({ id }),
    log_info: async (_msg: string) => "",
  }
}

describe("executeInSandbox per-call isolation", () => {
  let pool: SandboxPool

  beforeAll(async () => {
    // One slot: every call below reuses the SAME runtime, the worst case for leaks.
    pool = await createSandboxPool({ initialSize: 1, maxSize: 1 })
  }, 60_000)

  afterAll(async () => {
    if (pool) await pool.shutdown()
  }, 60_000)

  const polluter = `
    var counter = 0;
    async function pollute(params, ctx) {
      counter++;
      globalThis.leakedOrg = ctx.getOrgId();
      Object.prototype.leakedProto = ctx.getOrgId();
      Array.prototype.push = function () { return "hijacked:" + ctx.getOrgId(); };
      JSON.stringify = function () { return "hijacked"; };
      Reflect.apply = function () { return "stolen"; };
      // A continuation that outlives the call and would reach the host later.
      Promise.resolve().then(function () { return null; }).then(function () {
        globalThis.lateOrg = ctx.getOrgId();
        return ctx.record("late:" + ctx.getOrgId());
      });
      return { counter: counter, org: ctx.getOrgId() };
    }`

  const observer = `
    var counter = 0;
    async function observe(params, ctx) {
      counter++;
      var arr = [];
      var pushed = arr.push(1);
      var who = await ctx.whoami();
      return {
        counter: counter,
        leakedOrg: typeof globalThis.leakedOrg === "undefined" ? null : globalThis.leakedOrg,
        lateOrg: typeof globalThis.lateOrg === "undefined" ? null : globalThis.lateOrg,
        leakedProto: ({}).leakedProto === undefined ? null : ({}).leakedProto,
        pushed: pushed,
        json: JSON.stringify({ a: 1 }),
        org: ctx.getOrgId(),
        user: ctx.getUserId(),
        who: who,
        recorded: await ctx.record("observer"),
      };
    }`

  it("state written by a call for org A is invisible to later calls for org B and for org A", async () => {
    const callsA: string[] = []
    const callsB: string[] = []
    const callsA2: string[] = []
    const first = await executeInSandbox({
      pool,
      bundleSource: polluter,
      exportName: "pollute",
      params: {},
      bridge: bridgeFor("org-a", "user-a", callsA),
    })
    expect(first).toEqual({ counter: 1, org: "org-a" })

    for (const [orgId, userId, calls] of [
      ["org-b", "user-b", callsB],
      ["org-a", "user-a2", callsA2],
    ] as const) {
      const seen = await executeInSandbox({
        pool,
        bundleSource: observer,
        exportName: "observe",
        params: {},
        bridge: bridgeFor(orgId, userId, calls),
      })
      expect(seen).toEqual({
        counter: 1,
        leakedOrg: null,
        lateOrg: null,
        leakedProto: null,
        pushed: 1,
        json: '{"a":1}',
        org: orgId,
        user: userId,
        who: JSON.stringify({ orgId, userId }),
        recorded: "ok",
      })
      // The later call's bridge saw its own call only, never A's continuation.
      expect(calls).toEqual(["observer"])
    }
    // A's own late continuation never ran against a later call's context.
    expect(callsA.every((c) => c === "late:org-a")).toBe(true)
  })

  it("the same bundle re-evaluated per call never carries a module variable over", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await executeInSandbox({
        pool,
        bundleSource: polluter,
        exportName: "pollute",
        params: {},
        bridge: bridgeFor(`org-${i}`, `user-${i}`),
      })
      expect(r).toEqual({ counter: 1, org: `org-${i}` })
    }
  })

  it("a changed bundle (an app upgrade) is what the next call runs", async () => {
    const v1 = "function version(params, ctx) { return 1 }"
    const v2 = "function version(params, ctx) { return 2 }"
    const run = (bundleSource: string) =>
      executeInSandbox({
        pool,
        bundleSource,
        exportName: "version",
        params: {},
        bridge: bridgeFor("o", "u"),
      })
    expect(await run(v1)).toBe(1)
    expect(await run(v2)).toBe(2)
    expect(await run(v1)).toBe(1)
  })

  it("only __ctx reaches the host: no dispatcher or per-method bridge global is exposed", async () => {
    const probe = `async function probe(params, ctx) {
      var refused = [];
      var names = ["record", "whoami", "constructor", "toString", "nope"];
      for (var i = 0; i < names.length; i++) {
        refused.push(typeof globalThis["__bridge_" + names[i]]);
      }
      return {
        dispatcher: typeof globalThis.__bridge_dispatch,
        refused: refused,
        flat: typeof ctx.record,
        unregistered: typeof ctx.notRegistered,
      };
    }`
    const r = await executeInSandbox({
      pool,
      bundleSource: probe,
      exportName: "probe",
      params: {},
      bridge: bridgeFor("o", "u"),
    })
    expect(r).toEqual({
      dispatcher: "undefined",
      refused: ["undefined", "undefined", "undefined", "undefined", "undefined"],
      flat: "function",
      unregistered: "undefined",
    })
  })

  it("keeps the __ctx contract: flat, nested, structured, sync, getters, approval, logger", async () => {
    const shape = `async function shape(params, ctx) {
      return {
        flatAsync: await ctx.whoami(),
        sdkShapeParsed: await ctx.record({ x: 1 }),
        syncFlat: ctx.digest_sha("v"),
        nestedRaw: await ctx.tickets.get("t1"),
        structured: await ctx.db.findOne("note", "n1"),
        logger: typeof ctx.logger.info,
        log: typeof ctx.log.info,
        approval: ctx.approval,
        hiddenApprovalGetter: typeof ctx._approvalContext_get,
        org: ctx.getOrgId(),
        user: ctx.getUserId(),
      };
    }`
    const r = await executeInSandbox({
      pool,
      bundleSource: shape,
      exportName: "shape",
      params: {},
      bridge: {
        ...bridgeFor("org-s", "user-s"),
        _approvalContext_get: () =>
          JSON.stringify({ approvalRequestId: "ar1", approvalDeciderId: "d1", toolName: "t" }),
        approval_recordStarted: async () => "",
      },
    })
    expect(r).toEqual({
      // RAW shape (all-primitive args): the string return passes through.
      flatAsync: JSON.stringify({ orgId: "org-s", userId: "user-s" }),
      // SDK shape: the object arg is stringified for the host, the return parsed.
      sdkShapeParsed: "ok",
      syncFlat: "digest:v",
      nestedRaw: JSON.stringify({ id: "t1" }),
      // `db` is a structured-return group: always parsed.
      structured: { entity: "note", id: "n1", orgId: "org-s" },
      logger: "function",
      log: "function",
      approval: { approvalRequestId: "ar1", approvalDeciderId: "d1", toolName: "t" },
      hiddenApprovalGetter: "undefined",
      org: "org-s",
      user: "user-s",
    })
  })

  it("a call's setup creates ONE host function and compiles the same shim text for every caller", async () => {
    // Count what the executor does on the slot's context, call by call.
    const realAcquire = pool.acquire.bind(pool)
    const seen: Array<{ newFunction: number; sources: string[] }> = []
    pool.acquire = async (): Promise<SandboxSlot> => {
      const slot = await realAcquire()
      const ctx = slot.context as QuickJSAsyncContext
      const entry = { newFunction: 0, sources: [] as string[] }
      seen.push(entry)
      const newFunction = ctx.newFunction.bind(ctx)
      const evalCode = ctx.evalCode.bind(ctx)
      ctx.newFunction = ((...a: Parameters<typeof newFunction>) => {
        entry.newFunction++
        return newFunction(...a)
      }) as typeof ctx.newFunction
      ctx.evalCode = ((...a: Parameters<typeof evalCode>) => {
        entry.sources.push(a[0])
        return evalCode(...a)
      }) as typeof ctx.evalCode
      return slot
    }
    try {
      const big = (orgId: string) => {
        const b: Record<string, (...args: any[]) => any> = bridgeFor(orgId, `user-of-${orgId}`)
        for (let i = 0; i < 200; i++) b[`group${i % 20}_method${i}`] = async () => "x"
        return b
      }
      const bundle = "function noop(params, ctx) { return 1 }"
      for (const orgId of ["org-one", "org-two"]) {
        await executeInSandbox({
          pool,
          bundleSource: bundle,
          exportName: "noop",
          params: {},
          bridge: big(orgId),
        })
      }
    } finally {
      pool.acquire = realAcquire
    }
    expect(seen).toHaveLength(2)
    // One host function per call (the dispatcher), not one per bridge method (208).
    expect(seen.map((s) => s.newFunction)).toEqual([1, 1])
    // The compiled shim is byte-identical across callers and names no caller.
    const shims = seen.map((s) => s.sources.find((src) => src.includes("specJson")))
    expect(shims[0]).toBeDefined()
    expect(shims[0]).toBe(shims[1])
    for (const needle of ["org-one", "org-two", "user-of", "group1_method1"]) {
      expect(shims[0]).not.toContain(needle)
    }
  })
})
