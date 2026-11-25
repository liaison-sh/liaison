// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import kinds of the knowledge app (modules/imports): `knowledge.collection`
 * and `knowledge.document` (whose parent is `collection`, so one run files
 * documents into the collections it imports).
 *
 * Both write through the knowledge service on the record's transaction, with
 * a knowledge actor built from the person who started the run
 * (`knowledgeActorFromContext`): the service's scope rules, its dimension
 * ladder (a sensitivity outside the person's grant fails `out_of_scope`), its
 * owner rules and its sensitivity → `org_access` default (A6) all apply. The
 * import then stamps the row's `external_ref` (`<source>:<key>`, migration
 * 0208), the dedup key a later run skips on.
 *
 * Which rows a run may use (K-R7). The source label is the dedup space: a
 * built-in import's label is per person for a private import and per
 * organisation for a shared one (builtin/registry.ts). A folder or page found
 * by its key is used (as a parent, a folder to file into, a link target) only
 * when this run made it or the person can read it under their own row
 * security; nothing else is ever written into. Every skip is named in the run
 * report's `losses` with its reason: "already imported", "in Trash" (restore
 * it), "already imported, you cannot open it" (what it held then goes to the
 * top of the import), "already imported, deleted since".
 *
 * Create-only (A14): tags are created with `ON CONFLICT DO NOTHING` and an
 * existing tag is reused untouched (the service's tag upsert bumps it, so tags
 * never go through the service); taggings and memberships are inserted for the
 * new document only.
 *
 * A document (K-R10): the page is created (a private page is an organisation
 * page with no access, C7) with its text free of `import-file:` links; each
 * named file (`attachments[].ref`) is copied onto it in its own savepoint (one
 * that fails is named and its link becomes its text, the page and the other
 * files stay); one body update then writes the file tokens; then the page's
 * first version (`import`) records that text. Attachments without a `ref` are
 * uploads the person can see (A9), attached with `attachFileToParent`; one that
 * fails fails its record. A page that is a folder's own page
 * (`indexOfCollectionRef`) is filed in that folder and becomes its page when
 * this run made the folder.
 *
 * Links (`afterKind`, K-R9): once every page of the run is written, each page
 * still naming `[label](notion-ref:<key>)` has it replaced, under a row lock,
 * by the token of the page with that key (this run's, or an earlier run's of
 * the same label that the person reads), or by its label when there is none
 * (named). The revision moves on, so an editor opened before gets a conflict
 * (and a later save resolves the links again, body-tokens.ts); `updated_at`
 * does not, since undo reads it as someone's edit.
 *
 * Every created row is returned for the undo ledger: the collection; the
 * document, its memberships, the tags it created, its taggings, its files and
 * its import version.
 */
