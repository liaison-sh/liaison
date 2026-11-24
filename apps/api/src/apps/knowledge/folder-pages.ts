// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Folder pages (S20): a folder's own text is an ordinary page, pointed at by
 * `collections.index_document_id`, made on the first edit.
 *
 * - The page is titled as the folder, filed in it, and shared like a new page of
 *   that place: everyone edits it in a shared folder, nobody else sees it in a
 *   personal one. After that it has its own sharing, like any page.
 * - Making it is a folder write (the page is filed in the folder and the folder
 *   points at it), so it needs the folder scope and the create scope. Concurrent
 *   first edits are serialised on the folder row: one page, the others get it.
 * - The folder view lists what is directly inside that the reader may open
 *   (row security decides), never the page itself; a reader who may not open the
 *   page gets the list and nothing of the page.
 * - Renaming the folder renames the page when the renamer may edit it; renaming
 *   the page renames the folder when the renamer may manage folders.
 * - The page stops being the folder's page when it goes to Trash, or leaves the
 *   folder (moved, taken out). Deleting the folder leaves a page with text where
 *   the folder's content goes (its parent, or Unfiled) and moves an empty one to
 *   Trash when the person deleting may do that; otherwise it stays an ordinary page.
 * - A folder a live sync governs has no page (its content belongs to the source).
 *
 * The folder row may point at a page the reader cannot see, or at one in Trash
 * (moved there by someone without the folder scope, who cannot clear the pointer).
 * Neither is shown; a page in Trash no longer counts, so a new first edit replaces it.
 */
import { knowledgeCreateDocumentSchema } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import {
  FolderScopeError,
  isSynced,
  type KnowledgeCollectionRow,
  loadCollection,
  queueFolderEvent,
  requireCollectionsScope,
} from "~/apps/knowledge/collections"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  archiveKnowledgeDocument,
  canEditDocumentRow,
  createKnowledgeDocument,
  type KnowledgeActor,
  type KnowledgeDocumentRow,
  KnowledgeError,
  loadDocumentShareRole,
  loadKnowledgeDocument,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { hasScope } from "~/modules/permissions/permissions"

/** How many folders, and how many pages, a folder view lists at most. */
export const FOLDER_LIST_LIMIT = 500

/** A folder name is at most this long (knowledgeCollectionSchema). */
const FOLDER_NAME_MAX = 120

const notFound = () => new KnowledgeError("NOT_FOUND", "Knowledge item not found")

const canManageFolders = (actor: KnowledgeActor) =>
  hasScope("knowledge:collections:manage", actor.scopes)

const canCreatePages = (actor: KnowledgeActor) =>
  hasScope("knowledge:documents:create", actor.scopes) ||
  hasScope("knowledge:documents:admin", actor.scopes)

export interface FolderPageView {
  folder: {
    id: string
    name: string
    parentId: string | null
    ownerUserId: string | null
    synced: boolean
  }
  /** The folder's page, when it has one the reader may open; null otherwise. */
  page: (KnowledgeDocumentRow & { canEdit: boolean }) | null
  /** The reader may write the first text of a page this folder does not have. */
  canStartPage: boolean
  folders: Array<{ id: string; name: string }>
  pages: Array<{ id: string; title: string }>
  /** More folders or pages are inside than listed. */
  more: boolean
}

