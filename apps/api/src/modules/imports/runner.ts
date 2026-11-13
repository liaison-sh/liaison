// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The import runner: one library for every client (the CLI importers inline,
 * the `imports-run` job for API and agent runs).
 *
 * A run:
 *   1. resolves its kinds and refuses, before any write, when the person
 *      starting it lacks a kind's `writeScopes` (A6, A42);
 *   2. takes the per-(org, kind) Redis lock of every kind (R8);
 *   3. streams the source, validates each record against its kind (or the
 *      client's own validator), checks the record's dimension value against
 *      the person's grants (`out_of_scope` otherwise), and batches records per
 *      kind (parents before children, one source pass per level);
 *   4. writes each batch in ONE short privileged transaction pinned to the
 *      run's org, each record in its own savepoint (a failed record rolls back
 *      alone, R2) with its ledger rows written in that same savepoint (R1);
 *      bundled kinds write through the RLS session bridge in the worker pool,
 *      their ledger rows right after (`recoverLedger` sweeps a crash between);
 *   5. writes progress to the run row after each batch and stops cleanly when
 *      the run was asked to cancel.
 *
 * Dedup (A13): the dedup value is `<sourceLabel>:<key>` (the bare key for a
 * legacy CLI run with no label), stored in the app's external ref; a handler
 * prechecks it (and the bare key, R9) and reports `skipped`.
 */
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession, type RlsSession, type UserContext, withRlsContext } from "~/db/rls"
import type { ImportRunCounts, ImportRunStatus } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { withPinnedJobSlot } from "~/infra/jobs/pinned-jobs-gate"
import { copyObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { readOnlyRunBlockedError } from "~/modules/agent/runtime/read-only-run"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { type AppBridge, runApp } from "~/modules/apps/sandbox/run-app"
import {
  buildStorageKey,
  loadOrgSettings,
  resolveParent,
  wouldExceedOrgQuota,
} from "~/modules/files/service"
import { kindRecordError, ownAppSchema } from "~/modules/imports/kind-schema"
import { getImportKind, type ImportKindInfo } from "~/modules/imports/kinds"
import { insertLedgerRows, isLedgerTableName, tableRel } from "~/modules/imports/ledger"
import { acquireImportLocks, type ImportLocks } from "~/modules/imports/lock"
import {
  createImportRun,
  finishRun,
  markRunRunning,
  requeueRun,
  touchRunHeartbeat,
  writeRunProgress,
} from "~/modules/imports/runs"
import {
  FORMAT_KINDS,
  type ImportSource,
  type ResolvedImportFile,
  readSource,
  resolveImportFile,
} from "~/modules/imports/source"
import {
  type PreparedTransform,
  prepareTransform,
  type StagedRun,
  stageTransformSource,
  type TransformSource,
  type TransformStageHooks,
} from "~/modules/imports/transform-run"
import {
  AFTER_KIND_RECORD_KEY,
  dedupValueOf,
  type HostImportContext,
  type HostImportHandler,
  ImportError,
  type ImportRecordResult,
  type ImportRowRef,
} from "~/modules/imports/types"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "imports-runner" })

export const DEFAULT_BATCH_SIZE = 200
const CLI_LOCK_WAIT_MS = 5 * 60_000
const HEARTBEAT_MS = 60_000

/** One record's outcome, as handed to the client's `onRecord`. */
export interface ImportRecordEvent {
  line: number
  kind: string
  dedupKey: string
  status: "created" | "skipped" | "failed"
  error?: string
  /** Where the record came from, for a transform source ("batch 3 (tickets.csv), ..."). */
  at?: string
  report?: Record<string, unknown>
  record?: unknown
}

export interface RunImportOptions {
  orgId: string
  /** The person whose scopes and dimension grants authorize the run. */
  actor: UserContext
  /** Full kind names (`tickets.ticket`). */
  kinds: string[]
  source: ImportSource
  /** Prefix of every dedup value (`jira`); `""` keeps bare keys (legacy CLI). */
  sourceLabel: string
  mode: "api" | "cli"
  placeholders?: boolean
  dryRun?: boolean
  /** An existing run row (the job); otherwise the runner creates one. */
  runId?: string
  /** Who rows are attributed to when a record names nobody (default: the actor). */
  actorUserId?: string
  batchSize?: number
  /** Records were already validated by the client (the CLI keeps its own
   *  validators so its error texts stay as they were). */
  prevalidated?: boolean
  /** Options per kind, handed to its handler (`ctx.options`). */
  kindOptions?: Record<string, Record<string, unknown>>
  onRecord?: (event: ImportRecordEvent) => void
  /** How long to wait for another run of the same kinds (default: CLI 5 min, API 0). */
  lockWaitMs?: number
  /**
   * The job's shutdown abort (infra/jobs/jobs.ts). A queued run (`runId`)
   * stops after its current batch, goes back to `queued` and throws
   * ImportInterruptedError, so the job is handed back and the run restarts on
   * another worker; the rows already written are skipped there by dedup.
   */
  signal?: AbortSignal
  /** Test seams (and, for a transform source, its API client and download limits). */
  hooks?: TransformStageHooks & {
    afterBatch?: (batchIndex: number, runId: string) => Promise<void>
    /** Throw here to simulate a crash between a bundle call and its ledger write. */
    beforeBundledLedger?: (bridge: { fileIds: Set<string> }) => void | Promise<void>
  }
}

export interface RunImportResult {
  runId: string
  status: ImportRunStatus | "deferred" | "already_claimed"
  counts: ImportRunCounts
  errors: Array<Record<string, unknown>>
  report: Record<string, unknown>
}

interface PendingRecord {
  line: number
  record: Record<string, unknown>
  dedupKey: string
  dedupValue: string
}

/** The scopes of a kind the actor does not hold. */
export function missingWriteScopes(actor: UserContext, kinds: ImportKindInfo[]): string[] {
  const missing: string[] = []
  for (const k of kinds) {
    for (const scope of k.decl.writeScopes) {
      if (!hasScope(scope, actor.scopes) && !missing.includes(scope)) missing.push(scope)
    }
  }
  return missing
}

/** Does a dimension grant map cover `value` on `dimension` (same rule as RLS)? */
export function dimensionGranted(
  grants: Record<string, string[]>,
  dimension: string,
  value: string,
): boolean {
  const local = dimension.replace(/^.*:/, "")
  const covers = (key: string) => {
    const vals = grants[key]
    return Array.isArray(vals) && (vals.includes("*") || vals.includes(value))
  }
  return (grants["*"] ?? []).includes("*") || covers(dimension) || covers(local)
}

