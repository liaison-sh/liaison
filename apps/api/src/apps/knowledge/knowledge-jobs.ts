// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge scheduled jobs + sync worker.
 *
 * - Tick every minute: pick due synced sources and enqueue a `sync-source` job
 *   for each, using `jobId: "sync:<sourceId>"` so concurrent enqueues collapse
 *   onto a single execution (M-5).
 * - `sync-source` worker: loads the source, refuses force-on-open by a
 *   non-owner of a personal source (H-1), resolves the adapter, and runs
 *   `reconcileSyncedSource`.
 *
 * Structure: the heavy lifting lives in `tickEnqueueDueSources(enqueue)` and
 * `runSyncWorker(payload, deps)` so tests can drive the production logic
 * without booting BullMQ or a real Drive client. The exported
 * `registerKnowledgeJobs()` is just the wiring that hands those functions to
 * BullMQ at boot.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { resolveDatabaseCatalog } from "~/apps/database/bridge"
import { createDatabaseKnowledgeAdapter } from "~/apps/database/knowledge-adapter"
import { createDatabaseKnowledgeReadRunner } from "~/apps/database/knowledge-read-runner"
import { createGitlabAdapter } from "~/apps/gitlab/adapter"
import { makeGitlabFetchers } from "~/apps/gitlab/gitlab-rest"
import { createGoogleDriveAdapter } from "~/apps/google-drive/adapter"
import { makeDriveFetchers } from "~/apps/google-drive/drive-rest"
import { loadPickedItems } from "~/apps/google-drive/picker"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import type { KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { KNOWLEDGE_SOURCE_READ_SCOPE } from "~/apps/knowledge/source-registry"
import { reconcileSyncedSource } from "~/apps/knowledge/sync-reconciler"
import {
  type SyncedSourceDbRow,
  rowFromDb as syncedSourceRowFromDb,
} from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import {
  createAppQueue,
  enqueueAppJob,
  registerJobWorker,
  registerScheduledJob,
} from "~/infra/jobs/jobs"
import { jobsLogger as log } from "~/lib/logger"
import { isDemoOrgId } from "~/modules/demo/demo-org"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"
import { movingOrgIds } from "~/modules/org/transfer-state/state"

export type SyncJobTrigger = "schedule" | "force-on-open"

export interface SyncJobPayload {
  sourceId: string
  trigger: SyncJobTrigger
  /** User who triggered force-on-open (omitted for scheduler ticks). */
  enqueuedBy?: string
}

// `DueSourceRow` + `rowToSyncedSource` previously lived here; both moved to
// `synced-sources.ts` (exported as `SyncedSourceDbRow` + `rowFromDb`) so the
// scheduler and the route layer share one mapper and one shape.
type DueSourceRow = SyncedSourceDbRow
const rowToSyncedSource = syncedSourceRowFromDb

/**
 * A synced source keeps using the connected account's credential on every
 * tick, long after it was created. The credential may be an org-owned one that
 * every member could otherwise reach only through the source app's own scope,
 * so the owner's CURRENT scopes are re-checked before each fetch: a user who
 * has lost (or never held) the source app's read scope no longer syncs through
 * it.
 */
async function assertOwnerMaySyncFrom(
  app: keyof typeof KNOWLEDGE_SOURCE_READ_SCOPE,
  orgId: string,
  userId: string,
): Promise<void> {
  const { loadEffectivePermissions, hasScope } = await import("~/modules/permissions/permissions")
  const effective = await withSystemDb("knowledge-sync-owner-scopes", (db) =>
    loadEffectivePermissions(db, userId, orgId),
  )
  if (!hasScope(KNOWLEDGE_SOURCE_READ_SCOPE[app], effective.scopes)) {
    throw new Error(
      `FORBIDDEN: the source owner no longer holds ${KNOWLEDGE_SOURCE_READ_SCOPE[app]}`,
    )
  }
}

/**
 * Resolve the adapter for a given app name + actor. Supports google-drive,
 * gitlab, and database; additional providers can be added here without
 * touching the worker.
 */
function resolveAdapter(
  appName: string,
  source: {
    orgId: string
    ownerUserId: string | null
    createdBy: string
    sourceAccount?: string | null
  },
): KnowledgeSourceAdapter {
  if (appName === "google-drive") {
    const userId = source.ownerUserId ?? source.createdBy
    const getAccess = async () => {
      await assertOwnerMaySyncFrom("google-drive", source.orgId, userId)
      const { driveSourceOwnerOf, resolveDriveAccess } = await import(
        "~/apps/google-drive/drive-access"
      )
      // Privileged db to fetch the OAuth token; the connections service uses the
      // orgId we pass. Token fetch errors map to listFolder/fetchRemoteContent
      // errors in the adapter. The folder syncs from the Drive account recorded
      // when it was added, never silently from another account of the same user,
      // and only within that account's read scope (an org account: the shared
      // drives an admin chose, drive-scope.ts).
      return withSystemDb("knowledge-sync-token", (db) =>
        resolveDriveAccess(db, source.orgId, userId, {
          ...(source.sourceAccount ? { identifier: source.sourceAccount } : {}),
          // One Google account may hold an org row AND a member's own row: an
          // org folder reads through the org's, a personal one its owner's.
          sourceOwner: driveSourceOwnerOf(source),
        }),
      )
    }
    const getToken = async (): Promise<string> => (await getAccess()).token
    const fetchers = makeDriveFetchers(getAccess)
    // The picked-items root (drive-mode.ts) lists what the person picked on
    // this source's Drive account.
    const getPickedItems = async () =>
      source.sourceAccount
        ? loadPickedItems(source.orgId, source.sourceAccount, source.ownerUserId)
        : []
    return createGoogleDriveAdapter({ getToken, ...fetchers, getPickedItems })
  }
  if (appName === "gitlab") {
    const userId = source.ownerUserId ?? source.createdBy
    const loadCreds = async (): Promise<Record<string, string>> => {
      await assertOwnerMaySyncFrom("gitlab", source.orgId, userId)
      return withSystemDb("knowledge-sync-gitlab-token", async (db) => {
        const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
        return getCredentialsForConnection(
          db,
          source.orgId,
          userId,
          "gitlab",
          "gitlab",
          undefined,
          {
            actorType: "system",
          },
        )
      })
    }
    const getToken = async (): Promise<string> => String((await loadCreds()).token)
    const resolveDefaultGroupId = async (): Promise<string | undefined> => {
      try {
        const group = (await loadCreds()).group
        return group ? String(group) : undefined
      } catch {
        return undefined
      }
    }
    const client = makeGitlabFetchers(getToken)
    return createGitlabAdapter({ client, resolveDefaultGroupId })
  }
  if (appName === "database") {
    const userId = source.ownerUserId ?? source.createdBy
    // `createDatabaseKnowledgeReadRunner` wants a live `RlsClient`/`PrivilegedDb`
    // for its (lazy, per-call) credential lookup inside `runRead`. The job has
    // no ambient request tx, so build a fresh runner inside `withSystemDb` on
    // every `runRead` call, mirroring the gitlab branch's per-call
    // `withSystemDb` wrapping. Catalog resolution (`resolveDatabaseCatalog`) is
    // synchronous and tx-independent, so `hasRead` is answered directly off it
    // without needing any DB handle at all.
    const hasRead = (name: string): boolean => {
      try {
        return Boolean(resolveDatabaseCatalog().reads[name])
      } catch {
        return false
      }
    }
    const runRead = async (
      name: string,
      params: Record<string, unknown>,
    ): Promise<{ rows: Record<string, unknown>[] }> =>
      withSystemDb("knowledge-sync-database-read", (db) =>
        createDatabaseKnowledgeReadRunner({ tx: db as never, orgId: source.orgId, userId }).runRead(
          name,
          params,
        ),
      )
    return createDatabaseKnowledgeAdapter({ runRead, hasRead })
  }
  throw new Error(`No adapter registered for app: ${appName}`)
}

// ---------------------------------------------------------------------------
// Testable seams — these are the actual algorithm. registerKnowledgeJobs is
// just the BullMQ wiring around them.
// ---------------------------------------------------------------------------

export type EnqueueFn = (
  app: "knowledge",
  jobName: "sync-source",
  data: SyncJobPayload,
  opts: { jobId: string },
) => Promise<string>

/**
 * Scheduler-tick body. Selects due sources from the DB and enqueues a
 * `sync-source` job for each, **always** with `jobId: sync:<id>` so concurrent
 * enqueues collapse onto one worker run (M-5).
 *
 * Exposed for tests so they can call this directly with a capturing
 * `enqueue` and assert the exact set of enqueued sources + their jobIds —
 * rather than reproducing the SELECT inline.
 */
export async function tickEnqueueDueSources(enqueue: EnqueueFn): Promise<number> {
  const due = await fetchDueSyncedSourcesSystem()
  for (const s of due) {
    await writeUnlessMoving(s.orgId, () =>
      enqueue(
        "knowledge",
        "sync-source",
        { sourceId: s.id, trigger: "schedule" },
        { jobId: `sync:${s.id}` },
      ),
    )
  }
  return due.length
}

async function defaultGate(source: ReturnType<typeof rowToSyncedSource>): Promise<"sync" | "skip"> {
  // An owner who may no longer sync from Drive reads nothing here either: the
  // sync then fails on the same check, as before.
  try {
    await assertOwnerMaySyncFrom(
      "google-drive",
      source.orgId,
      source.ownerUserId ?? source.createdBy,
    )
  } catch {
    return "sync"
  }
  const { gateDriveSourceSync } = await import("~/apps/google-drive/org-drive-content")
  return gateDriveSourceSync(source)
}

export interface RunSyncWorkerDeps {
  /** Decides whether a Drive folder may sync (tests stub it). Production: gateDriveSourceSync. */
  gate?: (source: ReturnType<typeof rowToSyncedSource>) => Promise<"sync" | "skip">
  /**
   * Resolve an adapter for the given app. Tests inject a stub that doesn't
   * touch OAuth or real Drive. Production uses {@link resolveAdapter}.
   */
  resolveAdapter?: (
    appName: string,
    source: { orgId: string; ownerUserId: string | null; createdBy: string },
  ) => KnowledgeSourceAdapter
  /**
   * Run a reconciliation. Tests inject a spy so they can assert "was this
   * source actually reconciled?" without needing a real DB-writing pass.
   * Production uses {@link reconcileSyncedSource}.
   */
  reconcile?: (
    source: ReturnType<typeof rowToSyncedSource>,
    adapter: KnowledgeSourceAdapter,
  ) => Promise<unknown>
}

/**
 * Worker body. Loads the source, enforces the H-1 personal-owner check, and
 * dispatches to the reconciler.
 *
 * @throws Error with message starting `FORBIDDEN` when force-on-open is
 *         attempted by a non-owner of a personal source.
 */
export async function runSyncWorker(
  payload: SyncJobPayload,
  deps: RunSyncWorkerDeps = {},
): Promise<void> {
  const source = await loadSyncedSourceForWorker(payload.sourceId)
  if (!source) {
    log.warn({ sourceId: payload.sourceId }, "sync-source: source vanished")
    return
  }
  if (source.archivedAt) {
    log.info({ sourceId: source.id }, "sync-source: source archived; skipping")
    return
  }
  // A demo workspace reaches no provider and holds no connected account: its
  // sources were synced once, from fixtures, when the demo world was seeded.
  // A tick or a document's force-on-open leaves them as they are, rather than
  // failing on the missing account and stamping the source as broken.
  if (await isDemoOrgId(source.orgId)) {
    log.debug({ sourceId: source.id }, "sync-source: demo workspace; nothing to sync")
    return
  }
  // The job carries no org, so the transfer hold never sees it: a source of an
  // org being moved is left alone (the next tick picks it up after the move).
  if ((await movingOrgIds()).includes(source.orgId)) {
    log.info({ sourceId: source.id }, "sync-source: org is being moved; skipping")
    return
  }
  // H-1 / C1 worker-side defense in depth: force-on-open jobs carry the
  // enqueuing user's id. Personal sources only honor force-syncs from the
  // owner. Scheduler ticks (no enqueuedBy) bypass this check.
  if (
    payload.trigger === "force-on-open" &&
    source.ownerUserId != null &&
    payload.enqueuedBy !== source.ownerUserId
  ) {
    log.warn(
      {
        sourceId: source.id,
        enqueuedBy: payload.enqueuedBy,
        ownerUserId: source.ownerUserId,
      },
      "force-on-open by non-owner of personal source — refusing",
    )
    throw new Error("FORBIDDEN: personal synced source forced by non-owner")
  }
  // A Drive folder that syncs through an ORGANIZATION connection stays within
  // the shared drives an admin chose: with none chosen its content is hidden,
  // outside them it is removed, and nothing syncs (org-drive-content.ts).
  if (source.appName === "google-drive" && (await (deps.gate ?? defaultGate)(source)) === "skip") {
    log.info({ sourceId: source.id }, "sync-source: org Drive folder outside its shared drives")
    return
  }
  const adapter = (deps.resolveAdapter ?? resolveAdapter)(source.appName, source)
  try {
    await (deps.reconcile ?? reconcileSyncedSource)(source, adapter)
  } catch (err) {
    // The reconciler has already stamped the failure on the source (status,
    // last_error, last_sync_at), which is what the UI shows and what schedules
    // the next attempt one interval later. An upstream that is slow or down is
    // expected weather for a sync: rethrowing it made BullMQ rerun the whole
    // walk three times at once and log each attempt at error, so one provider
    // hiccup across a few sources read as an error-rate spike.
    if (isTransientUpstreamSyncError(err)) {
      log.warn(
        { err, sourceId: source.id, appName: source.appName },
        "sync-source: upstream unavailable; recorded on the source, retried next interval",
      )
      return
    }
    throw err
  }
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ConnectionRefused",
  "ConnectionClosed",
])

