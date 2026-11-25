// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Knowledge import of a Notion export (Markdown & CSV), its pure parts and
// its calls. The server's built-in `notion-export` reads the zip, the preview
// names every item that would not come across, the run acts as the person, and
// undo removes what it made. Here: a file refused before any upload, a server
// refusal read as a reason the screen translates, every loss sorted into a
// group a person reads (the server's English is never shown as a sentence),
// totals that count every item not listed by name, and the run a reopened tab
// picks up again.

import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { hasScope } from "~/modules/auth/auth-store"
import type { ImportRun } from "~/modules/imports/import-run-store"

/** Whoever may import a Notion export: the entries to the import tab show for them only. */
export const canImportNotion = (): boolean =>
  hasScope("kernel:imports:run") && hasScope("kernel:imports:read")

const QUIET = { suppressGlobalError: true } as const

/** Who sees what the import makes: only the person, everyone reads, everyone edits. */
export type Access = "private" | "view" | "edit"

export type Refusal =
  | "pdf"
  | "html"
  | "notZip"
  | "htmlExport"
  | "noPages"
  | "encrypted"
  | "zipBomb"
  | "tooManyEntries"
  | "unsafeEntry"
  | "unsupportedMethod"
  | "tooLarge"
  | "nestedTooDeep"
  | "forbidden"
  | "other"

export interface Loss {
  what: string
  where: string
}
export interface MissingFile {
  path: string
  reason: string
}

export type LossGroup =
  | "alreadyImported"
  | "inTrash"
  | "importedDeleted"
  | "importedHidden"
  | "webImage"
  | "embed"
  | "deadLink"
  | "fileMissing"
  | "fileNotCarried"
  | "pageTooLarge"
  | "storageFull"
  | "rowsPast"
  | "databaseRows"
  | "relationColumn"
  | "unknownBlock"
  | "failed"
  | "other"

/** The order groups are shown in: what a person acts on first. */
export const GROUP_ORDER: LossGroup[] = [
  "alreadyImported",
  "inTrash",
  "importedDeleted",
  "importedHidden",
  "webImage",
  "embed",
  "deadLink",
  "fileMissing",
  "fileNotCarried",
  "pageTooLarge",
  "storageFull",
  "rowsPast",
  "databaseRows",
  "relationColumn",
  "unknownBlock",
  "failed",
  "other",
]

export interface LossItem {
  group: LossGroup
  /** The page (or file) it is about. */
  where: string
  /** What exactly: a web address, a file or page name, a block, the server's words for "other". */
  detail?: string
  params?: Record<string, number>
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/** A file that cannot be a Notion export, named before anything is uploaded. */
export async function precheckFile(file: File): Promise<Refusal | null> {
  const name = file.name.toLowerCase()
  if (name.endsWith(".pdf")) return "pdf"
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html"
  if (!name.endsWith(".zip")) return "notZip"
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return ZIP_MAGIC.every((b, i) => head[i] === b) ? null : "notZip"
}

const REASONS: Record<string, Refusal> = {
  zip_encrypted: "encrypted",
  zip_ratio_exceeded: "zipBomb",
  zip_decompressed_too_large: "zipBomb",
  zip_too_many_entries: "tooManyEntries",
  zip_unsafe_entry: "unsafeEntry",
  zip_unsupported_method: "unsupportedMethod",
  invalid_zip: "notZip",
  upload_too_large: "tooLarge",
  zip_nested_too_deep: "nestedTooDeep",
}

/** A server refusal of the upload as a reason; anything else is "other". */
export function refusalOfError(err: unknown): Refusal {
  if (err instanceof ApiError) {
    const reason = err.details?.reason
    if (typeof reason === "string" && REASONS[reason]) return REASONS[reason]
    if (err.status === 403) return "forbidden"
  }
  return "other"
}

export type Counts = Record<string, { created: number; skipped: number; failed: number }>
export interface EntryTypes {
  markdown: number
  csv: number
  html: number
  other: number
}

/** A preview that would create nothing and skip nothing: not a Notion Markdown export. */
export function previewRefusal(counts: Counts, entries: EntryTypes): Refusal | null {
  let any = 0
  for (const c of Object.values(counts)) any += c.created + c.skipped + c.failed
  if (any > 0) return null
  return entries.html > 0 && entries.markdown === 0 ? "htmlExport" : "noPages"
}

const inParens = (s: string) => /\((.*)\)$/.exec(s)?.[1]

/** One named loss of the transform or the import, in its group. */
export function classifyLoss(loss: Loss): LossItem {
  const { what, where } = loss
  const item = (group: LossGroup, detail?: string): LossItem =>
    detail === undefined ? { group, where } : { group, where, detail }
  switch (what) {
    case "already imported":
      return item("alreadyImported")
    case "in Trash":
      return item("inTrash")
    case "already imported, deleted since":
      return item("importedDeleted")
    case "already imported, you cannot open it":
      return item("importedHidden")
    case "the database's rows are not in the export":
      return item("databaseRows")
  }
  if (what.startsWith("web image")) return item("webImage", inParens(what))
  if (what === "embed" || what.startsWith("embed (")) return item("embed", inParens(what))
  const block = /^unknown block <(.+)>$/.exec(what)
  if (block) return item("unknownBlock", block[1])
  if (what.startsWith("link to a page not in the export")) return item("deadLink", inParens(what))
  if (what.startsWith("file missing from the export")) return item("fileMissing", inParens(what))
  const notCarried = /^file not carried \((.*?)\):/.exec(what)
  if (notCarried) return item("fileNotCarried", notCarried[1])
  if (what.startsWith("relation column kept as text")) return item("relationColumn", inParens(what))
  const rows = /^(\d+) rows past the first (\d+) are not in the table$/.exec(what)
  if (rows)
    return { group: "rowsPast", where, params: { count: Number(rows[1]), max: Number(rows[2]) } }
  return item("other", what)
}

/** A file of the upload the runner did not read or copy. */
export function missingFileItem(m: MissingFile): LossItem {
  if (/over 1 MB/.test(m.reason)) return { group: "pageTooLarge", where: m.path }
  if (/storage quota/.test(m.reason)) return { group: "storageFull", where: m.path }
  if (/no such file/.test(m.reason)) return { group: "fileMissing", where: m.path }
  return { group: "other", where: m.path, detail: m.reason }
}

export interface LossInput {
  losses: Loss[]
  lossesNotListed: number
  missingFiles: MissingFile[]
  attachmentsMissing: number
  errors: Array<Record<string, unknown>>
  failed: number
}

export interface LossSummary {
  groups: Array<{ group: LossGroup; items: LossItem[] }>
  /** Items shown by name. */
  listed: number
  /** Items counted but not named (past the server's caps). */
  notListed: number
  /** Every item that did not come across: listed + notListed. Zero only when nothing was lost. */
  total: number
}

/** Every loss in its group, and every one past the caps counted: nothing counted unsaid. */
export function summarizeLosses(input: LossInput): LossSummary {
  const items: LossItem[] = [
    ...input.losses.map(classifyLoss),
    ...input.missingFiles.map(missingFileItem),
    ...input.errors.map(
      (e): LossItem => ({
        group: "failed",
        where: typeof e.at === "string" ? e.at : "",
      }),
    ),
  ]
  const byGroup = new Map<LossGroup, LossItem[]>()
  for (const it of items) byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), it])
  const groups = GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
    group: g,
    items: byGroup.get(g) ?? [],
  }))
  const notListed =
    Math.max(0, input.lossesNotListed) +
    Math.max(0, input.attachmentsMissing - input.missingFiles.length) +
    Math.max(0, input.failed - input.errors.length)
  return { groups, listed: items.length, notListed, total: items.length + notListed }
}

