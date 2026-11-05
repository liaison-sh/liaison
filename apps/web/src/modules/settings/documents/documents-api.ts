// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The organisation's document templates (api modules/documents): the shapes
// the settings pages read, and the calls they make. Every write goes through
// the kernel's REST routes; the routes validate (a 422 names the problem and,
// for a body, its path), the pages only show what the server answered.

import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { createUploadSession, moveFilesToParent, uploadFile } from "~/modules/files/file-service"

export type TemplateKind = "pdf_form" | "rich_text"

export interface TemplateField {
  name: string
  type: "text" | "checkbox" | "radio" | "dropdown" | "signature" | "button"
  page: number
  multiline?: boolean
  maxLength?: number | null
  options?: string[]
  tooltip?: string | null
}

export interface MappingEntry {
  path?: string
  const?: string | boolean
  image_file_id?: string
  placeholder?: string
}

export type Mapping = Record<string, MappingEntry>

export type RichTextBlock =
  | { type: "heading"; text: string; level?: 1 | 2 | 3 }
  | { type: "paragraph"; text: string }
  | { type: "list"; from: string; line: string }
  | { type: "image"; fileId: string; width?: number; align?: "left" | "center" | "right" }
  | { type: "spacer"; height: number }

export interface RichTextPage {
  size?: "A4" | "Letter"
  fontSize?: number
  margins?: { top?: number; right?: number; bottom?: number; left?: number }
}

export interface RichTextBody {
  page?: RichTextPage
  blocks: RichTextBlock[]
}

export interface DocumentTemplate {
  id: string
  name: string
  kind: TemplateKind
  recordType: string | null
  fileId: string | null
  body?: RichTextBody | null
  fields: TemplateField[]
  mapping: Mapping
  enabled: boolean
  updatedAt: string
  archivedAt: string | null
}

export interface RecordTypeField {
  path: string
  label: string
  type: "string" | "number" | "boolean" | "date"
  repeat?: string
}

export interface RecordType {
  app: string
  entity: string
  recordType: string
  label: string
  fields: RecordTypeField[]
}

export interface PreviewBlank {
  field: string
  label: string
  path?: string
}

export interface PreviewResult {
  templateId: string
  filename: string
  byteSize: number
  blanks: PreviewBlank[]
  sample: boolean
  pdfBase64: string
}

/** The kernel file parent a template's own files (its images) hang off. */
export function templateParent(templateId: string) {
  return { app: "kernel", entityType: "document_template", entityId: templateId }
}

/** Errors are shown inline by the pages: no global toast. */
const INLINE = { suppressGlobalError: true } as const

export function listTemplates(api: ApiClient): Promise<DocumentTemplate[]> {
  return api.get<DocumentTemplate[]>("/document-templates", INLINE)
}

export function getTemplate(api: ApiClient, id: string): Promise<DocumentTemplate> {
  return api.get<DocumentTemplate>(`/document-templates/${id}`, INLINE)
}

export function listRecordTypes(api: ApiClient): Promise<RecordType[]> {
  return api.get<RecordType[]>("/documents/record-types", INLINE)
}

export function createRichTextTemplate(
  api: ApiClient,
  input: { name: string; recordType: string | null; body: RichTextBody },
): Promise<DocumentTemplate> {
  return api.post<DocumentTemplate>(
    "/document-templates",
    { kind: "rich_text", name: input.name, recordType: input.recordType, body: input.body },
    INLINE,
  )
}

/**
 * Stage the PDF in an upload session of the caller's, then create the
 * template from it: the server inspects and sanitises the file, and refuses
 * (422, with a code) a PDF that cannot print.
 */
export async function createPdfFormTemplate(
  api: ApiClient,
  input: { name: string; recordType: string | null; file: File },
): Promise<DocumentTemplate> {
  const session = await createUploadSession(api, {
    targetApp: "kernel",
    targetEntityType: "document_template",
    targetEntityId: null,
  })
  const staged = await uploadFile(api, input.file, {
    app: "kernel",
    entityType: "file_upload_session",
    entityId: session.id,
  })
  return api.post<DocumentTemplate>(
    "/document-templates",
    { kind: "pdf_form", name: input.name, recordType: input.recordType, stagedFileId: staged.id },
    INLINE,
  )
}

export function updateTemplate(
  api: ApiClient,
  id: string,
  patch: {
    name?: string
    recordType?: string | null
    enabled?: boolean
    body?: RichTextBody
    mapping?: Mapping
  },
): Promise<DocumentTemplate> {
  return api.patch<DocumentTemplate>(`/document-templates/${id}`, patch, INLINE)
}

export function archiveTemplate(api: ApiClient, id: string): Promise<DocumentTemplate> {
  return api.post<DocumentTemplate>(`/document-templates/${id}/archive`, {}, INLINE)
}

export function previewTemplate(
  api: ApiClient,
  id: string,
  input: { recordId?: string },
): Promise<PreviewResult> {
  return api.post<PreviewResult>(`/document-templates/${id}/preview`, input, INLINE)
}

