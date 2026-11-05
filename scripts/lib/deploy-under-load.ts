// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deploys under load, and the launch scenario: the driver behind
// `bun run load-test --deploys N` and `bun run load-test --launch`.
//
// It runs qa/load/a9-deploy-under-load.js (k6) against a box whose load
// harness is on (LOAD_HARNESS_KEY), runs a deploy command N times while the
// traffic runs, then judges the run:
//
//   - every scripted agent turn got exactly its expected reply (k6 judges each
//     turn live; with DEPLOY_COUNTERS_DB_URL the stored turns are judged too);
//   - the effect sink (signed read, per load org) has no key counted twice;
//   - the deploy counters (scripts/lib/deploy-counters.ts): edge 5xx from the
//     edge's access log, turns cut by a process, duplicate effects;
//   - delays: p50 / p95 / max of requests, turns and WebSocket reconnect gaps
//     while a deploy ran, against the same outside the deploys;
//   - errors by type; for the launch scenario, the warm-pool hit rate and the
//     time to a workspace.
//
// It writes report.json and summary.txt into --out and prints the summary.
// Everything about the box comes from flags and the environment: its URL,
// its key, the deploy command, where its logs are read.
import { spawn } from "node:child_process"
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import postgres from "postgres"
import {
  LOAD_SCRIPT_REPLIES,
  SCRIPTED_FALLBACK_REPLY,
} from "../../apps/api/src/modules/agent/providers/load-script-catalog"
import {
  type CutTurn,
  cutTurnsWithLoadReplies,
  edge5xxMeasured,
  effectDuplicatesMeasured,
  readTurns,
} from "./deploy-counters"
import { HarnessClient, type LoadOrg, seedLoadOrgs } from "./load-harness-client"

// ── Flags ───────────────────────────────────────────────────────────────────

export interface DriverConfig {
  mode: "deploys" | "launch"
  box: string
  key: string
  /** Deploys mode: seed this many load orgs (unless --orgs-file). */
  orgs: number
  orgsFile: string | null
  prefix: string
  seed: string
  sessions: number
  needs: string[]
  deploys: number
  deployCmd: string | null
  warmupMs: number
  betweenMs: number
  cooldownMs: number
  /** How long after a deploy ends its window still counts as "during". */
  deployGraceMs: number
  /** Deploys mode with 0 deploys: how long the traffic runs. */
  durationMs: number | null
  turnIntervalS: number
  wsHoldS: number
  /** The page a user loads (unauthenticated), "/" on a box with its web shell. */
  pagePath: string
  /** Launch mode. */
  levels: number[]
  rampMs: number
  holdMs: number
  /** Visitors per minute; when set, arrivals follow a rate instead of a VU level. */
  arrivalPerMin: number | null
  walkS: number
  maxVus: number
  edgeLog: string | null
  edgeLogCmd: string | null
  appLogCmd: string | null
  out: string
  keepRaw: boolean
  k6: string
  /** One deploy command may run this long; then it is killed and counts as a failed deploy. */
  deployTimeoutMs: number
  /** A log command (edge / app) may run this long. */
  logTimeoutMs: number
  /** One signed request to the box may take this long. */
  fetchTimeoutMs: number
  /** After the driver stops k6, it is killed (SIGKILL) if it is still running this long after. */
  k6GraceMs: number
}

/** "90", "90s", "5m", "1h" → ms. */
export function parseDuration(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(v.trim())
  if (!m) throw new Error(`not a duration: ${v}`)
  const n = Number(m[1])
  const unit = m[2] ?? "s"
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!)
}

export const DRIVER_USAGE = `bun run load-test (--deploys N | --launch) --box <url> [flags]

Environment: LOAD_HARNESS_KEY (required, the box's key), LOAD_BOX_URL (or --box),
  LOAD_DEPLOY_CMD (or --deploy-cmd), DEPLOY_COUNTERS_DB_URL (optional, judges stored turns).

Deploys under load:
  --deploys N            rolling deploys to run during the load (0: traffic only)
  --deploy-cmd "<sh>"    the command that runs ONE deploy (exit 0 = deployed)
  --orgs N               load orgs to seed through the signed demo start (default 1)
  --orgs-file <path>     reuse orgs a previous run seeded (orgs.json)
  --prefix <p>           load org name prefix (default load-)
  --seed <s>             seed of the signup keys (same seed within an hour = same orgs)
  --sessions N           sessions per org (default 2: a user VU and a live VU)
  --warmup 60s --between 30s --cooldown 60s --deploy-grace 30s
  --duration <d>         with --deploys 0: how long the traffic runs
  --turn-interval 8      seconds between one user's turns (the per-person turn rate is 10/min)
  --ws-hold 60           seconds a live socket is held before it reconnects on its own
  --page-path /          the page each user loads (the box's web shell)

Launch scenario (synthetic visitors through the warm pool):
  --launch
  --levels 300,1000      active workspaces to hold, one stage per level
  --ramp 5m --hold 10m   time to reach each level, time held at it
  --arrival-rate R       visitors per minute instead of levels (ramped over --ramp, held --hold)
  --walk 300s            how long each visitor browses and runs turns
  --max-vus N            ceiling of concurrent visitors for --arrival-rate (default 2000)
  --needs support,sales  the visitor's picks (default support)
  --deploys N            deploys during the launch run too (after --warmup, every --between)

Counters and output:
  --edge-log <path> | --edge-log-cmd "<sh>"   the edge's JSON access log (edge 5xx)
  --app-log-cmd "<sh>"                        the app's JSON log (effect_duplicate lines)
  --out <dir>            report.json, summary.txt, orgs.json (default: a temp dir)
  --keep-raw             keep k6's raw JSON output
  --k6 <bin>             the k6 binary (default k6)
  --deploy-timeout 30m   one deploy command is killed after this (it counts as a failed deploy)
  --log-timeout 5m       a log command (edge / app) is killed after this (that counter fails)
  --fetch-timeout 30s    one signed request to the box is abandoned after this
  --k6-grace 2m          k6 gets this long to stop after the driver asks, then SIGKILL

The exit code is 0 only when every requested counter was measured and is 0: a counter
that was not measured, a failed sink read, k6 exiting non-zero or early, fewer deploys
than asked, an empty log source, a 401, a 429 or a signup / verify error exits 1.`

