// SPDX-License-Identifier: FSL-1.1-ALv2
// `ctx.steps.run` host side (bridge/steps.ts): claim, budget, hand-over,
// crash recovery, deduplication, stale continuations. The host's storage and
// queue are in memory (steps-memory.testutil.ts); the guest loop is the native
// shim (`createCtx`), the same code an isolate runs.
import { describe, expect, it } from "bun:test"
import {
  STEP_CONTINUATION_DELAY_MS,
  STEP_LEASE_GRACE_MS,
  stepBudgetMs,
  stepContinuationId,
} from "~/modules/apps/sandbox/bridge/steps"
import { MemoryStepsHost } from "~/modules/apps/sandbox/bridge/steps-memory.testutil"
import { createCtx } from "~/modules/apps/sandbox/ctx-shim"

type StepsCtx = {
  steps: {
    run: (
      name: string,
      opts: unknown,
      chunk: (cursor: any) => Promise<unknown>,
    ) => Promise<{ state: string; cursor: unknown; chunks: number }>
  }
}

/** One run of the job: the native ctx over the host's bridge for `payload`. */
function ctxFor(host: MemoryStepsHost, payload: Record<string, unknown> = {}): StepsCtx {
  const bridge = host.bridge(payload)
  return createCtx(Object.keys(bridge), null, async (m, args) =>
    JSON.parse(
      JSON.stringify(await bridge[m]!(...(JSON.parse(JSON.stringify(args)) as unknown[]))),
    ),
  ) as unknown as StepsCtx
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as { code?: string; status?: number; message: string }
  }
  throw new Error("expected a rejection")
}

describe("ctx.steps.run: where it may run", () => {
  it("refuses outside a job, and in an atomic job", async () => {
    const host = new MemoryStepsHost()
    expect((await errorOf(host.core({}, { noJob: true }).begin("s", {}))).code).toBe(
      "steps_outside_job",
    )
    expect((await errorOf(host.core({}, { atomic: true }).begin("s", {}))).code).toBe(
      "steps_in_atomic_job",
    )
  })

  it("refuses a bad name, bad options and a bad chunk answer (releasing the claim)", async () => {
    const host = new MemoryStepsHost()
    const core = host.core()
    expect((await errorOf(core.begin("no spaces", {}))).code).toBe("invalid_step_name")
    expect((await errorOf(core.begin("s", { budgetMs: -1 }))).code).toBe("invalid_step_options")
    const claim = await core.begin("s", {})
    if (claim.state !== "run") throw new Error("not claimed")
    expect((await errorOf(core.save("s", claim.token, { result: { cursor: 1 } }))).code).toBe(
      "invalid_step_result",
    )
    expect(host.docs.get("s")?.state.lease).toBeNull()
    expect((await core.begin("s", {})).state).toBe("run")
  })

  it("clamps the budget to 80% of the job timeout; defaults to half", () => {
    expect(stepBudgetMs(undefined, 60_000)).toBe(30_000)
    expect(stepBudgetMs(10_000, 60_000)).toBe(10_000)
    expect(stepBudgetMs(600_000, 60_000)).toBe(48_000)
  })
})

describe("ctx.steps.run: N pages over several runs", () => {
  it("runs chunks while the budget lasts, then hands over to a continuation, until done", async () => {
    const host = new MemoryStepsHost()
    const pages = 7
    const seen: number[] = []
    // Each chunk costs 4 s of the 10 s budget: three chunks per run.
    const chunk = async (cursor: number | null) => {
      const page = cursor ?? 0
      seen.push(page)
      host.now += 4_000
      return { done: page + 1 >= pages, cursor: page + 1 }
    }
    let out = await ctxFor(host).steps.run("backfill", { budgetMs: 10_000 }, chunk)
    expect(out).toEqual({ state: "scheduled", cursor: 3, chunks: 3 })
    let runs = 1
    while (host.queue.length > 0) {
      const next = host.take()
      expect(next.delayMs).toBe(STEP_CONTINUATION_DELAY_MS)
      out = await ctxFor(host, next.payload).steps.run("backfill", { budgetMs: 10_000 }, chunk)
      runs++
    }
    expect(out).toEqual({ state: "done", cursor: 7, chunks: 1 })
    expect(runs).toBe(3)
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6])
    // Done stays done: a later trigger runs nothing.
    expect(await ctxFor(host).steps.run("backfill", {}, chunk)).toEqual({
      state: "done",
      cursor: 7,
      chunks: 0,
    })
    expect(seen).toHaveLength(7)
  })

  it("a chunk's wakeIn ends the run and delays the continuation", async () => {
    const host = new MemoryStepsHost()
    const out = await ctxFor(host).steps.run("report", {}, async () => ({
      done: false,
      cursor: { reportId: "r1" },
      wakeIn: 20,
    }))
    expect(out).toEqual({ state: "scheduled", cursor: { reportId: "r1" }, chunks: 1 })
    const next = host.take()
    expect(next.delayMs).toBe(20_000)
    const epoch = host.docs.get("report")!.state.epoch
    expect(next.jobId).toBe(stepContinuationId("report", epoch, 1))
    expect(next.payload._steps).toEqual({ report: { epoch, gen: 1 } })
  })
})

