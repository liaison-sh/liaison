// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The local half of a Knowledge search: the org's own documents and source
 * links, read from the shared search index.
 *
 * The query is narrowed to Knowledge's entities IN the engine (app and entity
 * type, on top of the permission filter every search applies). It used to take
 * the top 20 of the WHOLE index and keep the Knowledge hits afterwards, so a
 * word common in mail, messages and contacts (a company's own product name)
 * filled that window with other records and the search reported no document
 * although hundreds matched.
 *
 * Each page then goes through the caller's guard (archived or deleted rows,
 * and the same read check `knowledge_get` runs). When the guard drops hits the
 * next page is read, up to {@link MAX_PAGES}, so a lagging ACL projection costs
 * a page, never the answer. The guard is the only source of what is returned
 * or counted: a hit it drops is never seen by the caller.
 */
import type { KnowledgeActor } from "~/apps/knowledge/service"
import { scopedEntitySearch } from "~/modules/search/service"

export const LOCAL_KNOWLEDGE_ENTITY_TYPES = ["document", "source_link"] as const

/** Hits read from the engine per page. */
export const PAGE_SIZE = 50
/** Pages read at most before answering with what the guard kept. */
export const MAX_PAGES = 4

export interface IndexedKnowledgeHit {
  source: "knowledge"
  sourceEntityId: string
  title: string
  type: string
  sourceRank: number
}

export async function searchLocalKnowledge(args: {
  actor: KnowledgeActor
  q: string
  limit: number
  /** Keep only the hits the reader may open (`dropArchivedKnowledgeHits`). */
  keep: (hits: IndexedKnowledgeHit[]) => Promise<IndexedKnowledgeHit[]>
  /** Test seam: the engine query. */
  search?: typeof scopedEntitySearch
}): Promise<IndexedKnowledgeHit[]> {
  const search = args.search ?? scopedEntitySearch
  const limit = Math.max(args.limit, 1)
  const kept: IndexedKnowledgeHit[] = []
  const seen = new Set<string>()
  for (let page = 0; page < MAX_PAGES && kept.length < limit; page++) {
    const entities = await search({
      orgId: args.actor.orgId,
      userId: args.actor.userId,
      scopes: args.actor.scopes,
      dimensionGrants: args.actor.dimensionGrants,
      roleIds: args.actor.roles ?? [],
      q: args.q,
      app: ["knowledge"],
      entityType: [...LOCAL_KNOWLEDGE_ENTITY_TYPES],
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
    const indexed = entities
      // Defence in depth: the engine filter already narrowed to these.
      .filter(
        (e) =>
          e.app === "knowledge" &&
          (LOCAL_KNOWLEDGE_ENTITY_TYPES as readonly string[]).includes(e.entityType),
      )
      .filter((e) => {
        const key = `${e.entityType}:${e.id}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((e) => ({
        source: "knowledge" as const,
        sourceEntityId: e.id,
        title: e.title ?? e.label,
        type: e.entityType,
        sourceRank: 0,
      }))
    if (indexed.length > 0) kept.push(...(await args.keep(indexed)))
    if (entities.length < PAGE_SIZE) break
  }
  return kept.slice(0, limit).map((h, i) => ({ ...h, sourceRank: i + 1 }))
}
