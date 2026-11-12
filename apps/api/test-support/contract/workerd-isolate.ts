// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contract harness's workerd executor: the app's Worker module (the
// package's worker.js, built from source) runs in a real workerd process of
// the sandbox service (@liaison/sandbox-supervisor), and every ctx.* call
// comes back over HTTP through the app's own bridge route and run registry,
// as a self-hosted run does. One isolate = one key of the pool (a fresh org id
// per `open`), so its runs land in the same process and the same module
// instance, which is what the contract's twice-in-one-isolate check needs.
//
// Limits are the service's own: the wall clock (deadline, then the process
// is killed), CPU time and memory (RSS cap + V8 heap) read by the supervisor,
// bridge calls counted at the bridge. A run stopped by one reports it as an
// overrun. The module carries the contract's virtual clock (see
// WORKERD_VIRTUAL_TIME), so fixtures recorded on QuickJS replay unchanged.

import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  createSupervisor,
  DEFAULTS,
  RUN_DEPTH_HEADER,
  type Supervisor,
} from "@liaison/sandbox-supervisor"
import type { Server } from "bun"
import { Hono } from "hono"
import { buildWorkerModule } from "~/modules/app-builder/build/freeze-core"
import {
  CONTRACT_EPOCH_MS,
  type ContractExecutor,
  type ContractIsolate,
  type ContractRunOutcome,
  type ContractRunRequest,
  type ContractSource,
} from "~/modules/apps/contract/isolate"
import { createAppBridgeRoutes } from "~/modules/apps/workers/bridge-route"
import { RunRegistry } from "~/modules/apps/workers/run-registry"

interface Service {
  url: string
  bridgeOrigin: string
  registry: RunRegistry
  supervisor: Supervisor
  stop(): Promise<void>
}

let service: Promise<Service> | null = null

function startService(): Promise<Service> {
  service ??= (async () => {
    const registry = new RunRegistry()
    const routes = new Hono().route(
      "/api/app-bridge",
      createAppBridgeRoutes({ registry, isConfigured: () => true }),
    )
    const bridge: Server<undefined> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      fetch: (req) => routes.fetch(req),
    })
    const bridgeOrigin = `http://127.0.0.1:${bridge.port}`
    const supervisor = await createSupervisor({ ...DEFAULTS, bridgeOrigin, spares: 0 })
    const front: Server<undefined> = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      maxRequestBodySize: 16 * 1024 * 1024,
      fetch: (req) => supervisor.fetch(req),
    })
    return {
      url: `http://127.0.0.1:${front.port}`,
      bridgeOrigin,
      registry,
      supervisor,
      async stop() {
        front.stop(true)
        bridge.stop(true)
        await supervisor.stop()
      },
    }
  })()
  return service
}

/** Stop the shared sandbox service (a test file's afterAll). */
export async function stopWorkerdContractService(): Promise<void> {
  const s = service
  service = null
  if (s) await (await s).stop()
}

/**
 * The contract's virtual clock for a real event loop: `Date` starts at the
 * contract epoch on every run and moves only when the app waits in a timer,
 * `Math.random()` is seeded per run (both as VIRTUAL_TIME_PRELUDE, so a
 * fixture recorded on QuickJS matches), and a timer fires on the next turn of
 * the loop while the clock jumps to its due time. `sleepMs()` is how far the
 * app's own timers moved the clock (the wait check).
 */
const WORKERD_VIRTUAL_TIME = `(function () {
  var g = globalThis;
  var RealDate = g.Date;
  var realSetTimeout = g.setTimeout.bind(g);
  var realClearTimeout = g.clearTimeout.bind(g);
  var EPOCH = ${CONTRACT_EPOCH_MS};
  var state = { now: EPOCH, seed: 1 };
  function VDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof VDate)) return new RealDate(state.now).toString();
    var d = args.length === 0 ? new RealDate(state.now) : new (Function.prototype.bind.apply(RealDate, [null].concat(args)))();
    Object.setPrototypeOf(d, VDate.prototype);
    return d;
  }
  VDate.prototype = Object.create(RealDate.prototype);
  VDate.prototype.constructor = VDate;
  VDate.now = function () { return state.now; };
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  g.Date = VDate;
  Math.random = function () {
    var t = (state.seed = (state.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  var repeating = new Map();
  g.setTimeout = function (fn, ms) {
    var rest = Array.prototype.slice.call(arguments, 2);
    var due = state.now + Math.max(0, Number(ms) || 0);
    return realSetTimeout(function () {
      if (due > state.now) state.now = due;
      if (typeof fn === "function") fn.apply(null, rest);
    }, 0);
  };
  g.clearTimeout = function (id) { realClearTimeout(id); };
  g.setInterval = function (fn, ms) {
    var every = Math.max(1, Number(ms) || 0);
    var id = {};
    function next() {
      if (state.now >= EPOCH + 3600000) { repeating.delete(id); return; }
      repeating.set(id, g.setTimeout(function () { if (repeating.has(id)) { fn(); next(); } }, every));
    }
    repeating.set(id, null);
    next();
    return id;
  };
  g.clearInterval = function (id) {
    var t = repeating.get(id);
    repeating.delete(id);
    if (t) realClearTimeout(t);
  };
  g.__contract = {
    reset: function () { state.now = EPOCH; state.seed = 1; },
    sleepMs: function () { return state.now - EPOCH; }
  };
})();`