describe("ctx.steps.run: duplicates and crashes", () => {
  it("a concurrent duplicate runs no chunk; duplicates share one lease wake", async () => {
    const host = new MemoryStepsHost()
    const a = host.core()
    const claim = await a.begin("s", {})
    expect(claim.state).toBe("run")
    let ran = 0
    const dup = async () =>
      ctxFor(host).steps.run("s", {}, async () => {
        ran++
        return { done: true }
      })
    expect((await dup()).state).toBe("skipped")
    expect((await dup()).state).toBe("skipped")
    expect(ran).toBe(0)
    expect(host.queue).toHaveLength(1)
    expect(host.deduped).toBe(1)
    const lease = host.docs.get("s")!.state.lease!
    expect(host.queue[0]!.delayMs).toBe(lease.until - host.now + 1_000)
  })

  it("a claim lost to a concurrent run between read and write: skipped", async () => {
    const host = new MemoryStepsHost()
    host.failNextWrite.add("s")
    expect((await host.core().begin("s", {})).state).toBe("skipped")
  })

  it("a run that died mid-chunk: its retry waits for the lease, then the chunk is redone from the saved cursor", async () => {
    const host = new MemoryStepsHost()
    const seen: number[] = []
    // Run 1 saves pages 0 and 1, then dies inside page 2 (no save, no release).
    let die = true
    const chunk = async (cursor: number | null) => {
      const page = cursor ?? 0
      seen.push(page)
      if (page === 2 && die) {
        die = false
        throw new Error("process killed")
      }
      return { done: page >= 3, cursor: page + 1 }
    }
    const core = host.core()
    const claim = await core.begin("s", { budgetMs: 30_000 })
    if (claim.state !== "run") throw new Error("not claimed")
    expect(await core.save("s", claim.token, { result: await chunk(0) })).toMatchObject({
      state: "run",
    })
    expect(await core.save("s", claim.token, { result: await chunk(1) })).toMatchObject({
      state: "run",
    })
    await expect(chunk(2)).rejects.toThrow("process killed") // killed: nothing saved
    // The job's retry (same payload) finds the lease held: no chunk, one wake.
    expect((await ctxFor(host).steps.run("s", {}, chunk)).state).toBe("skipped")
    const wake = host.take()
    expect(wake.delayMs).toBe(60_000 + STEP_LEASE_GRACE_MS + 1_000)
    host.now += wake.delayMs
    const out = await ctxFor(host, wake.payload).steps.run("s", {}, chunk)
    expect(out).toEqual({ state: "done", cursor: 4, chunks: 2 })
    expect(seen).toEqual([0, 1, 2, 2, 3])
  })

  it("a lease wake after the holder finished normally is skipped", async () => {
    const host = new MemoryStepsHost()
    const core = host.core()
    const claim = await core.begin("s", {})
    if (claim.state !== "run") throw new Error("not claimed")
    expect((await ctxFor(host).steps.run("s", {}, async () => ({ done: true }))).state).toBe(
      "skipped",
    )
    const wake = host.take()
    await core.save("s", claim.token, { result: { done: false, cursor: 1, wakeIn: 0 } })
    const continuation = host.take()
    host.now += wake.delayMs
    let ran = 0
    const count = async () => {
      ran++
      return { done: true }
    }
    expect((await ctxFor(host, wake.payload).steps.run("s", {}, count)).state).toBe("skipped")
    expect(ran).toBe(0)
    expect((await ctxFor(host, continuation.payload).steps.run("s", {}, count)).state).toBe("done")
    expect(ran).toBe(1)
  })

  it("a thrown chunk releases the claim, keeps the cursor and rethrows", async () => {
    const host = new MemoryStepsHost()
    await ctxFor(host).steps.run("s", { budgetMs: 1 }, async () => {
      host.now += 5
      return { done: false, cursor: 5 }
    })
    host.take()
    await expect(
      ctxFor(host).steps.run("s", {}, async () => {
        throw new Error("upstream 500")
      }),
    ).rejects.toThrow("upstream 500")
    const doc = host.docs.get("s")!.state
    expect(doc.lease).toBeNull()
    expect(doc.cursor).toBe(5)
    // The job's retry continues from the cursor at once.
    const seen: unknown[] = []
    await ctxFor(host).steps.run("s", {}, async (c) => {
      seen.push(c)
      return { done: true }
    })
    expect(seen).toEqual([5])
  })

  it("a lease taken over while the chunk ran: the late save is dropped and the run stops", async () => {
    const host = new MemoryStepsHost()
    const core = host.core()
    const first = await core.begin("s", {})
    if (first.state !== "run") throw new Error("not claimed")
    host.now += 60_000 + STEP_LEASE_GRACE_MS + 1
    const second = await core.begin("s", {})
    expect(second.state).toBe("run")
    expect(await core.save("s", first.token, { result: { done: true, cursor: 9 } })).toEqual({
      state: "skipped",
    })
    expect(host.docs.get("s")!.state.done).toBe(false)
  })

  it("an enqueue that fails keeps the lease (the chunk is redone after it runs out)", async () => {
    const host = new MemoryStepsHost()
    const core = host.core()
    const claim = await core.begin("s", { budgetMs: 1 })
    if (claim.state !== "run") throw new Error("not claimed")
    host.now += 5
    host.enqueueFails = true
    await expect(
      core.save("s", claim.token, { result: { done: false, cursor: 1 } }),
    ).rejects.toThrow("queue refused")
    const doc = host.docs.get("s")!.state
    expect(doc.lease?.token).toBe(claim.token)
    expect(doc.cursor).toBeNull()
  })
})

