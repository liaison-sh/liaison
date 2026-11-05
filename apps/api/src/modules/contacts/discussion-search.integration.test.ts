// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The notes migration 0216 copied into contact discussions are searchable, by
// whoever may read the discussion and nobody else.
//
// The migration inserts the messages with plain SQL: no event, so the live
// indexer never saw them. They reach the index through the full rebuild that
// DOC_SHAPE_VERSION 3 schedules at boot (index-shape.ts), whose transcript
// source streams every message from Postgres. Here the migration runs on real
// rows, the rebuild's own transcript source writes a real Meili index, and the
// real search service answers: the person who can see the contact finds the
// note once they open its discussion (as with every kernel thread, reading it
// is being seated in it, and seeing the contact is what seats them); a
// teammate who cannot see the private contact is refused the discussion and
// finds nothing.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { MeiliSearch } from "meilisearch"
import postgres from "postgres"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { openContactDiscussion } from "~/modules/contacts/discussion"
import { mergeContactsAsKernel } from "~/modules/contacts/service"
import { DOC_SHAPE_VERSION } from "~/modules/search/index-shape"
import { indexSources } from "~/modules/search/index-sources"
import { flushLiveIndexOnce, LiveIndexTestAccess } from "~/modules/search/live-index-queue"
import {
  processMessageIndexerJob,
  registerMessageIndexerConsumer,
} from "~/modules/search/message-indexer"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"

const MIGRATION = new URL("../../db/migrations/0216_contact_discussion.sql", import.meta.url)
  .pathname

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const ORG = crypto.randomUUID()
const OWNER = crypto.randomUUID()
const TEAMMATE = crypto.randomUUID()
const CONTACT = crypto.randomUUID()
const SURVIVOR = crypto.randomUUID()
const NOTE = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const INDEX_NAME = `test_contact_discussion_${tag}`
const SCOPES = ["kernel:contacts:read", "kernel:threads:read"]
const NOTE_TEXT = "Prefers the quokka edition, ships to Lisbon"

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})
const migrationConn = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })
const spies: Array<{ mockRestore: () => void }> = []

const ctx = (userId: string): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: {},
})

async function open(userId: string, contactId = CONTACT) {
  return withRlsContext(ctx(userId), (tx) =>
    openContactDiscussion(tx, { orgId: ORG, contactId, userId }),
  )
}

/** Wait until Meili has applied every task queued so far. */
async function settleMeili(): Promise<void> {
  const { results } = await meili.tasks.getTasks({ indexUids: [INDEX_NAME], limit: 1 })
  const last = results[0]?.uid
  if (typeof last === "number") await meili.tasks.waitForTask(last)
}

async function noteHits(userId: string): Promise<string[]> {
  const { pageSearch } = await import("~/modules/search/service")
  const res = await pageSearch({
    orgId: ORG,
    userId,
    scopes: SCOPES,
    q: "quokka Lisbon",
    limit: 20,
    offset: 0,
    filters: {},
  })
  return res.hits.filter((h) => h.entity_type === "message").map((h) => String(h.title ?? ""))
}

let migratedId = ""