export function parseDriverArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): DriverConfig {
  const flags = new Map<string, string>()
  const bools = new Set<string>()
  const BOOL = new Set(["launch", "keep-raw"])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`)
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    if (BOOL.has(name)) {
      bools.add(name)
      continue
    }
    const value = inline ?? argv[++i]
    if (value === undefined) throw new Error(`--${name} needs a value`)
    flags.set(name, value)
  }
  const KNOWN = new Set([
    "deploys",
    "deploy-cmd",
    "orgs",
    "orgs-file",
    "prefix",
    "seed",
    "sessions",
    "needs",
    "warmup",
    "between",
    "cooldown",
    "deploy-grace",
    "duration",
    "turn-interval",
    "ws-hold",
    "levels",
    "ramp",
    "hold",
    "arrival-rate",
    "walk",
    "max-vus",
    "edge-log",
    "edge-log-cmd",
    "app-log-cmd",
    "out",
    "k6",
    "box",
    "target",
    "page-path",
    "deploy-timeout",
    "log-timeout",
    "fetch-timeout",
    "k6-grace",
  ])
  for (const name of flags.keys()) if (!KNOWN.has(name)) throw new Error(`unknown flag --${name}`)
  const int = (name: string, dflt: number): number => {
    const v = flags.get(name)
    if (v === undefined) return dflt
    if (!/^\d+$/.test(v)) throw new Error(`--${name} must be a whole number`)
    return Number(v)
  }
  const dur = (name: string, dflt: string): number => parseDuration(flags.get(name) ?? dflt)
  const mode = bools.has("launch") ? "launch" : "deploys"
  const box = flags.get("box") ?? env.LOAD_BOX_URL
  if (!box || !/^https?:\/\//.test(box))
    throw new Error("--box <http(s) url> (or LOAD_BOX_URL) is required")
  const key = env.LOAD_HARNESS_KEY ?? ""
  if (key.length < 32)
    throw new Error("LOAD_HARNESS_KEY (the box's key, at least 32 characters) is required")
  const deploys = int("deploys", 0)
  const deployCmd = flags.get("deploy-cmd") ?? env.LOAD_DEPLOY_CMD ?? null
  if (deploys > 0 && !deployCmd)
    throw new Error("--deploys needs --deploy-cmd (or LOAD_DEPLOY_CMD)")
  const levels = (flags.get("levels") ?? "10")
    .split(",")
    .filter(Boolean)
    .map((v) => {
      if (!/^\d+$/.test(v)) throw new Error("--levels is a comma list of whole numbers")
      return Number(v)
    })
  const arrival = flags.get("arrival-rate")
  if (arrival !== undefined && !/^\d+(\.\d+)?$/.test(arrival))
    throw new Error("--arrival-rate is visitors per minute")
  const durationFlag = flags.get("duration")
  if (mode === "deploys" && deploys === 0 && !durationFlag) {
    throw new Error("--deploys 0 needs --duration (how long the traffic runs)")
  }
  return {
    mode,
    box: box.replace(/\/$/, ""),
    key,
    orgs: int("orgs", 1),
    orgsFile: flags.get("orgs-file") ?? null,
    prefix: flags.get("prefix") ?? "load-",
    seed: flags.get("seed") ?? `${Date.now()}`,
    sessions: Math.max(1, int("sessions", 2)),
    needs: (flags.get("needs") ?? "support").split(",").filter(Boolean),
    deploys,
    deployCmd,
    warmupMs: dur("warmup", "60s"),
    betweenMs: dur("between", "30s"),
    cooldownMs: dur("cooldown", "60s"),
    deployGraceMs: dur("deploy-grace", "30s"),
    durationMs: durationFlag ? parseDuration(durationFlag) : null,
    turnIntervalS: int("turn-interval", 8),
    wsHoldS: int("ws-hold", 60),
    pagePath: flags.get("page-path") ?? "/",
    levels,
    rampMs: dur("ramp", "5m"),
    holdMs: dur("hold", "10m"),
    arrivalPerMin: arrival === undefined ? null : Number(arrival),
    walkS: Math.round(dur("walk", "300s") / 1000),
    maxVus: int("max-vus", 2000),
    edgeLog: flags.get("edge-log") ?? null,
    edgeLogCmd: flags.get("edge-log-cmd") ?? null,
    appLogCmd: flags.get("app-log-cmd") ?? null,
    out: resolve(flags.get("out") ?? join(env.TMPDIR ?? tmpdir(), `liaison-load-${Date.now()}`)),
    keepRaw: bools.has("keep-raw"),
    k6: flags.get("k6") ?? "k6",
    deployTimeoutMs: dur("deploy-timeout", "30m"),
    logTimeoutMs: dur("log-timeout", "5m"),
    fetchTimeoutMs: dur("fetch-timeout", "30s"),
    k6GraceMs: dur("k6-grace", "2m"),
  }
}

const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`

/** The k6 stages of the launch scenario: per level, ramp to it then hold; then ramp down. */
export function launchStages(
  cfg: Pick<DriverConfig, "levels" | "rampMs" | "holdMs" | "arrivalPerMin">,
) {
  if (cfg.arrivalPerMin !== null) {
    return [
      { target: cfg.arrivalPerMin, duration: secs(cfg.rampMs) },
      { target: cfg.arrivalPerMin, duration: secs(cfg.holdMs) },
    ]
  }
  const stages: Array<{ target: number; duration: string }> = []
  for (const level of cfg.levels) {
    stages.push({ target: level, duration: secs(cfg.rampMs) })
    stages.push({ target: level, duration: secs(cfg.holdMs) })
  }
  stages.push({ target: 0, duration: secs(cfg.rampMs) })
  return stages
}

/** The environment k6 runs with (the key never goes on a command line). */
export function k6Env(cfg: DriverConfig, files: { orgs: string | null; summary: string }) {
  const env: Record<string, string> = {
    HOST: cfg.box,
    LOAD_MODE: cfg.mode,
    LOAD_HARNESS_KEY: cfg.key,
    LOAD_REPLIES: JSON.stringify(LOAD_SCRIPT_REPLIES),
    LOAD_FALLBACK: SCRIPTED_FALLBACK_REPLY,
    TURN_INTERVAL_S: String(cfg.turnIntervalS),
    WS_HOLD_S: String(cfg.wsHoldS),
    PAGE_PATH: cfg.pagePath,
    WALK_S: String(cfg.walkS),
    LAUNCH_NEEDS: JSON.stringify(cfg.needs),
    K6_SUMMARY_FILE: files.summary,
  }
  if (cfg.mode === "deploys") {
    env.LOAD_ORGS_FILE = files.orgs ?? ""
    // The driver stops k6 once the deploys and the cooldown are done.
    env.LOAD_DURATION = cfg.durationMs ? secs(cfg.durationMs) : "24h"
  } else if (cfg.arrivalPerMin !== null) {
    env.LAUNCH_ARRIVAL = JSON.stringify({
      timeUnit: "1m",
      preAllocatedVUs: Math.min(cfg.maxVus, Math.ceil(cfg.arrivalPerMin * (cfg.walkS / 60 + 1))),
      maxVUs: cfg.maxVus,
      stages: launchStages(cfg),
    })
  } else {
    env.LAUNCH_STAGES = JSON.stringify(launchStages(cfg))
  }
  return env
}

// ── Reading the run ─────────────────────────────────────────────────────────

export interface DeployWindow {
  index: number
  start: number
  end: number
  exitCode: number
}

export interface Stats {
  count: number
  p50: number | null
  p95: number | null
  max: number | null
}

export function stats(values: number[]): Stats {
  if (values.length === 0) return { count: 0, p50: null, p95: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
  const round = (v: number) => Math.round(v * 10) / 10
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1)!),
  }
}

