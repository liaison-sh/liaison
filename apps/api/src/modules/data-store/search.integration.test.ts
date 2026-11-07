// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Data store search (modules/data-store/search.ts) on real Postgres, Redis and
// Meili, through the store service's own write path and the real search
// service: a document of a declared searchable, agent-readable collection is
// found, one of an undeclared collection (or one not agent-readable) never is;
// a searcher without the collection's read scope finds nothing; the agent
// namespace is searchable under kernel:data:read; a delete takes the document
// out; the rebuild source streams exactly the indexed documents; and the org
// purge's filter delete removes them all.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import type { RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { appStoreDeclarationsRegistry } from "~/modules/apps/app-registries"
import {
  APP_DOCUMENT_ENTITY_TYPE,
  APP_DOCUMENT_INDEX_SOURCE,
  appDocumentEntityId,
} from "~/modules/data-store/search"
import { deleteDocument, setDocument } from "~/modules/data-store/service"
import { deleteOrgSearchDocuments } from "~/modules/org/purge/external"
import { indexSources } from "~/modules/search/index-sources"
import { flushLiveIndexOnce, LiveIndexTestAccess } from "~/modules/search/live-index-queue"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "storesearch"
const ORDERS_SCOPE = `${APP}:orders:read`
const WORD = `zephyrquill${Date.now().toString(36)}`

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
const spies: Array<{ mockRestore: () => void }> = []
let INDEX_NAME = ""
let ORG = ""
let USER = ""

function inOrg<T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId: USER, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
    fn,
  )
}

async function settle(): Promise<void> {
  while ((await flushLiveIndexOnce()) > 0) {}
  const { results } = await meili.tasks.getTasks({ indexUids: [INDEX_NAME], limit: 1 })
  const last = results[0]?.uid
  if (typeof last === "number") await meili.tasks.waitForTask(last)
}

/** The data store hits of `q` for a searcher holding `scopes`, as entity ids. */
async function hits(q: string, scopes: string[]): Promise<string[]> {
  const { pageSearch } = await import("~/modules/search/service")
  const res = await pageSearch({
    orgId: ORG,
    userId: USER,
    scopes,
    q,
    limit: 20,
    offset: 0,
    filters: {},
  })
  return res.hits
    .filter((h) => h.entity_type === APP_DOCUMENT_ENTITY_TYPE)
    .map((h) => String(h.entity_id ?? h.id))
    .sort()
}

const app = () => ({ orgId: ORG, app: APP, userId: null })
const agent = () => ({ orgId: ORG, app: "agent", userId: USER })

beforeAll(async () => {
  await acquireTestLock()
  const org = await minimal.secondOrg({ name: "Store Search Org" })
  ORG = org.orgId
  USER = org.adminUserId
  INDEX_NAME = `test_store_search_${ORG.slice(0, 8)}`
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  // The live index queue is flushed by the test, not by a job.
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
  await LiveIndexTestAccess.clear()
  const { expectedSettings } = await import("~/modules/search/drift")
  const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili.index(INDEX_NAME).updateSettings(
    expectedSettings({
      registeredReadScopes: ["kernel:data:read", ORDERS_SCOPE],
      dimensionFields: collectSearchableRegistrations(ORG).dimensionFields,
      aclFieldNames: collectSearchableRegistrations(ORG).aclFieldNames,
    }),
  )
  await meili.tasks.waitForTask(applied.taskUid)

  appStoreDeclarationsRegistry.set([ORG, APP], {
    orders: {
      readScope: ORDERS_SCOPE,
      searchable: { labelField: "title", fields: ["title", "customer"] },
      agentReadable: true,
    },
    // Searchable but not agent-readable: stays out of search too.
    ledger: {
      readScope: ORDERS_SCOPE,
      searchable: { labelField: "title", fields: ["title"] },
    },
  })
  await inOrg(async (tx) => {
    await setDocument(tx, app(), "orders", "o-1", {
      title: `Order ${WORD}`,
      customer: "Ines Duarte",
    })
    await setDocument(tx, app(), "orders", "o/2", { title: "Order two", customer: `${WORD} Ltd` })
    await setDocument(tx, app(), "ledger", "l-1", { title: `Ledger ${WORD}` })
    await setDocument(tx, app(), "sync_state", "s-1", { title: `Cursor ${WORD}` })
    await setDocument(tx, agent(), "notes", "n-1", { title: "Call back", summary: `${WORD} note` })
  })
  await settle()
})

