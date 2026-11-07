// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Search over the app data store (kernel.app_documents): documents of DECLARED,
// agent-readable, searchable collections (declared.ts) are in the unified
// search index, under their collection's read scope. Nothing else is.
//
//  - Live: every write of the store service (service.ts, both the agent's data
//    tools and an app's ctx.store) records an index request here
//    (`recordAppDocumentIndex`). The request CARRIES the built document, so the
//    flush never reads a row the writing transaction has not committed yet; the
//    latest request for a document wins in the coalescing queue
//    (live-index-queue.ts), and writes to one document serialize on its row lock.
//  - Rebuild: `app-documents` streams every indexed document of an org from
//    Postgres (index-sources.ts), so a lost or rebuilt index gets them back and a
//    collection whose declaration changed is rebuilt as it now stands.
//  - Query: the permission filter admits the read scopes of the org's declared
//    searchable collections (`appDocumentSearchReadScopes`), the hit type is
//    registered on the query path only (like thread messages: the generic
//    rebuild walk cannot build these documents), and every hit is checked
//    again (`rejectStaleAppDocumentHits`): its collection must still be declared
//    searchable and agent-readable under a read scope the searcher holds, and its
//    row must still exist (a request recorded by a write whose transaction then
//    rolled back leaves a document no row backs).
//  - Org purge: every document carries `org_id`, so the purge's one filter
//    delete (org/purge/external.ts) removes them with the rest.
//
// A document is `app: "kernel"`, `entity_type: "app_document"`, and names its
// record as `entity_id = "<app>/<collection>/<encoded doc id>"`; it has no page
// in the product (open target `outside`).

