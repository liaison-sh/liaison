// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A17: a message hit says which reply thread the message lives in, so a click
// on a reply opens its channel with the reply panel on the root. The value is
// read from the row by the same database re-check that decides the hit's
// visibility, never trusted from the index. A real Meili index holding
// documents written by the real indexer, over real rows.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import * as searchClientModule from "~/infra/search/client"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"

const ORG_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const THREADS_READ = "kernel:threads:read"
const INDEX_NAME = `test_a17_${crypto.randomUUID().slice(0, 8)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

const spies: Array<{ mockRestore: () => void }> = []
let rootId = ""
let replyId = ""

async function insertMessage(content: string, replyRootId: string | null): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, reply_root_id)
    VALUES (${THREAD_ID}, ${ORG_ID}, ${MEMBER}, ${content}, '{}'::text[], ${replyRootId})
    RETURNING id`
  return row.id
}

beforeAll(async () => {
  ExternalSearchHandlersTestAccess.reset()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
  spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(meili as never))
  const { expectedSettings } = await import("./drift")
  const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili.index(INDEX_NAME).updateSettings(
    expectedSettings({
      registeredReadScopes: [THREADS_READ],
      dimensionFields: [],
      aclFieldNames: collectSearchableRegistrations(ORG_ID).aclFieldNames,
    }),
  )
  await meili.tasks.waitForTask(applied.taskUid)

  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'A17 Org', ${`a17-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${MEMBER}, ${ORG_ID}, ${`a17-${tag}@test.com`}, 'member', 'x')`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
    VALUES (${THREAD_ID}, ${ORG_ID}, ${`a17-${tag}`}, ${MEMBER})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${THREAD_ID}, ${MEMBER}, ${ORG_ID})`
  rootId = await insertMessage("the zanzibar shipment root", null)
  replyId = await insertMessage("the zanzibar shipment reply", rootId)
  const { processMessageIndexerJob } = await import("./message-indexer")
  for (const messageId of [rootId, replyId]) {
    await processMessageIndexerJob({ action: "upsert", orgId: ORG_ID, messageId })
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  const deleted = await meili.deleteIndex(INDEX_NAME)
  await meili.tasks.waitForTask(deleted.taskUid)
  for (const s of spies) s.mockRestore()
  spies.length = 0
})

describe("message hits carry their reply root (A17)", () => {
  it("a reply's hit names its root; a channel message's hit names none", async () => {
    const { pageSearch } = await import("./service")
    const res = await pageSearch({
      orgId: ORG_ID,
      userId: MEMBER,
      scopes: [THREADS_READ],
      q: "zanzibar",
      limit: 20,
      offset: 0,
      filters: {},
    })
    const byId = new Map(
      res.hits
        .filter((h) => h.entity_type === "message")
        .map((h) => [String(h.entity_id ?? h.id), h]),
    )
    expect(byId.get(replyId)?.replyRootId).toBe(rootId)
    expect(byId.get(rootId)?.replyRootId).toBeNull()
  })
})
