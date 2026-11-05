// SPDX-License-Identifier: FSL-1.1-ALv2
// P4c-T48: a hybrid search finds every wording of one fact, so a top five is
// one fact five times unless the near duplicates are collapsed.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  clusterByCosine,
  DEFAULT_NEAR_DUPLICATE_THRESHOLD,
  processNearDuplicateJob,
} from "~/infra/jobs/near-duplicate-clusters"
import * as searchClientModule from "~/infra/search/client"
import { memorySearch } from "~/modules/agent/memory/memory-search"
import {
  type Embedder,
  MessageIndexerTestAccess,
  processMessageIndexerJob,
} from "~/modules/search/message-indexer"

const ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const INDEX_NAME = `test_p4ct48nd_${crypto.randomUUID().slice(0, 8)}`
const THREADS_READ = "kernel:threads:read"

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/**
 * ONE FACT, SIX WAYS. Every one of these says the courier account number, and
 * no two of them share the same words, which is exactly the shape a hybrid
 * search is good at finding all of.
 */
const COPIES = [
  "The DHL account number is 4711.",
  "Our courier account is numbered 4711.",
  "For the carrier, use account 4711.",
  "Shipping account: 4711.",
  "The parcel account reference is 4711.",
  "Remember, 4711 is the shipment account.",
]
const COPY_IDS: string[] = COPIES.map(() => crypto.randomUUID())

/** A message about something else entirely, which must survive on its own. */
const OTHER_ID = crypto.randomUUID()
const OTHER = "The sturgeon quota for the season is forty."

const CONCEPT = ["dhl", "courier", "carrier", "parcel", "shipping", "shipment", "account", "4711"]

/**
 * Two dimensions: how much of the fact a text carries, and how much of
 * anything else. Every wording of the fact lands within the threshold of every
 * other; the sturgeon message lands nowhere near it.
 */
const DIMENSIONS = 2
function fakeVector(text: string): number[] {
  const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  const hits = CONCEPT.filter((c) => words.has(c)).length
  return hits > 0 ? [1, 0.02 * hits] : [0, 1]
}

const fakeEmbedder: Embedder = {
  modelId: "fake-embedding-001",
  dimensions: DIMENSIONS,
  async embed(texts: string[]) {
    return { vectors: texts.map(fakeVector), tokens: texts.length }
  },
}

const spies: Array<{ mockRestore: () => void }> = []

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function search(query: string) {
  return withRlsContext(actor, (tx) =>
    memorySearch({ query }, { userId: USER_ID, orgId: ORG_ID, db: tx, scopes: [] } as never),
  )
}

describe("clusterByCosine", () => {
  it("keeps the threshold at 0.95", () => {
    expect(DEFAULT_NEAR_DUPLICATE_THRESHOLD).toBe(0.95)
  })

  it("names the first member of a cluster as its canonical id", () => {
    const out = clusterByCosine([
      { entityType: "message", entityId: "a", vector: [1, 0] },
      { entityType: "message", entityId: "b", vector: [0.999, 0.02] },
      { entityType: "message", entityId: "c", vector: [0, 1] },
    ])
    expect(out.find((o) => o.entityId === "b")?.canonicalId).toBe("a")
    expect(out.find((o) => o.entityId === "c")?.canonicalId).toBe("c")
  })

  it("leaves two documents that merely share a topic apart", () => {
    const out = clusterByCosine([
      { entityType: "message", entityId: "a", vector: [1, 0] },
      { entityType: "message", entityId: "b", vector: [0.7, 0.7] },
    ])
    expect(out.find((o) => o.entityId === "b")?.canonicalId).toBe("b")
  })
})

