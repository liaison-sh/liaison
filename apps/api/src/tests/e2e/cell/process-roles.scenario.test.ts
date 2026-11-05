// SPDX-License-Identifier: FSL-1.1-ALv2
// Process roles (S1) and the leader lease (S2), across real `src/index.ts`
// processes over one worker's schemas and Redis prefix (createRoleCell).
//
// S1: an `api` process opens no BullMQ Worker and starts no singleton; a
//     `worker` answers only /healthz and /readyz; an invalid role refuses boot.
// S2: of two workers exactly one leads and drains the outbox; SIGKILL the
//     leader and the survivor takes over within 20 s (the spawn env's lease TTL
//     is 3 s, packages/test-helpers/src/worker-env.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import {
  createRoleCell,
  deterministicPorts,
  jsonLogLines,
  type RoleCell,
  type RoleProcess,
} from "@liaison/test-helpers"

// The parallel runner gives this file a private worker id; a plain `bun test`
// run takes one clear of the lanes (0-3) and the helper tests (50-61, 99).
// The two cells below run one after the other on the same id.
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 70
const API_DIR = path.resolve(import.meta.dir, "../../../..")
const FAILOVER_BUDGET_MS = 20_000

interface ReadyzBody {
  status: string
  role: string
  instanceId: string
  leader: boolean
}

async function readyz(p: RoleProcess): Promise<ReadyzBody> {
  const res = await fetch(`${p.url}/readyz`)
  return (await res.json()) as ReadyzBody
}

function singletonStarted(p: RoleProcess, name?: string): boolean {
  return jsonLogLines(p).some(
    (l) => l.msg === "singleton started" && (name === undefined || l.singleton === name),
  )
}

/** The id the process's outbox claims rows with (`claimed_by`), from its start log. */
function outboxWorkerId(p: RoleProcess): string {
  const line = jsonLogLines(p).find((l) => l.msg === "Starting outbox worker")
  if (typeof line?.workerId !== "string") {
    throw new Error(`${p.role} on :${p.port} logged no outbox worker id`)
  }
  return line.workerId
}

/** BullMQ names each Worker's connection `…:w:<INSTANCE_ID>` (CLIENT LIST `name=`). */
async function bullWorkerConnections(cell: RoleCell, instanceId: string): Promise<number> {
  const list = String(await cell.redis.redis.call("CLIENT", "LIST"))
  return list.split("\n").filter((l) => l.includes(`:w:${instanceId}`)).length
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await probe().catch(() => undefined)
    if (v !== undefined) return v
    await Bun.sleep(everyMs)
  }
  return undefined
}

describe("S1: process roles", () => {
  let cell: RoleCell
  let api: RoleProcess
  let worker: RoleProcess

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "worker"])
    ;[api, worker] = cell.processes as [RoleProcess, RoleProcess]
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("an api process opens no BullMQ worker and starts no singleton", async () => {
    const a = await readyz(api)
    const w = await readyz(worker)
    expect(a).toMatchObject({ status: "ready", role: "api", leader: false })
    expect(w).toMatchObject({ status: "ready", role: "worker" })
    expect(a.instanceId).not.toBe(w.instanceId)

    // The worker hosts the job queues (positive control for the probe below).
    const workerConns = await until(async () => {
      const n = await bullWorkerConnections(cell, w.instanceId)
      return n > 0 ? n : undefined
    }, 15_000)
    expect(workerConns ?? 0).toBeGreaterThan(0)
    expect(await bullWorkerConnections(cell, a.instanceId)).toBe(0)

    // The worker leads and runs the outbox; the api runs no singleton at all.
    await worker.waitFor("singleton started", 15_000)
    expect(singletonStarted(worker, "outbox")).toBe(true)
    expect((await readyz(worker)).leader).toBe(true)
    expect(singletonStarted(api)).toBe(false)
    expect(jsonLogLines(api).some((l) => l.msg === "Starting outbox worker")).toBe(false)
  }, 60_000)

  it("a worker answers only /healthz and /readyz", async () => {
    const status = async (p: string) => {
      const res = await fetch(`${worker.url}${p}`)
      await res.body?.cancel()
      return res.status
    }
    expect(await status("/healthz")).toBe(200)
    expect(await status("/readyz")).toBe(200)
    expect(await status("/api/users/me")).toBe(404)
    expect(await status("/ws")).toBe(404)
    expect(await status("/")).toBe(404)
    // The api serves the API (its auth answers, not a 404).
    const res = await fetch(`${api.url}/api/users/me`)
    await res.body?.cancel()
    expect(res.status).not.toBe(404)
  }, 30_000)

  it("an invalid role refuses boot", async () => {
    // The api's own (valid) env, with only the role changed and a spare port.
    const port = deterministicPorts(CELL_WORKER, 10).at(-1)
    const proc = Bun.spawn({
      cmd: ["bun", "src/index.ts"],
      cwd: API_DIR,
      env: { ...api.env, LIAISON_ROLE: "bogus", PORT: String(port) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => proc.kill("SIGKILL"), 10_000)
    const code = await proc.exited
    clearTimeout(timer)
    const stderr = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(stderr).toContain("LIAISON_ROLE")
  }, 20_000)
})

