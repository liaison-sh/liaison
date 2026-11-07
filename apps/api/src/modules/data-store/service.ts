// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-org app data store (kernel.app_documents, migration 0275): JSON
// documents an app keeps for its org, in named collections, keyed by id.
//
//  - Every function runs in the CALLER's RLS transaction (`tx`): the database
//    keeps orgs apart (FORCE RLS on org_id). `caller.app` is the app that owns
//    the collections (the calling app on the bridge, `agent` for the agent's
//    own namespace); this module never lets one call reach another app's
//    collection, and callers never take `app` from a parameter they did not
//    verify.
//  - Limits: a document is a JSON object of at most 256 KiB serialized; a
//    collection holds at most 100,000 documents. The count lives in
//    kernel.app_document_usage, updated in the same transaction as the write
//    (its row is locked first, so writes to one collection serialize and the
//    limit holds without a scan).
//  - Optimistic concurrency: set/update/delete take `ifVersion`; a document
//    whose version differs (or that is missing, for ifVersion >= 1; present,
//    for ifVersion 0) refuses with `version_conflict`.
//  - Query: equality and `in` compile to `data @> $n::jsonb` (GIN), ranges to a
//    type-guarded comparison (numbers as numeric, strings as text: a value of
//    the other type never matches), field names are bound as text parameters
//    after a regex check, never spliced in as identifiers. Pages are keyed on
//    (sort value, doc_id) with an opaque cursor, so a page boundary stays put
//    while documents are added. A sort or range that no index serves runs
//    under a 2 s statement timeout.

import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withReleasedSavepoint } from "~/db/savepoint"
import { appDocuments, appDocumentUsage } from "~/db/schema/kernel"

/** Serialized size limit of one document. */
export const MAX_DOC_BYTES = 256 * 1024
/** Documents per (org, app, collection). */
export const MAX_DOCS_PER_COLLECTION = 100_000
export const MAX_DOC_ID_LENGTH = 200
export const DEFAULT_QUERY_LIMIT = 50
export const MAX_QUERY_LIMIT = 200
/** Values of one `in` filter. */
export const MAX_IN_VALUES = 50
/** Fields one `where` may filter on. */
export const MAX_WHERE_FIELDS = 20
/** A sort or range no index serves gets this long. */
export const UNINDEXED_STATEMENT_TIMEOUT = "2s"

export const APP_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/
export const COLLECTION_RE = /^[a-z][a-z0-9_]{0,62}$/
/** A filterable or sortable top-level key of `data`. */
export const FIELD_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

/** The agent's own namespace in the store. */
export const AGENT_STORE_APP = "agent"

/**
 * A draft preview's own namespace (modules/app-builder/preview.ts):
 * `draft:<draftId>`. The ':' never occurs in an app name, so no app's
 * collections and no other draft's can share it; the preview's bridge sets it
 * from the draft it runs (never from app code), it is wiped at the draft's next
 * preview and a day after its last write (`pruneDraftStoreNamespaces`), and no
 * collection in it is ever declared, listed or indexed.
 */
export const DRAFT_STORE_APP_RE =
  /^draft:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The store namespace of a draft's previews. */
export function draftStoreApp(draftId: string): string {
  const app = `draft:${draftId.toLowerCase()}`
  if (!DRAFT_STORE_APP_RE.test(app)) {
    throw new DataStoreError("invalid_name", `'${draftId}' is not a draft id`)
  }
  return app
}

/** Whether `app` is a draft preview's namespace (not an app's). */
export function isDraftStoreApp(app: string): boolean {
  return DRAFT_STORE_APP_RE.test(app)
}

export type DataStoreErrorCode =
  | "version_conflict"
  | "not_found"
  | "doc_too_large"
  | "collection_full"
  | "invalid_name"
  | "invalid_data"
  | "invalid_field"
  | "invalid_query"
  | "invalid_cursor"
  | "query_timeout"

/** A refused store call; `code` is stable for callers (bridge, tools, routes). */
export class DataStoreError extends Error {
  readonly code: DataStoreErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: DataStoreErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "DataStoreError"
    this.code = code
    this.details = details
  }
}

