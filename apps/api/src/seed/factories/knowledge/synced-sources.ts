// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The synced knowledge sources factory: a folder synced from a provider
// (GitLab, Google Drive, ...) and a document written in Liaison, each with
// the sharing a real company would give it.
//
// THE SOURCES ARE REAL ROWS, THE PROVIDERS ARE NOT. A seeded org reaches no
// provider, so each source is created and synced once through the product's
// own path (`createSyncedSource`, then `reconcileSyncedSource`) with a fixture
// adapter that lists fixed files instead of calling the provider. Everything
// the app reads afterwards (the source rows, the synced documents with their
// provenance, the collections, the search index) is what a real sync writes.
// Sharing is set with `setDocumentSharing`, the call the Share dialog makes.
//
// Privileged: the reconciler runs on the privileged connection in the product
// too (the sync worker), and the source and its documents are then stamped
// with the time their (seeded) sync ran (`stampSyncHistory`: HISTORY, a sync
// that ran a while ago). Reading the org's roles and finding an existing
// source are privileged reads, as in the sync worker. Everything else runs as
// the author, on an RLS transaction.
import { eq, sql } from "drizzle-orm"
import {
  createKnowledgeDocument,
  findOrgDocByTitle,
  setDocumentSharing,
} from "~/apps/knowledge/service"
import type { KnowledgeFolderItem, KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { reconcileSyncedSource } from "~/apps/knowledge/sync-reconciler"
import {
  createSyncedSource,
  rowFromDb,
  type SyncedSourceDbRow,
  type SyncedSourceRow,
} from "~/apps/knowledge/synced-sources"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { roles } from "~/db/schema/kernel/roles"
import { seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"
import { findOrCreateCollection, knowledgeAuthor } from "./articles"

/** A document's sharing, as the Share dialog sets it. */
export type DocumentSharing = Parameters<typeof setDocumentSharing>[2]

export interface SyncedFileSpec {
  externalId: string
  name: string
  /** Where the provider would open it. */
  url: string
  modifiedHoursAgo: number
  body: string
}

export interface SyncedSourceSeed {
  appName: string
  folderRef: string
  displayName: string
  defaultSensitivity: "internal" | "confidential"
  /** How long ago its last (seeded) sync ran. */
  lastSyncHoursAgo: number
  files: readonly SyncedFileSpec[]
  /** The sharing every document of the source gets. */
  sharing: DocumentSharing
}

/**
 * A source adapter that lists the fixed files of `spec` instead of calling the
 * provider: what the reconciler is handed for the one seeded sync.
 */
function fixtureAdapter(spec: SyncedSourceSeed, now: Date): KnowledgeSourceAdapter {
  const clock = seedClock(now)
  const items: KnowledgeFolderItem[] = spec.files.map((file) => ({
    kind: "file",
    externalId: file.externalId,
    name: file.name,
    parentExternalId: spec.folderRef,
    mimeType: "text/markdown",
    modifiedAt: clock.hoursBefore(file.modifiedHoursAgo).toISOString(),
    url: file.url,
  }))
  const byId = new Map(spec.files.map((file) => [file.externalId, file]))
  return {
    source: spec.appName as KnowledgeSourceAdapter["source"],
    async searchRemote() {
      return {
        hits: [],
        status: {
          source: spec.appName as KnowledgeSourceAdapter["source"],
          state: "complete",
          retryable: false,
        },
      }
    },
    async listFolder(input) {
      return { items: input.folderRef === spec.folderRef ? items : [] }
    },
    async fetchRemoteContent(input) {
      const file = byId.get(input.sourceEntityId)
      return file ? { status: "ok", text: file.body, url: file.url } : { status: "unavailable" }
    },
  }
}

/** The org's role ids by role name. */
export async function roleIdsByName(ctx: SeedContext): Promise<Map<string, string>> {
  const rows = await withPrivilegedDb(ctx.orgId, "seed-knowledge-sources:roles", (tx) =>
    tx.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.orgId, ctx.orgId)),
  )
  return new Map(rows.map((r) => [r.name, r.id]))
}

/**
 * The org's source for the spec's app and folder, created as `admin` (through
 * the product's `createSyncedSource`) when there is none yet. Either way the
 * row is the seeded org's own: found by a query pinned to it, or created by
 * an author acting in it.
 */