describe("ctx.steps.run: one chain", () => {
  it("a stale continuation (another run went on) is skipped; one ahead of the commit is retried", async () => {
    const host = new MemoryStepsHost()
    await ctxFor(host).steps.run("s", { budgetMs: 1 }, async () => {
      host.now += 5
      return { done: false, cursor: 1 }
    })
    const continuation = host.take()
    // A fresh trigger takes the chain on before the continuation runs.
    await ctxFor(host).steps.run("s", { budgetMs: 1 }, async () => {
      host.now += 5
      return { done: false, cursor: 2 }
    })
    let ran = 0
    expect(
      (
        await ctxFor(host, continuation.payload).steps.run("s", {}, async () => {
          ran++
          return { done: true }
        })
      ).state,
    ).toBe("skipped")
    expect(ran).toBe(0)
    // A continuation whose generation is not committed yet: 409, retried.
    const epoch = host.docs.get("s")!.state.epoch
    const ahead = host.core({ _steps: { s: { epoch, gen: 99 } } })
    const err = await errorOf(ahead.begin("s", {}))
    expect(err.code).toBe("step_not_ready")
    expect(err.status).toBe(409)
  })

  it("after a reset (new epoch) the old chain's continuation is skipped and the step restarts", async () => {
    const host = new MemoryStepsHost()
    await ctxFor(host).steps.run("s", { budgetMs: 1 }, async () => {
      host.now += 5
      return { done: false, cursor: 1 }
    })
    const old = host.take()
    host.docs.delete("s") // steps_reset
    const seen: unknown[] = []
    const chunk = async (c: unknown) => {
      seen.push(c)
      return { done: true, cursor: "end" }
    }
    expect((await ctxFor(host, old.payload).steps.run("s", {}, chunk)).state).toBe("skipped")
    expect((await ctxFor(host).steps.run("s", {}, chunk)).state).toBe("done")
    expect(seen).toEqual([null])
  })
})
