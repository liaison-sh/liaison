// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Preview a document template before it is saved or used: render it against
// one real record, or against a SAMPLE record built from the record type's
// declared fields, and hand the caller a short-lived PDF to open.
//
// The template is a saved one (`templateId`), a saved one with a draft body
// (`templateId` + `body`), or a draft that does not exist yet (`body` alone).
// The draft body passes the same schema a save does, so a preview that
// renders is a body that saves.
//
// A real record comes from the app's own record tool under the caller's
// authorization (print.ts readRecord), never from the caller. A sample record
// holds made-up values named after each field's label ("Sample Tracking
// number"), and every page of a sample preview carries a SAMPLE banner, so it
// can never pass for a real document.
//
// Both doors render through renderPreview: the agent tool (previewTemplate)
// and the settings page's REST route (previewSavedTemplate), which sends the
// PDF back and stores nothing. The agent's PDF is stored like a merged PDF
// (pdf/merge.ts): in an upload session of the caller's own, visible to them alone, which expires after 24 hours and is
// swept with the other expired staged uploads. Nothing is stored on a record
// or a template.

import { randomUUID } from "node:crypto"
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib"
import { withPrivilegedDb } from "~/db/privileged"
import type { DocumentTemplateKind } from "~/db/schema/kernel"
import { files, fileUploadSessions } from "~/db/schema/kernel"
import { putObject } from "~/infra/storage/object-storage"
import { pdfLogger as log } from "~/lib/logger"
import type { PrintDeclaration } from "~/modules/apps/app-registries"
import {
  assertParentVisible,
  buildStorageKey,
  FileServiceError,
  loadOrgSettings,
  resolveParent,
  wouldExceedOrgQuota,
} from "~/modules/files/service"
import { PdfReplayError } from "~/modules/pdf/replay"
import { hasScope } from "~/modules/permissions/permissions"
import { PdfFormError } from "./pdf-form"
import {
  assertRowsFit,
  declaredFieldOf,
  mappedRows,
  type PrintBlank,
  type PrintCaller,
  PrintError,
  printFilename,
  readRecord,
  recordLabelOf,
  resolveRecordType,
  templateRendererFor,
} from "./print"
import { parseRichTextBody, RichTextError, richTextPlaceholderPaths } from "./rich-text"
import {
  assertValidBody,
  type DocumentTemplate,
  DocumentTemplateError,
  getTemplate,
} from "./service"

/** How long a preview stays readable: the upload session default (file-upload-sessions.ts). */
export const PREVIEW_RETENTION_HOURS = 24

/** Rows a sample record gives each list, when the template does not say how many it prints. */
const SAMPLE_LIST_ROWS = 2

export interface PreviewInput {
  /** A saved template. */
  templateId?: string
  /** A rich_text body to preview instead of the saved one (or with no template at all). */
  body?: Record<string, unknown>
  /** "<app>:<entity>": overrides the template's record type (a draft has none of its own). */
  recordType?: string | null
  /** A real record of that type; without it, a sample record is used. */
  recordId?: string
  /** The draft's name, for the file name. */
  name?: string
}

/** A path the template reads that its record type does not declare: it always prints blank. */
export interface UnknownField {
  path: string
}

export interface PreviewResult {
  fileId: string
  filename: string
  byteSize: number
  pageCount: number
  /** True when the values are made up from the record type, not read from a record. */
  sample: boolean
  recordType: string | null
  recordId: string | null
  blanks: PrintBlank[]
  unknownFields: UnknownField[]
  expiresAt: string
}

// ---------------------------------------------------------------------------
// Sample records
// ---------------------------------------------------------------------------

function sampleValue(
  type: PrintDeclaration["fields"][number]["type"],
  label: string,
  row: number,
): unknown {
  switch (type) {
    case "number":
      return row + 1
    case "boolean":
      return true
    case "date":
      return new Date().toISOString().slice(0, 10)
    default:
      return row > 0 ? `Sample ${label} ${row + 1}` : `Sample ${label}`
  }
}

/** Set `value` at a dot path, creating objects on the way; never through the prototype. */
function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".")
  let cur: Record<string, unknown> = root
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] ?? ""
    const next = Object.hasOwn(cur, segment) ? cur[segment] : undefined
    if (next !== null && typeof next === "object" && !Array.isArray(next)) {
      cur = next as Record<string, unknown>
    } else {
      const created: Record<string, unknown> = {}
      Object.defineProperty(cur, segment, { value: created, enumerable: true, writable: true })
      cur = created
    }
  }
  const last = segments[segments.length - 1] ?? ""
  Object.defineProperty(cur, last, { value, enumerable: true, writable: true, configurable: true })
}

