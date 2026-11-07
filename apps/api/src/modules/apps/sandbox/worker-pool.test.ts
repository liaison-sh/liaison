// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { appsLogger } from "~/lib/logger"
import {
  MAX_NESTED_BREADTH_PER_PARENT,
  readProcessRssBytes,
  resolveSandboxPoolWarmSize,
  SandboxWorkerMemoryError,
  SandboxWorkerPool,
  workerEnv,
} from "~/modules/apps/sandbox/worker-pool"
import { isSandboxFault } from "./bundle-loader"

/** Wait until `predicate` holds, polling fast; throws via test timeout if never. */
async function until(predicate: () => boolean, intervalMs = 5): Promise<void> {
  while (!predicate()) await Bun.sleep(intervalMs)
}

/** The live command line of a process, one element per argument. */
async function processArgv(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean)
  }
  const ps = Bun.spawn(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe" })
  return (await new Response(ps.stdout).text()).trim().split(/\s+/)
}

let pool: SandboxWorkerPool

beforeAll(async () => {
  pool = new SandboxWorkerPool({ size: 2, maxSize: 4 })
  await pool.init()
})

afterAll(async () => {
  if (pool) await pool.shutdown()
})

describe("SandboxWorkerPool", () => {
  it("initializes workers and executes a simple handler", async () => {
    const stats = pool.stats()
    expect(stats.total).toBe(2)
    expect(stats.free).toBe(2)

    const result = await pool.execute({
      bundleSource: `function greet(params, ctx) { return { message: "hello " + params.name } }`,
      exportName: "greet",
      params: { name: "world" },
      bridge: {},
    })

    expect(result).toEqual({ message: "hello world" })
  })

  it("resolves an ASYNC handler that settles WITHOUT any bridge call (event-handler early return)", async () => {
    // Regression: the worker's only pending-jobs pump was wired to bridge
    // results, so an async handler that never bridges (the standard
    // filter-and-return-early shape of manifest EVENT handlers, e.g.
    // database:onDatabaseConnected on a non-database account) left its promise
    // reaction jobs unpumped -- the exec hung until the pool killed the worker.
    const result = await pool.execute({
      bundleSource: `async function onEvent(params, ctx) {
        if (params.appName !== "mine") return { skipped: true }
        return { handled: true }
      }`,
      exportName: "onEvent",
      params: { appName: "other" },
      bridge: {},
      timeoutMs: 5000,
    })
    expect(result).toEqual({ skipped: true })
  }, 15_000)

  it("a bridge error's HTTP status reaches the host when the handler lets it propagate", async () => {
    // A kernel service refusal (a projects 404 for a task key that does not
    // exist) crossed the IPC as a bare string, so the handler's rethrow reached
    // execute-tool statusless and was logged at error level, paging the watchdog.
    const err = await pool
      .execute({
        bundleSource: `async function getTask(params, ctx) { return await ctx.projects_get("{}") }`,
        exportName: "getTask",
        params: {},
        bridge: {
          projects_get: async () => {
            const e = new Error('no task with key "ERB-26"')
            ;(e as any).status = 404
            ;(e as any).code = "not_found"
            throw e
          },
        },
      })
      .then(
        () => null,
        (e) => e,
      )
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('no task with key "ERB-26"')
    expect(err.status).toBe(404)
    expect(err.code).toBe("not_found")
  })

  it("a handler catching a bridge error sees its message, and a statusless one stays a string", async () => {
    const result = await pool.execute({
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
          const e = new Error("task not found")
          ;(e as any).status = 404
          ;(e as any).code = "not_found"
          throw e
        },
        plain: async () => {
          throw new Error("boom")
        },
      },
    })
    expect(result).toEqual({
      typed: { message: "task not found", status: 404, code: "not_found" },
      plain: { kind: "string", text: "boom" },
    })
  })

  it("proxies bridge calls back to the main process", async () => {
    const calls: string[] = []

    const result = await pool.execute({
      bundleSource: `async function fetchData(params, ctx) {
        var items = await ctx.db_findMany("items")
        var org = await ctx.getOrgId()
        return { items: items, org: org }
      }`,
      exportName: "fetchData",
      params: {},
      bridge: {
        db_findMany: async (entity: string) => {
          calls.push(`findMany:${entity}`)
          return [{ id: 1, title: "test" }]
        },
        getOrgId: () => {
          calls.push("getOrgId")
          return "org-123"
        },
      },
    })

    expect(result).toEqual({
      items: [{ id: 1, title: "test" }],
      org: "org-123",
    })
    expect(calls).toContain("findMany:items")
    expect(calls).toContain("getOrgId")
  })

  it("handles handler errors without crashing the pool", async () => {
    const err = await pool
      .execute({
        bundleSource: `function fail(params, ctx) { throw new Error("app bug") }`,
        exportName: "fail",
        params: {},
        bridge: {},
      })
      .catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("app bug")

    // Pool still works
    const result = await pool.execute({
      bundleSource: `function ok(params, ctx) { return { ok: true } }`,
      exportName: "ok",
      params: {},
      bridge: {},
    })
    expect(result).toEqual({ ok: true })
  })

  it("blocks ArrayBuffer allocation", async () => {
    const err = await pool
      .execute({
        bundleSource: `function attack(params, ctx) { return new ArrayBuffer(1024) }`,
        exportName: "attack",
        params: {},
        bridge: {},
      })
      .catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain("ArrayBuffer")
  })

  it("enforces memory limit (OOM → error, pool recovers)", async () => {
    const err = await pool
      .execute({
        bundleSource: `function oom(params, ctx) {
        const arr = []
        while(true) arr.push("x".repeat(100000))
      }`,
        exportName: "oom",
        params: {},
        bridge: {},
        memoryLimitBytes: 4 * 1024 * 1024,
        timeoutMs: 10000,
      })
      .catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBeTruthy()

    // Wait for the replacement worker to spawn and finish its handshake.
    await until(() => {
      const s = pool.stats()
      return s.total >= 2 && s.free === s.total
    })

    // Pool still works after OOM
    const result = await pool.execute({
      bundleSource: `function ok(params, ctx) { return { alive: true } }`,
      exportName: "ok",
      params: {},
      bridge: {},
    })
    expect(result).toEqual({ alive: true })
  }, 20000)

  it("handles concurrent requests across workers", async () => {
    // Send exactly as many requests as workers to avoid queuing
    const results = await Promise.all(
      [1, 2].map((n) =>
        pool.execute({
          bundleSource: `function id(params) { return { n: params.n } }`,
          exportName: "id",
          params: { n },
          bridge: {},
        }),
      ),
    )

    expect(results).toEqual([{ n: 1 }, { n: 2 }])
  })

  it("queues requests when all workers are busy", async () => {
    // Create a tiny pool
    const smallPool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await smallPool.init()

    try {
      // Fire two requests concurrently — one runs, one queues
      const [r1, r2] = await Promise.all([
        smallPool.execute({
          bundleSource: `function a(p) { return { v: "a" } }`,
          exportName: "a",
          params: {},
          bridge: {},
        }),
        smallPool.execute({
          bundleSource: `function b(p) { return { v: "b" } }`,
          exportName: "b",
          params: {},
          bridge: {},
        }),
      ])

      expect(r1).toEqual({ v: "a" })
      expect(r2).toEqual({ v: "b" })
    } finally {
      await smallPool.shutdown()
    }
  })

  it("recovers from worker crash", async () => {
    const crashPool = new SandboxWorkerPool({ size: 1, maxSize: 2 })
    await crashPool.init()

    try {
      const err = await crashPool
        .execute({
          bundleSource: `function crash(p) {
          const arr = []
          while(true) arr.push("x".repeat(100000))
        }`,
          exportName: "crash",
          params: {},
          bridge: {},
          memoryLimitBytes: 2 * 1024 * 1024,
          timeoutMs: 10000,
        })
        .catch((e) => e)

      expect(err).toBeInstanceOf(Error)

      // Wait for the replacement worker to spawn and finish its handshake.
      await until(() => {
        const s = crashPool.stats()
        return s.total === 1 && s.free === 1
      })

      // Pool should still work
      const result = await crashPool.execute({
        bundleSource: `function ok(p) { return { recovered: true } }`,
        exportName: "ok",
        params: {},
        bridge: {},
      })
      expect(result).toEqual({ recovered: true })
    } finally {
      await crashPool.shutdown()
    }
  }, 20000)

  // Regression — the shared QuickJS WASM runtime only grows across executions
  // (measured 92MB -> ~1.8GB over 400 varied execs), so long-lived workers
  // ratchet toward the container's cgroup OOM limit. The pool must retire a
  // worker past its exec/RSS threshold and keep serving from a replacement.
  // A settled promise's result handle from getPromiseState was never disposed: it pinned the whole
  // context, bundle included, so an app of a few hundred KB ran the shared runtime out of memory
  // within 77 executions and every execution on that worker then failed until it crashed.
  it("an async handler that settles at once leaves nothing behind in the shared runtime", async () => {
    const leakPool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      memoryLimitBytes: 8 * 1024 * 1024,
      maxExecsPerWorker: 100_000,
    })
    await leakPool.init()
    try {
      const filler = Array.from(
        { length: 3000 },
        (_, i) => `function f${i}() { return { a: ${i} } }`,
      )
      const bundleSource = `${filler.join("\n")}\nasync function ok() { return { ok: true } }`
      for (let i = 0; i < 60; i++) {
        const result = await leakPool.execute({
          bundleSource,
          exportName: "ok",
          params: {},
          bridge: {},
          timeoutMs: 10_000,
        })
        expect(result).toEqual({ ok: true })
      }
    } finally {
      await leakPool.shutdown()
    }
  }, 60_000)

  // The same pin on the paths that do not end in a clean return: a handler that throws skipped the
  // bridge functions' disposal, and a bridge call still unanswered when the execution ended kept its
  // deferred. Either one, at no cost to the tenant, ran the runtime other tenants share out of memory.
  describe("no execution pins its context, however it ends", () => {
    const filler = Array.from({ length: 3000 }, (_, i) => `function f${i}() { return { a: ${i} } }`)
    const bundleOf = (body: string) =>
      `${filler.join("\n")}
      async function boom(params, ctx) { ${body} }
      async function fine() { return { ok: true } }`
    const ping = { ping: async () => "pong" }

    /**
     * 60 rounds of `failing` on one worker, each followed by a clean run. Each run must end its own
     * way: a pinned context shows as `out of memory` in whichever run comes next, and the pool then
     * replaces the worker, so only the runs' own outcomes can tell.
     */
    async function rounds(
      failing: { bundleSource: string; exportName: string },
      bridge: Record<string, (...args: never[]) => Promise<unknown>>,
      ends: { throws: string } | { returns: unknown },
    ) {
      const pool = new SandboxWorkerPool({
        size: 1,
        maxSize: 1,
        memoryLimitBytes: 8 * 1024 * 1024,
        maxExecsPerWorker: 100_000,
      })
      await pool.init()
      const common = { params: {}, bridge, timeoutMs: 10_000 }
      try {
        for (let i = 0; i < 60; i++) {
          const run = pool.execute({ ...common, ...failing })
          if ("throws" in ends) await expect(run).rejects.toThrow(ends.throws)
          else expect(await run).toEqual(ends.returns)
          const after = await pool.execute({
            ...common,
            bundleSource: bundleOf("return 1"),
            exportName: "fine",
          })
          expect(after).toEqual({ ok: true })
        }
      } finally {
        await pool.shutdown()
      }
    }

    it("a handler that throws", async () => {
      await rounds(
        { bundleSource: bundleOf(`throw new Error("nope")`), exportName: "boom" },
        ping,
        { throws: "nope" },
      )
    }, 120_000)

    it("a handler that throws after a bridge call", async () => {
      await rounds(
        { bundleSource: bundleOf(`await ctx.ping(); throw new Error("nope")`), exportName: "boom" },
        ping,
        { throws: "nope" },
      )
    }, 120_000)

    it("an export that does not exist", async () => {
      await rounds({ bundleSource: bundleOf("return 1"), exportName: "missing" }, ping, {
        throws: 'Export "missing" not found',
      })
    }, 120_000)

    it("a bundle that does not evaluate", async () => {
      await rounds(
        { bundleSource: `${bundleOf("return 1")}\nthrow new Error("at load")`, exportName: "fine" },
        ping,
        { throws: "at load" },
      )
    }, 120_000)

    it("a bridge call nobody answered before the handler returned", async () => {
      const never = new Promise<unknown>(() => {})
      await rounds(
        { bundleSource: bundleOf(`ctx.ping(); return { ok: true }`), exportName: "boom" },
        { ping: () => never },
        { returns: { ok: true } },
      )
    }, 120_000)
  })

  // Handler text is the tenant's: an error that merely says it must not retire a worker at will.
  it("an error that only mentions memory does not cost the worker", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1, maxExecsPerWorker: 100_000 })
    await pool.init()
    try {
      const bundleSource = `async function boom() { throw new Error("upstream said: out of memory") }`
      const common = { params: {}, bridge: {}, timeoutMs: 10_000, bundleSource }
      await expect(pool.execute({ ...common, exportName: "boom" })).rejects.toThrow("out of memory")
      // A retiring worker is at once off the free list, and its replacement takes far longer than this.
      await Bun.sleep(20)
      expect(pool.stats().free).toBe(1)
    } finally {
      await pool.shutdown()
    }
  }, 60_000)

  it("everything the pool itself answers when no code ran is a sandbox fault, not the handler's answer", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await pool.init()
    await pool.shutdown()
    const after = await pool
      .execute({ bundleSource: "", exportName: "x", params: {}, bridge: {}, timeoutMs: 1000 })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(isSandboxFault(after)).toBe(true)
    for (const message of [
      "Sandbox worker crashed (exit 1)",
      "Sandbox worker respawn failed — request dropped",
      "App execution exceeded the sandbox worker memory ceiling",
      "Queued sandbox request timed out waiting for a free worker",
      "Worker pool shutting down",
      "Worker IPC deserialization error",
      "App execution timed out",
      "Worker startup timeout",
      "Worker exited during startup (code 1)",
      "Worker message handling failed: x",
      "out of memory",
    ]) {
      expect(isSandboxFault(new Error(message))).toBe(true)
    }
    expect(isSandboxFault(new Error("signature_mismatch"))).toBe(false)
    expect(isSandboxFault(new Error("Bundle evaluation error: Unexpected token"))).toBe(false)
  })

  it("a worker that ran out of memory says so and is replaced at once", async () => {
    const oomPool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      memoryLimitBytes: 4 * 1024 * 1024,
      maxExecsPerWorker: 100_000,
    })
    await oomPool.init()
    try {
      const firstWorkerId = (oomPool as any).workers[0].id as number
      await expect(
        oomPool.execute({
          bundleSource: `var a = []; while (true) { a.push({ x: 1 }) }`,
          exportName: "never",
          params: {},
          bridge: {},
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow("Bundle evaluation error: InternalError: out of memory")
      await until(() => {
        const ws = (oomPool as any).workers as Array<{ id: number; ready: boolean }>
        return ws.length === 1 && ws[0].id !== firstWorkerId && ws[0].ready
      })
      const result = await oomPool.execute({
        bundleSource: `function ok() { return { ok: true } }`,
        exportName: "ok",
        params: {},
        bridge: {},
      })
      expect(result).toEqual({ ok: true })
    } finally {
      await oomPool.shutdown()
    }
  }, 60_000)

  it("recycles a worker after maxExecsPerWorker and keeps serving", async () => {
    const recyclePool = new SandboxWorkerPool({ size: 1, maxSize: 1, maxExecsPerWorker: 2 })
    await recyclePool.init()

    try {
      const firstWorkerId = (recyclePool as any).workers[0].id as number

      const run = () =>
        recyclePool.execute({
          bundleSource: `function ok(p) { return { n: p.n } }`,
          exportName: "ok",
          params: { n: 1 },
          bridge: {},
        })

      await run()
      await run() // hits the threshold -> worker retired after this response

      // Wait for the retired worker to exit and the replacement to spawn.
      await until(() => {
        const ws = (recyclePool as any).workers as Array<{ id: number; ready: boolean }>
        return ws.length === 1 && ws[0].id !== firstWorkerId && ws[0].ready
      })

      const workers = (recyclePool as any).workers as Array<{ id: number }>
      expect(workers.length).toBe(1)
      expect(workers[0].id).not.toBe(firstWorkerId)

      // The fresh worker serves requests as before.
      const result = await run()
      expect(result).toEqual({ n: 1 })
    } finally {
      await recyclePool.shutdown()
    }
  }, 20000)

  it("reports stats correctly", async () => {
    const s = pool.stats()
    expect(s.total).toBeGreaterThanOrEqual(2)
    expect(s.busy).toBe(0)
    expect(s.queued).toBe(0)
  })

  it("spawns every sandbox worker under bun --smol", async () => {
    const pid = (pool as any).workers[0].proc.pid as number
    expect(await processArgv(pid)).toContain("--smol")
  })

  it("does not pass host secrets into the worker environment", () => {
    const sentinel = "SANDBOX_SENTINEL_SECRET"
    const prev = process.env[sentinel]
    process.env[sentinel] = "super-secret-value"
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? "jwt-sentinel"
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? "enc-sentinel"
    try {
      const env = workerEnv()
      // The allowlist must not carry the sentinel or any known host secret.
      expect(env[sentinel]).toBeUndefined()
      expect(env.JWT_SECRET).toBeUndefined()
      expect(env.ENCRYPTION_KEY).toBeUndefined()
      expect(env.DATABASE_URL).toBeUndefined()
      // Only the minimal launcher vars plus the QuickJS host JSC options.
      expect(Object.keys(env).sort()).toEqual(
        ["BUN_JSC_useOMGJIT", "HOME", "NODE_ENV", "PATH"].filter(
          (k) => k === "NODE_ENV" || k.startsWith("BUN_JSC_") || process.env[k] !== undefined,
        ),
      )
    } finally {
      if (prev === undefined) delete process.env[sentinel]
      else process.env[sentinel] = prev
    }
  })

  it("a worker handler cannot reach a parent-set sentinel secret", async () => {
    const sentinel = "SANDBOX_RUNTIME_SENTINEL"
    const prev = process.env[sentinel]
    process.env[sentinel] = "leak-me-if-you-can"
    const probePool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await probePool.init()
    try {
      const result = await probePool.execute({
        bundleSource: `function probe(params, ctx) {
          var hasProcess = typeof process !== "undefined";
          var leaked = hasProcess && process.env ? process.env["${sentinel}"] : undefined;
          return { hasProcess: hasProcess, leaked: leaked === undefined ? null : leaked };
        }`,
        exportName: "probe",
        params: {},
        bridge: {},
      })
      // QuickJS exposes no `process`, and the worker subprocess env carries no
      // secret either — both layers must deny the read.
      expect(result).toEqual({ hasProcess: false, leaked: null })
    } finally {
      await probePool.shutdown()
      if (prev === undefined) delete process.env[sentinel]
      else process.env[sentinel] = prev
    }
  })

  // E5 (liaison-for-tailspin, U8.7): an ASYNC handler that settles BEFORE its
  // first awaited bridge call must have its settlement delivered — not hang
  // until the pool timeout kills the worker. QuickJS promise reactions are
  // jobs; the worker only ran executePendingJobs when a bridge call settled,
  // so a handler whose promise was already settled at call time (synchronous
  // throw — e.g. an approval guard firing first — or an immediate return)
  // left resolvePromise's reactions queued forever. The in-process executor
  // pumps the runtime for exactly this case (executor.ts); the out-of-process
  // worker must match. Note the sync-function variants of these cases take the
  // notAPromise fast path and never hit this — async is load-bearing here.
  describe("async handler settling before any bridge call (E5)", () => {
    it("delivers a synchronous throw from an async handler as the thrown error, not a timeout", async () => {
      const err = await pool
        .execute({
          bundleSource: `async function gated(params, ctx) {
            throw new Error("approval_required: gated verb requires an approved approval_request")
          }`,
          exportName: "gated",
          params: {},
          bridge: { db_findMany: async () => [] }, // bridge exists but is never called
          timeoutMs: 3000,
        })
        .catch((e) => e)

      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("approval_required")
      expect((err as Error).message).not.toContain("timed out")
    })

    it("delivers an immediate return from an async handler that never touches the bridge", async () => {
      const result = await pool.execute({
        bundleSource: `async function quick(params, ctx) { return { ok: true, n: params.n } }`,
        exportName: "quick",
        params: { n: 7 },
        bridge: { db_findMany: async () => [] },
        timeoutMs: 3000,
      })
      expect(result).toEqual({ ok: true, n: 7 })
    })

    it("delivers a first-entry approval-guard throw under the K6 syncContext (gated-tool shape)", async () => {
      const err = await pool
        .execute({
          bundleSource: `async function verb(params, ctx) {
            if (!ctx.approval) throw new Error("approval_required: call via the approval flow")
            return { ok: true }
          }`,
          exportName: "verb",
          params: {},
          bridge: { db_findMany: async () => [] },
          syncContext: { approval: null },
          timeoutMs: 3000,
        })
        .catch((e) => e)

      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toContain("approval_required")
    })

    it("still resolves the re-entry branch (ctx.approval populated) that settles via a bridge call", async () => {
      const result = await pool.execute({
        bundleSource: `async function verb(params, ctx) {
          if (!ctx.approval) throw new Error("approval_required")
          var rows = await ctx.db_findMany("audit")
          return { ok: true, approvalId: ctx.approval.approvalRequestId, rows: rows.length }
        }`,
        exportName: "verb",
        params: {},
        bridge: { db_findMany: async () => [{ id: 1 }] },
        syncContext: {
          approval: {
            approvalRequestId: "apr-1",
            approvalDeciderId: "u-1",
            toolName: "remediation:verb",
          },
        },
        timeoutMs: 3000,
      })
      expect(result).toEqual({ ok: true, approvalId: "apr-1", rows: 1 })
    })
  })
})