import { randomUUID } from "node:crypto"
import { fileToken } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { adoptable, importPageRefsOf, replaceImportPageRefs } from "~/apps/knowledge/body-tokens"
import { createKnowledgeCollection } from "~/apps/knowledge/collections"
import { refreshDocumentLinks } from "~/apps/knowledge/links"
import { kernelRel, knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  KnowledgeError,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import { md5 } from "~/apps/knowledge/versions"
import { extractRows, type PrivilegedDb } from "~/db"
import {
  deleteObjects,
  sanitizeFilename,
  copyObject as storageCopyObject,
} from "~/infra/storage/object-storage"
import { knowledgeLogger as log } from "~/lib/logger"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { attachFileToParent, isBlockedFileType } from "~/modules/files/attach"
import { buildStorageKey, loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"
import { importServiceClient } from "~/modules/imports/service-client"
import {
  dedupMatchSql,
  dedupValueOf,
  type HostAfterKindOutcome,
  type HostCheckOutcome,
  type HostImportContext,
  type HostImportHandler,
  type ImportRowRef,
} from "~/modules/imports/types"
import { hasScope } from "~/modules/permissions/permissions"

/** The canonical collection record. */
export const collectionImportRecordSchema = z
  .object({
    externalRef: z.string().min(1),
    name: z.string().trim().min(1).max(240),
    description: z.string().max(2000).optional().nullable(),
    parentExternalRef: z.string().min(1).optional().nullable(),
    /** Org-shared (no owner) rather than the importing person's own. */
    shared: z.boolean().optional(),
  })
  .strict()

/** Something a record could not carry, named in the run report. */
const lossSchema = z
  .object({ what: z.string().min(1).max(2000), where: z.string().max(500) })
  .strict()
type Loss = z.infer<typeof lossSchema>

/** The canonical document record. */
export const documentImportRecordSchema = z
  .object({
    externalRef: z.string().min(1),
    title: z.string().trim().min(1).max(240),
    body: z.string().max(1_000_000),
    summary: z.string().max(1000).optional().nullable(),
    collectionRefs: z.array(z.string().min(1)).max(500).optional(),
    tagNames: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
    team: z.array(z.string().trim().min(1)).max(50).optional(),
    documentScope: z.enum(["org", "personal"]).optional(),
    ownerEmail: z.string().max(320).optional().nullable(),
    /** Who in the organisation sees the page (an organisation page). */
    orgAccess: z.enum(["none", "viewer", "editor"]).optional(),
    /** The page is this imported folder's own page. */
    indexOfCollectionRef: z.string().min(1).optional(),
    losses: z.array(lossSchema).max(500).optional(),
    attachments: z
      .array(
        z.object({ fileId: z.string().min(1), ref: z.string().min(1).max(64).optional() }).strict(),
      )
      .max(500)
      .optional(),
  })
  .strict()
type DocumentRecord = z.infer<typeof documentImportRecordSchema>

/** The knowledge actor of the person who started the run (or `asUserId`). */
function knowledgeActor(ctx: HostImportContext, asUserId = ctx.actorUserId) {
  return knowledgeActorFromContext({
    orgId: ctx.orgId,
    userId: asUserId,
    scopes: ctx.actorScopes,
    dimensionGrants: ctx.actorDimensionGrants,
  })
}

// ---------------------------------------------------------------------------
// Which existing rows a run may use (K-R7)
// ---------------------------------------------------------------------------

type KnowledgeTable = "documents" | "collections"

/** A row an earlier record (of this run or another) stamped with this key. */
async function rowByRef(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  table: KnowledgeTable,
  ref: string,
): Promise<{ id: string; gone: boolean } | null> {
  const gone =
    table === "documents"
      ? drizzleSql`(archived_at IS NOT NULL OR trashed_at IS NOT NULL)`
      : drizzleSql`(archived_at IS NOT NULL)`
  const rows = extractRows<{ id: string; gone: boolean }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, ${gone} AS gone FROM ${knowledgeRel(table)}
      WHERE org_id = ${ctx.orgId}::uuid
        AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, ref)}
      LIMIT 1
    `),
  )
  return rows[0] ?? null
}

/** Did this run make the row? (Its ledger, read in the run's own transaction.) */
async function madeByThisRun(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  table: KnowledgeTable,
  id: string,
): Promise<boolean> {
  const rows = extractRows(
    await tx.execute(drizzleSql`
      SELECT 1 FROM ${kernelRel("import_ledger")}
      WHERE org_id = ${ctx.orgId}::uuid AND run_id = ${ctx.runId}::uuid
        AND table_name = ${`app_knowledge.${table}`} AND row_id = ${id}::uuid
      LIMIT 1
    `),
  )
  return rows.length > 0
}

/** The ids among `ids` the person reads, under their own row security. */
async function readableIds(
  ctx: HostImportContext,
  table: KnowledgeTable,
  ids: string[],
): Promise<Set<string>> {
  const out = new Set<string>()
  const ask: string[] = []
  for (const id of ids) {
    const known = ctx.cache.get(`readable:${table}:${id}`)
    if (known === true) out.add(id)
    else if (known === undefined) ask.push(id)
  }
  if (ask.length === 0) return out
  const seen = await ctx.withActorRls(async (rls) =>
    extractRows<{ id: string }>(
      await rls.execute(drizzleSql`
        SELECT id::text AS id FROM ${knowledgeRel(table)}
        WHERE org_id = ${ctx.orgId}::uuid AND id = ANY(${`{${ask.join(",")}}`}::uuid[])
      `),
    ),
  )
  const yes = new Set(seen.map((r) => r.id))
  for (const id of ask) {
    ctx.cache.set(`readable:${table}:${id}`, yes.has(id))
    if (yes.has(id)) out.add(id)
  }
  return out
}

/** Why an existing row is skipped, in the words the report shows. */
async function skipReason(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  table: KnowledgeTable,
  row: { id: string; gone: boolean },
): Promise<string> {
  if (row.gone) return table === "documents" ? "in Trash" : "already imported, deleted since"
  if (await madeByThisRun(tx, ctx, table, row.id)) return "already imported"
  if ((await readableIds(ctx, table, [row.id])).has(row.id)) return "already imported"
  return "already imported, you cannot open it"
}

/** Folders a preview would create (nothing is written in a preview). */
function previewFolders(ctx: HostImportContext): Set<string> {
  const cache = ctx.runCache ?? ctx.cache
  let set = cache.get("knowledge:preview-folders") as Set<string> | undefined
  if (!set) {
    set = new Set()
    cache.set("knowledge:preview-folders", set)
  }
  return set
}

type FolderUse = { id: string; mine: boolean } | "unusable" | "pending" | null

/**
 * The folder a key names, if this run may use it: made by this run, or read by
 * the person. `unusable`: it exists, in no state to file into. `pending`: a
 * preview's folder that the run would create. `null`: no folder has the key.
 */
async function folderByRef(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  ref: string,
  preview: boolean,
): Promise<FolderUse> {
  const row = await rowByRef(tx, ctx, "collections", ref)
  if (!row) return preview && previewFolders(ctx).has(ref) ? "pending" : null
  if (row.gone) return "unusable"
  if (await madeByThisRun(tx, ctx, "collections", row.id)) return { id: row.id, mine: true }
  if ((await readableIds(ctx, "collections", [row.id])).has(row.id)) {
    return { id: row.id, mine: false }
  }
  return "unusable"
}

const skipped = (what: string, where: string) => ({
  status: "skipped" as const,
  rows: [],
  report: { losses: [{ what, where }] },
})

async function stampExternalRef(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  table: KnowledgeTable,
  id: string,
  dedupValue: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    UPDATE ${knowledgeRel(table)} SET external_ref = ${dedupValue}
    WHERE id = ${id}::uuid AND org_id = ${ctx.orgId}::uuid
  `)
}