interface Split {
  during: number[]
  outside: number[]
}

/** Everything the k6 points say, folded. */
export class RunFold {
  readonly http: Split = { during: [], outside: [] }
  readonly turns: Split = { during: [], outside: [] }
  readonly wsGaps: Split = { during: [], outside: [] }
  readonly perDeploy = new Map<number, { httpMax: number; turnMax: number }>()
  readonly errorsByType: Record<string, number> = {}
  readonly turnVerdicts: Record<string, number> = {}
  turnsFollowedRestart = 0
  readonly wsServerCloses: Record<string, number> = {}
  readonly signupsByStatus: Record<string, number> = {}
  readonly ttw: { all: number[]; pooled: number[]; fresh: number[] } = {
    all: [],
    pooled: [],
    fresh: [],
  }
  poolHits = 0
  poolTotal = 0
  readonly launchOrgs = new Set<string>()

  constructor(
    private readonly windows: DeployWindow[],
    private readonly graceMs: number,
  ) {}

  private windowOf(t: number): DeployWindow | undefined {
    return this.windows.find((w) => t >= w.start && t <= w.end + this.graceMs)
  }

  private split(target: Split, t: number, v: number, field?: "httpMax" | "turnMax"): void {
    const w = this.windowOf(t)
    if (!w) {
      target.outside.push(v)
      return
    }
    target.during.push(v)
    if (field) {
      const d = this.perDeploy.get(w.index) ?? { httpMax: 0, turnMax: 0 }
      d[field] = Math.max(d[field], v)
      this.perDeploy.set(w.index, d)
    }
  }

