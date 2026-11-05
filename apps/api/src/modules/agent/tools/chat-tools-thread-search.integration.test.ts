// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's thread search, content pass (design audit finding 9).
//
// It used to be `ILIKE '%q%'` over every message of the org (564k rows in
// production, a sequential scan per agent search). The candidates now come from
// the message documents of the search index; the ROWS still come from the
// caller's own RLS transaction with the same membership join, so the messages
// SELECT policy (scopes, disclosure) and thread membership decide what comes
// back, exactly as before. These cases run on REAL rows, a REAL private Meili
// index and a REAL RLS transaction, and pin that nobody finds what they cannot
// read through the new path, including when the index is stale or down.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import * as searchClientModule from "~/infra/search/client"
import { handleThreadsSearch } from "~/modules/agent/tools/chat-tools"
import { SearchDriftTestAccess } from "~/modules/search/drift"
import {
  MessageIndexerTestAccess,
  processMessageIndexerJob,
} from "~/modules/search/message-indexer"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const MEMBER = crypto.randomUUID() // in rooms A and B, holds SCOPE
const LACKER = crypto.randomUUID() // in room A, lacks SCOPE
const OUTSIDER = crypto.randomUUID() // in room C only
const STRANGER = crypto.randomUUID() // other org
const ROOM_A = crypto.randomUUID()
const ROOM_B = crypto.randomUUID()
const ROOM_C = crypto.randomUUID()
const ROOM_X = crypto.randomUUID() // other org
const tag = ORG.slice(0, 8)
const INDEX = `test_thrsearch_${tag}`
const THREADS_READ = "kernel:threads:read"
const SCOPE = "crm:deals:read"

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

const ids: Record<string, string> = {}
const searches: string[] = []
const spies: Array<{ mockRestore: () => void }> = []

function recordingMeili(failing = false) {
  return {
    index: (name: string) => {
      const real = meili.index(name)
      return {
        search: async (q: string, opts: Record<string, unknown>) => {
          searches.push(String(opts?.filter ?? ""))
          if (failing) throw new Error("meili down")
          return await real.search(q, opts)
        },
        addDocuments: (docs: unknown[]) => real.addDocuments(docs as never),
        deleteDocuments: (a: unknown) => real.deleteDocuments(a as never),
      }
    },
    tasks: meili.tasks,
  } as unknown as ReturnType<typeof searchClientModule.getMeili>
}

async function insertMessage(
  org: string,
  thread: string,
  author: string,
  content: string,
  scopes: string[] = [],
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, content, required_scopes)
    VALUES (${thread}, ${org}, ${author}, ${content}, ${scopes}::text[]) RETURNING id`
  return String(row?.id)
}

function actor(userId: string, orgId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

async function search(userId: string, orgId: string, scopes: string[], query: string) {
  return await withRlsContext(actor(userId, orgId, scopes), (tx) =>
    handleThreadsSearch({ query, limit: 20 }, { userId, orgId, db: tx, scopes } as never),
  )
}

function matchedMessageIds(res: { threads: Array<{ matchContext?: { messageId?: string } }> }) {
  return res.threads.map((t) => t.matchContext?.messageId).filter(Boolean)
}

beforeAll(async () => {
  process.env.GOOGLE_API_KEY = ""
  MessageIndexerTestAccess.resetEmbedderCache()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX))
  spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(recordingMeili()))
  SearchDriftTestAccess.setSearchReady(true)

  const { expectedSettings } = await import("~/modules/search/drift")
  const created = await meili.createIndex(INDEX, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili
    .index(INDEX)
    .updateSettings(expectedSettings({ registeredReadScopes: [THREADS_READ], dimensionFields: [] }))
  await meili.tasks.waitForTask(applied.taskUid)

  for (const [org, name] of [
    [ORG, "thrsearch"],
    [OTHER_ORG, "thrsearch-other"],
  ] as const) {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${org}, ${name}, ${`${name}-${tag}`})`
  }
  for (const [id, org, name] of [
    [MEMBER, ORG, "member"],
    [LACKER, ORG, "lacker"],
    [OUTSIDER, ORG, "outsider"],
    [STRANGER, OTHER_ORG, "stranger"],
  ] as const) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${id}, ${org}, ${`thrsearch-${name}-${tag}@test.com`}, ${`Person ${name}`}, 'x')`
  }
  for (const [id, org, owner, members] of [
    [ROOM_A, ORG, MEMBER, [MEMBER, LACKER]],
    [ROOM_B, ORG, MEMBER, [MEMBER]],
    [ROOM_C, ORG, OUTSIDER, [OUTSIDER]],
    [ROOM_X, OTHER_ORG, STRANGER, [STRANGER]],
  ] as const) {
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${id}, ${org}, ${`thr-${id.slice(0, 8)}`}, 'Unrelated title', ${owner})`
    for (const userId of members) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${id}, ${userId}, ${org})`
    }
  }

  ids.openA = await insertMessage(ORG, ROOM_A, MEMBER, "the walrus invoice is paid")
  ids.scopedA = await insertMessage(ORG, ROOM_A, MEMBER, "the walrus contract terms", [SCOPE])
  ids.b = await insertMessage(ORG, ROOM_B, MEMBER, "a walrus shipment left Rotterdam")
  ids.c = await insertMessage(ORG, ROOM_C, OUTSIDER, "the walrus merger is secret")
  ids.x = await insertMessage(OTHER_ORG, ROOM_X, STRANGER, "another org's walrus")
  ids.deleted = await insertMessage(ORG, ROOM_B, MEMBER, "a walrus line later deleted")
  for (const [key, id] of Object.entries(ids)) {
    await processMessageIndexerJob({
      action: "upsert",
      orgId: key === "x" ? OTHER_ORG : ORG,
      messageId: id,
    })
  }
  await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${ids.deleted}`
})