/**
 * Add an image (a logo, a signature, a stamp) to a template: staged in an
 * upload session bound to the template, then moved onto it. Returns the file id.
 */
export async function uploadTemplateImage(
  api: ApiClient,
  templateId: string,
  file: File,
): Promise<string> {
  const session = await createUploadSession(api, {
    targetApp: "kernel",
    targetEntityType: "document_template",
    targetEntityId: templateId,
  })
  const staged = await uploadFile(api, file, {
    app: "kernel",
    entityType: "file_upload_session",
    entityId: session.id,
  })
  await moveFilesToParent(api, {
    sourceSessionId: session.id,
    target: templateParent(templateId),
    fileIds: [staged.id],
  })
  return staged.id
}

/** What a failed call says, and where (`details.field`: a body path or a field name). */
export interface InlineError {
  message: string
  code?: string
  field?: string
}

export function inlineError(err: unknown, fallback: string): InlineError {
  if (err instanceof ApiError) {
    const field = err.details?.field
    return {
      message: err.message || fallback,
      ...(err.code ? { code: err.code } : {}),
      ...(typeof field === "string" ? { field } : {}),
    }
  }
  if (err instanceof Error && err.message) return { message: err.message }
  return { message: fallback }
}

/** The block index a body path points at ("blocks.2.text" -> 2), or null. */
export function blockIndexOf(path: string | undefined): number | null {
  const m = path ? /^blocks\.(\d+)(?:\.|$)/.exec(path) : null
  return m ? Number(m[1]) : null
}

/**
 * The paths a placeholder can name: top-level fields as declared; inside a
 * list block (`from` set) the fields of that list's rows, relative to the row.
 */
export function insertablePaths(
  recordType: RecordType | undefined,
  listFrom?: string,
): RecordTypeField[] {
  if (!recordType) return []
  if (listFrom) {
    const prefix = `${listFrom}.`
    return recordType.fields
      .filter((f) => f.repeat === listFrom && f.path.startsWith(prefix))
      .map((f) => ({ ...f, path: f.path.slice(prefix.length) }))
  }
  return recordType.fields.filter((f) => f.repeat === undefined)
}

/** The lists a record type declares (the `repeat` of its fields). */
export function recordLists(recordType: RecordType | undefined): string[] {
  if (!recordType) return []
  return [...new Set(recordType.fields.map((f) => f.repeat).filter((r): r is string => !!r))].sort()
}

/** Insert `{{path}}` into `text` in place of [start, end). Returns the text and the new caret. */
export function insertPlaceholder(
  text: string,
  start: number,
  end: number,
  path: string,
): { text: string; caret: number } {
  const token = `{{${path}}}`
  const s = Math.max(0, Math.min(start, text.length))
  const e = Math.max(s, Math.min(end, text.length))
  return { text: text.slice(0, s) + token + text.slice(e), caret: s + token.length }
}

/** Base64 PDF bytes as a Blob. */
export function pdfBlob(base64: string): Blob {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return new Blob([bytes], { type: "application/pdf" })
}

// ---------------------------------------------------------------------------
// Needed-template rules (api modules/documents/rules-store.ts)
// ---------------------------------------------------------------------------

export interface RuleWhen {
  sku?: string[]
  countryIso2?: string[]
  carrier?: string[]
}

export interface DocumentTemplateRule {
  id: string
  recordType: string
  name: string
  when: RuleWhen
  templateIds: string[]
  note: string | null
  enabled: boolean
}

export interface RuleInput {
  recordType: string
  name: string
  when: RuleWhen
  templateIds: string[]
  note: string | null
  enabled: boolean
}

export function listRules(api: ApiClient, recordType: string): Promise<DocumentTemplateRule[]> {
  return api.get<DocumentTemplateRule[]>(
    `/document-template-rules?recordType=${encodeURIComponent(recordType)}`,
    INLINE,
  )
}

export function createRule(api: ApiClient, input: RuleInput): Promise<DocumentTemplateRule> {
  return api.post<DocumentTemplateRule>("/document-template-rules", input, INLINE)
}

export function updateRule(
  api: ApiClient,
  id: string,
  patch: Partial<RuleInput>,
): Promise<DocumentTemplateRule> {
  return api.patch<DocumentTemplateRule>(`/document-template-rules/${id}`, patch, INLINE)
}

export function deleteRule(api: ApiClient, id: string): Promise<unknown> {
  return api.delete(`/document-template-rules/${id}`, undefined, INLINE)
}

/** "a, b  c" -> ["a", "b", "c"]: values typed in one box, split on commas and spaces. */
export function splitValues(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

/** The conditions as the API takes them: only the ones that list a value. */
export function whenFrom(input: { sku: string; countryIso2: string; carrier: string }): RuleWhen {
  const sku = splitValues(input.sku)
  const countryIso2 = splitValues(input.countryIso2).map((c) => c.toUpperCase())
  const carrier = splitValues(input.carrier)
  return {
    ...(sku.length > 0 ? { sku } : {}),
    ...(countryIso2.length > 0 ? { countryIso2 } : {}),
    ...(carrier.length > 0 ? { carrier } : {}),
  }
}