/**
 * A failure of the remote side rather than of the sync: a timed out or aborted
 * request, a dropped connection, a rate limit or a 5xx. A 4xx such as a revoked
 * token is not transient and still fails the job.
 */
export function isTransientUpstreamSyncError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { name?: unknown; code?: unknown; status?: unknown }
  if (e.name === "TimeoutError" || e.name === "AbortError") return true
  if (typeof e.code === "string" && TRANSIENT_NETWORK_CODES.has(e.code)) return true
  if (typeof e.status === "number" && (e.status === 429 || e.status >= 500)) return true
  return false
}

/**
 * Watchdog threshold: sources stuck in 'running' longer than this are
 * considered stale (process crash mid-sync) and reset to 'error'.
 */
const STALE_RUNNING_THRESHOLD_MINUTES = 30

/**
 * Reset synced sources that have been stuck in 'running' past the watchdog
 * threshold. A crash mid-reconcile leaves the source in 'running' indefinitely
 * because the catch block in reconcileSyncedSource never executed.
 *
 * Exported for testing.
 */
export async function reclaimStaleRunningSources(): Promise<number> {
  // An org being moved keeps its sources as they are until the move ends.
  const result = await sweepSkippingMoving((notMoving) =>
    withSystemDb("knowledge-stale-running-reclaim", (db) =>
      db.execute(drizzleSql`
      UPDATE ${knowledgeRel("synced_sources")}
      SET last_sync_status = 'error',
          last_error = 'Sync watchdog: process did not complete within the expected window',
          updated_at = now()
      WHERE archived_at IS NULL
        AND ${notMoving(drizzleSql.raw("org_id"))}
        AND last_sync_status = 'running'
        AND updated_at < now() - interval '${drizzleSql.raw(String(STALE_RUNNING_THRESHOLD_MINUTES))} minutes'
      RETURNING id
    `),
    ),
  )
  const count = extractRows<{ id: string }>(result).length
  if (count > 0) {
    log.warn({ count }, "Reclaimed stale-running synced sources")
  }
  return count
}