/** Kinds grouped in dependency order: a kind's `parent` comes in an earlier level. */
function levelsOf(kinds: ImportKindInfo[]): ImportKindInfo[][] {
  const byName = new Map(kinds.map((k) => [k.kind, k]))
  const depth = new Map<string, number>()
  const visit = (k: ImportKindInfo, seen: Set<string>): number => {
    const known = depth.get(k.kind)
    if (known !== undefined) return known
    if (seen.has(k.kind)) throw new ImportError("invalid_request", `kind cycle at ${k.kind}`)
    seen.add(k.kind)
    const parentName = k.decl.parent ? `${k.app}.${k.decl.parent}` : null
    const parent = parentName ? byName.get(parentName) : undefined
    const d = parent ? visit(parent, seen) + 1 : 0
    depth.set(k.kind, d)
    return d
  }
  for (const k of kinds) visit(k, new Set())
  const levels: ImportKindInfo[][] = []
  for (const k of kinds) {
    const d = depth.get(k.kind) ?? 0
    if (!levels[d]) levels[d] = []
    levels[d]!.push(k)
  }
  return levels.filter((l) => l.length > 0)
}

async function resolveHostHandler(k: ImportKindInfo): Promise<HostImportHandler | null> {
  const { BUILTIN_IMPORT_HANDLERS } = await import("~/modules/imports/builtin-import-handlers")
  return BUILTIN_IMPORT_HANDLERS[k.kind] ?? null
}

function errorText(err: unknown, handler: HostImportHandler | null): string {
  if (handler?.formatError) return handler.formatError(err)
  return err instanceof Error ? err.message : String(err)
}

function containsFilePath(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some((v) => containsFilePath(v, depth + 1))
  for (const [k, v] of Object.entries(value)) {
    if (k === "filePath") return true
    if (containsFilePath(v, depth + 1)) return true
  }
  return false
}

function addCounters(into: Record<string, unknown>, from: Record<string, unknown> | undefined) {
  if (!from) return
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === "number") into[k] = (typeof into[k] === "number" ? Number(into[k]) : 0) + v
  }
}

/**
 * Run an import. Refusals before any write (unknown kind, missing scope, a
 * server path through the API, an unreadable file) throw `ImportError`; record
 * failures are counted and listed and the run continues.
 */
/** A queued run stopped by a shutdown and put back in the queue (RunImportOptions.signal). */
export class ImportInterruptedError extends Error {
  constructor(readonly runId: string) {
    super(`import run ${runId} interrupted by a shutdown; back in the queue`)
    this.name = "ImportInterruptedError"
  }
}

