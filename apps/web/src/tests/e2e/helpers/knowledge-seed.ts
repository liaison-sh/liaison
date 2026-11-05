// SPDX-License-Identifier: FSL-1.1-ALv2
// Per-test fixtures for Knowledge E2E scenarios: documents, collections and
// source links through authenticated worker-token API calls. Drive and GitLab
// connections come from the seed route (./seed.ts, `connections.mock`).

import type { WorkerEnv } from "@liaison/test-helpers"

export interface CreateKnowledgeDocumentInput {
  title: string
  body?: string
  documentScope?: "personal" | "organization"
  sensitivity?: "public" | "internal" | "confidential" | "restricted"
  team?: string[]
  collectionIds?: string[]
  tagNames?: string[]
  /**
   * Sharing-model broad-audience access (Drive-style ACL, migration 0002+).
   * Org docs default to "editor" (org-wide readable); pass "none" to restrict
   * reads to the owner/creator + explicit user/role shares.
   */
  orgAccess?: "none" | "viewer" | "editor"
}

export interface SeededKnowledgeDocument {
  id: string
  revision: number
  title: string
}

export async function createKnowledgeDocument(
  env: WorkerEnv,
  token: string,
  input: CreateKnowledgeDocumentInput,
): Promise<SeededKnowledgeDocument> {
  const res = await fetch(`${env.serverUrl}/api/knowledge/documents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: input.title,
      body: input.body ?? "",
      documentScope: input.documentScope ?? "personal",
      ...(input.sensitivity ? { sensitivity: input.sensitivity } : {}),
      ...(input.orgAccess ? { orgAccess: input.orgAccess } : {}),
      team: input.team,
      collectionIds: input.collectionIds,
      tagNames: input.tagNames,
    }),
  })
  if (res.status !== 201 && res.status !== 200) {
    const text = await res.text().catch(() => "")
    throw new Error(`createKnowledgeDocument failed: HTTP ${res.status} ${text}`)
  }
  const json = (await res.json()) as { data: { id: string; revision: number; title: string } }
  return {
    id: json.data.id,
    revision: json.data.revision,
    title: json.data.title,
  }
}

export async function loadKnowledgeHome(env: WorkerEnv, token: string): Promise<unknown> {
  const res = await fetch(`${env.serverUrl}/api/knowledge/home`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status !== 200) {
    throw new Error(`loadKnowledgeHome failed: HTTP ${res.status}`)
  }
  return res.json()
}

export interface KnowledgeSearchResult {
  hits: Array<{
    source: string
    sourceEntityId: string
    title: string
    type?: string
  }>
  sourceStatuses: Array<{ source: string; state: string }>
}

// ---------------------------------------------------------------------------
// Synced sources — used by the Phase 11.5 sync flow tests.
// ---------------------------------------------------------------------------

export interface CreateSyncedSourceInput {
  appName?: string // defaults to "google-drive"
  folderRef: string // must match the route's Zod regex: [A-Za-z0-9_-]{8,128}
  displayName: string
  syncIntervalSeconds?: number // defaults to 3600
  scope: "personal" | "organization"
  defaultSensitivity?: "public" | "internal" | "confidential" | "restricted"
}

export interface SeededSyncedSource {
  id: string
  rootCollectionId: string
  ownerUserId: string | null
  appName: string
  displayName: string
  lastSyncAt: string | null
  lastSyncStatus: "idle" | "running" | "ok" | "error"
}

/**
 * Create a synced source via the authenticated HTTP API. This exercises the
 * real route — H-5 folder precheck, scope gates, RLS — exactly as the user
 * would experience it. Returns the parsed envelope `data`.
 */
export async function createSyncedSourceViaApi(
  env: WorkerEnv,
  token: string,
  input: CreateSyncedSourceInput,
): Promise<SeededSyncedSource> {
  const body: Record<string, unknown> = {
    appName: input.appName ?? "google-drive",
    folderRef: input.folderRef,
    displayName: input.displayName,
    syncIntervalSeconds: input.syncIntervalSeconds ?? 3600,
    scope: input.scope,
  }
  if (input.scope === "organization") {
    body.defaultSensitivity = input.defaultSensitivity ?? "internal"
  }
  const res = await fetch(`${env.serverUrl}/api/knowledge/synced-sources`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  if (res.status !== 201 && res.status !== 200) {
    const text = await res.text().catch(() => "")
    throw new Error(`createSyncedSourceViaApi failed: HTTP ${res.status} ${text}`)
  }
  const json = (await res.json()) as { data: SeededSyncedSource }
  return json.data
}

/**
 * Drive the worker's reconcile path inline. Tests use this instead of waiting
 * on the BullMQ scheduler tick (which fires once per minute) — the worker
 * function is fully deterministic given the source row + adapter.
 *
 * Backed by the `_test_sync_now` route in `apps/knowledge/routes.ts` which is
 * mounted ONLY under the test-route gate (NODE_ENV=test or ENABLE_QA_SEED_ROUTES)
 * and still goes through the full
 * authz path (`loadSyncedSource` + `assertCanForceSyncedSource`).
 */
export async function reconcileSyncedSourceInline(
  env: WorkerEnv,
  token: string,
  sourceId: string,
): Promise<{
  documentsUpserted?: number
  sourceLinksUpserted?: number
  documentsArchived?: number
  fetchErrors?: Array<{ externalId: string; error: string }>
  paginationCapped?: string[]
  status?: "ok" | "error"
}> {
  const res = await fetch(
    `${env.serverUrl}/api/knowledge/synced-sources/${sourceId}/_test_sync_now`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`reconcileSyncedSourceInline failed: HTTP ${res.status} ${text}`)
  }
  const json = (await res.json()) as {
    data: { reconciled: boolean; stats?: Record<string, unknown> }
  }
  return (json.data.stats ?? {}) as ReturnType<typeof reconcileSyncedSourceInline> extends Promise<
    infer T
  >
    ? T
    : never
}

export async function searchKnowledge(
  env: WorkerEnv,
  token: string,
  query: string,
  limit = 25,
): Promise<KnowledgeSearchResult> {
  const res = await fetch(`${env.serverUrl}/api/knowledge/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, limit }),
  })
  if (res.status !== 200) {
    const text = await res.text().catch(() => "")
    throw new Error(`searchKnowledge failed: HTTP ${res.status} ${text}`)
  }
  const json = (await res.json()) as { data: KnowledgeSearchResult }
  return json.data
}