let knowledgeJobsRegistered = false

/**
 * Register Knowledge synced-source scheduled jobs + workers. Idempotent; safe
 * to call once at server boot.
 */
export async function registerKnowledgeJobs(opts: RunSyncWorkerDeps = {}): Promise<void> {
  if (knowledgeJobsRegistered) return
  knowledgeJobsRegistered = true

  createAppQueue("knowledge")

  // Tick every minute. The 60s sync_interval_seconds floor + this tick rate
  // means the effective minimum cadence is ~120s.
  await registerScheduledJob("knowledge", "synced-sources-tick", "*/1 * * * *", async () => {
    const count = await tickEnqueueDueSources(enqueueAppJob)
    if (count > 0) {
      log.debug({ count }, "Knowledge sync tick enqueued sources")
    }
  })

  // Sweep stale-running sources every 5 minutes. This resets sources that were
  // left in 'running' by a process crash so the next scheduler tick picks them
  // up again.
  await registerScheduledJob("knowledge", "stale-running-reclaim", "*/5 * * * *", async () => {
    await reclaimStaleRunningSources()
  })

  registerJobWorker<SyncJobPayload>("knowledge", "sync-source", async (payload) => {
    await runSyncWorker(payload, opts)
  })

  log.info("Knowledge synced-sources tick + worker registered")
}