export async function runImport(opts: RunImportOptions): Promise<RunImportResult> {
  const { orgId, actor } = opts
  if (actor.orgId !== orgId) throw new ImportError("forbidden", "actor is not in this org")
  if (opts.kinds.length === 0) throw new ImportError("invalid_request", "no kind to import")
  const apiReadable =
    opts.source.type === "file" ||
    (opts.source.type === "transform" && opts.source.input.type !== "paths")
  if (opts.mode === "api" && !apiReadable) {
    // R10: the API and the job read uploaded files only, never a server path.
    throw new ImportError("invalid_source", "API runs read uploaded files only")
  }
  if (
    opts.source.type === "transform" &&
    opts.mode === "api" &&
    "inline" in opts.source.transform
  ) {
    // An API run executes a saved version only: what was previewed and approved.
    throw new ImportError("invalid_source", "API runs execute a saved transform version")
  }

  // 1. Kinds and permissions, before any write.
  const kinds: ImportKindInfo[] = []
  for (const name of [...new Set(opts.kinds)]) {
    const k = await getImportKind(orgId, name, { ensureApps: opts.mode === "api" })
    if (!k) throw new ImportError("unknown_kind", `unknown import kind: ${name}`)
    kinds.push(k)
  }
  const missing = missingWriteScopes(actor, kinds)
  if (missing.length > 0) {
    throw new ImportError("forbidden", `missing scope(s): ${missing.join(", ")}`)
  }
  if (opts.sourceLabel === "" && kinds.some((k) => k.bundle)) {
    // A bundled kind's ledger is recovered by its source prefix: it needs one.
    throw new ImportError("invalid_request", "a bundled kind's run needs a source label")
  }
  const format =
    opts.source.type === "file" || opts.source.type === "path" ? opts.source.format : undefined
  if (format && format !== "ndjson") {
    const only = FORMAT_KINDS[format]
    if (kinds.length !== 1 || kinds[0]?.kind !== only) {
      throw new ImportError("invalid_source", `a ${format} file carries ${only} records only`)
    }
  }
  const resolvedFile: ResolvedImportFile | null =
    opts.source.type === "file" ? await resolveImportFile(actor, opts.source.fileId) : null
  const transformSource: TransformSource | null =
    opts.source.type === "transform" ? opts.source : null
  const prepared: PreparedTransform | null = transformSource
    ? await prepareTransform(
        orgId,
        transformSource,
        kinds.map((k) => k.kind),
      )
    : null

  const levels = levelsOf(kinds)
  if (levels.length > 1 && opts.source.type === "records") {
    throw new ImportError("invalid_request", "a record stream cannot carry dependent kinds")
  }

  // 2. Run row.
  const runId =
    opts.runId ??
    (
      await createImportRun({
        orgId,
        kinds: kinds.map((k) => k.kind),
        sourceLabel: opts.sourceLabel,
        source:
          opts.source.type === "file"
            ? { fileId: opts.source.fileId, ...(format ? { format } : {}) }
            : opts.source.type === "path"
              ? { path: opts.source.path, ...(format ? { format } : {}) }
              : opts.source.type === "transform" && prepared
                ? transformRunSource(opts.source, prepared)
                : { records: true },
        mode: opts.mode,
        dryRun: opts.dryRun === true,
        placeholders: opts.placeholders === true,
        startedBy: actor.userId,
        status: "running",
      })
    ).id

  // 3. Locks (dry runs write nothing and need none).
  let locks: ImportLocks | null = null
  if (!opts.dryRun) {
    locks = await acquireImportLocks(
      orgId,
      kinds.map((k) => k.kind),
      opts.lockWaitMs ?? (opts.mode === "cli" ? CLI_LOCK_WAIT_MS : 0),
    )
    if (!locks) {
      if (opts.mode === "cli") {
        await finishRun(orgId, runId, "failed", {
          counts: {},
          errors: [{ error: "another import of the same kind is running" }],
          report: {},
        })
        throw new ImportError("locked", "another import of the same kind is running")
      }
      return { runId, status: "deferred", counts: {}, errors: [], report: {} }
    }
  }

  const counts: ImportRunCounts = {}
  for (const k of kinds) counts[k.kind] = { created: 0, skipped: 0, failed: 0 }
  const errors: Array<Record<string, unknown>> = []
  const report: Record<string, unknown> = {}
  const caches = new Map<string, Map<string, unknown>>()
  let batchIndex = 0
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let cancelled = false
  let interrupted = false
  let staged: StagedRun | null = null

  const emit = (e: ImportRecordEvent) => {
    const c = counts[e.kind]
    if (c) c[e.status]++
    if (e.status === "failed") {
      const at = e.at ?? (staged && e.line > 0 ? staged.describeLine(e.line) : undefined)
      errors.push({
        line: e.line,
        kind: e.kind,
        dedupKey: e.dedupKey,
        error: e.error ?? "failed",
        ...(at ? { at } : {}),
      })
    }
    addCounters(report, e.report)
    opts.onRecord?.(e)
  }

  try {
    // A queued run (the job) is claimed: a second worker that raced to it
    // stops here instead of running it again.
    if (!(await markRunRunning(orgId, runId, opts.runId !== undefined))) {
      return { runId, status: "already_claimed", counts: {}, errors: [], report: {} }
    }
    heartbeat = setInterval(() => {
      touchRunHeartbeat(orgId, runId).catch(() => {})
    }, HEARTBEAT_MS)
    heartbeat.unref?.()
    const singleKind = kinds.length === 1 ? kinds[0]!.kind : null

    // A transform source runs once, here, into a spool the levels then read.
    let source: ImportSource = opts.source
    if (transformSource && prepared) {
      staged = await stageTransformSource({
        orgId,
        runId,
        actor,
        kinds,
        source: transformSource,
        prepared,
        mode: opts.mode,
        dryRun: opts.dryRun === true,
        ...(opts.hooks ? { hooks: opts.hooks } : {}),
        callbacks: {
          onRejected: (kind, at, message, count) => {
            const c = counts[kind]
            if (c && count > 1) c.failed += count - 1
            emit({ line: 0, kind, dedupKey: "", status: "failed", error: message, at })
          },
          onCall: async () => {
            const progress = await writeRunProgress(orgId, runId, { counts, errors, report })
            return progress.cancelRequested
          },
        },
      })
      Object.assign(report, staged.report)
      if (staged.cancelled) cancelled = true
      source = { type: "path", path: staged.spoolPath }
    }

    for (const level of levels) {
      if (cancelled || interrupted) break
      const inLevel = new Map(level.map((k) => [k.kind, k]))
      const pending = new Map<string, PendingRecord[]>()

      const flush = async (k: ImportKindInfo) => {
        const batch = pending.get(k.kind) ?? []
        pending.set(k.kind, [])
        if (batch.length === 0) return
        // A preview runs the kind's own check (nothing written), a run writes.
        const results = opts.dryRun
          ? await checkBatch(k, batch, runId, opts, caches, staged)
          : await writeBatch(k, batch, runId, opts, caches, staged)
        for (const [i, r] of results.entries()) {
          const p = batch[i]!
          emit({
            line: p.line,
            kind: k.kind,
            dedupKey: p.dedupKey,
            status: r.status,
            ...(r.error ? { error: r.error } : {}),
            ...(r.report ? { report: r.report } : {}),
            record: p.record,
          })
        }
        await opts.hooks?.afterBatch?.(batchIndex, runId)
        batchIndex++
        const progress = await writeRunProgress(orgId, runId, { counts, errors, report })
        if (progress.cancelRequested) cancelled = true
        else if (opts.runId !== undefined && opts.signal?.aborted) interrupted = true
      }

      for await (const item of readSource(source, resolvedFile)) {
        if (cancelled || interrupted) break
        const kindName = "kind" in item && item.kind ? item.kind : singleKind
        if ("error" in item) {
          // A line that is not JSON belongs to no kind: count it on the run.
          emit({
            line: item.line,
            kind: singleKind ?? "",
            dedupKey: "",
            status: "failed",
            error: item.error,
          })
          continue
        }
        if (!kindName) {
          if (level === levels[0]) {
            emit({
              line: item.line,
              kind: "",
              dedupKey: "",
              status: "failed",
              error: 'a multi-kind run needs {"kind", "record"} lines',
            })
          }
          continue
        }
        const k = inLevel.get(kindName)
        if (!k) {
          if (level === levels[0] && !kinds.some((x) => x.kind === kindName)) {
            emit({
              line: item.line,
              kind: kindName,
              dedupKey: "",
              status: "failed",
              error: `kind ${kindName} is not part of this run`,
            })
          }
          continue
        }
        const record = item.record
        if (record === null || typeof record !== "object" || Array.isArray(record)) {
          emit({
            line: item.line,
            kind: k.kind,
            dedupKey: "",
            status: "failed",
            error: "not an object",
          })
          continue
        }
        const rec = record as Record<string, unknown>
        const dedupKeyRaw = rec[k.decl.dedupKey]
        const dedupKey = typeof dedupKeyRaw === "string" ? dedupKeyRaw : ""
        if (opts.mode === "api" && containsFilePath(rec)) {
          emit({
            line: item.line,
            kind: k.kind,
            dedupKey,
            status: "failed",
            error: "filePath is accepted only from the CLI; reference an uploaded file instead",
          })
          continue
        }
        if (!opts.prevalidated) {
          const invalid = kindRecordError(k.decl, rec)
          if (invalid) {
            emit({
              line: item.line,
              kind: k.kind,
              dedupKey,
              status: "failed",
              error: `invalid record: ${invalid}`,
            })
            continue
          }
        }
        if (k.decl.dimension) {
          const v = rec[k.decl.dimension.field]
          if (
            typeof v === "string" &&
            v.length > 0 &&
            !dimensionGranted(actor.dimensionGrants, k.decl.dimension.dimension, v)
          ) {
            emit({
              line: item.line,
              kind: k.kind,
              dedupKey,
              status: "failed",
              error: `out_of_scope: ${k.decl.dimension.field} "${v}" is outside your grant`,
            })
            continue
          }
        }
        if (opts.dryRun && !(await checksRecords(k))) {
          // Validated, would be written: counted as created in the preview.
          emit({ line: item.line, kind: k.kind, dedupKey, status: "created", record: rec })
          continue
        }
        const list = pending.get(k.kind) ?? []
        list.push({
          line: item.line,
          record: rec,
          dedupKey,
          dedupValue: dedupValueOf(opts.sourceLabel, dedupKey),
        })
        pending.set(k.kind, list)
        if (list.length >= (opts.batchSize ?? DEFAULT_BATCH_SIZE)) await flush(k)
      }
      if (cancelled || interrupted) continue
      for (const k of level) await flush(k)
      if (!cancelled && !interrupted && !opts.dryRun) {
        for (const k of level) {
          const outcome = await runAfterKind(k, runId, opts, caches, staged)
          if (!outcome) continue
          if (outcome.error) errors.push({ kind: k.kind, error: outcome.error })
          addCounters(report, outcome.report)
        }
      }
    }

    if (interrupted && !cancelled) {
      await requeueRun(orgId, runId)
      throw new ImportInterruptedError(runId)
    }
    const status: ImportRunStatus = cancelled ? "cancelled" : "done"
    await finishRun(orgId, runId, status, { counts, errors, report })
    return { runId, status, counts, errors, report }
  } catch (err) {
    if (err instanceof ImportInterruptedError) throw err
    log.error({ err, orgId, runId }, "import run failed")
    errors.push({ error: err instanceof Error ? err.message : String(err) })
    await finishRun(orgId, runId, "failed", { counts, errors, report }).catch((e) =>
      log.error({ err: e, orgId, runId }, "could not mark the import run failed"),
    )
    throw err
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    await (staged as StagedRun | null)
      ?.cleanup()
      .catch((err) => log.warn({ err, orgId, runId }, "staged files cleanup failed"))
    await locks?.release().catch((err) => log.warn({ err, orgId, runId }, "lock release failed"))
  }
}