// A worker's RSS used to be compared with its cap only after an execution ended,
// so one execution drove a worker to 2031MB against a 512MB cap. This handler
// grows its worker the same way (many bridge calls returning 1MB strings, which
// it keeps) and the pool must stop it mid-flight at the hard ceiling.
describe("SandboxWorkerPool: in-flight memory ceiling", () => {
  it("kills a worker past the hard RSS ceiling mid-execution and rejects with the memory error", async () => {
    const maxWorkerRssBytes = 128 * 1024 * 1024
    const memPool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      maxWorkerRssBytes,
      timeoutMs: 60_000,
    })
    await memPool.init()
    const oneMb = "x".repeat(1024 * 1024)
    // Four times the 256 MB ceiling in rounds of about 1 MB. At 512 (twice
    // it) a loaded machine sampled the worker's RSS late enough that the kill
    // landed after the last round, failing "stopped mid-flight" although the
    // ceiling did fire. A working ceiling still stops it near 256 MB.
    const rounds = 1024
    let bridgeCalls = 0
    let peakRssBytes = 0
    const pid = (memPool as any).workers[0].proc.pid as number
    const peakSampler = setInterval(() => {
      readProcessRssBytes(pid).then((rss) => {
        if (rss !== null && rss > peakRssBytes) peakRssBytes = rss
      })
    }, 50)
    try {
      const outcome = await memPool
        .execute({
          // Each round keeps a fresh array of 131072 numbers, about one megabyte
          // of QuickJS heap the worker really holds. Keeping the bridged strings
          // themselves (or copies of them) stays under 100 MB of RSS: that is not
          // a load the ceiling has to stop.
          bundleSource: `async function hog(p, ctx) {
            var kept = []
            for (var i = 0; i < p.rounds; i++) {
              await ctx.chunk(i)
              var block = new Array(131072)
              for (var j = 0; j < block.length; j++) block[j] = j + i + 0.5
              kept.push(block)
            }
            return { kept: kept.length }
          }`,
          exportName: "hog",
          params: { rounds },
          bridge: {
            chunk: () => {
              bridgeCalls++
              return oneMb
            },
          },
          // QuickJS may hold all of it: this pins the pool's ceiling, not
          // QuickJS's own heap limit.
          memoryLimitBytes: 1536 * 1024 * 1024,
          timeoutMs: 60_000,
        })
        .then(
          (value) => ({ value, error: null as Error | null }),
          (error: Error) => ({ value: null as unknown, error }),
        )
      clearInterval(peakSampler)
      const report = {
        resolved: outcome.value,
        rejectedWith: outcome.error?.name ?? null,
        bridgeCalls,
        peakRssMb: Math.round(peakRssBytes / 1024 / 1024),
        ceilingMb: (2 * maxWorkerRssBytes) / 1024 / 1024,
      }
      console.log(`in-flight memory ceiling: ${JSON.stringify(report)}`)

      expect(report.rejectedWith).toBe("SandboxWorkerMemoryExceeded")
      expect(outcome.error).toBeInstanceOf(SandboxWorkerMemoryError)
      const err = outcome.error as SandboxWorkerMemoryError
      // The ceiling derives from the configured cap: twice it.
      expect(err.ceilingBytes).toBe(2 * maxWorkerRssBytes)
      expect(err.rssBytes).toBeGreaterThan(err.ceilingBytes)
      // Stopped mid-flight, not after the handler finished.
      expect(bridgeCalls).toBeLessThan(rounds)

      // The killed worker is replaced and the pool keeps serving.
      const after = await memPool.execute({
        bundleSource: `function ok(p) { return { alive: true } }`,
        exportName: "ok",
        params: {},
        bridge: {},
      })
      expect(after).toEqual({ alive: true })
    } finally {
      clearInterval(peakSampler)
      await memPool.shutdown()
    }
  }, 120_000)
})

