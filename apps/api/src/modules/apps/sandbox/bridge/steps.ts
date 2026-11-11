// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.steps.*`: work longer than one run, done as bounded chunks across runs
 * of the same job ("come back later" instead of sleeping or looping past the
 * run's limit).
 *
 * `ctx.steps.run(name, { budgetMs }, chunk)` is a guest-side loop (ctx-shim.ts
 * STEPS_RUN_SOURCE / stepsRun) over two hidden bridge methods defined here:
 *
 *  - `_steps_begin(name, opts)` loads the step's state and claims it with a
 *    lease, or says why this run does nothing (`done`, `skipped`).
 *  - `_steps_save(name, token, { result } | { failed })` stores the chunk's
 *    cursor and answers whether the run takes another chunk (`run`), stopped
 *    (`done`), or handed the rest to a re-enqueued run of the same job
 *    (`scheduled`).
 *
 * State: one document per step in the app's data store, collection
 * `liaison_steps`, id = the step name:
 * `{ epoch, gen, cursor, done, lease: { token, startedAt, until, budgetMs } | null }`.
 * Every write is compare-and-set on the document version, in its OWN committed
 * transaction (the session bridge's `commitNowTx`), so a lease is visible to a
 * concurrent run at once and a cursor never rolls back with a failed run.
 *
 * Guarantees:
 *  - One chunk at a time: a run needs the lease to call `chunk`; a duplicate run
 *    (a retry, a second trigger) finds it held and does nothing.
 *  - At least once: a chunk whose run died (a crash, a kill at the deadline)
 *    left the lease; the duplicate that found it held enqueued one wake for when
 *    it runs out (`await` marker), which then reclaims the step and redoes that
 *    chunk from the last saved cursor. Chunks are idempotent per cursor.
 *  - One chain: a continuation carries `{ epoch, gen }`; a run whose marker no
 *    longer matches the state (another run went on, or a reset) is skipped, so
 *    stray continuations never fork a second chain.
 *  - Bounded: a run stops taking chunks once `budgetMs` (at most 80% of the
 *    job's timeout) has passed since its claim; the job's own timeout bounds
 *    the chunk in flight.
 *
 * Only in a job run whose calls commit one by one (not an `atomic` job): the
 * state must commit on its own, and the step re-enqueues that job.
 */
import { randomUUID } from "node:crypto"
import type { RlsClient } from "~/db"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  type AppJobEnqueueOptions,
  createAppJobEnqueuer,
  MAX_WAKE_SECONDS,
  withoutHostJobFields,
} from "~/modules/apps/sandbox/bridge/platform"
import { typedError } from "~/modules/apps/sandbox/bridge/secret-free"
import {
  DataStoreError,
  deleteDocument,
  getDocument,
  type StoreCaller,
  setDocument,
} from "~/modules/data-store/service"

/** The data-store collection of the steps' state (one per app, like every collection). */
export const STEPS_COLLECTION = "liaison_steps"
export const STEP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
/** A run's lease outlives its job timeout by this much (executor grace, clock skew). */
export const STEP_LEASE_GRACE_MS = 10_000
/** A continuation waits this long at least, so it rarely starts before the state commits. */
export const STEP_CONTINUATION_DELAY_MS = 250
/** The share of the job's timeout a budget may take, and the default share. */
const MAX_BUDGET_SHARE = 0.8
const DEFAULT_BUDGET_SHARE = 0.5

export interface StepLease {
  token: string
  startedAt: number
  until: number
  budgetMs: number
}

export interface StepState {
  epoch: string
  gen: number
  cursor: unknown
  done: boolean
  lease: StepLease | null
}

/** What a continuation (or a lease wake) carries in `payload._steps[name]`. */
export interface StepMarker {
  epoch: string
  gen?: number
  await?: string
}

export interface StepJob {
  name: string
  payload: Record<string, unknown>
  timeoutMs: number
  atomic: boolean
}

export type StepBeginAnswer =
  | { state: "run"; token: string; cursor: unknown }
  | { state: "done"; cursor: unknown }
  | { state: "skipped" }

export type StepSaveAnswer =
  | { state: "run"; cursor: unknown }
  | { state: "done"; cursor: unknown }
  | { state: "scheduled"; cursor: unknown }
  | { state: "skipped" }
  | { state: "failed" }

export interface StepsDeps {
  job: StepJob | undefined
  /** False when the run's calls do not commit one by one (no `commitNowTx`). */
  canCommitNow: boolean
  read(name: string): Promise<{ state: StepState; version: number } | null>
  /** Compare-and-set (`ifVersion` 0 = must not exist); false on a version conflict. */
  write(name: string, state: StepState, ifVersion: number): Promise<boolean>
  /** Enqueue the current job again (its app payload) with `_steps` = `markers`. */
  enqueueSelf(
    markers: Record<string, StepMarker>,
    opts: { delayMs: number; jobId?: string },
  ): Promise<void>
  now(): number
  newId(): string
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !STEP_NAME_RE.test(name)) {
    throw typedError(
      400,
      "invalid_step_name",
      `ctx.steps: a step name matches ${STEP_NAME_RE.source}`,
    )
  }
}

function jsonArg(raw: unknown, what: string): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw typedError(400, "invalid_step_options", `ctx.steps: ${what} is not JSON`)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** The run's budget: `budgetMs` clamped to 80% of the job's timeout; default half of it. */
export function stepBudgetMs(raw: unknown, timeoutMs: number): number {
  const max = Math.max(1, Math.floor(timeoutMs * MAX_BUDGET_SHARE))
  if (raw === undefined || raw === null)
    return Math.max(1, Math.floor(timeoutMs * DEFAULT_BUDGET_SHARE))
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw typedError(400, "invalid_step_options", "ctx.steps.run: budgetMs is a positive number")
  }
  return Math.min(Math.floor(raw), max)
}