/** An ACTIVE org user by email, or null. */
async function activeUserByEmail(
  tx: PrivilegedDb,
  orgId: string,
  email: string,
): Promise<string | null> {
  const e = email.trim().toLowerCase()
  if (!e) return null
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid AND lower(email) = ${e} AND status = 'active'
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** The parent a collection goes under: null at the top (also for a parent it may not use). */
async function parentOf(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  ref: string | null | undefined,
  preview: boolean,
): Promise<string | null> {
  if (!ref) return null
  const parent = await folderByRef(tx, ctx, ref, preview)
  if (parent === null) {
    throw new Error(
      `parentExternalRef "${ref}" does not resolve to an imported collection: order parents before children`,
    )
  }
  return typeof parent === "object" ? parent.id : null
}

async function importCollection(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = collectionImportRecordSchema.parse(raw)
  const existing = await rowByRef(tx, ctx, "collections", record.externalRef)
  if (existing) {
    return skipped(await skipReason(tx, ctx, "collections", existing), record.name)
  }
  const parentCollectionId = await parentOf(tx, ctx, record.parentExternalRef, false)
  const created = await createKnowledgeCollection(
    importServiceClient(tx),
    {
      name: record.name,
      description: record.description ?? null,
      parentCollectionId,
      // Shared unless the record says otherwise (a subfolder follows its parent).
      ownerUserId: record.shared === false ? ctx.actorUserId : null,
    },
    knowledgeActor(ctx),
  )
  await stampExternalRef(tx, ctx, "collections", created.id, dedupValue)
  return {
    status: "created" as const,
    rows: [{ table: "app_knowledge.collections", id: created.id }],
  }
}

async function checkCollection(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<HostCheckOutcome> {
  const record = collectionImportRecordSchema.parse(raw)
  const existing = await rowByRef(tx, ctx, "collections", record.externalRef)
  if (existing) {
    const s = skipped(await skipReason(tx, ctx, "collections", existing), record.name)
    return { status: "skipped", report: s.report }
  }
  await parentOf(tx, ctx, record.parentExternalRef, true)
  previewFolders(ctx).add(record.externalRef)
  return { status: "created" }
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** Tags by name: an existing one is reused untouched, a missing one created. */
async function ensureTags(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  names: string[],
): Promise<{ ids: string[]; created: string[] }> {
  const ids: string[] = []
  const created: string[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    const normalized = name.toLowerCase().replace(/\s+/g, " ")
    if (!name || seen.has(normalized)) continue
    seen.add(normalized)
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${knowledgeRel("tags")} (id, org_id, name, normalized_name)
        VALUES (gen_random_uuid(), ${ctx.orgId}::uuid, ${name}, ${normalized})
        ON CONFLICT (org_id, normalized_name) DO NOTHING
        RETURNING id
      `),
    )[0]
    if (inserted) {
      ids.push(inserted.id)
      created.push(inserted.id)
      continue
    }
    const existing = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${knowledgeRel("tags")}
        WHERE org_id = ${ctx.orgId}::uuid AND normalized_name = ${normalized}
      `),
    )[0]
    if (existing) ids.push(existing.id)
  }
  return { ids, created }
}

/** A file link of an import's text: `![alt](import-file:<ref>)` or `[label](import-file:<ref>)`. */
const IMPORT_FILE_RE = /!?\[((?:\\.|[^\]\\])*)\]\(import-file:([A-Za-z0-9_.-]{1,64})\)/g