  private bump(rec: Record<string, number>, key: string, by = 1): void {
    rec[key] = (rec[key] ?? 0) + by
  }

  /** One line of k6's `--out json` output. */
  add(line: string): void {
    if (!line.startsWith('{"metric"') && !line.includes('"type":"Point"')) return
    let p: {
      type?: string
      metric?: string
      data?: { time?: string; value?: number; tags?: Record<string, string> }
    }
    try {
      p = JSON.parse(line)
    } catch {
      return
    }
    if (p.type !== "Point" || !p.data || typeof p.data.value !== "number") return
    const t = Date.parse(p.data.time ?? "")
    const v = p.data.value
    const tags = p.data.tags ?? {}
    switch (p.metric) {
      case "http_req_duration": {
        this.split(this.http, t, v, "httpMax")
        const status = Number(tags.status ?? 0)
        if (status === 0) this.bump(this.errorsByType, "http_network")
        else if (status >= 500) this.bump(this.errorsByType, "http_5xx")
        else if (status === 401) this.bump(this.errorsByType, "http_401")
        else if (status === 429) this.bump(this.errorsByType, "http_429")
        break
      }
      case "load_turn_ms":
        this.split(this.turns, t, v, "turnMax")
        break
      case "load_turn_result":
        this.bump(this.turnVerdicts, tags.verdict ?? "unknown", v)
        if (tags.followed === "yes") this.turnsFollowedRestart += v
        break
      case "load_ws_gap_ms":
        this.split(this.wsGaps, t, v)
        break
      case "load_ws_server_close":
        this.bump(this.wsServerCloses, tags.code ?? "?", v)
        break
      case "load_errors":
        this.bump(
          this.errorsByType,
          tags.status ? `${tags.type}_${tags.status}` : (tags.type ?? "unknown"),
          v,
        )
        break
      case "load_signup_result":
        this.bump(this.signupsByStatus, tags.status ?? "?", v)
        break
      case "load_signup_preparing":
        // A 202 "being prepared" a start got on a busy box before its final answer.
        this.bump(this.signupsByStatus, "202_preparing", v)
        break
      case "load_time_to_workspace_ms":
        this.ttw.all.push(v)
        ;(tags.pooled === "yes" ? this.ttw.pooled : this.ttw.fresh).push(v)
        if (tags.org) this.launchOrgs.add(tags.org)
        break
      case "load_pool_hit":
        this.poolTotal++
        if (v > 0) this.poolHits++
        break
    }
  }
}

export type CounterName = "edge5xx" | "cutTurns" | "effectDuplicates" | "doubledEffects"
export const COUNTER_NAMES: CounterName[] = [
  "edge5xx",
  "cutTurns",
  "effectDuplicates",
  "doubledEffects",
]

/** Why a server counter has no clean reading. */
export interface CounterDetail {
  /** Whether the run asked for this counter (a requested one that is not measured fails the run). */
  requested: boolean
  state: "not_measured" | "failed"
  reason: string
}

export interface ServerCounters {
  /** Edge access-log lines with status >= 500 in the run; null = not measured. */
  edge5xx: number | null
  /** Stored turns cut or with a wrong reply; null = not measured. */
  cutTurns: CutTurn[] | null
  /** effect_duplicate lines of the app log; null = not measured. */
  effectDuplicates: number | null
  /** Effect-sink keys of the run's load orgs counted more than once. */
  doubledEffects: number | null
  doubledEffectKeys: string[]
  /**
   * Counters that were not measured or whose read failed, with the reason. A
   * counter absent here is measured when its value is not null, and otherwise
   * not requested.
   */
  detail?: Partial<Record<CounterName, CounterDetail>>
}

/** What happened to the traffic generator and the deploy schedule. */
export interface RunOutcome {
  expectedDeploys: number
  k6Code: number
  /** k6 ended before the driver asked it to (a crash, an OOM). */
  k6Early: boolean
  /** The driver stopped k6 itself (SIGINT after the cooldown), so its exit code is not judged. */
  k6StoppedByDriver: boolean
}

export interface CounterStatus {
  status: "measured" | "not_measured" | "failed"
  requested: boolean
  reason?: string
}

/** Errors that must not happen in a run: dropped sessions, throttling, signup and verify failures. */
export function unexpectedErrors(errorsByType: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(errorsByType)) {
    if (/(^|_)(401|429)$/.test(k) || /^(signup|verify|sink_code|workspace_not_ready)/.test(k))
      out[k] = n
  }
  return out
}

