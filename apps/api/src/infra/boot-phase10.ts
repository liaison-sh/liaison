// SPDX-License-Identifier: FSL-1.1-ALv2

import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import {
  registerMailFragmentConsumer,
  registerMailSearchEnrichment,
} from "~/apps/mail/search-enrichment"
import { registerLinkIngestJobWorker } from "~/apps/tickets/link-ingest-job"
import { registerTicketsSearchEnrichment } from "~/apps/tickets/search-enrichment"
import { advisoryXactLock, assertTransactionScoped } from "~/db/advisory-lock"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { registerSingleton } from "~/infra/leadership"
import { rootLogger as log } from "~/lib/logger"
import { visitorPinUpstreamId } from "~/modules/agent/providers/openrouter"
import {
  type CatalogVersions,
  catalogFileParents,
  catalogVersions,
  currentCatalog,
  parseCatalogVersions,
  supersedingApp,
} from "~/modules/apps/catalog-derivations"
import { registerRevokeOnDisconnectConsumer } from "~/modules/apps/connections/revoke"
import { registerDigestScheduledJobs } from "~/modules/attention/digest-jobs"
import { registerStateMaterializerScheduledJob } from "~/modules/attention/state-materializer"
import { registerTranslatorConsumer } from "~/modules/attention/translator"
import { demoSpendBootCheck, registerDemoPriceCheckSingleton } from "~/modules/demo/demo-alerts"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { registerReplayResumeSingleton } from "~/modules/demo/replay/resume"
import { registerDemoWorldConsumer } from "~/modules/demo/world/consumer"
import {
  registerDeleteObjectDurableConsumer,
  registerDeleteObjectWorker,
} from "~/modules/files/delete-object-job"
import { registerMediaAnalysisJobWorker } from "~/modules/files/media-analysis-job"
import { registerOrphanGcScheduledJob } from "~/modules/files/orphan-gc"
import { buildFilesSelectPolicy, type FileParentRegistration } from "~/modules/files/rls-builder"
import {
  registerThumbnailDurableConsumer,
  registerThumbnailEventBridge,
  registerThumbnailJobWorker,
} from "~/modules/files/thumbnail-job"
import { warnOnImportUploadCors } from "~/modules/imports/uploads/cors-check"
import { registerImportUploadReaper } from "~/modules/imports/uploads/reaper"
import { registerMailProducerConsumer } from "~/modules/notifications/mail-producer"
import {
  primeSearchSettings,
  registerReindexWorker,
  registerSearchDriftCheck,
} from "~/modules/search/drift"
import { registerIndexerConsumer } from "~/modules/search/indexer"
import { registerMessageIndexerConsumer } from "~/modules/search/message-indexer"
import { registerTourProgressConsumer } from "~/modules/tours/consumer"

/** What one `rebuildFilesSelectPolicy` call did. */
export type FilesSelectPolicyRebuildOutcome =
  /** The policy DDL ran and committed. */
  | "applied"
  /** The live policy already is the one the catalog describes: no DDL ran. */
  | "unchanged"
  /** Inside `batchFilesSelectPolicyRebuild`: rebuilt once when the batch ends. */
  | "deferred"
  /** Not applied (lock never granted, or the role cannot own the policy): the
   *  existing policy stays, which denies by default what it does not name. */
  | "skipped"
  /** Not applied: the live policy was built from a newer catalog (this process
   *  is an older release still running during a rolling deploy). */
  | "superseded"

export interface FilesSelectPolicyRebuildOptions {
  /**
   * The parents to build the policy from. Default: the installed catalog's
   * (`catalogFileParents`), never the per-org registries, so a process that
   * registered no org builds the same policy as one that registered them all.
   */
  parents?: readonly FileParentRegistration[]
  /**
   * The catalog versions `parents` come from, stored with the policy. A rebuild
   * whose versions are older than the stored ones is refused ("superseded").
   * Default: the installed catalog's when `parents` is omitted, else none (no check).
   */
  catalogVersions?: CatalogVersions
  /** `SET LOCAL lock_timeout` for the DDL transaction. */
  lockTimeoutMs?: number
  /** Attempts before giving up on a lock that is never granted. */
  maxAttempts?: number
  /** First backoff between attempts; doubles each retry. */
  backoffMs?: number
}

