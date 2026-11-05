// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel tools over the organisation's document templates
// (modules/documents): an agent designs a template with the person, maps it to
// a record type's fields, previews it, saves it, and prints records with it.
//
//   document_record_types_list   readOnly   the printable record types, their fields and a sample record
//   document_templates_list      readOnly   the org's live templates
//   document_template_get        readOnly   one template: body, fields, mapping, the paths it reads
//   document_template_create     gated      a new rich_text template (or a PDF form from an upload)
//   document_template_update     gated      change a template
//   document_template_archive    gated      archive a template
//   document_template_preview    writes the caller's own short-lived PDF (sample or real record)
//   documents_print              writes the printed PDFs on the record (no data parameter)
//
// The working guide that goes with them is prompts/kernel/documents.md.

import type { ApprovalSummary } from "@liaison/shared"
import { z } from "zod"
import type { RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { pdfLogger as log } from "~/lib/logger"
import {
  previewTemplate,
  sampleRecordFor,
  templatePaths,
  unknownFieldsOf,
} from "~/modules/documents/preview"
import {
  listPrintableRecordTypes,
  PRINT_MAX_TEMPLATES,
  type PrintableRecordType,
  type PrintCaller,
  PrintError,
  printDocuments,
} from "~/modules/documents/print"
import { parseRichTextBody, RichTextError } from "~/modules/documents/rich-text"
import {
  archiveTemplate,
  type CreateTemplateInput,
  createTemplate,
  type DocumentTemplate,
  DocumentTemplateError,
  getTemplate,
  listTemplates,
  mappingSchema,
  type PatchTemplateInput,
  type TemplateCaller,
  updateTemplate,
} from "~/modules/documents/service"

export interface DocumentToolContext {
  userId: string
  orgId: string
  db: RlsClient
  scopes?: string[]
  dimensionGrants?: Record<string, string[]>
  actingAgentId?: string | null
}

export interface DocumentToolError {
  error: { code: string; message: string; templateId?: string }
}

function templateCaller(ctx: DocumentToolContext): TemplateCaller {
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    scopes: ctx.scopes ?? [],
    withRls: (fn) => fn(ctx.db),
  }
}

function printCaller(ctx: DocumentToolContext): PrintCaller {
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: ctx.scopes ?? [],
    dimensionGrants: ctx.dimensionGrants ?? {},
  }
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    scopes: ctx.scopes ?? [],
    withRls: (fn) => fn(ctx.db),
    actor,
    actingAgentId: ctx.actingAgentId ?? null,
  }
}

/** A refusal as the agent reads it: the code and the message saying what to fix. */
function toolError(err: unknown): DocumentToolError | null {
  if (err instanceof DocumentTemplateError) {
    return { error: { code: err.code, message: err.message } }
  }
  if (err instanceof PrintError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.templateId ? { templateId: err.templateId } : {}),
      },
    }
  }
  if (err instanceof RichTextError) return { error: { code: err.code, message: err.message } }
  return null
}

async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T | DocumentToolError> {
  try {
    return await fn()
  } catch (err) {
    const mapped = toolError(err)
    if (mapped) return mapped
    log.error({ err, tool: what }, "document tool failed")
    throw err
  }
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

const recordTypeParam = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_]*$/, "a record type is <app>:<entity>")
  .describe('The record type, "<app>:<entity>", from kernel__document_record_types_list.')

const templateIdParam = z
  .string()
  .uuid()
  .describe("A template id from kernel__document_templates_list.")

const bodyParam = z
  .record(z.string(), z.unknown())
  .describe(
    'The rich_text body: { page?: { size?: "A4"|"Letter", fontSize?: 8-14, margins? }, blocks: [...] }. Blocks: { type: "heading", text, level?: 1|2|3 }, { type: "paragraph", text }, { type: "list", from: "<list path>", line: "<text with {{field}} of one row>" }, { type: "image", fileId, width?, align? }, { type: "spacer", height }. Text takes {{path}} placeholders from the record type\'s fields.',
  )

const recordTypesParams = z.object({ recordType: recordTypeParam.optional() }).strict()

const listParams = z
  .object({
    recordType: recordTypeParam.optional(),
    kind: z.enum(["rich_text", "pdf_form"]).optional(),
  })
  .strict()

const getParams = z.object({ templateId: templateIdParam }).strict()

