// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T48: the near-duplicate clusterer.
//
// THE PROBLEM THE VECTOR LEG CREATES. A hybrid search is good at finding every
// wording of one fact, which is exactly what makes a top five degenerate into
// one fact said five times. So the documents whose vectors sit within a cosine
// threshold of each other are grouped, offline, into a CLUSTER with one
// canonical id, and the read path keeps one hit per cluster.
//
// NOT A DELETE. Nothing is removed from the index or the database: the other
// members are listed on the surviving hit so `memory_open` can reach them. A
// clustering mistake costs a hit its neighbours in one search, never a message.
//
// OFFLINE, because it is quadratic in the documents it compares. It runs as a
// job over one org at a time and writes its answer down; the read path only
// ever reads the answer.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { effectiveIndexName, ensureMeiliVectorStore, getMeili } from "~/infra/search/client"
import { searchLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { cosine } from "~/modules/agent/memory/rrf"
import { MEMORY_EMBEDDER_NAME } from "~/modules/search/message-indexer"

const QUEUE_APP = "kernel"
export const NEAR_DUPLICATE_JOB = "search-near-duplicate-clusters"

/**
 * The cosine at or above which two documents are the same fact told twice.
 * 0.95 is deliberately high: collapsing two things that merely share a topic
 * costs the agent a fact, and the cheaper mistake is to leave a duplicate in.
 */
export const DEFAULT_NEAR_DUPLICATE_THRESHOLD = 0.95

/** How many documents one pass compares. Quadratic, so it is bounded. */
const MAX_DOCUMENTS = 2000

export interface NearDuplicateJobPayload {
  orgId: string
  threshold?: number
}

interface ClusterableDoc {
  entityType: string
  entityId: string
  vector: number[]
}

export interface ClusterAssignment {
  entityType: string
  entityId: string
  canonicalId: string
}

/**
 * Single link clustering at `threshold`, in the order the documents were given.
 * Pure, so the threshold's effect is testable without an index behind it.
 *
 * The FIRST document of a cluster is its canonical id, and the documents arrive
 * oldest first, so a cluster's canonical id is the first time the fact was
 * said. Which member the READ path keeps is a different question, answered
 * there: it wants the newest, or the one inside the window.
 */
export function clusterByCosine(
  docs: ClusterableDoc[],
  threshold: number = DEFAULT_NEAR_DUPLICATE_THRESHOLD,
): ClusterAssignment[] {
  const canonicalOf = new Map<string, string>()
  const representatives: ClusterableDoc[] = []
  for (const doc of docs) {
    let canonical: string | null = null
    for (const rep of representatives) {
      if (cosine(doc.vector, rep.vector) >= threshold) {
        canonical = canonicalOf.get(`${rep.entityType}:${rep.entityId}`) ?? rep.entityId
        break
      }
    }
    if (!canonical) {
      canonical = doc.entityId
      representatives.push(doc)
    }
    canonicalOf.set(`${doc.entityType}:${doc.entityId}`, canonical)
  }
  return docs.map((d) => ({
    entityType: d.entityType,
    entityId: d.entityId,
    canonicalId: canonicalOf.get(`${d.entityType}:${d.entityId}`) as string,
  }))
}

/** The org's threshold setting, or the default. */
async function resolveThreshold(orgId: string): Promise<number> {
  try {
    const [{ getOrgKernelSettings }, { orgKernelSettingsSchema }] = await Promise.all([
      import("~/lib/settings"),
      import("@liaison/shared"),
    ])
    const settings = await withPrivilegedDb(orgId, "near-duplicates:org-settings", (tx) =>
      getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
    )
    const value = (settings.ai as { nearDuplicateThreshold?: number | null } | undefined)
      ?.nearDuplicateThreshold
    if (typeof value === "number" && value > 0 && value <= 1) return value
  } catch (err) {
    log.warn({ err, orgId }, "Could not read the near-duplicate threshold; using the default")
  }
  return DEFAULT_NEAR_DUPLICATE_THRESHOLD
}

/** Every document of this org that has a vector, oldest first. */
async function readVectoredDocuments(orgId: string): Promise<ClusterableDoc[]> {
  await ensureMeiliVectorStore()
  const result = await getMeili()
    .index(effectiveIndexName())
    .search("", {
      filter: `org_id = "${orgId}" AND app = "kernel" AND entity_type IN ["message", "message_window", "brief_row", "episode"]`,
      limit: MAX_DOCUMENTS,
      sort: ["created_at:asc"],
      retrieveVectors: true,
    })
  const hits = (result as { hits?: Array<Record<string, unknown>> }).hits ?? []
  const docs: ClusterableDoc[] = []
  for (const hit of hits) {
    const raw = (hit._vectors as Record<string, unknown> | undefined)?.[MEMORY_EMBEDDER_NAME]
    const embeddings = Array.isArray(raw)
      ? raw
      : ((raw as { embeddings?: unknown } | undefined)?.embeddings ?? null)
    const vector = Array.isArray(embeddings)
      ? ((Array.isArray(embeddings[0]) ? embeddings[0] : embeddings) as number[])
      : null
    const entityId = typeof hit.entity_id === "string" ? hit.entity_id : null
    const entityType = typeof hit.entity_type === "string" ? hit.entity_type : null
    // A document with no vector yet (the backfill has not reached it) is not
    // clusterable and is simply left in a cluster of its own.
    if (!vector || !entityId || !entityType) continue
    docs.push({ entityType, entityId, vector })
  }
  return docs
}

async function persistClusters(orgId: string, assignments: ClusterAssignment[]): Promise<void> {
  if (assignments.length === 0) return
  const qualified = sql.raw(
    `${quoteIdent(schemaRef("kernel"))}.${quoteIdent("search_document_clusters")}`,
  )
  await withPrivilegedDb(orgId, "near-duplicates:persist", async (tx) => {
    for (const a of assignments) {
      await tx.execute(
        sql`INSERT INTO ${qualified} (org_id, entity_type, entity_id, canonical_id, updated_at)
            VALUES (${orgId}, ${a.entityType}, ${a.entityId}, ${a.canonicalId}, now())
            ON CONFLICT (org_id, entity_type, entity_id)
            DO UPDATE SET canonical_id = EXCLUDED.canonical_id, updated_at = now()`,
      )
    }
  })
}

export interface NearDuplicateResult {
  documents: number
  clusters: number
  collapsed: number
}

export async function processNearDuplicateJob(
  payload: NearDuplicateJobPayload,
): Promise<NearDuplicateResult> {
  const { orgId } = payload
  const threshold = payload.threshold ?? (await resolveThreshold(orgId))
  const docs = await readVectoredDocuments(orgId)
  const assignments = clusterByCosine(docs, threshold)
  // The clusters live in Postgres only: memory search reads them from there
  // (`search_document_clusters`). They used to be copied into the index too, as
  // a partial `updateDocuments` of up to 2,000 documents that nothing read, and
  // a partial update of a document deleted meanwhile CREATES a stub without
  // `_vectors`, which fails the whole Meili batch it lands in.
  await persistClusters(orgId, assignments)

  const clusters = new Set(assignments.map((a) => a.canonicalId)).size
  const result = {
    documents: assignments.length,
    clusters,
    collapsed: assignments.length - clusters,
  }
  log.info({ orgId, threshold, ...result }, "near_duplicate_clusters")
  return result
}

export function registerNearDuplicateWorker(): void {
  registerJobWorker(QUEUE_APP, NEAR_DUPLICATE_JOB, async (payload: NearDuplicateJobPayload) => {
    await processNearDuplicateJob(payload)
  })
}