// Cross-execution message fencing (FIX A). Each worker holds a single
// pendingExec; a late `result`/`error` from a PREVIOUS execution (recycle then
// redispatch races) must never resolve/reject the CURRENT execution's promise.
describe("SandboxWorkerPool -- cross-execution message fencing", () => {
  it("drops a stale result whose requestId does not match the current pendingExec", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await pool.init()
    try {
      // Hold the single worker on a bridge-blocked execution so a real
      // pendingExec (with a known requestId) exists.
      let release: (v: unknown) => void = () => {}
      const blocked = new Promise((r) => {
        release = r
      })
      const exec = pool.execute({
        bundleSource: `async function hold(p, ctx) { return await ctx.block() }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })

      // Wait for the exec to bind a pendingExec on the worker.
      const worker = (pool as any).workers[0]
      const currentId = await new Promise<string>((resolve) => {
        const t = setInterval(() => {
          if (worker.pendingExec) {
            clearInterval(t)
            resolve(worker.pendingExec.requestId)
          }
        }, 5)
      })

      // Inject a stale message with a WRONG requestId directly into the handler.
      const staleId = `${currentId}-STALE`
      ;(pool as any).handleMessage(worker.id, {
        type: "error",
        id: staleId,
        error: "tickets_runSync is only available to the tickets app",
      })

      // The current execution must NOT have been rejected by the stale message:
      // its pendingExec is still bound and the promise is unsettled.
      expect(worker.pendingExec).not.toBeNull()
      expect(worker.pendingExec.requestId).toBe(currentId)

      // Real completion of the current execution still works.
      release({ ok: true })
      expect(await exec).toEqual({ ok: true })
    } finally {
      await pool.shutdown()
    }
  }, 15_000)

  it("never selects a worker marked recycling for a new dispatch", async () => {
    const pool = new SandboxWorkerPool({ size: 2, maxSize: 2 })
    await pool.init()
    try {
      const workers = (pool as any).workers as Array<{
        id: number
        busy: boolean
        recycling: boolean
      }>
      // Mark the first worker recycling; findFreeWorker must skip it.
      workers[0].recycling = true
      const picked = (pool as any).findFreeWorker()
      expect(picked).not.toBeNull()
      expect(picked.id).toBe(workers[1].id)

      // With the only remaining worker also recycling, no worker is free.
      workers[1].recycling = true
      expect((pool as any).findFreeWorker()).toBeNull()
    } finally {
      await pool.shutdown()
    }
  })
})

// Cold-start warming + backlog stagger (FIX B).
describe("SandboxWorkerPool -- warm size + boot ramp", () => {
  it("resolveSandboxPoolWarmSize honors env override, defaults to 8, clamps to maxSize", () => {
    // Default when unset.
    expect(resolveSandboxPoolWarmSize(24, {})).toBe(8)
    // SANDBOX_POOL_WARM_SIZE wins.
    expect(resolveSandboxPoolWarmSize(24, { SANDBOX_POOL_WARM_SIZE: "12" })).toBe(12)
    // Legacy APP_WORKER_POOL_SIZE honored as floor.
    expect(resolveSandboxPoolWarmSize(24, { APP_WORKER_POOL_SIZE: "6" })).toBe(6)
    // SANDBOX_POOL_WARM_SIZE beats the legacy var.
    expect(
      resolveSandboxPoolWarmSize(24, { SANDBOX_POOL_WARM_SIZE: "10", APP_WORKER_POOL_SIZE: "3" }),
    ).toBe(10)
    // Clamped to maxSize.
    expect(resolveSandboxPoolWarmSize(4, { SANDBOX_POOL_WARM_SIZE: "16" })).toBe(4)
    // Garbage / non-positive -> default.
    expect(resolveSandboxPoolWarmSize(24, { SANDBOX_POOL_WARM_SIZE: "0" })).toBe(8)
    expect(resolveSandboxPoolWarmSize(24, { SANDBOX_POOL_WARM_SIZE: "nope" })).toBe(8)
  })

  it("boot ramp throttles background concurrency at gate-open and releases after the window", async () => {
    // maxSize 4, reserved 0 -> full background cap is 4.
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 4, reservedInteractive: 0 })
    await pool.init()
    try {
      const capOf = () => (pool as any).backgroundConcurrencyCap as number
      // No ramp armed -> full cap.
      expect(capOf()).toBe(4)

      // Arm a ramp: floor 2, window 60s. Immediately the cap is throttled to the
      // floor (well below the full 4), so the backlog cannot saturate the pool.
      pool.beginBootRamp(60_000, 2)
      expect(capOf()).toBe(2)

      // Re-arm with a zero-length window -> ramp is inert, full cap restored.
      pool.beginBootRamp(0, 2)
      expect(capOf()).toBe(4)
    } finally {
      await pool.shutdown()
    }
  })
})

// Foreground-tool starvation guard (PROGRESS MUST-FIX L219). A sandboxed handler
// holds its worker (and an open Postgres tx) for its whole run, so a burst of
// background work (webhooks/events/jobs/routines) could occupy every worker and
// time out an interactive tool call queued behind it. The pool reserves capacity
// for interactive execs and drains them first.
describe("SandboxWorkerPool — interactive vs background scheduling", () => {
  it("reserves a worker for interactive — background cannot starve a foreground call", async () => {
    const pool = new SandboxWorkerPool({
      size: 2,
      maxSize: 2,
      reservedInteractive: 1,
      timeoutMs: 30_000,
    })
    await pool.init()
    try {
      let release: () => void = () => {}
      const blocked = new Promise<void>((r) => {
        release = r
      })
      const bgBundle = `async function hold(p, ctx) { await ctx.block(); return { bg: true } }`
      const bridge = { block: () => blocked }
      // 2 background execs. Cap = maxSize(2) - reserved(1) = 1, so only ONE may
      // run; the second queues even though a worker is idle (it's reserved).
      const bg1 = pool.execute({
        bundleSource: bgBundle,
        exportName: "hold",
        params: {},
        bridge,
        priority: "background",
      })
      const bg2 = pool.execute({
        bundleSource: bgBundle,
        exportName: "hold",
        params: {},
        bridge,
        priority: "background",
      })
      // Foreground call — must complete on the reserved worker, NOT wait behind
      // the (indefinitely-blocked) background work.
      const fg = pool.execute({
        bundleSource: `function quick(p) { return { fg: true } }`,
        exportName: "quick",
        params: {},
        bridge: {},
        priority: "interactive",
      })
      const winner = await Promise.race([
        fg.then(() => "fg" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000)),
      ])
      expect(winner).toBe("fg")
      expect(await fg).toEqual({ fg: true })
      // Reservation held: 1 background in flight, the 2nd parked in the queue.
      const s = pool.stats()
      expect(s.backgroundInFlight).toBe(1)
      expect(s.queued).toBe(1)
      // Releasing the block lets both background execs drain and complete.
      release()
      expect(await bg1).toEqual({ bg: true })
      expect(await bg2).toEqual({ bg: true })
    } finally {
      await pool.shutdown()
    }
  })

  it("drains a queued interactive request before a queued background one", async () => {
    const pool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      reservedInteractive: 0, // 1-worker pool can reserve none → priority ordering only
      timeoutMs: 30_000,
    })
    await pool.init()
    try {
      let release: () => void = () => {}
      const blocked = new Promise<void>((r) => {
        release = r
      })
      // Occupy the single worker.
      const occupy = pool.execute({
        bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
        priority: "interactive",
      })
      const order: string[] = []
      // Queue background FIRST, then interactive — interactive must drain first.
      const bgQ = pool
        .execute({
          bundleSource: `function b(p) { return {} }`,
          exportName: "b",
          params: {},
          bridge: {},
          priority: "background",
        })
        .then(() => {
          order.push("bg")
        })
      const fgQ = pool
        .execute({
          bundleSource: `function f(p) { return {} }`,
          exportName: "f",
          params: {},
          bridge: {},
          priority: "interactive",
        })
        .then(() => {
          order.push("fg")
        })
      release()
      await Promise.all([occupy, bgQ, fgQ])
      expect(order).toEqual(["fg", "bg"])
    } finally {
      await pool.shutdown()
    }
  })

  // Nested cross-app acquires: a sandboxed handler that calls another app's tool
  // (ctx.executeTool) acquires a SECOND worker of this same pool while holding
  // its own. Measured shape: a pool warmed to one (the test/memory-budget
  // default) serving a prepare-queue read that fans out three cross-app draft
  // resolutions, where two of the three answered "not synced yet" after the
  // per-tool timeout.
  describe("nested cross-app acquires", () => {
    it("serves three concurrent nested acquires while the only warm worker is held", async () => {
      // Warm 1, max 4: the nested acquires must COLD SPAWN their own workers.
      // Before the fix, findFreeWorker handed the first concurrent acquire a
      // worker that had been pushed on to the pool but had not yet sent its
      // ready handshake; the execute message reached a process with no IPC
      // handler, was dropped, and the execution hung to its timeout.
      const pool = new SandboxWorkerPool({ size: 1, maxSize: 4, timeoutMs: 20_000 })
      await pool.init()
      try {
        let release: () => void = () => {}
        const blocked = new Promise<void>((r) => {
          release = r
        })
        let parentHolding = false
        const parent = pool.execute({
          bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
          exportName: "hold",
          params: {},
          bridge: {
            block: () => {
              parentHolding = true
              return blocked
            },
          },
          priority: "interactive",
        })
        // Let the parent take the one warm worker before the nested calls land.
        await until(() => parentHolding)
        expect(pool.stats().free).toBe(0)
        const nested = [0, 1, 2].map(() =>
          pool.execute({
            bundleSource: `function quick(p) { return { ok: true } }`,
            exportName: "quick",
            params: {},
            bridge: {},
            priority: "interactive",
            nested: true,
          }),
        )
        const outcome = await Promise.race([
          Promise.all(nested).then(() => "served" as const),
          Bun.sleep(8_000).then(() => "starved" as const),
        ])
        expect(outcome).toBe("served")
        expect(await Promise.all(nested)).toEqual([{ ok: true }, { ok: true }, { ok: true }])
        release()
        expect(await parent).toEqual({ held: true })
      } finally {
        await pool.shutdown()
      }
    }, 60_000)

    it("dispatches a nested acquire that the background cap and the boot ramp would park", async () => {
      // The parent background execution already counts against the cap, so a
      // nested acquire queued behind it waits for the worker its own caller is
      // holding. During the boot ramp the cap is tighter still.
      const pool = new SandboxWorkerPool({ size: 1, maxSize: 4, timeoutMs: 20_000 })
      await pool.init()
      pool.beginBootRamp(60_000, 2)
      try {
        let release: () => void = () => {}
        const blocked = new Promise<void>((r) => {
          release = r
        })
        let parentHolding = false
        const parent = pool.execute({
          bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
          exportName: "hold",
          params: {},
          bridge: {
            block: () => {
              parentHolding = true
              return blocked
            },
          },
          priority: "background",
        })
        await until(() => parentHolding)
        const nested = [0, 1, 2].map(() =>
          pool.execute({
            bundleSource: `function quick(p) { return { ok: true } }`,
            exportName: "quick",
            params: {},
            bridge: {},
            priority: "background",
            nested: true,
          }),
        )
        const outcome = await Promise.race([
          Promise.all(nested).then(() => "served" as const),
          Bun.sleep(8_000).then(() => "starved" as const),
        ])
        expect(outcome).toBe("served")
        expect(pool.stats().queued).toBe(0)
        release()
        expect(await parent).toEqual({ held: true })
      } finally {
        await pool.shutdown()
      }
    }, 60_000)

    it("serves a nested acquire when the boot ramp floor is FULLY occupied by its own class", async () => {
      // The neighbour above holds ONE background parent against a ramp floor of
      // two, so the cap was never actually reached and the execution dispatched
      // whether or not nested work bypasses the cap. Here both floor slots are
      // held by background parents, so the nested acquire is the only thing the
      // cap can park: without the bypass it queues, and the queue only drains
      // when one of the very parents waiting on it finishes.
      const pool = new SandboxWorkerPool({ size: 2, maxSize: 4, timeoutMs: 20_000 })
      await pool.init()
      pool.beginBootRamp(60_000, 2)
      try {
        let release: () => void = () => {}
        const blocked = new Promise<void>((r) => {
          release = r
        })
        let parentsHolding = 0
        const parents = [0, 1].map(() =>
          pool.execute({
            bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
            exportName: "hold",
            params: {},
            bridge: {
              block: () => {
                parentsHolding++
                return blocked
              },
            },
            priority: "background",
          }),
        )
        await until(() => parentsHolding === 2)
        const before = pool.stats()
        expect(before.backgroundInFlight).toBe(2)
        expect(before.backgroundConcurrencyCap).toBe(2)
        expect(before.free).toBe(0)

        const nested = pool.execute({
          bundleSource: `function quick(p) { return { ok: true } }`,
          exportName: "quick",
          params: {},
          bridge: {},
          priority: "background",
          nested: true,
        })
        const outcome = await Promise.race([
          nested.then(() => "served" as const),
          Bun.sleep(5_000).then(() => "starved" as const),
        ])
        expect(outcome).toBe("served")
        expect(await nested).toEqual({ ok: true })
        release()
        expect(await Promise.all(parents)).toEqual([{ held: true }, { held: true }])
      } finally {
        await pool.shutdown()
      }
    }, 60_000)

    it("bounds one parent's fan-out past the breadth cap, and never queues it", async () => {
      // A nested hop is NEVER parked on the general queue: the slot it would
      // wait for is held by its own caller. So past the breadth cap a parent's
      // extra hops are refused outright, which unwinds into the handler and
      // frees its worker, rather than queued behind a foreground call (which is
      // what they used to do, and what the caller could deadlock on).
      const pool = new SandboxWorkerPool({ size: 1, maxSize: 1, timeoutMs: 20_000 })
      await pool.init()
      try {
        expect(MAX_NESTED_BREADTH_PER_PARENT).toBe(2)
        let release: () => void = () => {}
        const blocked = new Promise<void>((r) => {
          release = r
        })
        const holder = pool.execute({
          bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
          exportName: "hold",
          params: {},
          bridge: { block: () => blocked },
        })
        await until(() => pool.stats().busy === 1)

        // An ordinary foreground call queues behind the holder.
        const foreground = pool.execute({
          bundleSource: `function q(p) { return { who: "interactive" } }`,
          exportName: "q",
          params: {},
          bridge: {},
          priority: "interactive",
        })
        await until(() => pool.stats().queued === 1)

        let releaseHops: () => void = () => {}
        const hopGate = new Promise<void>((r) => {
          releaseHops = r
        })
        const hop = (label: string) =>
          pool.execute({
            bundleSource: `async function hop(p, ctx) { await ctx.gate(); return { who: p.who } }`,
            exportName: "hop",
            params: { who: label },
            bridge: { gate: () => hopGate },
            priority: "interactive",
            nested: true,
            nestedParentKey: "one-parent",
          })
        // Both admitted hops spawn a worker ABOVE maxSize rather than waiting.
        const hops = [hop("nested1"), hop("nested2")]
        await until(() => pool.stats().total === 3)

        const third = (await hop("nested3").catch((e: Error) => e)) as Error
        expect(third).toBeInstanceOf(Error)
        expect(third.name).toBe("SandboxReentrancyLimit")
        // The refusal never touched the queue: the foreground call is still the
        // only thing parked, and the pool did not grow for the refused hop.
        expect(pool.stats().queued).toBe(1)
        expect(pool.stats().total).toBe(3)

        releaseHops()
        expect(await Promise.all(hops)).toEqual([{ who: "nested1" }, { who: "nested2" }])
        expect(await foreground).toEqual({ who: "interactive" })
        release()
        expect(await holder).toEqual({ held: true })
      } finally {
        await pool.shutdown()
      }
    }, 60_000)

    it("a nested storm is bounded by the reentrancy ceiling and every hop settles", async () => {
      // Each hop carries its own parent key, so the breadth cap cannot bound
      // this one: only the ceiling can. Unbounded, a storm would inflate the
      // pool without limit; queued instead, it would hang on workers its own
      // callers hold. Bounded, every hop either runs or is refused at once.
      const pool = new SandboxWorkerPool({
        size: 1,
        maxSize: 4,
        reservedInteractive: 1,
        maxNestedOverflow: 2,
        timeoutMs: 20_000,
      })
      await pool.init()
      expect(pool.stats().maxTotal).toBe(6)
      try {
        let release: () => void = () => {}
        const blocked = new Promise<void>((r) => {
          release = r
        })
        const hold = (bridgeBlock: () => Promise<void>) => ({
          bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
          exportName: "hold",
          params: {},
          bridge: { block: bridgeBlock },
        })
        let parentHolding = false
        const parent = pool.execute({
          ...hold(() => {
            parentHolding = true
            return blocked
          }),
          priority: "background" as const,
        })
        await until(() => parentHolding)

        let releaseStorm: () => void = () => {}
        const stormGate = new Promise<void>((r) => {
          releaseStorm = r
        })
        // Each hop either reaches the gate (and holds a worker) or is refused.
        // Once all six have done one or the other, the storm has spawned every
        // worker it ever will, so sampling until then covers its peak.
        let stormHolding = 0
        let stormRefused = 0
        const storm = [0, 1, 2, 3, 4, 5].map((i) =>
          pool
            .execute({
              ...hold(() => {
                stormHolding++
                return stormGate
              }),
              priority: "background" as const,
              nested: true,
              nestedParentKey: `parent-${i}`,
            })
            .then(
              () => "ok" as const,
              (e: Error) => {
                stormRefused++
                return e.name
              },
            ),
        )

        let peakTotal = 0
        const sample = () => {
          peakTotal = Math.max(peakTotal, pool.stats().total)
          return stormHolding + stormRefused === 6
        }
        await until(sample)
        for (let i = 0; i < 3; i++) {
          await Bun.sleep(5)
          sample()
        }
        expect(peakTotal).toBeLessThanOrEqual(pool.stats().maxTotal)

        releaseStorm()
        release()
        const settled = await Promise.all(storm)
        // Nothing hung: every hop ran or was refused, and a refusal is only ever
        // the reentrancy limit.
        expect(settled).toHaveLength(6)
        expect(settled).toContain("ok")
        for (const outcome of settled) {
          expect(["ok", "SandboxReentrancyLimit"]).toContain(outcome)
        }
        expect(await parent).toEqual({ held: true })
      } finally {
        await pool.shutdown()
      }
    }, 60_000)
  })
})

// `stats().free` counted a still-booting worker as free while findFreeWorker
// (rightly) refused it, and the saturation report tested `busy === total`. A
// pool whose every usable worker is held while a replacement boots therefore
// reported itself unpressured and stayed silent: exactly the state an operator
// needs to see.
describe("SandboxWorkerPool: saturation while a spawn is in flight", () => {
  it("reports pressure when every usable worker is held and a replacement is booting", async () => {
    const warn = spyOn(appsLogger, "warn")
    const pool = new SandboxWorkerPool({ size: 2, maxSize: 2, reportIntervalMs: 100 })
    await pool.init()
    try {
      let release: () => void = () => {}
      const blocked = new Promise<void>((r) => {
        release = r
      })
      const holder = pool.execute({
        bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers.some((w: any) => w.busy)) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })
      // Hold the pool in the state a spawn in flight leaves behind: one worker
      // held, the other present but not yet past its handshake. On this machine
      // a real respawn clears its handshake in tens of milliseconds, far too
      // short to assert against, so the second worker is pinned in that state
      // rather than raced for it.
      const booting = (pool as any).workers.find((w: any) => !w.busy)
      booting.ready = false
      warn.mockClear()

      const saturationWarned = () =>
        warn.mock.calls.some((c: any[]) =>
          c.some((a) => typeof a === "string" && a.includes("Sandbox worker pool saturated")),
        )
      // The report runs every 100 ms; wait for it rather than a fixed span.
      await until(saturationWarned)
      const s = pool.stats()
      expect(s.free).toBe(0)
      expect(s.busy).toBeLessThan(s.total)
      const saturated = warn.mock.calls.filter((c: any[]) =>
        c.some((a) => typeof a === "string" && a.includes("Sandbox worker pool saturated")),
      )
      expect(saturated.length).toBeGreaterThan(0)

      booting.ready = true
      release()
      expect(await holder).toEqual({ held: true })
    } finally {
      warn.mockRestore()
      await pool.shutdown()
    }
  }, 60_000)
})

// The on-demand growth path (`execute` -> `await spawnWorker()` -> `dispatch`)
// hands the freshly spawned worker to its own caller AFTER the handshake, with
// no claim on it in between: the instant the handshake lands the worker is a
// plain free worker, so a queue drain running in that window dispatches a
// QUEUED execution on to it, the spawner's continuation then overwrites
// `pendingExec`, and the queued execution's result is dropped by the requestId
// fence and hangs to its timeout.
describe("SandboxWorkerPool: on-demand spawn against a concurrent queue drain", () => {
  it("loses no result when a drain runs between the handshake and the spawner's dispatch", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 2, timeoutMs: 3_000 })
    await pool.init()
    try {
      let release: () => void = () => {}
      const blocked = new Promise<void>((r) => {
        release = r
      })
      const holder = pool.execute({
        bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers[0].busy) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      const quick = (who: string) => ({
        bundleSource: `function q(p) { return { who: p.who } }`,
        exportName: "q",
        params: { who },
        bridge: {},
      })
      // Grows the pool: awaits the new worker's handshake, then dispatches on it.
      const grower = pool.execute(quick("grower"))
      // The pool is at maxSize now and the new worker is still booting, so these
      // two can only queue.
      const queuedA = pool.execute(quick("queuedA"))
      const queuedB = pool.execute(quick("queuedB"))
      expect(pool.stats().queued).toBe(2)

      // Reproduce the window: drain the queue the instant the booting worker
      // reports ready, before the spawner's continuation dispatches on to it.
      const booting = (pool as any).workers[1]
      let readyFlag: boolean = booting.ready
      Object.defineProperty(booting, "ready", {
        configurable: true,
        get: () => readyFlag,
        set: (v: boolean) => {
          readyFlag = v
          if (v) (pool as any).drainQueue()
        },
      })

      // Settle the handshake, the drain and every dispatch that follows while
      // the holder still pins worker 0, so worker 1 serves all three. A dropped
      // result would reject here at the 3 s execution timeout.
      const settled = await Promise.allSettled([grower, queuedA, queuedB])
      release()

      expect(settled).toEqual([
        { status: "fulfilled", value: { who: "grower" } },
        { status: "fulfilled", value: { who: "queuedA" } },
        { status: "fulfilled", value: { who: "queuedB" } },
      ])
      expect(await holder).toEqual({ held: true })
    } finally {
      await pool.shutdown()
    }
  }, 60_000)
})

// Change A / Change B — cancellation propagation must never let an abandoned
// caller consume a worker slot, and Change B's saturation logging must keep
// firing even when the queued request that triggered it later cancels (so a
// caller giving up never silences the real outage signal).
describe("SandboxWorkerPool: request cancellation", () => {
  it("aborted queued request is removed from the queue promptly", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await pool.init()
    try {
      // Occupy the only worker on a bridge-blocked execution so the next
      // request has to queue.
      let release: (v: unknown) => void = () => {}
      const blocked = new Promise((r) => {
        release = r
      })
      const occupy = pool.execute({
        bundleSource: `async function hold(p, ctx) { return await ctx.block() }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })

      // Wait for the worker to actually be busy before enqueuing the second.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers[0].busy) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      const controller = new AbortController()
      const queued = pool.execute({
        bundleSource: `function b(p) { return { v: "b" } }`,
        exportName: "b",
        params: {},
        bridge: {},
        signal: controller.signal,
      })

      expect(pool.stats().queued).toBe(1)

      const start = Date.now()
      controller.abort()
      const err = await queued.catch((e) => e)
      const elapsedMs = Date.now() - start

      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe("Sandbox request cancelled by caller")
      // Far below the queue budget (timeoutMs + 30000ms) -- must reject almost
      // immediately on abort, not wait out the queue timeout.
      expect(elapsedMs).toBeLessThan(2000)
      expect(pool.stats().queued).toBe(0)

      release({ ok: true })
      await occupy
    } finally {
      await pool.shutdown()
    }
  }, 15_000)

  it("aborted queued request never occupies a worker", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await pool.init()
    try {
      let release: (v: unknown) => void = () => {}
      const blocked = new Promise((r) => {
        release = r
      })
      const occupy = pool.execute({
        bundleSource: `async function hold(p, ctx) { return await ctx.block() }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })

      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers[0].busy) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      let aRan = false
      const controllerA = new AbortController()
      const reqA = pool
        .execute({
          bundleSource: `function a(p) { return { v: "a" } }`,
          exportName: "a",
          params: {},
          bridge: {},
          signal: controllerA.signal,
        })
        .then((v) => {
          aRan = true
          return v
        })
        .catch((e) => e)

      let bRan = false
      const reqB = pool
        .execute({
          bundleSource: `function b(p) { return { v: "b" } }`,
          exportName: "b",
          params: {},
          bridge: {},
        })
        .then((v) => {
          bRan = true
          return v
        })

      // Abort A while both A and B are still queued.
      controllerA.abort()
      // Free the worker; only B should ever be dispatched to it.
      release({ ok: true })

      const [resA, resB] = await Promise.all([reqA, reqB, occupy])
      expect(aRan).toBe(false)
      expect(resA).toBeInstanceOf(Error)
      expect(bRan).toBe(true)
      expect(resB).toEqual({ v: "b" })
    } finally {
      await pool.shutdown()
    }
  }, 15_000)

  it("saturation is still reported when callers cancel", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await pool.init()
    const warnSpy = spyOn(appsLogger, "warn")
    try {
      let release: (v: unknown) => void = () => {}
      const blocked = new Promise((r) => {
        release = r
      })
      const occupy = pool.execute({
        bundleSource: `async function hold(p, ctx) { return await ctx.block() }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })

      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers[0].busy) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      const controller = new AbortController()
      const queued = pool
        .execute({
          bundleSource: `function b(p) { return { v: "b" } }`,
          exportName: "b",
          params: {},
          bridge: {},
          signal: controller.signal,
        })
        .catch((e) => e)

      // The saturation report fires INDEPENDENTLY of caller cancellation.
      ;(pool as any).emitSaturationReportIfPressured()
      const sawSaturationWarn = warnSpy.mock.calls.some(
        (call) => call[1] === "Sandbox worker pool saturated",
      )
      expect(sawSaturationWarn).toBe(true)

      // Now cancel the queued caller — the signal that was already reported
      // must not be retroactively erased, and the pool keeps working.
      controller.abort()
      await queued
      release({ ok: true })
      await occupy
    } finally {
      warnSpy.mockRestore()
      await pool.shutdown()
    }
  }, 15_000)
})

