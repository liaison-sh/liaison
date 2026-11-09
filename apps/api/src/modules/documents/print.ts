// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Print one app record through the organisation's document templates.
//
// An app declares on an entity `print: { recordTool, idParam, label, fields }`
// (manifest-schema.ts, contract.ts printDeclarationErrors). Printing:
//
//   1. checks the caller may write files on the entity's own fileParent (its
//      writeScope, and the record visible to them), before anything runs;
//   2. resolves the templates asked for: same org (RLS), live, enabled, made
//      for this record type;
//   3. runs the app's readOnly, ungated record tool under the CALLER's actor
//      (the approval-card hydration precedent, apps/runtime.ts
//      buildSummarizerMeta). The data always comes from the app, never from
//      an agent or a default;
//   4. renders every template in memory, by kind (TEMPLATE_RENDERERS: a
//      pdf_form fills its PDF form, a rich_text lays its blocks out, rich-text.ts). A value
//      that is missing or empty prints as a visible grey placeholder and is
//      listed in `blanks`. A list with more rows than a template has slots for
//      refuses (`too_many_rows`): a document is never truncated;
//   5. only when every template rendered, stores one PDF per template on the
//      record (storeGeneratedPdf, pdf/render.ts), and optionally one merged
//      file (pdf/merge.ts, staged for the caller).