afterAll(async () => {
  appStoreDeclarationsRegistry.deleteByPrefix([ORG])
  await LiveIndexTestAccess.clear()
  try {
    await meili.deleteIndex(INDEX_NAME)
  } catch {}
  for (const s of spies) s.mockRestore()
  await releaseTestLock()
})

describe("data store search", () => {
  it("finds declared searchable documents, by label and by other fields, and nothing else", async () => {
    expect(await hits(WORD, ["kernel:data:read", ORDERS_SCOPE])).toEqual(
      [
        appDocumentEntityId("agent", "notes", "n-1"),
        appDocumentEntityId(APP, "orders", "o-1"),
        appDocumentEntityId(APP, "orders", "o/2"),
      ].sort(),
    )
  })

  it("hides a collection from a searcher without its read scope", async () => {
    expect(await hits(WORD, ["kernel:data:read"])).toEqual([
      appDocumentEntityId("agent", "notes", "n-1"),
    ])
    expect(await hits(WORD, ["kernel:threads:read"])).toEqual([])
  })

  it("drops a hit whose collection is no longer declared searchable", async () => {
    const before = appStoreDeclarationsRegistry.get([ORG, APP])!
    appStoreDeclarationsRegistry.set([ORG, APP], {
      ...before,
      orders: { readScope: ORDERS_SCOPE, agentReadable: true },
    })
    try {
      expect(await hits(WORD, ["kernel:data:read", ORDERS_SCOPE])).toEqual([
        appDocumentEntityId("agent", "notes", "n-1"),
      ])
    } finally {
      appStoreDeclarationsRegistry.set([ORG, APP], before)
    }
  })

  it("the rebuild source streams exactly the indexed documents", async () => {
    const source = new Map(indexSources()).get(APP_DOCUMENT_INDEX_SOURCE)
    expect(source).toBeDefined()
    const streamed: string[] = []
    await source!(ORG, async (docs) => {
      for (const d of docs) streamed.push(String(d.entity_id))
    })
    expect(streamed.sort()).toEqual(
      [
        appDocumentEntityId("agent", "notes", "n-1"),
        appDocumentEntityId(APP, "orders", "o-1"),
        appDocumentEntityId(APP, "orders", "o/2"),
      ].sort(),
    )
  })

  it("a delete takes the document out of the index", async () => {
    await inOrg((tx) => deleteDocument(tx, app(), "orders", "o-1"))
    await settle()
    const doc = await meili
      .index(INDEX_NAME)
      .search(WORD, { filter: `org_id = "${ORG}"`, limit: 20 })
    expect(doc.hits.map((h) => h.entity_id)).not.toContain(
      appDocumentEntityId(APP, "orders", "o-1"),
    )
    expect(await hits(WORD, ["kernel:data:read", ORDERS_SCOPE])).toEqual(
      [
        appDocumentEntityId("agent", "notes", "n-1"),
        appDocumentEntityId(APP, "orders", "o/2"),
      ].sort(),
    )
  })

  it("the org purge removes every store document from the index", async () => {
    const uids = await deleteOrgSearchDocuments(ORG)
    for (const uid of uids) await meili.tasks.waitForTask(uid)
    const left = await meili
      .index(INDEX_NAME)
      .search("", { filter: `org_id = "${ORG}" AND entity_type = "${APP_DOCUMENT_ENTITY_TYPE}"` })
    expect(left.hits).toEqual([])
  })
})