// A QuickJS execution that runs hot gets its asyncify WASM tiered up to JSC's
// optimizing OMG compiler on a background thread, and that compile grows the
// worker by gigabytes, during the executions and for many seconds after the
// last one returned (see QUICKJS_HOST_JSC_ENV in pool.ts). Recycling and the
// in-flight ceiling are pushed out of the way so this measures the worker.
describe("SandboxWorkerPool: QuickJS JIT memory", () => {
  it("a worker under sustained QuickJS load keeps its RSS bounded, during the executions and after", async () => {
    const jitPool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      maxWorkerRssBytes: 64 * 1024 * 1024 * 1024,
      maxExecsPerWorker: 1_000_000,
      timeoutMs: 60_000,
    })
    await jitPool.init()
    const pid = (jitPool as any).workers[0].proc.pid as number
    let peakRssBytes = 0
    const sampler = setInterval(() => {
      readProcessRssBytes(pid).then((rss) => {
        if (rss !== null && rss > peakRssBytes) peakRssBytes = rss
      })
    }, 100)
    const hotMs = 12_000
    const idleMs = 6_000
    let execs = 0
    try {
      const started = Date.now()
      while (Date.now() - started < hotMs) {
        await jitPool.execute({
          bundleSource: `function spin(p) {
            var acc = 0
            for (var i = 0; i < p.n; i++) {
              var o = { a: i, b: String(i), c: [i, i + 1] }
              acc += JSON.stringify(o).length + o.c.reduce(function (x, y) { return x + y }, 0)
            }
            return { acc: acc }
          }`,
          exportName: "spin",
          params: { n: 20_000 },
          bridge: {},
        })
        execs++
      }
      await Bun.sleep(idleMs)
      clearInterval(sampler)
      const report = {
        execs,
        peakRssMb: Math.round(peakRssBytes / 1024 / 1024),
        sameWorker: (jitPool as any).workers[0]?.proc.pid === pid,
      }
      console.log(`QuickJS JIT memory: ${JSON.stringify(report)}`)

      // The measurement covers one worker for the whole run.
      expect(report.sameWorker).toBe(true)
      expect(report.execs).toBeGreaterThan(10)
      // Measured on the dev box: about 1.5 GB and still climbing with the
      // default JSC tiers, about 150 MB with the optimizing WASM tier off.
      expect(report.peakRssMb).toBeLessThan(400)
    } finally {
      clearInterval(sampler)
      await jitPool.shutdown()
    }
  }, 60_000)
})