afterAll(async () => {
  SearchDriftTestAccess.resetSearchReady()
  for (const s of spies) s.mockRestore()
  for (const org of [ORG, OTHER_ORG]) {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
  }
  const deleted = await meili.deleteIndex(INDEX)
  await meili.tasks.waitForTask(deleted.taskUid)
})

describe("threads_search content pass: served by the index, decided by RLS", () => {
  it("is answered by the search index, narrowed to the caller's rooms", async () => {
    searches.length = 0
    const res = await search(MEMBER, ORG, [THREADS_READ, SCOPE], "walrus")
    expect(res.threads.map((t) => t.id).sort()).toEqual([ROOM_A, ROOM_B].sort())
    // The index answered: one search, over this org's message documents, in
    // the caller's rooms only. (The ILIKE scan issued no index search at all.)
    expect(searches).toHaveLength(1)
    expect(searches[0]).toContain(`org_id = "${ORG}"`)
    expect(searches[0]).toContain(`thread_id IN`)
    expect(searches[0]).not.toContain(ROOM_C)
  })

  it("never returns a room the caller is not in, nor another org's", async () => {
    const res = await search(MEMBER, ORG, [THREADS_READ, SCOPE], "walrus merger secret")
    expect(res.threads).toEqual([])
    const outsider = await search(OUTSIDER, ORG, [THREADS_READ, SCOPE], "walrus")
    expect(outsider.threads.map((t) => t.id)).toEqual([ROOM_C])
    const stranger = await search(STRANGER, OTHER_ORG, [THREADS_READ, SCOPE], "walrus")
    expect(stranger.threads.map((t) => t.id)).toEqual([ROOM_X])
  })

  it("never returns a message whose required scopes the caller lacks, even by its exact words", async () => {
    const res = await search(LACKER, ORG, [THREADS_READ], "walrus contract terms")
    expect(matchedMessageIds(res)).not.toContain(ids.scopedA)
    expect(res.threads).toEqual([])
    // The same room still matches through a message the caller may read.
    const open = await search(LACKER, ORG, [THREADS_READ], "walrus invoice")
    expect(matchedMessageIds(open)).toEqual([ids.openA])
  })

  it("never returns a deleted message", async () => {
    const res = await search(MEMBER, ORG, [THREADS_READ, SCOPE], "walrus later deleted")
    expect(matchedMessageIds(res)).not.toContain(ids.deleted)
  })

  it("a STALE document cannot leak: the row's current scopes decide", async () => {
    // The row is narrowed after it was indexed; the document still says open.
    const stale = await insertMessage(ORG, ROOM_A, MEMBER, "the narwhal budget", [])
    await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: stale })
    await sql`UPDATE kernel.messages SET required_scopes = ${[SCOPE]}::text[] WHERE id = ${stale}`
    const lacker = await search(LACKER, ORG, [THREADS_READ], "narwhal")
    expect(lacker.threads).toEqual([])
    const holder = await search(MEMBER, ORG, [THREADS_READ, SCOPE], "narwhal")
    expect(matchedMessageIds(holder)).toEqual([stale])
  })

  it("with the index down, a bounded fallback still answers under the same rules", async () => {
    const restore = spyOn(searchClientModule, "getMeili").mockReturnValue(recordingMeili(true))
    try {
      const member = await search(MEMBER, ORG, [THREADS_READ, SCOPE], "walrus")
      expect(member.threads.map((t) => t.id).sort()).toEqual([ROOM_A, ROOM_B].sort())
      const lacker = await search(LACKER, ORG, [THREADS_READ], "walrus contract")
      expect(lacker.threads).toEqual([])
      const outsider = await search(OUTSIDER, ORG, [THREADS_READ], "walrus")
      expect(outsider.threads.map((t) => t.id)).toEqual([ROOM_C])
    } finally {
      restore.mockRestore()
    }
  })
})