const DEFAULT_LOCK_TIMEOUT_MS = 2000
const DEFAULT_MAX_ATTEMPTS = 6
const DEFAULT_BACKOFF_MS = 250

/**
 * Counters for tests: how many rebuild requests reached the comparison with
 * the live policy (`evaluated`), how many ran the DDL (`applied`), and how many
 * DDL attempts lost the lock race (`lockTimeouts`).
 */
export const filesSelectPolicyRebuildStats = { evaluated: 0, applied: 0, lockTimeouts: 0 }

interface RebuildBatch {
  dirty: boolean
  opts: FilesSelectPolicyRebuildOptions
}
const rebuildBatch = new AsyncLocalStorage<RebuildBatch>()

/**
 * Run `fn` with every `rebuildFilesSelectPolicy` call inside it collapsed into
 * ONE rebuild when `fn` settles. Each app (re)install rebuilds the policy, and
 * the DDL takes an ACCESS EXCLUSIVE lock on `kernel.files`: a deploy that
 * upgrades five bundled apps used to take that lock six times in a row. Nested
 * batches join the outer one.
 */
export async function batchFilesSelectPolicyRebuild<T>(
  fn: () => Promise<T>,
  opts: FilesSelectPolicyRebuildOptions = {},
): Promise<T> {
  if (rebuildBatch.getStore()) return fn()
  const batch: RebuildBatch = { dirty: false, opts }
  let result: T
  try {
    result = await rebuildBatch.run(batch, fn)
  } finally {
    // Also after a throw: installs that landed before it still need their
    // file parents in the policy.
    if (batch.dirty) await rebuildFilesSelectPolicyNow(batch.opts)
  }
  return result
}

export async function rebuildFilesSelectPolicy(
  opts: FilesSelectPolicyRebuildOptions = {},
): Promise<FilesSelectPolicyRebuildOutcome> {
  const batch = rebuildBatch.getStore()
  if (batch) {
    batch.dirty = true
    // The batch rebuilds once at its end: from the last explicit parents, or the catalog.
    if (opts.parents) {
      batch.opts = { ...batch.opts, parents: opts.parents, catalogVersions: opts.catalogVersions }
    }
    return "deferred"
  }
  return rebuildFilesSelectPolicyNow(opts)
}

/** The uuid-join policy statement for these parents (the statement every
 *  rebuild applies first). Exposed for tests. */
export function currentFilesSelectPolicyStatement(
  parents: readonly FileParentRegistration[],
): string {
  const kernelSchema = schemaRef("kernel")
  return buildFilesSelectPolicy(
    parents.map((p) => ({ ...p, schemaRef: schemaRef(p.schemaRef) })),
    kernelSchema,
  )
}

/** One rebuild's inputs; `parents` already carry the schema prefix. */
interface PolicyBuild {
  parents: FileParentRegistration[]
  kernelSchema: string
  versions?: CatalogVersions
  legacyTextJoin: boolean
}

