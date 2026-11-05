// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Archived Knowledge documents must never be searchable.
 *
 * Live QA (2026-09-23): ~30 documents archived on 2026-07-27 still came back
 * from `knowledge.search`, and opening one returned `not_found`. The archive
 * event deletes the Meili document, but nothing else knew a row with
 * `archived_at` set is ineligible: the full reindex (`liaison search reindex`,
 * and the boot-time drift reindex) streamed EVERY row back into the index, and
 * any later upsert event on an archived row re-added it. These tests pin the
 * three layers: the indexer upsert, the full reindex (which also has to prune
 * what is already there, the cleanup path for existing deployments), and the
 * search-time filter that drops a stale hit even when the index lags.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import { sql } from "drizzle-orm"
import manifest from "~/apps/knowledge/app.manifest.json"
import { dropArchivedKnowledgeHits } from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import * as searchClientModule from "~/infra/search/client"
import { entityRegistry } from "~/modules/apps/app-registries"
import { documentId } from "~/modules/search/document-id"
import { IndexWriterTestAccess } from "~/modules/search/index-writer"
import { processIndexerJob } from "~/modules/search/indexer"
import { runReindex } from "~/modules/search/reindex"
import { mentionSearch } from "~/modules/search/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Doc = Record<string, unknown> & { id: string }

const LIVE_INDEX = "test_liaison_search"

/**
 * A Meili client over named in-memory indexes. The full reindex builds a shadow
 * index (`createIndex`), streams into it and swaps it with the live one
 * (`swapIndexes`), so the fake keeps one document map per index name and
 * `store` is always the LIVE index's documents. `addDocuments` records every
 * add, whichever index it went to.
 */
function fakeMeili(initialIds: string[] = []) {
  const indexes = new Map<string, Map<string, Doc>>([
    [LIVE_INDEX, new Map(initialIds.map((id) => [id, { id }]))],
  ])
  const docsOf = (name: string): Map<string, Doc> => {
    let docs = indexes.get(name)
    if (!docs) {
      // Meili creates an index on its first document write.
      docs = new Map()
      indexes.set(name, docs)
    }
    return docs
  }
  const addDocuments = mock(async (docs: Doc[], name = LIVE_INDEX) => {
    const store = docsOf(name)
    for (const d of docs) store.set(d.id, d)
    return { taskUid: 1 }
  })
  const deleteDocument = mock(async (id: string, name = LIVE_INDEX) => {
    docsOf(name).delete(id)
    return { taskUid: 2 }
  })
  // An empty Meili answer, so mentionSearch tops up from the direct-DB fallback.
  const search = mock(async () => ({ hits: [], estimatedTotalHits: 0 }))
  const index = (name: string) => ({
    addDocuments: (docs: Doc[]) => addDocuments(docs, name),
    // A partial update merges into the stored document (the vector opt-out sweep).
    updateDocuments: async (docs: Doc[]) => {
      const store = docsOf(name)
      for (const d of docs) store.set(d.id, { ...(store.get(d.id) ?? {}), ...d })
      return { taskUid: 4 }
    },
    deleteDocument: (id: string) => deleteDocument(id, name),
    deleteDocuments: async (ids: string[] | { filter: string }) => {
      const store = docsOf(name)
      if (Array.isArray(ids)) for (const id of ids) store.delete(id)
      return { taskUid: 3 }
    },
    getDocuments: async ({
      filter,
      limit,
      offset,
    }: {
      filter: string
      limit: number
      offset: number
    }) => {
      // Honour the org/app/entity scoping the prune sweep sends, on the id
      // prefix documentId() builds, so other orgs' docs are never "ghosts".
      const m = /org_id = "([^"]+)" AND app = "([^"]+)" AND entity_type = "([^"]+)"/.exec(filter)
      const prefix = m ? documentId(m[1], m[2], m[3], "") : ""
      const all = Array.from(docsOf(name).keys())
        .filter((id) => id.startsWith(prefix))
        .map((id) => ({ id }))
      return { results: all.slice(offset, offset + limit) }
    },
    getSettings: async () => {
      if (!indexes.has(name)) throw new Error(`index ${name} not found`)
      return {}
    },
    updateSettings: async () => ({ taskUid: 5 }),
    search,
  })
  const meili = {
    index,
    createIndex: async (name: string) => {
      indexes.set(name, new Map())
      return { taskUid: 6 }
    },
    deleteIndex: async (name: string) => {
      indexes.delete(name)
      return { taskUid: 7 }
    },
    swapIndexes: async (pairs: Array<{ indexes: [string, string] }>) => {
      for (const {
        indexes: [a, b],
      } of pairs) {
        const docsA = docsOf(a)
        indexes.set(a, docsOf(b))
        indexes.set(b, docsA)
      }
      return { taskUid: 8 }
    },
    httpRequest: { patch: async () => ({}) },
    tasks: { waitForTask: mock(async () => undefined) },
  }
  return {
    meili,
    get store(): Map<string, Doc> {
      return docsOf(LIVE_INDEX)
    },
    addDocuments,
    deleteDocument,
  }
}

