// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE WEB APP'S ONE VIEW OF THE APP BUILDER API. Every builder and app-log read
// or action the web app makes goes through here, so the wire shape lives in one
// place:
//
//   GET  /apps/builder/drafts                      the org's live drafts
//   GET  /apps/builder/drafts/:id[?n=]             one draft, a version (files), its frame URL
//   GET  /apps/builder/drafts/:id/versions         kept versions, newest first
//   POST /apps/builder/drafts/:id/check   {n?}     build + type check
//   POST /apps/builder/drafts/:id/preview {n?, entry, params?}   read-only run
//   POST /apps/builder/drafts/:id/restore {n}      version n's files as the next version
//   POST /apps/builder/drafts/:id/discard
//   POST /apps/builder/drafts/:id/publish {n?}     apps admins only (kernel:apps:admin)
//   GET  /apps/builder/drafts/:id/:n/ui.js         the built interface, as text for the frame
//   GET  /apps/:name/logs?level=&runId=&limit=     what an app logged, newest first
//
// Refusals arrive as ApiError (code from the server's `{error: {code}}`).

/** The slice of the shell's API client the builder uses. */
export interface BuilderApi {
  get: <T = unknown>(path: string, init?: { suppressGlobalError?: boolean }) => Promise<T>
  post: <T = unknown>(
    path: string,
    body?: unknown,
    init?: { suppressGlobalError?: boolean },
  ) => Promise<T>
  rawGet: (path: string, init?: { suppressGlobalError?: boolean }) => Promise<Response>
}

export type DraftStatus = "draft" | "published" | "discarded"

export interface BuildError {
  file?: string
  line?: number
  message: string
  code?: string
}

export interface DraftBuild {
  ok: boolean
  packageSha256?: string
  uiSha256?: string
  sizeBytes?: number
  errors?: BuildError[]
  appName?: string
  appVersion?: string
  typecheck?: { ok: boolean; errors: BuildError[] }
  at: string
}

export interface Draft {
  id: string
  orgId: string
  baseName: string
  title: string
  status: DraftStatus
  publishedAppName: string | null
  latestVersion: number
  createdAt: string
  updatedAt: string
}

export type DraftFiles = Record<string, string>

export interface DraftVersion {
  draftId: string
  n: number
  files: DraftFiles
  message: string | null
  build: DraftBuild | null
  createdAt: string
}

export interface DraftVersionSummary {
  n: number
  message: string | null
  build: DraftBuild | null
  sizeBytes: number
  createdAt: string
}

export interface DraftDetail {
  draft: Draft
  appName: string
  version: DraftVersion
  /** Present when the version has a built interface. */
  preview: { frameUrl: string; uiUrl: string } | null
}

export interface CheckResult {
  draftId: string
  n: number
  ok: boolean
  errors: BuildError[]
  typecheck: { ok: boolean; errors: BuildError[] } | null
  appName: string
  appVersion: string
  packageSha256: string | null
  sizeBytes: number | null
}

export type EntryKind = "tool" | "job" | "webhook"

export interface RunLogLine {
  level: AppLogLevel
  message: string
  fields: Record<string, unknown>
  at: string
}

export interface PreviewResult {
  draftId: string
  n: number
  entry: { kind: EntryKind; name: string }
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; status?: number }
  logs: RunLogLine[]
  logsDropped: number
  runId: string
  durationMs: number
  storeNamespace: string
  neverPublished: boolean
}

export interface PublishResult {
  appName: string
  appVersion: string
  sha256: string
  draftId: string
  n: number
  firstPublish: boolean
}

export type AppLogLevel = "debug" | "info" | "warn" | "error"

export const APP_LOG_LEVELS: readonly AppLogLevel[] = ["debug", "info", "warn", "error"]

export interface AppLogEntry {
  id: string
  app: string
  runId: string
  level: AppLogLevel
  message: string
  fields: Record<string, unknown>
  at: string
}