const WORKER_ENTRY_RE = /[\\/]modules[\\/]apps[\\/]workers[\\/]worker-entry\.ts$/
const WORKER_CORE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "src",
  "modules",
  "apps",
  "workers",
  "worker-core.ts",
)

/**
 * The product's Worker entry with the virtual clock in front: reset at the
 * start of every run, and the run's `sleepMs` read from it.
 */
const contractEntryPlugin: Bun.BunPlugin = {
  name: "contract-worker-entry",
  setup(build) {
    build.onLoad({ filter: WORKER_ENTRY_RE }, () => ({
      loader: "ts",
      contents: [
        'import { WorkerEntrypoint } from "cloudflare:workers"',
        `import { runWithBridge } from ${JSON.stringify(WORKER_CORE_PATH)}`,
        WORKERD_VIRTUAL_TIME,
        "export function createWorkerEntrypoint(mod: Record<string, unknown>) {",
        "  return class AppWorker extends WorkerEntrypoint {",
        "    async run(req: any, bridge: any) {",
        "      ;(globalThis as any).__contract.reset()",
        "      const r: any = await runWithBridge(mod, req, bridge)",
        "      if (r && r.timings) {",
        "        r.timings.sleepMs = (globalThis as any).__contract.sleepMs()",
        "        r.timings.sleepExact = true",
        "      }",
        "      return r",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    }))
  },
}

/** An app's (or a PDF template's) Worker module, built from its source file. */
export async function workerModuleSource(entryPath: string): Promise<ContractSource> {
  const built = await buildWorkerModule({ handlersPath: entryPath, plugins: [contractEntryPlugin] })
  return { workerModule: built.text }
}

interface Answer {
  ok?: boolean
  result?: unknown
  error?: { message?: string; kind?: string; code?: string }
  timings?: { sleepMs?: number }
}

class WorkerdContractIsolate implements ContractIsolate {
  private readonly orgId = `contract-${randomUUID()}`

  constructor(
    private readonly svc: Service,
    private readonly sha256: string,
  ) {}

  async run(req: ContractRunRequest): Promise<ContractRunOutcome> {
    const started = Date.now()
    const bridgeMethods = Object.keys(req.bridge)
    // The approval literal travels in the run body on Workers and workerd
    // (worker-core reads req.approval); the harness serves it as QuickJS's
    // shim reads it, from the bridge.
    const approvalGet = req.bridge._approvalContext_get
    const approvalText = typeof approvalGet === "function" ? await approvalGet() : undefined
    const approval = typeof approvalText === "string" ? JSON.parse(approvalText) : null
    const run = this.svc.registry.registerRun({
      bridge: req.bridge,
      bridgeMethods,
      orgId: this.orgId,
      appName: "contract",
      version: "0.0.0",
      timeoutMs: req.limits.wallMs,
      maxBridgeCalls: req.limits.bridgeCalls,
    })
    try {
      const res = await fetch(`${this.svc.url}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", [RUN_DEPTH_HEADER]: "0" },
        body: JSON.stringify({
          runId: run.runId,
          orgId: this.orgId,
          app: "contract",
          version: "0.0.0",
          sha256: this.sha256,
          exportName: req.exportName,
          params: req.params ?? null,
          extraArgs: req.extraArgs ?? [],
          approval,
          bridgeMethods,
          bridgeUrl: `${this.svc.bridgeOrigin}/api/app-bridge/${encodeURIComponent(run.runId)}`,
          runToken: run.runToken,
          deadlineMs: req.limits.wallMs,
          limits: { cpuMs: req.limits.cpuMs, subRequests: req.limits.subrequests },
        }),
      })
      const answer = (await res.json()) as Answer
      const wallMs = Date.now() - started
      const sleepMs = answer.timings?.sleepMs ?? 0
      if (answer.ok) return { ok: true, result: answer.result ?? null, wallMs, sleepMs }
      const kind = answer.error?.kind
      const outcome: ContractRunOutcome = {
        ok: false,
        error: kind === "timeout" ? "App execution timed out" : (answer.error?.message ?? ""),
        wallMs,
        sleepMs,
      }
      if (kind === "timeout") outcome.overrun = "wall"
      else if (kind === "limit" && answer.error?.code === "memory_limit") outcome.overrun = "memory"
      else if (kind !== "handler") {
        throw new Error(`the sandbox could not run the module (${kind}): ${outcome.error}`)
      }
      return outcome
    } finally {
      run.settle()
    }
  }

  dispose(): void {}
}

export const workerdContractExecutor: ContractExecutor = {
  name: "workerd",
  async open(source: ContractSource): Promise<ContractIsolate> {
    if (source.workerModule === undefined) {
      throw new Error("the workerd executor needs a Worker module (workerModuleSource)")
    }
    const svc = await startService()
    const bytes = new TextEncoder().encode(source.workerModule)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const put = await fetch(`${svc.url}/modules/${sha256}`, { method: "PUT", body: bytes })
    if (put.status !== 204) throw new Error(`module push refused: HTTP ${put.status}`)
    return new WorkerdContractIsolate(svc, sha256)
  },
}
