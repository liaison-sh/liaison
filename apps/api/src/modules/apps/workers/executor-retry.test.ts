// SPDX-License-Identifier: FSL-1.1-ALv2
//
// executeOnWorkers' reliability rules against a scripted loader: which faults
// are retried (loader-level, zero bridge calls, enough budget left), what the
// breaker and the app fallback hear, and that a retry stays inside the run's
// deadline (a webhook's delivery budget).

import { describe, expect, it } from "bun:test"
import { deliveryBudget } from "~/modules/webhooks/manifest-execution"
import { WorkersAdmission } from "./admission"
import type { WorkersConfig } from "./config"
import { executeOnWorkers, type WorkersRunInfo, type WorkersRunOptions } from "./executor"
import { AppFallbacks, LoaderBreaker } from "./fallback"
import { RunRegistry } from "./run-registry"

const ORG = "00000000-0000-4000-8000-0000000000a1"

const config: WorkersConfig = {
  loaderUrl: "http://loader.invalid",
  cellId: "cell-rt",
  loaderKey: "rt-cell-key-0123456789abcdef",
  bridgeBaseUrl: "http://cell.invalid/api/app-bridge",
}

type Step =
  | { status: number; body: unknown; delayMs?: number; bridgeCalls?: number }
  | { throw: string; delayMs?: number }

interface Harness {
  opts: WorkersRunOptions
  calls: () => number
  breaker: LoaderBreaker
  fallbacks: AppFallbacks
}

function harness(steps: Step[], over: Partial<WorkersRunOptions> = {}): Harness {
  const registry = new RunRegistry()
  let n = 0
  const breaker = over.breaker ?? new LoaderBreaker()
  const fallbacks = over.appFallbacks ?? new AppFallbacks()
  const opts: WorkersRunOptions = {
    config,
    appName: "rt",
    orgId: ORG,
    version: "1.0.0",
    bundleSha256: "a".repeat(64),
    exportName: "go",
    params: {},
    bridge: { emit: async () => 1 },
    holdsTx: false,
    timeoutMs: 2_000,
    admission: new WorkersAdmission(),
    registry,
    breaker,
    appFallbacks: fallbacks,
    retryJitterMs: () => 10,
    fetchImpl: async (_url, init) => {
      const step = steps[Math.min(n, steps.length - 1)] as Step
      n++
      const req = JSON.parse(String(init.body)) as { runId: string; runToken: string }
      // A bridge call the isolate made before the failure, counted on the owner.
      const made = "bridgeCalls" in step ? (step.bridgeCalls ?? 0) : 0
      for (let i = 0; i < made; i++) {
        const auth = registry.authenticate(req.runId, req.runToken, "nonce-1")
        if (auth.kind === "ok") auth.entry.stats.bridgeCalls++
      }
      if (step.delayMs) await Bun.sleep(step.delayMs)
      if ("throw" in step) throw new Error(step.throw)
      return new Response(typeof step.body === "string" ? step.body : JSON.stringify(step.body), {
        status: step.status,
      })
    },
    ...over,
  }
  return { opts, calls: () => n, breaker, fallbacks }
}

const ok = { status: 200, body: { ok: true, result: { done: 1 } } }
const kind = (status: number, k: string) => ({
  status,
  body: { ok: false, error: { message: `failed: ${k}`, kind: k } },
})

async function run(h: Harness): Promise<{ result?: unknown; error?: Error; info: WorkersRunInfo }> {
  let info: WorkersRunInfo = {}
  try {
    const result = await executeOnWorkers(h.opts, (i) => {
      info = i
    })
    return { result, info }
  } catch (e) {
    return { error: e as Error, info }
  }
}

describe("Workers retry: loader-level faults before any bridge call", () => {
  for (const [name, step] of [
    ["a network error", { throw: "connect ECONNREFUSED" }],
    ["a kindless 503 (Cloudflare's page)", { status: 503, body: "<html>503</html>" }],
    ["auth", kind(401, "auth")],
    ["loader_internal", kind(400, "loader_internal")],
  ] as const) {
    it(`${name} is retried once and the retry's answer is the run's`, async () => {
      const h = harness([step as Step, ok])
      const r = await run(h)
      expect(r.result).toEqual({ done: 1 })
      expect(h.calls()).toBe(2)
      expect(r.info.attempts).toBe(2)
      expect(r.info.fault).toBeUndefined()
    })
  }

  it("never retried once the run made a bridge call", async () => {
    const h = harness([{ throw: "socket hang up", bridgeCalls: 1 }, ok])
    const r = await run(h)
    expect(r.error?.message).toContain("App loader unreachable")
    expect(h.calls()).toBe(1)
    expect(r.info).toMatchObject({ attempts: 1, bridgeCalls: 1 })
    expect(r.info.fault).toEqual({ class: "loader", kind: "network" })
  })

  it("never retried when what is left of the budget is under twice the attempt", async () => {
    const h = harness([{ status: 503, body: "", delayMs: 400 }, ok], { timeoutMs: 1_000 })
    const r = await run(h)
    expect(h.calls()).toBe(1)
    expect(r.error?.name).toBe("WorkersRunError")
    expect(r.info.fault?.kind).toBe("http_503")
  })

  it("a second loader fault is the run's error (one retry only)", async () => {
    const h = harness([{ throw: "reset" }, { throw: "reset again" }, ok])
    const r = await run(h)
    expect(h.calls()).toBe(2)
    expect(r.error?.message).toContain("reset again")
  })
})

