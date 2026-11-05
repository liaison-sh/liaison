// SPDX-License-Identifier: FSL-1.1-ALv2

import type {
  CollectionMembershipInput,
  KnowledgeCollectionInput,
  KnowledgeCollectionRow,
} from "~/apps/knowledge/collections"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import { KnowledgeError } from "~/apps/knowledge/service"
import { hasScope } from "~/modules/permissions/permissions"

// Fence externally-authored remote knowledge content (a Drive/Notion/etc. doc
// body the org did not author into local Knowledge) so the agent reads it as
// DATA, not instructions — the same untrusted-content fence web_search/web_fetch
// apply to fetched page text (modules/agent/tools/web-tools.ts `wrapExternalContent`).
// The `untrusted: true` block flag is advisory metadata; this wraps the text
// itself so the boundary survives wherever the block string is rendered.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeSearchParams {
  query: string
  limit?: number
  sources?: string[]
  filters?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Deps interfaces (injected for testability)
// ---------------------------------------------------------------------------

export interface KnowledgeAgentRequestedAttention {
  kind: "knowledge_review"
  reason: "agent_requested"
  orgId: string
  data: {
    query: string
    requestedSources?: string[]
    actorId: string
    agentId?: string
    targetSource?: string
    targetEntityId?: string
  }
}

export interface KnowledgeSearchDeps {
  actor: KnowledgeActor
  orgId: string
  federatedSearch(
    params: KnowledgeSearchParams,
    actor: KnowledgeActor,
  ): Promise<{
    hits: Array<{
      source: string
      sourceEntityId: string
      title: string
      canFetchContent?: boolean
      status?: string
      [k: string]: unknown
    }>
    sourceStatuses: Array<{ source: string; state: string; retryable: boolean }>
    final: boolean
  }>
  /** Present in deps but must NOT be called during search */
  fetchRemoteContent?: (
    input: { source: string; sourceEntityId: string },
    actor: KnowledgeActor,
    purpose?: string,
  ) => Promise<unknown>
  /** Emits an attention item when retrieval would benefit from curator review (e.g. zero authorized hits). */
  emitAttention?: (item: KnowledgeAgentRequestedAttention) => Promise<void> | void
}

// ---------------------------------------------------------------------------
// find_by_title (U5.8) — DB-backed exact-title read, no search index
// ---------------------------------------------------------------------------

export interface KnowledgeFindByTitleParams {
  /** Exact document title to look up (trimmed, case-sensitive). */
  title: string
  /** Include archived documents in the lookup (default false). */
  includeArchived?: boolean
}

export interface KnowledgeFindByTitleResult {
  id: string
  revision: number
  title: string
  archived: boolean
}

export interface KnowledgeFindByTitleDeps {
  actor: KnowledgeActor
  orgId: string
  /** DB-backed exact-title lookup respecting the same read-authorization path as `get`
   *  (loadDocumentShareRole + assertCanReadDocumentRow) — service.ts's `findDocByTitle`. */
  findByTitle(
    title: string,
    actor: KnowledgeActor,
    opts: { includeArchived?: boolean },
  ): Promise<{ id: string; revision: number; title: string; archivedAt: string | null } | null>
}

/**
 * `knowledge_find_by_title` — exact-title existence/id lookup, DB-backed (never rides the Meilisearch
 * index). Built so cross-app callers (e.g. the `calls` connector's callRef→doc resolution) never have to
 * wait out search-indexing lag to discover a document that already exists in Postgres. Returns `null` (not
 * an error) when no match exists — "not found" and "not permitted" are intentionally indistinguishable, the
 * same convention `get`/`findOrgDocByTitle` already use elsewhere in this app.
 */
export async function handleKnowledgeFindByTitle(
  params: KnowledgeFindByTitleParams,
  deps: KnowledgeFindByTitleDeps,
): Promise<{ found: boolean; document: KnowledgeFindByTitleResult | null }> {
  // hasScope, NOT a literal .includes(): the cross-app path (the calls app's callRef→doc
  // resolution) attributes the caller's scopes in WILDCARD form (`knowledge:*`), which a
  // literal membership test rejects — caught live on the U5.8 staging gate (every
  // calls_segments_since 403'd here while knowledge:search, whose enforcement is
  // wildcard-honoring, passed).
  if (!hasScope("knowledge:documents:read", deps.actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", "Missing knowledge:documents:read scope")
  }
  const title = (params.title ?? "").trim()
  if (!title) {
    throw new KnowledgeError("VALIDATION", "title is required and must be non-empty")
  }
  const row = await deps.findByTitle(title, deps.actor, {
    includeArchived: params.includeArchived ?? false,
  })
  if (!row) return { found: false, document: null }
  return {
    found: true,
    document: {
      id: row.id,
      revision: row.revision,
      title: row.title,
      archived: row.archivedAt !== null,
    },
  }
}

// Dedupe agent_requested emissions across calls within a short window.
// Keyed by `${orgId}|${normalizedQuery}` (or `${orgId}|get|${source}|${entityId}` for retrieval).
const AGENT_REQUESTED_DEDUPE_WINDOW_MS = 5 * 60 * 1000
const agentRequestedDedupe = new Map<string, number>()

// E1 — unbounded growth guard. This map has no eviction of its own: every
// distinct (orgId, query) or (orgId, source, entityId) pair that ever misses
// knowledge search adds an entry that lives forever, since a key is only ever
// overwritten (never deleted) once its window is checked again. A high-churn
// deployment (many orgs, many distinct queries) grows this map monotonically.
// Sweep opportunistically whenever the map is touched AND has grown past a
// threshold — cheap in the common case (size check only) and self-limiting
// (a full O(n) scan only when there's actually something to reclaim), rather
// than a background timer that runs even when nothing changed.
const AGENT_REQUESTED_DEDUPE_SWEEP_THRESHOLD = 1024

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ")
}