const BASE = "/apps/builder/drafts"
const quiet = { suppressGlobalError: true }
const draftPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`

export function listDrafts(api: BuilderApi): Promise<Draft[]> {
  return api.get<Draft[]>(BASE, quiet)
}

export function getDraft(api: BuilderApi, id: string, n?: number): Promise<DraftDetail> {
  return api.get<DraftDetail>(`${draftPath(id)}${n ? `?n=${n}` : ""}`, quiet)
}

export function listVersions(api: BuilderApi, id: string): Promise<DraftVersionSummary[]> {
  return api.get<DraftVersionSummary[]>(`${draftPath(id)}/versions`, quiet)
}

export function checkDraft(api: BuilderApi, id: string, n?: number): Promise<CheckResult> {
  return api.post<CheckResult>(`${draftPath(id)}/check`, n ? { n } : {}, quiet)
}

export function previewDraft(
  api: BuilderApi,
  id: string,
  input: { n?: number; entry: { kind: EntryKind; name: string }; params?: Record<string, unknown> },
): Promise<PreviewResult> {
  return api.post<PreviewResult>(
    `${draftPath(id)}/preview`,
    {
      entry: input.entry,
      ...(input.n ? { n: input.n } : {}),
      ...(input.params ? { params: input.params } : {}),
    },
    quiet,
  )
}

export function restoreVersion(api: BuilderApi, id: string, n: number): Promise<DraftVersion> {
  return api.post<DraftVersion>(`${draftPath(id)}/restore`, { n }, quiet)
}

export function discardDraft(api: BuilderApi, id: string): Promise<Draft> {
  return api.post<Draft>(`${draftPath(id)}/discard`, {}, quiet)
}

export function publishDraft(api: BuilderApi, id: string, n?: number): Promise<PublishResult> {
  return api.post<PublishResult>(`${draftPath(id)}/publish`, n ? { n } : {}, quiet)
}

/** The version's built interface as text, handed to the sandboxed frame (never run here). */
export async function draftUiSource(api: BuilderApi, id: string, n: number): Promise<string> {
  const response = await api.rawGet(`${draftPath(id)}/${n}/ui.js`, quiet)
  return response.text()
}

export interface AppLogsQuery {
  level?: AppLogLevel
  runId?: string
  limit?: number
}

export function readAppLogs(
  api: BuilderApi,
  app: string,
  query: AppLogsQuery = {},
): Promise<AppLogEntry[]> {
  const q = new URLSearchParams()
  if (query.level) q.set("level", query.level)
  if (query.runId) q.set("runId", query.runId)
  if (query.limit) q.set("limit", String(query.limit))
  const s = q.toString()
  return api.get<AppLogEntry[]>(`/apps/${encodeURIComponent(app)}/logs${s ? `?${s}` : ""}`, quiet)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Whether `value` is a run id the logs route accepts. */
export function isRunId(value: string): boolean {
  return UUID.test(value)
}

/** Whether `name` is an org's custom app (`<base>-o<orgKey>`, the server's custom-app-name.ts). */
export function isCustomAppName(name: string): boolean {
  return /-o[0-9a-f]{8}$/.test(name)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The draft manifest, parsed; null when it is not JSON. */
export function draftManifest(files: DraftFiles): Record<string, unknown> | null {
  const text = files["app.manifest.json"]
  if (typeof text !== "string") return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The entry points a preview can run: the manifest's tools, jobs and webhooks. */
export function previewEntries(files: DraftFiles): Array<{ kind: EntryKind; name: string }> {
  const manifest = draftManifest(files)
  if (!manifest) return []
  const out: Array<{ kind: EntryKind; name: string }> = []
  const sections: Array<[EntryKind, string]> = [
    ["tool", "tools"],
    ["job", "jobs"],
    ["webhook", "webhooks"],
  ]
  for (const [kind, section] of sections) {
    for (const name of Object.keys(record(manifest[section]))) out.push({ kind, name })
  }
  return out
}

/** The interface components the manifest's tabs name (`views.tabTypes.*.component`). */
export function uiComponents(files: DraftFiles): string[] {
  const manifest = draftManifest(files)
  const tabs = record(record(manifest?.views).tabTypes)
  const names = new Set<string>()
  for (const tab of Object.values(tabs)) {
    const component = record(tab).component
    if (typeof component === "string" && component !== "") names.add(component)
  }
  return [...names]
}

/** The files in reading order: manifest, handlers, interface, then the rest by name. */
export function orderedFileNames(files: DraftFiles): string[] {
  const first = ["app.manifest.json", "handlers.ts", "ui.tsx", "README.md"]
  const names = Object.keys(files)
  return [
    ...first.filter((n) => names.includes(n)),
    ...names.filter((n) => !first.includes(n)).sort(),
  ]
}

/** Params typed as JSON: an object, or a message saying why not. */
export function parseParams(
  text: string,
): { ok: true; params: Record<string, unknown> } | { ok: false } {
  if (text.trim() === "") return { ok: true, params: {} }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false }
    return { ok: true, params: value as Record<string, unknown> }
  } catch {
    return { ok: false }
  }
}