async function rebuildFilesSelectPolicyNow(
  opts: FilesSelectPolicyRebuildOptions,
): Promise<FilesSelectPolicyRebuildOutcome> {
  filesSelectPolicyRebuildStats.evaluated++
  let rawParents = opts.parents
  let versions = opts.catalogVersions
  if (!rawParents) {
    const catalog = await currentCatalog()
    rawParents = catalogFileParents(catalog)
    versions ??= catalogVersions(catalog)
  }
  // Apply the worker schema prefix to both the kernel schema name and each
  // parent's schemaRef so the generated SELECT policy targets the worker's
  // cloned schemas instead of the original ones.
  const build: PolicyBuild = {
    parents: rawParents.map((p) => ({ ...p, schemaRef: schemaRef(p.schemaRef) })),
    kernelSchema: schemaRef("kernel"),
    versions,
    legacyTextJoin: false,
  }
  try {
    return await applyFilesSelectPolicy(build, opts)
  } catch (err: unknown) {
    // 42883 (undefined operator) / 42804 (datatype mismatch): some parent's
    // joinOn column is not uuid-typed, so the uuid-join form doesn't type-check.
    // Fall back to the legacy text-cast join (correct, slower) rather than
    // failing boot.
    const code = pgErrorCode(err)
    if (code !== "42883" && code !== "42804") throw err
    log.warn(
      { kernelSchema: build.kernelSchema },
      "files SELECT policy uuid-join failed to type-check; falling back to text-cast join",
    )
    return applyFilesSelectPolicy({ ...build, legacyTextJoin: true }, opts)
  }
}

function pgErrorCode(err: unknown): string | undefined {
  return (
    (err as { cause?: { code?: string }; code?: string }).code ??
    (err as { cause?: { code?: string } }).cause?.code
  )
}

/**
 * The live policy's identity: command, permissive flag, roles and the
 * deparsed USING / WITH CHECK expressions, hashed in SQL. A hand edit
 * (`ALTER POLICY`) changes it even when the stored comment survives.
 */
function policyFingerprintSql(kernelSchema: string): string {
  const rel = `${quoteIdent(kernelSchema)}.files`
  return (
    "SELECT obj_description(p.oid, 'pg_policy') AS comment, md5(concat_ws('|', " +
    "p.polcmd::text, p.polpermissive::text, " +
    "(SELECT string_agg(r::regrole::text, ',' ORDER BY r::regrole::text) FROM unnest(p.polroles) r), " +
    "coalesce(pg_get_expr(p.polqual, p.polrelid), ''), " +
    "coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))) AS fingerprint " +
    `FROM pg_policy p WHERE p.polrelid = to_regclass(${quoteLiteral(rel)}) ` +
    "AND p.polname = 'files_select'"
  )
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

/** The comment stored on the policy: which generated statement produced it,
 *  and the fingerprint the policy had right after. */
function policyStamp(stmt: string, fingerprint: string): string {
  const stmtHash = createHash("sha256").update(stmt).digest("hex")
  return `liaison:files_select:v1:${stmtHash}:${fingerprint}`
}

/** The stamp plus the catalog versions the policy was built from, when known. */
function policyComment(stmt: string, fingerprint: string, versions?: CatalogVersions): string {
  const stamp = policyStamp(stmt, fingerprint)
  if (!versions) return stamp
  return `${stamp}:catalog=${Buffer.from(JSON.stringify(versions)).toString("base64url")}`
}

/** A stored comment's stamp and catalog versions (none in a comment written before them). */
function parsePolicyComment(
  comment: string | null,
): { stamp: string; versions?: CatalogVersions } | undefined {
  const m = /^(liaison:files_select:v1:[0-9a-f]+:[0-9a-f]+)(?::catalog=([A-Za-z0-9_-]+))?$/.exec(
    comment ?? "",
  )
  if (!m?.[1]) return undefined
  if (!m[2]) return { stamp: m[1] }
  return {
    stamp: m[1],
    versions: parseCatalogVersions(Buffer.from(m[2], "base64url").toString("utf8")),
  }
}

function extractRowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  return ((result as { rows?: T[] }).rows ?? []) as T[]
}

/**
 * Apply the policy for `build` unless the live policy already is its result.
 *
 * The DDL (DROP + CREATE POLICY, one transaction) needs ACCESS EXCLUSIVE on
 * `kernel.files`. Waiting for it behind a long read would queue every later
 * reader of the table behind the waiting DDL, so the transaction sets a short
 * `lock_timeout` and, on 55P03, gives the lock back, lets the readers through,
 * and retries with backoff. `ALTER POLICY` or creating the new policy before
 * dropping the old one would not help: every form of policy DDL takes the same
 * ACCESS EXCLUSIVE lock, and both halves commit together anyway.
 */