// Injectable clock so tests can advance time without sleeping.
let _now: () => number = Date.now

/**
 * Remove every entry whose window has already elapsed. Called opportunistically
 * from `shouldEmitAgentRequested` once the map crosses the sweep threshold —
 * never changes the window semantics (an entry within its window is untouched
 * regardless of map size).
 */
function sweepExpiredAgentRequestedEntries(now: number): void {
  for (const [key, ts] of agentRequestedDedupe) {
    if (now - ts >= AGENT_REQUESTED_DEDUPE_WINDOW_MS) {
      agentRequestedDedupe.delete(key)
    }
  }
}

function shouldEmitAgentRequested(key: string): boolean {
  const now = _now()
  if (agentRequestedDedupe.size > AGENT_REQUESTED_DEDUPE_SWEEP_THRESHOLD) {
    sweepExpiredAgentRequestedEntries(now)
  }
  const last = agentRequestedDedupe.get(key)
  if (last && now - last < AGENT_REQUESTED_DEDUPE_WINDOW_MS) return false
  agentRequestedDedupe.set(key, now)
  return true
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * `knowledge_search` — federated search returning candidates and source statuses.
 * Never fetches remote bodies during search.
 */
export async function handleKnowledgeSearch(
  params: KnowledgeSearchParams,
  deps: KnowledgeSearchDeps,
): Promise<{
  hits: Array<Record<string, unknown>>
  sourceStatuses: Array<Record<string, unknown>>
  final: boolean
}> {
  const result = await deps.federatedSearch(
    {
      query: params.query,
      limit: params.limit ?? 10,
      sources: params.sources,
      filters: params.filters ?? {},
    },
    deps.actor,
  )

  // Zero authorized hits — emit agent_requested attention so curators can address gaps.
  if (result.hits.length === 0 && deps.emitAttention) {
    const normalized = normalizeQuery(params.query)
    const dedupeKey = `${deps.orgId}|search|${normalized}`
    if (shouldEmitAgentRequested(dedupeKey)) {
      await deps.emitAttention({
        kind: "knowledge_review",
        reason: "agent_requested",
        orgId: deps.orgId,
        data: {
          query: params.query,
          requestedSources: params.sources,
          actorId: deps.actor.userId,
          agentId: (deps.actor as { agentId?: string }).agentId,
        },
      })
    }
  }

  // Never call fetchRemoteContent during search — return candidates only
  return {
    hits: result.hits as Array<Record<string, unknown>>,
    sourceStatuses: result.sourceStatuses as Array<Record<string, unknown>>,
    final: result.final,
  }
}

// ---------------------------------------------------------------------------
// Create / Update agent tools (B2)
// ---------------------------------------------------------------------------
//
// These handlers wrap the service-layer create/update functions so they can be
// invoked from the sandbox RPC bridge. They take a typed deps shape so the
// bridge can pass a `tx`-bound callable without exposing the RlsClient to the
// sandbox runtime. Remote write-back is explicitly disallowed — agent writes
// can only land in local Knowledge documents (spec §243).

export interface KnowledgeCreateParams {
  documentScope: "personal" | "organization"
  title: string
  summary?: string | null
  body?: string
  team?: string[]
  sensitivity?: string
  ownerUserId?: string
  verifyNow?: boolean
  reviewDueAt?: string | null
}

export interface KnowledgeUpdateParams {
  id: string
  revision: number
  title?: string
  summary?: string | null
  body?: string
  team?: string[]
  sensitivity?: string
  ownerUserId?: string
  verifyNow?: boolean
  reviewDueAt?: string | null
}

export interface KnowledgeWriteDeps {
  actor: KnowledgeActor
  orgId: string
  createDocument(
    input: KnowledgeCreateParams,
    actor: KnowledgeActor,
  ): Promise<Record<string, unknown>>
  updateDocument(
    input: KnowledgeUpdateParams,
    actor: KnowledgeActor,
  ): Promise<Record<string, unknown>>
}

export async function handleKnowledgeCreate(
  params: KnowledgeCreateParams,
  deps: KnowledgeWriteDeps,
): Promise<Record<string, unknown>> {
  return deps.createDocument(params, deps.actor)
}

// ---------------------------------------------------------------------------
// Collection agent tools (T12 / T13)
// ---------------------------------------------------------------------------

const COLLECTIONS_SCOPE = "knowledge:collections:manage"

export interface KnowledgeCollectionCreateParams {
  name: string
  parentCollectionId?: string | null
  description?: string | null
}

export interface KnowledgeCollectionUpdateParams {
  id: string
  name?: string
  parentCollectionId?: string | null
  description?: string | null
}

export interface KnowledgeCollectionDeleteParams {
  id: string
}

export interface KnowledgeCollectionDeps {
  actor: KnowledgeActor
  createCollection?(
    input: KnowledgeCollectionInput,
    actor: KnowledgeActor,
  ): Promise<KnowledgeCollectionRow>
  updateCollection?(
    id: string,
    patch: Partial<KnowledgeCollectionInput>,
    actor: KnowledgeActor,
  ): Promise<KnowledgeCollectionRow>
  archiveCollection?(id: string, actor: KnowledgeActor): Promise<KnowledgeCollectionRow>
}

function requireCollectionsScope(actor: KnowledgeActor): void {
  if (!hasScope(COLLECTIONS_SCOPE, actor.scopes)) {
    throw new KnowledgeError("FORBIDDEN", `Caller lacks ${COLLECTIONS_SCOPE}`)
  }
}

export async function handleKnowledgeCollectionCreate(
  params: KnowledgeCollectionCreateParams,
  deps: KnowledgeCollectionDeps,
): Promise<KnowledgeCollectionRow> {
  requireCollectionsScope(deps.actor)
  if (!deps.createCollection) {
    throw new KnowledgeError("SOURCE_UNAVAILABLE", "createCollection dep missing")
  }
  return deps.createCollection(
    {
      name: params.name,
      parentCollectionId: params.parentCollectionId ?? null,
      description: params.description ?? null,
    },
    deps.actor,
  )
}

export async function handleKnowledgeCollectionUpdate(
  params: KnowledgeCollectionUpdateParams,
  deps: KnowledgeCollectionDeps,
): Promise<KnowledgeCollectionRow> {
  requireCollectionsScope(deps.actor)
  if (!deps.updateCollection) {
    throw new KnowledgeError("SOURCE_UNAVAILABLE", "updateCollection dep missing")
  }
  const patch: Partial<KnowledgeCollectionInput> = {}
  if (params.name !== undefined) patch.name = params.name
  if (params.parentCollectionId !== undefined) patch.parentCollectionId = params.parentCollectionId
  if (params.description !== undefined) patch.description = params.description
  return deps.updateCollection(params.id, patch, deps.actor)
}

export async function handleKnowledgeCollectionDelete(
  params: KnowledgeCollectionDeleteParams,
  deps: KnowledgeCollectionDeps,
): Promise<KnowledgeCollectionRow> {
  requireCollectionsScope(deps.actor)
  if (!deps.archiveCollection) {
    throw new KnowledgeError("SOURCE_UNAVAILABLE", "archiveCollection dep missing")
  }
  return deps.archiveCollection(params.id, deps.actor)
}

export interface KnowledgeAddToCollectionParams {
  collectionId: string
  documentId: string
}

export interface KnowledgeRemoveFromCollectionParams {
  collectionId: string
  documentId: string
}

export interface KnowledgeCollectionMembershipDeps {
  actor: KnowledgeActor
  addMembership?(input: CollectionMembershipInput, actor: KnowledgeActor): Promise<{ id: string }>
  removeMembership?(input: CollectionMembershipInput, actor: KnowledgeActor): Promise<void>
}

export async function handleKnowledgeAddToCollection(
  params: KnowledgeAddToCollectionParams,
  deps: KnowledgeCollectionMembershipDeps,
): Promise<{ id: string }> {
  requireCollectionsScope(deps.actor)
  if (!deps.addMembership) {
    throw new KnowledgeError("SOURCE_UNAVAILABLE", "addMembership dep missing")
  }
  return deps.addMembership(
    {
      collectionId: params.collectionId,
      targetType: "document",
      targetId: params.documentId,
    },
    deps.actor,
  )
}

export async function handleKnowledgeRemoveFromCollection(
  params: KnowledgeRemoveFromCollectionParams,
  deps: KnowledgeCollectionMembershipDeps,
): Promise<{ ok: true }> {
  requireCollectionsScope(deps.actor)
  if (!deps.removeMembership) {
    throw new KnowledgeError("SOURCE_UNAVAILABLE", "removeMembership dep missing")
  }
  await deps.removeMembership(
    {
      collectionId: params.collectionId,
      targetType: "document",
      targetId: params.documentId,
    },
    deps.actor,
  )
  return { ok: true }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const KnowledgeAgentToolsTestAccess = {
  /** Test-only — override the clock used for dedupe windows. */
  setClock(fn: (() => number) | null): void {
    _now = fn ?? Date.now
  },
  /** Test-only — force a sweep regardless of the size threshold. */
  sweepDedupe(): void {
    sweepExpiredAgentRequestedEntries(_now())
  },
  /** Test-only — current map size, to assert the sweep bounds growth. */
  dedupeSize(): number {
    return agentRequestedDedupe.size
  },
  /** Test-only — reset dedupe state between test cases. */
  resetDedupe(): void {
    agentRequestedDedupe.clear()
  },
}
