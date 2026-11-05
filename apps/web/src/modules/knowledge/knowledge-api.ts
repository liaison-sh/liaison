// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge API client — thin wrappers over the HTTP endpoints exposed by
// `apps/api/src/apps/knowledge/routes.ts`. Endpoint paths here are the
// integration contract; the routes.ts unit + integration tests pin the
// server side.
import type { KnowledgeSearchHit, KnowledgeSourceStatus } from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"

export type { KnowledgeSearchHit, KnowledgeSourceStatus } from "@liaison/shared"

export interface KnowledgeHomeData {
  personal: unknown[]
  recent: unknown[]
  needsReview: unknown[]
  sourceHealth: unknown[]
  unfiledCount?: number
}

export interface KnowledgeSearchParams {
  query: string
  limit?: number
  mode?: "blended" | "per_source" | "both"
  sources?: string[]
  cursors?: Record<string, string>
  filters?: Record<string, unknown>
}

export interface KnowledgeSearchResult {
  hits: KnowledgeSearchHit[]
  sourceStatuses: KnowledgeSourceStatus[]
  cursors?: Record<string, string>
  duplicates?: unknown[]
  final: boolean
}

export interface KnowledgeBacklink {
  app: string
  entityType: string
  entityId: string
  title: string
  url?: string
}

