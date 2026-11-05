// SPDX-License-Identifier: FSL-1.1-ALv2
// On-demand org setup (S3) and the setup stamp (S4), across real
// `src/index.ts` processes over one worker's schemas and Redis prefix
// (createRoleCell): two `api` processes and one `worker`, booted on an EMPTY
// database, so no process has any org at boot.
//
// S3: an org created through api A is served by api B (a manifest-derived
//     route answers with the org's apps), and its app job runs in the worker,
//     whose Worker on the app queue exists from boot, before any org (A3).
// S4: B's first touch of the org, set up by A and the worker with the same
//     build, writes nothing to the org's app and role rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  api,
  bootstrap,
  createRoleCell,
  jsonLogLines,
  type RoleCell,
  type RoleProcess,
} from "@liaison/test-helpers"
import { Queue } from "bullmq"
import IORedis from "ioredis"

// The parallel runner gives this file a private worker id; a plain `bun test`
// run takes one clear of the lanes (0-3), the helper tests (50-61, 99) and the
// process-roles scenario (70).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 71
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379"

// An in-tree app whose manifest declares jobs (so A3 binds `app-tickets` at
// boot) and ships skills (so the manifest route below lists them). Its
// `followupCheck` job has nothing to do in a fresh org.
const APP = "tickets"
const APP_QUEUE = `app-${APP}`
const APP_JOB = "followupCheck"

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

/**
 * How many apps this process registered (`registerInOrder` logs each one).
 * The cell boots with zero orgs and creates exactly one, so this counts the
 * apps registered for that org: the process-reported registration state.
 */
function appsRegistered(p: RoleProcess): number {
  return jsonLogLines(p).filter((l) => l.msg === "App registered").length
}

function registeredAppNames(p: RoleProcess): string[] {
  return jsonLogLines(p)
    .filter((l) => l.msg === "App registered")
    .map((l) => `${String(l.app)}@${String(l.version)}`)
    .sort()
}

/** Apps one process registered and the other did not (`-a` only in a, `+b` only in b). */
function registeredAppNamesDiff(a: RoleProcess, b: RoleProcess): string[] {
  const left = registeredAppNames(a)
  const right = registeredAppNames(b)
  return [
    ...left.filter((x) => !right.includes(x)).map((x) => `-${x}`),
    ...right.filter((x) => !left.includes(x)).map((x) => `+${x}`),
  ]
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

/** The app-shipped skills `GET /api/agent/app-skills` lists for the caller's org (manifest-derived). */
async function appSkills(p: RoleProcess, token: string): Promise<Array<{ appName: string }>> {
  const res = await api(p.url, "/api/agent/app-skills", { token })
  if (res.status !== 200) {
    throw new Error(`app-skills on :${p.port} answered ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.data as Array<{ appName: string }>
}

describe("S3 + S4: org setup across processes", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let apiB: RoleProcess
  let worker: RoleProcess
  let workerId: string
  let connection: IORedis
  let queue: Queue
  let token: string
  let orgId: string

  beforeAll(async () => {
    // A pinned build id: every process computes the same setup stamp.
    cell = await createRoleCell(CELL_WORKER, ["api", "api", "worker"], {
      serverEnv: { LIAISON_VERSION: "org-setup-scenario" },
    })
    ;[apiA, apiB, worker] = cell.processes as [RoleProcess, RoleProcess, RoleProcess]
    workerId = (await readyz(worker)).instanceId
    connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null })
    queue = new Queue(APP_QUEUE, { connection, prefix: `${cell.redisPrefix}bull` })
  }, 240_000)

  afterAll(async () => {
    await queue?.close()
    connection?.disconnect()
    await cell?.teardown()
  }, 60_000)

  it("A3: before any org exists, the worker holds a Worker on the app queue", async () => {
    const orgs = await cell.db.sql.unsafe(
      `SELECT count(*)::int AS n FROM ${cell.schemaPrefix}kernel.organizations`,
    )
    expect(orgs[0]?.n).toBe(0)
    expect(appsRegistered(worker)).toBe(0)

    // BullMQ names a Worker's connection `…:w:<name>`; the Worker's name is the
    // process INSTANCE_ID.
    const workers = await until(async () => {
      const ws = await queue.getWorkers()
      return ws.some((w) => String(w.rawname ?? "").endsWith(`:w:${workerId}`)) ? ws : undefined
    }, 15_000)
    expect(workers).toBeDefined()
    const apiIds = [(await readyz(apiA)).instanceId, (await readyz(apiB)).instanceId]
    for (const w of workers ?? []) {
      for (const id of apiIds) expect(String(w.rawname ?? "")).not.toEndWith(`:w:${id}`)
    }
  }, 30_000)

  it("S3: the org's app job, created through api A, runs in the worker", async () => {
    const boot = await bootstrap(apiA.url)
    token = boot.accessToken
    orgId = boot.orgId
    // A registered the org at creation: the route answers there first.
    expect((await appSkills(apiA, token)).some((s) => s.appName === APP)).toBe(true)

    const job = await queue.add(APP_JOB, { orgId }, { attempts: 1 })
    const done = await until(async () => {
      const state = await job.getState()
      if (state === "failed") {
        const failed = await queue.getJob(String(job.id))
        throw new Error(`job failed: ${failed?.failedReason}`)
      }
      return state === "completed" ? state : undefined
    }, 60_000)
    expect(done).toBe("completed")
    const finished = await queue.getJob(String(job.id))
    expect(finished?.processedBy).toBe(workerId)
  }, 90_000)

  it("S3 + S4: api B serves the org, and its setup of it writes nothing", async () => {
    expect(orgId).toBeDefined()
    // Every process that may set the org up before B has finished: A at
    // creation, the worker for its job (and its outbox). B has not touched it.
    const expected = appsRegistered(apiA)
    expect(expected).toBeGreaterThan(0)
    const settled = await until(
      async () => (appsRegistered(worker) === expected ? true : undefined),
      30_000,
    )
    // On a mismatch, name the apps each side registered: the difference is the diagnosis.
    expect(settled ? [] : registeredAppNamesDiff(apiA, worker)).toEqual([])
    expect(settled).toBe(true)
    expect(appsRegistered(apiB)).toBe(0)

    const snapshot = async () => {
      const rows = await cell.db.sql.unsafe(
        `SELECT 'apps:' || name AS k, xmin::text AS x FROM ${cell.schemaPrefix}kernel.apps WHERE org_id = $1
         UNION ALL
         SELECT 'roles:' || id::text AS k, xmin::text AS x FROM ${cell.schemaPrefix}kernel.roles WHERE org_id = $1
         ORDER BY k`,
        [orgId],
      )
      return rows.map((r) => `${r.k}=${r.x}`)
    }
    const before = await snapshot()
    expect(before.some((k) => k.startsWith(`apps:${APP}=`))).toBe(true)

    // B's first touch: the manifest route answers with the org's apps (S3).
    const skills = await appSkills(apiB, token)
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.some((s) => s.appName === APP)).toBe(true)
    // B registered the org's apps in memory, as A did ...
    expect(appsRegistered(apiB)).toBe(expected)
    // ... and wrote none of its app or role rows (S4).
    expect(await snapshot()).toEqual(before)
  }, 60_000)
})