/**
 * Cross-org row loader for the worker. **CAUTION:** returns rows from ANY
 * organization — the worker is the only caller and it scopes every subsequent
 * write to `source.orgId`. Do NOT call this from a route handler; use
 * `loadSyncedSource(tx, id, actor)` (RLS-scoped, in `synced-sources.ts`)
 * instead, or `loadSyncedSourceForOrgSystem(orgId, id)` below if you genuinely
 * need a privileged read scoped to a specific org.
 */
export async function loadSyncedSourceForWorker(id: string) {
  const rows = extractRows<DueSourceRow>(
    await withSystemDb("knowledge-sync-load", (db) =>
      db.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("synced_sources")}
        WHERE id = ${id}::uuid
        LIMIT 1
      `),
    ),
  )
  return rows[0] ? rowToSyncedSource(rows[0]) : null
}

/**
 * Privileged read scoped to one org. Use when a non-worker callsite needs
 * to bypass RLS but the orgId is known up-front (e.g. background sweepers).
 */
export async function loadSyncedSourceForOrgSystem(orgId: string, id: string) {
  const rows = extractRows<DueSourceRow>(
    await withSystemDb("knowledge-sync-load-org", (db) =>
      db.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("synced_sources")}
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
        LIMIT 1
      `),
    ),
  )
  return rows[0] ? rowToSyncedSource(rows[0]) : null
}

/**
 * Scheduler-side fetcher of due sources. Excludes archived + currently-running
 * rows, and excludes rows whose last_sync_at is too recent. Exported for the
 * scheduler tick (above) and for tests that want to assert "which sources
 * would the next tick pick up?" without driving the enqueue layer.
 */
export async function fetchDueSyncedSourcesSystem() {
  // An org being moved keeps its sources as they are until the move ends.
  const rows = extractRows<DueSourceRow>(
    await sweepSkippingMoving((notMoving) =>
      withSystemDb("knowledge-sync-due", (db) =>
        db.execute(drizzleSql`
        SELECT * FROM ${knowledgeRel("synced_sources")}
        WHERE archived_at IS NULL
          AND ${notMoving(drizzleSql.raw("org_id"))}
          AND last_sync_status IN ('idle', 'ok', 'error')
          AND (
            last_sync_at IS NULL
            OR last_sync_at + (sync_interval_seconds * interval '1 second') < now()
          )
        ORDER BY last_sync_at NULLS FIRST
      `),
      ),
    ),
  )
  return rows.map(rowToSyncedSource)
}
