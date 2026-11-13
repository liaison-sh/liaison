// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A word common across the org must not hide the Knowledge documents it is in.
 *
 * Production (2026-11-13): `knowledge__search` answered 0 hits for every query
 * holding the company's product name, while the index held about 1,100
 * matching documents. The local search took the top 20 of the WHOLE index
 * (`globalSearch`) and kept the Knowledge hits afterwards: the name is in
 * thousands of messages and contacts, which filled the window, so no document
 * survived the filter. The global palette had the same shape (one shared top
 * 50 for every bucket).
 *
 * Real Postgres rows, a real Meilisearch index built by the real document
 * builder, the real permission filter: 60 org contacts named after the product
 * outrank 3 documents that mention it in their body; one more document is
 * restricted to its owner.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { randomUUID } from "node:crypto"
import { MeiliSearch } from "meilisearch"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import {
  createKnowledgeDocument,
  knowledgeActorFromContext,
  setDocumentSharing,
} from "~/apps/knowledge/service"
import { type UserContext, withRlsContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { planEntityDocument } from "~/modules/search/indexer"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"
import { seedContext } from "~/seed/context"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { resolveContacts } from "~/seed/factories/people/contacts"

const ORG = randomUUID()
const tag = ORG.slice(0, 8)
const INDEX_NAME = `test_knowledge_crowding_${tag}`
// One made-up word, so only this test's records match it.
const TERM = `Quokkalab${tag.replace(/[^a-f]/g, "")}`
const READ = "knowledge:documents:read"
const OWNER_SCOPES = [
  READ,
  "knowledge:documents:create",
  "knowledge:documents:update",
  "kernel:contacts:read",
  "kernel:contacts:write",
]
const READER_SCOPES = [READ, "kernel:contacts:read"]
const GRANTS = { sensitivity: ["confidential"], team: ["*"] }
const CONTACTS = 60

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
const spies: Array<{ mockRestore: () => void }> = []

let owner = ""
let reader = ""
const readableIds: string[] = []
let hiddenId = ""

const ctx = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  orgId: ORG,
  userId,
  scopes,
  dimensionGrants: GRANTS,
  roles: [],
})

async function createDoc(title: string, restricted: boolean): Promise<string> {
  const actor = knowledgeActorFromContext({
    orgId: ORG,
    userId: owner,
    scopes: OWNER_SCOPES,
    dimensionGrants: GRANTS,
    roles: [],
  })
  return withRlsContext(ctx(owner, OWNER_SCOPES), async (tx) => {
    const doc = await createKnowledgeDocument(
      tx,
      {
        documentScope: "organization",
        title,
        body: `How to update the firmware of the ${TERM} controller, step by step.`,
        collectionIds: [],
        tagNames: [],
        team: [],
        sensitivity: "internal",
        verifyNow: false,
      } as never,
      actor,
      [],
    )
    if (restricted) {
      await setDocumentSharing(
        tx,
        doc.id,
        { orgAccess: "none", editScope: null, shares: [], roleShares: [] },
        actor,
      )
    }
    return doc.id
  })
}

async function indexAll(entities: Array<{ app: string; entityType: string; id: string }>) {
  const docs: Record<string, unknown>[] = []
  for (const e of entities) {
    const plan = await planEntityDocument({
      action: "upsert",
      orgId: ORG,
      app: e.app,
      entityType: e.entityType,
      entityId: e.id,
    })
    if (!plan || !("doc" in plan)) throw new Error(`no search document for ${e.entityType} ${e.id}`)
    docs.push(plan.doc)
  }
  const task = await meili.index(INDEX_NAME).addDocuments(docs)
  const done = await meili.tasks.waitForTask(task.taskUid)
  if (done.status !== "succeeded") throw new Error(`index write ${done.status}`)
}

