// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The query side must match the shape of the index it runs against (W2 review
// finding 2). The code that filters on `parent_type` ships at deploy; the
// index that can filter on it goes live at the rebuild's swap, minutes later.
// In between, Meili refuses any query naming an attribute that is not
// filterable, which took down mail search, ticket free text and every search
// scoped to an entity type. Real Meili, both shapes.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import * as searchClientModule from "~/infra/search/client"
import { SearchDriftTestAccess } from "~/modules/search/drift"
import { expectedSettings } from "~/modules/search/index-shape"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"
import { pageSearch, SearchServiceTestAccess } from "~/modules/search/service"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const OLD = `test_shape_old_${tag}`
const NEW = `test_shape_new_${tag}`
const READ = "kernel:contacts:read"
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

// The filterable attributes of the production index before the first rebuild.
const PRODUCTION_BEFORE_REBUILD = [
  "acl_role_ids",
  "acl_user_ids",
  "app",
  "author_agent_id",
  "created_at",
  "dedupe_key",
  "entity_id",
  "entity_type",
  "is_mentionable",
  "org_id",
  "org_wide",
  "participant_agent_ids",
  "participant_ids",
  "read_scope",
  "required_scopes",
  "sensitivity",
  "team",
  "thread_id",
]

const contact = {
  id: `${ORG}_kernel_contact_c1`,
  org_id: ORG,
  app: "kernel",
  entity_type: "contact",
  entity_id: "c1",
  read_scope: READ,
  is_mentionable: true,
  title: "Walrus Logistics",
  _vectors: { memory: null },
}

const spies: Array<{ mockRestore: () => void }> = []

beforeAll(async () => {
  spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(meili as never))
  SearchDriftTestAccess.setSearchReady(true)
  for (const [name, filterable] of [
    [OLD, PRODUCTION_BEFORE_REBUILD],
    [
      NEW,
      expectedSettings({
        registeredReadScopes: [READ],
        dimensionFields: [],
        aclFieldNames: collectSearchableRegistrations(ORG).aclFieldNames,
      }).filterableAttributes,
    ],
  ] as const) {
    await meili.tasks.waitForTask((await meili.createIndex(name, { primaryKey: "id" })).taskUid)
    await meili.tasks.waitForTask(
      (await meili.index(name).updateSettings({ filterableAttributes: [...filterable] })).taskUid,
    )
    await meili.tasks.waitForTask((await meili.index(name).addDocuments([contact])).taskUid)
  }
})

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  SearchDriftTestAccess.resetSearchReady()
  for (const name of [OLD, NEW]) {
    try {
      await meili.tasks.waitForTask((await meili.deleteIndex(name)).taskUid)
    } catch {
      /* gone */
    }
  }
})

async function scopedSearch(indexName: string) {
  SearchServiceTestAccess.resetFilterableCache()
  const spy = spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(indexName)
  try {
    return await pageSearch({
      orgId: ORG,
      userId: USER,
      scopes: [READ],
      q: "walrus",
      limit: 10,
      offset: 0,
      filters: {},
      entityType: ["contact"],
    })
  } finally {
    spy.mockRestore()
  }
}

describe("a search scoped to an entity type, against either index shape", () => {
  it("answers on the index production has before its rebuild", async () => {
    const res = await scopedSearch(OLD)
    expect(res.hits.map((h) => h.entity_id)).toEqual(["c1"])
  })

  it("answers on the rebuilt index", async () => {
    const res = await scopedSearch(NEW)
    expect(res.hits.map((h) => h.entity_id)).toEqual(["c1"])
  })
})