export interface RunReport {
  mode: DriverConfig["mode"]
  box: string
  startedAt: string
  endedAt: string
  deploys: Array<{
    index: number
    start: string
    end: string
    durationMs: number
    exitCode: number
    httpMaxMs: number | null
    turnMaxMs: number | null
  }>
  counters: ServerCounters & {
    /** Client side: requests answered 5xx or cut (no answer). */
    client5xx: number
    clientNetworkErrors: number
    /** Client side: turns not ending in exactly their expected reply. */
    clientCutTurns: number
  }
  turns: { total: number; byVerdict: Record<string, number>; followedRestart: number }
  delays: {
    duringDeploys: { http: Stats; turn: Stats; wsReconnectGap: Stats }
    outsideDeploys: { http: Stats; turn: Stats; wsReconnectGap: Stats }
  }
  errorsByType: Record<string, number>
  wsServerCloses: Record<string, number>
  launch: {
    signupsByStatus: Record<string, number>
    poolHitRate: number | null
    timeToWorkspace: { all: Stats; pooled: Stats; fresh: Stats }
  } | null
  /** Per counter: measured, not_measured or failed, with the reason. */
  counterStatus: Record<CounterName, CounterStatus>
  run: { deploysRequested: number; deploysDone: number; k6ExitCode: number; k6Early: boolean }
  ok: boolean
  summary: string
}

const fmt = (s: Stats) =>
  s.count === 0 ? "none" : `p50 ${s.p50} ms, p95 ${s.p95} ms, max ${s.max} ms (${s.count})`