/** Who writes, and whose collections: `app` is never a value the caller did not verify. */
export interface StoreCaller {
  orgId: string
  app: string
  /** The person behind the write (author columns), null for a system or app run. */
  userId: string | null
}

export interface StoreDocument {
  id: string
  data: Record<string, unknown>
  version: number
  updatedAt: string
}

export interface WriteOptions {
  /** The version the caller last read; 0 = the document must not exist yet. */
  ifVersion?: number
}

export type Scalar = string | number | boolean | null
export type RangeFilter = {
  gt?: number | string
  gte?: number | string
  lt?: number | string
  lte?: number | string
}
export type FieldFilter = Scalar | { in: Scalar[] } | RangeFilter
export type Where = Record<string, FieldFilter>

export interface StoreQuery {
  where?: Where
  orderBy?: { field: string; dir?: "asc" | "desc" }
  limit?: number
  cursor?: string
}

export interface StoreQueryResult {
  items: StoreDocument[]
  nextCursor: string | null
}

export interface CollectionUsage {
  app: string
  collection: string
  docs: number
  bytes: number
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertCaller(caller: StoreCaller): void {
  if (!APP_NAME_RE.test(caller.app) && !DRAFT_STORE_APP_RE.test(caller.app)) {
    throw new DataStoreError("invalid_name", `'${caller.app}' is not a valid app name`)
  }
}

function assertCollection(collection: string): void {
  if (typeof collection !== "string" || !COLLECTION_RE.test(collection)) {
    throw new DataStoreError(
      "invalid_name",
      `collection '${String(collection)}' must match ${COLLECTION_RE.source}`,
    )
  }
}

function assertDocId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_DOC_ID_LENGTH) {
    throw new DataStoreError(
      "invalid_name",
      `a document id is a string of 1 to ${MAX_DOC_ID_LENGTH} characters`,
    )
  }
}