async function applyFilesSelectPolicy(
  build: PolicyBuild,
  opts: FilesSelectPolicyRebuildOptions,
): Promise<FilesSelectPolicyRebuildOutcome> {
  const { kernelSchema } = build
  const lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  let backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  for (let attempt = 1; ; attempt++) {
    try {
      const outcome = await applyFilesSelectPolicyOnce(build, lockTimeoutMs)
      if (outcome === "applied") filesSelectPolicyRebuildStats.applied++
      return outcome
    } catch (err: unknown) {
      if (pgErrorCode(err) !== "55P03") throw err
      filesSelectPolicyRebuildStats.lockTimeouts++
      if (attempt >= maxAttempts) {
        log.error(
          { kernelSchema, attempts: attempt, lockTimeoutMs },
          "files SELECT policy rebuild gave up: kernel.files lock never granted; the existing policy stays",
        )
        return "skipped"
      }
      log.warn(
        { kernelSchema, attempt, lockTimeoutMs, backoffMs },
        "files SELECT policy rebuild: kernel.files lock busy, retrying",
      )
      await new Promise((r) => setTimeout(r, backoffMs))
      backoffMs *= 2
    }
  }
}

type SystemDb = Parameters<Parameters<typeof withSystemDb>[1]>[0]

/** The parents whose table exists, read in `db`'s transaction. */
async function parentsWithTables(
  db: SystemDb,
  parents: FileParentRegistration[],
): Promise<FileParentRegistration[]> {
  if (parents.length === 0) return parents
  const names = parents.map((p) => `${quoteIdent(p.schemaRef)}.${quoteIdent(p.tableName)}`)
  const rows = extractRowsOf<{ name: string; present: boolean }>(
    await db.execute(
      drizzleSql`SELECT n AS name, to_regclass(n) IS NOT NULL AS present FROM jsonb_array_elements_text(${JSON.stringify(names)}::jsonb) AS n`,
    ),
  )
  const present = new Set(rows.filter((r) => r.present).map((r) => r.name))
  const missing = parents.filter((_, i) => !present.has(names[i] ?? ""))
  if (missing.length > 0) {
    log.info(
      { missing: missing.map((p) => `${p.app}:${p.entityType}`) },
      "files SELECT policy: parents whose table does not exist yet are left out",
    )
  }
  return parents.filter((_, i) => present.has(names[i] ?? ""))
}

/**
 * One attempt, in ONE transaction that holds the policy's advisory lock from
 * the table check to the commit. Every rebuild (the setup step, an app's
 * schema DDL in any process, the leader's check) takes it, so two rebuilds
 * never interleave: without it, a rebuild that read the tables before another
 * process created its app's table could commit after that process's rebuild
 * and drop the new parent from the policy, making its files unreadable.
 *
 * Under the lock it reads which parent tables exist, builds the statement,
 * compares it with the live policy's stamp ("unchanged": no DDL), refuses a
 * policy built from a newer catalog ("superseded"), and only then runs the DDL.
 *
 * An app's table is created (and committed) before that app's rebuild starts
 * (runtime.ts), so whichever rebuild takes the lock after it sees the table.
 */