describe("S2: leader lease across two workers", () => {
  let cell: RoleCell
  let leader: RoleProcess
  let follower: RoleProcess

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["worker", "worker"])
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("exactly one of two workers leads", async () => {
    const [a, b] = cell.processes as [RoleProcess, RoleProcess]
    const settled = await until(async () => {
      const [ra, rb] = await Promise.all([readyz(a), readyz(b)])
      return ra.leader !== rb.leader ? { ra, rb } : undefined
    }, 15_000)
    expect(settled).toBeDefined()
    leader = settled?.ra.leader ? a : b
    follower = leader === a ? b : a
    await leader.waitFor("singleton started", 15_000)
    // Give a would-be second leader time to show itself (several lease polls).
    await Bun.sleep(1_500)
    expect((await readyz(leader)).leader).toBe(true)
    expect((await readyz(follower)).leader).toBe(false)
    expect(singletonStarted(leader, "outbox")).toBe(true)
    expect(singletonStarted(follower, "outbox")).toBe(false)
  }, 60_000)

  it("only the leader's outbox claims events", async () => {
    const leaderOutbox = outboxWorkerId(leader)
    const followerOutbox = outboxWorkerId(follower)
    expect(leaderOutbox).not.toBe(followerOutbox)

    const table = `${cell.schemaPrefix}kernel.pending_events`
    const org = crypto.randomUUID()
    // pending_events.org_id references organizations: the events need a real org.
    await cell.db.sql.unsafe(
      `INSERT INTO ${cell.schemaPrefix}kernel.organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [org, "Process roles outbox org", `process-roles-${org.slice(0, 8)}`],
    )
    const ids: string[] = []
    // 24 events over ~3.6 s: many outbox ticks of both processes.
    for (let i = 0; i < 24; i++) {
      const [row] = await cell.db.sql.unsafe(
        `INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`,
        [
          org,
          JSON.stringify({
            app: "kernel",
            entity: "saved_view",
            action: "created",
            entityId: crypto.randomUUID(),
            orgId: org,
          }),
        ],
      )
      ids.push(String(row?.id))
      await Bun.sleep(150)
    }

    const rows = await until(async () => {
      const rs = await cell.db.sql.unsafe(
        `SELECT claimed_by, processed_at FROM ${table} WHERE id = ANY($1::uuid[])`,
        [ids],
      )
      return rs.every((r) => r.processed_at !== null) ? rs : undefined
    }, 30_000)
    expect(rows).toBeDefined()
    expect(rows?.length).toBe(ids.length)
    const claimers = new Set((rows ?? []).map((r) => String(r.claimed_by)))
    expect([...claimers]).toEqual([leaderOutbox])
  }, 60_000)

  it("failover after SIGKILL of the leader is under 20 s", async () => {
    const t0 = Date.now()
    await leader.kill(9)
    const tookOver = await until(
      async () => ((await readyz(follower)).leader ? Date.now() - t0 : undefined),
      FAILOVER_BUDGET_MS + 5_000,
    )
    console.log(
      `[S2] failover after SIGKILL: ${tookOver === undefined ? "none" : `${(tookOver / 1000).toFixed(2)} s`}`,
    )
    expect(tookOver).toBeDefined()
    expect(tookOver ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(FAILOVER_BUDGET_MS)
    await follower.waitFor("singleton started", 10_000)
    expect(singletonStarted(follower, "outbox")).toBe(true)
  }, 60_000)
})