function assertField(field: unknown): asserts field is string {
  if (typeof field !== "string" || !FIELD_RE.test(field)) {
    throw new DataStoreError(
      "invalid_field",
      `field '${String(field)}' must be a top-level key matching ${FIELD_RE.source}`,
    )
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** The document as stored (JSON round trip) and its serialized size; refuses a non-object or an oversize one. */
function normalizeData(data: unknown): { data: Record<string, unknown>; size: number } {
  if (!isPlainObject(data)) {
    throw new DataStoreError("invalid_data", "a document is a JSON object")
  }
  let text: string
  try {
    text = JSON.stringify(data)
  } catch (err) {
    throw new DataStoreError("invalid_data", `the document is not JSON: ${(err as Error).message}`)
  }
  const size = Buffer.byteLength(text, "utf8")
  if (size > MAX_DOC_BYTES) {
    throw new DataStoreError(
      "doc_too_large",
      `the document is ${size} bytes serialized, over the ${MAX_DOC_BYTES} byte limit`,
      { size, limit: MAX_DOC_BYTES },
    )
  }
  return { data: JSON.parse(text) as Record<string, unknown>, size }
}

function assertIfVersion(opts: WriteOptions | undefined): number | undefined {
  const v = opts?.ifVersion
  if (v === undefined) return undefined
  if (!Number.isInteger(v) || v < 0) {
    throw new DataStoreError("invalid_query", "ifVersion is a whole number, 0 or more")
  }
  return v
}

function checkVersion(
  expected: number | undefined,
  current: { version: number } | undefined,
  id: string,
): void {
  if (expected === undefined) return
  const actual = current?.version ?? 0
  if (actual !== expected) {
    throw new DataStoreError(
      "version_conflict",
      `document '${id}' is at version ${actual}, not ${expected}`,
      { expected, actual },
    )
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function toDocument(row: {
  docId: string
  data: Record<string, unknown>
  version: number
  updatedAt: Date | string
}): StoreDocument {
  return {
    id: row.docId,
    data: row.data,
    version: row.version,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  }
}

function docKey(caller: StoreCaller, collection: string, id: string): SQL | undefined {
  return and(
    eq(appDocuments.orgId, caller.orgId),
    eq(appDocuments.app, caller.app),
    eq(appDocuments.collection, collection),
    eq(appDocuments.docId, id),
  )
}

/** Locks the collection's usage row (creating it), so writes to one collection serialize. */
async function lockUsage(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
): Promise<{ docs: number; bytes: number }> {
  await tx
    .insert(appDocumentUsage)
    .values({ orgId: caller.orgId, app: caller.app, collection })
    .onConflictDoNothing()
  const [row] = await tx
    .select({ docs: appDocumentUsage.docs, bytes: appDocumentUsage.bytes })
    .from(appDocumentUsage)
    .where(
      and(
        eq(appDocumentUsage.orgId, caller.orgId),
        eq(appDocumentUsage.app, caller.app),
        eq(appDocumentUsage.collection, collection),
      ),
    )
    .for("update")
  return { docs: Number(row?.docs ?? 0), bytes: Number(row?.bytes ?? 0) }
}

async function moveUsage(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  docsDelta: number,
  bytesDelta: number,
): Promise<void> {
  if (docsDelta === 0 && bytesDelta === 0) return
  await tx
    .update(appDocumentUsage)
    .set({
      docs: sql`GREATEST(${appDocumentUsage.docs} + ${docsDelta}, 0)`,
      bytes: sql`GREATEST(${appDocumentUsage.bytes} + ${bytesDelta}, 0)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(appDocumentUsage.orgId, caller.orgId),
        eq(appDocumentUsage.app, caller.app),
        eq(appDocumentUsage.collection, collection),
      ),
    )
}

async function lockedDoc(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  id: string,
): Promise<{ data: Record<string, unknown>; version: number; sizeBytes: number } | undefined> {
  const [row] = await tx
    .select({
      data: appDocuments.data,
      version: appDocuments.version,
      sizeBytes: appDocuments.sizeBytes,
    })
    .from(appDocuments)
    .where(docKey(caller, collection, id))
    .for("update")
  return row
}

const RETURNING = {
  docId: appDocuments.docId,
  data: appDocuments.data,
  version: appDocuments.version,
  updatedAt: appDocuments.updatedAt,
}

/** Writes `data` as the document's whole content, under the usage lock. */
async function writeLocked(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  id: string,
  next: { data: Record<string, unknown>; size: number },
  current: { version: number; sizeBytes: number } | undefined,
): Promise<StoreDocument> {
  if (!current) {
    const usage = await lockUsage(tx, caller, collection)
    if (usage.docs >= MAX_DOCS_PER_COLLECTION) {
      throw new DataStoreError(
        "collection_full",
        `collection '${collection}' holds ${usage.docs} documents, the limit is ${MAX_DOCS_PER_COLLECTION}`,
        { docs: usage.docs, limit: MAX_DOCS_PER_COLLECTION },
      )
    }
    const [row] = await tx
      .insert(appDocuments)
      .values({
        orgId: caller.orgId,
        app: caller.app,
        collection,
        docId: id,
        data: next.data,
        sizeBytes: next.size,
        version: 1,
        createdBy: caller.userId,
        updatedBy: caller.userId,
      })
      .returning(RETURNING)
    await moveUsage(tx, caller, collection, 1, next.size)
    return toDocument(row!)
  }
  await lockUsage(tx, caller, collection)
  const [row] = await tx
    .update(appDocuments)
    .set({
      data: next.data,
      sizeBytes: next.size,
      version: sql`${appDocuments.version} + 1`,
      updatedBy: caller.userId,
      updatedAt: sql`now()`,
    })
    .where(docKey(caller, collection, id))
    .returning(RETURNING)
  await moveUsage(tx, caller, collection, 0, next.size - current.sizeBytes)
  return toDocument(row!)
}

// ---------------------------------------------------------------------------
// Search indexing
// ---------------------------------------------------------------------------

/**
 * Every write (the agent's data tools and an app's ctx.store alike) hands the
 * document as written to search (data-store/search.ts), which indexes it only
 * when its collection is declared searchable and agent-readable. Best effort:
 * a write never fails on the search queue. Imported lazily: search.ts reads
 * the declarations, which import this module.
 */
async function indexWrite(write: {
  caller: StoreCaller
  collection: string
  docId: string
  written: { data: Record<string, unknown>; updatedAt: string } | null
}): Promise<void> {
  const { recordAppDocumentIndex } = await import("~/modules/data-store/search")
  await recordAppDocumentIndex(write)
}

async function indexed(
  caller: StoreCaller,
  collection: string,
  doc: StoreDocument,
): Promise<StoreDocument> {
  await indexWrite({
    caller,
    collection,
    docId: doc.id,
    written: { data: doc.data, updatedAt: doc.updatedAt },
  })
  return doc
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** The document, or null. */
export async function getDocument(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  id: string,
): Promise<StoreDocument | null> {
  assertCaller(caller)
  assertCollection(collection)
  assertDocId(id)
  const [row] = await tx
    .select(RETURNING)
    .from(appDocuments)
    .where(docKey(caller, collection, id))
  return row ? toDocument(row) : null
}

/** Creates or replaces the document. */
export async function setDocument(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  id: string,
  data: unknown,
  opts?: WriteOptions,
): Promise<StoreDocument> {
  assertCaller(caller)
  assertCollection(collection)
  assertDocId(id)
  const ifVersion = assertIfVersion(opts)
  const next = normalizeData(data)
  let current = await lockedDoc(tx, caller, collection, id)
  if (!current) {
    // No row to lock: a concurrent first write of the same id may be in flight. The usage row
    // lock serializes the collection's creators, so the re-read under it is authoritative (READ
    // COMMITTED: the statement sees what the writer before us committed).
    await lockUsage(tx, caller, collection)
    current = await lockedDoc(tx, caller, collection, id)
  }
  checkVersion(ifVersion, current, id)
  return indexed(caller, collection, await writeLocked(tx, caller, collection, id, next, current))
}

/** Shallow-merges `patch` into an existing document (a key set to null stays, as null). */
export async function updateDocument(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  id: string,
  patch: unknown,
  opts?: WriteOptions,
): Promise<StoreDocument> {
  assertCaller(caller)
  assertCollection(collection)
  assertDocId(id)
  const ifVersion = assertIfVersion(opts)
  if (!isPlainObject(patch)) {
    throw new DataStoreError("invalid_data", "a patch is a JSON object")
  }
  const current = await lockedDoc(tx, caller, collection, id)
  checkVersion(ifVersion, current, id)
  if (!current) {
    throw new DataStoreError("not_found", `document '${id}' is not in collection '${collection}'`)
  }
  const next = normalizeData({ ...current.data, ...patch })
  return indexed(caller, collection, await writeLocked(tx, caller, collection, id, next, current))
}

/** Deletes the document; `deleted` false when there was none. */
export async function deleteDocument(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  id: string,
  opts?: WriteOptions,
): Promise<{ deleted: boolean }> {
  assertCaller(caller)
  assertCollection(collection)
  assertDocId(id)
  const ifVersion = assertIfVersion(opts)
  const current = await lockedDoc(tx, caller, collection, id)
  checkVersion(ifVersion, current, id)
  if (!current) return { deleted: false }
  await lockUsage(tx, caller, collection)
  await tx.delete(appDocuments).where(docKey(caller, collection, id))
  await moveUsage(tx, caller, collection, -1, -current.sizeBytes)
  await indexWrite({ caller, collection, docId: id, written: null })
  return { deleted: true }
}

/** The caller org's collections with their counters, one app's or every app's. */
export async function listCollections(
  tx: RlsClient,
  filter: { orgId: string; app?: string },
): Promise<CollectionUsage[]> {
  if (filter.app !== undefined && !APP_NAME_RE.test(filter.app)) {
    throw new DataStoreError("invalid_name", `'${filter.app}' is not a valid app name`)
  }
  const rows = await tx
    .select({
      app: appDocumentUsage.app,
      collection: appDocumentUsage.collection,
      docs: appDocumentUsage.docs,
      bytes: appDocumentUsage.bytes,
    })
    .from(appDocumentUsage)
    .where(
      and(
        eq(appDocumentUsage.orgId, filter.orgId),
        filter.app !== undefined ? eq(appDocumentUsage.app, filter.app) : undefined,
        sql`${appDocumentUsage.docs} > 0`,
      ),
    )
    .orderBy(asc(appDocumentUsage.app), asc(appDocumentUsage.collection))
  return rows.map((r) => ({ ...r, docs: Number(r.docs), bytes: Number(r.bytes) }))
}

// ---------------------------------------------------------------------------
// Query compiler
// ---------------------------------------------------------------------------

/** Columns a query may name besides top-level keys of `data`. */
const DOC_ID_FIELD = "doc_id"
const UPDATED_AT_FIELD = "updated_at"
const RANGE_OPS = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const
type RangeOp = keyof typeof RANGE_OPS

function isScalar(v: unknown): v is Scalar {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v))
  )
}

/** `data -> k`, the key bound as a text parameter. */
function dataField(field: string): SQL {
  return sql`(${appDocuments.data} -> ${field}::text)`
}

function containment(field: string, value: Scalar): SQL {
  return sql`${appDocuments.data} @> ${JSON.stringify({ [field]: value })}::jsonb`
}

function columnCompare(field: string, op: (typeof RANGE_OPS)[RangeOp] | "=", value: Scalar): SQL {
  if (field === DOC_ID_FIELD) {
    if (typeof value !== "string") {
      throw new DataStoreError("invalid_query", "doc_id compares with a string")
    }
    return sql`${appDocuments.docId} ${sql.raw(op)} ${value}`
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new DataStoreError("invalid_query", "updated_at compares with an ISO date-time string")
  }
  return sql`${appDocuments.updatedAt} ${sql.raw(op)} ${value}::timestamptz`
}

interface CompiledWhere {
  conditions: SQL[]
  /** A range on a data field: no index serves it. */
  unindexed: boolean
}

export function compileWhere(where: unknown): CompiledWhere {
  const conditions: SQL[] = []
  let unindexed = false
  if (where === undefined || where === null) return { conditions, unindexed }
  if (!isPlainObject(where)) throw new DataStoreError("invalid_query", "where is an object")
  const entries = Object.entries(where)
  if (entries.length > MAX_WHERE_FIELDS) {
    throw new DataStoreError("invalid_query", `where names at most ${MAX_WHERE_FIELDS} fields`)
  }
  for (const [field, filter] of entries) {
    assertField(field)
    const isColumn = field === DOC_ID_FIELD || field === UPDATED_AT_FIELD
    if (isScalar(filter)) {
      conditions.push(isColumn ? columnCompare(field, "=", filter) : containment(field, filter))
      continue
    }
    if (!isPlainObject(filter)) {
      throw new DataStoreError("invalid_query", `filter on '${field}' is a value, {in}, or a range`)
    }
    const keys = Object.keys(filter)
    if (keys.length === 0) {
      throw new DataStoreError("invalid_query", `filter on '${field}' is empty`)
    }
    if ("in" in filter) {
      const values = (filter as { in: unknown }).in
      if (keys.length !== 1 || !Array.isArray(values) || values.length === 0) {
        throw new DataStoreError("invalid_query", `'in' on '${field}' is a non-empty array alone`)
      }
      if (values.length > MAX_IN_VALUES) {
        throw new DataStoreError("invalid_query", `'in' takes at most ${MAX_IN_VALUES} values`)
      }
      const parts = values.map((v) => {
        if (!isScalar(v)) throw new DataStoreError("invalid_query", `'in' values are scalars`)
        return isColumn ? columnCompare(field, "=", v) : containment(field, v)
      })
      conditions.push(sql`(${sql.join(parts, sql` OR `)})`)
      continue
    }
    for (const key of keys) {
      if (!Object.hasOwn(RANGE_OPS, key)) {
        throw new DataStoreError("invalid_query", `unknown operator '${key}' on '${field}'`)
      }
      const value = (filter as Record<string, unknown>)[key]
      const op = RANGE_OPS[key as RangeOp]
      if (isColumn) {
        conditions.push(columnCompare(field, op, value as Scalar))
        continue
      }
      unindexed = true
      if (typeof value === "number" && Number.isFinite(value)) {
        conditions.push(
          sql`(jsonb_typeof(${dataField(field)}) = 'number' AND (${dataField(field)})::numeric ${sql.raw(op)} ${String(value)}::numeric)`,
        )
      } else if (typeof value === "string") {
        conditions.push(
          sql`(jsonb_typeof(${dataField(field)}) = 'string' AND (${appDocuments.data} ->> ${field}::text) ${sql.raw(op)} ${value})`,
        )
      } else {
        throw new DataStoreError(
          "invalid_query",
          `'${key}' on '${field}' takes a number or a string`,
        )
      }
    }
  }
  return { conditions, unindexed }
}

interface CursorPayload {
  /** The order the cursor was made for: `field:dir`. */
  o: string
  /** The last row's sort value (JSON for a data field, text for updated_at, absent for doc_id). */
  v?: unknown
  id: string
}

function encodeCursor(c: CursorPayload): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url")
}

function decodeCursor(cursor: unknown, order: string): CursorPayload {
  if (typeof cursor !== "string" || cursor.length > 4096) {
    throw new DataStoreError("invalid_cursor", "the cursor is not one this query returned")
  }
  try {
    const c = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload
    if (!isPlainObject(c) || c.o !== order || typeof c.id !== "string") throw new Error("shape")
    return c
  } catch {
    throw new DataStoreError("invalid_cursor", "the cursor is not one this query returned")
  }
}

function resolveLimit(limit: unknown): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_QUERY_LIMIT) {
    throw new DataStoreError(
      "invalid_query",
      `limit is a whole number from 1 to ${MAX_QUERY_LIMIT}`,
    )
  }
  return limit as number
}

/** What a query step runs on: the transaction, or the savepoint a statement timeout runs in. */
type StoreReader = Pick<RlsClient, "select" | "execute">

const isStatementTimeout = (err: unknown): boolean =>
  ((err as { cause?: { code?: string } } | null)?.cause?.code ??
    (err as { code?: string } | null)?.code) === "57014"

/**
 * Runs `fn` with a statement timeout, in a savepoint of `tx`. A query past the timeout is a typed
 * `query_timeout` refusal; the savepoint rolls back with it (the timeout setting too), so the
 * transaction stays usable. On success the transaction's own timeout is put back.
 * Exported for tests.
 */
export async function withStatementTimeout<T>(
  tx: RlsClient,
  timeout: string,
  fn: (db: StoreReader) => Promise<T>,
): Promise<T> {
  try {
    return await withReleasedSavepoint(tx, async (sp) => {
      const [prev] = extractRows<{ v: string }>(
        await sp.execute(sql`SELECT current_setting('statement_timeout') AS v`),
      )
      await sp.execute(sql`SELECT set_config('statement_timeout', ${timeout}, true)`)
      const result = await fn(sp)
      await sp.execute(sql`SELECT set_config('statement_timeout', ${prev?.v ?? "0"}, true)`)
      return result
    })
  } catch (err) {
    if (!isStatementTimeout(err)) throw err
    throw new DataStoreError(
      "query_timeout",
      `the query ran past ${timeout}: filter with equality or in on its fields, or sort by updated_at`,
      { timeout },
    )
  }
}

/** One page of the collection's documents matching `query`. */
export async function queryDocuments(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  query: StoreQuery = {},
): Promise<StoreQueryResult> {
  assertCaller(caller)
  assertCollection(collection)
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    throw new DataStoreError("invalid_query", "a query is an object")
  }
  for (const key of Object.keys(query)) {
    if (!["where", "orderBy", "limit", "cursor"].includes(key)) {
      throw new DataStoreError("invalid_query", `unknown query key '${key}'`)
    }
  }
  const limit = resolveLimit(query.limit)
  const compiled = compileWhere(query.where)

  const orderField = query.orderBy?.field ?? UPDATED_AT_FIELD
  assertField(orderField)
  const dirInput = query.orderBy?.dir ?? (query.orderBy ? "asc" : "desc")
  if (dirInput !== "asc" && dirInput !== "desc") {
    throw new DataStoreError("invalid_query", "orderBy.dir is 'asc' or 'desc'")
  }
  const dir = dirInput
  const order = `${orderField}:${dir}`
  const cmp = sql.raw(dir === "asc" ? ">" : "<")
  const sortDir = dir === "asc" ? asc : desc

  // The sort key, and how a cursor value compares with it.
  let sortKey: SQL | null
  let sortValue: SQL<unknown>
  if (orderField === DOC_ID_FIELD) {
    sortKey = null
    sortValue = sql`NULL`
  } else if (orderField === UPDATED_AT_FIELD) {
    sortKey = sql`${appDocuments.updatedAt}`
    sortValue = sql`${appDocuments.updatedAt}::text`
  } else {
    sortKey = sql`COALESCE(${dataField(orderField)}, 'null'::jsonb)`
    sortValue = sql`COALESCE(${dataField(orderField)}, 'null'::jsonb)`
  }

  const conditions = [
    eq(appDocuments.orgId, caller.orgId),
    eq(appDocuments.app, caller.app),
    eq(appDocuments.collection, collection),
    ...compiled.conditions,
  ]
  if (query.cursor !== undefined) {
    const c = decodeCursor(query.cursor, order)
    if (orderField === DOC_ID_FIELD) {
      conditions.push(sql`${appDocuments.docId} ${cmp} ${c.id}`)
    } else if (orderField === UPDATED_AT_FIELD) {
      if (typeof c.v !== "string") {
        throw new DataStoreError("invalid_cursor", "the cursor is not one this query returned")
      }
      conditions.push(
        sql`(${appDocuments.updatedAt}, ${appDocuments.docId}) ${cmp} (${c.v}::timestamptz, ${c.id})`,
      )
    } else {
      conditions.push(
        sql`(${sortKey}, ${appDocuments.docId}) ${cmp} (${JSON.stringify(c.v ?? null)}::jsonb, ${c.id})`,
      )
    }
  }

  const run = (db: StoreReader) =>
    db
      .select({ ...RETURNING, sortValue: sql<unknown>`${sortValue}` })
      .from(appDocuments)
      .where(and(...conditions))
      .orderBy(...(sortKey ? [sortDir(sortKey)] : []), sortDir(appDocuments.docId))
      .limit(limit + 1)

  const unindexed = compiled.unindexed || orderField !== UPDATED_AT_FIELD
  const rows = unindexed
    ? await withStatementTimeout(tx, UNINDEXED_STATEMENT_TIMEOUT, run)
    : await run(tx)

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor({
          o: order,
          id: last.docId,
          ...(orderField === DOC_ID_FIELD ? {} : { v: last.sortValue }),
        })
      : null
  return { items: page.map(toDocument), nextCursor }
}

/** How many of the collection's documents match `where`. */
export async function countDocuments(
  tx: RlsClient,
  caller: StoreCaller,
  collection: string,
  where?: Where,
): Promise<number> {
  assertCaller(caller)
  assertCollection(collection)
  const compiled = compileWhere(where)
  const run = async (db: StoreReader) => {
    const [row] = await db
      .select({ n: sql<string>`count(*)::text` })
      .from(appDocuments)
      .where(
        and(
          eq(appDocuments.orgId, caller.orgId),
          eq(appDocuments.app, caller.app),
          eq(appDocuments.collection, collection),
          ...compiled.conditions,
        ),
      )
    return Number(row?.n ?? 0)
  }
  return compiled.unindexed ? withStatementTimeout(tx, UNINDEXED_STATEMENT_TIMEOUT, run) : run(tx)
}

/**
 * Empties a draft preview's namespace (`draft:<draftId>`) in the caller's org:
 * its documents and their counters. Runs in the caller's RLS transaction.
 */
export async function wipeDraftStore(
  tx: RlsClient,
  orgId: string,
  draftId: string,
): Promise<{ deleted: number }> {
  const app = draftStoreApp(draftId)
  const gone = await tx
    .delete(appDocuments)
    .where(and(eq(appDocuments.orgId, orgId), eq(appDocuments.app, app)))
    .returning({ id: appDocuments.docId })
  await tx
    .delete(appDocumentUsage)
    .where(and(eq(appDocumentUsage.orgId, orgId), eq(appDocumentUsage.app, app)))
  return { deleted: gone.length }
}