function markerOf(job: StepJob, name: string): StepMarker | undefined {
  const all = job.payload._steps
  if (!isRecord(all)) return undefined
  const m = all[name]
  if (!isRecord(m) || typeof m.epoch !== "string") return undefined
  return {
    epoch: m.epoch,
    ...(typeof m.gen === "number" ? { gen: m.gen } : {}),
    ...(typeof m.await === "string" ? { await: m.await } : {}),
  }
}

function isStepState(v: unknown): v is StepState {
  return (
    isRecord(v) &&
    typeof v.epoch === "string" &&
    typeof v.gen === "number" &&
    typeof v.done === "boolean" &&
    (v.lease === null || isRecord(v.lease))
  )
}

/** The chunk's answer: `{ done, cursor?, wakeIn? }` (wakeIn in seconds). */
function parseChunkResult(raw: unknown): { done: boolean; cursor: unknown; wakeInMs?: number } {
  if (!isRecord(raw) || typeof raw.done !== "boolean") {
    throw typedError(
      400,
      "invalid_step_result",
      "ctx.steps.run: a chunk returns { done: boolean, cursor?, wakeIn? }",
    )
  }
  let wakeInMs: number | undefined
  if (raw.wakeIn !== undefined && raw.wakeIn !== null) {
    if (
      typeof raw.wakeIn !== "number" ||
      !Number.isFinite(raw.wakeIn) ||
      raw.wakeIn < 0 ||
      raw.wakeIn > MAX_WAKE_SECONDS
    ) {
      throw typedError(
        400,
        "invalid_step_result",
        `ctx.steps.run: wakeIn is a number of seconds from 0 to ${MAX_WAKE_SECONDS}`,
      )
    }
    wakeInMs = Math.round(raw.wakeIn * 1000)
  }
  return {
    done: raw.done,
    cursor: raw.cursor === undefined ? null : raw.cursor,
    ...(wakeInMs !== undefined ? { wakeInMs } : {}),
  }
}

/** The continuation's deduplication key: one per (chain, generation). */
export function stepContinuationId(name: string, epoch: string, gen: number): string {
  return `steps:${name}:${epoch}:${gen}`
}