async function applyFilesSelectPolicyOnce(
  build: PolicyBuild,
  lockTimeoutMs: number,
): Promise<FilesSelectPolicyRebuildOutcome> {
  const { kernelSchema } = build
  let parentCount = 0
  const runDdl = async (db: SystemDb): Promise<"applied" | "unchanged" | "superseded"> => {
    assertTransactionScoped(db, "files SELECT policy rebuild")
    await db.execute(drizzleSql.raw(`SET LOCAL lock_timeout = '${Math.trunc(lockTimeoutMs)}ms'`))
    await db.execute(advisoryXactLock(`files-select-policy:${kernelSchema}`))
    const parents = await parentsWithTables(db, build.parents)
    parentCount = parents.length
    const stmt = buildFilesSelectPolicy(
      parents,
      kernelSchema,
      build.legacyTextJoin ? { legacyTextJoin: true } : undefined,
    )
    const [live] = extractRowsOf<{ comment: string | null; fingerprint: string }>(
      await db.execute(drizzleSql.raw(policyFingerprintSql(kernelSchema))),
    )
    const stored = parsePolicyComment(live?.comment ?? null)
    if (live && stored?.stamp === policyStamp(stmt, live.fingerprint)) return "unchanged"
    if (build.versions && stored?.versions) {
      const newer = await supersedingApp(stored.versions, build.versions)
      if (newer) {
        log.warn(
          { kernelSchema, app: newer, stored: stored.versions[newer], ours: build.versions[newer] },
          "files SELECT policy left as is: it was built from a newer catalog than this process's",
        )
        return "superseded"
      }
    }
    await db.execute(drizzleSql.raw(stmt))
    const [after] = extractRowsOf<{ fingerprint: string }>(
      await db.execute(drizzleSql.raw(policyFingerprintSql(kernelSchema))),
    )
    if (after) {
      await db.execute(
        drizzleSql.raw(
          `COMMENT ON POLICY files_select ON ${quoteIdent(kernelSchema)}.files IS ` +
            quoteLiteral(policyComment(stmt, after.fingerprint, build.versions)),
        ),
      )
    }
    return "applied"
  }
  const report = (
    outcome: "applied" | "unchanged" | "superseded",
    how: string,
  ): FilesSelectPolicyRebuildOutcome => {
    if (outcome === "unchanged") {
      log.info({ parentCount, kernelSchema }, "files SELECT policy unchanged, no DDL")
    } else if (outcome === "applied") {
      log.info({ parentCount, kernelSchema }, `Rebuilt files SELECT policy${how}`)
    }
    return outcome
  }
  try {
    const outcome = await withSystemDb("rebuild-files-select-policy", async (db) => {
      // The cloned `kernel.files` table is owned by `liaison_app` (see the
      // E2E schema cloner). CREATE POLICY requires the relation owner, but
      // `withSystemDb` runs as `liaison_admin`. Switch to `liaison_app` for
      // the DDL — the existing transaction's SET LOCAL ROLE keeps the
      // change scoped to this rebuild.
      await db.execute(drizzleSql.raw("SET LOCAL ROLE liaison_app"))
      return runDdl(db)
    })
    return report(outcome, "")
  } catch (err: unknown) {
    // In production the migration owner (postgres superuser) owns
    // `kernel.files`, so `SET LOCAL ROLE liaison_app` may not have policy
    // ownership either. Fall back to running the DDL as the current admin
    // role — if that also fails with 42501, leave the existing policy
    // intact (it was correct at install time).
    if (pgErrorCode(err) !== "42501") throw err
    try {
      const outcome = await withSystemDb("rebuild-files-select-policy:fallback", runDdl)
      return report(outcome, " (admin fallback)")
    } catch (err2: unknown) {
      if (pgErrorCode(err2) === "42501") {
        log.warn(
          { kernelSchema },
          "files SELECT policy rebuild skipped — runtime role not the relation owner",
        )
        return "skipped"
      }
      throw err2
    }
  }
}

/**
 * The leader's check of the files SELECT policy against the catalog, on each
 * lease acquire. The setup step applies it once per deploy; this catches a
 * setup step that could not take the `kernel.files` lock ("skipped"), without
 * waiting for the next deploy. Usually "unchanged": no DDL. Never throws.
 */
export function registerFilesSelectPolicyCheck(): void {
  registerSingleton({
    name: "files-select-policy-check",
    onAcquired: () => {
      void rebuildFilesSelectPolicy()
        .then((outcome) => {
          if (outcome === "skipped") {
            log.error(
              { alert: "files_select_policy_not_applied" },
              "Leader check: the files SELECT policy could not be applied; it stays as it was",
            )
          }
        })
        .catch((err: unknown) =>
          log.error({ err }, "Leader check of the files SELECT policy failed"),
        )
    },
    onLost: () => {},
  })
}

