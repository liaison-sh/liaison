// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { esmExportsToGlobalThis } from "~/modules/apps/sandbox/bundle-loader"
import {
  executeInSandbox,
  resolveSandboxDefaultTimeoutMs,
  resolveSandboxMaxToolTimeoutMs,
  resolveToolTimeoutMs,
} from "~/modules/apps/sandbox/executor"
import {
  createSandboxPool,
  resolveSandboxPoolMaxSize,
  type SandboxPool,
} from "~/modules/apps/sandbox/pool"

describe("resolveSandboxDefaultTimeoutMs", () => {
  it("pins 5s in production and IGNORES the env override (a hung handler must never hold a worker)", () => {
    expect(resolveSandboxDefaultTimeoutMs({ NODE_ENV: "production" })).toBe(5_000)
    expect(
      resolveSandboxDefaultTimeoutMs({
        NODE_ENV: "production",
        LIAISON_SANDBOX_TIMEOUT_MS: "300000",
      }),
    ).toBe(5_000)
  })
  it("defaults to 60s in non-production but honours LIAISON_SANDBOX_TIMEOUT_MS (chaos agent_run needs more)", () => {
    expect(resolveSandboxDefaultTimeoutMs({ NODE_ENV: "test" })).toBe(60_000)
    expect(
      resolveSandboxDefaultTimeoutMs({ NODE_ENV: "test", LIAISON_SANDBOX_TIMEOUT_MS: "300000" }),
    ).toBe(300_000)
    // Garbage / non-positive override falls back to the 60s default.
    expect(
      resolveSandboxDefaultTimeoutMs({ NODE_ENV: "test", LIAISON_SANDBOX_TIMEOUT_MS: "nope" }),
    ).toBe(60_000)
    expect(
      resolveSandboxDefaultTimeoutMs({ NODE_ENV: "test", LIAISON_SANDBOX_TIMEOUT_MS: "0" }),
    ).toBe(60_000)
  })
})

describe("resolveToolTimeoutMs (per-tool budget honoured up to a cap, unclamped by 5s prod ceiling)", () => {
  const prod = { NODE_ENV: "production" }
  it("honours a declared per-tool timeout in production (NOT clamped to the 5s default)", () => {
    // The prod bug: heavy tools (shopify home_load, tickets get) were pinned to 5s.
    // A declared 20s must survive in production.
    expect(resolveToolTimeoutMs(20_000, prod)).toBe(20_000)
  })
  it("floors a declared timeout below the base default up to the default", () => {
    // A tool declaring less than the tight prod default gains nothing — keep the default.
    expect(resolveToolTimeoutMs(2_000, prod)).toBe(5_000)
  })
  it("caps a runaway declared timeout at the max (a manifest must not pin a worker for minutes)", () => {
    expect(resolveToolTimeoutMs(600_000, prod)).toBe(resolveSandboxMaxToolTimeoutMs(prod))
    expect(resolveToolTimeoutMs(600_000, prod)).toBe(120_000)
  })
  it("returns undefined when nothing is declared, so the base default applies downstream", () => {
    expect(resolveToolTimeoutMs(undefined, prod)).toBeUndefined()
    expect(resolveToolTimeoutMs(0, prod)).toBeUndefined()
    expect(resolveToolTimeoutMs(Number.NaN, prod)).toBeUndefined()
  })
  it("does not reduce the already-shipped long declarations (invoicing 120s, boxtal 60s)", () => {
    expect(resolveToolTimeoutMs(120_000, prod)).toBe(120_000)
    expect(resolveToolTimeoutMs(60_000, prod)).toBe(60_000)
  })
  it("honours an env override of the max cap", () => {
    expect(
      resolveToolTimeoutMs(200_000, {
        NODE_ENV: "production",
        LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS: "200000",
      }),
    ).toBe(200_000)
  })
})