export const createParams = z
  .object({
    name: z.string().trim().min(1).max(200).describe('What people call it: "Thank you letter".'),
    recordType: recordTypeParam.optional(),
    kind: z
      .enum(["rich_text", "pdf_form"])
      .optional()
      .describe("rich_text (the default): blocks you write. pdf_form: an uploaded fillable PDF."),
    body: bodyParam.optional(),
    stagedFileId: z
      .string()
      .uuid()
      .optional()
      .describe("pdf_form only: the fileId of the PDF uploaded with kernel__files_upload_url."),
    mapping: mappingSchema
      .optional()
      .describe('pdf_form only: { "<form field>": { path } | { const } | { placeholder } }.'),
    enabled: z.boolean().optional(),
  })
  .strict()

export const updateParams = z
  .object({
    templateId: templateIdParam,
    name: z.string().trim().min(1).max(200).optional(),
    recordType: recordTypeParam.nullable().optional(),
    body: bodyParam.optional(),
    mapping: mappingSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

const archiveParams = z.object({ templateId: templateIdParam }).strict()

export const previewParams = z
  .object({
    templateId: templateIdParam.optional(),
    body: bodyParam.optional(),
    recordType: recordTypeParam.optional(),
    recordId: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("A real record to fill it from. Leave it out to preview with SAMPLE values."),
    name: z.string().max(200).optional().describe("A draft's name, for the file name."),
  })
  .strict()

/** NO data or values parameter: the record always comes from the app's own record tool. */
export const printParams = z
  .object({
    app: z.string().regex(/^[a-z][a-z0-9_-]*$/, "an app name"),
    entity: z.string().regex(/^[a-z][a-z0-9_]*$/, "an entity name"),
    recordId: z.string().min(1).max(200),
    templateIds: z.array(z.string().uuid()).min(1).max(PRINT_MAX_TEMPLATES),
    merge: z.boolean().optional().describe("Also make one merged PDF of all printed documents."),
  })
  .strict()

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** How a field goes in a rich_text body: a placeholder, or a list block for a repeating one. */
function fieldUse(field: PrintableRecordType["fields"][number]): string {
  const list = field.repeat
  if (list && field.path.startsWith(`${list}.`)) {
    return `list block { from: "${list}", line: "...{{${field.path.slice(list.length + 1)}}}..." }`
  }
  return `{{${field.path}}}`
}

export async function handleDocumentRecordTypesList(
  params: z.infer<typeof recordTypesParams>,
  ctx: DocumentToolContext,
) {
  // Only the types whose record tool the caller may call: never the shape of records it cannot read.
  const all = await listPrintableRecordTypes(ctx.orgId, { scopes: ctx.scopes ?? [] })
  const types = params.recordType ? all.filter((t) => t.recordType === params.recordType) : all
  return {
    recordTypes: types.map((t) => ({
      recordType: t.recordType,
      label: t.label,
      fields: t.fields.map((f) => ({
        path: f.path,
        label: f.label,
        type: f.type,
        ...(f.repeat ? { repeat: f.repeat } : {}),
        use: fieldUse(f),
      })),
      sampleRecord: sampleRecordFor(t),
    })),
  }
}

export async function handleDocumentTemplatesList(
  params: z.infer<typeof listParams>,
  ctx: DocumentToolContext,
) {
  const templates = await listTemplates(ctx.db, {
    ...(params.recordType ? { recordType: params.recordType } : {}),
    ...(params.kind ? { kind: params.kind } : {}),
  })
  return {
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      recordType: t.recordType,
      enabled: t.enabled,
      updatedAt: t.updatedAt.toISOString(),
    })),
  }
}

async function declarationOf(orgId: string, recordType: string | null) {
  if (!recordType) return null
  const types = await listPrintableRecordTypes(orgId)
  const found = types.find((t) => t.recordType === recordType)
  return found ? { recordTool: "", idParam: "", label: found.label, fields: found.fields } : null
}