describe("archived Knowledge documents stay out of search", () => {
  let orgId: string
  let ownerId: string
  let liveId: string
  let archivedId: string
  let suffix: string
  const spies: Array<{ mockRestore: () => void }> = []

  beforeAll(async () => {
    await acquireTestLock()
    // A rebuild waits out twice the writers' "is a rebuild running" cache window
    // before reading and before dropping the old index; 100 ms instead of 1 s.
    IndexWriterTestAccess.setRebuildStateCacheMs(100)
  })
  afterAll(async () => {
    IndexWriterTestAccess.setRebuildStateCacheMs()
    await releaseTestLock()
  })

  beforeEach(async () => {
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const [org] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'KnowledgeArchived', ${`knowledge-archived-${suffix}`}) RETURNING id`,
      ),
    )
    orgId = org.id
    const [owner] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version) VALUES (gen_random_uuid(), ${orgId}::uuid, ${`owner-${suffix}@x.test`}, 'Owner', 'active', 'h', 1, 1) RETURNING id`,
      ),
    )
    ownerId = owner.id
    const insertDoc = async (title: string, archived: boolean) => {
      const [row] = extractRows<{ id: string }>(
        await db.execute(
          sql`INSERT INTO app_knowledge.documents (id, org_id, title, body, document_scope, owner_user_id, participant_ids, created_by, revision, required_scopes, sensitivity, archived_at)
              VALUES (gen_random_uuid(), ${orgId}::uuid, ${title}, 'body', 'organization', ${ownerId}::uuid, NULL, ${ownerId}::uuid, 1, '{}'::text[], 'internal', ${archived ? sql`now()` : sql`NULL`})
              RETURNING id`,
        ),
      )
      return row.id
    }
    liveId = await insertDoc(`Skill live ${suffix}`, false)
    archivedId = await insertDoc(`Skill archived ${suffix}`, true)

    // The REAL manifest declaration, so the test fails if the manifest stops
    // telling the indexer which column marks a row archived.
    const decl = (manifest as { entities: Record<string, any> }).entities.document
    entityRegistry.set([orgId, "knowledge", "document"], decl)
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(LIVE_INDEX))
  })

  afterEach(async () => {
    for (const s of spies) s.mockRestore()
    spies.length = 0
    entityRegistry.delete([orgId, "knowledge", "document"])
    await db.execute(sql`DELETE FROM app_knowledge.documents WHERE org_id = ${orgId}::uuid`)
    await db.execute(sql`DELETE FROM kernel.users WHERE org_id = ${orgId}::uuid`)
    await db.execute(sql`DELETE FROM kernel.organizations WHERE id = ${orgId}::uuid`)
  })

  it("an upsert job on an archived document deletes it from the index instead of re-adding it", async () => {
    const fake = fakeMeili([documentId(orgId, "knowledge", "document", archivedId)])
    spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(fake.meili as any))

    await processIndexerJob({
      action: "upsert",
      orgId,
      app: "knowledge",
      entityType: "document",
      entityId: archivedId,
    })

    expect(fake.addDocuments).not.toHaveBeenCalled()
    expect(fake.store.has(documentId(orgId, "knowledge", "document", archivedId))).toBe(false)
  })

  it("a full reindex skips archived documents and prunes the ones already indexed", async () => {
    const archivedDocId = documentId(orgId, "knowledge", "document", archivedId)
    const liveDocId = documentId(orgId, "knowledge", "document", liveId)
    // The deployed state: the archived doc is sitting in the index.
    const fake = fakeMeili([archivedDocId])
    spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(fake.meili as any))

    await runReindex()

    const added = fake.addDocuments.mock.calls.flatMap((c) => c[0].map((d) => d.id))
    expect(added).toContain(liveDocId)
    expect(added).not.toContain(archivedDocId)
    expect(fake.store.has(liveDocId)).toBe(true)
    expect(fake.store.has(archivedDocId)).toBe(false)
  })

  it("the direct-DB mention fallback never returns an archived document", async () => {
    const fake = fakeMeili()
    spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(fake.meili as any))

    const hits = await mentionSearch({
      orgId,
      userId: ownerId,
      scopes: ["knowledge:documents:read"],
      dimensionGrants: {},
      q: suffix,
      type: "entity",
      limit: 10,
    })
    const ids = hits.map((h) => h.id)
    expect(ids).toContain(liveId)
    expect(ids).not.toContain(archivedId)
  })

  it("knowledge search drops a stale index hit for an archived or deleted document", async () => {
    const goneId = "00000000-0000-4000-8000-000000000000"
    const hits = [
      {
        source: "knowledge",
        sourceEntityId: archivedId,
        title: "a",
        type: "document",
        sourceRank: 1,
      },
      { source: "knowledge", sourceEntityId: liveId, title: "l", type: "document", sourceRank: 2 },
      { source: "knowledge", sourceEntityId: goneId, title: "g", type: "document", sourceRank: 3 },
    ]
    const kept = await dropArchivedKnowledgeHits(db as never, orgId, hits)
    expect(kept.map((h) => h.sourceEntityId)).toEqual([liveId])
  })
})