/** `_steps_begin` / `_steps_save`, over injected storage and queue (unit-testable). */
export function createStepsCore(deps: StepsDeps) {
  const requireJob = (): StepJob => {
    const job = deps.job
    if (!job) {
      throw typedError(
        400,
        "steps_outside_job",
        "ctx.steps.run runs in a job handler: enqueue a job (ctx.jobs.enqueue) and run the step there",
      )
    }
    if (job.atomic || !deps.canCommitNow) {
      throw typedError(
        400,
        "steps_in_atomic_job",
        "ctx.steps.run cannot run in an atomic job: the step's cursor commits on its own",
      )
    }
    return job
  }

  const begin = async (name: unknown, rawOpts: unknown): Promise<StepBeginAnswer> => {
    const job = requireJob()
    assertName(name)
    const opts = jsonArg(rawOpts, "the options") ?? {}
    if (!isRecord(opts)) {
      throw typedError(400, "invalid_step_options", "ctx.steps.run: the options are an object")
    }
    const budgetMs = stepBudgetMs(opts.budgetMs, job.timeoutMs)
    const marker = markerOf(job, name)
    const current = await deps.read(name)
    const state: StepState = current?.state ?? {
      epoch: deps.newId(),
      gen: 0,
      cursor: null,
      done: false,
      lease: null,
    }
    if (state.done) return { state: "done", cursor: state.cursor }
    if (marker) {
      // A continuation or wake of another chain (a reset since): not ours.
      if (marker.epoch !== state.epoch) return { state: "skipped" }
      if (marker.await !== undefined) {
        // A lease wake: only for the lease it waited on. Anything else means
        // the holder finished (and continued) or another run took over.
        if (state.lease?.token !== marker.await) return { state: "skipped" }
      } else if (marker.gen !== undefined) {
        // Enqueued just before its state committed: retried shortly (409).
        if (marker.gen > state.gen) {
          throw typedError(409, "step_not_ready", `ctx.steps: step '${name}' is still saving`)
        }
        // Superseded: another run already took this chain further.
        if (marker.gen < state.gen) return { state: "skipped" }
      }
    }
    const now = deps.now()
    const lease = state.lease
    if (lease && lease.until > now) {
      // Held by a live run, or by one that died and whose lease has not run out.
      // One wake per lease (deduplicated by its token) for when it does; a
      // live holder releases it first and the wake is skipped. A lease wake
      // that came early re-arms without an id (its own id is still running).
      const ownWake = marker?.await === lease.token
      await deps.enqueueSelf(
        { [name]: { epoch: state.epoch, await: lease.token } },
        {
          delayMs: lease.until - now + 1_000,
          ...(ownWake ? {} : { jobId: `steps:${name}:${state.epoch}:await:${lease.token}` }),
        },
      )
      return { state: "skipped" }
    }
    const token = deps.newId()
    const claimed = await deps.write(
      name,
      {
        ...state,
        lease: {
          token,
          startedAt: now,
          until: now + job.timeoutMs + STEP_LEASE_GRACE_MS,
          budgetMs,
        },
      },
      current?.version ?? 0,
    )
    // A concurrent run claimed it between the read and the write: it runs.
    if (!claimed) return { state: "skipped" }
    return { state: "run", token, cursor: state.cursor }
  }

  const save = async (
    name: unknown,
    token: unknown,
    rawInput: unknown,
  ): Promise<StepSaveAnswer> => {
    requireJob()
    assertName(name)
    const input = jsonArg(rawInput, "the chunk's answer")
    const current = await deps.read(name)
    if (!current || typeof token !== "string" || current.state.lease?.token !== token) {
      // The lease ran out and another run took over, or the step was reset:
      // this run's chunk result is dropped and the run stops.
      return { state: "skipped" }
    }
    const { state, version } = current
    const lease = current.state.lease as StepLease
    if (isRecord(input) && input.failed === true) {
      // The chunk threw: the lease goes, the cursor stays, the job's retry redoes it.
      await deps.write(name, { ...state, lease: null }, version)
      return { state: "failed" }
    }
    let result: ReturnType<typeof parseChunkResult>
    try {
      result = parseChunkResult(isRecord(input) ? input.result : undefined)
    } catch (err) {
      await deps.write(name, { ...state, lease: null }, version)
      throw err
    }
    const gen = state.gen + 1
    if (result.done) {
      const ok = await deps.write(
        name,
        { ...state, gen, cursor: result.cursor, done: true, lease: null },
        version,
      )
      return ok ? { state: "done", cursor: result.cursor } : { state: "skipped" }
    }
    const now = deps.now()
    if (result.wakeInMs === undefined && now - lease.startedAt < lease.budgetMs) {
      const ok = await deps.write(name, { ...state, gen, cursor: result.cursor }, version)
      return ok ? { state: "run", cursor: result.cursor } : { state: "skipped" }
    }
    // Out of budget, or the chunk asked to come back later: hand over. The
    // continuation is enqueued BEFORE the state commits (an enqueue that fails
    // leaves the lease, so the job's retry finds it held and the chunk is redone
    // after it runs out); one that starts before the commit is refused with
    // `step_not_ready` and retried.
    await deps.enqueueSelf(
      { [name]: { epoch: state.epoch, gen } },
      {
        delayMs: Math.max(result.wakeInMs ?? 0, STEP_CONTINUATION_DELAY_MS),
        jobId: stepContinuationId(name, state.epoch, gen),
      },
    )
    const ok = await deps.write(
      name,
      { ...state, gen, cursor: result.cursor, lease: null },
      version,
    )
    return ok ? { state: "scheduled", cursor: result.cursor } : { state: "skipped" }
  }

  return { begin, save }
}

