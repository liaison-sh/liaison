// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-run limit table: what one run of app code may spend, per entry kind,
// on every executor. Every site that starts a sandboxed run (run-app.ts and
// the sites outside it: summarizers, PDF templates, import transforms) reads
// its budget here, and so do the executors (the QuickJS pools, the Workers
// executor), so a limit is changed in one place.
//
//   wallMs       wall clock of the run, from start to answer. QuickJS enforces
//                it with an interrupt handler plus a timer (the only CPU bound
//                it has); Workers sends it as the run's deadline.
//   cpuMs        CPU time of the run. Sent to the Workers loader, which caps it
//                itself as well; QuickJS has none beyond wallMs.
//   memoryBytes  heap of the run's isolate. QuickJS sets it on its runtime; a
//                Workers isolate has the platform's own limit.
//   subrequests  outbound calls of the run (provider fetches plus bridge calls,
//                which are subrequests on Workers). Sent to the Workers loader.
//   bridgeCalls  bridge calls of the run. The contract harness enforces it;
//                on Workers each one is a subrequest, so the loader's cap
//                holds it there too.
//
// The values are the ones each site used before the table existed (see each
// row). Env overrides kept: LIAISON_SANDBOX_TIMEOUT_MS (outside production),
// LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS, SANDBOX_MEMORY_LIMIT_MB,
// LIAISON_TRANSFORM_CALL_BUDGET_MS, LIAISON_SANDBOX_FETCH_TIMEOUT_MS.

/** Every kind of entry point app code runs as. */
export const RUN_ENTRY_KINDS = [
  "tool",
  "preflight",
  "webhook",
  "webhook-verify",
  "job",
  "event",
  "poll",
  "reconcile",
  "search",
  "export",
  "attention",
  "disconnect",
  "import",
  "preview",
  "import-transform",
  "pdf-template",
  "summarizer",
  "route",
  "provision",
] as const

export type RunEntryKind = (typeof RUN_ENTRY_KINDS)[number]

export interface RunLimits {
  wallMs: number
  cpuMs: number
  memoryBytes: number
  subrequests: number
  bridgeCalls: number
}

/**
 * How a kind's wall clock is found:
 *  - `base`: the sandbox default (5 s in production, else 60 s or
 *    LIAISON_SANDBOX_TIMEOUT_MS); a declared value is honoured between that and
 *    the instance ceiling (`clampDeclaredWallMs`). Tools, preflights, webhooks.
 *  - `declared-or`: the manifest's declared value as is (the manifest schema
 *    bounds it), else `ms`. Jobs, search.
 *  - `fixed`: always `ms`.
 *  - `transform`: an import transform call (`resolveTransformCallBudgetMs`).
 */
type WallRule =
  | { rule: "base" }
  | { rule: "declared-or"; ms: number }
  | { rule: "fixed"; ms: number }
  | { rule: "transform" }

interface KindRow {
  wall: WallRule
  /** The heap: the sandbox's (SANDBOX_MEMORY_LIMIT_MB) or a fixed size. */
  memory: { rule: "sandbox" } | { rule: "fixed"; bytes: number }
}

/** CPU time a Workers run may use (the loader caps it too). */
const CPU_MS = 30_000
/** Outbound calls a run may make (Workers subrequests). */
const SUBREQUESTS = 10_000
/** Bridge calls a run may make; each is a subrequest on Workers. */
const BRIDGE_CALLS = 10_000
/** The import transform pool's heap, whatever SANDBOX_MEMORY_LIMIT_MB says. */
const TRANSFORM_MEMORY_BYTES = 32 * 1024 * 1024
/** An import transform call's budget when neither the call nor the env names one. */
const TRANSFORM_CALL_BUDGET_MS = 30_000

const SANDBOX = { rule: "sandbox" } as const