describe("SandboxWorkerPool: idle worker RSS", () => {
  it("retires an idle worker whose RSS is past the cap, and keeps serving", async () => {
    // A fresh worker already sits above a 16 MB cap without running anything:
    // it stands in for memory that grew after the last execution returned,
    // which neither the post-exec check nor the in-flight sampler sees.
    const idlePool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      maxWorkerRssBytes: 16 * 1024 * 1024,
      idleRssSampleIntervalMs: 100,
    })
    const infoSpy = spyOn(appsLogger, "info")
    await idlePool.init()
    const first = (idlePool as any).workers[0].proc as { exited: Promise<number> }
    try {
      const retired = await Promise.race([
        first.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ])
      expect(retired).toBe(true)
      expect(
        infoSpy.mock.calls.some(
          (call) => call[1] === "Recycling idle sandbox worker past its RSS cap",
        ),
      ).toBe(true)

      const after = await idlePool.execute({
        bundleSource: `function ok(p) { return { alive: true } }`,
        exportName: "ok",
        params: {},
        bridge: {},
      })
      expect(after).toEqual({ alive: true })
    } finally {
      infoSpy.mockRestore()
      await idlePool.shutdown()
    }
  }, 30_000)
})

// A spawn that never reports ready used to leak BOTH the process and the
// handle: the startup timeout rejected the acquire, `handleWorkerExit` could
// not clean up (it runs off `proc.exited`, which a hung start never reaches)
// and the on-demand growth path had already marked the handle busy for its own
// caller. The pool was left with a worker that is present, busy and dead, and
// `maxSize` such events wedged it for good.
describe("SandboxWorkerPool: a spawn that never reports ready", () => {
  it("kills the process, drops the handle and still serves the next acquire", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 2, timeoutMs: 5_000 })
    await pool.init()
    // Squeeze the boot budget only AFTER the warm worker is up, so the failing
    // spawn is the on-demand one and nothing else.
    ;(pool as any).startupTimeoutMs = 1
    try {
      // The warm worker takes the first execution and holds it, so the next
      // acquire has to grow the pool and hit the 1 ms startup budget.
      let release: () => void = () => {}
      const blocked = new Promise<void>((r) => {
        release = r
      })
      const holder = pool.execute({
        bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers[0].busy) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      const grower = pool.execute({
        bundleSource: `function q(p) { return { ok: true } }`,
        exportName: "q",
        params: {},
        bridge: {},
      })
      await expect(grower).rejects.toThrow(/startup timeout/i)

      // The dead handle is gone, the warm worker is untouched, and nothing is
      // left claimed: before the fix this read { total: 2, busy: 2 }.
      const after = pool.stats()
      expect(after.total).toBe(1)
      expect(after.busy).toBe(1)
      expect(after.queued).toBe(0)

      release()
      expect(await holder).toEqual({ held: true })

      // And the pool still works: with the warm worker free again the next
      // acquire is served without growing at all.
      const next = await pool.execute({
        bundleSource: `function q(p) { return { served: true } }`,
        exportName: "q",
        params: {},
        bridge: {},
      })
      expect(next).toEqual({ served: true })
      expect(pool.stats().busy).toBe(0)
    } finally {
      await pool.shutdown()
    }
  }, 60_000)

  it("leaves nothing claimed after an idle pool's growth spawn times out", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 2 })
    await pool.init()
    ;(pool as any).startupTimeoutMs = 1
    try {
      const before = pool.stats().total
      // Grow the pool directly: no execution involved, so the only thing under
      // test is what a failed spawn leaves behind.
      await expect((pool as any).spawnWorker(true)).rejects.toThrow(/startup timeout/i)
      const after = pool.stats()
      expect(after.total).toBe(before)
      expect(after.busy).toBe(0)
      expect(after.free).toBe(before)
    } finally {
      await pool.shutdown()
    }
  }, 30_000)
})