/** A live folder the person sees, or NOT_FOUND. */
async function liveFolder(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<KnowledgeCollectionRow> {
  const folder = await loadCollection(tx, id, actor)
  if (!folder || folder.archivedAt) throw notFound()
  return folder
}

/**
 * What the folder row points at, as this person's row security shows it: no
 * pointer, a page in Trash (`trashed`: the pointer no longer counts), or a page
 * that counts (live, or one the person cannot see at all).
 */
async function pointerOf(
  tx: RlsClient,
  folderId: string,
  actor: KnowledgeActor,
  lock: boolean,
): Promise<{ id: string | null; trashed: boolean }> {
  const [row] = extractRows<{ id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT index_document_id::text AS id FROM ${knowledgeRel("collections")}
       WHERE id = ${folderId}::uuid AND org_id = ${actor.orgId}::uuid
       ${lock ? drizzleSql`FOR UPDATE` : drizzleSql``}`),
  )
  const id = row?.id ?? null
  if (!id) return { id: null, trashed: false }
  const [doc] = extractRows<{ archived: boolean }>(
    await tx.execute(drizzleSql`
      SELECT archived_at IS NOT NULL AS archived FROM ${knowledgeRel("documents")}
       WHERE id = ${id}::uuid AND org_id = ${actor.orgId}::uuid`),
  )
  return { id, trashed: doc?.archived === true }
}

/** The page with its edit flag, when the reader may open it. */
async function openablePage(
  tx: RlsClient,
  id: string,
  actor: KnowledgeActor,
): Promise<(KnowledgeDocumentRow & { canEdit: boolean }) | null> {
  const doc = await loadKnowledgeDocument(tx, id, actor)
  if (!doc || doc.archivedAt) return null
  const shareRole = await loadDocumentShareRole(tx, doc.id, actor)
  return { ...doc, canEdit: canEditDocumentRow(doc, actor, shareRole) }
}

/** GET /collections/:id/page: the folder's page and what is inside, for this reader. */
export async function readFolderPage(
  tx: RlsClient,
  folderId: string,
  actor: KnowledgeActor,
): Promise<FolderPageView> {
  const folder = await liveFolder(tx, folderId, actor)
  const synced = await isSynced(tx, folder.id)
  const pointer = await pointerOf(tx, folder.id, actor, false)
  // `indexDocumentId` is set only when the reader may open the page.
  const page =
    !synced && folder.indexDocumentId ? await openablePage(tx, folder.indexDocumentId, actor) : null

  const folders = extractRows<{ id: string; name: string }>(
    await tx.execute(drizzleSql`
      SELECT c.id::text AS id, c.name FROM ${knowledgeRel("collections")} c
       WHERE c.org_id = ${actor.orgId}::uuid AND c.parent_collection_id = ${folder.id}::uuid
         AND c.archived_at IS NULL
         AND (c.owner_user_id IS NULL OR c.owner_user_id::text = ${actor.userId})
       ORDER BY lower(c.name), c.name, c.id
       LIMIT ${FOLDER_LIST_LIMIT + 1}`),
  )
  // Row security on documents keeps out every page the reader may not open.
  const pages = extractRows<{ id: string; title: string }>(
    await tx.execute(drizzleSql`
      SELECT d.id::text AS id, d.title FROM ${knowledgeRel("collection_memberships")} m
        JOIN ${knowledgeRel("documents")} d ON d.id = m.target_id AND d.org_id = m.org_id
       WHERE m.org_id = ${actor.orgId}::uuid AND m.collection_id = ${folder.id}::uuid
         AND m.target_type = 'document' AND d.archived_at IS NULL
         AND d.id IS DISTINCT FROM ${pointer.id}::uuid
       ORDER BY lower(d.title), d.title, d.id
       LIMIT ${FOLDER_LIST_LIMIT + 1}`),
  )
  const more = folders.length > FOLDER_LIST_LIMIT || pages.length > FOLDER_LIST_LIMIT

  return {
    folder: {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentCollectionId,
      ownerUserId: folder.ownerUserId,
      synced,
    },
    page,
    canStartPage:
      !synced &&
      canManageFolders(actor) &&
      canCreatePages(actor) &&
      (pointer.id === null || pointer.trashed),
    folders: folders.slice(0, FOLDER_LIST_LIMIT),
    pages: pages.slice(0, FOLDER_LIST_LIMIT),
    more,
  }
}

/**
 * POST /collections/:id/page: the folder's page, made now if it has none (the
 * first edit). `body` is the first text, used only when the page is made here.
 */
export async function ensureIndexDocument(
  tx: RlsClient,
  folderId: string,
  actor: KnowledgeActor,
  input: { body?: string } = {},
): Promise<{ page: KnowledgeDocumentRow; created: boolean }> {
  requireCollectionsScope(actor)
  if (!canManageFolders(actor)) throw new FolderScopeError()
  if (!canCreatePages(actor)) {
    throw new FolderScopeError("Forbidden: you cannot create Knowledge pages")
  }
  const folder = await liveFolder(tx, folderId, actor)
  if (await isSynced(tx, folder.id)) {
    throw new KnowledgeError(
      "VALIDATION",
      "This folder is synced from another app, so it has no page of its own.",
    )
  }

  // Every first edit of this folder waits here for the one before it.
  const pointer = await pointerOf(tx, folder.id, actor, true)
  if (pointer.id && !pointer.trashed) {
    const existing = await openablePage(tx, pointer.id, actor)
    // A page the person cannot open: refused like an unknown folder, naming nothing.
    if (!existing) throw notFound()
    return { page: existing, created: false }
  }

  const page = await createKnowledgeDocument(
    tx,
    knowledgeCreateDocumentSchema.parse({
      title: folder.name,
      body: input.body ?? "",
      documentScope: "organization",
      orgAccess: folder.ownerUserId === null ? "editor" : "none",
      collectionIds: [folder.id],
    }),
    actor,
    [],
  )
  const set = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("collections")}
         SET index_document_id = ${page.id}::uuid, updated_at = now()
       WHERE id = ${folder.id}::uuid AND org_id = ${actor.orgId}::uuid
         AND index_document_id IS NOT DISTINCT FROM ${pointer.id}::uuid
      RETURNING id`),
  )
  if (set.length === 0) {
    throw new KnowledgeError("REVISION_CONFLICT", "This folder's page was just made. Reload it.")
  }
  await queueFolderEvent(tx, "update", folder, folder, actor)
  return { page, created: true }
}