/** The table. A row per entry kind; the comment says which site it was read at before. */
export const RUN_LIMIT_TABLE: Readonly<Record<RunEntryKind, KindRow>> = Object.freeze({
  // execute-tool.ts: the tool's declared timeoutMs through the instance ceiling.
  tool: { wall: { rule: "base" }, memory: SANDBOX },
  preflight: { wall: { rule: "base" }, memory: SANDBOX },
  // webhooks/manifest-execution.ts + infra/jobs/webhook-worker.ts (the delivery
  // also fits inside the request ceiling there).
  webhook: { wall: { rule: "base" }, memory: SANDBOX },
  "webhook-verify": { wall: { rule: "base" }, memory: SANDBOX },
  // runtime.ts: `jobDef.timeoutMs ?? 60_000`.
  job: { wall: { rule: "declared-or", ms: 60_000 }, memory: SANDBOX },
  // runtime.ts: event handlers 30 s (the bus's own handler timeout is 60 s).
  event: { wall: { rule: "fixed", ms: 30_000 }, memory: SANDBOX },
  // runtime.ts: async-output polls and outcome reconciles, 60 s.
  poll: { wall: { rule: "fixed", ms: 60_000 }, memory: SANDBOX },
  reconcile: { wall: { rule: "fixed", ms: 60_000 }, memory: SANDBOX },
  // runtime.ts: `searchDef.timeoutMs ?? 5000` (manifest bounds it to 10 s).
  search: { wall: { rule: "declared-or", ms: 5_000 }, memory: SANDBOX },
  // export/invoke-export.ts, attention-aggregator.ts, imports/runner.ts: the
  // sandbox default (the attention feed stops waiting after 2 s,
  // attention/state-materializer.ts PROVIDER_TIMEOUT_MS).
  export: { wall: { rule: "base" }, memory: SANDBOX },
  attention: { wall: { rule: "base" }, memory: SANDBOX },
  import: { wall: { rule: "base" }, memory: SANDBOX },
  // connections/before-disconnect.ts HOOK_TIMEOUT_MS.
  disconnect: { wall: { rule: "fixed", ms: 20_000 }, memory: SANDBOX },
  // app-builder/preview.ts PREVIEW_TIMEOUT_MS.
  preview: { wall: { rule: "fixed", ms: 30_000 }, memory: SANDBOX },
  // imports/transforms/pool.ts.
  "import-transform": {
    wall: { rule: "transform" },
    memory: { rule: "fixed", bytes: TRANSFORM_MEMORY_BYTES },
  },
  // pdf/sandbox-render.ts and pdf/pool.ts, 30 s.
  "pdf-template": { wall: { rule: "fixed", ms: 30_000 }, memory: SANDBOX },
  // runtime.ts: an app's approval summarizer, 5 s.
  summarizer: { wall: { rule: "fixed", ms: 5_000 }, memory: SANDBOX },
  // app-pages.ts: a page's call to one of the app's routes, like a tool.
  route: { wall: { rule: "base" }, memory: SANDBOX },
  // app-provisioning.ts: `config apply` / `config verify` running the app's
  // provisioning handler (a person waits on the CLI, like a disconnect hook).
  provision: { wall: { rule: "fixed", ms: 60_000 }, memory: SANDBOX },
})

type Env = NodeJS.ProcessEnv

/**
 * The sandbox default wall clock. Production pins a tight 5 s and IGNORES the
 * env override (a hung or abusive third-party handler must never hold a
 * worker). Outside production it is 60 s unless LIAISON_SANDBOX_TIMEOUT_MS
 * says otherwise: a scenario harness runs a whole multi-turn agent
 * conversation in one sandboxed run, which legitimately outlasts 60 s.
 */