beforeAll(async () => {
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))

  await seedOrgRow({ id: ORG, name: "KnowledgeCrowding", slug: `knowledge-crowding-${tag}` })
  owner = await seedUserRow({
    orgId: ORG,
    email: `owner-${tag}@crowding.test`,
    name: "Owner",
    status: "active",
  })
  reader = await seedUserRow({
    orgId: ORG,
    email: `reader-${tag}@crowding.test`,
    name: "Reader",
    status: "active",
  })
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(ORG)

  const { expectedSettings } = await import("~/modules/search/drift")
  const regs = collectSearchableRegistrations(ORG)
  const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili.index(INDEX_NAME).updateSettings(
    expectedSettings({
      registeredReadScopes: regs.registeredReadScopes,
      dimensionFields: regs.dimensionFields,
      aclFieldNames: regs.aclFieldNames,
    }),
  )
  await meili.tasks.waitForTask(applied.taskUid)

  for (const title of ["Controller update guide", "Lab install notes", "Bootloader recovery"]) {
    readableIds.push(await createDoc(`${title} ${tag}`, false))
  }
  hiddenId = await createDoc(`Owner-only draft ${tag}`, true)

  // The crowd: org contacts whose NAME is the word, so they outrank documents
  // that only mention it in their body.
  const contacts = await resolveContacts(
    seedContext({ orgId: ORG, now: new Date() }),
    ctx(owner, OWNER_SCOPES),
    Array.from({ length: CONTACTS }, (_, i) => ({
      key: `c${i}`,
      email: `dealer${i}-${tag}@crowding.test`,
      name: `${TERM} Dealer ${i}`,
    })),
    "org",
  )
  await indexAll([
    ...contacts.map(([, c]) => ({ app: "kernel", entityType: "contact", id: c.id })),
    ...[...readableIds, hiddenId].map((id) => ({
      app: "knowledge",
      entityType: "document",
      id,
    })),
  ])
}, 120_000)

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  await meili.deleteIndex(INDEX_NAME).catch(() => {})
})

type Bridge = Record<string, (paramsJson: string) => Promise<string>>

async function readerAgentSearch(query: string) {
  const c = ctx(reader, READER_SCOPES)
  return withRlsContext(c, async (tx) => {
    const bridge = createRpcBridge(
      "knowledge",
      reader,
      ORG,
      tx as never,
      knowledgeManifest as never,
      READER_SCOPES,
      "user",
      undefined,
      { actor: c },
    ) as Bridge
    return JSON.parse(
      await bridge.knowledge_search!(JSON.stringify({ query, filters: { sources: [] } })),
    ) as {
      hits: Array<{ sourceEntityId: string; title: string }>
      sourceStatuses: Array<{ source: string; state: string; hitCount?: number }>
    }
  })
}

describe("knowledge search under a word common in other records", () => {
  it("precondition: the unscoped top of the index is all contacts", async () => {
    const { pageSearch } = await import("~/modules/search/service")
    const page = await pageSearch({
      orgId: ORG,
      userId: reader,
      scopes: READER_SCOPES,
      dimensionGrants: GRANTS,
      q: TERM,
      limit: 20,
      offset: 0,
      filters: {},
    })
    expect(page.hits.length).toBe(20)
    expect(page.hits.every((h) => h.entity_type === "contact")).toBe(true)
  })

  it("knowledge_search finds every readable document, never the restricted one", async () => {
    const res = await readerAgentSearch(TERM)
    const ids = res.hits.map((h) => h.sourceEntityId)
    expect(ids.sort()).toEqual([...readableIds].sort())
    expect(ids).not.toContain(hiddenId)
    expect(res.hits.map((h) => h.title).join(" ")).not.toContain("Owner-only")
    const local = res.sourceStatuses.find((s) => s.source === "knowledge")
    expect(local?.state).toBe("complete")
    expect(local?.hitCount).toBe(readableIds.length)
  })

  it("a multi-word query holding the common word still finds the documents", async () => {
    const res = await readerAgentSearch(`${TERM} firmware`)
    expect(res.hits.map((h) => h.sourceEntityId).sort()).toEqual([...readableIds].sort())
  })

  it("the owner finds the restricted document too", async () => {
    const { scopedEntitySearch } = await import("~/modules/search/service")
    const hits = await scopedEntitySearch({
      orgId: ORG,
      userId: owner,
      scopes: OWNER_SCOPES,
      dimensionGrants: GRANTS,
      q: TERM,
      app: ["knowledge"],
      entityType: ["document"],
      limit: 20,
    })
    expect(hits.map((h) => h.id)).toContain(hiddenId)
  })

  it("the global palette lists the documents next to a full contacts bucket", async () => {
    const { globalSearch } = await import("~/modules/search/service")
    const res = await globalSearch({
      orgId: ORG,
      userId: reader,
      scopes: READER_SCOPES,
      dimensionGrants: GRANTS,
      q: TERM,
      limit: 10,
    })
    expect(res.contacts.length).toBe(10)
    const docIds = res.entities.filter((e) => e.app === "knowledge").map((e) => e.id)
    expect(docIds.sort()).toEqual([...readableIds].sort())
    expect(docIds).not.toContain(hiddenId)
  })

  it("a picker narrowed to Knowledge documents (dashboard link cell) finds them", async () => {
    const { mentionSearch } = await import("~/modules/search/service")
    const hits = await mentionSearch({
      orgId: ORG,
      userId: reader,
      scopes: READER_SCOPES,
      dimensionGrants: GRANTS,
      q: TERM,
      limit: 10,
      app: "knowledge",
      entityType: "document",
    })
    expect(hits.map((h) => h.id).sort()).toEqual([...readableIds].sort())
  })
})
