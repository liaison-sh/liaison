// SPDX-License-Identifier: FSL-1.1-ALv2
// The shutdown sequence (S9) across real `src/index.ts` processes: two `api`
// processes over one worker's schemas and Redis prefix; A gets a real SIGTERM
// while a request is in flight and a WebSocket is open on it.
//
// - /readyz on A goes 503 at once; the in-flight request finishes 200;
// - the socket on A is closed with 1012 and a new socket opens on B;
// - after the edge grace (2 s) a new connection to A is refused;
// - A exits 0, and its `shutdown_phase` lines come in stage order.
// - an idle `all` process with the production budgets exits within seconds;
// - a main thread wedged after the SIGTERM (a synchronous loop: no timer runs,
//   so the hard deadline cannot fire) is killed by the shutdown watchdog
//   shortly past the hard deadline, instead of living on until an outside kill.
//
// The job drain (A16) is proven on real Redis with two BullMQ hosts in
// infra/jobs/jobs.drain.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  api,
  bootstrap,
  createRoleCell,
  jsonLogLines,
  type RoleCell,
  type RoleProcess,
} from "@liaison/test-helpers"
import { SHUTDOWN_WATCHDOG_GRACE_MS } from "~/lib/shutdown"
import { SHUTDOWN_BUDGET_DEFAULTS } from "~/lib/shutdown-budget"

// The parallel runner gives this file a private worker id; a plain `bun test`
// run takes one clear of the lanes (0-3), the helper tests (50-61, 99) and the
// other cell scenarios (70-74).
const CELL_WORKER = process.env.WORKER_ID != null ? Number(process.env.WORKER_ID) : 75
const SLOW_MS = 4_000