/**
 * The durable consumers, workers and scheduled jobs of every process. It writes
 * no instance-wide derivation: the files SELECT policy and the search settings
 * come from the catalog and are applied by the locked setup step
 * (`db/reconcile-catalog-boot.ts`); the leader re-checks both on each lease
 * acquire (`registerSearchDriftCheck`, `registerFilesSelectPolicyCheck`). So a process that has registered no org
 * leaves both as they are.
 */
export async function runPhase10Boot(): Promise<void> {
  log.info("Phase 10 boot: start")

  // Tickets' unified-search enrichment hook must be registered before the
  // indexer consumer below — a job processed before registration would build
  // a document with no enrichment text (the hook is consulted synchronously
  // inside buildSearchDocument at upsert time, not re-checked later).
  registerTicketsSearchEnrichment()
  registerMailSearchEnrichment()
  // Register the rebuild worker BEFORE drift detection: drift may enqueue
  // `search-reindex-full`, which requires the handler to already exist.
  registerIndexerConsumer()
  // Thread messages have their own indexer: they are not a registered
  // searchable entity, so the entity indexer above drops their events.
  registerMessageIndexerConsumer()
  // Mail messages are indexed as fragments of their conversation.
  registerMailFragmentConsumer()
  registerTranslatorConsumer()
  // New-email attention items (S15/S16), from the mail app's message:create.
  registerMailProducerConsumer()
  registerReindexWorker()
  registerThumbnailJobWorker()
  registerThumbnailEventBridge()
  registerDeleteObjectWorker()
  registerDeleteObjectDurableConsumer()
  // A committed connection disconnect revokes its staged OAuth grant (revoke.ts).
  registerRevokeOnDisconnectConsumer()
  registerThumbnailDurableConsumer()
  // Guided tours advance on product events. LAST of the durable consumers: it
  // reads what the others committed and never throws (modules/tours/consumer.ts).
  registerTourProgressConsumer()
  // Demo scenarios' world beats run when their owner reaches one: after
  // tour-progress, whose moves it reads. Never throws (modules/demo/world).
  registerDemoWorldConsumer()
  // Media-analysis slow-path job + transfer-link auto-download worker. Both must
  // be registered before any enqueueAppJob for their names runs (enqueueAppJob
  // throws "No handler registered" otherwise).
  registerMediaAnalysisJobWorker()
  registerLinkIngestJobWorker()
  // Recorded demo node sessions continue where they stopped, on the leader
  // (a singleton hook: armed when this process takes the leader lease).
  registerReplayResumeSingleton()
  // Demo mode: the spend boot check logs, per process, why visitor spend is
  // off (the owner alert's mail channel was wired in index.ts, before any org
  // runtime). The pinned price check (it reads the provider's catalogue) and
  // its 6 h interval are the leader's, off the boot path.
  if (isDemoModeEnabled()) {
    void demoSpendBootCheck().catch((err) =>
      log.error({ err, alert: "demo_spend_boot_check_failed" }, "demo spend boot check failed"),
    )
    registerDemoPriceCheckSingleton(visitorPinUpstreamId())
  }
  log.info("Phase 10 boot: durable consumers + workers registered")

  // Read only: is there a built index to serve from. The drift check (and any
  // rebuild it schedules) is the leader's, on the catalog's inputs.
  await primeSearchSettings()
  registerSearchDriftCheck()
  // The leader re-checks the files SELECT policy against the catalog: the
  // fallback when the setup step could not apply it.
  registerFilesSelectPolicyCheck()
  log.info("Phase 10 boot: search readiness probed, drift check armed on the leader")

  await registerStateMaterializerScheduledJob()
  log.info("Phase 10 boot: state materializer registered")
  await registerDigestScheduledJobs()
  log.info("Phase 10 boot: digest jobs registered")
  await registerOrphanGcScheduledJob()
  await registerImportUploadReaper()
  void warnOnImportUploadCors()
  log.info("Phase 10 boot: orphan gc registered")
}