/** The text with each copied file as its token and every other file link as its label. */
function withFileTokens(body: string, copied: ReadonlyMap<string, string>): string {
  return body.replace(IMPORT_FILE_RE, (_whole, label: string, ref: string) => {
    const id = copied.get(ref)
    return id ? fileToken(id) : label.replace(/\\(.)/g, "$1")
  })
}

let copyOverride: ((args: { sourceKey: string; destKey: string }) => Promise<void>) | null = null

/** Test seam: the storage copy of an imported file. */
export const KnowledgeImportTestAccess = {
  setCopyObject(fn: ((args: { sourceKey: string; destKey: string }) => Promise<void>) | null) {
    copyOverride = fn
  },
}

/**
 * Copy one file of the import onto the page, as a Liaison file of the page: a
 * file the run's transform staged (an extracted zip entry) gets its row and a
 * copy of its bytes; an upload goes through `attachFileToParent` (its
 * encryption envelope travels with it). The row is written before the bytes,
 * so a refused row leaves no object behind. Returns the row and its key.
 */
async function copyFileOntoPage(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  documentId: string,
  fileId: string,
  named: boolean,
): Promise<{ id: string; storageKey: string | null; filename: string }> {
  const src = await ctx.resolveFile(fileId)
  const uploaded = extractRows<{ app: string; entity_type: string; enc_version: number }>(
    await tx.execute(drizzleSql`
      SELECT app, entity_type, enc_version FROM ${kernelRel("files")}
      WHERE org_id = ${ctx.orgId}::uuid AND id::text = ${fileId}
      LIMIT 1
    `),
  )
  if (uploaded[0]) {
    // A file a page names takes the rule of a save (body-tokens.ts): only another
    // Knowledge page's file or a fresh upload, never a sealed one.
    if (named && !adoptable(uploaded[0])) {
      throw new Error("only a Knowledge page's file or a new upload is copied onto a page")
    }
    const copied = await attachFileToParent(
      {
        sourceFileId: fileId,
        target: { app: "knowledge", entityType: "document", entityId: documentId },
      },
      {
        rlsTx: importServiceClient(tx),
        privileged: (_reason, fn) => fn(tx),
        orgId: ctx.orgId,
        userId: ctx.actorUserId,
        actorType: "user",
        scopes: ctx.actorScopes,
        // The page was created for this person in this run, so they edit it (K-R6).
        destinationAuthorized: true,
        ...(copyOverride ? { copyObject: copyOverride } : {}),
      },
    )
    return { id: copied.id, storageKey: null, filename: copied.filename }
  }
  const filename = sanitizeFilename(src.filename)
  if (isBlockedFileType(filename, src.mimeType)) {
    throw new Error("this type of file is never attached")
  }
  const settings = await loadOrgSettings(tx, ctx.orgId)
  if (await wouldExceedOrgQuota(tx, ctx.orgId, settings, Number(src.sizeBytes))) {
    throw new Error("the organization's storage is full")
  }
  const id = randomUUID()
  const storageKey = buildStorageKey({
    orgId: ctx.orgId,
    app: "knowledge",
    entityType: "document",
    entityId: documentId,
    filename,
    objectId: id,
  })
  await tx.execute(drizzleSql`
    INSERT INTO ${kernelRel("files")}
      (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
       storage_key, uploaded_by, disposition)
    VALUES (${id}::uuid, ${ctx.orgId}::uuid, 'knowledge', 'document', ${documentId},
            ${filename}, ${src.mimeType}, ${Number(src.sizeBytes)}, ${storageKey},
            ${ctx.actorUserId}::uuid, 'attachment')
  `)
  await tx.queueEvent({
    app: "kernel",
    entity: "file",
    action: "create",
    entityId: id,
    orgId: ctx.orgId,
    actorId: ctx.actorUserId,
    actorType: "user",
    data: {
      id,
      app: "knowledge",
      entityType: "document",
      entityId: documentId,
      filename,
      mimeType: src.mimeType,
      sizeBytes: Number(src.sizeBytes),
      storageKey,
    },
  })
  await (copyOverride ?? storageCopyObject)({ sourceKey: src.storageKey, destKey: storageKey })
  return { id, storageKey, filename }
}

