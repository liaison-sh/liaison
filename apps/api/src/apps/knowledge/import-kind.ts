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
 * Create-only (A14): tags are created with `ON CONFLICT DO NOTHING` and an
 * existing tag is reused untouched (the service's tag upsert bumps it, so tags
 * never go through the service); taggings and memberships are inserted for the
 * new document only. A document's attachments are copies of uploaded files the
 * person can see (A9), attached with `attachFileToParent`.
 *
 * Every created row is returned for the undo ledger: the collection; the
 * document, its memberships, the tags it created, its taggings, its files.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { createKnowledgeCollection } from "~/apps/knowledge/collections"
import { kernelRel, knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  KnowledgeError,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import { extractRows, type PrivilegedDb } from "~/db"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { attachFileToParent } from "~/modules/files/attach"
import { importServiceClient } from "~/modules/imports/service-client"
import {
  dedupMatchSql,
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

/** The canonical document record. */
export const documentImportRecordSchema = z
  .object({
    externalRef: z.string().min(1),
    title: z.string().trim().min(1).max(240),
    body: z.string().max(1_000_000),
    summary: z.string().max(1000).optional().nullable(),
    collectionRefs: z.array(z.string().min(1)).max(100).optional(),
    tagNames: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    sensitivity: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
    team: z.array(z.string().trim().min(1)).max(50).optional(),
    documentScope: z.enum(["org", "personal"]).optional(),
    ownerEmail: z.string().max(320).optional().nullable(),
    attachments: z
      .array(z.object({ fileId: z.string().min(1) }).strict())
      .max(50)
      .optional(),
  })
  .strict()

/** The knowledge actor of the person who started the run (or `asUserId`). */
function knowledgeActor(ctx: HostImportContext, asUserId = ctx.actorUserId) {
  return knowledgeActorFromContext({
    orgId: ctx.orgId,
    userId: asUserId,
    scopes: ctx.actorScopes,
    dimensionGrants: ctx.actorDimensionGrants,
  })
}

/** A collection a run (this one or an earlier one) imported, by source key. */
async function collectionIdByRef(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  ref: string,
): Promise<string | null> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("collections")}
      WHERE org_id = ${ctx.orgId}::uuid
        AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, ref)}
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

async function documentExists(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  ref: string,
): Promise<boolean> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("documents")}
      WHERE org_id = ${ctx.orgId}::uuid
        AND ${dedupMatchSql(drizzleSql`external_ref`, ctx.sourceLabel, ref)}
      LIMIT 1
    `),
  )
  return rows.length > 0
}

async function stampExternalRef(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  table: "documents" | "collections",
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

async function importCollection(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = collectionImportRecordSchema.parse(raw)
  if (await collectionIdByRef(tx, ctx, record.externalRef)) {
    return { status: "skipped" as const, rows: [] }
  }
  let parentCollectionId: string | null = null
  if (record.parentExternalRef) {
    parentCollectionId = await collectionIdByRef(tx, ctx, record.parentExternalRef)
    if (!parentCollectionId) {
      throw new Error(
        `parentExternalRef "${record.parentExternalRef}" does not resolve to an imported ` +
          "collection: order parents before children",
      )
    }
  }
  const created = await createKnowledgeCollection(
    importServiceClient(tx),
    {
      name: record.name,
      description: record.description ?? null,
      parentCollectionId,
      ...(record.shared === true ? { ownerUserId: null } : {}),
    },
    knowledgeActor(ctx),
  )
  await stampExternalRef(tx, ctx, "collections", created.id, dedupValue)
  return {
    status: "created" as const,
    rows: [{ table: "app_knowledge.collections", id: created.id }],
  }
}

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

async function importDocument(
  tx: PrivilegedDb,
  ctx: HostImportContext,
  raw: Record<string, unknown>,
  dedupValue: string,
) {
  const record = documentImportRecordSchema.parse(raw)
  if (await documentExists(tx, ctx, record.externalRef)) {
    return { status: "skipped" as const, rows: [] }
  }
  const tagNames = record.tagNames ?? []
  if (tagNames.length > 0 && !hasScope("knowledge:tags:manage", ctx.actorScopes)) {
    throw new Error("out_of_scope: tagging a document needs knowledge:tags:manage")
  }
  const personal = record.documentScope === "personal"
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

  const collectionIds: string[] = []
  for (const ref of record.collectionRefs ?? []) {
    const id = await collectionIdByRef(tx, ctx, ref)
    if (!id) throw new Error(`collectionRef "${ref}" does not resolve to an imported collection`)
    collectionIds.push(id)
  }

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
        body: record.body,
        collectionIds,
        ...(!personal && ownerId !== ctx.actorUserId ? { ownerUserId: ownerId } : {}),
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

  // Attachments last: each copies stored bytes (a failure after a copy would
  // leave the copy behind).
  for (const att of record.attachments ?? []) {
    // A9: the person must be able to see the uploaded file (their RLS, their org).
    await ctx.resolveFile(att.fileId)
    const copied = await attachFileToParent(
      {
        sourceFileId: att.fileId,
        target: { app: "knowledge", entityType: "document", entityId: doc.id },
      },
      {
        // Source visibility was checked under the person's RLS above; the
        // destination (the new document) exists only in this transaction.
        rlsTx: client,
        privileged: (_reason, fn) => fn(tx),
        orgId: ctx.orgId,
        userId: ctx.actorUserId,
        actorType: "user",
        scopes: ctx.actorScopes,
      },
    )
    rows.push({ table: "kernel.files", id: copied.id })
  }

  return { status: "created" as const, rows, report }
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
  formatError: formatKnowledgeImportError,
}

export const documentImportHandler: HostImportHandler = {
  importRecord: importDocument,
  formatError: formatKnowledgeImportError,
}
