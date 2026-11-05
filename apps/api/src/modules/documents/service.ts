// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The organisation's document templates (kernel.document_templates, migration
// 0255): store, read, change and archive them.
//
// A `pdf_form` template starts as an ordinary staged upload (the caller's own
// upload session, from the web upload or the files_upload_url tool). Creating
// the template runs the PDF form intake (pdf-form.ts: inspect, sanitize, dry
// run, in an isolated child process), stores the SANITIZED bytes as a new
// kernel file parented to the template, and deletes the staged upload. The
// uploaded bytes themselves are never kept, so whatever active content they
// carried never reaches a stored template. A refused upload creates nothing.
//
// A `rich_text` template keeps its blocks in `body`. A body is saved only
// when it is within BODY_MAX_BYTES and passes the rich_text renderer's own
// schema (rich-text.ts richTextBodySchema), so a stored body always prints.
//
// Reads run under the caller's RLS (FORCE RLS, org scoped). The writes that
// store a file run privileged, as pdf/render.ts stores a rendered PDF: the
// template row, its file row and the link between them land in one
// transaction, every statement pinned to the caller's org. Who may write is
// the route's scope check (kernel:org:admin).

import { randomUUID } from "node:crypto"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { z } from "zod"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  type DocumentTemplateField,
  type DocumentTemplateKind,
  type DocumentTemplateMappingEntry,
  type DocumentTemplateRow,
  documentTemplates,
  files,
  fileUploadSessions,
} from "~/db/schema/kernel"
import { deleteObject, putObject } from "~/infra/storage/object-storage"
import { pdfLogger as log } from "~/lib/logger"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import {
  buildStorageKey,
  deleteFile,
  FileServiceError,
  loadOrgSettings,
  noteStoredOrgUsage,
  wouldExceedOrgQuota,
} from "~/modules/files/service"
import {
  PDF_FORM_MAX_BYTES,
  PDF_FORM_MAX_FIELDS,
  PDF_FORM_MAX_TEXT_LENGTH,
  PdfFormError,
  type PdfFormErrorCode,
  type PreparedTemplate,
  preparePdfFormTemplate,
} from "./pdf-form"
import { parseRichTextBody, RichTextError } from "./rich-text"

/** The kernel file parent a template's files hang off (files/service.ts KERNEL_PARENTS). */
export const DOCUMENT_TEMPLATE_PARENT = "document_template"

/** Largest rich_text body accepted, measured as its JSON text. */
export const BODY_MAX_BYTES = 256 * 1024

/** Image types a field may print (a signature, a stamp). */
const MAPPING_IMAGE_TYPES = ["image/png", "image/jpeg"] as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DocumentTemplateErrorCode =
  | "not_found"
  | "staged_file_not_found"
  | "staged_file_expired"
  | "staged_file_unreadable"
  | "archived"
  | "wrong_kind"
  | "mapping_invalid"
  | "body_too_large"
  | "body_invalid"
  | "storage_quota_exceeded"
  | PdfFormErrorCode

const STATUS_OF: Record<DocumentTemplateErrorCode, number> = {
  not_found: 404,
  staged_file_not_found: 404,
  staged_file_expired: 410,
  staged_file_unreadable: 422,
  archived: 409,
  wrong_kind: 409,
  mapping_invalid: 422,
  body_too_large: 413,
  body_invalid: 422,
  storage_quota_exceeded: 409,
  // Every PDF intake refusal: the file is not a template that can print.
  not_a_pdf: 422,
  input_too_large: 422,
  too_many_pages: 422,
  too_complex: 422,
  encrypted: 422,
  xfa: 422,
  no_fields: 422,
  parse_failed: 422,
  parse_timeout: 422,
  sanitize_failed: 422,
  flatten_failed: 422,
  value_too_long: 422,
  invalid_option: 422,
  image_invalid: 422,
}

export class DocumentTemplateError extends Error {
  readonly status: number
  constructor(
    readonly code: DocumentTemplateErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = "DocumentTemplateError"
    this.status = STATUS_OF[code]
  }
}

