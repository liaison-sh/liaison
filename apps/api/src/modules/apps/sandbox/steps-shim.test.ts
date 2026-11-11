// SPDX-License-Identifier: FSL-1.1-ALv2
// `ctx.steps.run`, `ctx.jobs.enqueue` and `ctx.timers.wakeIn` through the three
// ctx builds: the worker pool's QuickJS source, the in-process executor's
// QuickJS shim and the isolate's native `createCtx`. The same handler over the
// same host (bridge/steps.ts over in-memory storage) must make the same bridge
// calls and return the same answers on each.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { MemoryStepsHost } from "~/modules/apps/sandbox/bridge/steps-memory.testutil"
import { createCtx } from "~/modules/apps/sandbox/ctx-shim"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"
import { SandboxWorkerPool } from "~/modules/apps/sandbox/worker-pool"

type AnyBridge = Record<string, (...args: any[]) => unknown>
type Call = { method: string; args: unknown[] }
type Runner = (source: string, params: unknown, bridge: AnyBridge) => Promise<unknown>

// Pages 0..4, two per run (the host clock advances 4 s per chunk, budget 6 s),
// then a chunk that throws on a second step, then the enqueue and timer calls.
const FIXTURE = `async function pages(params, ctx) {
  var seen = []
  var runs = []
  var payload = params
  for (var i = 0; i < 10; i++) {
    var out = await ctx.steps.run("pages", { budgetMs: 6000 }, async function (cursor) {
      var page = cursor === null ? 0 : cursor
      seen.push(page)
      await ctx.tick()
      return { done: page + 1 >= 5, cursor: page + 1 }
    })
    runs.push(out)
    if (out.state !== "scheduled") break
    payload = await ctx.nextPayload()
    await ctx.usePayload(payload)
  }
  var thrown = null
  try {
    await ctx.steps.run("other", async function () { throw new Error("chunk failed") })
  } catch (e) {
    thrown = String(e && e.message ? e.message : e)
  }
  await ctx.jobs.enqueue("sync", { page: 2 }, { delay: 5000, jobId: "sync-2" })
  await ctx.timers.wakeIn(90, "poll", { report: "r1" }, { jobId: "poll" })
  var state = await ctx.steps.get("pages")
  return { seen: seen, runs: runs, thrown: thrown, state: state }
}`

/** A host whose bridge follows the job: `usePayload` switches the run's payload. */
function hostBridge(calls: Call[]): AnyBridge {
  const host = new MemoryStepsHost("sync", 10_000)
  let steps = host.bridge({})
  const rec =
    (method: string, fn: (...a: any[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return fn(...args)
    }
  return {
    _steps_begin: rec("_steps_begin", (...a: unknown[]) => steps._steps_begin!(...a)),
    _steps_save: rec("_steps_save", (...a: unknown[]) => steps._steps_save!(...a)),
    steps_get: rec("steps_get", (name: string) => {
      const d = host.docs.get(name)
      return JSON.stringify(d ? { cursor: d.state.cursor, done: d.state.done } : null)
    }),
    jobs_enqueue: rec("jobs_enqueue", () => undefined),
    timers_wakeIn: rec("timers_wakeIn", () => undefined),
    // Test plumbing (raw group-less names): the clock and the queue.
    tick: async () => {
      host.now += 4_000
    },
    nextPayload: async () => JSON.stringify(host.take().payload),
    usePayload: async (json: string) => {
      steps = host.bridge(JSON.parse(json))
    },
  }
}

const EXPECTED = {
  seen: [0, 1, 2, 3, 4],
  runs: [
    { state: "scheduled", cursor: 2, chunks: 2 },
    { state: "scheduled", cursor: 4, chunks: 2 },
    { state: "done", cursor: 5, chunks: 1 },
  ],
  thrown: "chunk failed",
  state: { cursor: 5, done: true },
}

const wire = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))

const runNative: Runner = async (source, params, bridge) => {
  const ctx = createCtx(Object.keys(bridge), null, async (method, args) =>
    wire(await bridge[method]!(...(wire(args) as unknown[]))),
  )
  const handler = new Function(`${source}\nreturn pages`)() as (
    p: unknown,
    c: unknown,
  ) => Promise<unknown>
  return wire(await handler(params, ctx))
}

describe("ctx.steps / jobs / timers on every ctx build", () => {
  let workerPool: SandboxWorkerPool
  let inProcess: SandboxPool

  beforeAll(async () => {
    workerPool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await workerPool.init()
    inProcess = await createSandboxPool({ initialSize: 1, maxSize: 1 })
  }, 60_000)

  afterAll(async () => {
    if (workerPool) await workerPool.shutdown()
    if (inProcess) await inProcess.shutdown()
  }, 60_000)

  const runners: Array<[string, () => Runner]> = [
    [
      "worker pool",
      () => (source, params, bridge) =>
        workerPool.execute({ bundleSource: source, exportName: "pages", params, bridge }),
    ],
    [
      "in-process",
      () => (source, params, bridge) =>
        executeInSandbox({
          pool: inProcess,
          bundleSource: source,
          exportName: "pages",
          params,
          bridge,
        }),
    ],
    ["createCtx", () => runNative],
  ]

  const results: Record<string, { result: unknown; calls: Call[] }> = {}

  for (const [label, runner] of runners) {
    it(`${label}: pages over three runs, a failed chunk, enqueue and timer`, async () => {
      const calls: Call[] = []
      const result = await runner()(FIXTURE, {}, hostBridge(calls))
      expect(result).toEqual(EXPECTED)
      // The hidden methods are not on the flat surface; the claim/save calls
      // carry JSON text (structured group marshalling).
      expect(calls.filter((c) => c.method === "_steps_begin")).toHaveLength(4)
      const failSave = calls.find(
        (c) => c.method === "_steps_save" && String(c.args[2]).includes('"failed":true'),
      )
      expect(failSave?.args[0]).toBe("other")
      expect(calls.find((c) => c.method === "jobs_enqueue")?.args).toEqual([
        "sync",
        '{"page":2}',
        '{"delay":5000,"jobId":"sync-2"}',
      ])
      expect(calls.find((c) => c.method === "timers_wakeIn")?.args).toEqual([
        90,
        "poll",
        '{"report":"r1"}',
        '{"jobId":"poll"}',
      ])
      results[label] = { result, calls }
    })
  }

  it("the three builds made the same bridge calls", () => {
    const [first, ...rest] = Object.values(results)
    expect(first).toBeDefined()
    for (const r of rest) expect(r.calls).toEqual(first!.calls)
  })

  it("the hidden step methods stay off the flat ctx", async () => {
    const probe = `async function pages(params, ctx) {
      return { begin: typeof ctx._steps_begin, save: typeof ctx._steps_save, run: typeof ctx.steps.run }
    }`
    const bridge = hostBridge([])
    for (const [, runner] of runners) {
      expect(await runner()(probe, {}, bridge)).toEqual({
        begin: "undefined",
        save: "undefined",
        run: "function",
      })
    }
  })
})