// The two mechanisms that keep one worker from carrying two executions are
// separable, and the regression test above passes with either one removed
// (each on its own is enough to keep the RESULTS intact). These two pin them
// one at a time: the first is red only without the spawner's claim, the second
// only without the dispatch guard.
describe("SandboxWorkerPool: the two halves of the double-bind protection", () => {
  it("keeps a queue drain off the worker the spawner is about to dispatch on", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 2, timeoutMs: 5_000 })
    await pool.init()
    try {
      let release: () => void = () => {}
      const blocked = new Promise<void>((r) => {
        release = r
      })
      const holder = pool.execute({
        bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers[0].busy) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      const quick = (who: string) => ({
        bundleSource: `function q(p) { return { who: p.who } }`,
        exportName: "q",
        params: { who },
        bridge: {},
      })
      const grower = pool.execute(quick("grower"))
      const queuedA = pool.execute(quick("queuedA"))
      const queuedB = pool.execute(quick("queuedB"))
      expect(pool.stats().queued).toBe(2)

      // What a drain sees at the exact instant the spawner's worker reports
      // ready, which is the whole window the claim exists to close.
      let queuedAtHandshake = -1
      let boundAtHandshake: unknown = "unobserved"
      const booting = (pool as any).workers[1]
      let readyFlag: boolean = booting.ready
      Object.defineProperty(booting, "ready", {
        configurable: true,
        get: () => readyFlag,
        set: (v: boolean) => {
          readyFlag = v
          if (!v) return
          ;(pool as any).drainQueue()
          queuedAtHandshake = pool.stats().queued
          boundAtHandshake = booting.pendingExec
        },
      })

      // Settle everything on worker 1 while the holder still pins worker 0.
      const settled = await Promise.allSettled([grower, queuedA, queuedB])
      release()

      expect(settled).toEqual([
        { status: "fulfilled", value: { who: "grower" } },
        { status: "fulfilled", value: { who: "queuedA" } },
        { status: "fulfilled", value: { who: "queuedB" } },
      ])
      expect(await holder).toEqual({ held: true })

      // Unclaimed, the drain takes the worker out from under the spawner: the
      // queue drops to 1 and a queued execution is already bound to it.
      expect(queuedAtHandshake).toBe(2)
      expect(boundAtHandshake).toBeNull()
    } finally {
      await pool.shutdown()
    }
  }, 60_000)

  it("requeues a dispatch that reaches a worker with a live execution", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1, timeoutMs: 5_000 })
    await pool.init()
    try {
      let release: () => void = () => {}
      const blocked = new Promise<void>((r) => {
        release = r
      })
      const holder = pool.execute({
        bundleSource: `async function hold(p, ctx) { await ctx.block(); return { held: true } }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
      })
      const worker = await new Promise<any>((resolve) => {
        const t = setInterval(() => {
          const w = (pool as any).workers[0]
          if (w?.pendingExec) {
            clearInterval(t)
            resolve(w)
          }
        }, 5)
      })
      const boundRequestId = worker.pendingExec.requestId

      // Drive the guard directly: no ordinary path can reach a busy worker
      // today (findFreeWorker and dispatch run in one synchronous step, and the
      // spawner's claim closes the one asynchronous gap), so this is the only
      // way to assert the invariant the guard states.
      const second = (pool as any).dispatch(
        worker,
        {
          bundleSource: `function q(p) { return { second: true } }`,
          exportName: "q",
          params: {},
          bridge: {},
        },
        "interactive",
        false,
      )
      // Requeued, not bound: the holder's execution is still the one on the
      // worker. Without the guard the second dispatch overwrites pendingExec
      // and the requestId fence then drops the holder's result.
      expect(pool.stats().queued).toBe(1)
      expect(worker.pendingExec.requestId).toBe(boundRequestId)

      release()
      expect(await holder).toEqual({ held: true })
      expect(await second).toEqual({ second: true })
    } finally {
      await pool.shutdown()
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// Reentrancy. A bundled app's tool handler can call another app's tool through
// `ctx.executeTool`; that nested dispatch goes rpc-bridge -> executeToolCore ->
// execute-tool's runManifest -> getWorkerPool().execute(), i.e. straight back
// into THIS pool while the calling handler still holds its worker. The bridge
// functions below stand in for exactly that path.
//
// Before the fix a nested dispatch queued like any other request, so N such
// calls on a pool of N workers all waited for slots their own callers were
// holding: a textbook thread-pool reentrancy deadlock that only unwound at the
// worker kill timer (timeoutMs + 2000), long after the HTTP layer had answered
// 504 and the operator had seen "Request failed".
// ---------------------------------------------------------------------------
describe("SandboxWorkerPool: nested (reentrant) dispatch", () => {
  it("N reentrant executions all complete on a pool of N workers", async () => {
    const N = 3
    const pool = new SandboxWorkerPool({
      size: N,
      maxSize: N,
      reservedInteractive: 0,
      timeoutMs: 10_000,
    })
    await pool.init()
    try {
      const outerBundle = `async function outer(p, ctx) {
        var inner = await ctx.callNested(p.i)
        return { i: p.i, inner: inner }
      }`
      const innerBundle = `function inner(p, ctx) { return { ok: p.i } }`

      const outers = Array.from({ length: N }, (_, i) =>
        pool.execute({
          bundleSource: outerBundle,
          exportName: "outer",
          params: { i },
          timeoutMs: 10_000,
          bridge: {
            // The nested cross-app call: same pool, while this handler's worker
            // is still held.
            callNested: (j: number) =>
              pool.execute({
                bundleSource: innerBundle,
                exportName: "inner",
                params: { i: j },
                bridge: {},
                nested: true,
                timeoutMs: 10_000,
              }),
          },
        }),
      )

      // Without the fix every nested call queues behind the N busy workers and
      // each outer execution dies at its own kill timer with
      // "App execution timed out" -- this Promise.all rejects.
      const results = await Promise.all(outers)
      expect(results).toEqual(Array.from({ length: N }, (_, i) => ({ i, inner: { ok: i } })))
      // Overflow is real but bounded: the pool grew past maxSize, never past
      // the declared ceiling.
      const s = pool.stats()
      expect(s.total).toBeGreaterThan(N)
      expect(s.total).toBeLessThanOrEqual(s.maxTotal)
    } finally {
      await pool.shutdown()
    }
  }, 45_000)

  it("nested admission is bounded: a deep recursive chain never spawns past the ceiling", async () => {
    // Ceiling = maxSize(1) + nested headroom(2) = 3 workers, total, ever.
    const pool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      reservedInteractive: 0,
      maxNestedOverflow: 2,
      timeoutMs: 10_000,
    })
    await pool.init()
    expect(pool.stats().maxTotal).toBe(3)
    try {
      const refusals: string[] = []
      // Each frame recurses one level deeper through a nested dispatch.
      const recBundle = `async function rec(p, ctx) {
        if (p.depth <= 0) return { reached: 0 }
        var r = await ctx.deeper(p.depth - 1)
        if (r && r.refused) return { reached: 0 }
        return { reached: (r && r.reached != null ? r.reached : 0) + 1 }
      }`
      const deeper = (depth: number): Promise<unknown> =>
        pool
          .execute({
            bundleSource: recBundle,
            exportName: "rec",
            params: { depth },
            bridge: { deeper },
            nested: true,
            timeoutMs: 10_000,
          })
          .catch((e: Error) => {
            refusals.push(e.name)
            return { refused: true }
          })

      const root = await pool.execute({
        bundleSource: recBundle,
        exportName: "rec",
        // Far deeper than the ceiling allows.
        params: { depth: 12 },
        bridge: { deeper },
        timeoutMs: 10_000,
      })

      // The root settles (no deadlock, no kill-timer unwind)...
      expect(root).toBeDefined()
      // ...the recursion was cut off by the reentrancy ceiling, not by a hang...
      expect(refusals).toContain("SandboxReentrancyLimit")
      // ...and the pool never spawned more than the ceiling. nextWorkerId is
      // monotonic, so it counts every worker ever spawned in this pool.
      expect((pool as any).nextWorkerId).toBeLessThanOrEqual(3)
      expect(pool.stats().total).toBeLessThanOrEqual(3)
    } finally {
      await pool.shutdown()
    }
  }, 45_000)

  it("a wide nested fan-out is bounded too and every call still settles", async () => {
    const pool = new SandboxWorkerPool({
      size: 1,
      maxSize: 1,
      reservedInteractive: 0,
      maxNestedOverflow: 2,
      timeoutMs: 10_000,
    })
    await pool.init()
    try {
      let release: (v: unknown) => void = () => {}
      const blocked = new Promise((r) => {
        release = r
      })
      // Occupy the single non-nested worker for the whole test.
      const occupy = pool.execute({
        bundleSource: `async function hold(p, ctx) { return await ctx.block() }`,
        exportName: "hold",
        params: {},
        bridge: { block: () => blocked },
        timeoutMs: 10_000,
      })

      const settled = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          pool
            .execute({
              bundleSource: `function n(p) { return { v: p.i } }`,
              exportName: "n",
              params: { i },
              bridge: {},
              nested: true,
              timeoutMs: 10_000,
            })
            .then(
              () => "ok" as const,
              () => "refused" as const,
            ),
        ),
      )

      // Nothing hung: every nested call either ran or was refused immediately.
      expect(settled).toHaveLength(8)
      expect(settled).toContain("ok")
      expect((pool as any).nextWorkerId).toBeLessThanOrEqual(3)

      release({ ok: true })
      await occupy
    } finally {
      await pool.shutdown()
    }
  }, 45_000)
})

// ---------------------------------------------------------------------------
// Caller abort DURING an execution. dispatch() used to ignore `signal`
// entirely, so a request that 504'd at REQUEST_TIMEOUT_MS kept its worker until
// the kill timer (timeoutMs + 2000) -- which is what turned operator re-clicks
// into a rolling outage.
// ---------------------------------------------------------------------------
describe("SandboxWorkerPool: abort of an already-running execution", () => {
  it("releases the worker promptly, well before the kill timer", async () => {
    // Kill timer would be timeoutMs + 2000 = 22s. A single-worker pool means the
    // follow-up request can only run once the aborted one's slot comes back.
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1, timeoutMs: 20_000 })
    await pool.init()
    try {
      let release: (v: unknown) => void = () => {}
      const blocked = new Promise((r) => {
        release = r
      })
      const controller = new AbortController()
      const running = pool
        .execute({
          bundleSource: `async function hold(p, ctx) { return await ctx.block() }`,
          exportName: "hold",
          params: {},
          bridge: { block: () => blocked },
          signal: controller.signal,
          timeoutMs: 20_000,
        })
        .catch((e: Error) => e)

      // Wait until the execution is genuinely RUNNING (not queued).
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if ((pool as any).workers[0]?.busy) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      const start = Date.now()
      controller.abort()

      const err = (await running) as Error
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe("SandboxRequestCancelled")

      // A subsequent request gets a worker without waiting out the kill timer.
      const next = await pool.execute({
        bundleSource: `function ok(p) { return { ok: true } }`,
        exportName: "ok",
        params: {},
        bridge: {},
        timeoutMs: 20_000,
      })
      const elapsedMs = Date.now() - start
      expect(next).toEqual({ ok: true })
      // Without the fix this takes ~22s (kill timer); with it, one worker
      // respawn (~1s).
      expect(elapsedMs).toBeLessThan(10_000)

      release({ ok: true })
    } finally {
      await pool.shutdown()
    }
  }, 60_000)

  it("logs an abort that killed a handler mid-side-effect, at warn: the caller went away", async () => {
    const pool = new SandboxWorkerPool({ size: 1, maxSize: 1, timeoutMs: 20_000 })
    await pool.init()
    const warnSpy = spyOn(appsLogger, "warn")
    const errSpy = spyOn(appsLogger, "error")
    try {
      let release: (v: unknown) => void = () => {}
      const blocked = new Promise((r) => {
        release = r
      })
      const controller = new AbortController()
      // The handler makes a bridge call (a committed host-side side effect)
      // and then blocks on a second one.
      const running = pool
        .execute({
          bundleSource: `async function work(p, ctx) {
            await ctx.sideEffect()
            return await ctx.block()
          }`,
          exportName: "work",
          params: {},
          bridge: { sideEffect: async () => ({ done: true }), block: () => blocked },
          signal: controller.signal,
          appId: "boxtal",
          toolName: "print_pack",
          timeoutMs: 20_000,
        })
        .catch((e: Error) => e)

      // Wait until the first bridge call has been serviced.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (((pool as any).workers[0]?.pendingExec?.bridgeCallCount ?? 0) > 0) {
            clearInterval(t)
            resolve()
          }
        }, 5)
      })

      controller.abort()
      const rejected = await running

      const halfDone = warnSpy.mock.calls.find(
        (call) => typeof call[1] === "string" && call[1].includes("aborted by caller mid-handler"),
      )
      expect(halfDone?.[0]).toMatchObject({
        reason: "caller_cancelled",
        sideEffectsCommitted: true,
      })
      expect(
        errSpy.mock.calls.some(
          (call) => typeof call[1] === "string" && call[1].includes("aborted"),
        ),
      ).toBe(false)
      // The rejection is named, so every seam classifies it as a cancellation.
      expect((rejected as Error).name).toBe("SandboxRequestCancelled")
      release({ ok: true })
    } finally {
      warnSpy.mockRestore()
      errSpy.mockRestore()
      await pool.shutdown()
    }
  }, 60_000)
})

describe("SandboxWorkerPool: worker runtime", () => {
  it("spawns workers with the runtime the pool itself runs on, not a PATH bun", async () => {
    const spawn = spyOn(Bun, "spawn")
    const onePool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    try {
      await onePool.init()
      const argv = spawn.mock.calls[0]?.[0] as string[]
      expect(argv[0]).toBe(process.execPath)
    } finally {
      spawn.mockRestore()
      await onePool.shutdown()
    }
  })
})
