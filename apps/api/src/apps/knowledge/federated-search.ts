// SPDX-License-Identifier: FSL-1.1-ALv2

import type { KnowledgeActor } from "~/apps/knowledge/service"
import type {
  KnowledgeSearchHit,
  KnowledgeSearchInput,
  KnowledgeSourceAdapter,
  KnowledgeSourceSearchResult,
  KnowledgeSourceState,
  KnowledgeSourceStatus,
} from "~/apps/knowledge/source-protocol"
import { boundedBy } from "~/lib/bounded"
import { knowledgeLogger } from "~/lib/logger"

export type {
  KnowledgeSearchHit,
  KnowledgeSearchInput,
  KnowledgeSourceAdapter,
  KnowledgeSourceSearchResult,
  KnowledgeSourceStatus,
} from "~/apps/knowledge/source-protocol"

export interface KnowledgeSourceRegistry {
  register(adapter: KnowledgeSourceAdapter): void
  clearForTest(): void
  listEnabled(actor: KnowledgeActor, filters?: Record<string, unknown>): KnowledgeSourceAdapter[]
}

export interface FederatedKnowledgeSearchDeps {
  actor: KnowledgeActor
  registry: KnowledgeSourceRegistry
  localSearch(
    input: KnowledgeSearchInput,
    actor: KnowledgeActor,
  ): Promise<KnowledgeSourceSearchResult>
  timeoutMs?: number
}

export interface FederatedKnowledgeSearchResult {
  hits: KnowledgeSearchHit[]
  sourceStatuses: KnowledgeSourceStatus[]
  cursors: Record<string, string>
  duplicates: Array<{ kept: string; removed: string; key: string }>
  final: true
}

const RRF_K = 60

/**
 * State-derived user-facing message for non-`complete` source statuses. The
 * wire layer (route handler + sandbox bridge) replaces any adapter-supplied
 * `message` with this scrubbed value to prevent leaks of bearer tokens, host
 * names, or tenant identifiers in error strings (BS-6).
 */
export function sourceFriendlyMessage(state: KnowledgeSourceState): string {
  switch (state) {
    case "skipped":
      return "Remote search skipped"
    case "loading":
      return "Source is loading"
    case "complete":
      return "Source returned results"
    case "partial":
      return "Source returned partial results"
    case "unavailable":
      return "Source is temporarily unavailable"
    case "unauthorized":
      return "Source requires re-authorization"
    case "rate-limited":
      return "Source is rate-limited; try again shortly"
    case "error":
      return "Source search failed"
    default:
      return "Source unavailable"
  }
}

/**
 * Scrub adapter-supplied `message` strings on every non-`complete` source
 * status — only the `complete` state is allowed to carry an adapter message.
 * Routes call this before returning to ensure no error pathway can ever leak
 * bearer tokens, internal host names, or tenant identifiers on the wire.
 */
export function scrubSourceStatuses(statuses: KnowledgeSourceStatus[]): KnowledgeSourceStatus[] {
  return statuses.map((status) =>
    status.state === "complete"
      ? status
      : { ...status, message: sourceFriendlyMessage(status.state) },
  )
}

/**
 * Tag each local document hit with the connector that mirrors it, when it is
 * sourced from an external synced source. `appByDocId` maps a document id to
 * the owning synced source's app name (e.g. "gitlab"). Only `type:"document"`
 * hits are eligible — `source_link` and remote hits pass through untouched.
 * Pure (no IO) so callers can unit-test the projection independently of Meili.
 */
export function attachSyncedSourceApp(
  hits: KnowledgeSearchHit[],
  appByDocId: Map<string, string>,
): KnowledgeSearchHit[] {
  if (appByDocId.size === 0) return hits
  return hits.map((hit) => {
    if (hit.type !== "document") return hit
    const app = appByDocId.get(hit.sourceEntityId)
    return app ? { ...hit, syncedSourceApp: app } : hit
  })
}

export function createKnowledgeSourceRegistry(): KnowledgeSourceRegistry {
  const adapters = new Map<string, KnowledgeSourceAdapter>()
  return {
    register(adapter) {
      adapters.set(adapter.source, adapter)
    },
    clearForTest() {
      adapters.clear()
    },
    listEnabled(_actor, filters = {}) {
      const selected = Array.isArray(filters.sources)
        ? new Set(filters.sources.filter((source): source is string => typeof source === "string"))
        : null
      return Array.from(adapters.values()).filter(
        (adapter) => !selected || selected.has(adapter.source),
      )
    },
  }
}

function nowMs(): number {
  return Date.now()
}

function isRateLimitError(error: unknown): boolean {
  const err = error as { code?: unknown; status?: unknown; message?: unknown }
  return err.code === "RATE_LIMITED" || err.code === "RATE_LIMIT" || err.status === 429
}

function errorStatus(source: string, error: unknown, durationMs: number): KnowledgeSourceStatus {
  const state: KnowledgeSourceState = isRateLimitError(error) ? "rate-limited" : "error"
  return {
    source,
    state,
    retryable: true,
    message: error instanceof Error ? error.message : "Source search failed",
    durationMs,
    hitCount: 0,
  }
}