/** The words a failed copy is named with. */
function copyFailure(err: unknown): string {
  if (err instanceof Error && err.message) return err.message.slice(0, 200)
  return "the file could not be copied"
}

/** Where a page goes: its folders, and the folder it is the page of. */
async function placeOf(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  record: DocumentRecord,
  preview: boolean,
): Promise<{ collectionIds: string[]; indexOf: string | null }> {
  if (record.indexOfCollectionRef) {
    const own = await folderByRef(tx, ctx, record.indexOfCollectionRef, preview)
    if (own === "pending") return { collectionIds: [], indexOf: null }
    if (own && typeof own === "object") {
      return { collectionIds: [own.id], indexOf: own.mine ? own.id : null }
    }
  }
  const collectionIds: string[] = []
  for (const ref of record.collectionRefs ?? []) {
    const folder = await folderByRef(tx, ctx, ref, preview)
    if (folder === null) {
      throw new Error(`collectionRef "${ref}" does not resolve to an imported collection`)
    }
    // A folder this person may not use: the page goes to the top of the import.
    if (typeof folder === "object") collectionIds.push(folder.id)
  }
  return { collectionIds, indexOf: null }
}

/** The refusals a run and its preview share. */
function assertDocumentAllowed(ctx: HostImportContext, record: DocumentRecord) {
  if ((record.tagNames ?? []).length > 0 && !hasScope("knowledge:tags:manage", ctx.actorScopes)) {
    throw new Error("out_of_scope: tagging a document needs knowledge:tags:manage")
  }
}

