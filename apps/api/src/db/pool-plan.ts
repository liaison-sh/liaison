// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE POOL PLAN. Every process opens up to five Postgres pools (connection.ts):
 * main, request, privileged, jobs and privileged-jobs. Their sizes come from
 * one connection budget (DB_CELL_MAX_CONNECTIONS, the connections Liaison may
 * open on its database endpoint) and the process's role, so the whole topology
 * (every api and worker replica, two releases side by side during a rolling
 * deploy, the migrate one-shot and a reserve) fits the endpoint.
 *
 * Pure: no env, no imports from the job code. connection.ts feeds it the
 * env at import and sizes every pool from the result; the boot (index.ts)
 * refuses when one release's pools overflow the budget and warns when two
 * releases side by side would. Operator page: docs/self-hosting/pools.md.
 *
 * Without a budget the sizes are the legacy env resolution (DB_POOL_MAX and
 * friends, else 20), exactly what every release before the plan opened.
 */

export type PoolName = "main" | "request" | "privileged" | "jobs" | "privilegedJobs"

export const POOL_NAMES: readonly PoolName[] = [
  "main",
  "request",
  "privileged",
  "jobs",
  "privilegedJobs",
]

/** Where a pool's size came from. */
export type PoolSource = "planned" | "override" | "legacy"

/**
 * The shape a process plans for. `cli` (LIAISON_CLI=1) and `oneshot`
 * (LIAISON_ONESHOT=1: migrate, the catalog reconcile) sit outside the
 * topology: 2 connections per pool, never refused.
 */
export type PlanRole = "all" | "api" | "worker" | "cli" | "oneshot"

/** Connections the migrate one-shot opens: its pools (2 each) plus migrate.ts's own direct connections and the lease fence. */
export const MIGRATE_FOOTPRINT = 13
/** Connections kept outside the plan by default: superuser slots, psql, monitoring. */
export const DEFAULT_CELL_RESERVED = 15
/** The api's privileged pool never plans below this (one conversation view with its customer card bursts to it). */
export const API_PRIVILEGED_FLOOR = 10
/**
 * Orgs a process sets up in memory at once (a burst of first touches after a
 * deploy). A set-up org's registration holds at most one privileged connection
 * at a time, for one short statement (no per-app schema transaction once the
 * process saw the schema current), so the burst takes at most half the
 * privileged pool, leaving the rest to the auth checks and card loads beside
 * it; never more than 8, never fewer than 1. Half, not less: the first-touch
 * bound (p95 2 s for 50 orgs touched at once) needs the width.
 */
export function memoryRegistrationConcurrency(privilegedPoolSize: number): number {
  return Math.max(1, Math.min(8, Math.floor(privilegedPoolSize / 2)))
}
/** Jobs-pool connections kept for session-mode jobs (one short transaction per call) beside the pinned holders. */
export const JOBS_SESSION_RESERVE = 2
/**
 * App event handlers an api process runs at once. They run in the publishing
 * process (delivery "once"), usually an api, and each holds a jobs connection
 * for its whole run behind the pinned-jobs gate.
 */
export const API_EVENT_HANDLER_SLOTS = 2
/** Jobs-pool connections an api keeps beside its event handlers: inbound webhooks, token refreshes (short transactions). */
export const API_JOBS_RESERVE = 1
/**
 * Pinned jobs-pool holders the catalog can start at once on one worker: Σ over
 * catalog queues that declare atomic jobs or event subscriptions of
 * min(5, concurrency). A constant because the pools are sized at import,
 * before the catalog can be read; infra/jobs/pinned-jobs-gate.test.ts
 * recomputes it from the manifests and fails when the catalog changes it.
 */
export const PINNED_JOBS_WANTED = 15
/** Kernel slots on top of which the privileged pool keeps room for nested reads (queue-classes.ts). */
const PRIVILEGED_HEADROOM = 4
/** Pool size of a `cli` or `oneshot` process. */
const FIXED_POOL_SIZE = 2
/** Size every pool takes with neither a budget nor an env value (the pre-plan default). */
const LEGACY_DEFAULT = 20
/** The main pool's slots once the request login has its own pool. */
const MAIN_WHEN_SPLIT = 5
/** Useful maxima of the api's surplus: request and privileged. */
const API_REQUEST_MAX = 25
const API_PRIVILEGED_MAX = 20
/** Maxima of a single `all` process (the single-app defaults). */
const ALL_REQUEST_MAX = 25
const ALL_PRIVILEGED_MAX = 15
const ALL_JOBS_MAX = 30

