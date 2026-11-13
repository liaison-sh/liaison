// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Search and read agree, on the agent tool path.
 *
 * A person's agent searched Knowledge, got a document shared with a role the
 * person holds, then opened it by id and by title and got `not_found` both
 * times: `knowledge_search` built its actor with the person's roles, while
 * `knowledge_get` and `knowledge_find_by_title` built theirs without, so the
 * role share that let search find it did not let the read open it.
 *
 * Driven through the real sandbox bridge under the reader's RLS context:
 *   - a document shared with a role the reader holds is found by search and
 *     opens by id and by exact title;
 *   - a document the reader cannot open never appears in search, even when
 *     the index hands it back (a lagging or divergent ACL projection), and the
 *     search guard drops it on its own, without RLS's help;
 *   - a search that finds nothing (a French question about English documents)
 *     tells the agent to search again with the terms in the documents' language.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import {
  createKnowledgeDocument,
  dropArchivedKnowledgeHits,
  type KnowledgeActor,
  knowledgeActorFromContext,
  setDocumentSharing,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { KNOWLEDGE_SEARCH_NO_HITS_NOTE } from "~/modules/apps/sandbox/bridge/knowledge"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as searchService from "~/modules/search/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const READ = "knowledge:documents:read"
const CREATE = "knowledge:documents:create"
const UPDATE = "knowledge:documents:update"
const GRANTS = { sensitivity: ["confidential"], team: ["*"] }

let orgId: string
let owner: string
let reader: string
let financeRole: string
let sharedId: string
let hiddenId: string
const sharedTitle = `Q3 P&L ${randomUUID().slice(0, 8)}`
const hiddenTitle = `Board minutes ${randomUUID().slice(0, 8)}`

function userCtx(userId: string, scopes: string[], roles: string[]): UserContext {
  return { actorType: "user", orgId, userId, scopes, dimensionGrants: GRANTS, roles }
}

function knowledgeActor(userId: string, scopes: string[], roles: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: GRANTS, roles })
}

type Bridge = Record<string, (paramsJson: string) => Promise<string>>

/** One bridge call as the reader's agent: the reader's scopes and roles, under their RLS. */
async function asReaderAgent<T>(call: (bridge: Bridge) => Promise<string>): Promise<T> {
  const ctx = userCtx(reader, [READ], [financeRole])
  return withRlsContext(ctx, async (tx) => {
    const bridge = createRpcBridge(
      "knowledge",
      reader,
      orgId,
      tx as never,
      knowledgeManifest as never,
      [READ],
      "user",
      undefined,
      { actor: ctx },
    ) as Bridge
    return JSON.parse(await call(bridge)) as T
  })
}

async function createRestrictedDoc(title: string, roleShares: string[]): Promise<string> {
  const ownerActor = knowledgeActor(owner, [CREATE, READ, UPDATE], [])
  return withRlsContext(userCtx(owner, ownerActor.scopes, []), async (tx) => {
    const doc = await createKnowledgeDocument(
      tx,
      {
        documentScope: "organization",
        title,
        body: `${title}: gross margin 54%, driven by the Kestrel 10.`,
        collectionIds: [],
        tagNames: [],
        team: [],
        sensitivity: "confidential",
        verifyNow: false,
      } as never,
      ownerActor,
      [],
    )
    await setDocumentSharing(
      tx,
      doc.id,
      {
        orgAccess: "none",
        editScope: null,
        shares: [],
        roleShares: roleShares.map((roleId) => ({ roleId, role: "viewer" as const })),
      },
      ownerActor,
    )
    return doc.id
  })
}