/** What a transform run's row records of its source: the pin, the input, the file rules. */
export function transformRunSource(
  source: TransformSource,
  prepared: PreparedTransform,
): Record<string, unknown> {
  return {
    transform:
      "inline" in source.transform
        ? { name: prepared.name, inline: true, sha256: prepared.sha256 }
        : {
            id: source.transform.id,
            version: source.transform.version,
            name: prepared.name,
            sha256: prepared.sha256,
          },
    input: source.input,
    ...(source.files ? { files: source.files } : {}),
    ...(source.limit ? { limit: source.limit } : {}),
  }
}

/** Write one batch of one kind and return a result per record, in order. */
async function writeBatch(
  k: ImportKindInfo,
  batch: PendingRecord[],
  runId: string,
  opts: RunImportOptions,
  caches: Map<string, Map<string, unknown>>,
  staged: StagedRun | null,
): Promise<ImportRecordResult[]> {
  const handler = await resolveHostHandler(k)
  if (handler) return writeHostBatch(k, handler, batch, runId, opts, caches, staged)
  if (k.bundle) return writeBundledBatch(k, batch, runId, opts, staged, runClaims(caches, k.kind))
  return batch.map((p) => ({
    dedupKey: p.dedupKey,
    status: "failed" as const,
    rows: [],
    error: `no handler for import kind ${k.kind}`,
  }))
}

/**
 * Move the ledger time of the run's own rows a record (or `afterKind`)
 * reports it updated, a roll-up. Only rows of the kind's `rollupTables` that
 * are already on this run's ledger move: any other change still reads as
 * someone else's at undo.
 */
async function refreshTouched(
  tx: PrivilegedDb,
  k: ImportKindInfo,
  orgId: string,
  runId: string,
  touched: ImportRowRef[] | undefined,
): Promise<void> {
  if (!touched || touched.length === 0) return
  const allowed = new Set(k.decl.rollupTables ?? [])
  const K = drizzleSql.raw(schemaRef("kernel"))
  for (const t of touched) {
    if (!allowed.has(t.table)) {
      throw new Error(`${k.kind} touched ${t.table}, which is not one of its rollupTables`)
    }
    // clock_timestamp: after the update the handler just made in this transaction.
    await tx.execute(drizzleSql`
      UPDATE ${K}.import_ledger SET recorded_at = clock_timestamp()
      WHERE org_id = ${orgId}::uuid AND run_id = ${runId}::uuid
        AND table_name = ${t.table} AND row_id = ${t.id}::uuid
    `)
  }
}

/** The cache every kind of the run shares, kept beside the per-kind ones. */
function runCacheOf(caches: Map<string, Map<string, unknown>>): Map<string, unknown> {
  let shared = caches.get(RUN_CACHE_KEY)
  if (!shared) {
    shared = new Map()
    caches.set(RUN_CACHE_KEY, shared)
  }
  return shared
}
/** Not a kind name (kinds are `<app>.<kind>`). */
const RUN_CACHE_KEY = "__run__"

/** A host handler's context for one kind of the run (its cache lives for the run). */
function hostContext(
  k: ImportKindInfo,
  runId: string,
  opts: RunImportOptions,
  caches: Map<string, Map<string, unknown>>,
  staged: StagedRun | null,
): HostImportContext {
  let cache = caches.get(k.kind)
  if (!cache) {
    cache = new Map()
    caches.set(k.kind, cache)
  }
  return {
    orgId: opts.orgId,
    runId,
    kind: k.kind,
    sourceLabel: opts.sourceLabel,
    actorUserId: opts.actorUserId ?? opts.actor.userId,
    actorScopes: opts.actor.scopes,
    actorDimensionGrants: opts.actor.dimensionGrants,
    placeholders: opts.placeholders === true,
    mode: opts.mode,
    cache,
    runCache: runCacheOf(caches),
    options: opts.kindOptions?.[k.kind] ?? {},
    // A file the run's transform staged first (an extracted zip entry, a
    // download), then an uploaded file under the person's RLS.
    resolveFile: async (fileId) => {
      if (!staged) return resolveImportFile(opts.actor, fileId)
      // A transform run resolves only its own files, never any file the
      // person can read.
      if (!staged.fileAllowed(fileId)) {
        throw new ImportError("file_not_found", `file ${fileId} is not a file of this import`)
      }
      return staged.resolveStagedFile(fileId) ?? resolveImportFile(opts.actor, fileId)
    },
    withActorRls: (fn) => withRlsContext(opts.actor, fn),
    checkDimension: (dimension, value) =>
      dimensionGranted(opts.actor.dimensionGrants, dimension, value),
  }
}

/**
 * A host kind's `afterKind` (D7), once its level is written: one privileged
 * transaction pinned to the run's org, its rows ledgered under `__after__` in
 * that same transaction. A failure rolls it back and is listed on the run.
 */
async function runAfterKind(
  k: ImportKindInfo,
  runId: string,
  opts: RunImportOptions,
  caches: Map<string, Map<string, unknown>>,
  staged: StagedRun | null,
): Promise<{ report?: Record<string, unknown>; error?: string } | null> {
  const handler = await resolveHostHandler(k)
  if (!handler?.afterKind) return null
  const afterKind = handler.afterKind.bind(handler)
  const ctx = hostContext(k, runId, opts, caches, staged)
  try {
    return await withPinnedJobSlot("import-batch", () =>
      withPrivilegedDb(
        opts.orgId,
        "imports-after-kind",
        async (tx) => {
          const outcome = await afterKind(tx, ctx)
          await insertLedgerRows(tx, {
            orgId: opts.orgId,
            runId,
            kind: k.kind,
            recordKey: AFTER_KIND_RECORD_KEY,
            rows: outcome.rows,
          })
          await refreshTouched(tx, k, opts.orgId, runId, outcome.touched)
          return outcome.report ? { report: outcome.report } : {}
        },
        { pool: "jobs", actor: opts.actor },
      ),
    )
  } catch (err) {
    log.error({ err, orgId: opts.orgId, runId, kind: k.kind }, "import afterKind failed")
    return { error: `afterKind: ${errorText(err, handler)}` }
  }
}