describe("near duplicates, end to end", () => {
  beforeAll(async () => {
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    MessageIndexerTestAccess.setEmbedderFactory(async () => fakeEmbedder)

    const { expectedSettings } = await import("~/modules/search/drift")
    const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)
    const applied = await meili
      .index(INDEX_NAME)
      .updateSettings(
        expectedSettings({ registeredReadScopes: [THREADS_READ], dimensionFields: [] }),
      )
    await meili.tasks.waitForTask(applied.taskUid)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'DedupeOrg', ${`dedupe-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_ID}, ${ORG_ID}, ${`dedupe-${tag}@test.com`}, 'Dedupe', 'x')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`dedupe${tag}`}, ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`

    const rows = [
      ...COPIES.map((content, i) => ({
        id: COPY_IDS[i] as string,
        content,
        createdAt: new Date(Date.UTC(2026, 2, 2 + i, 9, 0, 0)).toISOString(),
      })),
      {
        id: OTHER_ID,
        content: OTHER,
        createdAt: new Date(Date.UTC(2026, 2, 9, 9, 0, 0)).toISOString(),
      },
    ]
    for (const r of rows) {
      await sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, required_scopes, created_at)
        VALUES (${r.id}, ${ORG_ID}, ${THREAD_ID}, ${USER_ID}, 'user', ${r.content}, '{}'::text[], ${r.createdAt})`
      await processMessageIndexerJob({ action: "upsert", orgId: ORG_ID, messageId: r.id })
    }
  })

  afterAll(async () => {
    MessageIndexerTestAccess.setEmbedderFactory(null)
    MessageIndexerTestAccess.resetEmbedderCache()
    for (const s of spies) s.mockRestore()
    try {
      await meili.deleteIndex(INDEX_NAME)
    } catch {
      /* the index is a test artifact */
    }
    await sql`DELETE FROM kernel.search_document_clusters WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("six reworded copies of one fact collapse to one hit with the others listed", async () => {
    // Before the clusterer has run, the search returns the copies as separate
    // hits: nothing yet knows they are one fact.
    const before = await search("what is the courier account number")
    const copiesBefore = before.hits.filter((h) => COPY_IDS.includes(h.messageId ?? ""))
    expect(copiesBefore.length).toBeGreaterThan(1)

    const result = await processNearDuplicateJob({ orgId: ORG_ID })
    expect(result.collapsed).toBeGreaterThanOrEqual(5)

    const after = await search("what is the courier account number")
    const copyHits = after.hits.filter((h) => COPY_IDS.includes(h.messageId ?? ""))
    expect(copyHits).toHaveLength(1)

    // The newest saying of the fact is the one kept: it is the one still true.
    const kept = copyHits[0]
    expect(kept?.messageId).toBe(COPY_IDS[COPIES.length - 1] as string)
    // And the other five are LISTED, so memory_open can still reach them.
    const listed = new Set(kept?.clusterMessageIds ?? [])
    for (const id of COPY_IDS.slice(0, COPIES.length - 1)) expect(listed.has(id)).toBe(true)
  })

  it("writes the canonical id in postgres, and never partially updates the index", async () => {
    const rows = await sql`SELECT entity_id, canonical_id FROM kernel.search_document_clusters
      WHERE org_id = ${ORG_ID} AND entity_type = 'message'`
    const byId = new Map(rows.map((r) => [r.entity_id as string, r.canonical_id as string]))
    // Every copy points at the first one; the sturgeon message is its own.
    for (const id of COPY_IDS) expect(byId.get(id)).toBe(COPY_IDS[0] as string)
    expect(byId.get(OTHER_ID)).toBe(OTHER_ID)

    const hit = await meili.index(INDEX_NAME).search("sturgeon quota", {
      filter: `org_id = "${ORG_ID}" AND entity_type = "message"`,
      limit: 1,
    })
    // Read from Postgres by memory search; a partial Meili update of a document
    // deleted meanwhile would create a stub without `_vectors`.
    expect(hit.hits[0]).toBeDefined()
    expect((hit.hits[0] as { canonical_id?: string })?.canonical_id).toBeUndefined()
  })
})
