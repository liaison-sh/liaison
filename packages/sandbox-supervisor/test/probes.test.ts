// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sandbox service's probes, against real workerd processes: every limit
// holds by its own mechanism, a run reaches nothing but the bridge, a process
// is driven by the supervisor only, processes are bound to one key and
// recycled, and a nested chain never deadlocks the pool.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { signCellRequestV2 } from "@liaison/app-loader"
import { SANDBOX_CELL_ID } from "../src/cell"
import { PROBE_SHA, type Sandbox, startSandbox } from "./helpers"

describe("limits", () => {
  let sb: Sandbox
  beforeAll(async () => {
    sb = await startSandbox()
  })
  afterAll(async () => {
    await sb.stop()
  })

  test("a runaway loop is killed at its CPU limit; another org's runs keep answering", async () => {
    const t0 = Date.now()
    const spin = sb.run("spin", null, { orgId: "org-spin", cpuMs: 1_000, deadlineMs: 20_000 })
    const others: number[] = []
    let stop = false
    const other = (async () => {
      while (!stop) {
        const s = Date.now()
        const r = await sb.run("echo", { i: others.length }, { orgId: "org-other" })
        expect(r.body.ok).toBe(true)
        others.push(Date.now() - s)
      }
    })()
    const r = await spin
    const took = Date.now() - t0
    stop = true
    await other
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toMatchObject({ kind: "limit", code: "cpu_limit" })
    // Its limit plus the meter's reach, far before the 20 s deadline.
    expect(took).toBeLessThan(1_000 + 2_000)
    expect(others.length).toBeGreaterThan(3)
    expect(sb.sup.pool.counters.killed.cpu).toBe(1)
    // The process was replaced: the same app runs again.
    expect((await sb.run("echo", 1, { orgId: "org-spin" })).body.ok).toBe(true)
  }, 30_000)

  test("a spin past its deadline is killed by the wall timer (deadline + grace)", async () => {
    const t0 = Date.now()
    const r = await sb.run("spin", null, { orgId: "org-wall", deadlineMs: 1_500 })
    const took = Date.now() - t0
    expect(r.body.error).toMatchObject({ kind: "timeout", message: "App execution timed out" })
    expect(took).toBeGreaterThanOrEqual(1_500)
    expect(took).toBeLessThan(1_500 + 1_000 + 1_000)
    expect(sb.sup.pool.counters.killed.wall).toBe(1)
  }, 30_000)

  test("a run awaiting forever times out and its process is not reused", async () => {
    const before = sb.sup.pool.counters.killed.timeout ?? 0
    const r = await sb.run("hang", null, { orgId: "org-hang", deadlineMs: 800 })
    expect(r.body.error).toMatchObject({ kind: "timeout" })
    expect(sb.sup.pool.counters.killed.timeout).toBe(before + 1)
  }, 30_000)

  test("a memory bomb is killed alone; the next run of the app answers", async () => {
    const t0 = Date.now()
    const other = sb.run("echo", "still here", { orgId: "org-quiet" })
    const r = await sb.run("bomb", null, { orgId: "org-bomb", deadlineMs: 20_000 })
    expect(r.body.ok).toBe(false)
    expect(r.body.error).toMatchObject({ kind: "limit", code: "memory_limit" })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect((await other).body.result).toBe("still here")
    const k = sb.sup.pool.counters.killed
    expect((k.memory ?? 0) + (k.heap ?? 0)).toBe(1)
    expect((await sb.run("echo", 2, { orgId: "org-bomb" })).body.ok).toBe(true)
  }, 30_000)
})