function getPath(root: Record<string, unknown>, path: string): unknown {
  let cur: unknown = root
  for (const segment of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, segment)) return undefined
    cur = (cur as Record<string, unknown>)[segment]
  }
  return cur
}

/**
 * A record with a made-up value for every declared field: text is "Sample
 * <label>", a number counts the row, a date is today. A repeating field
 * (`repeat: "lines"`) fills `rowsOf(list)` rows of its list.
 */
export function sampleRecordFor(
  declaration: Pick<PrintDeclaration, "fields">,
  rowsOf: (list: string) => number = () => SAMPLE_LIST_ROWS,
): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const field of declaration.fields) {
    const list = field.repeat
    if (list === undefined || !field.path.startsWith(`${list}.`)) {
      setPath(record, field.path, sampleValue(field.type, field.label, 0))
      continue
    }
    const rest = field.path.slice(list.length + 1)
    let rows = getPath(record, list)
    if (!Array.isArray(rows)) {
      rows = Array.from({ length: Math.max(0, rowsOf(list)) }, () => ({}))
      setPath(record, list, rows)
    }
    ;(rows as Array<Record<string, unknown>>).forEach((row, i) => {
      setPath(row, rest, sampleValue(field.type, field.label, i))
    })
  }
  return record
}

// ---------------------------------------------------------------------------
// Field check
// ---------------------------------------------------------------------------

/** The record paths a template reads (rich_text placeholders, pdf_form mapping paths). */
export function templatePaths(template: Pick<DocumentTemplate, "kind" | "body" | "mapping">) {
  if (template.kind === "rich_text") {
    return richTextPlaceholderPaths(parseRichTextBody(template.body ?? { blocks: [] }))
  }
  return Object.values(template.mapping)
    .map((e) => e.path)
    .filter((p): p is string => typeof p === "string")
}

/** The paths a template reads that the record type does not declare (a field or a list). */
export function unknownFieldsOf(paths: readonly string[], declaration: PrintDeclaration | null) {
  const lists = new Set(declaration?.fields.flatMap((f) => (f.repeat ? [f.repeat] : [])) ?? [])
  const out: UnknownField[] = []
  for (const path of paths) {
    if (declaration && (declaredFieldOf(declaration, path) || lists.has(path))) continue
    out.push({ path })
  }
  return out
}

// ---------------------------------------------------------------------------
// The SAMPLE banner
// ---------------------------------------------------------------------------

async function finishPdf(
  bytes: Uint8Array,
  sample: boolean,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  if (!sample) return { bytes, pageCount: doc.getPageCount() }
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const banner = "SAMPLE: example values, not a real record"
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize()
    page.drawText(banner, { x: 18, y: height - 14, size: 8, font, color: rgb(0.75, 0.1, 0.1) })
    const size = Math.min(width, height) / 6
    page.drawText("SAMPLE", {
      x: width * 0.18,
      y: height * 0.3,
      size,
      font,
      color: rgb(0.85, 0.2, 0.2),
      opacity: 0.12,
      rotate: degrees(45),
    })
  }
  const out = await doc.save({ useObjectStreams: false })
  return { bytes: out, pageCount: doc.getPageCount() }
}

// ---------------------------------------------------------------------------
// Storage: the caller's own short-lived staged file
// ---------------------------------------------------------------------------

