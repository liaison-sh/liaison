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
//                          `x-liaison-run-depth: <n>` marks a nested run;
//                          the body's `lane` (interactive by default) picks
//                          the top-level run's share of the pool (pool.ts).
//   PUT  /modules/<sha256> the module bytes of an app version (content
//                          addressed, re-hashed here and again by the loader).
//                          A run whose module was never pushed answers
//                          `bundle_missing`; the cell pushes it and runs again.
//   GET  /health, /stats   (`/health?bridge=1` also says whether the caller's
//                          bridge-only listener answers from here, and answers
//                          503 `sandbox_network_open` while the firewall
//                          self-check finds more than that reachable)
//
// The firewall self-check (network-check.ts) runs at start, then every hour
// (every 30 s while it finds the network open, and at once on a health check
// then): while it finds an app's main port, the host or the metadata address
// reachable from here, every /run is refused with `sandbox_network_open`.
//
// Every request may carry the app's release (`x-liaison-sandbox-release`,
// release.ts). One of another release is refused (409
// `sandbox_release_mismatch`, saying how to recreate the service), and
// /health answers 503 while only callers of another release reach the
// service: after an upgrade that left this container on the old image, its
// health check fails and every run says why.
//
// Bridge calls: a workerd process's only outbound address is this service's
// bridge relay (a unix socket in the pool's work dir). The relay passes a call
// (`POST /api/app-bridge/<runId>`, nothing else) to the app process that sent
// that run, at the address the run came from, on the bridge port of
// SANDBOX_BRIDGE_ORIGIN (or to SANDBOX_BRIDGE_ADDRESS when it is set). So any
// number of app processes (a single `app`, or the rolling `api` and `worker`
// processes) share one sandbox service, each reached on its own bridge-only
// listener; a call for a run that is not running here goes nowhere.
//
// Each answer of /run carries the run's CPU time as the supervisor measured
// it (`x-liaison-sandbox-cpu-ms`), its peak resident memory
// (`x-liaison-sandbox-rss-mb`), for the app's usage rows, and how long it
// waited for a process (`x-liaison-sandbox-queue-ms`), for its timing record.
//
// Per-run limits, each by its own mechanism (workerd enforces none itself):
//   wall      the run's deadline + SANDBOX_KILL_GRACE_MS, then SIGKILL. The
//             deadline counts from the run's arrival (its wait for a process
//             included), or, for a background run with its own queue bound
//             (RunBody.queueMs), from its start.
//   CPU       the process's CPU time since the run started (proc-meter.ts),
//             over the run's cpuMs (the loader protocol's limits, capped)
//   memory    V8 --max-old-space-size per process + its RSS over the cap
//   subrequests  counted by the app's bridge, where every call lands
// A killed process is replaced; its run answers `limit` or `timeout`. A run
// the loader itself timed out (an awaited promise that never settles) also
// takes its process down: the isolate may still hold work.

import { chmodSync } from "node:fs"
import {
  bundleKey,
  deadlineDuration,
  dynamicWorkerId,
  type ErrorKind,
  fail,
  MAX_FETCHED_BUNDLE_BYTES,
  MAX_QUEUE_MS,
  queueBound,
  type RunBody,
  type RunLane,
  runLimits,
  sha256Hex,
  signCellRequestV2,
  validateRunBody,
} from "@liaison/app-loader"
import { SANDBOX_CELL_ID } from "./cell"
import type { SupervisorConfig } from "./config"
import { hostWorkerSource } from "./host-build"
import {
  NETWORK_OPEN_CODE,
  NetworkCheck,
  type NetworkCheckOptions,
  networkOpenMessage,
} from "./network-check"
import { PoolError, WorkerdPool, type WorkerdProcess } from "./pool"
import { sampleProcess } from "./proc-meter"
import {
  RELEASE_HEADER,
  RELEASE_MISMATCH_CODE,
  releaseMismatchMessage,
  sandboxRelease,
} from "./release"
import { pinnedWorkerdVersion } from "./workerd-bin"