export function buildReport(input: {
  cfg: Pick<DriverConfig, "mode" | "box">
  startedAt: number
  endedAt: number
  windows: DeployWindow[]
  fold: RunFold
  server: ServerCounters
  run: RunOutcome
}): RunReport {
  const { fold, server, windows } = input
  const total = Object.values(fold.turnVerdicts).reduce((a, b) => a + b, 0)
  const clientCutTurns = total - (fold.turnVerdicts.ok ?? 0)
  const client5xx = fold.errorsByType.http_5xx ?? 0
  const clientNetworkErrors = fold.errorsByType.http_network ?? 0
  const failedDeploys = windows.filter((w) => w.exitCode !== 0).length
  const measured: Array<[string, number]> = [
    ["edge 5xx (client)", client5xx],
    ["cut requests (client)", clientNetworkErrors],
    ["cut turns (client)", clientCutTurns],
  ]
  if (server.edge5xx !== null) measured.push(["edge 5xx (edge log)", server.edge5xx])
  if (server.cutTurns !== null) measured.push(["cut turns (stored)", server.cutTurns.length])
  if (server.effectDuplicates !== null)
    measured.push(["duplicate effects (ledger)", server.effectDuplicates])
  if (server.doubledEffects !== null)
    measured.push(["doubled effects (sink)", server.doubledEffects])
  measured.push(["failed deploys", failedDeploys])
  measured.push(["deploys not run", Math.max(0, input.run.expectedDeploys - windows.length)])
  const k6Clean = !input.run.k6Early && (input.run.k6StoppedByDriver || input.run.k6Code === 0)
  measured.push(["abnormal k6 exits", k6Clean ? 0 : 1])
  const unexpected = unexpectedErrors(fold.errorsByType)
  measured.push([
    "unexpected errors (401, 429, signup, verify)",
    Object.values(unexpected).reduce((a, b) => a + b, 0),
  ])
  const values: Record<CounterName, boolean> = {
    edge5xx: server.edge5xx !== null,
    cutTurns: server.cutTurns !== null,
    effectDuplicates: server.effectDuplicates !== null,
    doubledEffects: server.doubledEffects !== null,
  }
  const counterStatus = {} as Record<CounterName, CounterStatus>
  for (const name of COUNTER_NAMES) {
    const d = server.detail?.[name]
    if (d) counterStatus[name] = { status: d.state, requested: d.requested, reason: d.reason }
    else if (values[name]) counterStatus[name] = { status: "measured", requested: true }
    else counterStatus[name] = { status: "not_measured", requested: false, reason: "not requested" }
  }
  const unmeasuredRequested = COUNTER_NAMES.filter(
    (n) =>
      counterStatus[n].status === "failed" ||
      (counterStatus[n].requested && counterStatus[n].status !== "measured"),
  )
  const ok = total > 0 && unmeasuredRequested.length === 0 && measured.every(([, n]) => n === 0)
  const during = {
    http: stats(fold.http.during),
    turn: stats(fold.turns.during),
    wsReconnectGap: stats(fold.wsGaps.during),
  }
  const outside = {
    http: stats(fold.http.outside),
    turn: stats(fold.turns.outside),
    wsReconnectGap: stats(fold.wsGaps.outside),
  }
  const launch =
    input.cfg.mode === "launch"
      ? {
          signupsByStatus: fold.signupsByStatus,
          poolHitRate:
            fold.poolTotal === 0
              ? null
              : Math.round((fold.poolHits / fold.poolTotal) * 1000) / 1000,
          timeToWorkspace: {
            all: stats(fold.ttw.all),
            pooled: stats(fold.ttw.pooled),
            fresh: stats(fold.ttw.fresh),
          },
        }
      : null
  const errors = Object.entries(fold.errorsByType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
  const lines = [
    `${input.cfg.mode === "launch" ? "Launch run" : "Deploys under load"} on ${input.cfg.box}: ${windows.length} deploy(s), ${total} scripted turns (${fold.turnVerdicts.ok ?? 0} exact, ${fold.turnsFollowedRestart} followed a restart).`,
    `Counters: ${measured.map(([k, n]) => `${n} ${k}`).join(", ")}.`,
    `Delay during deploys: requests ${fmt(during.http)}; turns ${fmt(during.turn)}; socket reconnect ${fmt(during.wsReconnectGap)}.`,
    `Outside deploys: requests ${fmt(outside.http)}; turns ${fmt(outside.turn)}.`,
    `Errors by type: ${errors.length ? errors.join(", ") : "none"}.`,
  ]
  if (launch) {
    lines.push(
      `Launch: warm-pool hit rate ${launch.poolHitRate === null ? "n/a" : `${Math.round(launch.poolHitRate * 100)}%`}; time to workspace ${fmt(launch.timeToWorkspace.all)} (pooled ${fmt(launch.timeToWorkspace.pooled)}; fresh ${fmt(launch.timeToWorkspace.fresh)}); signups ${JSON.stringify(launch.signupsByStatus)}.`,
    )
  }
  for (const name of COUNTER_NAMES) {
    const c = counterStatus[name]
    if (c.status === "not_measured") lines.push(`NOT MEASURED: ${name} (${c.reason})`)
    else if (c.status === "failed") lines.push(`FAILED: ${name} (${c.reason})`)
  }
  lines.push(
    ok
      ? "Verdict: the deploys only delayed work."
      : "Verdict: work was stopped, cut or doubled (see the counters).",
  )
  return {
    mode: input.cfg.mode,
    box: input.cfg.box,
    startedAt: new Date(input.startedAt).toISOString(),
    endedAt: new Date(input.endedAt).toISOString(),
    deploys: windows.map((w) => {
      const d = fold.perDeploy.get(w.index)
      return {
        index: w.index,
        start: new Date(w.start).toISOString(),
        end: new Date(w.end).toISOString(),
        durationMs: w.end - w.start,
        exitCode: w.exitCode,
        httpMaxMs: d ? Math.round(d.httpMax) : null,
        turnMaxMs: d ? Math.round(d.turnMax) : null,
      }
    }),
    counters: { ...server, client5xx, clientNetworkErrors, clientCutTurns },
    turns: { total, byVerdict: fold.turnVerdicts, followedRestart: fold.turnsFollowedRestart },
    delays: { duringDeploys: during, outsideDeploys: outside },
    errorsByType: fold.errorsByType,
    wsServerCloses: fold.wsServerCloses,
    launch,
    counterStatus,
    run: {
      deploysRequested: input.run.expectedDeploys,
      deploysDone: windows.length,
      k6ExitCode: input.run.k6Code,
      k6Early: input.run.k6Early,
    },
    ok,
    summary: lines.join("\n"),
  }
}

/** Sink keys counted more than once since `sinceMs`, as `org|kind|key`. */
export function doubledSinkKeys(
  perOrg: Array<{
    orgId: string
    effects: Array<{ kind: string; key: string; count: number; lastAt: number }>
  }>,
  sinceMs: number,
): string[] {
  const out: string[] = []
  for (const { orgId, effects } of perOrg) {
    for (const e of effects)
      if (e.count > 1 && e.lastAt >= sinceMs) out.push(`${orgId}|${e.kind}|${e.key}`)
  }
  return out
}

// ── The run ─────────────────────────────────────────────────────────────────

/** The environment a command the driver runs gets: ours, without the box's key. */
function commandEnv(): NodeJS.ProcessEnv {
  const { LOAD_HARNESS_KEY: _key, ...rest } = process.env
  return rest
}

function runBash(
  cmd: string,
  stdout: number | "pipe",
  stderr: number | "inherit",
  timeoutMs: number,
): Promise<{ code: number; timedOut: boolean; out: Buffer }> {
  return new Promise((done) => {
    const child = spawn("bash", ["-c", cmd], {
      stdio: ["ignore", stdout, stderr],
      env: commandEnv(),
      detached: true,
    })
    const chunks: Buffer[] = []
    child.stdout?.on("data", (c: Buffer) => chunks.push(c))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // The whole process group: a deploy script's children die with it.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, timeoutMs)
    child.on("error", () => {
      clearTimeout(timer)
      done({ code: 127, timedOut, out: Buffer.concat(chunks) })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      done({ code: timedOut ? 124 : (code ?? 1), timedOut, out: Buffer.concat(chunks) })
    })
  })
}

/**
 * Run a shell command with ALL its output (stdout and stderr, of every part
 * of a compound command) appended to `logFile`. Killed after `timeoutMs`
 * (exit code 124). The box's key is not in its environment.
 */
export async function sh(cmd: string, logFile: string, timeoutMs: number): Promise<number> {
  const fd = openSync(logFile, "a", 0o600)
  try {
    return (await runBash(cmd, fd, fd, timeoutMs)).code
  } finally {
    closeSync(fd)
  }
}

/** Run a shell command and return its stdout; rejects on a non-zero exit or after `timeoutMs`. */
export async function shCapture(cmd: string, timeoutMs: number): Promise<string> {
  const r = await runBash(cmd, "pipe", "inherit", timeoutMs)
  if (r.timedOut) throw new Error(`\`${cmd}\` timed out after ${Math.round(timeoutMs / 1000)} s`)
  if (r.code !== 0) throw new Error(`\`${cmd}\` exited ${r.code}`)
  return r.out.toString("utf8")
}

/** Write a file that holds secrets: mode 600 whether or not it existed (and whatever its old mode). */
export function writePrivateFile(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/**
 * Make the output directory. Only a directory the driver created is
 * restricted (700); one that was already there (`.`, `~`, `/tmp`) keeps its mode.
 */
export function prepareOut(dir: string): void {
  const existed = existsSync(dir)
  mkdirSync(dir, { recursive: true })
  if (!existed) chmodSync(dir, 0o700)
}

/** The read of one log source: its counter, or why it has none. */
export interface LogCounter {
  value: number | null
  detail?: CounterDetail
}

/** Read a log source and count it; a failed read, or a source with no usable line, is not a 0. */
export async function measureLog(
  requested: boolean,
  what: string,
  read: () => Promise<string>,
  count: (lines: string[]) => number | null,
): Promise<LogCounter> {
  if (!requested) return { value: null }
  try {
    const value = count((await read()).split("\n"))
    if (value === null) {
      return {
        value: null,
        detail: {
          requested,
          state: "not_measured",
          reason: `${what} had no line of the expected format inside the run's window`,
        },
      }
    }
    return { value }
  } catch (err) {
    return {
      value: null,
      detail: { requested, state: "failed", reason: `${what}: ${(err as Error).message}` },
    }
  }
}

/**
 * The effect sink of every load org the run used, read back signed. A failed
 * read never throws away the doubles the other reads found: they are counted,
 * and the counter is marked failed.
 */
export async function readSinks(
  client: Pick<HarnessClient, "sink">,
  orgIds: string[],
  sinceMs: number,
  log: (line: string) => void = () => undefined,
): Promise<LogCounter & { keys: string[] }> {
  const perOrg: Array<{
    orgId: string
    effects: Awaited<ReturnType<HarnessClient["sink"]>>["effects"]
  }> = []
  const failures: string[] = []
  for (const orgId of orgIds) {
    try {
      perOrg.push({ orgId, effects: (await client.sink(orgId)).effects })
    } catch (err) {
      failures.push((err as Error).message)
      log(`sink read failed: ${(err as Error).message}`)
    }
  }
  const keys = doubledSinkKeys(perOrg, sinceMs)
  if (orgIds.length === 0) {
    return {
      value: null,
      keys,
      detail: { requested: true, state: "not_measured", reason: "the run used no load org" },
    }
  }
  const value = perOrg.length > 0 ? keys.length : null
  if (failures.length > 0) {
    return {
      value,
      keys,
      detail: {
        requested: true,
        state: "failed",
        reason: `${failures.length} of ${orgIds.length} sink reads failed (${failures[0]})`,
      },
    }
  }
  return { value, keys }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runDeployUnderLoad(argv: string[]): Promise<number> {
  if (argv.includes("--help")) {
    console.log(DRIVER_USAGE)
    return 0
  }
  let cfg: DriverConfig
  try {
    cfg = parseDriverArgs(argv, process.env)
  } catch (err) {
    console.error(`load-test: ${(err as Error).message}\n\n${DRIVER_USAGE}`)
    return 2
  }
  prepareOut(cfg.out)
  const log = (line: string) => console.log(`→ ${line}`)
  const client = new HarnessClient(cfg.box, cfg.key, fetch, cfg.fetchTimeoutMs)

  let orgs: LoadOrg[] = []
  let orgsFile: string | null = null
  if (cfg.mode === "deploys") {
    if (cfg.orgsFile) {
      orgsFile = resolve(cfg.orgsFile)
      orgs = (JSON.parse(readFileSync(orgsFile, "utf8")) as { orgs: LoadOrg[] }).orgs
      log(`${orgs.length} load org(s) from ${orgsFile}`)
    } else {
      log(`seeding ${cfg.orgs} load org(s) on ${cfg.box}`)
      orgs = await seedLoadOrgs(client, {
        orgs: cfg.orgs,
        prefix: cfg.prefix,
        seed: cfg.seed,
        sessions: cfg.sessions,
        needs: cfg.needs,
        log,
      })
      orgsFile = join(cfg.out, "orgs.json")
      writePrivateFile(orgsFile, JSON.stringify({ box: cfg.box, seed: cfg.seed, orgs }, null, 2))
    }
  }

  const raw = join(cfg.out, "k6-points.json")
  const summaryFile = join(cfg.out, "k6-summary.json")
  const scriptPath = resolve(
    new URL("../../qa/load/a9-deploy-under-load.js", import.meta.url).pathname,
  )
  const startedAt = Date.now()
  log(`k6 ${cfg.mode} traffic → ${cfg.box}`)
  const k6 = spawn(cfg.k6, ["run", "--quiet", "--no-color", `--out=json=${raw}`, scriptPath], {
    env: { ...process.env, ...k6Env(cfg, { orgs: orgsFile, summary: summaryFile }) },
    stdio: ["ignore", "ignore", "inherit"],
  })
  const k6Done = new Promise<number>((done) => {
    k6.on("exit", (code) => done(code ?? 1))
    k6.on("error", () => done(127))
  })
  let k6Exited = false
  void k6Done.then(() => (k6Exited = true))

  const windows: DeployWindow[] = []
  const deployLog = join(cfg.out, "deploys.log")
  await sleep(cfg.warmupMs)
  for (let i = 1; i <= cfg.deploys && !k6Exited; i++) {
    const start = Date.now()
    log(`deploy ${i}/${cfg.deploys}`)
    writeFileSync(deployLog, `\n=== deploy ${i} ${new Date(start).toISOString()}\n`, {
      flag: "a",
      mode: 0o600,
    })
    const exitCode = await sh(cfg.deployCmd!, deployLog, cfg.deployTimeoutMs)
    const end = Date.now()
    windows.push({ index: i, start, end, exitCode })
    log(
      `deploy ${i} ${exitCode === 0 ? "done" : exitCode === 124 ? "TIMED OUT" : `FAILED (${exitCode})`} in ${Math.round((end - start) / 1000)} s`,
    )
    if (i < cfg.deploys) await sleep(cfg.betweenMs)
  }
  let k6StoppedByDriver = false
  let k6Early = false
  if (cfg.mode === "deploys" && cfg.deploys > 0) {
    await sleep(cfg.cooldownMs)
    k6Early = k6Exited
    if (!k6Exited) {
      k6StoppedByDriver = true
      k6.kill("SIGINT")
      const stopped = await Promise.race([
        k6Done.then(() => true),
        sleep(cfg.k6GraceMs).then(() => false),
      ])
      if (!stopped) {
        log(`k6 did not stop within ${Math.round(cfg.k6GraceMs / 1000)} s, killing it`)
        k6.kill("SIGKILL")
      }
    }
  }
  const k6Code = await k6Done
  const endedAt = Date.now()
  log(`k6 ended (${k6Code})`)

  const fold = new RunFold(windows, cfg.deployGraceMs)
  if (existsSync(raw)) {
    const rl = createInterface({
      input: createReadStream(raw),
      crlfDelay: Number.POSITIVE_INFINITY,
    })
    for await (const line of rl) fold.add(line)
  }

  const orgIds = cfg.mode === "deploys" ? orgs.map((o) => o.orgId) : [...fold.launchOrgs]
  const sink = await readSinks(client, orgIds, startedAt, log)

  const window = { start: startedAt, end: endedAt }
  const edge = await measureLog(
    cfg.edgeLog !== null || cfg.edgeLogCmd !== null,
    "the edge log",
    async () =>
      cfg.edgeLog
        ? readFileSync(cfg.edgeLog, "utf8")
        : shCapture(cfg.edgeLogCmd!, cfg.logTimeoutMs),
    (lines) => edge5xxMeasured(lines, window),
  )
  const app = await measureLog(
    cfg.appLogCmd !== null,
    "the app log",
    () => shCapture(cfg.appLogCmd!, cfg.logTimeoutMs),
    (lines) => effectDuplicatesMeasured(lines, window),
  )
  let cut: CutTurn[] | null = null
  let cutDetail: CounterDetail | undefined
  if (process.env.DEPLOY_COUNTERS_DB_URL) {
    const sql = postgres(process.env.DEPLOY_COUNTERS_DB_URL, { max: 1 })
    try {
      const rows = await readTurns(sql, window)
      if (rows.length === 0) {
        cutDetail = {
          requested: true,
          state: "not_measured",
          reason: "no stored turn started inside the run's window",
        }
      } else {
        cut = cutTurnsWithLoadReplies(rows, Date.now())
      }
    } catch (err) {
      cutDetail = {
        requested: true,
        state: "failed",
        reason: `stored turns: ${(err as Error).message}`,
      }
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  const detail: ServerCounters["detail"] = {}
  if (edge.detail) detail.edge5xx = edge.detail
  if (app.detail) detail.effectDuplicates = app.detail
  if (cutDetail) detail.cutTurns = cutDetail
  if (sink.detail) detail.doubledEffects = sink.detail
  const report = buildReport({
    cfg,
    startedAt,
    endedAt,
    windows,
    fold,
    server: {
      edge5xx: edge.value,
      cutTurns: cut,
      effectDuplicates: app.value,
      doubledEffects: sink.value,
      doubledEffectKeys: sink.keys,
      detail,
    },
    run: { expectedDeploys: cfg.deploys, k6Code, k6Early, k6StoppedByDriver },
  })
  writePrivateFile(join(cfg.out, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
  writePrivateFile(join(cfg.out, "summary.txt"), `${report.summary}\n`)
  if (!cfg.keepRaw && existsSync(raw)) Bun.spawnSync(["rm", "-f", raw])
  console.log(`\n${report.summary}\n\nreport: ${join(cfg.out, "report.json")}`)
  return report.ok ? 0 : 1
}