async function writeHostBatch(
  k: ImportKindInfo,
  handler: HostImportHandler,
  batch: PendingRecord[],
  runId: string,
  opts: RunImportOptions,
  caches: Map<string, Map<string, unknown>>,
  staged: StagedRun | null,
): Promise<ImportRecordResult[]> {
  const orgId = opts.orgId
  const ctx = hostContext(k, runId, opts, caches, staged)
  const cache = ctx.cache
  let results: ImportRecordResult[]
  try {
    // One short privileged transaction per batch, pinned to the run's org (R1);
    // each record in its own savepoint (R2) with its ledger rows (R1).
    results = await withPinnedJobSlot("import-batch", () =>
      withPrivilegedDb(
        orgId,
        "imports-batch",
        async (tx) => {
          const out: ImportRecordResult[] = []
          for (const p of batch) {
            try {
              const outcome = await tx.transaction(async (sp) => {
                const o = await handler.importRecord(sp, ctx, p.record, p.dedupValue)
                // A skipped record may still have made setup rows (a calendar).
                if (o.status === "created" || (o.status === "skipped" && o.rows.length > 0)) {
                  await insertLedgerRows(sp, {
                    orgId,
                    runId,
                    kind: k.kind,
                    recordKey: p.dedupKey,
                    rows: o.rows,
                  })
                  await refreshTouched(sp, k, orgId, runId, o.touched)
                }
                return o
              })
              out.push({
                dedupKey: p.dedupKey,
                status: outcome.status,
                rows: outcome.rows,
                ...(outcome.report ? { report: outcome.report } : {}),
              })
            } catch (err) {
              log.error({ err, orgId, runId, kind: k.kind, line: p.line }, "import record failed")
              out.push({
                dedupKey: p.dedupKey,
                status: "failed",
                rows: [],
                error: errorText(err, handler),
              })
            }
          }
          return out
        },
        // The definer checks of the kind's services read the importer's context.
        { pool: "jobs", actor: opts.actor },
      ),
    )
  } catch (err) {
    // The batch transaction itself failed (commit): nothing of it is kept, and
    // whatever the handler cached during it is stale.
    cache.clear()
    const message = errorText(err, handler)
    return batch.map((p) => ({ dedupKey: p.dedupKey, status: "failed", rows: [], error: message }))
  }
  if (handler.afterCommit) {
    try {
      const counters = await handler.afterCommit(ctx, results)
      if (counters) {
        const first = results.find((r) => r.status === "created")
        if (first) first.report = { ...(first.report ?? {}), ...counters }
      }
    } catch (err) {
      log.warn({ err, orgId, runId, kind: k.kind }, "import afterCommit failed")
    }
  }
  return results
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** The largest value a bundle may raise one of its sequences to (Q2). */
export const MAX_SEQUENCE_FLOOR = 2 ** 31

/** One bundle result, with the side effects it asks the host for (D4). */
/** A bundle's request to attach an uploaded file to one of the rows it just wrote. */
interface BundleAttachment {
  fileId: string
  /** A file parent of the kind's own app (manifest `entities.<x>.fileParent`). */
  parent: string
  rowId: string
  /** Also record the copy's id in the row's `external_refs` under this key. */
  ref?: string
}

interface BundledResult extends ImportRecordResult {
  /** `kernel.files` rows the bundle claims; ledgered only once verified. */
  fileIds: string[]
  /** Sequence floors to raise once the record is in. */
  floors: Array<{ key: string; value: number }>
  /** Uploaded files to attach to the record's own rows through the app's file parents. */
  attachments: BundleAttachment[]
  /** A claim the host refused: the record fails with this, its own rows stay ledgered. */
  refusal?: string
}

/**
 * Shape of the results a bundle export returns. A bundle may only ledger rows
 * of the tables its kind declares in its own schema; it may also name
 * `kernel.files` rows (verified in the ledger transaction), sequence floors
 * (`sequenceFloors: [{key, value}]`, keys of its own app only) and
 * attachments (`attachments: [{fileId, parent, rowId}]`, see attachForBundle).
 * Nothing else a bundle returns reaches the host.
 */
function parseBundledResults(raw: unknown, batch: PendingRecord[], k: ImportKindInfo) {
  const list = Array.isArray(raw) ? raw : []
  return batch.map((p, i): BundledResult => {
    const r = list[i]
    if (r === null || typeof r !== "object") {
      return {
        dedupKey: p.dedupKey,
        status: "failed",
        rows: [],
        fileIds: [],
        floors: [],
        attachments: [],
        error: "handler returned no result",
      }
    }
    const obj = r as Record<string, unknown>
    const status = obj.status === "created" || obj.status === "skipped" ? obj.status : "failed"
    const rows: ImportRowRef[] = []
    const fileIds: string[] = []
    let refusal: string | undefined
    for (const row of Array.isArray(obj.rows) ? obj.rows : []) {
      if (row === null || typeof row !== "object") continue
      const t = (row as Record<string, unknown>).table
      const id = (row as Record<string, unknown>).id
      if (typeof t !== "string" || typeof id !== "string") continue
      if (t === "kernel.files") {
        if (UUID.test(id)) fileIds.push(id)
        else refusal ??= `forbidden_row: kernel.files ${id.slice(0, 64)}`
        continue
      }
      if (k.decl.tables.includes(t) && t.startsWith(`${ownAppSchema(k.app)}.`) && UUID.test(id)) {
        rows.push({ table: t, id })
      }
    }
    const floors: Array<{ key: string; value: number }> = []
    for (const f of Array.isArray(obj.sequenceFloors) ? obj.sequenceFloors : []) {
      const key = f !== null && typeof f === "object" ? (f as Record<string, unknown>).key : null
      const value =
        f !== null && typeof f === "object" ? (f as Record<string, unknown>).value : null
      if (
        typeof key !== "string" ||
        !key.startsWith(`${k.app}:`) ||
        key.length > 200 ||
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_SEQUENCE_FLOOR
      ) {
        refusal ??= `forbidden_sequence: ${typeof key === "string" ? key.slice(0, 200) : "?"}`
        continue
      }
      floors.push({ key, value })
    }
    const attachments: BundleAttachment[] = []
    for (const a of Array.isArray(obj.attachments) ? obj.attachments : []) {
      const o = a !== null && typeof a === "object" ? (a as Record<string, unknown>) : {}
      if (
        typeof o.fileId === "string" &&
        UUID.test(o.fileId) &&
        typeof o.parent === "string" &&
        /^[a-z][a-z0-9_]{0,62}$/.test(o.parent) &&
        typeof o.rowId === "string" &&
        UUID.test(o.rowId) &&
        (o.ref === undefined || (typeof o.ref === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(o.ref)))
      ) {
        attachments.push({
          fileId: o.fileId,
          parent: o.parent,
          rowId: o.rowId,
          ...(typeof o.ref === "string" ? { ref: o.ref } : {}),
        })
      } else {
        refusal ??= "forbidden_attachment: a malformed attachment"
      }
    }
    return {
      dedupKey: p.dedupKey,
      status,
      rows,
      fileIds,
      floors,
      attachments,
      ...(refusal ? { refusal } : {}),
      ...(status === "failed"
        ? { error: typeof obj.error === "string" ? obj.error : "handler reported a failure" }
        : {}),
    }
  })
}

/**
 * The `kernel.files` ids among `ids` a bundled kind may ledger: rows the
 * host's bridge created for THIS batch's bundle call (`bridgeFiles`), of the
 * run's org, of the kind's own app, uploaded by the run's user during the run,
 * and on no ledger yet (a partial unique index on the ledger closes the race).
 * Read in the ledger transaction.
 */
async function ownRunFiles(
  tx: PrivilegedDb,
  k: ImportKindInfo,
  runId: string,
  orgId: string,
  uploadedBy: string,
  claimed: string[],
  bridgeFiles: ReadonlySet<string>,
): Promise<Set<string>> {
  const ids = claimed.filter((id) => bridgeFiles.has(id))
  if (ids.length === 0) return new Set()
  const K = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT f.id FROM ${K}.files f
      JOIN ${K}.import_runs r ON r.id = ${runId}::uuid AND r.org_id = ${orgId}::uuid
      WHERE f.id = ANY(${`{${ids.join(",")}}`}::uuid[])
        AND f.org_id = ${orgId}::uuid
        AND f.app = ${k.app}
        AND f.uploaded_by = ${uploadedBy}::uuid
        AND r.started_at IS NOT NULL AND f.created_at >= r.started_at
        AND NOT EXISTS (
          SELECT 1 FROM ${K}.import_ledger l WHERE l.table_name = 'kernel.files' AND l.row_id = f.id
        )
    `),
  )
  return new Set(rows.map((r) => r.id))
}

/**
 * The rows among `rows` a bundled record may ledger: rows of the run's org
 * written after the run started and on no other run's ledger. A bundle
 * reports its rows itself; this check (in the ledger transaction) stops it
 * naming an older row, which undo would then delete, or attach a file to.
 * Every manifest table has `created_at` (modules/apps/ddl.ts).
 */
async function ownRunRows(
  tx: PrivilegedDb,
  runId: string,
  orgId: string,
  rows: ImportRowRef[],
): Promise<Set<string>> {
  const ok = new Set<string>()
  const byTable = new Map<string, string[]>()
  for (const r of rows) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.id])
  const K = drizzleSql.raw(schemaRef("kernel"))
  for (const [table, ids] of byTable) {
    const found = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT t.id::text AS id FROM ${tableRel(table)} t
        JOIN ${K}.import_runs r ON r.id = ${runId}::uuid AND r.org_id = ${orgId}::uuid
        WHERE t.id = ANY(${`{${ids.join(",")}}`}::uuid[])
          AND t.org_id = ${orgId}::uuid
          AND r.started_at IS NOT NULL AND t.created_at >= r.started_at
          AND NOT EXISTS (
            SELECT 1 FROM ${K}.import_ledger l
            WHERE l.table_name = ${table} AND l.row_id = t.id AND l.run_id <> ${runId}::uuid
          )
      `),
    )
    for (const f of found) ok.add(`${table}:${f.id}`)
  }
  return ok
}