async function findOrCreateSource(
  ctx: SeedContext,
  admin: UserContext,
  spec: SyncedSourceSeed,
  adapter: KnowledgeSourceAdapter,
): Promise<SyncedSourceRow> {
  const rows = await withPrivilegedDb(ctx.orgId, "seed-knowledge-sources:find", async (tx) =>
    rowsOf<SyncedSourceDbRow>(
      await tx.execute(sql`SELECT * FROM app_knowledge.synced_sources
        WHERE org_id = ${ctx.orgId}::uuid AND app_name = ${spec.appName}
          AND folder_ref = ${spec.folderRef} AND archived_at IS NULL
        LIMIT 1`),
    ),
  )
  const row = rows[0]
  if (row) {
    const found = { ...rowFromDb(row), orgId: ctx.orgId }
    return found
  }
  const author = knowledgeAuthor(ctx, admin)
  const created = await asUser(admin, (tx) =>
    createSyncedSource(
      tx as never,
      {
        appName: spec.appName as never,
        folderRef: spec.folderRef,
        displayName: spec.displayName,
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: spec.defaultSensitivity,
      },
      author,
      { adapter },
    ),
  )
  const source = { ...created, orgId: ctx.orgId }
  return source
}

/**
 * HISTORY: the source's last sync ran `lastSyncHoursAgo` before the base time,
 * as a real one would have. Returns the source's live documents.
 */
async function stampSyncHistory(
  ctx: SeedContext,
  sourceId: string,
  syncedAt: Date,
): Promise<Array<{ id: string; title: string }>> {
  return withPrivilegedDb(ctx.orgId, "seed-knowledge-sources:docs", async (tx) => {
    const at = syncedAt.toISOString()
    await tx.execute(sql`UPDATE app_knowledge.synced_sources
      SET last_sync_at = ${at}::timestamptz, last_sync_status = 'ok', last_error = NULL
      WHERE id = ${sourceId}::uuid`)
    await tx.execute(sql`UPDATE app_knowledge.documents
      SET last_synced_at = ${at}::timestamptz
      WHERE synced_source_id = ${sourceId}::uuid`)
    return rowsOf<{ id: string; title: string }>(
      await tx.execute(sql`SELECT id, title FROM app_knowledge.documents
        WHERE synced_source_id = ${sourceId}::uuid AND archived_at IS NULL`),
    )
  })
}

/**
 * Create (or find, by app and folder) each source as `admin`, sync it once
 * through the reconciler, stamp the sync's time and share every document.
 */
export async function seedSyncedSources(
  ctx: SeedContext,
  admin: UserContext,
  sources: readonly SyncedSourceSeed[],
): Promise<{ syncedSourceIds: string[]; collectionIds: string[]; documentIds: string[] }> {
  const author = knowledgeAuthor(ctx, admin)
  const clock = seedClock(ctx.now)
  const syncedSourceIds: string[] = []
  const collectionIds: string[] = []
  const documentIds: string[] = []
  for (const spec of sources) {
    const adapter = fixtureAdapter(spec, ctx.now)
    const source = await findOrCreateSource(ctx, admin, spec, adapter)
    await reconcileSyncedSource(source, adapter)
    syncedSourceIds.push(source.id)
    collectionIds.push(source.rootCollectionId)
    const docs = await stampSyncHistory(ctx, source.id, clock.hoursBefore(spec.lastSyncHoursAgo))
    for (const doc of docs) {
      await asUser(admin, (tx) => setDocumentSharing(tx as never, doc.id, spec.sharing, author))
      documentIds.push(doc.id)
    }
  }
  return { syncedSourceIds, collectionIds, documentIds }
}

/**
 * A document written in Liaison, in a collection of its own, with its sharing:
 * the collection is found by name and the document by title on a re-run.
 */
export async function seedWrittenDocument(
  ctx: SeedContext,
  admin: UserContext,
  input: {
    collection: { name: string; description: string; ownerUserId: string }
    document: {
      title: string
      summary: string
      body: string
      ownerUserId: string
      tags: string[]
      sensitivity: "public" | "internal" | "confidential" | "restricted"
      orgAccess: "none" | "viewer" | "editor"
      verifyNow: boolean
    }
    sharing: DocumentSharing
  },
): Promise<{ collectionId: string; documentId: string }> {
  const author = knowledgeAuthor(ctx, admin)
  const collectionId = await findOrCreateCollection(ctx, admin, input.collection)
  const doc = input.document
  const documentId = await asUser(admin, async (tx) => {
    const existing = await findOrgDocByTitle(tx as never, ctx.orgId, doc.title, author)
    if (existing) return existing.id
    const created = await createKnowledgeDocument(
      tx as never,
      {
        documentScope: "organization",
        title: doc.title,
        summary: doc.summary,
        body: doc.body,
        collectionIds: [collectionId],
        ownerUserId: doc.ownerUserId,
        tagNames: doc.tags,
        team: [],
        sensitivity: doc.sensitivity,
        orgAccess: doc.orgAccess,
        verifyNow: doc.verifyNow,
      },
      author,
      [],
    )
    return created.id
  })
  await asUser(admin, (tx) => setDocumentSharing(tx as never, documentId, input.sharing, author))
  return { collectionId, documentId }
}