/** What the kernel queue classes want: every slot (classes + legacy drain), and agent + cron + webhook. */
export interface KernelNeed {
  total: number
  requestSlots: number
}

/** The default kernel classes: cron 2 + agent 4 + media 2 + bulk 1 + webhook 1 + legacy drain 1; agent + cron + webhook 7. */
export const DEFAULT_KERNEL_NEED: KernelNeed = { total: 11, requestSlots: 7 }

/** Env pool sizes an operator set (DB_POOL_MAX, DB_PRIVILEGED_POOL_MAX, DB_JOBS_POOL_MAX, DB_PRIVILEGED_JOBS_POOL_MAX). */
export interface PoolOverrides {
  pool?: number
  privileged?: number
  jobs?: number
  privilegedJobs?: number
}

export interface PlanInput {
  role: PlanRole
  /** DATABASE_REQUEST_PASSWORD is set: request and jobs RLS work log in as their own login, two more pools. */
  split: boolean
  /** DB_CELL_MAX_CONNECTIONS; undefined = legacy sizes. */
  cellMax?: number
  /** DB_CELL_RESERVED; default DEFAULT_CELL_RESERVED. */
  reserved?: number
  apiReplicas?: number
  workerReplicas?: number
  overrides: PoolOverrides
  kernel: KernelNeed
  /** DB_CELL_STRICT: an overlap overflow refuses too. */
  strict?: boolean
}

export type PlanVerdict = "ok" | "warn" | "refuse"

export interface PoolPlan {
  mode: "planned" | "legacy" | "fixed"
  role: PlanRole
  split: boolean
  /** All five, by name. Unsplit, request = main and privilegedJobs = jobs (the same pools). */
  pools: Record<PoolName, number>
  source: Record<PoolName, PoolSource>
  /** The distinct pools this process opens. */
  physical: PoolName[]
  /** Connections this process may open (Σ physical). */
  perProcess: number
  /** Pinned jobs-pool holders admitted at once (infra/jobs/pinned-jobs-gate.ts). */
  pinnedJobSlots: number
  /** Per-login connections of this process: what a pooler's per-login pool_size must cover. */
  logins: { request: number; privileged: number }
  topology: { api: number; worker: number; all: number }
  /** One release's connections: Σ replicas × per-process. */
  steady: number
  /** Two releases side by side (rolling api/worker), one for a single `all`. */
  overlap: number
  /** Budget − reserve − migrate footprint; null without a budget. */
  available: number | null
  /** Surplus left once every pool reached its useful maximum. */
  unallocated: number
  verdict: PlanVerdict
}

type Sizes = Record<PoolName, number>

function physicalPools(split: boolean): PoolName[] {
  return split ? [...POOL_NAMES] : ["main", "privileged", "jobs"]
}

function sum(pools: Sizes, split: boolean): number {
  return physicalPools(split).reduce((n, p) => n + pools[p], 0)
}

/** Unsplit, the request pool is the main pool and privileged-jobs is jobs. */
function aliasUnsplit(pools: Sizes, split: boolean): Sizes {
  return split ? pools : { ...pools, request: pools.main, privilegedJobs: pools.jobs }
}

/** Jobs-pool connections a role keeps outside the pinned holders. */
function jobsReserve(role: PlanRole): number {
  return role === "api" ? API_JOBS_RESERVE : JOBS_SESSION_RESERVE
}

/** Unsplit, a pinned holder and its privileged twin share the one jobs pool, so each slot costs two. */
function pinnedSlots(jobs: number, split: boolean, reserve: number): number {
  const n = split ? Math.max(1, jobs - reserve) : Math.max(1, Math.floor((jobs - reserve) / 2))
  return Math.min(jobs, n)
}

function legacySizes(o: PoolOverrides, split: boolean): Sizes {
  const pool = o.pool ?? LEGACY_DEFAULT
  const jobs = o.jobs ?? pool
  return aliasUnsplit(
    {
      main: split ? Math.min(pool, MAIN_WHEN_SPLIT) : pool,
      request: pool,
      privileged: o.privileged ?? pool,
      jobs,
      privilegedJobs: o.privilegedJobs ?? jobs,
    },
    split,
  )
}