describe("Workers retry: app-level and final outcomes are not retried", () => {
  for (const k of ["load", "bundle_missing", "bundle_fetch_failed"]) {
    it(`${k}: no retry, this org's app@version falls back, the breaker does not count it`, async () => {
      const h = harness([kind(502, k), ok])
      const r = await run(h)
      expect(h.calls()).toBe(1)
      expect(r.info.fault).toEqual({ class: "app", kind: k })
      expect(h.fallbacks.active(AppFallbacks.key(ORG, "rt", "1.0.0"))).toBe(true)
      expect(h.fallbacks.active(AppFallbacks.key("another-org", "rt", "1.0.0"))).toBe(false)
      expect(h.fallbacks.active(AppFallbacks.key(ORG, "rt", "1.0.1"))).toBe(false)
      expect(h.breaker.state()).toBe("closed")
    })
  }

  it("a module without the export it was asked for (worker-core's code): app-level load", async () => {
    const h = harness([
      {
        status: 200,
        body: {
          ok: false,
          error: {
            message: 'Export "go" not found (got undefined)',
            code: "export_missing",
            kind: "handler",
          },
        },
      },
      ok,
    ])
    const r = await run(h)
    expect(h.calls()).toBe(1)
    expect(r.error?.message).toBe('Export "go" not found (got undefined)')
    expect(r.info.fault).toEqual({ class: "app", kind: "load" })
    expect(h.fallbacks.active(AppFallbacks.key(ORG, "rt", "1.0.0"))).toBe(true)
    expect(h.breaker.state()).toBe("closed")
  })

  for (const k of ["limit", "handler", "timeout"]) {
    it(`${k}: the run's own outcome, nothing else changes`, async () => {
      const h = harness([kind(200, k), ok])
      const r = await run(h)
      expect(h.calls()).toBe(1)
      expect(r.error).toBeDefined()
      expect(r.info.fault).toEqual({ class: "final", kind: k })
      expect(h.fallbacks.active(AppFallbacks.key(ORG, "rt", "1.0.0"))).toBe(false)
    })
  }
})

describe("Workers retry inside a webhook's delivery budget", () => {
  it("the retry ends inside deliveryBudget, and none starts when it could not fit", async () => {
    const budget = deliveryBudget(1_500, 3_000)
    expect(budget).not.toBeNull()
    const timeoutMs = budget?.timeoutMs as number
    // Fits: a fast fault, then a slow but successful attempt.
    const fits = harness(
      [
        { throw: "reset", delayMs: 100 },
        { ...ok, delayMs: 300 },
      ],
      { timeoutMs },
    )
    const t0 = Date.now()
    const a = await run(fits)
    expect(a.result).toEqual({ done: 1 })
    expect(Date.now() - t0).toBeLessThan(timeoutMs)
    // Does not fit: the first attempt used more than half of the budget.
    const late = harness([{ throw: "reset", delayMs: Math.ceil(timeoutMs * 0.6) }, ok], {
      timeoutMs,
    })
    const t1 = Date.now()
    const b = await run(late)
    expect(late.calls()).toBe(1)
    expect(b.error).toBeDefined()
    expect(Date.now() - t1).toBeLessThan(timeoutMs)
  })

  it("the retry's deadline is what is left of the run's, never a fresh one", async () => {
    const deadlines: number[] = []
    const h = harness([{ throw: "reset", delayMs: 200 }, ok], { timeoutMs: 2_000 })
    const inner = h.opts.fetchImpl as NonNullable<WorkersRunOptions["fetchImpl"]>
    h.opts.fetchImpl = (url, init) => {
      deadlines.push((JSON.parse(String(init.body)) as { deadlineMs: number }).deadlineMs)
      return inner(url, init)
    }
    await run(h)
    expect(deadlines).toHaveLength(2)
    expect(deadlines[1] as number).toBeLessThanOrEqual(2_000 - 200)
  })
})

describe("the breaker hears every attempt", () => {
  it("five loader faults open it; no retry runs while it is open", async () => {
    const breaker = new LoaderBreaker()
    for (let i = 0; i < 2; i++) {
      // Each run: a fault and its retry's fault (2 per run).
      await run(harness([{ throw: "reset" }, { throw: "reset" }], { breaker }))
    }
    expect(breaker.state()).toBe("closed")
    const h = harness([{ throw: "reset" }, ok], { breaker })
    const r = await run(h)
    // The fifth fault opened it: the retry is skipped.
    expect(breaker.state()).toBe("open")
    expect(h.calls()).toBe(1)
    expect(r.error).toBeDefined()
  })

  it("a probe the loader answers (even with a handler error) closes it", async () => {
    let now = 0
    const breaker = new LoaderBreaker(() => now)
    for (let i = 0; i < 5; i++) breaker.record("loader_fault")
    now = 61_000
    const admission = breaker.admit()
    expect(admission).toEqual({ allow: true, probe: true })
    await run(harness([kind(200, "handler")], { breaker, probe: true }))
    expect(breaker.state()).toBe("closed")
  })
})