export const RUN_DEPTH_HEADER = "x-liaison-run-depth"
export const CPU_HEADER = "x-liaison-sandbox-cpu-ms"
export const RSS_HEADER = "x-liaison-sandbox-rss-mb"
export const QUEUE_HEADER = "x-liaison-sandbox-queue-ms"
/** How long a caller's release counts toward /health. */
export const RELEASE_WINDOW_MS = 120_000
const BRIDGE_CALL = /^\/api\/app-bridge\/([^/]+)$/
const MODULE_CACHE_BYTES = 256 * 1024 * 1024
const SHA = /^[0-9a-f]{64}$/

export type KillReason = "cpu" | "memory" | "wall" | "heap" | "crashed"

export interface RunRecord {
  executor: "workerd"
  runId: string
  proc: number
  how: string
  depth: number
  lane: RunLane
  queueMs: number
  /**
   * How long it could wait for a process: its own queue bound (a background
   * run's RunBody.queueMs; its deadline then counted from its start), or its
   * deadline (null queue bound: the wait counted toward it).
   */
  queueLimitMs: number
  /** Whether its deadline counted from its start (a separate queue bound) or its arrival. */
  deadlineFrom: "start" | "arrival"
  wallMs: number
  cpuMs: number
  rssMaxMb: number
  killed: KillReason | null
}

/** Where the request came from: the caller's address, when the server knows it. */
export interface CallerInfo {
  requestIP(req: Request): { address: string } | null
}

export interface Supervisor {
  fetch(req: Request, server?: CallerInfo): Promise<Response>
  /** This service's release (release.ts). */
  readonly release: string
  readonly pool: WorkerdPool
  /** The firewall self-check (network-check.ts). */
  readonly network: NetworkCheck
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

/** `host:port` for a caller's address (an IPv4-mapped IPv6 address as IPv4). */
function hostPort(address: string, port: string): string {
  const a = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "")
  return a.includes(":") ? `[${a}]:${port}` : `${a}:${port}`
}

/** How often the firewall self-check runs while it finds the network closed, and while open. */
export const NETWORK_RECHECK_MS = { closed: 60 * 60 * 1000, open: 30_000 }
/** A health check re-runs the self-check at once when its last open verdict is older than this. */
const NETWORK_HEALTH_FRESH_MS = 2_000

