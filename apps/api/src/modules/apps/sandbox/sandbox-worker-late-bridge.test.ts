// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bridge answer that lands after the run's deadline: resolving the guest's
// promise runs guest code under an interrupt handler that now says stop, and
// QuickJS throws "interrupted". That used to escape the IPC handler and kill
// the worker ("Sandbox worker crashed (exit 1)"); the run must end as a
// timeout, and the worker must stay usable.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { SandboxWorkerPool } from "~/modules/apps/sandbox/worker-pool"

let pool: SandboxWorkerPool

beforeAll(async () => {
  pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
  await pool.init()
})

afterAll(async () => {
  if (pool) await pool.shutdown()
})

describe("sandbox worker: a bridge answer after the deadline", () => {
  it("ends the run as a timeout, not a worker crash, and the worker runs the next call", async () => {
    // A tight loop of quick bridge calls past its deadline: some answer lands
    // while QuickJS's interrupt poll is due, and resolving it throws.
    const bundleSource = `async function spin(p, ctx) {
      var until = Date.now() + p.ms
      while (Date.now() < until) await __bridge_tick()
      return { done: true }
    }`
    const bridge = {
      tick: () => new Promise((r) => setTimeout(() => r(1), 1)),
    }
    const err = await pool
      .execute({ bundleSource, exportName: "spin", params: { ms: 3_000 }, bridge, timeoutMs: 300 })
      .then(
        () => null,
        (e: Error) => e,
      )
    expect(err?.message).toBe("App execution timed out")
    expect(err?.message).not.toContain("crashed")

    const ok = await pool.execute({
      bundleSource: `function hi() { return { ok: true } }`,
      exportName: "hi",
      params: {},
      bridge: {},
    })
    expect(ok).toEqual({ ok: true })
  }, 20_000)
})