// ---------------------------------------------------------------------------
// Input schemas (the routes validate with these)
// ---------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1).max(200)
/** "<app>:<entity>", the records a template prints from. */
const recordTypeSchema = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_]*$/, "record type is <app>:<entity>")

const mappingEntrySchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, "a dot path such as order.lines.0.sku")
      .optional(),
    const: z.union([z.string().max(PDF_FORM_MAX_TEXT_LENGTH), z.boolean()]).optional(),
    image_file_id: z.string().uuid().optional(),
    placeholder: z.string().max(200).optional(),
  })
  .strict()
  .refine(
    (e) => [e.path, e.const, e.image_file_id].filter((v) => v !== undefined).length <= 1,
    "a field takes its value from one of path, const or image_file_id",
  )

export const mappingSchema = z
  .record(z.string().min(1).max(500), mappingEntrySchema)
  .refine((m) => Object.keys(m).length <= PDF_FORM_MAX_FIELDS, "too many mapped fields")

const bodySchema = z.record(z.string(), z.unknown())

export const createTemplateSchema = z.union([
  z
    .object({
      kind: z.literal("pdf_form").optional(),
      name: nameSchema,
      stagedFileId: z.string().uuid(),
      recordType: recordTypeSchema.nullable().optional(),
      mapping: mappingSchema.optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rich_text"),
      name: nameSchema,
      body: bodySchema,
      recordType: recordTypeSchema.nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .strict(),
])
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>

export const patchTemplateSchema = z
  .object({
    name: nameSchema.optional(),
    recordType: recordTypeSchema.nullable().optional(),
    mapping: mappingSchema.optional(),
    enabled: z.boolean().optional(),
    body: bodySchema.optional(),
  })
  .strict()
export type PatchTemplateInput = z.infer<typeof patchTemplateSchema>

export const replaceFileSchema = z
  .object({ stagedFileId: z.string().uuid(), mapping: mappingSchema.optional() })
  .strict()
export type ReplaceFileInput = z.infer<typeof replaceFileSchema>

export const listQuerySchema = z.object({
  recordType: recordTypeSchema.optional(),
  kind: z.enum(["pdf_form", "rich_text"]).optional(),
})

// ---------------------------------------------------------------------------
// Context and shapes
// ---------------------------------------------------------------------------

/** Who is acting, and how to open their RLS transaction (one per step, never across the PDF intake). */
export interface TemplateCaller {
  orgId: string
  userId: string
  scopes: string[]
  withRls: <T>(fn: (tx: RlsClient) => Promise<T>) => Promise<T>
}

export interface DocumentTemplate {
  id: string
  name: string
  kind: DocumentTemplateKind
  recordType: string | null
  fileId: string | null
  body: Record<string, unknown> | null
  fields: DocumentTemplateField[]
  mapping: Record<string, DocumentTemplateMappingEntry>
  enabled: boolean
  createdBy: string | null
  updatedBy: string | null
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

/** A list entry: everything but the rich_text body. */
export type DocumentTemplateSummary = Omit<DocumentTemplate, "body">

function toTemplate(row: DocumentTemplateRow): DocumentTemplate {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    recordType: row.recordType,
    fileId: row.fileId,
    body: row.body ?? null,
    fields: row.fields,
    mapping: row.mapping,
    enabled: row.enabled,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

function toSummary(row: DocumentTemplateRow): DocumentTemplateSummary {
  const { body: _body, ...rest } = toTemplate(row)
  return rest
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The org's live templates (archived ones are left out), by name. */
export async function listTemplates(
  tx: RlsClient,
  filter: { recordType?: string; kind?: DocumentTemplateKind } = {},
): Promise<DocumentTemplateSummary[]> {
  const where = [isNull(documentTemplates.archivedAt)]
  if (filter.recordType) where.push(eq(documentTemplates.recordType, filter.recordType))
  if (filter.kind) where.push(eq(documentTemplates.kind, filter.kind))
  const rows = await tx
    .select()
    .from(documentTemplates)
    .where(and(...where))
    .orderBy(asc(documentTemplates.name), asc(documentTemplates.id))
  return rows.map(toSummary)
}

/** One template, archived or not; null when it is not visible to the caller. */
export async function getTemplate(tx: RlsClient, id: string): Promise<DocumentTemplate | null> {
  const [row] = await tx
    .select()
    .from(documentTemplates)
    .where(eq(documentTemplates.id, id))
    .limit(1)
  return row ? toTemplate(row) : null
}

async function requireLiveTemplate(tx: RlsClient, id: string): Promise<DocumentTemplate> {
  const template = await getTemplate(tx, id)
  if (!template) throw new DocumentTemplateError("not_found", "Template not found")
  if (template.archivedAt) {
    throw new DocumentTemplateError("archived", "This template is archived")
  }
  return template
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The size cap first (a huge body is not parsed), then the rich_text block schema. */
export function assertValidBody(body: Record<string, unknown>): void {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8")
  if (bytes > BODY_MAX_BYTES) {
    throw new DocumentTemplateError(
      "body_too_large",
      `The template body is ${bytes} bytes; the limit is ${BODY_MAX_BYTES}`,
    )
  }
  try {
    parseRichTextBody(body)
  } catch (err) {
    if (err instanceof RichTextError) {
      throw new DocumentTemplateError("body_invalid", err.message, err.path)
    }
    throw err
  }
}

/**
 * Every mapped field must be one the template offers; a constant only fills a
 * text field (a string, within its maxLength) or a checkbox (a boolean); an
 * image must be a PNG or JPEG file parented to this very template.
 */
async function validateMapping(
  tx: RlsClient,
  templateId: string,
  fields: readonly DocumentTemplateField[],
  mapping: Record<string, DocumentTemplateMappingEntry>,
): Promise<void> {
  const byName = new Map(fields.map((f) => [f.name, f]))
  const imageIds = new Set<string>()
  for (const [name, entry] of Object.entries(mapping)) {
    const field = byName.get(name)
    if (!field) {
      throw new DocumentTemplateError(
        "mapping_invalid",
        `The template has no field named "${name}"`,
        name,
      )
    }
    if (entry.const !== undefined) {
      if (field.type === "text") {
        if (typeof entry.const !== "string") {
          throw new DocumentTemplateError(
            "mapping_invalid",
            `Field "${name}" is a text field: its constant must be text`,
            name,
          )
        }
        if (field.maxLength !== undefined && entry.const.length > field.maxLength) {
          throw new DocumentTemplateError(
            "mapping_invalid",
            `Field "${name}" holds at most ${field.maxLength} characters`,
            name,
          )
        }
      } else if (field.type === "checkbox") {
        if (typeof entry.const !== "boolean") {
          throw new DocumentTemplateError(
            "mapping_invalid",
            `Field "${name}" is a checkbox: its constant must be true or false`,
            name,
          )
        }
      } else {
        throw new DocumentTemplateError(
          "mapping_invalid",
          `Field "${name}" (${field.type}) cannot take a constant; only text fields and checkboxes can`,
          name,
        )
      }
    }
    if (entry.image_file_id !== undefined) imageIds.add(entry.image_file_id)
  }
  if (imageIds.size === 0) return
  const ids = [...imageIds]
  const rows = await tx
    .select({ id: files.id, mimeType: files.mimeType, encVersion: files.encVersion })
    .from(files)
    .where(
      and(
        eq(files.app, "kernel"),
        eq(files.entityType, DOCUMENT_TEMPLATE_PARENT),
        eq(files.entityId, templateId),
        sql`${files.id} IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`,
      ),
    )
  const usable = new Set(
    rows
      .filter(
        (r) =>
          r.encVersion === 0 &&
          (MAPPING_IMAGE_TYPES as readonly string[]).includes(r.mimeType.toLowerCase()),
      )
      .map((r) => r.id),
  )
  for (const [name, entry] of Object.entries(mapping)) {
    if (entry.image_file_id !== undefined && !usable.has(entry.image_file_id)) {
      throw new DocumentTemplateError(
        "mapping_invalid",
        `Field "${name}": the image must be a PNG or JPEG file added to this template`,
        name,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// The PDF intake
// ---------------------------------------------------------------------------

interface StagedPdf {
  id: string
  storageKey: string
  filename: string
}

/** The caller's own staged upload (a session-parented file is visible to its owner only). */
async function loadStagedFile(tx: RlsClient, fileId: string): Promise<StagedPdf> {
  const [row] = await tx
    .select({
      id: files.id,
      storageKey: files.storageKey,
      filename: files.filename,
      sizeBytes: files.sizeBytes,
      encVersion: files.encVersion,
      expiresAt: fileUploadSessions.expiresAt,
    })
    .from(files)
    .innerJoin(fileUploadSessions, sql`${files.entityId} = ${fileUploadSessions.id}::text`)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.app, "kernel"),
        eq(files.entityType, "file_upload_session"),
      ),
    )
    .limit(1)
  if (!row) {
    throw new DocumentTemplateError(
      "staged_file_not_found",
      "No staged upload of yours has this id; upload the PDF first",
    )
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new DocumentTemplateError("staged_file_expired", "The staged upload has expired")
  }
  if (row.encVersion !== 0) {
    throw new DocumentTemplateError(
      "staged_file_unreadable",
      "The staged upload is end-to-end encrypted; the server cannot read it as a template",
    )
  }
  if (row.sizeBytes > PDF_FORM_MAX_BYTES) {
    throw new DocumentTemplateError(
      "input_too_large",
      `The PDF is ${row.sizeBytes} bytes; the limit is ${PDF_FORM_MAX_BYTES}`,
    )
  }
  return { id: row.id, storageKey: row.storageKey, filename: row.filename }
}

/** Read the staged bytes and run the intake in its isolate. */
async function prepareStaged(staged: StagedPdf): Promise<PreparedTemplate> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(
      (await getObjectBytes(staged.storageKey, { maxBytes: PDF_FORM_MAX_BYTES })).bytes,
    )
  } catch (err) {
    if (err instanceof FileServiceError) {
      log.warn({ err, fileId: staged.id }, "document template: staged upload unreadable")
      throw new DocumentTemplateError(
        err.code === "FILE_TOO_LARGE" ? "input_too_large" : "staged_file_unreadable",
        "The staged upload could not be read",
      )
    }
    throw err
  }
  try {
    return await preparePdfFormTemplate(bytes)
  } catch (err) {
    if (err instanceof PdfFormError) {
      throw new DocumentTemplateError(err.code, err.message, err.field)
    }
    throw err
  }
}

function pdfFilename(staged: StagedPdf): string {
  return /\.pdf$/i.test(staged.filename) ? staged.filename : `${staged.filename}.pdf`
}

/**
 * Put the sanitized bytes in storage under the template, after the quota
 * check. Returns the stored object's key; the caller writes the file row.
 */
async function putTemplateObject(
  orgId: string,
  templateId: string,
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const over = await withPrivilegedDb(orgId, "document-templates:quota", async (tx) =>
    wouldExceedOrgQuota(tx, orgId, await loadOrgSettings(tx, orgId), bytes.byteLength),
  )
  if (over) {
    throw new DocumentTemplateError(
      "storage_quota_exceeded",
      "The organisation's storage is full; the template was not saved",
    )
  }
  const storageKey = buildStorageKey({
    orgId,
    app: "kernel",
    entityType: DOCUMENT_TEMPLATE_PARENT,
    entityId: templateId,
    filename,
  })
  await putObject({ key: storageKey, body: bytes, contentType: "application/pdf" })
  return storageKey
}

async function insertTemplateFile(
  tx: PrivilegedDb,
  args: {
    orgId: string
    userId: string
    templateId: string
    filename: string
    storageKey: string
    size: number
  },
): Promise<string> {
  const fileId = randomUUID()
  await tx.insert(files).values({
    id: fileId,
    orgId: args.orgId,
    app: "kernel",
    entityType: DOCUMENT_TEMPLATE_PARENT,
    entityId: args.templateId,
    filename: args.filename,
    mimeType: "application/pdf",
    sizeBytes: args.size,
    storageKey: args.storageKey,
    uploadedBy: args.userId,
  })
  return fileId
}

/** Remove an object whose row never landed. Best effort: the orphan sweep is the backstop. */
async function discardObject(storageKey: string): Promise<void> {
  try {
    await deleteObject(storageKey)
  } catch (err) {
    log.warn({ err }, "document template: could not remove an unused stored object")
  }
}

/** Delete a file through the files service (scope, visibility, the object-deletion event). */
async function removeFile(caller: TemplateCaller, fileId: string, why: string): Promise<void> {
  try {
    await caller.withRls((rlsTx) =>
      deleteFile(fileId, {
        orgId: caller.orgId,
        userId: caller.userId,
        scopes: caller.scopes,
        rlsTx,
        privileged: (reason, fn) => withPrivilegedDb(caller.orgId, reason, fn),
      }),
    )
  } catch (err) {
    // The template is saved; a leftover staged upload expires and is swept.
    log.warn({ err, fileId, orgId: caller.orgId }, `document template: could not delete ${why}`)
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createTemplate(
  caller: TemplateCaller,
  input: CreateTemplateInput,
): Promise<DocumentTemplate> {
  if (input.kind === "rich_text") return createRichTextTemplate(caller, input)
  return createPdfFormTemplate(caller, input)
}

async function createRichTextTemplate(
  caller: TemplateCaller,
  input: Extract<CreateTemplateInput, { kind: "rich_text" }>,
): Promise<DocumentTemplate> {
  assertValidBody(input.body)
  return caller.withRls(async (tx) => {
    const [row] = await tx
      .insert(documentTemplates)
      .values({
        orgId: caller.orgId,
        name: input.name,
        kind: "rich_text",
        recordType: input.recordType ?? null,
        body: input.body,
        enabled: input.enabled ?? true,
        createdBy: caller.userId,
        updatedBy: caller.userId,
      })
      .returning()
    if (!row) throw new Error("document template insert returned no row")
    return toTemplate(row)
  })
}

async function createPdfFormTemplate(
  caller: TemplateCaller,
  input: Exclude<CreateTemplateInput, { kind: "rich_text" }>,
): Promise<DocumentTemplate> {
  const staged = await caller.withRls((tx) => loadStagedFile(tx, input.stagedFileId))
  // Outside any transaction: the intake may take seconds.
  const prepared = await prepareStaged(staged)
  const templateId = randomUUID()
  const mapping = input.mapping ?? {}
  // A new template has no files yet, so an image mapping can only fail here.
  await caller.withRls((tx) => validateMapping(tx, templateId, prepared.fields, mapping))

  const filename = pdfFilename(staged)
  const storageKey = await putTemplateObject(caller.orgId, templateId, filename, prepared.bytes)
  try {
    await withPrivilegedDb(caller.orgId, "document-templates:create", async (tx) => {
      await tx.insert(documentTemplates).values({
        id: templateId,
        orgId: caller.orgId,
        name: input.name,
        kind: "pdf_form",
        recordType: input.recordType ?? null,
        fields: prepared.fields,
        mapping,
        enabled: input.enabled ?? true,
        createdBy: caller.userId,
        updatedBy: caller.userId,
      })
      const fileId = await insertTemplateFile(tx, {
        orgId: caller.orgId,
        userId: caller.userId,
        templateId,
        filename,
        storageKey,
        size: prepared.bytes.byteLength,
      })
      await tx
        .update(documentTemplates)
        .set({ fileId })
        .where(and(eq(documentTemplates.id, templateId), eq(documentTemplates.orgId, caller.orgId)))
      await noteStoredOrgUsage(tx, caller.orgId)
    })
  } catch (err) {
    await discardObject(storageKey)
    throw err
  }
  await removeFile(caller, staged.id, "the staged upload")
  const created = await caller.withRls((tx) => getTemplate(tx, templateId))
  if (!created) throw new Error("document template not visible after create")
  return created
}

/**
 * Change a template's name, record type, mapping, enabled flag, or (rich_text
 * only) body. An archived template is not changed.
 */
export async function updateTemplate(
  caller: TemplateCaller,
  id: string,
  patch: PatchTemplateInput,
): Promise<DocumentTemplate> {
  if (patch.body !== undefined) assertValidBody(patch.body)
  return caller.withRls(async (tx) => {
    const current = await requireLiveTemplate(tx, id)
    if (patch.body !== undefined && current.kind !== "rich_text") {
      throw new DocumentTemplateError(
        "wrong_kind",
        "Only a rich_text template has a body; a PDF form's content is its file",
      )
    }
    if (patch.mapping !== undefined) {
      await validateMapping(tx, id, current.fields, patch.mapping)
    }
    const [row] = await tx
      .update(documentTemplates)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.recordType !== undefined ? { recordType: patch.recordType } : {}),
        ...(patch.mapping !== undefined ? { mapping: patch.mapping } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        updatedBy: caller.userId,
        updatedAt: new Date(),
      })
      .where(and(eq(documentTemplates.id, id), isNull(documentTemplates.archivedAt)))
      .returning()
    if (!row) throw new DocumentTemplateError("not_found", "Template not found")
    return toTemplate(row)
  })
}

/** Archive a template: it leaves every list and can no longer be changed. Idempotent. */
export async function archiveTemplate(
  caller: TemplateCaller,
  id: string,
): Promise<DocumentTemplate> {
  return caller.withRls(async (tx) => {
    const current = await getTemplate(tx, id)
    if (!current) throw new DocumentTemplateError("not_found", "Template not found")
    if (current.archivedAt) return current
    const [row] = await tx
      .update(documentTemplates)
      .set({ archivedAt: new Date(), updatedBy: caller.userId, updatedAt: new Date() })
      .where(eq(documentTemplates.id, id))
      .returning()
    if (!row) throw new DocumentTemplateError("not_found", "Template not found")
    return toTemplate(row)
  })
}

/**
 * Give a pdf_form template a new PDF: the same intake as at creation. The
 * mapping is the one passed, else the current one, and must fit the new
 * file's fields. The previous file is deleted once the new one is linked.
 */
export async function replaceTemplateFile(
  caller: TemplateCaller,
  id: string,
  input: ReplaceFileInput,
): Promise<DocumentTemplate> {
  const { template, staged } = await caller.withRls(async (tx) => {
    const template = await requireLiveTemplate(tx, id)
    if (template.kind !== "pdf_form") {
      throw new DocumentTemplateError("wrong_kind", "Only a pdf_form template has a file")
    }
    return { template, staged: await loadStagedFile(tx, input.stagedFileId) }
  })
  const prepared = await prepareStaged(staged)
  const mapping = input.mapping ?? template.mapping
  await caller.withRls((tx) => validateMapping(tx, id, prepared.fields, mapping))

  const filename = pdfFilename(staged)
  const storageKey = await putTemplateObject(caller.orgId, id, filename, prepared.bytes)
  try {
    await withPrivilegedDb(caller.orgId, "document-templates:replace-file", async (tx) => {
      const fileId = await insertTemplateFile(tx, {
        orgId: caller.orgId,
        userId: caller.userId,
        templateId: id,
        filename,
        storageKey,
        size: prepared.bytes.byteLength,
      })
      const updated = await tx
        .update(documentTemplates)
        .set({
          fileId,
          fields: prepared.fields,
          mapping,
          updatedBy: caller.userId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(documentTemplates.id, id),
            eq(documentTemplates.orgId, caller.orgId),
            isNull(documentTemplates.archivedAt),
          ),
        )
        .returning({ id: documentTemplates.id })
      if (updated.length === 0) {
        throw new DocumentTemplateError("archived", "The template was archived meanwhile")
      }
      await noteStoredOrgUsage(tx, caller.orgId)
    })
  } catch (err) {
    await discardObject(storageKey)
    throw err
  }
  if (template.fileId) await removeFile(caller, template.fileId, "the previous template file")
  await removeFile(caller, staged.id, "the staged upload")
  const replaced = await caller.withRls((tx) => getTemplate(tx, id))
  if (!replaced) throw new Error("document template not visible after replace")
  return replaced
}
