// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * app-sources.ts: knowledge sources an app declares, synced page by page.
 *
 * An app declares source kinds in its manifest (`knowledgeSources.<kind>`:
 * title, handler, readScope, configSchema, timeoutMs). A synced source of such
 * a kind (`synced_sources.source_kind`) is synced by the Knowledge job
 * (knowledge-jobs.ts) through `runAppSourceSync`: it wakes the kind's handler in
 * the app's sandbox with `{ sourceId, kind, config, cursor }` and receives one
 * page `{ documents: { upsert, delete }, nextCursor, done, prune? }`.
 *
 * - Each page is written in ONE privileged transaction together with the new
 *   cursor, behind a compare-and-set on `sync_generation`: a page is applied
 *   once, a crash before its commit leaves the previous cursor (the next run
 *   asks for the same page again), and of two concurrent runs only one applies.
 * - A job runs pages while it has budget (`APP_SOURCE_LIMITS`), then hands the
 *   rest to a continuation job; one page is one run, bounded by the
 *   "knowledge-sync" row of the run-limit table (modules/apps/run-limits.ts).
 * - A pass starts when a sync begins with no pass open (`sync_pass_started_at`)
 *   and ends on `done`. The cursor of the final page is kept: the next pass
 *   starts from it (an incremental sync), or from null when the app returns
 *   none. `prune: true` on the final page archives the source's documents the
 *   pass did not upsert (a full listing).
 * - Provenance is the folder sources' own: `source_identities` per external id
 *   (source = the app's name), documents carrying `synced_source_id` and
 *   `source_identity_id`, in the source's root collection.
 *
 * The in-tree folder adapters (source-registry.ts) keep their own path:
 * a source with no `source_kind` never comes here.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, KnowledgeError } from "~/apps/knowledge/service"
import {
  reparentMembership,
  upsertSourceIdentity,
  upsertSyncedDocument,
} from "~/apps/knowledge/sync-reconciler"
import type { SyncedSourceRow } from "~/apps/knowledge/synced-sources"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { jobsLogger as log } from "~/lib/logger"
import {
  type KnowledgeSourceKindDecl,
  knowledgeSourceKindRegistry,
} from "~/modules/apps/app-registries"
import { createParamValidatorCache } from "~/modules/apps/param-validator"
import { hasScope } from "~/modules/permissions/permissions"

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** What one page may carry, and how much one sync job may do before it hands over. */
export const APP_SOURCE_LIMITS = {
  /** Documents upserted by one page. */
  maxUpserts: 200,
  /** External ids deleted by one page. */
  maxDeletes: 1_000,
  /** One document's body, in characters. */
  maxBodyChars: 1_000_000,
  /** An external id, in characters. */
  maxExternalIdChars: 512,
  /** The cursor, as JSON. */
  maxCursorBytes: 16_384,
  /** Pages one job runs before it hands the rest to a continuation. */
  maxPagesPerJob: 25,
  /** No new page starts in a job after this much of its time. */
  jobBudgetMs: 60_000,
}

export type AppSourceLimits = typeof APP_SOURCE_LIMITS

/** One document an app source returns. */
export interface AppSourceDocument {
  /** The provider's stable id: the document's identity across syncs. */
  externalId: string
  title: string
  /** The document's text (markdown or plain text). */
  body: string
  url?: string
  mimeType?: string
  modifiedAt?: string
  /** The provider's revision (etag, commit, version): kept as the document's external revision. */
  rev?: string
  /** A path to show for the document; its title when absent. */
  path?: string
}

/** One page, parsed and checked. */
export interface AppSourcePage {
  upserts: AppSourceDocument[]
  deletes: string[]
  nextCursor: unknown
  done: boolean
  prune: boolean
}

/** The input of one page's run, handed to the app's handler. */
export interface AppSourceSyncInput {
  sourceId: string
  kind: string
  config: Record<string, unknown>
  cursor: unknown
}

/** A page the app returned that breaks the contract: the sync records it and writes nothing. */
export class AppSourceContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AppSourceContractError"
  }
}