/**
 * The page stops being a folder's page: it went to Trash (`folderId` absent: any
 * folder) or left that folder. Only a person who may manage folders can write
 * the folder row; for anyone else a page in Trash simply stops counting.
 */
export async function detachFolderPage(
  tx: RlsClient,
  actor: KnowledgeActor,
  documentId: string,
  folderId?: string,
): Promise<void> {
  if (!canManageFolders(actor)) return
  const rows = extractRows<{ id: string; owner_user_id: string | null }>(
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("collections")}
         SET index_document_id = NULL, updated_at = now()
       WHERE org_id = ${actor.orgId}::uuid AND index_document_id = ${documentId}::uuid
         ${folderId ? drizzleSql`AND id = ${folderId}::uuid` : drizzleSql``}
      RETURNING id::text AS id, owner_user_id::text AS owner_user_id`),
  )
  for (const r of rows) {
    const row = { id: r.id, ownerUserId: r.owner_user_id }
    await queueFolderEvent(tx, "update", row, row, actor)
  }
}

/** The folder was renamed: its page takes the name, when the renamer may edit it. */
export async function followFolderRename(
  tx: RlsClient,
  folder: KnowledgeCollectionRow,
  actor: KnowledgeActor,
): Promise<void> {
  if (!folder.indexDocumentId) return
  const page = await openablePage(tx, folder.indexDocumentId, actor)
  if (!page?.canEdit || page.title === folder.name) return
  await updateKnowledgeDocument(
    tx,
    { id: page.id, revision: page.revision, title: folder.name },
    actor,
    [],
  )
}

/** A page was renamed: the folders it is the page of take the name. */
export async function followPageRename(
  tx: RlsClient,
  documentId: string,
  title: string,
  actor: KnowledgeActor,
): Promise<void> {
  if (!canManageFolders(actor)) return
  const name = title.trim().slice(0, FOLDER_NAME_MAX).trim()
  if (!name) return
  const folders = extractRows<{ id: string; owner_user_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, owner_user_id::text AS owner_user_id
        FROM ${knowledgeRel("collections")}
       WHERE org_id = ${actor.orgId}::uuid AND index_document_id = ${documentId}::uuid
         AND archived_at IS NULL AND name IS DISTINCT FROM ${name}`),
  )
  for (const f of folders) {
    if (await isSynced(tx, f.id)) continue
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("collections")} SET name = ${name}, updated_at = now()
       WHERE id = ${f.id}::uuid AND org_id = ${actor.orgId}::uuid`)
    const row = { id: f.id, ownerUserId: f.owner_user_id }
    await queueFolderEvent(tx, "update", row, row, actor)
  }
}

/**
 * The folder is being deleted, its content already moved to its parent: it keeps
 * no page. Its page, if it has no text and the person may move it to Trash, goes
 * there; otherwise it stays, an ordinary page where the folder's content went.
 */
export async function releaseFolderPage(
  tx: RlsClient,
  folderId: string,
  pageId: string | null,
  actor: KnowledgeActor,
): Promise<void> {
  if (!pageId) return
  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel("collections")} SET index_document_id = NULL
     WHERE id = ${folderId}::uuid AND org_id = ${actor.orgId}::uuid`)
  const page = await openablePage(tx, pageId, actor)
  if (!page?.canEdit || page.body.trim() !== "" || page.syncedSourceId) return
  if (
    !hasScope("knowledge:documents:archive", actor.scopes) &&
    !hasScope("knowledge:documents:admin", actor.scopes)
  ) {
    return
  }
  await archiveKnowledgeDocument(tx, page.id, actor)
}

/** The page a folder points at, as stored, for the folder's own delete. */
export async function storedPointer(
  tx: RlsClient,
  folderId: string,
  actor: KnowledgeActor,
): Promise<string | null> {
  return (await pointerOf(tx, folderId, actor, true)).id
}