beforeAll(async () => {
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  // The live index queue is flushed by the test, not by a job.
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
  spies.push(spyOn(jobsModule, "registerJobWorker").mockImplementation((() => {}) as never))
  await LiveIndexTestAccess.clear()
  const { expectedSettings } = await import("~/modules/search/drift")
  const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili.index(INDEX_NAME).updateSettings(
    expectedSettings({
      registeredReadScopes: SCOPES,
      dimensionFields: [],
      aclFieldNames: collectSearchableRegistrations(ORG).aclFieldNames,
    }),
  )
  await meili.tasks.waitForTask(applied.taskUid)

  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'ContactDiscussionSearch', ${`contact-discussion-search-${tag}`})`
  for (const [id, name] of [
    [OWNER, "owner"],
    [TEAMMATE, "teammate"],
  ] as const) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${id}, ${ORG}, ${`cds-${name}-${tag}@test.com`}, ${name}, 'x')`
  }
  // A private contact: only its owner sees it.
  await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, owner_user_id, org_access)
    VALUES (${CONTACT}, ${ORG}, ${`@cds-${tag}`}, 'Ines Duarte', ${`ines-${tag}@example.com`},
            ${OWNER}, ${OWNER}, 'none')`
  await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, owner_user_id, org_access)
    VALUES (${SURVIVOR}, ${ORG}, ${`@cds-survivor-${tag}`}, 'Ines Duarte', ${`ines.d-${tag}@example.com`},
            ${OWNER}, ${OWNER}, 'none')`
  // A note as the old notes list wrote it, before 0216.
  await sql`INSERT INTO kernel.timeline_entries
      (id, org_id, app, entity_type, entity_id, action, actor_id, actor_type, summary)
    VALUES (${NOTE}, ${ORG}, 'kernel', 'contact', ${CONTACT}, 'note', ${OWNER}, 'user', ${NOTE_TEXT})`

  // The migration, as shipped (idempotent: it only touches notes still there).
  for (const statement of readFileSync(MIGRATION, "utf8").split("--> statement-breakpoint")) {
    await migrationConn.unsafe(statement)
  }
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text FROM kernel.messages WHERE org_id = ${ORG} AND external_ref = ${`contact-note:${NOTE}`}`
  migratedId = row?.id ?? ""
}, 60_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await migrationConn.end()
  const deleted = await meili.deleteIndex(INDEX_NAME)
  await meili.tasks.waitForTask(deleted.taskUid)
  await LiveIndexTestAccess.clear()
  DurableConsumersTestAccess.reset()
  for (const s of spies) s.mockRestore()
})

describe("contact notes migrated into discussions are searchable under the discussion's rules", () => {
  it("the migration's copies were never indexed live, so a rebuild is scheduled for them", async () => {
    expect(migratedId).toMatch(/^[0-9a-f-]{36}$/)
    const raw = await meili.index(INDEX_NAME).search("quokka")
    expect(raw.hits).toEqual([])
    // Boot compares the index's fingerprint with this version and rebuilds.
    expect(DOC_SHAPE_VERSION).toBeGreaterThanOrEqual(3)
  })

  it("after the rebuild, the person who sees the contact finds the note, a teammate who cannot does not", async () => {
    const source = indexSources().find(([name]) => name === "kernel-transcript")?.[1]
    expect(source).toBeDefined()
    await source!(ORG, async (docs) => {
      if (docs.length === 0) return
      const task = await meili.index(INDEX_NAME).addDocuments(docs)
      await meili.tasks.waitForTask(task.taskUid)
    })
    const indexed = await meili.index(INDEX_NAME).search("quokka")
    expect(indexed.hits.map((h) => h.entity_id)).toContain(migratedId)

    // Nobody is seated by the migration: reading the discussion starts with
    // opening it, which only someone who sees the contact can do.
    expect(await noteHits(OWNER)).toEqual([])
    expect(await open(OWNER)).not.toBeNull()
    expect(await noteHits(OWNER)).toEqual([NOTE_TEXT])

    expect(await open(TEAMMATE)).toBeNull()
    expect(await noteHits(TEAMMATE)).toEqual([])
  })

  it("merged into another contact, the note is found in the survivor's discussion, by the same people", async () => {
    const survivor = await open(OWNER, SURVIVOR)
    expect(survivor).not.toBeNull()
    const [own] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${survivor!.threadId}, ${ORG}, ${OWNER}, 'Second address, same quokka order', '{}'::text[])
      RETURNING id::text`
    await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: String(own?.id) })

    await withPrivilegedDb(ORG, "test-contact-merge", (tx) =>
      mergeContactsAsKernel(tx, {
        orgId: ORG,
        userId: OWNER,
        sourceId: CONTACT,
        targetId: SURVIVOR,
      }),
    )
    const [moved] = await sql<{ thread_id: string }[]>`
      SELECT thread_id::text FROM kernel.messages WHERE id = ${migratedId}`
    expect(moved?.thread_id).toBe(survivor!.threadId)

    // After commit, the merge event re-indexes the survivor's discussion.
    const [event] = await sql<{ id: string; data: unknown }[]>`
      SELECT id::text, payload -> 'data' AS data FROM kernel.pending_events
       WHERE org_id = ${ORG} AND payload ->> 'app' = 'kernel'
         AND payload ->> 'entity' = 'contact' AND payload ->> 'action' = 'merge'
       ORDER BY seq DESC LIMIT 1`
    expect((event?.data as { discussionMoved?: boolean })?.discussionMoved).toBe(true)
    DurableConsumersTestAccess.reset()
    registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: String(event?.id),
      event: {
        app: "kernel",
        entity: "contact",
        action: "merge",
        entityId: SURVIVOR,
        orgId: ORG,
        data: event?.data,
      },
    })
    while ((await flushLiveIndexOnce()) > 0) {}
    await settleMeili()

    const docs = await meili.index(INDEX_NAME).search("quokka", { filter: `org_id = "${ORG}"` })
    const note = docs.hits.find((h) => h.entity_id === migratedId)
    expect(note?.thread_id).toBe(survivor!.threadId)
    expect(docs.hits.some((h) => h.thread_id !== survivor!.threadId)).toBe(false)

    expect((await noteHits(OWNER)).sort()).toEqual(
      ["Second address, same quokka order", NOTE_TEXT].sort(),
    )
    expect(await open(TEAMMATE, SURVIVOR)).toBeNull()
    expect(await noteHits(TEAMMATE)).toEqual([])
  })
})