/** Bridge methods that create a `kernel.files` row and return it (`{ id }`). */
const FILE_CREATING_BRIDGE_METHODS = new Set([
  "files_importAttachment",
  "files_importFromUrl",
  "files_attachToParent",
])

/**
 * The bundle's bridge, with every file the host creates for it through the
 * file methods recorded: a bundle can ledger only a file its own calls made
 * during this batch.
 */
type BridgeMethods = AppBridge

function recordBridgeFiles(methods: BridgeMethods): {
  methods: BridgeMethods
  fileIds: Set<string>
} {
  const fileIds = new Set<string>()
  const wrapped: BridgeMethods = { ...methods }
  for (const name of FILE_CREATING_BRIDGE_METHODS) {
    const original = methods[name]
    if (typeof original !== "function") continue
    wrapped[name] = async (...args: Parameters<typeof original>) => {
      const result: unknown = await original(...args)
      try {
        const parsed: unknown = typeof result === "string" ? JSON.parse(result) : result
        const id =
          parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>).id
            : undefined
        if (typeof id === "string" && UUID.test(id)) fileIds.add(id)
      } catch {
        // Not a file row: nothing to record.
      }
      return result
    }
  }
  return { methods: wrapped, fileIds }
}

/**
 * Attach an uploaded file to one of the rows a bundle's record just wrote,
 * through a file parent of the kind's own app: the host copies the bytes
 * (never the bundle) into a new `kernel.files` row of that parent, and, for a
 * self-parented parent (`joinOn` a column of the row, as an invoice's
 * `pdf_file_id`), points the row at it. Checked here, in the ledger
 * transaction: the file is one the PERSON can see (their RLS and org, A9);
 * the parent is the app's own and the person holds its write scope; the row
 * is one this record wrote. The same power as `files_attachToParent` plus the
 * link `pdf.render` makes, for a row the run itself created.
 */