/** Another run applied a page first: this run stops and writes nothing. */
export class AppSourceConflictError extends Error {
  constructor(sourceId: string) {
    super(`another sync of source ${sourceId} moved its cursor first`)
    this.name = "AppSourceConflictError"
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

function optionalString(doc: Record<string, unknown>, key: string, at: string): string | undefined {
  const v = doc[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw new AppSourceContractError(`${at}.${key} must be a string`)
  return v
}

/** Check one page against the contract and the limits. */
export function parseSyncResult(
  raw: unknown,
  limits: AppSourceLimits = APP_SOURCE_LIMITS,
): AppSourcePage {
  if (!isObject(raw)) throw new AppSourceContractError("a sync page must be an object")
  if (typeof raw.done !== "boolean") throw new AppSourceContractError("done must be a boolean")
  const documents = raw.documents === undefined ? {} : raw.documents
  if (!isObject(documents)) throw new AppSourceContractError("documents must be an object")
  const upsertRaw = documents.upsert ?? []
  const deleteRaw = documents.delete ?? []
  if (!Array.isArray(upsertRaw)) throw new AppSourceContractError("documents.upsert must be a list")
  if (!Array.isArray(deleteRaw)) throw new AppSourceContractError("documents.delete must be a list")
  if (upsertRaw.length > limits.maxUpserts) {
    throw new AppSourceContractError(
      `documents.upsert has ${upsertRaw.length} documents, at most ${limits.maxUpserts} per page`,
    )
  }
  if (deleteRaw.length > limits.maxDeletes) {
    throw new AppSourceContractError(
      `documents.delete has ${deleteRaw.length} ids, at most ${limits.maxDeletes} per page`,
    )
  }
  const checkId = (v: unknown, at: string): string => {
    if (typeof v !== "string" || v.length === 0 || v.length > limits.maxExternalIdChars) {
      throw new AppSourceContractError(
        `${at} must be a non-empty string of at most ${limits.maxExternalIdChars} characters`,
      )
    }
    return v
  }
  const upserts: AppSourceDocument[] = []
  const seen = new Set<string>()
  upsertRaw.forEach((doc, i) => {
    const at = `documents.upsert[${i}]`
    if (!isObject(doc)) throw new AppSourceContractError(`${at} must be an object`)
    const externalId = checkId(doc.externalId, `${at}.externalId`)
    if (seen.has(externalId)) {
      throw new AppSourceContractError(`${at}.externalId "${externalId}" appears twice in the page`)
    }
    seen.add(externalId)
    if (typeof doc.title !== "string" || doc.title.trim().length === 0) {
      throw new AppSourceContractError(`${at}.title must be a non-empty string`)
    }
    if (typeof doc.body !== "string")
      throw new AppSourceContractError(`${at}.body must be a string`)
    if (doc.body.length > limits.maxBodyChars) {
      throw new AppSourceContractError(
        `${at}.body has ${doc.body.length} characters, at most ${limits.maxBodyChars}`,
      )
    }
    const url = optionalString(doc, "url", at)
    const mimeType = optionalString(doc, "mimeType", at)
    const modifiedAt = optionalString(doc, "modifiedAt", at)
    const rev = optionalString(doc, "rev", at)
    const path = optionalString(doc, "path", at)
    if (modifiedAt !== undefined && Number.isNaN(Date.parse(modifiedAt))) {
      throw new AppSourceContractError(`${at}.modifiedAt must be an ISO date`)
    }
    upserts.push({
      externalId,
      title: doc.title,
      body: doc.body,
      ...(url !== undefined ? { url } : {}),
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
      ...(rev !== undefined ? { rev } : {}),
      ...(path !== undefined ? { path } : {}),
    })
  })
  const deletes = deleteRaw.map((v, i) => checkId(v, `documents.delete[${i}]`))
  const both = deletes.find((id) => seen.has(id))
  if (both) {
    throw new AppSourceContractError(`"${both}" is both upserted and deleted in one page`)
  }
  const nextCursor = raw.nextCursor === undefined ? null : raw.nextCursor
  let cursorJson: string | undefined
  try {
    cursorJson = JSON.stringify(nextCursor)
  } catch {
    throw new AppSourceContractError("nextCursor must be JSON")
  }
  if (cursorJson === undefined) throw new AppSourceContractError("nextCursor must be JSON")
  if (Buffer.byteLength(cursorJson) > limits.maxCursorBytes) {
    throw new AppSourceContractError(`nextCursor is larger than ${limits.maxCursorBytes} bytes`)
  }
  if (!raw.done && nextCursor === null) {
    throw new AppSourceContractError("a page that is not done must return a nextCursor")
  }
  if (raw.prune !== undefined && typeof raw.prune !== "boolean") {
    throw new AppSourceContractError("prune must be a boolean")
  }
  return {
    upserts,
    deletes,
    nextCursor: JSON.parse(cursorJson),
    done: raw.done,
    prune: raw.done && raw.prune === true,
  }
}

// ---------------------------------------------------------------------------
// Kinds: lookup and the checks at creation
// ---------------------------------------------------------------------------

/** The kind an app declares for an org, or null. */
export function findAppSourceKind(
  orgId: string,
  appName: string,
  kind: string,
): KnowledgeSourceKindDecl | null {
  return knowledgeSourceKindRegistry.get([orgId, appName])?.kinds[kind] ?? null
}

/**
 * Check a new app source before it is stored: the app declares the kind for
 * the actor's org, the actor holds the kind's read scope, and the config
 * matches its configSchema. Returns the config (defaults filled in).
 */
export function checkAppSourceKind(
  actor: KnowledgeActor,
  appName: string,
  kind: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const decl = findAppSourceKind(actor.orgId, appName, kind)
  if (!decl) {
    throw new KnowledgeError(
      "SOURCE_NOT_ENABLED",
      `${appName} offers no knowledge source "${kind}" here; install or enable the app first`,
    )
  }
  if (decl.readScope && !hasScope(decl.readScope, actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", `Missing ${decl.readScope}`)
  }
  if (!isObject(config)) throw new KnowledgeError("VALIDATION", "config must be an object")
  if (decl.configSchema) {
    const validate = configValidator(decl.configSchema)
    const value = structuredClone(config)
    if (!validate(value)) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
        .join("; ")
      throw new KnowledgeError("VALIDATION", `config: ${detail}`)
    }
    return value
  }
  return config
}

/** A kind's config check, compiled once per schema; fills the schema's defaults in. */
const configValidator = createParamValidatorCache({ allErrors: true, useDefaults: true })

/** The app source kinds of the actor's org that the actor may create a source of. */
export function listAppSourceKinds(actor: KnowledgeActor): Array<{
  appName: string
  kind: string
  title: string
  description?: string
  configSchema?: Record<string, unknown>
}> {
  const out: ReturnType<typeof listAppSourceKinds> = []
  for (const [key, entry] of knowledgeSourceKindRegistry.entriesOf(actor.orgId)) {
    const appName = key[1]
    if (key[0] !== actor.orgId || !appName) continue
    for (const [kind, decl] of Object.entries(entry.kinds)) {
      if (decl.readScope && !hasScope(decl.readScope, actor.scopes)) continue
      out.push({
        appName,
        kind,
        title: decl.title,
        ...(decl.description ? { description: decl.description } : {}),
        ...(decl.configSchema ? { configSchema: decl.configSchema } : {}),
      })
    }
  }
  return out.sort((a, b) => `${a.appName}:${a.kind}`.localeCompare(`${b.appName}:${b.kind}`))
}

// ---------------------------------------------------------------------------
// Persisted state: where the source's sync stands
// ---------------------------------------------------------------------------

export interface AppSourceState {
  cursor: unknown
  /** Bumped by every applied page: the compare-and-set token. */
  generation: number
  /** When the open pass started (ISO), or null between passes. */
  passStartedAt: string | null
}

export interface AppliedPage {
  state: AppSourceState
  upserted: number
  archived: number
}

/** Where the sync reads and writes; the database in production, memory in unit tests. */
export interface AppSourceStore {
  /** Mark the source running, open a pass when none is open, and read its state. */
  beginAppSourcePass(source: SyncedSourceRow): Promise<AppSourceState>
  /**
   * Write one page and its cursor in one transaction, only while the source is
   * still at `from.generation` (else AppSourceConflictError, nothing written).
   * A done page closes the pass and stamps the source ok.
   */
  applyAppSourcePage(
    source: SyncedSourceRow,
    from: AppSourceState,
    page: AppSourcePage,
  ): Promise<AppliedPage>
  /** Stamp a failed sync (cursor and pass kept: the next sync resumes). */
  failAppSourceSync(source: SyncedSourceRow, message: string): Promise<void>
}

const toIso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v)

/** Mark the source running and open a pass when none is open (the database store's begin). */
async function beginAppSourcePass(source: SyncedSourceRow): Promise<AppSourceState> {
  const rows = extractRows<{
    sync_cursor: unknown
    sync_generation: number | null
    sync_pass_started_at: Date | string | null
  }>(
    await withPrivilegedDb(source.orgId, "knowledge-app-source-begin", (tx) =>
      tx.execute(drizzleSql`
          UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_status = 'running',
              sync_pass_started_at = COALESCE(
                sync_pass_started_at, date_trunc('milliseconds', now())
              ),
              updated_at = now()
          WHERE id = ${source.id}::uuid AND org_id = ${source.orgId}::uuid
          RETURNING sync_cursor, sync_generation, sync_pass_started_at
        `),
    ),
  )
  const row = rows[0]
  if (!row) throw new KnowledgeError("NOT_FOUND", `synced source ${source.id} not found`)
  return {
    cursor: row.sync_cursor ?? null,
    generation: Number(row.sync_generation ?? 0),
    passStartedAt: toIso(row.sync_pass_started_at),
  }
}

/** Write one page and its cursor behind the generation compare-and-set (the database store's applyPage). */
async function applyAppSourcePage(
  source: SyncedSourceRow,
  from: AppSourceState,
  page: AppSourcePage,
): Promise<AppliedPage> {
  return withPrivilegedDb(source.orgId, "knowledge-app-source-page", async (tx) => {
    // The compare-and-set first: it locks the source row, so a concurrent
    // run waits here and then finds the generation moved.
    const cursorJson = JSON.stringify(page.nextCursor ?? null)
    const moved = extractRows<{ sync_generation: number; at: Date | string }>(
      await tx.execute(drizzleSql`
          UPDATE ${knowledgeRel("synced_sources")}
          SET sync_cursor = ${cursorJson}::jsonb,
              sync_generation = sync_generation + 1,
              ${
                page.done
                  ? drizzleSql`sync_pass_started_at = NULL,
              last_sync_at = now(),
              last_sync_status = 'ok',
              last_error = NULL,`
                  : drizzleSql``
              }
              updated_at = now()
          WHERE id = ${source.id}::uuid
            AND org_id = ${source.orgId}::uuid
            AND sync_generation = ${from.generation}
          RETURNING sync_generation, now() AS at
        `),
    )
    if (!moved[0]) throw new AppSourceConflictError(source.id)
    const at = new Date(toIso(moved[0].at) ?? Date.now())
    const upserted = await writeUpserts(tx, source, page.upserts, at)
    const archivedIds = await archiveByExternalIds(tx, source, page.deletes)
    if (page.done && page.prune && from.passStartedAt) {
      archivedIds.push(...(await archiveNotSyncedSince(tx, source, from.passStartedAt)))
    }
    for (const id of archivedIds) {
      await tx.queueEvent({
        app: "knowledge",
        entity: "document",
        action: "archive",
        entityId: id,
        data: { id, syncedSourceId: source.id },
        actorId: source.createdBy,
        actorType: "system",
        orgId: source.orgId,
      })
    }
    return {
      state: {
        cursor: page.nextCursor ?? null,
        generation: Number(moved[0].sync_generation),
        passStartedAt: page.done ? null : from.passStartedAt,
      },
      upserted,
      archived: archivedIds.length,
    }
  })
}

/** Stamp a failed sync, keeping the cursor and the pass (the database store's fail). */
async function failAppSourceSync(source: SyncedSourceRow, message: string): Promise<void> {
  // `last_sync_at` advances on a failure too, so a permanent failure waits a
  // whole interval (sync-reconciler.ts says why).
  await withPrivilegedDb(source.orgId, "knowledge-app-source-fail", (tx) =>
    tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("synced_sources")}
        SET last_sync_at = now(),
            last_sync_status = 'error',
            last_error = ${message.slice(0, 500)},
            updated_at = now()
        WHERE id = ${source.id}::uuid AND org_id = ${source.orgId}::uuid
      `),
  )
}

/** The production store: `app_knowledge.synced_sources` and the documents of the source. */
export const dbAppSourceStore: AppSourceStore = {
  beginAppSourcePass,
  applyAppSourcePage,
  failAppSourceSync,
}

async function writeUpserts(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  docs: AppSourceDocument[],
  at: Date,
): Promise<number> {
  for (const doc of docs) {
    const identityId = await upsertSourceIdentity(tx, source.orgId, source.appName, {
      kind: "file",
      externalId: doc.externalId,
      name: doc.title,
      parentExternalId: source.folderRef,
      ...(doc.mimeType ? { mimeType: doc.mimeType } : {}),
      ...(doc.modifiedAt ? { modifiedAt: doc.modifiedAt } : {}),
      ...(doc.url ? { url: doc.url } : {}),
    })
    const externalRev = doc.rev ?? doc.modifiedAt ?? null
    const { id, bodyChanged } = await upsertSyncedDocument(tx, {
      source,
      identityId,
      title: doc.title,
      body: doc.body,
      externalPath: doc.path ?? doc.title,
      externalRev,
      lastSyncedAt: at,
    })
    await reparentMembership(
      tx,
      source.orgId,
      source.id,
      "document",
      id,
      source.rootCollectionId,
      source.createdBy,
    )
    if (bodyChanged) {
      await tx.queueEvent({
        app: "knowledge",
        entity: "document",
        action: "update",
        entityId: id,
        data: { syncedSourceId: source.id, externalRev, lastSyncAt: at.toISOString() },
        actorId: source.createdBy,
        actorType: "system",
        orgId: source.orgId,
      })
    }
  }
  return docs.length
}

async function archiveByExternalIds(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  externalIds: string[],
): Promise<string[]> {
  if (externalIds.length === 0) return []
  const ids = drizzleSql.join(
    externalIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")} AS d
      SET archived_at = now(), updated_at = now()
      FROM ${knowledgeRel("source_identities")} AS si
      WHERE d.synced_source_id = ${source.id}::uuid
        AND d.archived_at IS NULL
        AND si.id = d.source_identity_id
        AND si.org_id = ${source.orgId}::uuid
        AND si.source = ${source.appName}
        AND si.external_id IN (${ids})
      RETURNING d.id
    `),
  ).map((r) => r.id)
}