import { MAX_IMAGE_BYTES } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import type { ActorContext } from "~/db/rls"
import type { DocumentTemplateKind } from "~/db/schema/kernel"
import { files } from "~/db/schema/kernel"
import { pdfLogger as log } from "~/lib/logger"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { checkToolScopes, resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import {
  entityRegistry,
  type PrintDeclaration,
  type PrintFieldDeclaration,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { isAppActiveForOrgAsync } from "~/modules/apps/org-apps"
import { assertParentVisible, FileServiceError, resolveParent } from "~/modules/files/service"
import { MergePdfsError, mergePdfs } from "~/modules/pdf/merge"
import { PdfStorageQuotaError, storeGeneratedPdf } from "~/modules/pdf/render"
import { PdfReplayError } from "~/modules/pdf/replay"
import { hasScope } from "~/modules/permissions/permissions"
import {
  fillPdfForm,
  PDF_FORM_MAX_BYTES,
  PdfFormError,
  type PdfFormImage,
  type PdfFormValue,
} from "./pdf-form"
import { RichTextError, renderRichText } from "./rich-text"
import { DOCUMENT_TEMPLATE_PARENT, type DocumentTemplate, getTemplate } from "./service"

/** Templates one print may produce (the merge takes at most 20 files). */
export const PRINT_MAX_TEMPLATES = 20

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PrintErrorCode =
  | "record_type_not_printable"
  | "print_record_tool_invalid"
  | "forbidden"
  | "record_not_found"
  | "record_unavailable"
  | "template_not_found"
  | "template_disabled"
  | "template_record_type_mismatch"
  | "template_file_missing"
  | "renderer_unavailable"
  | "too_many_rows"
  | "template_invalid"
  | "document_too_large"
  | "storage_quota_exceeded"
  | "merge_failed"
  | PdfFormError["code"]

const STATUS_OF: Record<string, number> = {
  record_type_not_printable: 404,
  print_record_tool_invalid: 422,
  forbidden: 403,
  record_not_found: 404,
  record_unavailable: 502,
  template_not_found: 404,
  template_disabled: 409,
  template_record_type_mismatch: 422,
  template_file_missing: 409,
  renderer_unavailable: 501,
  too_many_rows: 422,
  template_invalid: 422,
  document_too_large: 422,
  storage_quota_exceeded: 409,
  merge_failed: 422,
}

export class PrintError extends Error {
  readonly status: number
  constructor(
    readonly code: PrintErrorCode,
    message: string,
    status?: number,
    readonly templateId?: string,
  ) {
    super(message)
    this.name = "PrintError"
    // A PDF form refusal (value_too_long, invalid_option, ...) is the template's
    // or the record's content: 422.
    this.status = status ?? STATUS_OF[code] ?? 422
  }
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Who prints, and how to open their RLS transaction. */
export interface PrintCaller {
  orgId: string
  userId: string
  scopes: string[]
  /** The caller's actor: the record tool runs under it (a system actor for an app's own pass). */
  actor: ActorContext
  /** The agent acting for the person, when one is (decides the quota exemption). */
  actingAgentId: string | null
  withRls: <T>(fn: (tx: RlsClient) => Promise<T>) => Promise<T>
}

export interface PrintInput {
  app: string
  entity: string
  recordId: string
  templateIds: string[]
  merge?: boolean
}

/** A template field that printed as a grey placeholder: a person must fill it. */
export interface PrintBlank {
  /** The template's field name. */
  field: string
  /** What the field holds, in words (the record field's label when mapped). */
  label: string
  /** The record path it is mapped to, when it is. */
  path?: string
}

export interface PrintedFile {
  templateId: string
  templateName: string
  fileId: string
  filename: string
  byteSize: number
  blanks: PrintBlank[]
}

export interface PrintResult {
  files: PrintedFile[]
  merged: { fileId: string; filename: string; byteSize: number; pageCount: number } | null
}

/** One printable record type, for the settings page and the agent tools. */
export interface PrintableRecordType {
  app: string
  entity: string
  /** "<app>:<entity>", the value a template's recordType takes. */
  recordType: string
  label: string
  fields: PrintFieldDeclaration[]
}

// ---------------------------------------------------------------------------
// Template renderers, by kind
// ---------------------------------------------------------------------------

export interface TemplateRenderContext {
  template: DocumentTemplate
  /** The record JSON the app's record tool returned. */
  record: Record<string, unknown>
  declaration: PrintDeclaration
  caller: PrintCaller
}

export interface RenderedTemplate {
  bytes: Uint8Array
  blanks: PrintBlank[]
}

export type TemplateRenderer = (ctx: TemplateRenderContext) => Promise<RenderedTemplate>

/**
 * The renderer of each template kind. A kind with no entry here refuses with
 * `renderer_unavailable` before the record is read.
 */
const TEMPLATE_RENDERERS: Partial<Record<DocumentTemplateKind, TemplateRenderer>> = {
  pdf_form: renderPdfFormTemplate,
  rich_text: renderRichTextTemplate,
}

/** The renderer of a template kind; undefined when that kind cannot print yet. */
export function templateRendererFor(kind: DocumentTemplateKind): TemplateRenderer | undefined {
  return TEMPLATE_RENDERERS[kind]
}

// ---------------------------------------------------------------------------
// Record paths
// ---------------------------------------------------------------------------

/**
 * Walk a dot path (`lines.0.hts`) through the record: numeric segments index
 * arrays, other segments read an object's OWN properties only (no prototype
 * walk: `constructor`, `__proto__` resolve to nothing).
 */
export function readRecordPath(record: unknown, path: string): unknown {
  let cur: unknown = record
  for (const segment of path.split(".")) {
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(segment)) return undefined
      cur = cur[Number(segment)]
    } else if (cur !== null && typeof cur === "object" && Object.hasOwn(cur, segment)) {
      cur = (cur as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return cur
}

/** The declared field a concrete path stands for (`lines.0.hts` -> `lines.hts`). */
export function declaredFieldOf(
  declaration: PrintDeclaration,
  path: string,
): PrintFieldDeclaration | undefined {
  const shape = path
    .split(".")
    .filter((s) => !/^\d+$/.test(s))
    .join(".")
  return declaration.fields.find((f) => f.path === shape)
}

/** The row numbers of the list `list` a template maps (`lines.0.x`, `lines.1.y` -> {0, 1}). */
export function mappedRows(paths: readonly string[], list: string): Set<number> {
  const rows = new Set<number>()
  const prefix = `${list}.`
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue
    const index = path.slice(prefix.length).split(".")[0] ?? ""
    if (/^\d+$/.test(index)) rows.add(Number(index))
  }
  return rows
}

/**
 * D32: every row of a list the template prints must have its slot. A template
 * that maps none of a list's rows does not print that list; one that maps
 * some must have room for all of them.
 */
export function assertRowsFit(
  template: Pick<DocumentTemplate, "id" | "name" | "mapping">,
  declaration: PrintDeclaration,
  record: unknown,
): void {
  const paths = Object.values(template.mapping)
    .map((e) => e.path)
    .filter((p): p is string => typeof p === "string")
  const lists = new Set(
    declaration.fields.map((f) => f.repeat).filter((r): r is string => r !== undefined),
  )
  for (const list of lists) {
    const slots = mappedRows(paths, list)
    if (slots.size === 0) continue
    const rows = readRecordPath(record, list)
    if (!Array.isArray(rows)) continue
    for (let i = 0; i < rows.length; i++) {
      if (!slots.has(i)) {
        throw new PrintError(
          "too_many_rows",
          `The record has ${rows.length} rows in "${list}"; the template "${template.name}" has room for ${slots.size}. Nothing was printed: use a template with more rows.`,
          undefined,
          template.id,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// pdf_form
// ---------------------------------------------------------------------------

/** A record value as a PDF form field value; null when it has nothing printable. */
function formValue(value: unknown, fieldType: string): PdfFormValue {
  if (fieldType === "checkbox") return typeof value === "boolean" ? value : null
  if (fieldType === "signature" || fieldType === "button") return null
  if (typeof value === "string") return value.trim() === "" ? null : value
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null
  if (typeof value === "bigint") return String(value)
  if (typeof value === "boolean" && fieldType === "text") return value ? "Yes" : "No"
  return null
}

async function loadTemplatePdf(
  caller: PrintCaller,
  template: DocumentTemplate,
): Promise<Uint8Array> {
  const fileId = template.fileId
  if (!fileId) {
    throw new PrintError(
      "template_file_missing",
      `The template "${template.name}" has no PDF file; upload one in its settings`,
      undefined,
      template.id,
    )
  }
  const row = await caller.withRls(async (tx) => {
    const [r] = await tx
      .select({ storageKey: files.storageKey, encVersion: files.encVersion })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          eq(files.app, "kernel"),
          eq(files.entityType, DOCUMENT_TEMPLATE_PARENT),
          eq(files.entityId, template.id),
        ),
      )
      .limit(1)
    return r
  })
  if (row?.encVersion !== 0) {
    throw new PrintError(
      "template_file_missing",
      `The template "${template.name}" PDF file cannot be read`,
      undefined,
      template.id,
    )
  }
  const { bytes } = await getObjectBytes(row.storageKey, { maxBytes: PDF_FORM_MAX_BYTES })
  return new Uint8Array(bytes)
}

/** A PNG or JPEG file of this template (a signature, a stamp); null when unusable. */
async function loadTemplateImage(
  caller: PrintCaller,
  templateId: string,
  fileId: string,
): Promise<PdfFormImage | null> {
  const row = await caller.withRls(async (tx) => {
    const [r] = await tx
      .select({ storageKey: files.storageKey, mimeType: files.mimeType })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          eq(files.app, "kernel"),
          eq(files.entityType, DOCUMENT_TEMPLATE_PARENT),
          eq(files.entityId, templateId),
          eq(files.encVersion, 0),
        ),
      )
      .limit(1)
    return r
  })
  const mime = row?.mimeType.toLowerCase()
  const type = mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpeg" : null
  if (!row || !type) return null
  try {
    const { bytes } = await getObjectBytes(row.storageKey, { maxBytes: MAX_IMAGE_BYTES })
    return { bytes: new Uint8Array(bytes), type }
  } catch (err) {
    log.warn({ err, templateId, fileId }, "print: template image unreadable; printed blank")
    return null
  }
}

async function renderPdfFormTemplate(ctx: TemplateRenderContext): Promise<RenderedTemplate> {
  const { template, record, declaration, caller } = ctx
  const pdf = await loadTemplatePdf(caller, template)
  const typeOf = new Map(template.fields.map((f) => [f.name, f.type]))
  const values: Record<string, PdfFormValue> = {}
  const images: Record<string, PdfFormImage> = {}
  const placeholders: Record<string, string> = {}
  for (const [name, entry] of Object.entries(template.mapping)) {
    const fieldType = typeOf.get(name)
    if (fieldType === undefined) continue
    if (entry.placeholder !== undefined) placeholders[name] = entry.placeholder
    if (entry.path !== undefined) {
      values[name] = formValue(readRecordPath(record, entry.path), fieldType)
    } else if (entry.const !== undefined) {
      values[name] = entry.const
    } else if (entry.image_file_id !== undefined) {
      const image = await loadTemplateImage(caller, template.id, entry.image_file_id)
      if (image) images[name] = image
    }
  }
  let filled: Awaited<ReturnType<typeof fillPdfForm>>
  try {
    filled = await fillPdfForm(pdf, values, images, { placeholders })
  } catch (err) {
    if (err instanceof PdfFormError) {
      throw new PrintError(
        err.code,
        `Template "${template.name}"${err.field ? `, field "${err.field}"` : ""}: ${err.message}`,
        undefined,
        template.id,
      )
    }
    throw err
  }
  const blanks = filled.blank.map((field): PrintBlank => {
    const entry = template.mapping[field]
    const path = entry?.path
    const declared = path ? declaredFieldOf(declaration, path) : undefined
    return {
      field,
      label: declared?.label ?? entry?.placeholder ?? field,
      ...(path ? { path } : {}),
    }
  })
  return { bytes: filled.bytes, blanks }
}

// ---------------------------------------------------------------------------
// rich_text
// ---------------------------------------------------------------------------

/**
 * Lay the template's blocks out against the record (rich-text.ts). Its images
 * resolve only to files parented to THIS template (loadTemplateImage): an id
 * of another template's or another record's file prints nothing.
 */
async function renderRichTextTemplate(ctx: TemplateRenderContext): Promise<RenderedTemplate> {
  const { template, record, declaration, caller } = ctx
  try {
    const out = await renderRichText({
      body: template.body,
      record,
      labelOf: (path) => declaredFieldOf(declaration, path)?.label ?? path,
      resolveImage: async (fileId) => {
        const image = await loadTemplateImage(caller, template.id, fileId)
        if (!image) return null
        return { bytes: image.bytes, mime: image.type === "png" ? "image/png" : "image/jpeg" }
      },
      title: template.name,
    })
    return {
      bytes: out.bytes,
      blanks: out.blanks.map((b) => ({ field: b.path, label: b.label, path: b.path })),
    }
  } catch (err) {
    if (err instanceof RichTextError) {
      throw new PrintError(
        err.code === "body_invalid" ? "template_invalid" : err.code,
        `Template "${template.name}": ${err.message}`,
        undefined,
        template.id,
      )
    }
    if (err instanceof PdfReplayError) {
      log.error({ err, templateId: template.id, code: err.code }, "print: rich_text replay refused")
      throw new PrintError(
        "document_too_large",
        `Template "${template.name}": the document could not be drawn (${err.code}: ${err.message})`,
        undefined,
        template.id,
      )
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

/**
 * Every entity of the org's live apps that declares `print`. With `scopes`,
 * only the types whose record tool those scopes may call: a caller is not
 * told about records it could never read.
 */
export async function listPrintableRecordTypes(
  orgId: string,
  opts: { scopes?: readonly string[] } = {},
): Promise<PrintableRecordType[]> {
  await awaitOrgApps(orgId)
  const out: PrintableRecordType[] = []
  for (const [[regOrgId, app, entity], decl] of entityRegistry.entriesOf(orgId)) {
    if (regOrgId !== orgId || !decl.print) continue
    if (!(await isAppActiveForOrgAsync(orgId, app))) continue
    if (opts.scopes) {
      const tool = toolRegistry.get([orgId, app, decl.print.recordTool])
      if (!tool || !checkToolScopes(tool, [...opts.scopes]).authorized) continue
    }
    out.push({
      app,
      entity,
      recordType: `${app}:${entity}`,
      label: decl.print.label,
      fields: decl.print.fields,
    })
  }
  return out.sort((a, b) => a.recordType.localeCompare(b.recordType))
}

// ---------------------------------------------------------------------------
// Print
// ---------------------------------------------------------------------------

export interface ResolvedRecordType {
  declaration: PrintDeclaration
  labelField: string
  toolName: string
  /** The record tool's own scopes: what a turn that reads the record has read. */
  requiredScopes: string[]
}

export async function resolveRecordType(
  caller: PrintCaller,
  app: string,
  entity: string,
): Promise<ResolvedRecordType> {
  await awaitOrgApps(caller.orgId)
  const entry = entityRegistry.get([caller.orgId, app, entity])
  const declaration = entry?.print
  if (!entry || !declaration || !(await isAppActiveForOrgAsync(caller.orgId, app))) {
    throw new PrintError(
      "record_type_not_printable",
      `"${app}:${entity}" is not a record type that prints documents`,
    )
  }
  // The manifest was checked at registration; checked again here because this
  // is the door the kernel opens with the caller's authorization.
  const tool = toolRegistry.get([caller.orgId, app, declaration.recordTool])
  if (tool?.readOnly !== true || tool.gated === true || tool.conditionalGate === true) {
    throw new PrintError(
      "print_record_tool_invalid",
      `"${app}:${entity}" names a record tool that is not a registered readOnly, ungated tool`,
    )
  }
  return {
    declaration,
    labelField: entry.labelField,
    toolName: `${app}:${declaration.recordTool}`,
    requiredScopes: resolveRequiredScopes(tool),
  }
}

/** The caller holds the entity's file writeScope and sees the record. */
async function authorizeParent(caller: PrintCaller, input: PrintInput): Promise<void> {
  const parent = resolveParent(caller.orgId, input.app, input.entity)
  if (!parent) {
    throw new PrintError(
      "print_record_tool_invalid",
      `"${input.app}:${input.entity}" declares no fileParent to store printed files on`,
    )
  }
  if (!hasScope(parent.writeScope, caller.scopes)) {
    throw new PrintError(
      "forbidden",
      `Printing stores files on the record: it needs the ${parent.writeScope} permission`,
    )
  }
  try {
    await caller.withRls((tx) => assertParentVisible(tx, parent, input.recordId))
  } catch (err) {
    if (err instanceof FileServiceError) {
      throw new PrintError("record_not_found", "The record was not found or is not visible to you")
    }
    throw err
  }
}

async function resolveTemplates(
  caller: PrintCaller,
  input: PrintInput,
): Promise<DocumentTemplate[]> {
  const recordType = `${input.app}:${input.entity}`
  const ids = [...new Set(input.templateIds)]
  const templates = await caller.withRls(async (tx) => {
    const out: DocumentTemplate[] = []
    for (const id of ids) {
      const t = await getTemplate(tx, id)
      if (!t || t.archivedAt) {
        throw new PrintError("template_not_found", `Template ${id} was not found`, undefined, id)
      }
      out.push(t)
    }
    return out
  })
  for (const t of templates) {
    if (!t.enabled) {
      throw new PrintError(
        "template_disabled",
        `The template "${t.name}" is turned off`,
        undefined,
        t.id,
      )
    }
    if (t.recordType !== recordType) {
      throw new PrintError(
        "template_record_type_mismatch",
        `The template "${t.name}" prints ${t.recordType ?? "no record type"}, not ${recordType}`,
        undefined,
        t.id,
      )
    }
    if (!TEMPLATE_RENDERERS[t.kind]) {
      throw new PrintError(
        "renderer_unavailable",
        `The template "${t.name}" is a ${t.kind} template; printing ${t.kind} templates is not available yet`,
        undefined,
        t.id,
      )
    }
  }
  return templates
}

interface ToolFailure {
  status?: unknown
  code?: unknown
  message?: unknown
}

export async function readRecord(
  caller: PrintCaller,
  resolved: ResolvedRecordType,
  recordId: string,
): Promise<Record<string, unknown>> {
  const { executeTool } = await import("~/modules/apps/execute-tool")
  let result: Awaited<ReturnType<typeof executeTool>>
  try {
    result = await executeTool({
      toolName: resolved.toolName,
      orgId: caller.orgId,
      actor: caller.actor,
      params: { [resolved.declaration.idParam]: recordId },
      // The kernel reads the record for a print the caller asked for: an
      // ungated readOnly tool, so the origin decides no gate; "system" keeps
      // the audit truthful (no agent turn, no UI click on this tool).
      origin: "system",
      ...(caller.actingAgentId ? { agentId: caller.actingAgentId } : {}),
    })
  } catch (err) {
    const failure = err as ToolFailure
    const status =
      typeof failure.status === "number" && failure.status >= 400 && failure.status < 500
        ? failure.status
        : 502
    log.error(
      { err, tool: resolved.toolName, orgId: caller.orgId, code: failure.code },
      "print: the record tool failed",
    )
    throw new PrintError(
      "record_unavailable",
      `The record could not be read (${resolved.toolName}: ${String(failure.message ?? "failed")})`,
      status,
    )
  }
  if (result.blocked) {
    throw new PrintError(
      "print_record_tool_invalid",
      `${resolved.toolName} asked for an approval; a record tool must not`,
    )
  }
  // The record is in the agent's hands now (its values are in the PDF it can
  // pass on): the turn has read what the record tool reads, as if it had
  // called that tool itself, so the scope-taint rule judges its later writes
  // against those scopes too. No agent turn (a REST call): nothing to taint.
  currentRunContext()?.turnScopeAccumulator?.recordInjected(resolved.requiredScopes)
  const data = result.data
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new PrintError("record_unavailable", `${resolved.toolName} returned no record object`)
  }
  const record = data as Record<string, unknown>
  const error = record.error
  if (error !== null && typeof error === "object" && Object.keys(record).length === 1) {
    const message = (error as { message?: unknown }).message
    throw new PrintError(
      "record_unavailable",
      `The record could not be read (${resolved.toolName}: ${String(message ?? "error")})`,
      409,
    )
  }
  return record
}

/**
 * "<template> <record label>.pdf", as people read it: letters of any script
 * are kept, only path separators, control and reserved characters go (the
 * storage key sanitises its own copy, files/service.ts buildStorageKey).
 */
export function printFilename(name: string): string {
  const stem = name
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, " ")
    .replace(/\.pdf$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim()
  return `${stem || "document"}.pdf`
}

export function recordLabelOf(
  record: Record<string, unknown>,
  labelField: string,
  id: string,
): string {
  const value = Object.hasOwn(record, labelField) ? record[labelField] : undefined
  if (typeof value === "string" && value.trim() !== "") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return id
}

export async function printDocuments(caller: PrintCaller, input: PrintInput): Promise<PrintResult> {
  const resolved = await resolveRecordType(caller, input.app, input.entity)
  await authorizeParent(caller, input)
  const templates = await resolveTemplates(caller, input)
  const record = await readRecord(caller, resolved, input.recordId)

  // Every template renders before anything is stored: a refusal stores nothing.
  const rendered: Array<{ template: DocumentTemplate; out: RenderedTemplate }> = []
  for (const template of templates) {
    assertRowsFit(template, resolved.declaration, record)
    const renderer = TEMPLATE_RENDERERS[template.kind]
    if (!renderer) throw new Error(`no renderer for ${template.kind}`)
    const out = await renderer({ template, record, declaration: resolved.declaration, caller })
    rendered.push({ template, out })
  }

  const recordLabel = recordLabelOf(record, resolved.labelField, input.recordId)
  const printed: PrintedFile[] = []
  for (const { template, out } of rendered) {
    const filename = printFilename(`${template.name} ${recordLabel}`)
    try {
      const stored = await storeGeneratedPdf({
        orgId: caller.orgId,
        app: input.app,
        parent: { entityType: input.entity, entityId: input.recordId },
        filename,
        bytes: out.bytes,
        actor: { actorType: "user", actingAgentId: caller.actingAgentId },
        // An app's own pass has no person behind it: the file has no uploader.
        uploadedBy: caller.actor.actorType === "user" ? caller.userId : null,
      })
      printed.push({
        templateId: template.id,
        templateName: template.name,
        fileId: stored.fileId,
        filename,
        byteSize: out.bytes.byteLength,
        blanks: out.blanks,
      })
    } catch (err) {
      if (err instanceof PdfStorageQuotaError) {
        throw new PrintError("storage_quota_exceeded", err.message, undefined, template.id)
      }
      throw err
    }
  }

  let merged: PrintResult["merged"] = null
  if (input.merge === true && printed.length > 0) {
    try {
      const m = await caller.withRls((rlsTx) =>
        mergePdfs(
          {
            fileIds: printed.map((p) => p.fileId),
            title: printFilename(`${resolved.declaration.label} ${recordLabel}`),
          },
          { rlsTx, orgId: caller.orgId, userId: caller.userId },
        ),
      )
      merged = {
        fileId: m.file_id,
        filename: m.title,
        byteSize: m.byte_size,
        pageCount: m.page_count,
      }
    } catch (err) {
      if (err instanceof MergePdfsError) {
        throw new PrintError(
          err.code === "storage_quota_exceeded" ? "storage_quota_exceeded" : "merge_failed",
          `The documents were printed but could not be merged: ${err.message}`,
        )
      }
      throw err
    }
  }
  return { files: printed, merged }
}