async function attachForBundle(
  tx: PrivilegedDb,
  k: ImportKindInfo,
  opts: RunImportOptions,
  runId: string,
  actorUserId: string,
  recordRows: ImportRowRef[],
  a: BundleAttachment,
  staged: StagedRun | null,
): Promise<{ fileId: string } | { refusal: string }> {
  const parent = resolveParent(opts.orgId, k.app, a.parent) ?? k.fileParents?.[a.parent]
  if (!parent) return { refusal: `"${a.parent}" is not a file parent of ${k.app}` }
  const own = ownAppSchema(k.app)
  const table = `${parent.schemaRef}.${parent.tableName}`
  if (parent.schemaRef !== own || !isLedgerTableName(table) || !IDENT.test(parent.joinOn)) {
    return { refusal: `"${a.parent}" is not a file parent of ${k.app}'s own tables` }
  }
  if (!hasScope(parent.writeScope, opts.actor.scopes)) {
    return { refusal: `attaching to "${a.parent}" needs ${parent.writeScope}` }
  }
  if (!recordRows.some((r) => r.table === table && r.id === a.rowId)) {
    return { refusal: `row ${a.rowId} is not one this record wrote` }
  }
  // A file the run's transform staged (an extracted zip entry, a download)
  // has no row of its own to copy from; a transform run attaches only its own
  // files, and anything else must be an upload the person can read.
  let source: Omit<ResolvedImportFile, "id"> & { id: string | null }
  try {
    if (staged && !staged.fileAllowed(a.fileId)) throw new Error("not a file of this import")
    const own = staged?.resolveStagedFile(a.fileId)
    source = own ? { ...own, id: null } : await resolveImportFile(opts.actor, a.fileId)
  } catch {
    return { refusal: `file ${a.fileId} not found` }
  }
  // Each attach is a new copy that counts toward the org's storage (an upload
  // attached to N records is N copies): refused past the operator's cap. Read
  // in the ledger transaction, so the copies this run already made count.
  const settings = await loadOrgSettings(tx, opts.orgId)
  if (await wouldExceedOrgQuota(tx, opts.orgId, settings, Number(source.sizeBytes))) {
    return {
      refusal: `the organization's storage limit is reached (STORAGE_QUOTA_EXCEEDED); ${source.filename} was not attached`,
    }
  }
  const fileId = randomUUID()
  const selfParented = parent.joinOn !== "id"
  const entityId = selfParented ? fileId : a.rowId
  const storageKey = buildStorageKey({
    orgId: opts.orgId,
    app: k.app,
    entityType: a.parent,
    entityId,
    filename: source.filename,
  })
  try {
    return await tx.transaction(async (sp) => {
      const K = drizzleSql.raw(schemaRef("kernel"))
      await sp.execute(drizzleSql`
        INSERT INTO ${K}.files
          (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key,
           uploaded_by, copied_from_id)
        VALUES (${fileId}::uuid, ${opts.orgId}::uuid, ${k.app}, ${a.parent}, ${entityId},
                ${source.filename}, ${source.mimeType}, ${source.sizeBytes}, ${storageKey},
                ${actorUserId}::uuid, ${source.id}::uuid)
      `)
      if (selfParented) {
        const updated = extractRows<{ id: string }>(
          await sp.execute(drizzleSql`
            UPDATE ${tableRel(table)} SET ${drizzleSql.raw(quoteIdent(parent.joinOn))} = ${fileId}::uuid
            WHERE id = ${a.rowId}::uuid AND org_id = ${opts.orgId}::uuid
            RETURNING id
          `),
        )
        if (updated.length === 0) throw new Error("the row is gone")
      }
      if (a.ref) {
        // The copy's id in the row's external refs (an imported invoice's
        // `import_file_id`, which its legal-original backfill reads).
        const updated = extractRows<{ id: string }>(
          await sp.execute(drizzleSql`
            UPDATE ${tableRel(table)}
            SET external_refs = COALESCE(external_refs, '{}'::jsonb) || jsonb_build_object(${a.ref}::text, ${fileId}::text)
            WHERE id = ${a.rowId}::uuid AND org_id = ${opts.orgId}::uuid
            RETURNING id
          `),
        )
        if (updated.length === 0) throw new Error("the row is gone")
      }
      // The bytes are copied once the rows are in: a refused insert leaves no
      // stray object behind.
      await copyObject({ sourceKey: source.storageKey, destKey: storageKey })
      return { fileId }
    })
  } catch (err) {
    log.warn({ err, orgId: opts.orgId, runId, kind: k.kind }, "import attachment refused")
    return {
      refusal: `the file could not be attached: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/

/** The longest claim a record may hold, and how many one record may hold. */
const CLAIM_MAX_LENGTH = 200
const CLAIMS_PER_RECORD_MAX = 20

/**
 * The claims a kind's records hold for the run (an invoice number): each
 * batch's bundle gets those of earlier batches (`claimed`), and a record it
 * passed or created returns its own (`claims`), so a duplicate in a later
 * batch is refused even by a preview that writes nothing.
 */
function runClaims(caches: Map<string, Map<string, unknown>>, kind: string): Set<string> {
  const shared = runCacheOf(caches)
  const key = `claims:${kind}`
  const existing = shared.get(key)
  if (existing instanceof Set) return existing as Set<string>
  const fresh = new Set<string>()
  shared.set(key, fresh)
  return fresh
}

/** Keep the claims of the records a bundle passed or created (strings only, bounded). */
function keepClaims(raw: unknown, into: Set<string>): void {
  for (const r of Array.isArray(raw) ? raw : []) {
    if (r === null || typeof r !== "object") continue
    const obj = r as Record<string, unknown>
    if (obj.status !== "created" || !Array.isArray(obj.claims)) continue
    for (const c of obj.claims.slice(0, CLAIMS_PER_RECORD_MAX)) {
      if (typeof c === "string" && c.length > 0 && c.length <= CLAIM_MAX_LENGTH) into.add(c)
    }
  }
}

/** The batch a bundle export receives (the handler and the preview's check alike). */
function bundleParams(
  k: ImportKindInfo,
  batch: PendingRecord[],
  runId: string,
  opts: RunImportOptions,
  claimed: ReadonlySet<string>,
) {
  return {
    runId,
    kind: k.kind,
    sourceLabel: opts.sourceLabel,
    records: batch.map((p) => ({ record: p.record, dedupValue: p.dedupValue })),
    claimed: [...claimed],
  }
}

/** Call one export of the kind's bundle in the sandbox, through the one door. */
async function runBundleExport(
  k: ImportKindInfo,
  exportName: string,
  params: ReturnType<typeof bundleParams>,
  bridge: AppBridge,
  orgId: string,
): Promise<unknown> {
  const bundle = k.bundle
  if (!bundle) throw new Error(`${k.kind} has no bundle`)
  return runApp({
    appName: k.app,
    orgId,
    bundlePath: bundle.bundlePath,
    exportName,
    entry: `import:${k.kind}`,
    params,
    bridge,
    priority: "background",
    appId: k.app,
    holdsTx: false,
  })
}

/**
 * Whether a preview runs the kind's own per-record check: a host handler's
 * `checkRecord`, or a bundle's `check` export.
 */
async function checksRecords(k: ImportKindInfo): Promise<boolean> {
  const handler = await resolveHostHandler(k)
  if (handler) return typeof handler.checkRecord === "function"
  return Boolean(k.bundle && k.decl.check)
}

/** A preview's batch: the kind's own check, nothing written. */
async function checkBatch(
  k: ImportKindInfo,
  batch: PendingRecord[],
  runId: string,
  opts: RunImportOptions,
  caches: Map<string, Map<string, unknown>>,
  staged: StagedRun | null,
): Promise<ImportRecordResult[]> {
  const handler = await resolveHostHandler(k)
  if (handler?.checkRecord) return checkHostBatch(k, handler, batch, runId, opts, caches, staged)
  return checkBundledBatch(k, batch, runId, opts, runClaims(caches, k.kind))
}

/**
 * A preview's batch of a host kind with `checkRecord`: one READ ONLY
 * privileged transaction pinned to the run's org, with the run's context, each
 * record checked on its own (a refusal fails that record, as in a run).
 */
async function checkHostBatch(
  k: ImportKindInfo,
  handler: HostImportHandler,
  batch: PendingRecord[],
  runId: string,
  opts: RunImportOptions,
  caches: Map<string, Map<string, unknown>>,
  staged: StagedRun | null,
): Promise<ImportRecordResult[]> {
  const check = handler.checkRecord
  if (!check) return batch.map((p) => ({ dedupKey: p.dedupKey, status: "created", rows: [] }))
  const ctx = hostContext(k, runId, opts, caches, staged)
  try {
    return await withPinnedJobSlot("import-batch", () =>
      withPrivilegedDb(
        opts.orgId,
        "imports-preview-check",
        async (tx) => {
          await tx.execute(drizzleSql`SET TRANSACTION READ ONLY`)
          const out: ImportRecordResult[] = []
          for (const p of batch) {
            try {
              const status = await tx.transaction((sp) => check(sp, ctx, p.record, p.dedupValue))
              out.push({ dedupKey: p.dedupKey, status, rows: [] })
            } catch (err) {
              out.push({
                dedupKey: p.dedupKey,
                status: "failed",
                rows: [],
                error: errorText(err, handler),
              })
            }
          }
          return out
        },
        { pool: "jobs", actor: opts.actor },
      ),
    )
  } catch (err) {
    const message = errorText(err, handler)
    return batch.map((p) => ({ dedupKey: p.dedupKey, status: "failed", rows: [], error: message }))
  }
}

/** Bridge methods that reach outside the org, refused to a preview's check. */
const PREVIEW_CHECK_REFUSED_IO = ["fetch", "imap_fetch", "smtp_send"] as const

/**
 * The session a preview's check runs on: the person's RLS, each transaction
 * READ ONLY, so a write the bridge let through still fails in the database.
 */
export function previewCheckSession(actor: UserContext): RlsSession {
  return {
    ctx: actor,
    opts: { pool: "jobs" },
    run: (fn) =>
      withRlsContext(
        actor,
        async (tx) => {
          await tx.execute(drizzleSql`SET TRANSACTION READ ONLY`)
          return fn(tx)
        },
        { pool: "jobs" },
      ),
  }
}

/**
 * A preview's batch of a kind with a `check` export: the bundle's own
 * per-record checks, as the person, in read-only transactions (a check that
 * tries to write fails its batch). One result per record; a batch the check
 * cannot run fails every record with the reason, as a run would.
 */
async function checkBundledBatch(
  k: ImportKindInfo,
  batch: PendingRecord[],
  runId: string,
  opts: RunImportOptions,
  claimed: Set<string>,
): Promise<ImportRecordResult[]> {
  const check = k.decl.check
  if (!check || !k.bundle) {
    return batch.map((p) => ({ dedupKey: p.dedupKey, status: "created" as const, rows: [] }))
  }
  const session = previewCheckSession(opts.actor)
  const bridge = createSessionRpcBridge(
    k.app,
    opts.actorUserId ?? opts.actor.userId,
    opts.orgId,
    session,
    (k.manifest ?? { name: k.app }) as never,
    undefined,
    undefined,
    undefined,
    // A read-only run: the db writes and every side-effect method (mail, jobs,
    // events, approvals, files) refuse, so an ungated preview changes nothing.
    { readOnlyRunOverride: true },
  )
  // Outside I/O too: a check reads the org's own data, never the network.
  for (const name of PREVIEW_CHECK_REFUSED_IO) {
    if (typeof bridge[name] !== "function") continue
    bridge[name] = async () => {
      throw readOnlyRunBlockedError("external", `ctx.${name}`)
    }
  }
  let raw: unknown
  try {
    raw = await runBundleExport(
      k,
      check,
      bundleParams(k, batch, runId, opts, claimed),
      bridge,
      opts.orgId,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return batch.map((p) => ({ dedupKey: p.dedupKey, status: "failed", rows: [], error: message }))
  }
  keepClaims(raw, claimed)
  const list = Array.isArray(raw) ? raw : []
  return batch.map((p, i): ImportRecordResult => {
    const r = list[i]
    const obj = r !== null && typeof r === "object" ? (r as Record<string, unknown>) : null
    const status = obj?.status === "created" || obj?.status === "skipped" ? obj.status : "failed"
    const error =
      status === "failed"
        ? typeof obj?.error === "string" && obj.error
          ? obj.error.slice(0, 2000)
          : "the check returned no result"
        : undefined
    return { dedupKey: p.dedupKey, status, rows: [], ...(error ? { error } : {}) }
  })
}
/** Raise one of the app's own sequences to at least `value` (never lowers it). */
async function raiseSequenceFloor(
  tx: PrivilegedDb,
  orgId: string,
  app: string,
  floor: { key: string; value: number },
): Promise<void> {
  // The allocator's lock (modules/sequences/allocate.ts), so a raise and an
  // allocation of the same key serialize.
  await tx.execute(
    drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`${orgId}:${floor.key}`}, 0))`,
  )
  const K = drizzleSql.raw(schemaRef("kernel"))
  await tx.execute(drizzleSql`
    INSERT INTO ${K}.app_sequences (org_id, app_id, key, value, updated_at)
    VALUES (${orgId}::uuid, ${app}, ${floor.key}, ${floor.value}, now())
    ON CONFLICT (org_id, app_id, key) DO UPDATE
      SET value = GREATEST(${K}.app_sequences.value, EXCLUDED.value),
          updated_at = CASE WHEN EXCLUDED.value > ${K}.app_sequences.value
                            THEN now() ELSE ${K}.app_sequences.updated_at END
  `)
}

async function writeBundledBatch(
  k: ImportKindInfo,
  batch: PendingRecord[],
  runId: string,
  opts: RunImportOptions,
  staged: StagedRun | null,
  claimed: Set<string>,
): Promise<ImportRecordResult[]> {
  const bundle = k.bundle
  if (!bundle) throw new Error("writeBundledBatch without a bundle")
  const orgId = opts.orgId
  const actorUserId = opts.actorUserId ?? opts.actor.userId
  const session = createRlsSession(opts.actor, { pool: "jobs" })
  const bridge = recordBridgeFiles(
    createSessionRpcBridge(
      k.app,
      actorUserId,
      orgId,
      session,
      (k.manifest ?? { name: k.app }) as never,
    ),
  )
  let raw: unknown
  try {
    raw = await runBundleExport(
      k,
      k.decl.handler,
      bundleParams(k, batch, runId, opts, claimed),
      bridge.methods,
      orgId,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ err, orgId, runId, kind: k.kind }, "bundled import batch failed in the worker pool")
    return batch.map((p) => ({ dedupKey: p.dedupKey, status: "failed", rows: [], error: message }))
  }
  keepClaims(raw, claimed)
  const results = parseBundledResults(raw, batch, k)
  await opts.hooks?.beforeBundledLedger?.({ fileIds: bridge.fileIds })
  await withPrivilegedDb(orgId, "imports-bundled-ledger", async (tx) => {
    for (const r of results) {
      if (r.status === "skipped") continue
      // Only rows this run wrote (never an older row, never another run's).
      const owned = await ownRunRows(tx, runId, orgId, r.rows)
      const foreignRow = r.rows.find((row) => !owned.has(`${row.table}:${row.id}`))
      if (foreignRow) {
        r.refusal ??= `forbidden_row: ${foreignRow.table} ${foreignRow.id}`
        r.rows = r.rows.filter((row) => owned.has(`${row.table}:${row.id}`))
      }
      if (r.status === "failed") {
        // A record that failed after writing: its rows are ledgered so undo
        // (and recoverLedger) can remove them; nothing else it claimed applies.
        await insertLedgerRows(tx, {
          orgId,
          runId,
          kind: k.kind,
          recordKey: r.dedupKey,
          rows: r.rows,
        })
        continue
      }
      const verified = await ownRunFiles(
        tx,
        k,
        runId,
        orgId,
        actorUserId,
        r.fileIds,
        bridge.fileIds,
      )
      const foreign = r.fileIds.find((id) => !verified.has(id))
      if (foreign) r.refusal ??= `forbidden_row: kernel.files ${foreign}`
      const attached: ImportRowRef[] = []
      if (!r.refusal) {
        for (const a of r.attachments) {
          const done = await attachForBundle(tx, k, opts, runId, actorUserId, r.rows, a, staged)
          if ("refusal" in done) {
            r.refusal = `forbidden_attachment: ${done.refusal}`
            break
          }
          attached.push({ table: "kernel.files", id: done.fileId })
        }
      }
      // The record's own rows (and its verified files) are ledgered even when
      // a claim is refused, so undo can still remove what the bundle wrote.
      await insertLedgerRows(tx, {
        orgId,
        runId,
        kind: k.kind,
        recordKey: r.dedupKey,
        rows: [
          ...r.rows,
          ...[...verified].map((id) => ({ table: "kernel.files", id })),
          ...attached,
        ],
      })
      if (r.refusal) continue
      for (const floor of r.floors) await raiseSequenceFloor(tx, orgId, k.app, floor)
    }
  })
  return results.map(({ fileIds: _f, floors: _s, attachments: _a, refusal, ...r }) =>
    refusal ? { ...r, status: "failed" as const, error: refusal } : r,
  )
}
