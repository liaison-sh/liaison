// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sandbox service: app runs on a supervised pool of workerd processes
// (pool.ts), each running the shared app loader as its parent Worker
// (host-worker.ts). It speaks the app loader's protocol (@liaison/app-loader
// protocol.ts), so a cell's executor drives it as it drives the Workers loader.
//
//   POST /run              a loader `/run` body. The cell's signature headers,
//                          if any, are not checked: the service holds no cell
//                          key. It is reachable only from the app (the sandbox
//                          network, or loopback in development), and a run can
//                          do nothing without its own token, which the app's
//                          bridge checks on every call.
//                          `x-liaison-run-depth: <n>` marks a nested run.
//   PUT  /modules/<sha256> the module bytes of an app version (content
//                          addressed, re-hashed here and again by the loader).
//                          A run whose module was never pushed answers
//                          `bundle_missing`; the cell pushes it and runs again.
//   GET  /health, /stats
//
// Per-run limits, each by its own mechanism (workerd enforces none itself):
//   wall      the run's deadline + SANDBOX_KILL_GRACE_MS, then SIGKILL
//   CPU       the process's CPU time since the run started (proc-meter.ts),
//             over the run's cpuMs (the loader protocol's limits, capped)
//   memory    V8 --max-old-space-size per process + its RSS over the cap
//   subrequests  counted by the app's bridge, where every call lands
// A killed process is replaced; its run answers `limit` or `timeout`. A run
// the loader itself timed out (an awaited promise that never settles) also
// takes its process down: the isolate may still hold work.

import {
  bundleKey,
  deadlineDuration,
  dynamicWorkerId,
  type ErrorKind,
  fail,
  MAX_FETCHED_BUNDLE_BYTES,
  type RunBody,
  runLimits,
  sha256Hex,
  signCellRequestV2,
  validateRunBody,
} from "@liaison/app-loader"
import type { SupervisorConfig } from "./config"
import { SANDBOX_CELL_ID } from "./cell"
import { hostWorkerSource } from "./host-build"
import { PoolError, WorkerdPool, type WorkerdProcess } from "./pool"
import { sampleProcess } from "./proc-meter"
import { pinnedWorkerdVersion } from "./workerd-bin"

export const RUN_DEPTH_HEADER = "x-liaison-run-depth"
const MODULE_CACHE_BYTES = 256 * 1024 * 1024
const SHA = /^[0-9a-f]{64}$/

export type KillReason = "cpu" | "memory" | "wall" | "heap" | "crashed"

export interface RunRecord {
  executor: "workerd"
  runId: string
  proc: number
  how: string
  depth: number
  queueMs: number
  wallMs: number
  cpuMs: number
  rssMaxMb: number
  killed: KillReason | null
}

export interface Supervisor {
  fetch(req: Request): Promise<Response>
  readonly pool: WorkerdPool
  /** The last runs' records (newest last), for tests and /stats. */
  readonly recent: RunRecord[]
  stop(): Promise<void>
}

function killAnswer(reason: KillReason, extra: Record<string, unknown>): Response {
  const error: { message: string; kind: ErrorKind; code?: string } =
    reason === "cpu"
      ? { message: "Worker exceeded cpu time limit", kind: "limit", code: "cpu_limit" }
      : reason === "memory" || reason === "heap"
        ? { message: "Worker exceeded memory limit", kind: "limit", code: "memory_limit" }
        : reason === "wall"
          ? { message: "App execution timed out", kind: "timeout" }
          : { message: "The sandbox process died", kind: "loader_internal", code: "process_died" }
  return Response.json({ ok: false, error, ...extra })
}