export function resolveSandboxDefaultTimeoutMs(env: Env = process.env): number {
  if (env.NODE_ENV === "production") return 5_000
  const override = Number(env.LIAISON_SANDBOX_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : 60_000
}

/**
 * The ceiling of a declared wall clock (a tool's manifest `timeoutMs`): 120 s
 * unless LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS says otherwise. High enough for
 * the long declarations already shipped (a PDF render 120 s, a label buy 60 s),
 * low enough that a third-party manifest cannot pin a worker for minutes.
 */
export function resolveSandboxMaxToolTimeoutMs(env: Env = process.env): number {
  const override = Number(env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : 120_000
}

/**
 * A declared wall clock, honoured between the sandbox default and the
 * ceiling; undefined when nothing (valid) is declared, which means the
 * sandbox default.
 */
export function resolveToolTimeoutMs(
  declared: number | undefined,
  env: Env = process.env,
): number | undefined {
  if (typeof declared !== "number" || !Number.isFinite(declared) || declared <= 0) return undefined
  const base = resolveSandboxDefaultTimeoutMs(env)
  const max = resolveSandboxMaxToolTimeoutMs(env)
  return Math.min(Math.max(declared, base), max)
}

/**
 * The sandbox heap: 32 MiB unless SANDBOX_MEMORY_LIMIT_MB says otherwise. 8 MiB
 * was too small for one mail message pipeline (a fetched message, its parse
 * tree and its decoded body at once); 24 in-process slots of 32 MiB stay inside
 * the worker RSS recycling envelope.
 */
export function resolveSandboxMemoryLimit(env: Env = process.env): number {
  const overrideMb = Number(env.SANDBOX_MEMORY_LIMIT_MB)
  if (Number.isFinite(overrideMb) && overrideMb > 0) return Math.floor(overrideMb) * 1024 * 1024
  return 32 * 1024 * 1024
}

/**
 * One import transform call's budget: the call's own, else
 * LIAISON_TRANSFORM_CALL_BUDGET_MS, else 30 s, through `resolveToolTimeoutMs`
 * (never below the sandbox default, never above the ceiling).
 */
export function resolveTransformCallBudgetMs(declared?: number, env: Env = process.env): number {
  const fromEnv = Number(env.LIAISON_TRANSFORM_CALL_BUDGET_MS)
  const wanted =
    declared ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : TRANSFORM_CALL_BUDGET_MS)
  return (
    resolveToolTimeoutMs(wanted, env) ??
    resolveToolTimeoutMs(TRANSFORM_CALL_BUDGET_MS, env) ??
    TRANSFORM_CALL_BUDGET_MS
  )
}

function wallMsOf(row: KindRow, declaredMs: number | undefined, env: Env): number {
  const wall = row.wall
  switch (wall.rule) {
    case "base":
      return resolveToolTimeoutMs(declaredMs, env) ?? resolveSandboxDefaultTimeoutMs(env)
    case "declared-or":
      return typeof declaredMs === "number" && Number.isFinite(declaredMs) && declaredMs > 0
        ? declaredMs
        : wall.ms
    case "fixed":
      return wall.ms
    case "transform":
      return resolveTransformCallBudgetMs(declaredMs, env)
  }
}

/**
 * The limits of one run of `kind`. `declaredMs` is the wall clock the entry
 * point declares (a manifest `timeoutMs`), when its kind honours one.
 */
export function runLimits(
  kind: RunEntryKind,
  opts: { declaredMs?: number | undefined; env?: Env } = {},
): RunLimits {
  const env = opts.env ?? process.env
  const row = RUN_LIMIT_TABLE[kind]
  return {
    wallMs: wallMsOf(row, opts.declaredMs, env),
    cpuMs: CPU_MS,
    memoryBytes: row.memory.rule === "fixed" ? row.memory.bytes : resolveSandboxMemoryLimit(env),
    subrequests: SUBREQUESTS,
    bridgeCalls: BRIDGE_CALLS,
  }
}

/** The part of the limits the Workers loader applies itself. */
export function workersLoaderLimits(limits: RunLimits): { cpuMs: number; subRequests: number } {
  return { cpuMs: limits.cpuMs, subRequests: limits.subrequests }
}

/**
 * The entry kind of a run's `<kind>:<name>` entry label (run-app.ts `entry`),
 * or null for a label of no kind in the table (`handler:<export>`).
 */
export function entryKindOf(entry: string): RunEntryKind | null {
  const kind = entry.slice(0, Math.max(0, entry.indexOf(":")))
  return (RUN_ENTRY_KINDS as readonly string[]).includes(kind) ? (kind as RunEntryKind) : null
}

// -- Egress (one outbound call of a run) -----------------------------------------

export interface EgressLimits {
  /** A read's answer wait (LIAISON_SANDBOX_FETCH_TIMEOUT_MS, at most 120 s; default 10 s). */
  fetchTimeoutMs: number
  /** The longest a non-multipart write may ask to wait for its answer. */
  writeMaxTimeoutMs: number
  /** The longest any call may wait (a multipart upload). */
  maxTimeoutMs: number
  maxResponseBytes: number
  maxRequestBytes: number
  /** A multipart upload's body (the bytes never cross into the sandbox). */
  multipartMaxRequestBytes: number
}

const EGRESS_MAX_TIMEOUT_MS = 120_000

/**
 * The per-call egress limits of `ctx.fetch` (sandbox/bridge/egress.ts). A
 * call is also bounded by its run's wall clock.
 */
export function egressLimits(env: Env = process.env): EgressLimits {
  const override = Number(env.LIAISON_SANDBOX_FETCH_TIMEOUT_MS)
  return {
    fetchTimeoutMs:
      Number.isFinite(override) && override > 0
        ? Math.min(override, EGRESS_MAX_TIMEOUT_MS)
        : 10_000,
    writeMaxTimeoutMs: 30_000,
    maxTimeoutMs: EGRESS_MAX_TIMEOUT_MS,
    maxResponseBytes: 1_000_000,
    maxRequestBytes: 1_000_000,
    multipartMaxRequestBytes: 25 * 1024 * 1024,
  }
}

// -- SQL connections (one `ctx.sql` call of a run) -------------------------------

export interface SqlCallLimits {
  /** A call's statement timeout when it asks for none. */
  defaultTimeoutMs: number
  /** The longest statement timeout a call may ask for (also bounded by its run). */
  maxTimeoutMs: number
  /** Rows a call returns when it asks for no cap. */
  defaultMaxRows: number
  /** The most rows any call returns. */
  maxRows: number
  /** Host-held connection pools per server process (least recently used closed first). */
  poolsMax: number
  /** A pool unused this long is closed. */
  poolIdleMs: number
}

/**
 * The per-call limits of the platform-held SQL connections
 * (connections/sql/service.ts). The statement timeout is set on the database
 * and the call is cancelled there at its deadline; rows beyond the cap are
 * never sent to the run. LIAISON_SQL_POOLS_MAX overrides the pool bound.
 */
export function sqlCallLimits(env: Env = process.env): SqlCallLimits {
  const pools = Number(env.LIAISON_SQL_POOLS_MAX)
  return {
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: Math.min(120_000, resolveSandboxMaxToolTimeoutMs(env)),
    defaultMaxRows: 500,
    maxRows: 2_000,
    poolsMax: Number.isInteger(pools) && pools > 0 ? pools : 32,
    poolIdleMs: 10 * 60_000,
  }
}

// -- The shared per-connection limiter (connection-limiter.ts) ---------------------

export interface ConnectionLimiterLimits {
  /**
   * The longest a call waits for its connection's permit before it fails with
   * `provider_rate_limited` (429): an interactive run (a tool, whose default
   * wall clock is 5 s in production) waits briefly, a job longer.
   */
  maxWaitMs: { interactive: number; background: number }
  /** The longest pause one provider answer (`Retry-After`, `ctx.limiter.pause`) may set. */
  maxPauseMs: number
  /**
   * A concurrency permit's lease: freed after this long even if its holder
   * died without releasing it. Above the longest egress call.
   */
  leaseTtlMs: number
  /** One Redis round trip of the limiter; past it the limiter fails open. */
  redisTimeoutMs: number
}

/** The limits of the shared per-connection limiter. */
export function connectionLimiterLimits(env: Env = process.env): ConnectionLimiterLimits {
  return {
    maxWaitMs: { interactive: 2_000, background: 20_000 },
    maxPauseMs: 60_000,
    leaseTtlMs: egressLimits(env).maxTimeoutMs + 10_000,
    redisTimeoutMs: 250,
  }
}