async function importDocument(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = documentImportRecordSchema.parse(raw)
  const existing = await rowByRef(tx, ctx, "documents", record.externalRef)
  if (existing) return skipped(await skipReason(tx, ctx, "documents", existing), record.title)
  assertDocumentAllowed(ctx, record)
  const tagNames = record.tagNames ?? []
  const personal = record.documentScope === "personal"
  const losses: Loss[] = [...(record.losses ?? [])]
  const report: Record<string, unknown> = {}

  // The owner the record names (an active user), else the importing person.
  let ownerId = ctx.actorUserId
  if (record.ownerEmail) {
    const found = await activeUserByEmail(tx, ctx.orgId, record.ownerEmail)
    if (found) ownerId = found
    else report.ownerUnresolved = 1
  }
  // A personal document is created as its owner (the service makes the
  // creator the owner); naming someone else's needs the owner-assignment
  // authority an organization document needs too.
  if (
    personal &&
    ownerId !== ctx.actorUserId &&
    !hasScope("knowledge:documents:assign-owner", ctx.actorScopes) &&
    !hasScope("knowledge:documents:admin", ctx.actorScopes)
  ) {
    throw new Error("out_of_scope: Forbidden to assign Knowledge document owner")
  }

  const place = await placeOf(tx, ctx, record, false)
  const client = importServiceClient(tx)
  const actor = knowledgeActor(ctx, personal ? ownerId : ctx.actorUserId)
  // Outside any agent run context: inside a routine tick the service turns a
  // create into an update of the routine's running doc, and an import only
  // creates.
  const doc = await runContextStore.exit(() =>
    createKnowledgeDocument(
      client,
      {
        documentScope: personal ? "personal" : "organization",
        title: record.title,
        summary: record.summary ?? null,
        // Files are named once they are this page's (below).
        body: withFileTokens(record.body, new Map()),
        collectionIds: place.collectionIds,
        ...(!personal && ownerId !== ctx.actorUserId ? { ownerUserId: ownerId } : {}),
        ...(!personal && record.orgAccess ? { orgAccess: record.orgAccess } : {}),
        // Tags never go through the service (its upsert touches existing tags).
        tagNames: [],
        team: personal ? [] : (record.team ?? []),
        sensitivity: record.sensitivity ?? "internal",
        verifyNow: false,
      },
      actor,
      // An import reads nothing scoped into the document (D5).
      [],
    ),
  )
  await stampExternalRef(tx, ctx, "documents", doc.id, dedupValue)
  const rows: ImportRowRef[] = [{ table: "app_knowledge.documents", id: doc.id }]

  for (const m of extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("collection_memberships")}
      WHERE org_id = ${ctx.orgId}::uuid AND target_type = 'document' AND target_id = ${doc.id}::uuid
    `),
  )) {
    rows.push({ table: "app_knowledge.collection_memberships", id: m.id })
  }

  if (tagNames.length > 0) {
    const tags = await ensureTags(tx, ctx, tagNames)
    for (const id of tags.created) rows.push({ table: "app_knowledge.tags", id })
    for (const tagId of tags.ids) {
      const tagging = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${knowledgeRel("taggings")}
            (id, org_id, tag_id, target_type, target_id, created_by)
          VALUES (gen_random_uuid(), ${ctx.orgId}::uuid, ${tagId}::uuid, 'document',
                  ${doc.id}::uuid, ${actor.userId}::uuid)
          ON CONFLICT (org_id, tag_id, target_type, target_id) DO NOTHING
          RETURNING id
        `),
      )[0]
      if (tagging) rows.push({ table: "app_knowledge.taggings", id: tagging.id })
    }
  }

  // Files: each in its own savepoint. Objects copied so far are removed if the
  // record fails after them (its rows roll back with it).
  const copiedKeys: string[] = []
  try {
    const copied = new Map<string, string>()
    for (const att of record.attachments ?? []) {
      if (!att.ref) {
        // An upload the person can see (A9), its failure the record's.
        await ctx.resolveFile(att.fileId)
        const file = await copyFileOntoPage(tx, ctx, doc.id, att.fileId, false)
        rows.push({ table: "kernel.files", id: file.id })
        continue
      }
      const ref = att.ref
      try {
        const file = await tx.transaction((sp) =>
          copyFileOntoPage(sp, ctx, doc.id, att.fileId, true),
        )
        if (file.storageKey) copiedKeys.push(file.storageKey)
        copied.set(ref, file.id)
        rows.push({ table: "kernel.files", id: file.id })
      } catch (err) {
        log.warn({ err, orgId: ctx.orgId, runId: ctx.runId }, "knowledge import: a file not copied")
        const name = await ctx
          .resolveFile(att.fileId)
          .then((f) => f.filename)
          .catch(() => ref)
        losses.push({
          what: `file not carried (${name.split("/").pop()}): ${copyFailure(err)}`,
          where: record.title,
        })
      }
    }
    if (copied.size > 0) report.filesCopied = copied.size

    const body = withFileTokens(record.body, copied)
    if (body !== doc.body) {
      await tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("documents")} SET body = ${body}
        WHERE id = ${doc.id}::uuid AND org_id = ${ctx.orgId}::uuid
      `)
    }

    if (place.indexOf) {
      // The folder this run made shows this page as its own text. Its
      // `updated_at` stays: undo reads a later change as someone's work.
      await tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("collections")} SET index_document_id = ${doc.id}::uuid
        WHERE id = ${place.indexOf}::uuid AND org_id = ${ctx.orgId}::uuid
          AND index_document_id IS NULL
      `)
    }

    // The page's history starts with the text the import gave it.
    const version = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${knowledgeRel("document_versions")}
          (org_id, document_id, kind, title, body, body_md5, revision, author_type, author_id,
           required_scopes)
        SELECT d.org_id, d.id, 'import', d.title, d.body, ${md5(body)}, d.revision, 'user',
               ${actor.userId}::uuid, d.required_scopes
          FROM ${knowledgeRel("documents")} d
         WHERE d.id = ${doc.id}::uuid AND d.org_id = ${ctx.orgId}::uuid
        RETURNING id::text AS id
      `),
    )[0]
    if (version) rows.push({ table: "app_knowledge.document_versions", id: version.id })
  } catch (err) {
    await deleteObjects(copiedKeys).catch((e) =>
      log.warn({ err: e, orgId: ctx.orgId }, "knowledge import: copies not removed"),
    )
    throw err
  }

  if (losses.length > 0) report.losses = losses
  return { status: "created" as const, rows, report }
}

async function checkDocument(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
): Promise<HostCheckOutcome> {
  const record = documentImportRecordSchema.parse(raw)
  const existing = await rowByRef(tx, ctx, "documents", record.externalRef)
  if (existing) {
    const s = skipped(await skipReason(tx, ctx, "documents", existing), record.title)
    return { status: "skipped", report: s.report }
  }
  assertDocumentAllowed(ctx, record)
  await placeOf(tx, ctx, record, true)
  const files = record.attachments?.length ?? 0
  // The preview counts the files the run would copy onto pages (summed by the runner).
  const report = {
    ...(files > 0 ? { filesToCopy: files } : {}),
    ...(record.losses?.length ? { losses: record.losses } : {}),
  }
  return { status: "created", ...(Object.keys(report).length > 0 ? { report } : {}) }
}

// ---------------------------------------------------------------------------
// Links between imported pages (afterKind)
// ---------------------------------------------------------------------------

async function linkImportedPages(
  tx: PrivilegedDb,
  ctx: HostImportContext,
): Promise<HostAfterKindOutcome> {
  // This run's pages still naming an import link, locked: an editor's save
  // waits, then meets the moved revision.
  const pages = extractRows<{ id: string; title: string; body: string }>(
    await tx.execute(drizzleSql`
      SELECT d.id::text AS id, d.title, d.body FROM ${knowledgeRel("documents")} d
      WHERE d.org_id = ${ctx.orgId}::uuid AND d.body LIKE '%](notion-ref:%'
        AND EXISTS (
          SELECT 1 FROM ${kernelRel("import_ledger")} l
          WHERE l.org_id = d.org_id AND l.run_id = ${ctx.runId}::uuid
            AND l.table_name = 'app_knowledge.documents' AND l.row_id = d.id
        )
      ORDER BY d.id
      FOR UPDATE OF d
    `),
  )
  if (pages.length === 0) return { rows: [] }

  // Every key named, to the live page with that key: this run's, or one the
  // person reads.
  const refs = [...new Set(pages.flatMap((p) => importPageRefsOf(p.body)))]
  const values = refs.map((r) => dedupValueOf(ctx.sourceLabel, r))
  const found = extractRows<{ id: string; external_ref: string; mine: boolean }>(
    await tx.execute(drizzleSql`
      SELECT d.id::text AS id, d.external_ref,
             EXISTS (SELECT 1 FROM ${kernelRel("import_ledger")} l
                      WHERE l.org_id = d.org_id AND l.run_id = ${ctx.runId}::uuid
                        AND l.table_name = 'app_knowledge.documents' AND l.row_id = d.id) AS mine
        FROM ${knowledgeRel("documents")} d
       WHERE d.org_id = ${ctx.orgId}::uuid
         AND d.external_ref = ANY(${`{${values.map((v) => `"${v.replace(/["\\]/g, "\\$&")}"`).join(",")}}`}::text[])
         AND d.archived_at IS NULL AND d.trashed_at IS NULL
    `),
  )
  const readable = await readableIds(
    ctx,
    "documents",
    found.filter((f) => !f.mine).map((f) => f.id),
  )
  const prefix = ctx.sourceLabel ? `${ctx.sourceLabel}:` : ""
  const byRef = new Map<string, string>()
  for (const f of found) {
    if (f.mine || readable.has(f.id)) byRef.set(f.external_ref.slice(prefix.length), f.id)
  }

  const losses: Loss[] = []
  let resolved = 0
  for (const page of pages) {
    const body = replaceImportPageRefs(
      page.body,
      (ref) => {
        const id = byRef.get(ref) ?? null
        if (id) resolved++
        return id
      },
      "label",
      (label) =>
        losses.push({ what: `link to a page not in the export (${label})`, where: page.title }),
    )
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("documents")} SET body = ${body}, revision = revision + 1
      WHERE id = ${page.id}::uuid AND org_id = ${ctx.orgId}::uuid
    `)
    // The import version holds the page's text as the import left it.
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("document_versions")} v
         SET body = ${body}, body_md5 = ${md5(body)}, revision = d.revision
        FROM ${knowledgeRel("documents")} d
       WHERE v.document_id = ${page.id}::uuid AND v.org_id = ${ctx.orgId}::uuid
         AND v.kind = 'import' AND d.id = v.document_id
         AND EXISTS (SELECT 1 FROM ${kernelRel("import_ledger")} l
                      WHERE l.org_id = v.org_id AND l.run_id = ${ctx.runId}::uuid
                        AND l.table_name = 'app_knowledge.document_versions' AND l.row_id = v.id)
    `)
    await refreshDocumentLinks(tx, ctx.orgId, page.id, body)
    await tx.queueEvent({
      app: "knowledge",
      entity: "document",
      action: "update",
      entityId: page.id,
      data: { id: page.id },
      actorId: ctx.actorUserId,
      actorType: "user",
      orgId: ctx.orgId,
    })
  }
  return {
    rows: [],
    report: { linksResolved: resolved, ...(losses.length > 0 ? { losses } : {}) },
  }
}

/** A service refusal on dimensions or owners reads as `out_of_scope`. */
export function formatKnowledgeImportError(err: unknown): string {
  if (err instanceof KnowledgeError) {
    return err.code === "FORBIDDEN" ? `out_of_scope: ${err.message}` : `${err.code}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

export const collectionImportHandler: HostImportHandler = {
  importRecord: importCollection,
  checkRecord: (tx, ctx, record) => checkCollection(tx, ctx, record),
  formatError: formatKnowledgeImportError,
}

export const documentImportHandler: HostImportHandler = {
  importRecord: importDocument,
  checkRecord: (tx, ctx, record) => checkDocument(tx, ctx, record),
  afterKind: linkImportedPages,
  formatError: formatKnowledgeImportError,
}