let searchSpy: { mockRestore: () => void } | null = null

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeReadSearchConsistency', ${`k-read-search-${Date.now()}`})
          RETURNING id`,
    ),
  )
  orgId = org!.id
  const mkUser = async (name: string) => {
    const [row] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-${randomUUID()}@x.test`}, ${name}, 'active', 'h', 1, 1)
            RETURNING id`,
      ),
    )
    return row!.id
  }
  owner = await mkUser("owner")
  reader = await mkUser("reader")
  // A role share needs no kernel.roles row: RLS and the share lookup read the
  // actor's role ids (app.current_roles), as the role-sharing suite does.
  financeRole = randomUUID()
  sharedId = await createRestrictedDoc(sharedTitle, [financeRole])
  hiddenId = await createRestrictedDoc(hiddenTitle, [])
})

afterEach(() => {
  searchSpy?.mockRestore()
  searchSpy = null
})

afterAll(releaseTestLock)

/** The index answers with both documents, whatever the reader may open. */
function indexReturnsBoth(): void {
  searchSpy = spyOn(searchService, "scopedEntitySearch").mockResolvedValue([
    {
      id: sharedId,
      app: "knowledge",
      entityType: "document",
      label: sharedTitle,
      title: sharedTitle,
    },
    {
      id: hiddenId,
      app: "knowledge",
      entityType: "document",
      label: hiddenTitle,
      title: hiddenTitle,
    },
  ])
}

describe("knowledge agent tools: search and read agree", () => {
  it("a document shared with the reader's role opens by id", async () => {
    const got = await asReaderAgent<{ status: string; document?: { id: string; title: string } }>(
      (b) => b.knowledge_get!(JSON.stringify({ id: sharedId })),
    )
    expect(got.status).toBe("available")
    expect(got.document?.title).toBe(sharedTitle)
  })

  it("a document shared with the reader's role opens by exact title", async () => {
    const got = await asReaderAgent<{ found: boolean; document: { id: string } | null }>((b) =>
      b.knowledge_find_by_title!(JSON.stringify({ title: sharedTitle })),
    )
    expect(got.found).toBe(true)
    expect(got.document?.id).toBe(sharedId)
  })

  it("a document the reader cannot open stays not_found by id and by title", async () => {
    const byId = await asReaderAgent<{ status: string }>((b) =>
      b.knowledge_get!(JSON.stringify({ id: hiddenId })),
    )
    expect(byId.status).toBe("not_found")
    const byTitle = await asReaderAgent<{ found: boolean }>((b) =>
      b.knowledge_find_by_title!(JSON.stringify({ title: hiddenTitle })),
    )
    expect(byTitle.found).toBe(false)
  })

  it("search returns the readable document and never the one the reader cannot open", async () => {
    indexReturnsBoth()
    const res = await asReaderAgent<{ hits: Array<{ sourceEntityId: string; title: string }> }>(
      (b) =>
        b.knowledge_search!(JSON.stringify({ query: "gross margin", filters: { sources: [] } })),
    )
    const ids = res.hits.map((h) => h.sourceEntityId)
    expect(ids).toContain(sharedId)
    expect(ids).not.toContain(hiddenId)
    expect(res.hits.map((h) => h.title)).not.toContain(hiddenTitle)
  })

  it("every document search returns opens by id through knowledge_get", async () => {
    indexReturnsBoth()
    const res = await asReaderAgent<{ hits: Array<{ sourceEntityId: string; type: string }> }>(
      (b) =>
        b.knowledge_search!(JSON.stringify({ query: "gross margin", filters: { sources: [] } })),
    )
    const docHits = res.hits.filter((h) => h.type === "document")
    expect(docHits.length).toBeGreaterThan(0)
    for (const hit of docHits) {
      const got = await asReaderAgent<{ status: string }>((b) =>
        b.knowledge_get!(JSON.stringify({ id: hit.sourceEntityId })),
      )
      expect(got.status).toBe("available")
    }
  })

  it("a search that finds nothing tells the agent to retry in the documents' language", async () => {
    // Keyword search: the French words are in no English document.
    searchSpy = spyOn(searchService, "scopedEntitySearch").mockResolvedValue([])
    const miss = await asReaderAgent<{ hits: unknown[]; note?: string }>((b) =>
      b.knowledge_search!(JSON.stringify({ query: "marge brute T3", filters: { sources: [] } })),
    )
    expect(miss.hits).toHaveLength(0)
    expect(miss.note).toBe(KNOWLEDGE_SEARCH_NO_HITS_NOTE)
    expect(miss.note).toContain("translated into English")

    // A search that finds the document carries no note.
    searchSpy.mockRestore()
    indexReturnsBoth()
    const hit = await asReaderAgent<{ hits: unknown[]; note?: string }>((b) =>
      b.knowledge_search!(JSON.stringify({ query: "gross margin Q3", filters: { sources: [] } })),
    )
    expect(hit.hits.length).toBeGreaterThan(0)
    expect(hit.note).toBeUndefined()
  })

  it("the search guard drops a hit its reader cannot open, without RLS", async () => {
    // Privileged connection: RLS returns every row, so only the read check drops one.
    const hits = [
      { sourceEntityId: sharedId, type: "document" },
      { sourceEntityId: hiddenId, type: "document" },
    ]
    const kept = await dropArchivedKnowledgeHits(
      db as never,
      orgId,
      hits,
      knowledgeActor(reader, [READ], [financeRole]),
    )
    expect(kept.map((h) => h.sourceEntityId)).toEqual([sharedId])
    // Without a reader the guard only drops archived or missing rows.
    const unfiltered = await dropArchivedKnowledgeHits(db as never, orgId, hits)
    expect(unfiltered).toHaveLength(2)
  })
})