async function stagePreview(
  caller: PrintCaller,
  filename: string,
  bytes: Uint8Array,
): Promise<{ fileId: string; expiresAt: Date }> {
  const session = await caller.withRls(async (tx) => {
    const [row] = await tx
      .insert(fileUploadSessions)
      .values({
        orgId: caller.orgId,
        createdBy: caller.userId,
        targetApp: "kernel",
        targetEntityType: "document_preview",
      })
      .returning({ id: fileUploadSessions.id, expiresAt: fileUploadSessions.expiresAt })
    return row
  })
  if (!session) throw new Error("document preview: no upload session returned")
  const full = await withPrivilegedDb(caller.orgId, "documents:preview-quota", async (tx) =>
    wouldExceedOrgQuota(
      tx,
      caller.orgId,
      await loadOrgSettings(tx, caller.orgId),
      bytes.byteLength,
    ),
  )
  if (full) {
    throw new PrintError(
      "storage_quota_exceeded",
      "The organisation's storage is full; the preview was not saved",
    )
  }
  const fileId = randomUUID()
  const storageKey = buildStorageKey({
    orgId: caller.orgId,
    app: "kernel",
    entityType: "file_upload_session",
    entityId: session.id,
    filename,
  })
  await putObject({ key: storageKey, body: bytes, contentType: "application/pdf" })
  await withPrivilegedDb(caller.orgId, "documents:preview-insert", async (tx) => {
    await tx.insert(files).values({
      id: fileId,
      orgId: caller.orgId,
      app: "kernel",
      entityType: "file_upload_session",
      entityId: session.id,
      filename,
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      storageKey,
      uploadedBy: caller.userId,
      disposition: "attachment",
    })
  })
  return { fileId, expiresAt: session.expiresAt }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function draftTemplate(input: PreviewInput, body: Record<string, unknown>): DocumentTemplate {
  const now = new Date()
  return {
    // A fresh id: no stored file is parented to it, so a draft's image blocks print nothing.
    id: randomUUID(),
    name: input.name?.trim() || "Draft template",
    kind: "rich_text",
    recordType: input.recordType ?? null,
    fileId: null,
    body,
    fields: [],
    mapping: {},
    enabled: true,
    createdBy: null,
    updatedBy: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  }
}

async function resolvePreviewTemplate(
  caller: PrintCaller,
  input: PreviewInput,
): Promise<DocumentTemplate> {
  if (input.body !== undefined) assertValidBody(input.body)
  if (!input.templateId) {
    if (input.body === undefined) {
      throw new DocumentTemplateError(
        "body_invalid",
        "Pass templateId (a saved template) or body (a draft rich_text body)",
      )
    }
    return draftTemplate(input, input.body)
  }
  const id = input.templateId
  const saved = await caller.withRls((tx) => getTemplate(tx, id))
  if (!saved) throw new DocumentTemplateError("not_found", "Template not found")
  if (saved.archivedAt) throw new DocumentTemplateError("archived", "This template is archived")
  if (input.body !== undefined && saved.kind !== "rich_text") {
    throw new DocumentTemplateError(
      "wrong_kind",
      "Only a rich_text template has a body; a PDF form's content is its file",
    )
  }
  return {
    ...saved,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.recordType !== undefined ? { recordType: input.recordType } : {}),
  }
}

function splitRecordType(recordType: string): { app: string; entity: string } {
  const [app = "", entity = ""] = recordType.split(":")
  return { app, entity }
}

/**
 * The caller may read the record for a preview: its file-parent row proves it. One exception: a
 * record type declaring `parentMadeOnPrint` makes that row only on its first print (an order's
 * row is written when its first paper is stored), so a record with no row yet is not invisible.
 * There, a caller holding the parent's read scope who sees no row reads the record through the
 * app's record tool under their own scopes and RLS. The manifest contract allows the flag only on
 * a parent whose rows are visible to every holder of that scope (contract.ts
 * parentMadeOnPrintErrors), so "no row seen" by a holder means no row: a row RLS hides is still
 * refused here, with the same 404. A print still needs the row (print.ts authorizeParent).
 */
async function assertRecordVisible(
  caller: PrintCaller,
  app: string,
  entity: string,
  recordId: string,
  declaration: PrintDeclaration,
): Promise<void> {
  const parent = resolveParent(caller.orgId, app, entity)
  if (!parent) return
  try {
    await caller.withRls((tx) => assertParentVisible(tx, parent, recordId))
  } catch (err) {
    if (err instanceof FileServiceError) {
      if (declaration.parentMadeOnPrint === true && hasScope(parent.readScope, caller.scopes)) return
      throw new PrintError("record_not_found", "The record was not found or is not visible to you")
    }
    throw err
  }
}

/** A template rendered for a preview, before anyone stores or sends it. */
export interface RenderedPreview {
  template: DocumentTemplate
  bytes: Uint8Array
  pageCount: number
  /** True when the values are made up from the record type, not read from a record. */
  sample: boolean
  /** The real record's label (its labelField), when one was read. */
  recordLabel: string | null
  blanks: PrintBlank[]
  unknownFields: UnknownField[]
}

/**
 * The one preview render, behind both doors (the agent tool and the settings
 * page's REST route): a real record is read only after the caller is shown to
 * see it, through the app's record tool; without one, the sample record is
 * used and every page says SAMPLE. A template that is turned off previews (it
 * is being designed), and nothing is stored here.
 */