/** Floors of a planned api or worker process (M1 table). Unsplit: request is the main pool, jobs takes both jobs pools. */
function floors(role: "api" | "worker", split: boolean, kernel: KernelNeed): Sizes {
  const request = role === "api" ? 6 : kernel.requestSlots
  const privileged = role === "api" ? API_PRIVILEGED_FLOOR : kernel.total + PRIVILEGED_HEADROOM
  // The api's jobs pool fits its event handlers plus its reserve; the worker's
  // starts small and takes the surplus first (planTopology).
  const jobs =
    role === "api"
      ? (split ? API_EVENT_HANDLER_SLOTS : 2 * API_EVENT_HANDLER_SLOTS) + API_JOBS_RESERVE
      : split
        ? 3
        : 4
  return aliasUnsplit(
    { main: split ? MAIN_WHEN_SPLIT : request, request, privileged, jobs, privilegedJobs: 2 },
    split,
  )
}

/** Planned api and worker sizes (no overrides) for one release of `api` + `worker` replicas in `perRelease` connections. */
function planTopology(
  split: boolean,
  kernel: KernelNeed,
  api: number,
  worker: number,
  perRelease: number,
): { api: Sizes; worker: Sizes; unallocated: number } {
  const a = floors("api", split, kernel)
  const w = floors("worker", split, kernel)
  let surplus = perRelease - (api * sum(a, split) + worker * sum(w, split))
  if (surplus <= 0) return { api: a, worker: w, unallocated: 0 }
  if (worker > 0) {
    // 1. worker jobs, up to what the pinned holders want plus the session reserve.
    const jobsMax = split
      ? PINNED_JOBS_WANTED + JOBS_SESSION_RESERVE
      : 2 * PINNED_JOBS_WANTED + JOBS_SESSION_RESERVE
    const addJobs = Math.max(0, Math.min(jobsMax - w.jobs, Math.floor(surplus / worker)))
    w.jobs += addJobs
    surplus -= worker * addJobs
    // 2. split only: worker privileged-jobs, up to the pinned slots.
    if (split) {
      const pj = Math.max(
        0,
        Math.min(
          pinnedSlots(w.jobs, split, JOBS_SESSION_RESERVE) - w.privilegedJobs,
          Math.floor(surplus / worker),
        ),
      )
      w.privilegedJobs += pj
      surplus -= worker * pj
    }
  }
  if (api > 0) {
    // 3. each api, one unit at a time, request then privileged, up to 25 and 20.
    let units = Math.floor(surplus / api)
    let spent = 0
    let turn: "request" | "privileged" = "request"
    while (units > 0) {
      const reqRoom = a.request < API_REQUEST_MAX
      const privRoom = a.privileged < API_PRIVILEGED_MAX
      if (!reqRoom && !privRoom) break
      const pick =
        turn === "request"
          ? reqRoom
            ? "request"
            : "privileged"
          : privRoom
            ? "privileged"
            : "request"
      a[pick] += 1
      units -= 1
      spent += 1
      turn = turn === "request" ? "privileged" : "request"
    }
    surplus -= api * spent
  }
  // Unsplit, the request pool IS the main pool: its growth is the main pool's.
  const api1 = split ? a : { ...a, main: a.request }
  return { api: aliasUnsplit(api1, split), worker: aliasUnsplit(w, split), unallocated: surplus }
}

/** A single `all` process: maxima, clamped toward its floors to fit `available`. */
function planAll(
  split: boolean,
  kernel: KernelNeed,
  available: number,
): { sizes: Sizes; unallocated: number } {
  const privMax = Math.max(ALL_PRIVILEGED_MAX, kernel.total + PRIVILEGED_HEADROOM)
  const max: Sizes = aliasUnsplit(
    {
      main: split ? MAIN_WHEN_SPLIT : ALL_REQUEST_MAX,
      request: ALL_REQUEST_MAX,
      privileged: privMax,
      jobs: ALL_JOBS_MAX,
      privilegedJobs: ALL_JOBS_MAX,
    },
    split,
  )
  const s: Sizes = aliasUnsplit(
    {
      main: split ? MAIN_WHEN_SPLIT : 7,
      request: 7,
      privileged: Math.max(API_PRIVILEGED_FLOOR, kernel.total + PRIVILEGED_HEADROOM),
      jobs: split ? 3 : 4,
      privilegedJobs: 2,
    },
    split,
  )
  let surplus = available - sum(s, split)
  // Round robin over the growable pools, one unit each, until the maxima or the surplus run out.
  const order: PoolName[] = split
    ? ["request", "privileged", "jobs", "privilegedJobs"]
    : ["main", "privileged", "jobs"]
  while (surplus > 0) {
    let grew = false
    for (const p of order) {
      if (surplus > 0 && s[p] < max[p]) {
        s[p] += 1
        surplus -= 1
        grew = true
      }
    }
    if (!grew) break
  }
  return { sizes: aliasUnsplit(s, split), unallocated: Math.max(0, surplus) }
}

