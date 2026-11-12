// SPDX-License-Identifier: FSL-1.1-ALv2

import type { KnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import { createKnowledgeSourceRegistry } from "~/apps/knowledge/federated-search"
import type { KnowledgeSearchHit, KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { knowledgeItemsRegistry } from "~/modules/apps/app-registries"
import { isAppUnavailableFor, primeOrgApps } from "~/modules/apps/org-apps"
import { CapLimitError } from "~/modules/org/caps"
import { hasScope } from "~/modules/permissions/permissions"

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined
/** Only an http(s) URL from an app reaches a stored link or a hit ("Open original"). */
const safeUrl = (v: unknown): string | undefined => {
  const s = str(v)
  return s && /^https?:\/\//i.test(s) ? s : undefined
}

/** One item an app's `resolve` export answered with; null: not visible to this person. */
export interface ResolvedItem {
  title?: string
  url?: string
  modifiedAt?: string
  text?: string
}

/**
 * Parse a `resolve` answer: `{ found: false }` (or nothing) is "not visible";
 * otherwise `{ title, url, modifiedAt, text }`, each checked. A malformed
 * answer is an error, not an invisible item: a link is never marked stale
 * because an app broke its contract.
 */
export function parseResolved(raw: unknown): ResolvedItem | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) throw new Error("knowledgeItems.resolve must answer an object")
  if (raw.error !== undefined) {
    const e = isObject(raw.error) ? raw.error : {}
    throw new Error(`resolve failed: ${str(e.code) ?? "error"} ${str(e.message) ?? ""}`.trim())
  }
  if (raw.found === false) return null
  const title = str(raw.title)
  const url = safeUrl(raw.url)
  const modifiedAt = str(raw.modifiedAt)
  const text = typeof raw.text === "string" ? raw.text : undefined
  return {
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
    ...(text !== undefined ? { text } : {}),
  }
}

/** Parse a `search` answer (the external search contract) into Knowledge hits. */
export function parseSearchAnswer(
  app: string,
  raw: unknown,
): { hits: KnowledgeSearchHit[]; cursor?: string } {
  if (!isObject(raw) || !Array.isArray(raw.results)) return { hits: [] }
  const hits: KnowledgeSearchHit[] = []
  raw.results.forEach((r, i) => {
    if (!isObject(r)) return
    const id = str(r.id)
    if (!id) return
    const attributes = isObject(r.attributes) ? r.attributes : {}
    const url = safeUrl(r.url ?? attributes.url)
    const snippet = str(r.snippet)
    const modifiedAt = str(r.modifiedAt ?? attributes.modifiedAt)
    hits.push({
      source: app,
      sourceEntityId: id,
      title: str(r.title) ?? id,
      type: str(r.entity) ?? "item",
      sourceRank: i + 1,
      ...(url ? { url } : {}),
      ...(snippet ? { snippet } : {}),
      ...(modifiedAt ? { modifiedAt } : {}),
    })
  })
  const cursor = str(raw.nextCursor)
  return { hits, ...(cursor ? { cursor } : {}) }
}

/**
 * The knowledge sources a person reaches: one adapter per installed app that
 * declares `knowledgeItems` (manifest), when the app is available to them and
 * they hold its `readScope`. The adapter wakes the app's exports for them:
 * `search` serves federated search (when the org's policy for the app, else the
 * app's `searchByDefault`, allows it), `resolve` serves source links (create,
 * verify, refresh) and remote reads. Nothing here holds a transaction: callers
 * run these adapters outside one.
 *
 * `searchPolicy`: the org's `broadSearchEnabled` per source (sources.ts
 * `loadSearchPolicies`); a source with no row follows the app's default.
 */
export async function registerDefaultKnowledgeSources(input: {
  orgId: string
  userId: string
  /** The caller's effective scopes: an app's `readScope` gates its adapter. */
  scopes: readonly string[]
  searchPolicy?: ReadonlyMap<string, boolean>
}): Promise<KnowledgeSourceRegistry> {
  const { orgId, userId, scopes } = input
  const registry = createKnowledgeSourceRegistry()
  await primeOrgApps(orgId)
  for (const [key, entry] of knowledgeItemsRegistry.entriesOf(orgId)) {
    const app = key[1]
    if (key[0] !== orgId || !app) continue
    const { decl, dispatch } = entry
    if (decl.readScope && !hasScope(decl.readScope, [...scopes])) continue
    if (isAppUnavailableFor(orgId, app, userId)) continue
    const tenant = { orgId, userId }
    const searchOn = input.searchPolicy?.get(app) ?? decl.searchByDefault
    const adapter: KnowledgeSourceAdapter = { source: app }
    if (decl.search && searchOn) {
      adapter.searchRemote = async (search) => {
        const started = Date.now()
        let raw: unknown
        try {
          raw = await dispatch(
            "search",
            { query: search.query, limit: search.limit, cursor: search.cursors?.[app] ?? null },
            tenant,
          )
        } catch (err) {
          // The org reached an app day cap: no hits, said as such.
          if (err instanceof CapLimitError) {
            return {
              hits: [],
              status: { source: app, state: "rate-limited", retryable: true, hitCount: 0 },
            }
          }
          throw err
        }
        const { hits, cursor } = parseSearchAnswer(app, raw)
        return {
          hits,
          status: {
            source: app,
            state: "complete",
            retryable: false,
            hitCount: hits.length,
            durationMs: Date.now() - started,
            ...(cursor ? { cursor } : {}),
          },
        }
      }
    }
    if (decl.resolve) {
      const resolve = async (ref: string, content: boolean) =>
        parseResolved(await dispatch("resolve", { ref, content }, tenant))
      adapter.getRemoteMetadata = async ({ sourceEntityId }) => {
        const item = await resolve(sourceEntityId, false)
        if (!item) return null
        const { text: _text, ...meta } = item
        return meta
      }
      adapter.fetchRemoteContent = async ({ sourceEntityId }) => {
        const item = await resolve(sourceEntityId, true)
        if (!item) return { status: "not_found" }
        return { status: "available", ...item }
      }
    }
    registry.register(adapter)
  }
  return registry
}