async function archiveNotSyncedSince(
  tx: PrivilegedDb,
  source: SyncedSourceRow,
  passStartedAt: string,
): Promise<string[]> {
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")}
      SET archived_at = now(), updated_at = now()
      WHERE synced_source_id = ${source.id}::uuid
        AND archived_at IS NULL
        AND (last_synced_at IS NULL OR last_synced_at < ${passStartedAt}::timestamptz)
      RETURNING id
    `),
  ).map((r) => r.id)
}

// ---------------------------------------------------------------------------
// The sync loop
// ---------------------------------------------------------------------------

export interface AppSourceSyncDeps {
  /** Run one page in the app (the registered dispatch in production). */
  dispatch: (input: AppSourceSyncInput) => Promise<unknown>
  store?: AppSourceStore
  /** Hand the rest of the pass to a new job, after `generation`. */
  enqueueContinuation: (sourceId: string, generation: number) => Promise<void>
  limits?: Partial<AppSourceLimits>
  now?: () => number
}

export type AppSourceSyncOutcome =
  | { state: "done"; pages: number; upserted: number; archived: number }
  | { state: "continued"; pages: number; upserted: number; archived: number }
  | { state: "conflict"; pages: number; upserted: number; archived: number }

/**
 * Sync an app source: pages while the job has budget, each page written with
 * its cursor; then either the pass is done or a continuation is enqueued. A
 * failed page (the run threw, or broke the contract) is stamped on the source
 * and rethrown; the cursor stays, so the next sync asks for the same page.
 */
export async function runAppSourceSync(
  source: SyncedSourceRow,
  deps: AppSourceSyncDeps,
): Promise<AppSourceSyncOutcome> {
  if (!source.sourceKind) throw new Error(`synced source ${source.id} has no source kind`)
  const store = deps.store ?? dbAppSourceStore
  const limits = { ...APP_SOURCE_LIMITS, ...deps.limits }
  const now = deps.now ?? Date.now
  const startedAt = now()
  const totals = { pages: 0, upserted: 0, archived: 0 }
  let state = await store.beginAppSourcePass(source)
  for (;;) {
    let page: AppSourcePage
    try {
      const raw = await deps.dispatch({
        sourceId: source.id,
        kind: source.sourceKind,
        config: source.sourceConfig ?? {},
        cursor: state.cursor,
      })
      page = parseSyncResult(raw, limits)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await store.failAppSourceSync(
        source,
        err instanceof AppSourceContractError ? `Sync page refused: ${message}` : message,
      )
      throw err
    }
    let applied: AppliedPage
    try {
      applied = await store.applyAppSourcePage(source, state, page)
    } catch (err) {
      if (err instanceof AppSourceConflictError) {
        log.info({ sourceId: source.id }, "app source sync: another run moved the cursor; stopping")
        return { state: "conflict", ...totals }
      }
      await store.failAppSourceSync(source, err instanceof Error ? err.message : String(err))
      throw err
    }
    state = applied.state
    totals.pages += 1
    totals.upserted += applied.upserted
    totals.archived += applied.archived
    if (page.done) return { state: "done", ...totals }
    if (totals.pages >= limits.maxPagesPerJob || now() - startedAt >= limits.jobBudgetMs) {
      try {
        await deps.enqueueContinuation(source.id, state.generation)
      } catch (err) {
        // The pass stays open: the next scheduled sync resumes it from the cursor.
        await store.failAppSourceSync(
          source,
          `Could not schedule the next page: ${err instanceof Error ? err.message : String(err)}`,
        )
        throw err
      }
      return { state: "continued", ...totals }
    }
  }
}

/**
 * The sync job's app-source branch (knowledge-jobs.ts): sets the org up, finds
 * the kind the app declares, re-checks that the owner still holds its read
 * scope, and runs the pages through the app's registered dispatch.
 */
export async function runAppSourceSyncJob(
  source: SyncedSourceRow,
  opts: {
    enqueueContinuation: (sourceId: string, generation: number) => Promise<void>
    setUpAppSourceOrg?: (orgId: string) => Promise<void>
    ownerScopes?: (orgId: string, userId: string) => Promise<readonly string[]>
    dispatch?: AppSourceSyncDeps["dispatch"]
    store?: AppSourceStore
    limits?: Partial<AppSourceLimits>
  },
): Promise<AppSourceSyncOutcome | { state: "refused"; reason: string }> {
  const store = opts.store ?? dbAppSourceStore
  const kind = source.sourceKind ?? ""
  const userId = source.ownerUserId ?? source.createdBy
  const setUpOrg =
    opts.setUpAppSourceOrg ??
    (async (orgId: string) => {
      const { awaitOrgApps } = await import("~/modules/apps/init")
      await awaitOrgApps(orgId)
    })
  await setUpOrg(source.orgId)
  const entry = knowledgeSourceKindRegistry.get([source.orgId, source.appName])
  const decl = entry?.kinds[kind]
  const refuse = async (reason: string) => {
    log.warn({ sourceId: source.id, app: source.appName, kind }, `app source sync: ${reason}`)
    await store.failAppSourceSync(source, reason)
    return { state: "refused" as const, reason }
  }
  if (!entry || !decl) {
    return refuse(`${source.appName} no longer offers the knowledge source "${kind}"`)
  }
  if (decl.readScope) {
    const scopes = await (opts.ownerScopes ?? loadOwnerScopes)(source.orgId, userId)
    if (!hasScope(decl.readScope, [...scopes])) {
      return refuse(`the source owner no longer holds ${decl.readScope}`)
    }
  }
  const dispatch =
    opts.dispatch ??
    ((input: AppSourceSyncInput) => entry.dispatch(kind, input, { orgId: source.orgId, userId }))
  return runAppSourceSync(source, {
    dispatch,
    store,
    enqueueContinuation: opts.enqueueContinuation,
    ...(opts.limits ? { limits: opts.limits } : {}),
  })
}

async function loadOwnerScopes(orgId: string, userId: string): Promise<readonly string[]> {
  const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
  const { withSystemDb } = await import("~/db/privileged")
  const effective = await withSystemDb("knowledge-app-source-owner-scopes", (db) =>
    loadEffectivePermissions(db, userId, orgId),
  )
  return effective.scopes
}
