// SPDX-License-Identifier: FSL-1.1-ALv2
import type { KnowledgeActor } from "~/apps/knowledge/service"

export type KnowledgeSourceState =
  | "skipped"
  | "loading"
  | "complete"
  | "partial"
  | "unavailable"
  | "unauthorized"
  | "rate-limited"
  | "error"

export interface KnowledgeSourceStatus {
  source: string
  state: KnowledgeSourceState
  retryable: boolean
  message?: string
  cursor?: string
  durationMs?: number
  hitCount?: number
}

export interface KnowledgeSearchHit {
  source: string
  sourceEntityId: string
  title: string
  url?: string
  type: string
  scope?: string
  snippet?: string
  modifiedAt?: string
  sourceRank?: number
  fusedRank?: number
  badges?: string[]
  canFetchContent?: boolean
  status?: string
  duplicateKeys?: string[]
  cursor?: string
  /** App name of the external synced source mirroring this document hit (e.g.
   *  "gitlab"), when applicable. Mirrors the field on the shared
   *  `KnowledgeSearchHit` so provenance survives the wire to the web client. */
  syncedSourceApp?: string
}

export interface KnowledgeSearchInput {
  query: string
  limit: number
  mode?: "blended" | "per_source" | "both"
  sources?: string[]
  cursors?: Record<string, string>
  filters?: Record<string, unknown>
}

export interface KnowledgeSourceSearchResult {
  hits: KnowledgeSearchHit[]
  status: KnowledgeSourceStatus
}

export interface KnowledgeFolderItem {
  kind: "folder" | "file"
  externalId: string
  name: string
  // M2: REQUIRED. Top-level items in a mounted folder carry
  // parentExternalId === input.folderRef (the source root). Adapters must
  // always set this; the reconciler does NOT silently fall back.
  parentExternalId: string
  mimeType?: string
  modifiedAt?: string
  etag?: string
  size?: number
  url?: string
}

export interface KnowledgeFolderListInput {
  folderRef: string
  cursor?: string
}

export interface KnowledgeFolderListResult {
  items: KnowledgeFolderItem[]
  nextCursor?: string
  /**
   * When true, the remote search index was not fully scanned and the result
   * set may be incomplete. Callers (e.g. the sync reconciler) should surface
   * this to operators rather than silently treating the listing as exhaustive.
   */
  incompleteSearch?: boolean
}

export interface KnowledgePickedFolder {
  folderRef: string
  displayName: string
}

export interface KnowledgeSourceAdapter {
  source: string
  /** Federated search; absent: the source is not searched (links and reads only). */
  searchRemote?(
    input: KnowledgeSearchInput,
    actor: KnowledgeActor,
  ): Promise<KnowledgeSourceSearchResult>
  getRemoteMetadata?(input: { sourceEntityId: string }, actor: KnowledgeActor): Promise<unknown>
  fetchRemoteContent?(
    input: { sourceEntityId: string },
    actor: KnowledgeActor,
    purpose?: string,
  ): Promise<{
    status: string
    text?: string
    url?: string
    title?: string
    modifiedAt?: string
  }>
  browseRemote?(input: Record<string, unknown>, actor: KnowledgeActor): Promise<unknown>
  refreshLinkedMetadata?(input: Record<string, unknown>, actor: KnowledgeActor): Promise<unknown>
  // Synced folder source extension (M-2). Adapters that opt in materialize a
  // mounted folder tree into Knowledge documents + source_links via the
  // reconciler. `listFolder` enumerates direct children of `folderRef`;
  // `pickFolder` is an optional native folder picker (e.g. Drive Picker).
  listFolder?(
    input: KnowledgeFolderListInput,
    actor: KnowledgeActor,
  ): Promise<KnowledgeFolderListResult>
  pickFolder?(actor: KnowledgeActor): Promise<KnowledgePickedFolder | null>
  /**
   * Types beyond the text list (`isTextMime`) whose text `fetchRemoteContent`
   * gives, so the reconciler imports them as documents: Drive's Docs, Sheets,
   * Slides and Excel workbooks. Absent: the text list only.
   */
  hasText?(mimeType: string | undefined): boolean
  cachePolicyOptions?: Record<string, unknown>
}

/** Whether the reconciler imports a file of this type as a document from this adapter. */
export function importsAsDocument(
  adapter: Pick<KnowledgeSourceAdapter, "hasText">,
  mimeType: string | undefined,
): boolean {
  return isTextMime(mimeType) || adapter.hasText?.(mimeType) === true
}

export function isFolderSourceCapable(a: KnowledgeSourceAdapter): boolean {
  return typeof a.listFolder === "function"
}

// MIME allowlist for documents that the reconciler materialises as
// `app_knowledge.documents` (full body, indexed, searchable). Non-matching
// MIME types fall back to `source_links` (link-only, opens externally).
//
// M5: positive allowlist instead of `/^text\//. The previous broad pattern
// admitted text/html, text/javascript, text/css, text/x-script, image/svg+xml
// etc — none of which we want to ingest as readable bodies even though the
// DOMPurify sanitizer would catch the worst rendering escapes. Keep this
// list narrow; add types deliberately when a real use case shows up.
const ALLOWED_TEXT_MIMES = new Set<string>([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/markdown",
  "application/x-markdown",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
])

export function isTextMime(mime: string | undefined): boolean {
  if (!mime) return false
  const base = mime.split(";", 1)[0].trim().toLowerCase()
  return ALLOWED_TEXT_MIMES.has(base)
}