/** The loss parts of a run's (or a preview's) report. */
export function lossInputOf(
  report: Record<string, unknown>,
  errors: Array<Record<string, unknown>> = [],
  counts: Counts = {},
): LossInput {
  let failed = 0
  for (const c of Object.values(counts)) failed += c.failed
  return {
    losses: Array.isArray(report.losses) ? (report.losses as Loss[]) : [],
    lossesNotListed: Number(report.lossesNotListed) || 0,
    missingFiles: Array.isArray(report.missingFiles) ? (report.missingFiles as MissingFile[]) : [],
    attachmentsMissing: Number(report.attachmentsMissing) || 0,
    errors,
    failed,
  }
}

const NOTION_LABEL = /^builtin:notion(:u:.+)?$/

/** The person's newest Notion import still worth showing (not a preview, not undone, not put away). */
export function pickResumableRun<R extends ImportRun & { startedBy?: string | null }>(
  runs: R[],
  userId: string,
  dismissedId: string | null,
): R | undefined {
  const mine = runs
    .filter((r) => !r.dryRun && NOTION_LABEL.test(r.sourceLabel) && r.startedBy === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const newest = mine[0]
  // An undone run is over: the tab opens on a new upload.
  return newest && newest.id !== dismissedId && newest.status !== "undone" ? newest : undefined
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface NotionPreview {
  previewId: string
  counts: Counts
  errorRate: number
  errors: Array<Record<string, unknown>>
  named: {
    losses: Loss[]
    lossesNotListed: number
    missingFiles: MissingFile[]
    attachmentsMissing: number
    filesToCopy: number
    entries: EntryTypes
  }
}

/** Read the whole upload as the person would import it; nothing is written. */
export function previewNotion(api: ApiClient, fileId: string, access: Access) {
  return api.post<NotionPreview>(
    "/imports/previews",
    { builtin: "notion-export", params: { access }, fileIds: [fileId] },
    QUIET,
  )
}

/** Start the run this preview showed. */
export function startNotion(api: ApiClient, previewId: string) {
  return api.post<{ runId: string; status: string }>(
    `/imports/previews/${previewId}/start`,
    undefined,
    QUIET,
  )
}

/** The org's recent runs the person may read. */
export function recentRuns(api: ApiClient) {
  return api.get<Array<ImportRun & { startedBy?: string | null }>>("/imports", QUIET)
}

const DISMISSED_KEY = "liaison:knowledge-notion-import:dismissed"

/** The run the person put away ("Import another export"), per browser. */
export function dismissedRun(userId: string): string | null {
  try {
    return localStorage.getItem(`${DISMISSED_KEY}:${userId}`)
  } catch {
    return null
  }
}

export function dismissRun(userId: string, runId: string): void {
  try {
    localStorage.setItem(`${DISMISSED_KEY}:${userId}`, runId)
  } catch {
    // Without storage the next visit shows the report again: harmless.
  }
}
