// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The boot's pool-budget checks (db/pool-boot.ts, index.ts): a topology whose
// one release overflows the budget refuses before Redis or HTTP, naming every
// pool; two releases side by side over it only warn; the server's own limit
// gets the same rule; the kernel keeps its slots on a worker's planned pool.

import { describe, expect, it } from "bun:test"
import path from "node:path"
import { sql } from "~/db"
import { checkServerLimit, readServerLimit, reportPoolPlan } from "~/db/pool-boot"
import { DEFAULT_KERNEL_NEED, planInputFromEnv, planPools } from "~/db/pool-plan"
import { planKernelSlots } from "~/infra/jobs/queue-classes"

const API_DIR = path.resolve(import.meta.dir, "../..")

function recorder() {
  const lines: { level: string; obj: Record<string, unknown>; msg: string }[] = []
  const at = (level: string) => (obj: object, msg: string) =>
    lines.push({ level, obj: obj as Record<string, unknown>, msg })
  return { lines, log: { info: at("info"), warn: at("warn"), fatal: at("fatal") } }
}

/** Starts the server entry with `env` on top of this run's, until it exits or `until` matches its output. */
async function boot(
  env: Record<string, string>,
  until: RegExp | null,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; ms: number }> {
  const started = performance.now()
  const child = Bun.spawn(["bun", "src/index.ts"], {
    cwd: API_DIR,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  let output = ""
  const decoder = new TextDecoder()
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      output += decoder.decode(chunk)
      if (until?.test(output)) child.kill("SIGKILL")
    }
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  try {
    await Promise.all([pump(child.stdout), pump(child.stderr), child.exited])
  } finally {
    clearTimeout(timer)
  }
  return { code: child.exitCode, output, ms: performance.now() - started }
}

const TOPOLOGY = {
  LIAISON_ROLE: "api",
  LIAISON_API_REPLICAS: "2",
  LIAISON_WORKER_REPLICAS: "1",
  // Split logins: all five pools. The process exits before it connects.
  DATABASE_REQUEST_PASSWORD: "pool-boot-test",
  DB_POOL_MAX: "",
  DB_PRIVILEGED_POOL_MAX: "",
  DB_JOBS_POOL_MAX: "",
  DB_PRIVILEGED_JOBS_POOL_MAX: "",
  DB_CELL_STRICT: "false",
}

describe("boot: the pool budget", () => {
  it("refuses a topology whose one release overflows the budget, naming every pool", async () => {
    const r = await boot({ ...TOPOLOGY, DB_CELL_MAX_CONNECTIONS: "40" }, null, 30_000)
    expect(r.code).toBe(1)
    expect(r.ms).toBeLessThan(10_000)
    expect(r.output).toContain("pool_budget_exceeded")
    for (const pool of ["main=5", "request=6", "privileged=10", "jobs=3", "privileged-jobs=2"]) {
      expect(r.output).toContain(pool)
    }
  }, 40_000)

  it("boots past an overlap-only overflow with the warning", async () => {
    // 150: available 122, one release 84, two releases 168.
    const r = await boot(
      { ...TOPOLOGY, DB_CELL_MAX_CONNECTIONS: "150" },
      /pool_budget_overlap_exceeded/,
      30_000,
    )
    expect(r.output).toContain("pool_budget_overlap_exceeded")
    expect(r.output).not.toContain("Refusing to boot")
  }, 40_000)

  it("logs the overlap warning, refuses steady overflow, and stays quiet within the budget", () => {
    const input = planInputFromEnv(
      { DB_CELL_MAX_CONNECTIONS: 150, LIAISON_API_REPLICAS: 2, LIAISON_WORKER_REPLICAS: 1 },
      "api",
      true,
      DEFAULT_KERNEL_NEED,
    )
    const warn = recorder()
    expect(reportPoolPlan(planPools(input), warn.log, { endpoint: "direct" })).toBe("warn")
    expect(warn.lines.map((l) => l.obj.alert)).toEqual([
      "pool_plan",
      "pool_budget_overlap_exceeded",
    ])
    const ok = recorder()
    expect(
      reportPoolPlan(planPools({ ...input, cellMax: 200 }), ok.log, { endpoint: "pooler" }),
    ).toBe("ok")
    expect(ok.lines).toHaveLength(1)
    expect(ok.lines[0]?.obj.perLogin).toEqual({ request: 9, privileged: 17 })
  })

  it("plans a worker's privileged pool so the kernel keeps 2/4/2/1/1 slots, unscaled", () => {
    const worker = planPools(
      planInputFromEnv({ DB_CELL_MAX_CONNECTIONS: 200 }, "worker", true, DEFAULT_KERNEL_NEED),
    )
    const k = planKernelSlots({}, worker.pools.privileged)
    expect(k.slots).toEqual({ cron: 2, agent: 4, media: 2, bulk: 1, webhook: 1 })
    expect(k.scaledDown).toBe(false)
  })

  it("warns when the server's limit is below the budget, and refuses when one release cannot fit it", async () => {
    const plan = planPools(
      planInputFromEnv(
        { DB_CELL_MAX_CONNECTIONS: 200, LIAISON_API_REPLICAS: 2, LIAISON_WORKER_REPLICAS: 1 },
        "api",
        true,
        DEFAULT_KERNEL_NEED,
      ),
    )
    // The real server answers the query.
    const live = await readServerLimit(sql)
    expect(live.maxConnections).toBeGreaterThan(0)

    const below = recorder()
    const v = checkServerLimit(
      plan,
      { maxConnections: 185, superuserReserved: 3, reserved: 0 },
      below.log,
      { cellMax: 200 },
    )
    expect(v).toBe("warn")
    expect(below.lines.map((l) => l.obj.alert)).toEqual([
      "pool_budget_above_server_limit",
      "pool_budget_overlap_exceeded",
    ])
    // An external database at 100: 97 usable - 13 = 84 < one release's 86.
    const external = recorder()
    expect(
      checkServerLimit(
        plan,
        { maxConnections: 100, superuserReserved: 3, reserved: 0 },
        external.log,
        {},
      ),
    ).toBe("refuse")
    expect(external.lines.at(-1)?.level).toBe("fatal")
  })

  it("keeps the legacy sizes without a budget", () => {
    const sizes = (e: Parameters<typeof planInputFromEnv>[0], split: boolean) => {
      const p = planPools(planInputFromEnv(e, "api", split, DEFAULT_KERNEL_NEED))
      return [
        p.pools.main,
        p.pools.request,
        p.pools.privileged,
        p.pools.jobs,
        p.pools.privilegedJobs,
      ]
    }
    expect(sizes({}, true)).toEqual([5, 20, 20, 20, 20])
    expect(
      sizes({ DB_POOL_MAX: 6, DB_PRIVILEGED_POOL_MAX: 10, DB_JOBS_POOL_MAX: 2 }, true),
    ).toEqual([5, 6, 10, 2, 2])
    expect(
      sizes({ DB_POOL_MAX: 25, DB_PRIVILEGED_POOL_MAX: 15, DB_JOBS_POOL_MAX: 30 }, false),
    ).toEqual([25, 25, 15, 30, 30])
  })
})