/** `_steps_begin`, `_steps_save` (tx-less: each write commits at once), `steps_get`, `steps_reset`. */
export function createStepsMethods(
  ctx: Pick<
    BridgeContext,
    "appName" | "orgId" | "userId" | "actorType" | "txDb" | "callerScopes" | "bridgeOptions"
  >,
): {
  _steps_begin: (name: string, optsJson?: unknown) => Promise<string>
  _steps_save: (name: string, token: string, inputJson?: unknown) => Promise<string>
  steps_get: (name: string) => Promise<string>
  steps_reset: (name: string) => Promise<string>
} {
  const caller: StoreCaller = { orgId: ctx.orgId, app: ctx.appName, userId: null }
  const commitNow = ctx.bridgeOptions?.commitNowTx
  const job = ctx.bridgeOptions?.currentJob
  const enqueue = createAppJobEnqueuer(ctx)
  const inCommitNow = <T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> => {
    if (!commitNow) throw new Error("ctx.steps: this run cannot commit on its own")
    return commitNow(fn)
  }
  const core = createStepsCore({
    job,
    canCommitNow: commitNow !== undefined,
    read: (name) =>
      inCommitNow(async (tx) => {
        const doc = await getDocument(tx, caller, STEPS_COLLECTION, name)
        if (!doc) return null
        if (!isStepState(doc.data)) {
          throw typedError(
            500,
            "step_state_corrupt",
            `ctx.steps: step '${name}' has no valid state`,
          )
        }
        return { state: doc.data, version: doc.version }
      }),
    write: (name, state, ifVersion) =>
      inCommitNow(async (tx) => {
        try {
          await setDocument(tx, caller, STEPS_COLLECTION, name, state, { ifVersion })
          return true
        } catch (err) {
          if (err instanceof DataStoreError && err.code === "version_conflict") return false
          throw err
        }
      }),
    enqueueSelf: async (markers, opts) => {
      const j = job as StepJob
      const enqueueOpts: AppJobEnqueueOptions = {
        delayMs: opts.delayMs,
        longDelay: true,
        hostFields: { _steps: markers },
        ...(opts.jobId ? { jobId: opts.jobId } : {}),
      }
      await enqueue(j.name, withoutHostJobFields(j.payload), enqueueOpts)
    },
    now: () => Date.now(),
    newId: () => randomUUID(),
  })
  const txOf = (): RlsClient => {
    if (!ctx.txDb) throw typedError(400, "invalid_query", "ctx.steps needs an organization's run")
    return ctx.txDb
  }
  return {
    _steps_begin: async (name, optsJson) => JSON.stringify(await core.begin(name, optsJson)),
    _steps_save: async (name, token, inputJson) =>
      JSON.stringify(await core.save(name, token, inputJson)),
    // The step's state for a status view: null before its first run.
    steps_get: async (name) => {
      assertName(name)
      const doc = await getDocument(txOf(), caller, STEPS_COLLECTION, name)
      if (!doc || !isStepState(doc.data)) return JSON.stringify(null)
      const s = doc.data
      return JSON.stringify({
        cursor: s.cursor,
        done: s.done,
        running: s.lease !== null && s.lease.until > Date.now(),
        updatedAt: doc.updatedAt,
      })
    },
    // Forget the step: its next run starts from a null cursor. A run holding
    // it stops at its next save; a queued continuation of the old chain is skipped.
    steps_reset: async (name) => {
      assertName(name)
      const out = await deleteDocument(txOf(), caller, STEPS_COLLECTION, name)
      return JSON.stringify({ reset: out.deleted })
    },
  }
}