export async function createSupervisor(cfg: SupervisorConfig): Promise<Supervisor> {
  const pool = new WorkerdPool(cfg, await hostWorkerSource())
  const modules = new Map<string, Uint8Array>()
  let moduleBytes = 0
  const recent: RunRecord[] = []
  void pool.topUpSpares()

  function remember(sha: string, bytes: Uint8Array): void {
    if (modules.has(sha)) modules.delete(sha)
    else moduleBytes += bytes.byteLength
    modules.set(sha, bytes)
    for (const [k, v] of modules) {
      if (moduleBytes <= MODULE_CACHE_BYTES) break
      modules.delete(k)
      moduleBytes -= v.byteLength
    }
  }

  async function putModule(req: Request, sha: string): Promise<Response> {
    if (!SHA.test(sha)) return fail(400, "loader_internal", "invalid sha256", { code: "bad_request" })
    const len = Number(req.headers.get("content-length") ?? "0")
    if (len > MAX_FETCHED_BUNDLE_BYTES) {
      return fail(413, "loader_internal", "module too large", { code: "bad_request" })
    }
    const bytes = new Uint8Array(await req.arrayBuffer())
    if (bytes.byteLength > MAX_FETCHED_BUNDLE_BYTES) {
      return fail(413, "loader_internal", "module too large", { code: "bad_request" })
    }
    if ((await sha256Hex(bytes)) !== sha) {
      return fail(409, "load", "bundle hash mismatch", { code: "hash_mismatch" })
    }
    remember(sha, bytes)
    return new Response(null, { status: 204 })
  }

  async function pushTo(p: WorkerdProcess, key: string, bytes: Uint8Array): Promise<void> {
    if (p.pushed.has(key)) return
    const res = await fetch(`http://sandbox/__module?key=${encodeURIComponent(key)}`, {
      unix: p.socket,
      method: "PUT",
      body: bytes,
    })
    if (res.status !== 204) throw new Error(`module push refused: HTTP ${res.status}`)
    p.pushed.add(key)
  }

  async function run(req: Request): Promise<Response> {
    const raw = new Uint8Array(await req.arrayBuffer())
    let body: RunBody
    try {
      body = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return fail(400, "loader_internal", "body is not JSON", { code: "bad_request" })
    }
    const invalid = validateRunBody(body)
    if (invalid) return fail(400, "loader_internal", invalid, { code: "bad_request" })
    const depthRaw = req.headers.get(RUN_DEPTH_HEADER)
    const depth = depthRaw === null ? 0 : Number(depthRaw)
    if (!Number.isInteger(depth) || depth < 0) {
      return fail(400, "loader_internal", `invalid ${RUN_DEPTH_HEADER}`, { code: "bad_request" })
    }
    const module = modules.get(body.sha256)
    if (!module) {
      return fail(404, "bundle_missing", "module not pushed to the sandbox", {
        code: "bundle_missing",
      })
    }

    const tq = Date.now()
    const deadlineAt = tq + deadlineDuration(body.deadlineMs, tq)
    const key = dynamicWorkerId(SANDBOX_CELL_ID, body)
    let acquired: Awaited<ReturnType<WorkerdPool["acquire"]>>
    try {
      acquired = await pool.acquire(key, depth, deadlineAt)
    } catch (e) {
      if (!(e instanceof PoolError)) throw e
      if (e.code === "queue_timeout") {
        return Response.json({ ok: false, error: { message: "App execution timed out", kind: "timeout" } })
      }
      if (e.code === "stopped") return fail(503, "loader_internal", e.message, { code: "stopping" })
      return fail(429, "limit", e.message, { code: e.code })
    }
    const { proc: p, how } = acquired
    const queueMs = Date.now() - tq
    const rec: RunRecord = {
      executor: "workerd",
      runId: body.runId,
      proc: p.n,
      how,
      depth,
      queueMs,
      wallMs: 0,
      cpuMs: 0,
      rssMaxMb: 0,
      killed: null,
    }
    const t0 = Date.now()
    let killed: KillReason | null = null
    const killFor = (reason: KillReason) => {
      if (killed || !cfg.killEnabled) return
      killed = reason
      pool.kill(p, reason)
    }
    let wallTimer: ReturnType<typeof setTimeout> | undefined
    let polling = true
    try {
      await pushTo(p, bundleKey(body), module)
      p.runs++
      pool.counters.runs++
      const cpuLimit = runLimits(body).cpuMs
      const start = await sampleProcess(p.pid)
      rec.rssMaxMb = start.rssMb
      wallTimer = setTimeout(
        () => killFor("wall"),
        Math.max(0, deadlineAt - Date.now()) + cfg.killGraceMs,
      )
      void (async () => {
        while (polling && !p.dead) {
          await Bun.sleep(cfg.pollMs)
          if (!polling || p.dead) break
          try {
            const s = await sampleProcess(p.pid)
            rec.cpuMs = s.cpuMs - start.cpuMs
            if (s.rssMb > rec.rssMaxMb) rec.rssMaxMb = s.rssMb
            if (rec.cpuMs > cpuLimit) killFor("cpu")
            else if (s.rssMb > cfg.rssCapMb) killFor("memory")
          } catch {}
        }
      })()
      const headers = {
        "content-type": "application/json",
        ...(await signCellRequestV2({
          cellId: SANDBOX_CELL_ID,
          cellKey: p.processKey,
          direction: "cell->loader",
          method: "POST",
          path: "/run",
          body: raw,
          ts: Date.now(),
        })),
      }
      let res: Response
      let text: string
      try {
        res = await fetch("http://sandbox/run", { unix: p.socket, method: "POST", headers, body: raw })
        text = await res.text()
      } catch {
        // The process went away under the run: a limit's kill, or it died.
        await Promise.race([p.child.exited, Bun.sleep(200)])
        const heap = /heap|out of memory|allocation failed|OOM/i.test(p.stderrTail)
        const reason: KillReason = killed ?? (heap ? "heap" : "crashed")
        pool.exitedUnderRun(p, reason)
        rec.killed = reason
        return killAnswer(reason, {})
      }
      if (killed) {
        rec.killed = killed
        return killAnswer(killed, {})
      }
      // The loader gave up on an awaited promise: the isolate may still hold
      // work, so its process is not reused.
      if (/"kind":"timeout"/.test(text.slice(0, 512))) pool.kill(p, "timeout")
      return new Response(text, {
        status: res.status,
        headers: { "content-type": "application/json" },
      })
    } catch (e) {
      if (!p.dead) pool.kill(p, "crashed")
      return fail(500, "loader_internal", `sandbox error: ${(e as Error).message}`)
    } finally {
      polling = false
      if (wallTimer) clearTimeout(wallTimer)
      rec.wallMs = Date.now() - t0
      recent.push(rec)
      if (recent.length > 200) recent.splice(0, recent.length - 200)
      if (p.dead) pool.replaced()
      else pool.release(p)
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/health") return Response.json({ ok: true })
    if (url.pathname === "/stats" && req.method === "GET") {
      return Response.json({
        workerd: pinnedWorkerdVersion(),
        modules: modules.size,
        pool: pool.stats(),
        recent: recent.slice(-20),
      })
    }
    if (url.pathname === "/run" && req.method === "POST") return run(req)
    const m = /^\/modules\/([^/]+)$/.exec(url.pathname)
    if (m && req.method === "PUT") return putModule(req, m[1] ?? "")
    return new Response("not found", { status: 404 })
  }

  return {
    pool,
    recent,
    async fetch(req) {
      try {
        const res = await handle(req)
        return res
      } catch (e) {
        return fail(500, "loader_internal", `sandbox error: ${(e as Error).message}`)
      }
    },
    stop: () => pool.stop(),
  }
}