export async function handleDocumentTemplateGet(
  params: z.infer<typeof getParams>,
  ctx: DocumentToolContext,
) {
  return guarded("document_template_get", async () => {
    const template = await getTemplate(ctx.db, params.templateId)
    if (!template) throw new DocumentTemplateError("not_found", "Template not found")
    const paths = templatePaths(template)
    return {
      template: {
        id: template.id,
        name: template.name,
        kind: template.kind,
        recordType: template.recordType,
        enabled: template.enabled,
        archived: template.archivedAt !== null,
        body: template.body,
        fields: template.fields,
        mapping: template.mapping,
        updatedAt: template.updatedAt.toISOString(),
      },
      paths,
      unknownFields: unknownFieldsOf(paths, await declarationOf(ctx.orgId, template.recordType)),
    }
  })
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function assertPrintableRecordType(orgId: string, recordType: string | null | undefined) {
  if (!recordType) return
  const types = await listPrintableRecordTypes(orgId)
  if (!types.some((t) => t.recordType === recordType)) {
    throw new DocumentTemplateError(
      "mapping_invalid",
      `"${recordType}" is not a record type that prints documents; pick one from kernel__document_record_types_list`,
    )
  }
}

function toCreateInput(params: z.infer<typeof createParams>): CreateTemplateInput {
  if ((params.kind ?? "rich_text") === "rich_text") {
    if (params.stagedFileId !== undefined || params.mapping !== undefined) {
      throw new DocumentTemplateError(
        "wrong_kind",
        "stagedFileId and mapping belong to a pdf_form template; a rich_text template takes body",
      )
    }
    if (params.body === undefined) {
      throw new DocumentTemplateError("body_invalid", "A rich_text template needs a body")
    }
    return {
      kind: "rich_text",
      name: params.name,
      body: params.body,
      ...(params.recordType !== undefined ? { recordType: params.recordType } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    }
  }
  if (params.body !== undefined) {
    throw new DocumentTemplateError("wrong_kind", "A pdf_form template takes no body")
  }
  if (params.stagedFileId === undefined) {
    throw new DocumentTemplateError(
      "staged_file_not_found",
      "A pdf_form template needs stagedFileId: upload the PDF with kernel__files_upload_url first",
    )
  }
  return {
    kind: "pdf_form",
    name: params.name,
    stagedFileId: params.stagedFileId,
    ...(params.recordType !== undefined ? { recordType: params.recordType } : {}),
    ...(params.mapping !== undefined ? { mapping: params.mapping } : {}),
    ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
  }
}

function validateBody(body: Record<string, unknown> | undefined): void {
  if (body === undefined) return
  try {
    parseRichTextBody(body)
  } catch (err) {
    if (err instanceof RichTextError) throw new DocumentTemplateError("body_invalid", err.message)
    throw err
  }
}

/** Refused before a card is raised: a person never approves a template that cannot save. */
export async function documentTemplateCreatePreflight(
  params: z.infer<typeof createParams>,
  ctx: DocumentToolContext,
) {
  const out = await guarded("document_template_create", async () => {
    toCreateInput(params)
    validateBody(params.body)
    await assertPrintableRecordType(ctx.orgId, params.recordType)
    return { ok: true as const }
  })
  return out
}

export async function documentTemplateUpdatePreflight(
  params: z.infer<typeof updateParams>,
  ctx: DocumentToolContext,
) {
  return guarded("document_template_update", async () => {
    validateBody(params.body)
    await assertPrintableRecordType(ctx.orgId, params.recordType)
    const current = await getTemplate(ctx.db, params.templateId)
    if (!current) throw new DocumentTemplateError("not_found", "Template not found")
    if (current.archivedAt) throw new DocumentTemplateError("archived", "This template is archived")
    if (params.body !== undefined && current.kind !== "rich_text") {
      throw new DocumentTemplateError("wrong_kind", "Only a rich_text template has a body")
    }
    return { ok: true as const }
  })
}

function savedView(t: DocumentTemplate) {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    recordType: t.recordType,
    enabled: t.enabled,
    archived: t.archivedAt !== null,
  }
}

export async function handleDocumentTemplateCreate(
  params: z.infer<typeof createParams>,
  ctx: DocumentToolContext,
) {
  return guarded("document_template_create", async () => {
    await assertPrintableRecordType(ctx.orgId, params.recordType)
    const created = await createTemplate(templateCaller(ctx), toCreateInput(params))
    return { template: savedView(created) }
  })
}

export async function handleDocumentTemplateUpdate(
  params: z.infer<typeof updateParams>,
  ctx: DocumentToolContext,
) {
  return guarded("document_template_update", async () => {
    await assertPrintableRecordType(ctx.orgId, params.recordType)
    const { templateId, ...rest } = params
    const patch: PatchTemplateInput = {
      ...(rest.name !== undefined ? { name: rest.name } : {}),
      ...(rest.recordType !== undefined ? { recordType: rest.recordType } : {}),
      ...(rest.body !== undefined ? { body: rest.body } : {}),
      ...(rest.mapping !== undefined ? { mapping: rest.mapping } : {}),
      ...(rest.enabled !== undefined ? { enabled: rest.enabled } : {}),
    }
    const updated = await updateTemplate(templateCaller(ctx), templateId, patch)
    return { template: savedView(updated) }
  })
}

export async function handleDocumentTemplateArchive(
  params: z.infer<typeof archiveParams>,
  ctx: DocumentToolContext,
) {
  return guarded("document_template_archive", async () => ({
    template: savedView(await archiveTemplate(templateCaller(ctx), params.templateId)),
  }))
}

export async function handleDocumentTemplatePreview(
  params: z.infer<typeof previewParams>,
  ctx: DocumentToolContext,
) {
  return guarded("document_template_preview", async () => {
    const out = await previewTemplate(printCaller(ctx), {
      ...(params.templateId ? { templateId: params.templateId } : {}),
      ...(params.body !== undefined ? { body: params.body } : {}),
      ...(params.recordType !== undefined ? { recordType: params.recordType } : {}),
      ...(params.recordId ? { recordId: params.recordId } : {}),
      ...(params.name ? { name: params.name } : {}),
    })
    return {
      ...out,
      ...(out.sample
        ? {
            note: "SAMPLE values, not a real record: every page says so. Never send it as the real document.",
          }
        : {}),
    }
  })
}

export async function handleDocumentsPrint(
  params: z.infer<typeof printParams>,
  ctx: DocumentToolContext,
) {
  return guarded("documents_print", async () => {
    const out = await printDocuments(printCaller(ctx), {
      app: params.app,
      entity: params.entity,
      recordId: params.recordId,
      templateIds: params.templateIds,
      ...(params.merge !== undefined ? { merge: params.merge } : {}),
    })
    const blanks = out.files.flatMap((f) =>
      f.blanks.map((b) => ({ templateName: f.templateName, label: b.label, path: b.path ?? null })),
    )
    return { files: out.files, merged: out.merged, blanks }
  })
}

// ---------------------------------------------------------------------------
// Approval cards
// ---------------------------------------------------------------------------

interface SummarizerCtx {
  tx: RlsClient
  orgId: string
  userId: string
}

function blocksOf(body: unknown): Array<Record<string, unknown>> {
  const blocks = (body as { blocks?: unknown } | null | undefined)?.blocks
  return Array.isArray(blocks)
    ? blocks.filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
    : []
}

function blockCount(body: unknown): string {
  const blocks = blocksOf(body)
  const byType = new Map<string, number>()
  for (const b of blocks) {
    const type = typeof b.type === "string" ? b.type : "block"
    byType.set(type, (byType.get(type) ?? 0) + 1)
  }
  const detail = [...byType].map(([type, n]) => `${n} ${type}${n === 1 ? "" : "s"}`).join(", ")
  return `${blocks.length} block${blocks.length === 1 ? "" : "s"}${detail ? ` (${detail})` : ""}`
}

/** The most lines a card shows (the approval card's own cap). */
const CARD_MAX_LINES = 8
/** How much of one block a card quotes. */
const BLOCK_QUOTE_CHARS = 120

function truncated(text: string, max = BLOCK_QUOTE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat
}

/** What a block prints, as a person reads it on the card. */
function blockQuote(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "block"
  const text = (key: string) => (typeof block[key] === "string" ? (block[key] as string) : "")
  switch (type) {
    case "heading":
    case "paragraph":
      return `${type}: ${truncated(text("text"))}`
    case "list":
      return `list of ${text("from") || "?"}: ${truncated(text("line"))}`
    case "image":
      return "image"
    case "spacer":
      return "spacer"
    default:
      return type
  }
}

/**
 * The summary lines, then as many detail lines as the card has room for; what
 * does not fit is counted on the last line, so the card never hides a change.
 */
function withDetails(lines: string[], details: string[]): string[] {
  const room = CARD_MAX_LINES - lines.length
  if (room <= 0) return lines.slice(0, CARD_MAX_LINES)
  if (details.length <= room) return [...lines, ...details]
  const shown = details.slice(0, room - 1)
  return [...lines, ...shown, `and ${details.length - shown.length} more`]
}

function safePaths(kind: "rich_text" | "pdf_form", body: unknown, mapping: unknown): string[] {
  try {
    return templatePaths({
      kind,
      body: (body ?? null) as Record<string, unknown> | null,
      mapping: (mapping ?? {}) as DocumentTemplate["mapping"],
    })
  } catch {
    return []
  }
}

function listed(paths: readonly string[], max = 12): string {
  const shown = paths.slice(0, max).join(", ")
  return paths.length > max ? `${shown} and ${paths.length - max} more` : shown
}

async function recordTypeLabel(orgId: string, recordType: string | null | undefined) {
  if (!recordType) return "none"
  const types = await listPrintableRecordTypes(orgId).catch(() => [])
  const found = types.find((t) => t.recordType === recordType)
  return found ? `${found.label} (${recordType})` : recordType
}

export async function summarizeDocumentTemplateCreate(
  params: unknown,
  ctx: SummarizerCtx,
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as Partial<z.infer<typeof createParams>>
  const kind = p.kind ?? "rich_text"
  const name = p.name ?? "(no name)"
  const lines = [`Prints: ${await recordTypeLabel(ctx.orgId, p.recordType)}`]
  let details: string[] = []
  if (kind === "rich_text") {
    lines.push(`Content: ${blockCount(p.body)}`)
    const paths = safePaths(kind, p.body, undefined)
    lines.push(paths.length > 0 ? `Fills in: ${listed(paths)}` : "Fills in no record fields")
    details = blocksOf(p.body)
      .filter((b) => b.type !== "spacer")
      .map((b) => blockQuote(b))
  } else {
    lines.push("Content: the uploaded PDF form")
    lines.push(`Mapped form fields: ${Object.keys(p.mapping ?? {}).length}`)
  }
  if (p.enabled === false) lines.push("Saved turned off")
  return {
    kind: "document_template_create",
    title: `Create the document template "${name}"`,
    lines: withDetails(lines, details),
    impact: "internal",
  }
}

export async function summarizeDocumentTemplateUpdate(
  params: unknown,
  ctx: SummarizerCtx,
): Promise<ApprovalSummary> {
  const p = (params ?? {}) as Partial<z.infer<typeof updateParams>>
  const current = p.templateId ? await getTemplate(ctx.tx, p.templateId).catch(() => null) : null
  const name = current?.name ?? "a document template"
  const lines: string[] = []
  const details: string[] = []
  if (p.name !== undefined && p.name !== current?.name) lines.push(`Name: ${name} -> ${p.name}`)
  if (p.recordType !== undefined && p.recordType !== current?.recordType) {
    lines.push(
      `Prints: ${await recordTypeLabel(ctx.orgId, current?.recordType)} -> ${await recordTypeLabel(ctx.orgId, p.recordType)}`,
    )
  }
  if (p.enabled !== undefined && p.enabled !== current?.enabled) {
    lines.push(p.enabled ? "Turned on" : "Turned off")
  }
  if (p.body !== undefined) {
    const beforeBlocks = blocksOf(current?.body)
    const before = beforeBlocks.map((b) => JSON.stringify(b))
    const afterBlocks = blocksOf(p.body)
    const remaining = before.map((key, i) => ({ key, block: beforeBlocks[i] }))
    const addedBlocks: Array<Record<string, unknown>> = []
    afterBlocks.forEach((b) => {
      const i = remaining.findIndex((r) => r.key === JSON.stringify(b))
      if (i >= 0) remaining.splice(i, 1)
      else addedBlocks.push(b)
    })
    lines.push(
      `Content: ${before.length} -> ${blockCount(p.body)}; ${addedBlocks.length} new or changed, ${remaining.length} removed or replaced`,
    )
    for (const b of addedBlocks) details.push(`+ ${blockQuote(b)}`)
    for (const r of remaining) if (r.block) details.push(`- ${blockQuote(r.block)}`)
    const oldPaths = new Set(safePaths("rich_text", current?.body, undefined))
    const newPaths = safePaths("rich_text", p.body, undefined)
    const gained = newPaths.filter((x) => !oldPaths.has(x))
    const lost = [...oldPaths].filter((x) => !newPaths.includes(x))
    if (gained.length > 0) lines.push(`Now fills in: ${listed(gained)}`)
    if (lost.length > 0) lines.push(`No longer fills in: ${listed(lost)}`)
  }
  if (p.mapping !== undefined) {
    lines.push(`Form field mapping: ${Object.keys(p.mapping).length} fields mapped`)
  }
  if (lines.length === 0) lines.push("No visible change")
  return {
    kind: "document_template_update",
    title: `Change the document template "${name}"`,
    lines: withDetails(lines.slice(0, CARD_MAX_LINES), details),
    impact: "internal",
  }
}

export async function summarizeDocumentTemplateArchive(
  params: unknown,
  ctx: SummarizerCtx,
): Promise<ApprovalSummary> {
  const id = (params as { templateId?: string } | null)?.templateId
  const current = id ? await getTemplate(ctx.tx, id).catch(() => null) : null
  return {
    kind: "document_template_archive",
    title: `Archive the document template "${current?.name ?? id ?? "?"}"`,
    lines: [
      `Prints: ${await recordTypeLabel(ctx.orgId, current?.recordType)}`,
      "It leaves every list and can no longer be printed. Documents already printed stay.",
    ],
    impact: "internal",
  }
}

export const DocumentToolParams = {
  recordTypesParams,
  listParams,
  getParams,
  createParams,
  updateParams,
  archiveParams,
  previewParams,
  printParams,
}