/** A raw socket whose close code the test reads. */
async function openRawSocket(
  proc: RoleProcess,
  token: string,
): Promise<{ closed: Promise<number>; close(): void }> {
  const t = await api(proc.url, "/api/auth/ws-ticket", { method: "POST", token })
  if (t.status !== 200) throw new Error(`ws-ticket on :${proc.port} answered ${t.status}`)
  const ws = new WebSocket(
    `${proc.url.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(String(t.body.data.ticket))}`,
  )
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (e) => resolve(e.code))
  })
  const synced = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no presence_sync from :${proc.port}`)), 10_000)
    ws.addEventListener("message", (e) => {
      if (String(e.data).includes('"presence_sync"')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve())
    ws.addEventListener("error", () => reject(new Error(`socket to :${proc.port} failed`)))
  })
  ws.send(JSON.stringify({ type: "hello", lastEventId: 0 }))
  await synced
  return { closed, close: () => ws.close() }
}

describe("S9: a SIGTERM drains instead of dropping", () => {
  let cell: RoleCell
  let apiA: RoleProcess
  let apiB: RoleProcess
  let token: string

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api", "api"], {
      serverEnv: {
        LIAISON_VERSION: "p3-cell",
        // Spawned test servers get no edge grace and a 1 s HTTP drain
        // (worker-env.ts) so restarts are quick; this scenario proves the
        // production edge grace and drain, so it takes their defaults back.
        SHUTDOWN_EDGE_GRACE_MS: String(SHUTDOWN_BUDGET_DEFAULTS.edgeGraceMs),
        SHUTDOWN_HTTP_DRAIN_MS: String(SHUTDOWN_BUDGET_DEFAULTS.httpDrainMs),
      },
    })
    ;[apiA, apiB] = cell.processes as [RoleProcess, RoleProcess]
    token = (await bootstrap(apiA.url)).accessToken
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("readyz 503 at once, the in-flight request finishes, sockets close 1012, then A refuses and exits 0", async () => {
    const socket = await openRawSocket(apiA, token)
    const slow = fetch(`${apiA.url}/api/_test/shutdown/slow?ms=${SLOW_MS}`).then(async (res) => ({
      status: res.status,
      body: (await res.json()) as { data: { endedAt: number } },
    }))
    // Let the request reach its handler before the signal.
    await Bun.sleep(300)

    const t0 = Date.now()
    apiA.proc.kill("SIGTERM")
    let readyzAt: number | undefined
    while (Date.now() - t0 < 2_000) {
      const res = await fetch(`${apiA.url}/readyz`).catch(() => undefined)
      await res?.body?.cancel()
      if (res?.status === 503) {
        readyzAt = Date.now() - t0
        break
      }
      await Bun.sleep(10)
    }
    expect(readyzAt).toBeDefined()
    expect(readyzAt ?? Number.POSITIVE_INFINITY).toBeLessThan(500)

    // The socket on A closes with 1012 at the edge; the client finds B.
    expect(await socket.closed).toBe(1012)
    const onB = await openRawSocket(apiB, token)
    onB.close()

    const done = await slow
    expect(done.status).toBe(200)
    expect(done.body.data.endedAt).toBeGreaterThan(t0)

    // Past the edge grace a new connection to A is refused.
    const lateAt = Math.max(0, t0 + 3_000 - Date.now())
    await Bun.sleep(lateAt)
    if (apiA.proc.exitCode === null) {
      const late = await fetch(`${apiA.url}/healthz`).then(
        () => "answered",
        (err: unknown) => String((err as { code?: string }).code ?? err),
      )
      expect(late).not.toBe("answered")
    }

    expect(await apiA.proc.exited).toBe(0)
    const phases = jsonLogLines(apiA)
      .filter((l) => l.msg === "shutdown_phase")
      .map((l) => String(l.phase))
    const at = (p: string) => phases.findIndex((n) => n === p || n.startsWith(`${p}:`))
    for (const p of ["readiness", "listener", "http-drain", "listener-close", "pools"]) {
      expect({ phase: p, logged: at(p) >= 0 }).toEqual({ phase: p, logged: true })
    }
    expect(at("readiness")).toBeLessThan(at("listener"))
    expect(at("listener")).toBeLessThan(at("http-drain"))
    expect(at("http-drain")).toBeLessThan(at("listener-close"))
    expect(at("listener-close")).toBeLessThan(at("pools"))
    expect(
      jsonLogLines(apiA).some((l) => l.msg === "shutdown_phase" && l.outcome === "timeout"),
    ).toBe(false)
  }, 90_000)
})

// The single container (`all`: HTTP, jobs, singletons, schedulers) with the
// production budgets: an idle process exits 0 well before the hard deadline,
// and no phase is cut at its deadline (a phase that waits on something that
// never ends would hold the process until the hard deadline, or forever).
describe("S9: an idle `all` process exits promptly on SIGTERM", () => {
  let cell: RoleCell
  let proc: RoleProcess

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["all"], {
      serverEnv: {
        LIAISON_VERSION: "p3-cell",
        SHUTDOWN_EDGE_GRACE_MS: String(SHUTDOWN_BUDGET_DEFAULTS.edgeGraceMs),
        SHUTDOWN_HTTP_DRAIN_MS: String(SHUTDOWN_BUDGET_DEFAULTS.httpDrainMs),
        SHUTDOWN_TURN_DRAIN_MS: String(SHUTDOWN_BUDGET_DEFAULTS.turnDrainMs),
        SHUTDOWN_JOB_DRAIN_MS: String(SHUTDOWN_BUDGET_DEFAULTS.jobDrainMs),
      },
    })
    ;[proc] = cell.processes as [RoleProcess]
    await bootstrap(proc.url)
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("exits 0 within the edge grace plus a few seconds, no phase timing out", async () => {
    const t0 = Date.now()
    proc.proc.kill("SIGTERM")
    const code = await Promise.race([proc.proc.exited, Bun.sleep(30_000).then(() => "hung")])
    const ms = Date.now() - t0
    const timedOut = jsonLogLines(proc)
      .filter((l) => l.msg === "shutdown_phase" && l.outcome === "timeout")
      .map((l) => String(l.phase))
    expect({ code, timedOut }).toEqual({ code: 0, timedOut: [] })
    expect(ms).toBeLessThan(SHUTDOWN_BUDGET_DEFAULTS.edgeGraceMs + 8_000)
  }, 90_000)
})

describe("S9: a main thread wedged during shutdown is killed past the hard deadline", () => {
  const HARD_DEADLINE_MS = 4_000
  let cell: RoleCell
  let proc: RoleProcess

  beforeAll(async () => {
    cell = await createRoleCell(CELL_WORKER, ["api"], {
      serverEnv: {
        LIAISON_VERSION: "p3-cell",
        SHUTDOWN_EDGE_GRACE_MS: "2000",
        SHUTDOWN_HARD_DEADLINE_MS: String(HARD_DEADLINE_MS),
      },
    })
    ;[proc] = cell.processes as [RoleProcess]
  }, 240_000)

  afterAll(async () => {
    await cell?.teardown()
  }, 60_000)

  it("the watchdog kills it soon after the hard deadline, with a fatal line saying why", async () => {
    const t0 = Date.now()
    proc.proc.kill("SIGTERM")
    // Inside the edge grace the listener still takes a request: this one
    // holds the main thread for far longer than the hard deadline.
    await Bun.sleep(300)
    void fetch(`${proc.url}/api/_test/shutdown/block?ms=45000`).catch(() => undefined)
    const ended = await Promise.race([proc.proc.exited, Bun.sleep(30_000).then(() => "hung")])
    const ms = Date.now() - t0
    expect(ended).not.toBe("hung")
    expect(proc.proc.signalCode).toBe("SIGKILL")
    expect(ms).toBeGreaterThanOrEqual(HARD_DEADLINE_MS)
    expect(ms).toBeLessThan(HARD_DEADLINE_MS + SHUTDOWN_WATCHDOG_GRACE_MS + 4_000)
    expect(proc.stderr() + proc.stdout()).toContain("shutdown watchdog")
  }, 90_000)
})