/** Applies the env overrides on top of planned sizes, marking each pool's source. */
function withOverrides(
  planned: Sizes,
  o: PoolOverrides,
  split: boolean,
): { pools: Sizes; source: Record<PoolName, PoolSource> } {
  const pools = { ...planned }
  const source: Record<PoolName, PoolSource> = {
    main: "planned",
    request: "planned",
    privileged: "planned",
    jobs: "planned",
    privilegedJobs: "planned",
  }
  const set = (p: PoolName, n: number | undefined) => {
    if (n === undefined) return
    pools[p] = n
    source[p] = "override"
  }
  if (split) {
    set("request", o.pool)
    if (o.pool !== undefined && o.pool < pools.main) set("main", o.pool)
  } else {
    set("main", o.pool)
  }
  set("privileged", o.privileged)
  set("jobs", o.jobs)
  set("privilegedJobs", o.privilegedJobs ?? o.jobs)
  if (!split) {
    pools.request = pools.main
    source.request = source.main
    pools.privilegedJobs = pools.jobs
    source.privilegedJobs = source.jobs
  }
  return { pools, source }
}

function loginsOf(pools: Sizes, split: boolean): { request: number; privileged: number } {
  if (!split) return { request: 0, privileged: sum(pools, split) }
  return {
    request: pools.request + pools.jobs,
    privileged: pools.main + pools.privileged + pools.privilegedJobs,
  }
}

function verdictFor(
  steady: number,
  overlap: number,
  available: number,
  strict: boolean,
): PlanVerdict {
  if (steady > available) return "refuse"
  if (overlap > available) return strict ? "refuse" : "warn"
  return "ok"
}

export function planPools(input: PlanInput): PoolPlan {
  const { role, split, overrides, kernel } = input
  const strict = input.strict === true
  if (role === "cli" || role === "oneshot") {
    const fixed: Sizes = {
      main: FIXED_POOL_SIZE,
      request: FIXED_POOL_SIZE,
      privileged: FIXED_POOL_SIZE,
      jobs: FIXED_POOL_SIZE,
      privilegedJobs: FIXED_POOL_SIZE,
    }
    const { pools, source } = withOverrides(fixed, overrides, split)
    const perProcess = sum(pools, split)
    return {
      mode: "fixed",
      role,
      split,
      pools,
      source,
      physical: physicalPools(split),
      perProcess,
      pinnedJobSlots: pinnedSlots(pools.jobs, split, jobsReserve(role)),
      logins: loginsOf(pools, split),
      topology: { api: 0, worker: 0, all: 0 },
      steady: perProcess,
      overlap: perProcess,
      available: null,
      unallocated: 0,
      verdict: "ok",
    }
  }

  const apiReplicas =
    role === "api" ? Math.max(1, input.apiReplicas ?? 2) : (input.apiReplicas ?? 2)
  const workerReplicas =
    role === "worker" ? Math.max(1, input.workerReplicas ?? 1) : (input.workerReplicas ?? 1)
  const topology =
    role === "all"
      ? { api: 0, worker: 0, all: 1 }
      : { api: apiReplicas, worker: workerReplicas, all: 0 }
  const overlapFactor = role === "all" ? 1 : 2

  let pools: Sizes
  let source: Record<PoolName, PoolSource>
  let steady: number
  let available: number | null = null
  let unallocated = 0
  let mode: PoolPlan["mode"]

  if (input.cellMax === undefined) {
    mode = "legacy"
    pools = legacySizes(overrides, split)
    source = Object.fromEntries(POOL_NAMES.map((p) => [p, "legacy"])) as Record<
      PoolName,
      PoolSource
    >
    const other = legacySizes({}, split)
    steady =
      role === "all"
        ? sum(pools, split)
        : role === "api"
          ? apiReplicas * sum(pools, split) + workerReplicas * sum(other, split)
          : workerReplicas * sum(pools, split) + apiReplicas * sum(other, split)
  } else {
    mode = "planned"
    available = input.cellMax - (input.reserved ?? DEFAULT_CELL_RESERVED) - MIGRATE_FOOTPRINT
    if (role === "all") {
      const all = planAll(split, kernel, available)
      ;({ pools, source } = withOverrides(all.sizes, overrides, split))
      unallocated = all.unallocated
      steady = sum(pools, split)
    } else {
      const t = planTopology(
        split,
        kernel,
        apiReplicas,
        workerReplicas,
        Math.floor(available / overlapFactor),
      )
      ;({ pools, source } = withOverrides(role === "api" ? t.api : t.worker, overrides, split))
      unallocated = t.unallocated
      steady =
        role === "api"
          ? apiReplicas * sum(pools, split) + workerReplicas * sum(t.worker, split)
          : workerReplicas * sum(pools, split) + apiReplicas * sum(t.api, split)
    }
  }
  const overlap = overlapFactor * steady
  return {
    mode,
    role,
    split,
    pools,
    source,
    physical: physicalPools(split),
    perProcess: sum(pools, split),
    pinnedJobSlots: pinnedSlots(pools.jobs, split, jobsReserve(role)),
    logins: loginsOf(pools, split),
    topology,
    steady,
    overlap,
    available,
    unallocated,
    verdict: available === null ? "ok" : verdictFor(steady, overlap, available, strict),
  }
}