export async function renderPreview(
  caller: PrintCaller,
  template: DocumentTemplate,
  recordId?: string,
): Promise<RenderedPreview> {
  const kind: DocumentTemplateKind = template.kind
  const renderer = templateRendererFor(kind)
  if (!renderer) {
    throw new PrintError(
      "renderer_unavailable",
      `Printing ${kind} templates is not available yet`,
      undefined,
      template.id,
    )
  }
  const recordType = template.recordType
  if (recordId && !recordType) {
    throw new PrintError(
      "record_type_not_printable",
      `The template "${template.name}" has no record type to read a record from: pass recordType, or preview it with the sample`,
      422,
      template.id,
    )
  }

  let declaration: PrintDeclaration = { recordTool: "", idParam: "", label: "", fields: [] }
  let known: PrintDeclaration | null = null
  let record: Record<string, unknown> = {}
  let recordLabel: string | null = null
  if (recordType) {
    const { app, entity } = splitRecordType(recordType)
    const resolved = await resolveRecordType(caller, app, entity)
    declaration = resolved.declaration
    known = declaration
    if (recordId) {
      await assertRecordVisible(caller, app, entity, recordId, declaration)
      record = await readRecord(caller, resolved, recordId)
      recordLabel = recordLabelOf(record, resolved.labelField, recordId)
    }
  }
  const sample = !recordId
  const paths = templatePaths(template)
  if (sample) {
    record = sampleRecordFor(declaration, (list) => {
      if (kind !== "pdf_form") return SAMPLE_LIST_ROWS
      // A form has a fixed number of row slots: the sample fills exactly those.
      return mappedRows(paths, list).size || SAMPLE_LIST_ROWS
    })
  }

  let rendered: Awaited<ReturnType<typeof renderer>>
  try {
    assertRowsFit(template, declaration, record)
    rendered = await renderer({ template, record, declaration, caller })
  } catch (err) {
    if (err instanceof RichTextError) {
      throw new PrintError(err.code === "body_invalid" ? "template_invalid" : err.code, err.message)
    }
    if (err instanceof PdfFormError || err instanceof PdfReplayError) {
      log.warn({ err, templateId: template.id }, "document preview: render refused")
      throw new PrintError("template_invalid", err.message)
    }
    throw err
  }

  const finished = await finishPdf(rendered.bytes, sample)
  return {
    template,
    bytes: finished.bytes,
    pageCount: finished.pageCount,
    sample,
    recordLabel,
    blanks: rendered.blanks,
    unknownFields: unknownFieldsOf(paths, known),
  }
}

/**
 * The agent's preview: a saved template, a saved one with a draft body, or a
 * draft alone, rendered by renderPreview and staged as the caller's own
 * short-lived file.
 */
export async function previewTemplate(
  caller: PrintCaller,
  input: PreviewInput,
): Promise<PreviewResult> {
  const template = await resolvePreviewTemplate(caller, input)
  const out = await renderPreview(caller, template, input.recordId)
  const filename = printFilename(`${out.sample ? "SAMPLE preview" : "Preview"} ${template.name}`)
  const stored = await stagePreview(caller, filename, out.bytes)
  return {
    fileId: stored.fileId,
    filename,
    byteSize: out.bytes.byteLength,
    pageCount: out.pageCount,
    sample: out.sample,
    recordType: template.recordType,
    recordId: input.recordId ?? null,
    blanks: out.blanks,
    unknownFields: out.unknownFields,
    expiresAt: stored.expiresAt.toISOString(),
  }
}

/** The settings page's preview of a saved template: the PDF comes back, nothing is stored. */
export interface SavedTemplatePreview {
  templateId: string
  filename: string
  bytes: Uint8Array
  blanks: PrintBlank[]
  sample: boolean
}

export async function previewSavedTemplate(
  caller: PrintCaller,
  templateId: string,
  input: { recordId?: string },
): Promise<SavedTemplatePreview> {
  const template = await caller.withRls((tx) => getTemplate(tx, templateId))
  if (!template || template.archivedAt) {
    throw new PrintError("template_not_found", `Template ${templateId} was not found`)
  }
  const out = await renderPreview(caller, template, input.recordId)
  return {
    templateId: template.id,
    filename: printFilename(`${template.name} ${out.recordLabel ?? "sample"}`),
    bytes: out.bytes,
    blanks: out.blanks,
    sample: out.sample,
  }
}
