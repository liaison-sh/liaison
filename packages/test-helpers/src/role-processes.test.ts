// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { deterministicPorts } from "./port-allocator"
import { createRoleCell, type RoleCell } from "./role-processes"
import { WORKER_PORT_STRIDE } from "./test-namespace"

// High worker ids, clear of the e2e runs (0-3) and worker-env.test.ts (50, 51, 99).
const CELL_WORKER = 60
const TEARDOWN_WORKER = 61

async function listeners(port: number): Promise<string> {
  const proc = Bun.spawn({ cmd: ["lsof", "-ti", `:${port}`], stdout: "pipe", stderr: "pipe" })
  return (await new Response(proc.stdout).text()).trim()
}

describe("role-process cell", () => {
  let cell: RoleCell | undefined

  afterAll(async () => {
    if (cell) await cell.teardown()
  }, 30_000)

  it("boots two processes against one schema and Redis prefix", async () => {
    cell = await createRoleCell(CELL_WORKER, ["all", "all"])
    expect(cell.processes).toHaveLength(2)
    const [a, b] = cell.processes
    expect(a.port).not.toBe(b.port)
    for (const p of cell.processes) {
      expect(p.role).toBe("all")
      const res = await fetch(`${p.url}/healthz`)
      expect(res.status).toBe(200)
      expect(p.env.LIAISON_ROLE).toBe("all")
      expect(p.env.PORT).toBe(String(p.port))
    }
    expect(a.env.SCHEMA_PREFIX).toBe(cell.schemaPrefix)
    expect(b.env.SCHEMA_PREFIX).toBe(cell.schemaPrefix)
    expect(a.env.REDIS_PREFIX).toBe(cell.redisPrefix)
    expect(b.env.REDIS_PREFIX).toBe(cell.redisPrefix)
    // Ports come from the worker's own 10-port block (the ownServer convention).
    const block = deterministicPorts(CELL_WORKER, WORKER_PORT_STRIDE)
    for (const p of cell.processes) expect(block).toContain(p.port)
  }, 120_000)

  it("refuses more processes than the worker's port stride holds", async () => {
    const roles = Array.from({ length: WORKER_PORT_STRIDE + 1 }, () => "all" as const)
    await expect(createRoleCell(CELL_WORKER + 10, roles)).rejects.toThrow(/port stride/)
  })

  it("teardown leaves no listener", async () => {
    const tmp = await createRoleCell(TEARDOWN_WORKER, ["all"])
    const extra = await tmp.spawn("all")
    const ports = tmp.processes.map((p) => p.port)
    expect(ports).toContain(extra.port)
    expect(ports).toHaveLength(2)
    await tmp.teardown()
    for (const port of ports) expect(await listeners(port)).toBe("")
  }, 120_000)
})