describe("resolveSandboxPoolMaxSize", () => {
  it("defaults to the raised 24 (was 12, saturated in prod)", () => {
    expect(resolveSandboxPoolMaxSize({})).toBe(24)
  })
  it("honours SANDBOX_POOL_MAX_SIZE so a saturated node can widen without a redeploy", () => {
    expect(resolveSandboxPoolMaxSize({ SANDBOX_POOL_MAX_SIZE: "40" })).toBe(40)
  })
  it("falls back to the default on garbage / non-positive values", () => {
    expect(resolveSandboxPoolMaxSize({ SANDBOX_POOL_MAX_SIZE: "nope" })).toBe(24)
    expect(resolveSandboxPoolMaxSize({ SANDBOX_POOL_MAX_SIZE: "0" })).toBe(24)
  })
})

describe("executeInSandbox", () => {
  let pool: SandboxPool

  beforeAll(async () => {
    pool = await createSandboxPool({ initialSize: 1, maxSize: 1 })
  }, 60_000)

  afterAll(async () => {
    if (pool) await pool.shutdown()
  }, 60_000)

  it("a bundler-renamed export alias never clobbers the same-named function the bundle still calls", async () => {
    // Bun.build emits `greet2 as greet` when a wrapper is exported under the name of the
    // function it wraps. The loader must not turn that into a global assignment that
    // overwrites the script-global `greet`, or the wrapper recurses into itself.
    const bundle = esmExportsToGlobalThis(
      [
        "async function greet(params, ctx) { return 'inner'; }",
        "async function greet2(params, ctx) { return 'outer:' + (await greet(params, ctx)); }",
        "export {",
        "  greet2 as greet",
        "};",
        "",
      ].join("\n"),
    )
    const result = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "greet",
      params: {},
      bridge: {},
    })
    expect(result).toBe("outer:inner")
  })

  it("a bridge refusal's HTTP status and code survive a trusted handler's rethrow", async () => {
    // A trusted app (projects) calling the kernel for a task key that does not
    // exist got a 404 back, but the executor rejected with the bare message,
    // so execute-tool saw a statusless fault and logged it at error level.
    const typed = () => {
      const e = new Error('no task with key "ERB-26"')
      ;(e as any).status = 404
      ;(e as any).code = "not_found"
      return e
    }
    const err = await executeInSandbox({
      pool,
      bundleSource: `async function getTask(params, ctx) { return await ctx.projects_get("{}") }`,
      exportName: "getTask",
      params: {},
      bridge: {
        projects_get: async () => {
          throw typed()
        },
      },
    }).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(Error)
    // The executor appends the sandbox stack after the first line.
    expect(err.message.split("\n")[0]).toBe('no task with key "ERB-26"')
    expect(err.status).toBe(404)
    expect(err.code).toBe("not_found")

    const caught = await executeInSandbox({
      pool,
      bundleSource: `async function probe(params, ctx) {
        var out = {}
        try { await ctx.typed() } catch (e) { out.typed = { message: e.message, status: e.status, code: e.code } }
        try { await ctx.plain() } catch (e) { out.plain = { kind: typeof e, text: String(e) } }
        return out
      }`,
      exportName: "probe",
      params: {},
      bridge: {
        typed: async () => {
          throw typed()
        },
        plain: async () => {
          throw new Error("boom")
        },
      },
    })
    expect(caught).toEqual({
      typed: { message: 'no task with key "ERB-26"', status: 404, code: "not_found" },
      plain: { kind: "string", text: "boom" },
    })
  })

  it("executes a trivial handler and returns the result", async () => {
    const bundle = `function echo(params, ctx) { return { got: params.message }; }`
    const result = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "echo",
      params: { message: "hello" },
      bridge: {},
    })
    expect(result).toEqual({ got: "hello" })
  })

  it("handler can call a synchronous host function via bridge", async () => {
    const bundle = `function add(params, ctx) { return { sum: ctx.add(params.a, params.b) }; }`
    const result = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "add",
      params: { a: 3, b: 4 },
      bridge: { add: (a: number, b: number) => a + b },
    })
    expect(result).toEqual({ sum: 7 })
  })

  it("handler can call an async host function via bridge", async () => {
    const bundle = `async function fetchData(params, ctx) {
      var data = await ctx.getData(params.id);
      return { data: data };
    }`
    const result = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "fetchData",
      params: { id: "abc" },
      bridge: {
        getData: async (id: string) => ({ id, name: `Item ${id}` }),
      },
    })
    expect(result).toEqual({ data: { id: "abc", name: "Item abc" } })
  })

  it("propagates handler errors", async () => {
    const bundle = `function fail(params, ctx) { throw new Error("handler broke"); }`
    await expect(
      executeInSandbox({ pool, bundleSource: bundle, exportName: "fail", params: {}, bridge: {} }),
    ).rejects.toThrow("handler broke")
  })

  it("returns null for handlers that return undefined", async () => {
    const bundle = `function noop(params, ctx) {}`
    const result = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "noop",
      params: {},
      bridge: {},
    })
    expect(result).toBeNull()
  })

  it("handles handler returning an array", async () => {
    const bundle = `function list(params, ctx) { return [1, 2, 3]; }`
    const result = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "list",
      params: {},
      bridge: {},
    })
    expect(result).toEqual([1, 2, 3])
  })

  it("throws when export name does not exist in bundle", async () => {
    const bundle = `function existing(params, ctx) { return true; }`
    await expect(
      executeInSandbox({
        pool,
        bundleSource: bundle,
        exportName: "missing",
        params: {},
        bridge: {},
      }),
    ).rejects.toThrow("missing")
  })

  it("produces consistent results across invocations", async () => {
    const bundle = `function counter(params, ctx) { return { value: 1 }; }`
    const r1 = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "counter",
      params: {},
      bridge: {},
    })
    const r2 = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "counter",
      params: {},
      bridge: {},
    })
    expect(r1).toEqual({ value: 1 })
    expect(r2).toEqual({ value: 1 })
  })

  it("survives a host bridge promise that resolves after the execution times out", async () => {
    // The handler awaits a bridge call whose host work outlives the timeout.
    // On timeout the slot is destroyed (context disposed); when the slow bridge
    // promise finally settles, the executor must short-circuit instead of
    // marshalling into the freed context and crashing the host process.
    const bundle = `async function slow(params, ctx) {
      var v = await ctx.slowCall();
      return { v: v };
    }`
    // The bridge call answers only when released, i.e. after the timeout.
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r
    })
    let markSlowSettled!: () => void
    const slowSettled = new Promise<void>((r) => {
      markSlowSettled = r
    })
    await expect(
      executeInSandbox({
        pool,
        bundleSource: bundle,
        exportName: "slow",
        params: {},
        bridge: {
          slowCall: async () => {
            await slowGate
            markSlowSettled()
            return "late"
          },
        },
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out")

    // Let the late bridge promise settle now, and give the executor's
    // continuation a turn of the event loop to run. If the guard is missing,
    // this resolves against freed WASM handles and crashes the worker.
    releaseSlow()
    await slowSettled
    await new Promise((r) => setTimeout(r, 20))

    // The pool must still be usable for the next execution.
    const result = await executeInSandbox({
      pool,
      bundleSource: `function ok(params, ctx) { return { alive: true }; }`,
      exportName: "ok",
      params: {},
      bridge: {},
    })
    expect(result).toEqual({ alive: true })
  }, 10_000)

  it("isolates module-level state across invocations", async () => {
    const bundle = `var count = 0; function inc(params, ctx) { count++; return { count: count }; }`
    const r1 = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "inc",
      params: {},
      bridge: {},
    })
    const r2 = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "inc",
      params: {},
      bridge: {},
    })
    // Each invocation re-evaluates the module, so count starts at 0 each time
    expect(r1).toEqual({ count: 1 })
    expect(r2).toEqual({ count: 1 })
  })

  // QuickJS hardening / isolation tests
  it("blocked typed-array globals are absent inside the sandbox", async () => {
    // The harden script deletes typed-array constructors so sandbox code cannot
    // allocate WASM linear memory directly and bypass the QuickJS heap limit.
    const bundle = `function check(params, ctx) {
      return {
        ArrayBuffer: typeof ArrayBuffer,
        Uint8Array: typeof Uint8Array,
        SharedArrayBuffer: typeof SharedArrayBuffer,
        DataView: typeof DataView,
      };
    }`
    const result = (await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "check",
      params: {},
      bridge: {},
    })) as Record<string, string>
    expect(result.ArrayBuffer).toBe("undefined")
    expect(result.Uint8Array).toBe("undefined")
    expect(result.SharedArrayBuffer).toBe("undefined")
    expect(result.DataView).toBe("undefined")
  })

  it("sandbox code cannot access host globalThis via prototype escape", async () => {
    // Confirm that common prototype-escape routes are blocked. The QuickJS
    // isolate has its own global; host globalThis and process are inaccessible.
    const bundle = `function escape(params, ctx) {
      var gotProcess = typeof process;
      var gotHostGlobal = typeof globalThis.Bun;
      return { process: gotProcess, bun: gotHostGlobal };
    }`
    const result = (await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "escape",
      params: {},
      bridge: {},
    })) as Record<string, string>
    // QuickJS exposes its own `process`-less globalThis; Bun is never present.
    expect(result.bun).toBe("undefined")
    // `process` is not exposed inside QuickJS.
    expect(result.process).toBe("undefined")
  })

  it("sandbox code cannot pollute host global state between invocations", async () => {
    // Write to a hypothetical global inside one invocation; the next must not see it.
    const write = `function writeGlobal(params, ctx) {
      globalThis.__smuggled = "leaked";
      return null;
    }`
    const read = `function readGlobal(params, ctx) {
      return { value: typeof globalThis.__smuggled === "undefined" ? "clean" : globalThis.__smuggled };
    }`
    await executeInSandbox({
      pool,
      bundleSource: write,
      exportName: "writeGlobal",
      params: {},
      bridge: {},
    })
    const result = await executeInSandbox({
      pool,
      bundleSource: read,
      exportName: "readGlobal",
      params: {},
      bridge: {},
    })
    // Each invocation gets a fresh context; the write must not persist.
    expect((result as Record<string, string>).value).toBe("clean")
  })

  it("bridge methods are the only channel to the host — unregistered names are absent", async () => {
    // Only bridge methods injected at sandbox setup time are accessible.
    // Verify that an arbitrary registered name is callable and an unregistered
    // name is simply absent.
    const bundle = `async function test(params, ctx) {
      var hasRegistered = typeof ctx.echo === "function";
      var hasUnregistered = typeof ctx.notRegistered === "function";
      var echoed = await ctx.echo("ping");
      return { hasRegistered, hasUnregistered, echoed };
    }`
    const result = await executeInSandbox({
      pool,
      bundleSource: bundle,
      exportName: "test",
      params: {},
      bridge: { echo: (v: string) => v },
    })
    expect(result).toEqual({ hasRegistered: true, hasUnregistered: false, echoed: "ping" })
  })

  it("a timed-out execution with an in-flight bridge promise does not poison later executions", async () => {
    // Regression: a handler killed by timeout leaves live GC objects (the pending
    // bridge promise) in its runtime. Freeing that runtime natively trips
    // QuickJS's gc_obj_list assertion, and with a module shared across slots the
    // resulting emscripten abort hung EVERY later execution in the process.
    // Per-slot modules + drop-without-free on destroy() keep the pool healthy.
    let releaseHang: (() => void) | undefined
    const hangPromise = new Promise<void>((resolve) => {
      releaseHang = resolve
    })
    const hangBundle = `async function hang(params, ctx) {
      await ctx.never();
      return { unreachable: true };
    }`
    await expect(
      executeInSandbox({
        pool,
        bundleSource: hangBundle,
        exportName: "hang",
        params: {},
        bridge: { never: async () => hangPromise },
        timeoutMs: 100,
      }),
    ).rejects.toThrow("App execution timed out")

    // Several follow-up executions across slots must still work.
    for (let i = 0; i < 3; i++) {
      const ok = await executeInSandbox({
        pool,
        bundleSource: `async function ok(params, ctx) { return { n: await ctx.add(params.i, 1) } }`,
        exportName: "ok",
        params: { i },
        bridge: { add: async (a: number, b: number) => a + b },
      })
      expect(ok).toEqual({ n: i + 1 })
    }

    // Late settle of the abandoned host promise must be a no-op (disposed guard).
    releaseHang?.()
    await new Promise((r) => setTimeout(r, 20))
    const after = await executeInSandbox({
      pool,
      bundleSource: `function last(params, ctx) { return { ok: true } }`,
      exportName: "last",
      params: {},
      bridge: {},
    })
    expect(after).toEqual({ ok: true })
  })
})