/**
 * The same rule against a limit read from the server (max_connections minus
 * its reserved slots): steady above (limit − migrate footprint) refuses,
 * overlap above it warns.
 */
export function judgeAgainstLimit(
  plan: PoolPlan,
  observedLimit: number,
  strict = false,
): { verdict: PlanVerdict; available: number } {
  const available = observedLimit - MIGRATE_FOOTPRINT
  if (plan.mode === "fixed") return { verdict: "ok", available }
  return { verdict: verdictFor(plan.steady, plan.overlap, available, strict), available }
}

/** Operator name of a pool (privilegedJobs → privileged-jobs). */
export function poolLabel(p: PoolName): string {
  return p === "privilegedJobs" ? "privileged-jobs" : p
}

/** One line naming every physical pool with its size and source, then the topology sums. */
export function describePlan(plan: PoolPlan): string {
  const pools = plan.physical
    .map((p) => `${poolLabel(p)}=${plan.pools[p]} (${plan.source[p]})`)
    .join(", ")
  const topo =
    plan.role === "all"
      ? "1 all"
      : plan.role === "api" || plan.role === "worker"
        ? `${plan.topology.api} api + ${plan.topology.worker} worker`
        : plan.role
  const budget =
    plan.available === null
      ? "no budget (DB_CELL_MAX_CONNECTIONS unset)"
      : `available ${plan.available}`
  return `${plan.role} pools: ${pools}; ${plan.perProcess} per process; ${topo}: steady ${plan.steady}, overlap ${plan.overlap}, ${budget}`
}

/** The env this plan reads (lib/env.ts names). */
export interface PoolEnv {
  DB_POOL_MAX?: number
  DB_PRIVILEGED_POOL_MAX?: number
  DB_JOBS_POOL_MAX?: number
  DB_PRIVILEGED_JOBS_POOL_MAX?: number
  DB_CELL_MAX_CONNECTIONS?: number
  DB_CELL_RESERVED?: number
  DB_CELL_STRICT?: boolean
  LIAISON_API_REPLICAS?: number
  LIAISON_WORKER_REPLICAS?: number
}

/** The plan input for a process: its role (cli / oneshot first), split logins, env and kernel need. */
export function planInputFromEnv(
  e: PoolEnv,
  role: PlanRole,
  split: boolean,
  kernel: KernelNeed,
): PlanInput {
  return {
    role,
    split,
    cellMax: e.DB_CELL_MAX_CONNECTIONS,
    reserved: e.DB_CELL_RESERVED,
    apiReplicas: e.LIAISON_API_REPLICAS,
    workerReplicas: e.LIAISON_WORKER_REPLICAS,
    strict: e.DB_CELL_STRICT,
    kernel,
    overrides: {
      pool: e.DB_POOL_MAX,
      privileged: e.DB_PRIVILEGED_POOL_MAX,
      jobs: e.DB_JOBS_POOL_MAX,
      privilegedJobs: e.DB_PRIVILEGED_JOBS_POOL_MAX,
    },
  }
}