async function runSource(
  source: string,
  fn: () => Promise<KnowledgeSourceSearchResult>,
  timeoutMs: number,
): Promise<KnowledgeSourceSearchResult> {
  const start = nowMs()
  try {
    const result = await boundedBy(fn(), timeoutMs, () => new Error(`${source} timed out`))
    const durationMs = nowMs() - start
    return {
      hits: result.hits.slice(),
      status: {
        ...result.status,
        source: result.status.source ?? source,
        durationMs: result.status.durationMs ?? durationMs,
        hitCount: result.status.hitCount ?? result.hits.length,
      },
    }
  } catch (error) {
    return { hits: [], status: errorStatus(source, error, nowMs() - start) }
  }
}

function hitPrimaryId(hit: KnowledgeSearchHit): string {
  return `${hit.source}:${hit.sourceEntityId}`
}

function duplicateKey(hit: KnowledgeSearchHit): string {
  return hit.duplicateKeys?.find(Boolean) ?? `${hit.source}:${hit.sourceEntityId}`
}

function mergeBadges(a: KnowledgeSearchHit, b: KnowledgeSearchHit): string[] {
  return Array.from(new Set([...(a.badges ?? []), a.source, ...(b.badges ?? []), b.source]))
}

function sourceRank(hit: KnowledgeSearchHit, index: number): number {
  return hit.sourceRank && hit.sourceRank > 0 ? hit.sourceRank : index + 1
}

function fuseHits(
  sourceResults: KnowledgeSourceSearchResult[],
  limit: number,
): {
  hits: KnowledgeSearchHit[]
  duplicates: Array<{ kept: string; removed: string; key: string }>
} {
  const scores = new Map<string, number>()
  const byDuplicate = new Map<string, KnowledgeSearchHit>()
  const duplicates: Array<{ kept: string; removed: string; key: string }> = []

  for (const result of sourceResults) {
    result.hits.forEach((hit, index) => {
      const score = 1 / (RRF_K + sourceRank(hit, index))
      const key = duplicateKey(hit)
      const existing = byDuplicate.get(key)
      if (!existing) {
        const next = { ...hit, badges: Array.from(new Set([...(hit.badges ?? []), hit.source])) }
        byDuplicate.set(key, next)
        scores.set(hitPrimaryId(next), score)
        return
      }

      const existingId = hitPrimaryId(existing)
      scores.set(existingId, (scores.get(existingId) ?? 0) + score)
      existing.badges = mergeBadges(existing, hit)
      existing.canFetchContent = existing.canFetchContent || hit.canFetchContent
      existing.status = existing.status ?? hit.status
      duplicates.push({ kept: existingId, removed: hitPrimaryId(hit), key })
    })
  }

  return {
    hits: Array.from(byDuplicate.values())
      .map((hit) => ({ ...hit, fusedRank: scores.get(hitPrimaryId(hit)) ?? 0 }))
      .sort((a, b) => {
        const scoreDiff = (b.fusedRank ?? 0) - (a.fusedRank ?? 0)
        if (scoreDiff !== 0) return scoreDiff
        const titleDiff = a.title.localeCompare(b.title)
        if (titleDiff !== 0) return titleDiff
        return hitPrimaryId(a).localeCompare(hitPrimaryId(b))
      })
      .slice(0, limit),
    duplicates,
  }
}

export async function federatedKnowledgeSearch(
  input: KnowledgeSearchInput,
  deps: FederatedKnowledgeSearchDeps,
): Promise<FederatedKnowledgeSearchResult> {
  const query = input.query.trim()
  const limit = Math.min(Math.max(input.limit, 1), 50)
  const request: KnowledgeSearchInput = {
    ...input,
    query,
    limit,
    cursors: input.cursors ?? {},
    filters: input.filters ?? {},
  }
  const remoteAdapters = deps.registry
    .listEnabled(deps.actor, request.filters)
    .flatMap((adapter) => {
      const search = adapter.searchRemote
      return search ? [{ source: adapter.source, search: search.bind(adapter) }] : []
    })

  if (!query) {
    const skipped = remoteAdapters.map((adapter) => ({
      source: adapter.source,
      state: "skipped" as const,
      retryable: false,
      message: "Remote search skipped for empty query",
      hitCount: 0,
    }))
    return { hits: [], sourceStatuses: skipped, cursors: {}, duplicates: [], final: true }
  }

  const timeoutMs = deps.timeoutMs ?? 5_000
  const sourceResults = await Promise.all([
    runSource("knowledge", () => deps.localSearch(request, deps.actor), timeoutMs),
    ...remoteAdapters.map((adapter) =>
      runSource(adapter.source, () => adapter.search(request, deps.actor), timeoutMs),
    ),
  ])
  // Observability — per-source latency/status. Query and body content are
  // intentionally omitted to keep logs free of user data.
  for (const result of sourceResults) {
    knowledgeLogger.info(
      {
        orgId: deps.actor.orgId,
        source: result.status.source,
        state: result.status.state,
        durationMs: result.status.durationMs ?? 0,
        hitCount: result.status.hitCount ?? result.hits.length,
      },
      "federated_search_source",
    )
  }
  const { hits, duplicates } = fuseHits(sourceResults, limit)
  const cursors: Record<string, string> = {}
  for (const result of sourceResults) {
    if (result.status.cursor) cursors[result.status.source] = result.status.cursor
  }
  return {
    hits,
    sourceStatuses: sourceResults.map((result) => result.status),
    cursors,
    duplicates,
    final: true,
  }
}