export async function createSupervisor(
  cfg: SupervisorConfig,
  opts: {
    release?: string
    /** Tests: the self-check's probe and gateway. */
    network?: Pick<NetworkCheckOptions, "accepts" | "gateway" | "timeoutMs">
  } = {},
): Promise<Supervisor> {
  const release = opts.release ?? sandboxRelease()
  const pool = new WorkerdPool(cfg, await hostWorkerSource())
  const origin = new URL(cfg.bridgeOrigin)
  const network = new NetworkCheck({
    mode: cfg.networkCheck,
    appPorts: cfg.probeAppPorts,
    gatewayPorts: cfg.probeGatewayPorts,
    appHosts: [origin.hostname],
    ...opts.network,
    log: (level, msg, extra) => {
      const line = JSON.stringify({ level, msg, ...extra })
      if (level === "info") console.log(line)
      else console.error(line)
    },
  })
  let networkTimer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  const scheduleNetworkCheck = () => {
    if (stopping || network.mode === "off") return
    if (networkTimer) clearTimeout(networkTimer)
    const every =
      network.verdict.state === "open" ? NETWORK_RECHECK_MS.open : NETWORK_RECHECK_MS.closed
    networkTimer = setTimeout(() => {
      void network.check().finally(scheduleNetworkCheck)
    }, every)
    networkTimer.unref?.()
  }
  const firstNetworkCheck = network.check().finally(scheduleNetworkCheck)
  /** A caller seen for the first time: its main port joins the self-check. */
  const noteCaller = (caller: string | null) => {
    if (!caller) return
    const host = caller.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "")
    if (host === "127.0.0.1" || host === "::1") return
    if (network.noteAppHost(host)) void network.check()
  }
  const bridgePort = origin.port || "80"
  const fallbackTarget = cfg.bridgeAddress ?? `${origin.hostname}:${bridgePort}`
  /**
   * Running runs: where their bridge calls go, and how many /run requests
   * name the id (a replayed body must not end the original's routing).
   */
  const runTargets = new Map<string, { target: string; n: number }>()
  const seen = { match: 0, mismatch: 0, other: "" }
  const relaySocket = `${pool.workDir}/bridge.sock`
  const relay = Bun.serve({
    unix: relaySocket,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const m = BRIDGE_CALL.exec(path)
      const target =
        m && req.method === "POST"
          ? runTargets.get(decodeURIComponent(m[1] ?? ""))?.target
          : undefined
      if (!target) return new Response("Not Found", { status: 404 })
      const headers = new Headers(req.headers)
      headers.delete("host")
      headers.delete("connection")
      try {
        const res = await fetch(`http://${target}${path}`, {
          method: "POST",
          headers,
          body: await req.arrayBuffer(),
          redirect: "manual",
          // A bridge call may wait on a nested run: the run's deadline bounds it.
          timeout: false,
        } as RequestInit)
        return new Response(res.body, { status: res.status, headers: res.headers })
      } catch (e) {
        return Response.json(
          { error: `bridge unreachable: ${(e as Error).message}` },
          { status: 502 },
        )
      }
    },
  })
  // Processes of their own uids connect to the relay too.
  if (cfg.processUids) chmodSync(relaySocket, 0o666)
  pool.bridgeTarget = `unix:${relaySocket}`
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
    if (!SHA.test(sha))
      return fail(400, "loader_internal", "invalid sha256", { code: "bad_request" })
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

  async function run(req: Request, caller: string | null): Promise<Response> {
    noteCaller(caller)
    await firstNetworkCheck
    if (network.refusing && network.verdict.state === "open") {
      return fail(503, "loader_internal", networkOpenMessage(network.verdict.reachable), {
        code: NETWORK_OPEN_CODE,
      })
    }
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

    const target = cfg.bridgeAddress ?? (caller ? hostPort(caller, bridgePort) : fallbackTarget)
    // The first request for a run id decides where its calls go; a replay of
    // the same body adds a reference and never redirects them.
    const entry = runTargets.get(body.runId) ?? { target, n: 0 }
    entry.n++
    runTargets.set(body.runId, entry)
    try {
      return await runOn(body, raw, depth, module)
    } finally {
      if (--entry.n === 0) runTargets.delete(body.runId)
    }
  }

  async function runOn(
    body: RunBody,
    raw: Uint8Array,
    depth: number,
    module: Uint8Array,
  ): Promise<Response> {
    const tq = Date.now()
    const runMs = deadlineDuration(body.deadlineMs, tq)
    const key = dynamicWorkerId(SANDBOX_CELL_ID, body)
    const lane: RunLane = body.lane ?? "interactive"
    // One rule (the Workers admission applies the same, workers/admission.ts):
    // a background run that states its own queue bound waits up to that for a
    // process and then gets its whole deadline; any other run's deadline
    // counts from its arrival, the wait included (a person waits on it).
    const ownQueue = depth === 0 ? queueBound(body) : null
    const queueLimitMs = ownQueue ?? runMs
    const deadlineFrom = ownQueue === null ? "arrival" : "start"
    let acquired: Awaited<ReturnType<WorkerdPool["acquire"]>>
    try {
      acquired = await pool.acquire(key, depth, tq + queueLimitMs, lane)
    } catch (e) {
      if (!(e instanceof PoolError)) throw e
      if (e.code === "queue_timeout") {
        // It never started: its queue bound went waiting for a process.
        const queueMs = Date.now() - tq
        recent.push({
          executor: "workerd",
          runId: body.runId,
          proc: 0,
          how: "queue_timeout",
          depth,
          lane,
          queueMs,
          queueLimitMs,
          deadlineFrom,
          wallMs: 0,
          cpuMs: 0,
          rssMaxMb: 0,
          killed: null,
        })
        if (recent.length > 200) recent.splice(0, recent.length - 200)
        const r = Response.json({
          ok: false,
          error: {
            message: "Queued sandbox request timed out waiting for a free worker",
            kind: "timeout",
            code: "queue_timeout",
          },
        })
        r.headers.set(QUEUE_HEADER, String(queueMs))
        return r
      }
      if (e.code === "stopped") return fail(503, "loader_internal", e.message, { code: "stopping" })
      return fail(429, "limit", e.message, { code: e.code })
    }
    const { proc: p, how } = acquired
    const queueMs = Date.now() - tq
    const deadlineAt = (ownQueue === null ? tq : Date.now()) + runMs
    const rec: RunRecord = {
      executor: "workerd",
      runId: body.runId,
      proc: p.n,
      how,
      depth,
      lane,
      queueMs,
      queueLimitMs,
      deadlineFrom,
      wallMs: 0,
      cpuMs: 0,
      rssMaxMb: 0,
      killed: null,
    }
    const t0 = Date.now()
    // The run's measured CPU and peak memory go back with its answer.
    const answer = (r: Response): Response => {
      r.headers.set(CPU_HEADER, String(Math.max(0, Math.round(rec.cpuMs))))
      r.headers.set(RSS_HEADER, String(Math.round(rec.rssMaxMb)))
      r.headers.set(QUEUE_HEADER, String(rec.queueMs))
      return r
    }
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
        res = await fetch("http://sandbox/run", {
          unix: p.socket,
          method: "POST",
          headers,
          body: raw,
        })
        text = await res.text()
      } catch {
        // The process went away under the run: a limit's kill, or it died.
        await Promise.race([p.child.exited, Bun.sleep(200)])
        const heap = /heap|out of memory|allocation failed|OOM/i.test(p.stderrTail)
        const reason: KillReason = killed ?? (heap ? "heap" : "crashed")
        pool.exitedUnderRun(p, reason)
        rec.killed = reason
        return answer(killAnswer(reason, {}))
      }
      if (killed) {
        rec.killed = killed
        return answer(killAnswer(killed, {}))
      }
      // The run's CPU to its end (the poll may not have read the last of it).
      try {
        const end = await sampleProcess(p.pid)
        rec.cpuMs = Math.max(rec.cpuMs, end.cpuMs - start.cpuMs)
        if (end.rssMb > rec.rssMaxMb) rec.rssMaxMb = end.rssMb
      } catch {}
      // The loader gave up on an awaited promise: the isolate may still hold
      // work, so its process is not reused.
      if (/"kind":"timeout"/.test(text.slice(0, 512))) pool.kill(p, "timeout")
      return answer(
        new Response(text, {
          status: res.status,
          headers: { "content-type": "application/json" },
        }),
      )
    } catch (e) {
      if (!p.dead) pool.kill(p, "crashed")
      return answer(fail(500, "loader_internal", `sandbox error: ${(e as Error).message}`))
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

  /**
   * The caller's release against this service's: null when it may go on (the
   * same release, or none stated), else the refusal.
   */
  function releaseCheck(req: Request): Response | null {
    const theirs = req.headers.get(RELEASE_HEADER)
    if (theirs === null) return null
    if (theirs === release) {
      seen.match = Date.now()
      return null
    }
    seen.mismatch = Date.now()
    seen.other = theirs.slice(0, 128)
    return fail(409, "loader_internal", releaseMismatchMessage(release, seen.other), {
      code: RELEASE_MISMATCH_CODE,
    })
  }

  /**
   * Whether the caller's bridge-only listener answers from here (any HTTP
   * answer: a GET there is the listener's own 404), for `GET /health?bridge=1`.
   */
  async function bridgeReachable(caller: string | null): Promise<boolean> {
    const target = cfg.bridgeAddress ?? (caller ? hostPort(caller, bridgePort) : fallbackTarget)
    try {
      const res = await fetch(`http://${target}/api/app-bridge/sandbox-probe`, {
        signal: AbortSignal.timeout(1_000),
      })
      await res.arrayBuffer()
      return true
    } catch {
      return false
    }
  }

  /** Healthy unless, lately, only callers of another release reached this service. */
  async function health(req: Request, caller: string | null): Promise<Response> {
    const now = Date.now()
    const stale = now - seen.mismatch < RELEASE_WINDOW_MS && now - seen.match >= RELEASE_WINDOW_MS
    if (stale) {
      return Response.json(
        {
          ok: false,
          release,
          code: RELEASE_MISMATCH_CODE,
          message: releaseMismatchMessage(release, seen.other),
        },
        { status: 503 },
      )
    }
    if (new URL(req.url).searchParams.get("bridge") === "1") {
      noteCaller(caller)
      await firstNetworkCheck
      // Open lately: look again now, so the firewall step shows at once.
      const v = network.verdict
      const recheck =
        network.refusing && v.state === "open" && now - v.checkedAt > NETWORK_HEALTH_FRESH_MS
      const [bridgeOk] = await Promise.all([
        bridgeReachable(caller),
        recheck ? network.check().then(scheduleNetworkCheck) : Promise.resolve(),
      ])
      const after = network.verdict
      if (network.refusing && after.state === "open") {
        return Response.json(
          {
            ok: false,
            release,
            code: NETWORK_OPEN_CODE,
            message: networkOpenMessage(after.reachable),
            reachable: after.reachable,
          },
          { status: 503 },
        )
      }
      return Response.json({
        ok: true,
        release,
        bridge: bridgeOk ? "ok" : "unreachable",
        network: after.state,
      })
    }
    // The container's own health: alive and of the callers' release. The
    // firewall verdict is the app's to report (its /healthz), so a stack can
    // start before its firewall step is installed.
    return Response.json({ ok: true, release, network: network.verdict.state })
  }

  async function handle(req: Request, server?: CallerInfo): Promise<Response> {
    const url = new URL(req.url)
    const refused = releaseCheck(req)
    if (refused) return refused
    const caller = server?.requestIP(req)?.address ?? null
    if (url.pathname === "/health") return health(req, caller)
    if (url.pathname === "/stats" && req.method === "GET") {
      return Response.json({
        workerd: pinnedWorkerdVersion(),
        release,
        modules: modules.size,
        network: network.verdict,
        processUids: cfg.processUids,
        // The effective sizes, what they were derived from, and the lane caps.
        sizes: {
          poolSize: cfg.poolSize,
          reserved: cfg.reserved,
          reservedInteractive: cfg.reservedInteractive,
          overflow: cfg.overflow,
          rssCapMb: cfg.rssCapMb,
          laneCaps: pool.caps,
          // How long a top-level run of each lane may wait for a process.
          queueLimits: {
            interactive: "deadline",
            background: { withQueueMs: "queueMs", maxMs: MAX_QUEUE_MS, withoutQueueMs: "deadline" },
          },
          sizing: cfg.sizing ?? null,
        },
        pool: pool.stats(),
        recent: recent.slice(-20),
      })
    }
    if (url.pathname === "/run" && req.method === "POST") {
      return run(req, caller)
    }
    const m = /^\/modules\/([^/]+)$/.exec(url.pathname)
    if (m && req.method === "PUT") return putModule(req, m[1] ?? "")
    return new Response("not found", { status: 404 })
  }

  return {
    pool,
    network,
    recent,
    release,
    async fetch(req, server) {
      try {
        const res = await handle(req, server)
        return res
      } catch (e) {
        return fail(500, "loader_internal", `sandbox error: ${(e as Error).message}`)
      }
    },
    async stop() {
      stopping = true
      if (networkTimer) clearTimeout(networkTimer)
      relay.stop(true)
      await pool.stop()
    },
  }
}