describe("isolation", () => {
  let sb: Sandbox
  beforeAll(async () => {
    sb = await startSandbox()
  })
  afterAll(async () => {
    await sb.stop()
  })

  test("a run reaches the bridge and nothing else", async () => {
    const pong = await sb.run("bridge", { hi: 1 })
    expect(pong.body.result).toEqual({ data: { pong: { hi: 1 } } })
    for (const url of [
      `${sb.url}/stats`, // the supervisor itself
      `${sb.bridgeOrigin}/api/app-bridge/x`, // the bridge, without the bridge capability
      "http://169.254.169.254/latest/meta-data/",
      "https://example.com/",
    ]) {
      const r = await sb.run("net", { url })
      expect({ url, reached: r.body.result?.reached }).toEqual({ url, reached: false })
    }
  }, 30_000)

  test("a run sees no env and neither its token nor the bridge URL", async () => {
    const r = await sb.run("look")
    expect(r.body.result.env).toEqual([])
    expect(r.body.result.req).not.toContain("runToken")
    expect(r.body.result.req).not.toContain("bridgeUrl")
    // Accepted risk (documented): SharedArrayBuffer exists in workerd.
    expect(r.body.result.sharedArrayBuffer).toBe("function")
  }, 30_000)

  test("a wrong run token is refused by the bridge", async () => {
    const r = await sb.run("bridge", 1, { token: "x".repeat(43) })
    expect(r.body.result).toMatchObject({ errorStatus: 401, errorCode: "bad_token" })
    expect(sb.calls.at(-1)).toMatchObject({ method: "ping", status: 401 })
  }, 30_000)

  test("a workerd process refuses a /run the supervisor did not sign", async () => {
    await sb.run("echo", 0)
    const p = sb.sup.pool.procs[0]
    if (!p) throw new Error("no process")
    const body = JSON.stringify({ runId: "x:1" })
    const unsigned = await fetch("http://sandbox/run", { unix: p.socket, method: "POST", body })
    expect(unsigned.status).toBe(401)
    const wrongKey = await signCellRequestV2({
      cellId: SANDBOX_CELL_ID,
      cellKey: "not-the-process-key-0123456789",
      direction: "cell->loader",
      method: "POST",
      path: "/run",
      body,
      ts: Date.now(),
    })
    const forged = await fetch("http://sandbox/run", {
      unix: p.socket,
      method: "POST",
      headers: wrongKey,
      body,
    })
    expect(forged.status).toBe(401)
    expect(((await forged.json()) as { error: { kind: string } }).error.kind).toBe("auth")
  }, 30_000)

  test("a module the sandbox does not hold is bundle_missing; a wrong push is refused", async () => {
    const bad = await fetch(`${sb.url}/modules/${"0".repeat(64)}`, { method: "PUT", body: "x" })
    expect(bad.status).toBe(409)
    const res = await fetch(`${sb.url}/run`, {
      method: "POST",
      body: JSON.stringify({
        runId: "t:1",
        orgId: "o",
        app: "a",
        version: "1",
        sha256: "f".repeat(64),
        exportName: "echo",
        params: null,
        bridgeMethods: [],
        bridgeUrl: `${sb.bridgeOrigin}/api/app-bridge/t`,
        runToken: "t".repeat(32),
        deadlineMs: 1000,
      }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { kind: string } }).error.kind).toBe("bundle_missing")
  })

  test("two orgs never share a process, and module state stays in its process", async () => {
    const a1 = await sb.run("count", null, { orgId: "org-a" })
    const b1 = await sb.run("count", null, { orgId: "org-b" })
    const a2 = await sb.run("count", null, { orgId: "org-a" })
    expect([a1.body.result, b1.body.result, a2.body.result]).toEqual([1, 1, 2])
    const recs = sb.sup.recent.slice(-3)
    expect(recs[0]?.proc).toBe(recs[2]?.proc)
    expect(recs[1]?.proc).not.toBe(recs[0]?.proc)
    expect(PROBE_SHA).toMatch(/^[0-9a-f]{64}$/)
  }, 30_000)
})

describe("recycling", () => {
  test("a process is replaced after its run count and stopped when idle", async () => {
    const sb = await startSandbox({ recycleRuns: 3, idleMs: 300 })
    try {
      const procs: number[] = []
      for (let i = 0; i < 4; i++) {
        expect((await sb.run("count")).body.ok).toBe(true)
        procs.push(sb.sup.recent.at(-1)?.proc ?? -1)
      }
      expect(procs[0]).toBe(procs[2])
      expect(procs[3]).not.toBe(procs[0])
      expect(sb.sup.pool.counters.killed.recycle).toBe(1)
      await Bun.sleep(900)
      expect(sb.sup.pool.counters.killed.idle).toBe(1)
      expect(sb.sup.pool.procs.length).toBe(0)
    } finally {
      await sb.stop()
    }
  }, 30_000)
})

describe("nesting", () => {
  test("a depth-4 chain completes with the general share full; depth 5 is refused", async () => {
    const sb = await startSandbox() // 6 processes, 2 reserved, 2 overflow
    try {
      const hangs = [1, 2, 3].map((i) =>
        sb.run("hang", null, { orgId: `org-h${i}`, deadlineMs: 3_000 }),
      )
      await Bun.sleep(300)
      const chain = await sb.run("nest", { to: 4 }, { orgId: "org-chain", deadlineMs: 3_000 })
      // Each level answers the next level's run: depth 4 is the innermost.
      let level = chain.body
      let depth = 0
      while (level?.result?.data && "result" in (level.result.data as object)) {
        level = level.result.data as Record<string, any>
        depth++
      }
      expect(chain.body.ok).toBe(true)
      expect(level.result.data).toEqual({ depth: 4 })
      expect(depth).toBe(4)
      // With a fourth top-level run holding the general share, the next one
      // waits for a process, until its deadline.
      hangs.push(sb.run("hang", null, { orgId: "org-h4", deadlineMs: 3_000 }))
      await Bun.sleep(300)
      const queued = await sb.run("echo", 1, { orgId: "org-late", deadlineMs: 300 })
      expect(queued.body.error).toMatchObject({ kind: "timeout" })
      const deep = await sb.run("echo", 1, { orgId: "org-deep", depth: 5 })
      expect(deep.status).toBe(429)
      expect(deep.body.error).toMatchObject({ kind: "limit", code: "nesting_depth" })
      await Promise.all(hangs)
    } finally {
      await sb.stop()
    }
  }, 30_000)
})
