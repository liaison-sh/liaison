// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Run a transform in the sandbox: one call, the upload loop (one call per
 * batch) and the API pull loop (one call per page).
 *
 * Each call is a fresh run through the one door (run-app.ts): on QuickJS the
 * source is evaluated again; on the app loader or the sandbox service it runs
 * as a Worker module built from the source once (transformModule), whose
 * isolate may be reused. Either way nothing a call leaves behind is promised to
 * the next: anything the transform wants to keep travels in `state` (returned
 * by one call, passed to the next).
 * The host drives everything that waits: parsing, cursor bookkeeping, the
 * backoff after a 429 and the deferred downloads all happen between calls,
 * outside the sandbox deadline.
 */
import type { PrivilegedDb } from "~/db"
import { resolveTransformCallBudgetMs } from "~/modules/apps/run-limits"
import { runApp } from "~/modules/apps/sandbox/run-app"
import type { SandboxWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { ensureScriptModule } from "~/modules/apps/workers/adhoc-module"
import type { TransformBatch } from "./batch"
import {
  buildTransformBridge,
  type DeferredDownload,
  type EmittedBatch,
  type RecordIssue,
  type TransformBridgeHost,
} from "./bridge"
import { getTransformPool, TRANSFORM_MEMORY_LIMIT_BYTES } from "./pool"
import { type TransformEntry, validateTransformSource, wrapTransformSource } from "./source"

/**
 * `state` a call may hand to the next one, serialized. Sized for a people
 * directory carried across batches (20,000 people as id -> [email, name] is
 * about 1.3 MB): the state is inlined into each call with at most a 1 MB
 * batch, well inside the 32 MiB heap. A bigger lookup is kept smaller (fewer
 * fields), never moved out of the sandbox.
 */
export const TRANSFORM_STATE_MAX_BYTES = 4 * 1024 * 1024

export class TransformRunError extends Error {
  readonly code = "transform_failed"
  constructor(
    message: string,
    /** The batch (uploads) or page (API sources) that failed, 1-based. */
    readonly step: number | null = null,
  ) {
    super(message)
    this.name = "TransformRunError"
  }
}

export interface TransformCallInput {
  source: string
  entry: TransformEntry
  params: unknown
  host: TransformBridgeHost
  /** Declared budget for one call; resolved through `resolveTransformCallBudgetMs`. */
  budgetMs?: number
  /** Env the budget is resolved against (tests pass production limits). */
  env?: NodeJS.ProcessEnv
  /** Defaults to the transform pool. */
  pool?: SandboxWorkerPool
  signal?: AbortSignal
}

export interface TransformCallResult {
  value: unknown
  emitted: EmittedBatch[]
  rejected: Array<RecordIssue & { kind: string }>
  /** All records the call rejected (`rejected` keeps the first 1,000). */
  rejectedCount: number
  downloads: DeferredDownload[]
  /** Longest Retry-After of a 429 the call saw, or null when it was not throttled. */
  throttledMs: number | null
  /** QuickJS heap in use when the call returned (null when unreadable). */
  heapBytes: number | null
  ms: number
}

/**
 * `finish` is optional: its call goes through this dispatcher, appended to the
 * script, which calls it only when the script's global scope defines one
 * (`function finish` or a top-level `const finish = async () => ...`, never a
 * helper of that name inside another function) and otherwise answers
 * NO_FINISH.
 */
const FINISH_EXPORT = "__liaisonFinish"
const NO_FINISH = "__liaisonNoFinish"
const FINISH_DISPATCH = `function ${FINISH_EXPORT}(batch, ctx) {
  return typeof finish === "function" ? finish(batch, ctx) : { ${NO_FINISH}: true }
}`

/** Did a finish call find no `finish` to call? */
function noFinish(value: unknown): boolean {
  return typeof value === "object" && value !== null && NO_FINISH in value
}

/**
 * The app name an import transform's runs are recorded under (run timing,
 * usage): it is an org's code, not an app's.
 */
export const TRANSFORM_RUN_APP = "import-transform"

/** The entry points a transform's Worker module exports (each looked up when called). */
const TRANSFORM_EXPORTS = ["transform", "pull", FINISH_EXPORT] as const

/**
 * The Worker module of a transform's source (built once per org and source,
 * workers/adhoc-module.ts): the script as QuickJS runs it, with the `finish`
 * dispatcher, exporting every entry point. Built when a transform is saved
 * (store.ts) and looked up when a call goes to a remote executor.
 */
export function transformModule(orgId: string, source: string, tx?: PrivilegedDb): Promise<string> {
  return ensureScriptModule({
    origin: "import-transform",
    orgId,
    ...(tx ? { tx } : {}),
    script: `${wrapTransformSource(source)}\n${FINISH_DISPATCH}`,
    exports: TRANSFORM_EXPORTS,
  })
}

/** One sandboxed call of the transform's entry function, through the one door (run-app.ts). */
export async function runTransformCall(input: TransformCallInput): Promise<TransformCallResult> {
  const optional = input.entry === "finish"
  validateTransformSource(input.source, input.entry === "finish" ? "transform" : input.entry)
  const pool = input.pool ?? (await getTransformPool())
  const bridge = buildTransformBridge(input.host)
  const timeoutMs = resolveTransformCallBudgetMs(input.budgetMs, input.env)
  let heapBytes: number | null = null
  const started = Date.now()
  const value = await runApp({
    appName: TRANSFORM_RUN_APP,
    orgId: input.host.orgId,
    // No installed version: the source's own Worker module, else the source
    // as given on the transform pool.
    installed: null,
    workerModule: async () => ({
      sha256: await transformModule(input.host.orgId, input.source),
      version: "transform",
    }),
    bundleSource: optional
      ? `${wrapTransformSource(input.source)}\n${FINISH_DISPATCH}`
      : wrapTransformSource(input.source),
    exportName: optional ? FINISH_EXPORT : input.entry,
    entry: `import-transform:${input.entry}`,
    params: input.params,
    bridge: bridge.methods,
    timeoutMs,
    priority: "background",
    toolName: `import-transform:${input.entry}`,
    holdsTx: false,
    quickjs: {
      workerPool: pool,
      memoryLimitBytes: TRANSFORM_MEMORY_LIMIT_BYTES,
      onHeapReport: (r) => {
        heapBytes = r.heapBytes
      },
    },
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return {
    value,
    emitted: bridge.ledger.emitted,
    rejected: bridge.ledger.rejected,
    rejectedCount: bridge.ledger.rejectedCount,
    downloads: bridge.ledger.downloads,
    throttledMs: bridge.ledger.throttledMs,
    heapBytes,
    ms: Date.now() - started,
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function checkedState(value: unknown, where: string): unknown {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TransformRunError(
      `${where} returned ${Array.isArray(value) ? "an array" : typeof value}; return an object such as { state }.`,
    )
  }
  const state = (value as { state?: unknown }).state
  if (state === undefined) return undefined
  const bytes = Buffer.byteLength(JSON.stringify(state) ?? "null", "utf8")
  if (bytes > TRANSFORM_STATE_MAX_BYTES) {
    throw new TransformRunError(
      `${where} returned a state of ${bytes} bytes; state may be at most ${TRANSFORM_STATE_MAX_BYTES} bytes (keep only what the next call needs).`,
    )
  }
  return state
}

// ---------------------------------------------------------------------------
// Upload sources
// ---------------------------------------------------------------------------

export interface UploadFileInfo {
  name: string
  kind: "csv" | "json" | "jsonl" | "xml" | "xlsx" | "text"
}

/** What the host does with a finished call's output (the runner persists it). */
export interface TransformSink {
  onEmitted(batch: EmittedBatch[], step: number): Promise<void>
  /** `issues` holds the first 1,000 of the step's `total` rejected records. */
  onRejected?(
    issues: Array<RecordIssue & { kind: string }>,
    step: number,
    total: number,
  ): Promise<void>
  /** API sources: perform the call's deferred downloads (outside the call's deadline). */
  onDownloads?(downloads: DeferredDownload[], step: number): Promise<void>
}

export interface UploadRunInput {
  source: string
  files: UploadFileInfo[]
  batches: AsyncIterable<TransformBatch>
  host: Omit<TransformBridgeHost, "sourceType">
  sink: TransformSink
  initialState?: unknown
  budgetMs?: number
  env?: NodeJS.ProcessEnv
  pool?: SandboxWorkerPool
  signal?: AbortSignal
  /** Called after every batch (progress, heap measurement, a cancel check). */
  onBatch?: (report: {
    batch: number
    records: number
    heapBytes: number | null
    ms: number
  }) => void | Promise<void>
}

export interface UploadRunResult {
  batches: number
  records: number
  state: unknown
  peakHeapBytes: number | null
}

/** Call `transform(batch, ctx)` once per batch, carrying `state` across calls. */
export async function runUploadTransform(input: UploadRunInput): Promise<UploadRunResult> {
  validateTransformSource(input.source, "transform")
  let state = input.initialState
  let n = 0
  let records = 0
  let peak: number | null = null
  for await (const batch of input.batches) {
    n++
    if (input.signal?.aborted) throw new TransformRunError("The import was cancelled.", n)
    let result: TransformCallResult
    try {
      result = await runTransformCall({
        source: input.source,
        entry: "transform",
        params: {
          files: input.files,
          file: batch.file,
          ...(batch.path !== undefined ? { path: batch.path } : {}),
          offset: batch.firstRecord,
          records: batch.records,
          state: state ?? null,
        },
        host: { ...input.host, sourceType: "upload" },
        ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.pool ? { pool: input.pool } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
      state = checkedState(result.value, `transform (batch ${n})`) ?? state
    } catch (err) {
      throw new TransformRunError(
        `The transform failed on batch ${n} (${batch.file}, records ${batch.firstRecord}-${batch.firstRecord + batch.records.length - 1}): ${messageOf(err)}`,
        n,
      )
    }
    if (result.emitted.length > 0) await input.sink.onEmitted(result.emitted, n)
    if (result.rejectedCount > 0) {
      await input.sink.onRejected?.(result.rejected, n, result.rejectedCount)
    }
    records += batch.records.length
    if (result.heapBytes !== null) peak = Math.max(peak ?? 0, result.heapBytes)
    await input.onBatch?.({
      batch: n,
      records: batch.records.length,
      heapBytes: result.heapBytes,
      ms: result.ms,
    })
  }
  // The end of the input: a transform that keeps a group open across batches
  // (rows of one conversation) emits it from `finish`, called once with the
  // last state.
  {
    if (input.signal?.aborted) throw new TransformRunError("The import was cancelled.", n + 1)
    let result: TransformCallResult
    try {
      result = await runTransformCall({
        source: input.source,
        entry: "finish",
        params: { files: input.files, records: [], state: state ?? null, done: true },
        host: { ...input.host, sourceType: "upload" },
        ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.pool ? { pool: input.pool } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch (err) {
      throw new TransformRunError(`The transform failed in finish: ${messageOf(err)}`, n + 1)
    }
    if (noFinish(result.value))
      return { batches: n, records, state: state ?? null, peakHeapBytes: peak }
    if (result.emitted.length > 0) await input.sink.onEmitted(result.emitted, n + 1)
    if (result.rejectedCount > 0) {
      await input.sink.onRejected?.(result.rejected, n + 1, result.rejectedCount)
    }
    if (result.heapBytes !== null) peak = Math.max(peak ?? 0, result.heapBytes)
    await input.onBatch?.({ batch: n + 1, records: 0, heapBytes: result.heapBytes, ms: result.ms })
  }
  return { batches: n, records, state: state ?? null, peakHeapBytes: peak }
}

// ---------------------------------------------------------------------------
// API sources
// ---------------------------------------------------------------------------

export interface ApiPullInput {
  source: string
  host: Omit<TransformBridgeHost, "sourceType">
  sink: TransformSink
  initialCursor?: unknown
  initialState?: unknown
  /** Stop after this many pages (a preview); the run reports it was cut. */
  maxPages?: number
  /** Retries of one page after 429 answers before the run fails. */
  maxThrottleRetries?: number
  budgetMs?: number
  env?: NodeJS.ProcessEnv
  pool?: SandboxWorkerPool
  signal?: AbortSignal
  /** Waits between throttled attempts; injectable for tests. */
  sleep?: (ms: number) => Promise<void>
  /** Called after every page the sink took (progress, a cancel check). */
  onPage?: (page: number) => void | Promise<void>
}

export interface ApiPullResult {
  pages: number
  state: unknown
  /** The cursor to resume from, null when the source said it was done. */
  nextCursor: unknown
  stoppedOn: "done" | "max_pages" | "repeated_cursor"
  throttleWaitsMs: number[]
}

const DEFAULT_THROTTLE_RETRIES = 8
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 120_000

function cursorKey(cursor: unknown): string {
  return JSON.stringify(cursor ?? null)
}

/**
 * Call `pull({cursor, state}, ctx)` once per page until it returns a null
 * `nextCursor`. A page whose call met a 429 is thrown away (nothing it emitted
 * is kept), the host waits (Retry-After, else exponential backoff) and calls
 * the same page again. A cursor already seen ends the run: a source that loops
 * would otherwise import forever.
 */
export async function runApiPull(input: ApiPullInput): Promise<ApiPullResult> {
  validateTransformSource(input.source, "pull")
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms))
  const maxRetries = input.maxThrottleRetries ?? DEFAULT_THROTTLE_RETRIES
  let cursor: unknown = input.initialCursor ?? null
  let state: unknown = input.initialState ?? null
  const seen = new Set<string>([cursorKey(cursor)])
  const waits: number[] = []
  let pages = 0
  for (;;) {
    if (input.maxPages !== undefined && pages >= input.maxPages) {
      return { pages, state, nextCursor: cursor, stoppedOn: "max_pages", throttleWaitsMs: waits }
    }
    const page = pages + 1
    let attempt = 0
    let result: TransformCallResult
    for (;;) {
      if (input.signal?.aborted) throw new TransformRunError("The import was cancelled.", page)
      try {
        result = await runTransformCall({
          source: input.source,
          entry: "pull",
          params: { cursor, state },
          host: { ...input.host, sourceType: "api" },
          ...(input.budgetMs !== undefined ? { budgetMs: input.budgetMs } : {}),
          ...(input.env ? { env: input.env } : {}),
          ...(input.pool ? { pool: input.pool } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      } catch (err) {
        throw new TransformRunError(`The transform failed on page ${page}: ${messageOf(err)}`, page)
      }
      if (result.throttledMs === null) break
      attempt++
      if (attempt > maxRetries) {
        throw new TransformRunError(
          `The API kept answering 429 (rate limited) on page ${page} after ${maxRetries} retries.`,
          page,
        )
      }
      const backoff = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (attempt - 1))
      const wait = Math.min(MAX_BACKOFF_MS, Math.max(result.throttledMs, backoff))
      waits.push(wait)
      await sleep(wait)
    }
    pages = page
    const value = result.value
    let nextCursor: unknown
    try {
      state = checkedState(value, `pull (page ${page})`) ?? state
      nextCursor =
        value && typeof value === "object"
          ? ((value as { nextCursor?: unknown }).nextCursor ?? null)
          : null
    } catch (err) {
      throw new TransformRunError(messageOf(err), page)
    }
    // Downloads first: the refs the page's records carry name files the host
    // has fetched (or failed to) by the time the records reach the sink.
    if (result.downloads.length > 0) {
      if (!input.sink.onDownloads) {
        throw new TransformRunError("This run cannot download files.", page)
      }
      await input.sink.onDownloads(result.downloads, page)
    }
    if (result.emitted.length > 0) await input.sink.onEmitted(result.emitted, page)
    if (result.rejectedCount > 0) {
      await input.sink.onRejected?.(result.rejected, page, result.rejectedCount)
    }
    await input.onPage?.(page)
    if (nextCursor === null) {
      return { pages, state, nextCursor: null, stoppedOn: "done", throttleWaitsMs: waits }
    }
    const key = cursorKey(nextCursor)
    if (seen.has(key)) {
      return { pages, state, nextCursor, stoppedOn: "repeated_cursor", throttleWaitsMs: waits }
    }
    seen.add(key)
    cursor = nextCursor
  }
}