import { createHash } from "node:crypto"
import { and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { appDocuments } from "~/db/schema/kernel"
import { searchLogger as log } from "~/lib/logger"
import {
  type DeclaredCollection,
  getDeclaredCollection,
  listDeclaredCollections,
} from "~/modules/data-store/declared"
import { AGENT_STORE_APP, type StoreCaller } from "~/modules/data-store/service"
import { hasScope } from "~/modules/permissions/permissions"
import { registerIndexSource } from "~/modules/search/index-sources"
import {
  type LiveIndexItem,
  type LiveIndexResolution,
  recordLiveIndex,
  registerLiveIndexResolver,
} from "~/modules/search/live-index-queue"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"

export const APP_DOCUMENT_ENTITY_TYPE = "app_document"
/** The live index request kind. */
export const APP_DOCUMENT_RESOLVER = "app-document"
/** The rebuild source name. */
export const APP_DOCUMENT_INDEX_SOURCE = "app-documents"

/** Bounds of the indexed text. */
const MAX_TITLE_CHARS = 300
const MAX_BODY_CHARS = 8_000
const REBUILD_PAGE = 500

/**
 * The query path's registration of the hit type: `defensiveFilterHits` keeps
 * only hits of a registered type. Its read scope is the agent namespace's; a
 * declared collection's own scope rides each document (`read_scope`).
 */
export const APP_DOCUMENT_SEARCH_REGISTRATION: SearchableEntityRegistration = {
  app: "kernel",
  entityType: APP_DOCUMENT_ENTITY_TYPE,
  schemaName: "kernel",
  tableName: "app_documents",
  readScope: "kernel:data:read",
  labelField: "title",
  indexFields: { title: "title" },
  permissionFields: {},
  mentionable: false,
}

/** The declaration of a collection whose documents are indexed, or null. */
export function indexedCollection(
  orgId: string,
  app: string,
  collection: string,
): (DeclaredCollection & { searchable: NonNullable<DeclaredCollection["searchable"]> }) | null {
  const decl = getDeclaredCollection(orgId, app, collection)
  if (!decl?.searchable || !decl.agentReadable) return null
  return decl as DeclaredCollection & {
    searchable: NonNullable<DeclaredCollection["searchable"]>
  }
}

/** How a hit names its record: `<app>/<collection>/<encoded doc id>`. */
export function appDocumentEntityId(app: string, collection: string, docId: string): string {
  return `${app}/${collection}/${encodeURIComponent(docId)}`
}

/** The inverse of {@link appDocumentEntityId}, or null for anything else. */
export function parseAppDocumentEntityId(
  entityId: unknown,
): { app: string; collection: string; docId: string } | null {
  if (typeof entityId !== "string") return null
  const first = entityId.indexOf("/")
  const second = entityId.indexOf("/", first + 1)
  if (first <= 0 || second <= first + 1) return null
  try {
    return {
      app: entityId.slice(0, first),
      collection: entityId.slice(first + 1, second),
      docId: decodeURIComponent(entityId.slice(second + 1)),
    }
  } catch {
    return null
  }
}

/**
 * The search document id. Hashed: the parts may hold characters Meili refuses,
 * and replacing them (document-id.ts) would let `a_b`/`c` and `a`/`b_c` collide.
 */
export function appDocumentSearchId(
  orgId: string,
  app: string,
  collection: string,
  docId: string,
): string {
  const h = createHash("sha256").update(`${app}\0${collection}\0${docId}`).digest("hex")
  return `${orgId.replace(/[^a-zA-Z0-9_-]/g, "_")}_kernel_${APP_DOCUMENT_ENTITY_TYPE}_${h.slice(0, 40)}`
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(", ")
  return ""
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

function unixSeconds(at: string | Date): number | null {
  const ms = new Date(at).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** The search document of one store document of an indexed collection. */
export function buildAppDocumentSearchDoc(
  orgId: string,
  decl: DeclaredCollection & { searchable: NonNullable<DeclaredCollection["searchable"]> },
  docId: string,
  data: Record<string, unknown>,
  updatedAt: string | Date,
): Record<string, unknown> {
  const { labelField, fields } = decl.searchable
  const title = clip(textOf(data[labelField]).trim(), MAX_TITLE_CHARS) || docId
  const body = clip(
    fields
      .filter((f) => f !== labelField)
      .map((f) => textOf(data[f]).trim())
      .filter(Boolean)
      .join("\n"),
    MAX_BODY_CHARS,
  )
  const doc: Record<string, unknown> = {
    id: appDocumentSearchId(orgId, decl.app, decl.collection, docId),
    org_id: orgId,
    app: "kernel",
    entity_type: APP_DOCUMENT_ENTITY_TYPE,
    entity_id: appDocumentEntityId(decl.app, decl.collection, docId),
    read_scope: decl.readScope,
    is_mentionable: false,
    title,
    label_secondary: `${decl.app} / ${decl.collection}`,
    body: body || null,
    store_app: decl.app,
    store_collection: decl.collection,
    store_doc_id: docId,
  }
  const updated = unixSeconds(updatedAt)
  if (updated !== null) doc.updated_at = updated
  return doc
}

/* -------------------------------------------------------------------------- */
/* Live indexing                                                              */
/* -------------------------------------------------------------------------- */

/** What a store write hands the index: the document as written, or null for a delete. */
export interface StoreWriteForIndex {
  caller: StoreCaller
  collection: string
  docId: string
  written: { data: Record<string, unknown>; updatedAt: string } | null
}

/** The live request of one write, or null when the collection is not indexed. */
export function appDocumentLiveIndexItem(write: StoreWriteForIndex): LiveIndexItem | null {
  const { caller, collection, docId, written } = write
  const decl = indexedCollection(caller.orgId, caller.app, collection)
  if (!decl) return null
  const key = appDocumentSearchId(caller.orgId, caller.app, collection, docId)
  if (!written) {
    return { t: APP_DOCUMENT_RESOLVER, key, payload: { orgId: caller.orgId, action: "delete" } }
  }
  return {
    t: APP_DOCUMENT_RESOLVER,
    key,
    payload: {
      orgId: caller.orgId,
      action: "upsert",
      doc: buildAppDocumentSearchDoc(caller.orgId, decl, docId, written.data, written.updatedAt),
    },
  }
}

/**
 * Record the index request of one store write (service.ts calls this after
 * every write). Best effort: a store write never fails on the search queue; a
 * missed request is repaired by the next write of the document or a rebuild.
 */
export async function recordAppDocumentIndex(write: StoreWriteForIndex): Promise<void> {
  const item = appDocumentLiveIndexItem(write)
  if (!item) return
  try {
    await recordLiveIndex([item])
  } catch (err) {
    log.warn(
      { err, orgId: write.caller.orgId, app: write.caller.app, collection: write.collection },
      "Could not queue a data store document for search",
    )
  }
}

registerLiveIndexResolver(APP_DOCUMENT_RESOLVER, async (items) => {
  const out: LiveIndexResolution = { docs: [], deleteIds: [], failed: [] }
  for (const item of items) {
    const doc = item.payload.doc
    if (item.payload.action === "upsert" && doc && typeof doc === "object") {
      out.docs.push(doc as Record<string, unknown>)
    } else {
      out.deleteIds.push(item.key)
    }
  }
  return out
})

/* -------------------------------------------------------------------------- */
/* Rebuild                                                                    */
/* -------------------------------------------------------------------------- */

/** A system reader of the org's store rows (kernel.app_documents RLS is per org). */
function storeReader(orgId: string): ActorContext {
  return { actorType: "system", orgId, purpose: "job", scopes: ["kernel:data:read"] }
}

/** The org's indexed collections: its apps' declared ones and the agent namespace. */
function indexedCollectionsFilter(orgId: string): SQL | undefined {
  const declared = listDeclaredCollections(orgId).filter((d) => d.searchable && d.agentReadable)
  const pairs = declared.map((d) =>
    and(eq(appDocuments.app, d.app), eq(appDocuments.collection, d.collection)),
  )
  return or(eq(appDocuments.app, AGENT_STORE_APP), ...pairs)
}

/** Stream every indexed store document of `orgId` (the rebuild's `app-documents` source). */
export async function streamAppDocumentsForRebuild(
  orgId: string,
  sink: (docs: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  const actor = storeReader(orgId)
  type Key = { app: string; collection: string; docId: string }
  type Row = Key & { data: unknown; updatedAt: Date }
  let after: Key | null = null
  for (;;) {
    const cursor: Key | null = after
    const rows: Row[] = await withRlsContext(actor, (tx) =>
      tx
        .select({
          app: appDocuments.app,
          collection: appDocuments.collection,
          docId: appDocuments.docId,
          data: appDocuments.data,
          updatedAt: appDocuments.updatedAt,
        })
        .from(appDocuments)
        .where(
          and(
            eq(appDocuments.orgId, orgId),
            indexedCollectionsFilter(orgId),
            cursor
              ? sql`(${appDocuments.app}, ${appDocuments.collection}, ${appDocuments.docId}) > (${cursor.app}, ${cursor.collection}, ${cursor.docId})`
              : undefined,
          ),
        )
        .orderBy(asc(appDocuments.app), asc(appDocuments.collection), asc(appDocuments.docId))
        .limit(REBUILD_PAGE),
    )
    if (rows.length === 0) break
    const docs: Record<string, unknown>[] = []
    for (const row of rows) {
      const decl = indexedCollection(orgId, row.app, row.collection)
      if (!decl) continue
      docs.push(
        buildAppDocumentSearchDoc(
          orgId,
          decl,
          row.docId,
          row.data as Record<string, unknown>,
          row.updatedAt,
        ),
      )
    }
    if (docs.length > 0) await sink(docs)
    const last = rows[rows.length - 1]!
    after = { app: last.app, collection: last.collection, docId: last.docId }
    if (rows.length < REBUILD_PAGE) break
  }
}

registerIndexSource(APP_DOCUMENT_INDEX_SOURCE, (orgId, sink) =>
  streamAppDocumentsForRebuild(orgId, (docs) => sink(docs)),
)

/* -------------------------------------------------------------------------- */
/* Query path                                                                 */
/* -------------------------------------------------------------------------- */

/** The read scopes of the org's indexed collections, for the permission filter. */
export function appDocumentSearchReadScopes(orgId: string): string[] {
  const scopes = new Set<string>([APP_DOCUMENT_SEARCH_REGISTRATION.readScope])
  for (const d of listDeclaredCollections(orgId)) {
    if (d.searchable && d.agentReadable) scopes.add(d.readScope)
  }
  return [...scopes]
}

interface HitLike {
  entity_type?: unknown
  entity_id?: unknown
}

/**
 * Drop data store hits the searcher may not see as things stand now: the
 * collection is no longer declared searchable and agent-readable, its read
 * scope is not one the searcher holds, or no row backs the document any more.
 * Other hits pass untouched, in order.
 */
export async function rejectStaleAppDocumentHits<H extends HitLike>(
  actor: { orgId: string; scopes: string[] },
  hits: H[],
): Promise<H[]> {
  const candidates = new Map<H, { app: string; collection: string; docId: string }>()
  for (const h of hits) {
    if (h.entity_type !== APP_DOCUMENT_ENTITY_TYPE) continue
    const ref = parseAppDocumentEntityId(h.entity_id)
    if (!ref) continue
    const decl = indexedCollection(actor.orgId, ref.app, ref.collection)
    if (decl && hasScope(decl.readScope, actor.scopes)) candidates.set(h, ref)
  }
  const present = new Set<string>()
  if (candidates.size > 0) {
    const refs = [...candidates.values()]
    const rows = await withRlsContext(storeReader(actor.orgId), (tx) =>
      tx
        .select({
          app: appDocuments.app,
          collection: appDocuments.collection,
          docId: appDocuments.docId,
        })
        .from(appDocuments)
        .where(
          and(
            eq(appDocuments.orgId, actor.orgId),
            inArray(
              appDocuments.docId,
              refs.map((r) => r.docId),
            ),
            or(
              ...refs.map((r) =>
                and(eq(appDocuments.app, r.app), eq(appDocuments.collection, r.collection)),
              ),
            ),
          ),
        ),
    )
    for (const r of rows) present.add(`${r.app}\0${r.collection}\0${r.docId}`)
  }
  return hits.filter((h) => {
    if (h.entity_type !== APP_DOCUMENT_ENTITY_TYPE) return true
    const ref = candidates.get(h)
    return ref ? present.has(`${ref.app}\0${ref.collection}\0${ref.docId}`) : false
  })
}