export interface KnowledgeSourceTelemetry {
  source: string
  policy: string
  connectionMode?: string
  broadSearchEnabled?: boolean
  cachedBytes: number
  cachedChunks: number
  cachedDays: number
  lastRefreshAt?: string
  lastError?: string
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export async function fetchKnowledgeHome(api: ApiClient): Promise<KnowledgeHomeData> {
  return api.get("/knowledge/home")
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export async function listKnowledgeDocuments(api: ApiClient): Promise<unknown[]> {
  return api.get("/knowledge/documents")
}

export async function listUnfiledKnowledgeDocuments(api: ApiClient): Promise<unknown[]> {
  return api.get("/knowledge/documents?filter=unfiled")
}

export async function getKnowledgeDocument(
  api: ApiClient,
  id: string,
  opts?: { signal?: AbortSignal },
): Promise<unknown> {
  return api.get(`/knowledge/documents/${id}`, opts)
}

export interface CreateKnowledgeDocumentInput {
  title?: string
  body?: string
  documentScope?: "personal" | "organization"
  /** Optional initial general-access level (Share dialog "General access"). */
  orgAccess?: KnowledgeOrgAccess
  [key: string]: unknown
}

export interface UpdateKnowledgeDocumentInput {
  title?: string
  body?: string
  revision?: number
  /** Optional general-access level (Share dialog "General access"). */
  orgAccess?: KnowledgeOrgAccess
  [key: string]: unknown
}

export async function createKnowledgeDocument(
  api: ApiClient,
  body: CreateKnowledgeDocumentInput | unknown,
): Promise<unknown> {
  return api.post("/knowledge/documents", body)
}

export async function updateKnowledgeDocument(
  api: ApiClient,
  id: string,
  body: UpdateKnowledgeDocumentInput | unknown,
): Promise<unknown> {
  return api.patch(`/knowledge/documents/${id}`, body)
}

// ---------------------------------------------------------------------------
// Sharing (Google-Drive-style per-document access control)
// ---------------------------------------------------------------------------

export type KnowledgeOrgAccess = "none" | "viewer" | "editor"
export type KnowledgeShareRole = "viewer" | "editor"

export interface KnowledgeShareEntry {
  userId: string
  role: KnowledgeShareRole
}

export interface KnowledgeRoleShareEntry {
  roleId: string
  role: KnowledgeShareRole
}

export interface KnowledgeDocumentSharing {
  orgAccess: KnowledgeOrgAccess
  /** Scoped-edit gate (e.g. `'clevel'`). When set alongside `orgAccess:
   * 'viewer'`, everyone in the org can view but only holders of that scope
   * can edit. `null` means no scoped-edit gate. */
  editScope: string | null
  shares: KnowledgeShareEntry[]
  roleShares?: KnowledgeRoleShareEntry[]
}

export interface KnowledgeMember {
  userId: string
  name: string
  email: string
}

export interface KnowledgeRole {
  roleId: string
  name: string
  memberCount: number
}

export async function getDocumentSharing(
  api: ApiClient,
  docId: string,
): Promise<KnowledgeDocumentSharing> {
  return api.get(`/knowledge/documents/${docId}/sharing`)
}

export async function setDocumentSharing(
  api: ApiClient,
  docId: string,
  body: KnowledgeDocumentSharing,
): Promise<KnowledgeDocumentSharing> {
  return api.put(`/knowledge/documents/${docId}/sharing`, body)
}

export async function listKnowledgeMembers(api: ApiClient): Promise<KnowledgeMember[]> {
  return api.get("/knowledge/members")
}

export async function listKnowledgeRoles(api: ApiClient): Promise<KnowledgeRole[]> {
  return api.get("/knowledge/roles")
}

export async function archiveKnowledgeDocument(api: ApiClient, id: string): Promise<unknown> {
  return api.post(`/knowledge/documents/${id}/archive`, {})
}

export async function restoreKnowledgeDocument(api: ApiClient, id: string): Promise<unknown> {
  return api.post(`/knowledge/documents/${id}/restore`, {})
}

export async function verifyKnowledgeDocument(
  api: ApiClient,
  id: string,
  body: { revision: number },
): Promise<unknown> {
  return api.post(`/knowledge/documents/${id}/verify`, body)
}

/**
 * Backlinks for a Knowledge document. The server filters to references the
 * caller is authorized to see; the client renders whatever is returned (no
 * client-side redaction logic).
 */
export async function getKnowledgeDocumentBacklinks(
  api: ApiClient,
  id: string,
  opts?: { signal?: AbortSignal },
): Promise<{ backlinks: KnowledgeBacklink[] }> {
  return api.get(`/knowledge/documents/${id}/backlinks`, opts)
}

// ---------------------------------------------------------------------------
// Collections tree
// ---------------------------------------------------------------------------

export interface CollectionTreeNode {
  id: string
  name: string
  parentId: string | null
  /** UUID of the personal owner of this collection. Null when shared with
   * the whole org. Drives the Personal/Shared split in the sidebar. */
  ownerUserId: string | null
  /** Synced-source id when this collection is the root of a mounted folder
   * tree (T-9). Used by the sidebar to render a cloud badge. */
  syncedSourceId?: string | null
  virtual?: boolean
  children: CollectionTreeNode[]
  /** `syncedSourceId` is set on a document mirrored from an external synced
   *  source, so the tree can mark its provenance (T-9 cloud badge). */
  documents: Array<{ id: string; title: string; syncedSourceId?: string | null }>
}

export async function getCollectionsTree(api: ApiClient): Promise<CollectionTreeNode[]> {
  return api.get<CollectionTreeNode[]>("/knowledge/collections/tree")
}

export interface KnowledgeCollectionInput {
  name: string
  parentCollectionId?: string | null
  description?: string | null
  ownerUserId?: string | null
}

export async function createCollection(
  api: ApiClient,
  body: KnowledgeCollectionInput,
): Promise<{ id: string }> {
  return api.post("/knowledge/collections", body)
}

export async function updateCollection(
  api: ApiClient,
  id: string,
  patch: Partial<KnowledgeCollectionInput>,
): Promise<{ id: string }> {
  return api.patch(`/knowledge/collections/${id}`, patch)
}

export async function archiveCollection(api: ApiClient, id: string): Promise<{ id: string }> {
  return api.post(`/knowledge/collections/${id}/archive`)
}

export async function addDocumentToCollection(
  api: ApiClient,
  collectionId: string,
  docId: string,
): Promise<{ id: string }> {
  return api.post(`/knowledge/collections/${collectionId}/members`, {
    targetType: "document",
    targetId: docId,
  })
}

export async function removeDocumentFromCollection(
  api: ApiClient,
  collectionId: string,
  docId: string,
): Promise<{ ok: boolean }> {
  return api.delete(`/knowledge/collections/${collectionId}/members`, {
    targetType: "document",
    targetId: docId,
  })
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function runKnowledgeSearch(
  api: ApiClient,
  params: KnowledgeSearchParams,
): Promise<KnowledgeSearchResult> {
  return api.post("/knowledge/search", params)
}

// ---------------------------------------------------------------------------
// Source links + telemetry
// ---------------------------------------------------------------------------

export interface KnowledgeLinkRemoteBody {
  source: string
  externalId: string
  title: string
  url?: string
  summary?: string
  collectionId?: string
}

export async function linkRemoteDocument(
  api: ApiClient,
  body: KnowledgeLinkRemoteBody,
): Promise<unknown> {
  return api.post("/knowledge/source-links", body)
}

export async function getSourceTelemetry(
  api: ApiClient,
  source: string,
): Promise<KnowledgeSourceTelemetry> {
  return api.get(`/knowledge/sources/${source}`)
}

// ---------------------------------------------------------------------------
// Synced sources (T-8)
// ---------------------------------------------------------------------------

export interface KnowledgeSyncedSource {
  id: string
  appName: string
  folderRef: string
  displayName: string
  rootCollectionId: string
  ownerUserId: string | null
  defaultSensitivity: string | null
  syncIntervalSeconds: number
  lastSyncAt: string | null
  lastSyncStatus: "idle" | "running" | "ok" | "error"
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateSyncedSourceBody {
  appName: string
  folderRef: string
  displayName: string
  syncIntervalSeconds: number
  scope: "personal" | "organization"
  defaultSensitivity?: string | null
}

export async function createSyncedSource(
  api: ApiClient,
  body: CreateSyncedSourceBody,
): Promise<KnowledgeSyncedSource> {
  return api.post("/knowledge/synced-sources", body) as Promise<KnowledgeSyncedSource>
}

export async function runSyncedSourceNow(api: ApiClient, id: string): Promise<unknown> {
  return api.post(`/knowledge/synced-sources/${id}/run-now`, {})
}
