// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mail search documents are built from the rows that changed (design audit
// finding 2): the conversation document is its envelope, and each message is a
// FRAGMENT document of its conversation. These cases run on real rows and a
// real private Meili index, and pin:
//
//   - a conversation document costs O(1) rows however long the conversation is
//     (it used to read its newest 50 messages on every message);
//   - a fragment is found AS its conversation, once per conversation, by every
//     search surface, and only by the searchers the conversation admits;
//   - a sealed mailbox contributes no fragment at all (Invariant K);
//   - a deleted conversation takes its fragments with it.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { MeiliSearch } from "meilisearch"
import {
  MailSearchEnrichmentTestAccess,
  registerMailSearchEnrichment,
} from "~/apps/mail/search-enrichment"
import { extractRows } from "~/db"
import * as privilegedModule from "~/db/privileged"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { entityRegistry } from "~/modules/apps/app-registries"
import { ContentSuppressionTestAccess } from "~/modules/mailbox-crypto/content-suppression"
import { SearchDriftTestAccess } from "~/modules/search/drift"
import { processIndexerJob } from "~/modules/search/indexer"
import { flushLiveIndexOnce, LiveIndexTestAccess } from "~/modules/search/live-index-queue"
import { globalSearch, pageSearch, resolveMailConversationMatches } from "~/modules/search/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const READ = "mail:conversations:read"
const INDEX = `test_mailfrag_${crypto.randomUUID().slice(0, 8)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

let orgId = ""
let owner = ""
let other = ""
const account = {
  personal: crypto.randomUUID(),
  sealed: crypto.randomUUID(),
  org: crypto.randomUUID(),
}
const conv = { long: crypto.randomUUID(), sealed: crypto.randomUUID(), org: crypto.randomUUID() }
const spies: Array<{ mockRestore: () => void }> = []

async function insertMessage(
  convId: string,
  accountId: string,
  ownerId: string | null,
  i: number,
  body: string,
) {
  const [row] = await withSystemDb("mailfrag-msg", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.messages
          (org_id, conversation_id, account_id, external_message_id, message_references,
           from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body,
           html_body, snippet, is_read, is_starred, labels, direction, raw_headers, owner_type,
           owner_id, sent_at)
        VALUES (${orgId}::uuid, ${convId}::uuid, ${accountId}::uuid, ${`m-${convId}-${i}`}, '[]',
                '{"name":"Claudine Mercier","email":"claudine@example.test"}'::jsonb,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Pallet schedule', ${body}, null, null,
                false, false, '[]'::jsonb, 'inbound', '{}'::jsonb,
                ${ownerId ? "user" : "org"}, ${ownerId}::uuid,
                ${new Date(Date.UTC(2026, 8, 1, 9, i)).toISOString()}::timestamptz)
        RETURNING id`),
    ),
  )
  return String(row?.id)
}

async function settle(): Promise<void> {
  while ((await flushLiveIndexOnce()) > 0) {}
  for (const uid of Object.keys(await LiveIndexTestAccess.ledger())) {
    await meili.tasks.waitForTask(Number(uid))
  }
}

async function emitMessageCreated(messageId: string) {
  await MailSearchEnrichmentTestAccess.handler({
    event: {
      app: "mail",
      entity: "message",
      action: "create",
      orgId,
      entityId: messageId,
      data: { id: messageId },
    },
  } as never)
}

const messageIds: Record<string, string[]> = { long: [], sealed: [], org: [] }

beforeAll(async () => {
  const u = await minimal.person((await createTestOrg()).id)
  orgId = u.orgId
  owner = u.id
  other = (await minimal.person(orgId)).id
  process.env.GOOGLE_API_KEY = ""

  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
  SearchDriftTestAccess.setSearchReady(true)
  await LiveIndexTestAccess.clear()

  // The mail conversation as the manifest registers it.
  entityRegistry.set([orgId, "mail", "conversation"], {
    searchable: true,
    tableName: "conversations",
    readScope: READ,
    labelField: "subject",
    indexFields: { title: "subject", labelSecondary: "from_email" },
    permissionFields: { readScope: READ, participantIdsField: "owner_id" },
  } as never)
  registerMailSearchEnrichment()

  const { expectedSettings } = await import("~/modules/search/drift")
  const { collectSearchableRegistrations } = await import("~/modules/search/searchable-entities")
  const regs = collectSearchableRegistrations(orgId)
  const created = await meili.createIndex(INDEX, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili.index(INDEX).updateSettings(
    expectedSettings({
      registeredReadScopes: regs.registeredReadScopes,
      dimensionFields: regs.dimensionFields,
      aclFieldNames: regs.aclFieldNames,
    }),
  )
  await meili.tasks.waitForTask(applied.taskUid)

  await withSystemDb("mailfrag-fixture", async (tx) => {
    for (const [id, ownerType, ownerId, state] of [
      [account.personal, "user", owner, "none"],
      [account.sealed, "user", owner, "ready"],
      [account.org, "org", null, "none"],
    ] as Array<[string, string, string | null, string]>) {
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
                ${ownerId}, 'gmail', ${`${id}@frag.test`}, 'active', ${state})`)
    }
    for (const [id, acct, ownerId] of [
      [conv.long, account.personal, owner],
      [conv.sealed, account.sealed, owner],
      [conv.org, account.org, null],
    ] as Array<[string, string, string | null]>) {
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
           status, labels, is_read, is_starred, message_count, from_email)
        VALUES (${id}::uuid, ${orgId}::uuid, ${acct}::uuid, ${ownerId ? "user" : "org"},
                ${ownerId}::uuid, ${`t-${id}`}, 'Pallet schedule', null, 'open', '[]',
                false, false, 1, 'claudine@example.test')`)
    }
  })
  // A long personal conversation: 60 messages, one of them the only one saying
  // "sturgeon"; a sealed one saying "sturgeon" too; an org one saying "osprey".
  for (let i = 0; i < 60; i++) {
    const body = i === 17 ? "the sturgeon quota for October" : `routine update ${i}`
    messageIds.long.push(await insertMessage(conv.long, account.personal, owner, i, body))
  }
  messageIds.sealed.push(
    await insertMessage(conv.sealed, account.sealed, owner, 0, "sealed sturgeon VELLUMFRAGNONCE"),
  )
  messageIds.org.push(await insertMessage(conv.org, account.org, null, 0, "the osprey invoice"))
  ContentSuppressionTestAccess.resetCache()

  for (const c of Object.values(conv)) {
    await processIndexerJob({
      action: "upsert",
      orgId,
      app: "mail",
      entityType: "conversation",
      entityId: c,
    })
  }
  for (const id of [...messageIds.long, ...messageIds.sealed, ...messageIds.org]) {
    await emitMessageCreated(id)
  }
  await settle()
}, 120_000)

afterAll(async () => {
  for (const s of spies) s.mockRestore()
  SearchDriftTestAccess.resetSearchReady()
  entityRegistry.delete([orgId, "mail", "conversation"])
  await LiveIndexTestAccess.clear()
  await withSystemDb("mailfrag-cleanup", async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
    await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
    await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
  })
  const deleted = await meili.deleteIndex(INDEX)
  await meili.tasks.waitForTask(deleted.taskUid)
})

const who = (userId: string) => ({
  orgId,
  userId,
  scopes: [READ],
  dimensionGrants: {},
  roleIds: [],
})

describe("mail search documents are built from the rows that changed", () => {
  it("a conversation document reads O(1) rows, however many messages the conversation holds", async () => {
    let rowsRead = 0
    const real = privilegedModule.withPrivilegedDb
    const spy = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation((async (
      org: string,
      purpose: string,
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      real(org, purpose, (tx) =>
        fn(
          new Proxy(tx as object, {
            get(target, prop) {
              const value = (target as Record<string | symbol, unknown>)[prop]
              if (prop !== "execute" || typeof value !== "function") return value
              return async (q: unknown) => {
                const r = await (value as (q: unknown) => Promise<unknown>).call(target, q)
                rowsRead += extractRows(r).length
                return r
              }
            },
          }),
        ),
      )) as never)
    try {
      await processIndexerJob({
        action: "upsert",
        orgId,
        app: "mail",
        entityType: "conversation",
        entityId: conv.long,
      })
    } finally {
      spy.mockRestore()
    }
    // The conversation row, its suppression answer. It used to read its newest
    // 50 message bodies here, on every message of a sync.
    expect(rowsRead).toBeLessThanOrEqual(3)
    const doc = (await meili
      .index(INDEX)
      .getDocument(`${orgId}_mail_conversation_${conv.long}`)) as Record<string, unknown>
    expect(String(doc.body ?? "")).not.toContain("routine update")
  })

  it("a message's text finds its conversation, reported AS the conversation, once", async () => {
    const res = await globalSearch({ ...who(owner), q: "sturgeon quota", limit: 10 })
    expect(res.entities.map((e) => [e.app, e.entityType, e.id])).toEqual([
      ["mail", "conversation", conv.long],
    ])
    const page = await pageSearch({
      ...who(owner),
      q: "routine update",
      limit: 20,
      offset: 0,
      filters: {},
      entityType: ["conversation"],
    })
    // 60 matching fragments collapse to their one conversation.
    expect(page.hits.map((h) => h.entity_id)).toEqual([conv.long])
    expect(page.hits[0]?.entity_type).toBe("conversation")
    expect(page.total).toBe(1)
    const ids = await resolveMailConversationMatches({ ...who(owner), q: "sturgeon" })
    expect(ids).toEqual([conv.long])
  })

  it("a fragment is found only by the searchers its conversation admits", async () => {
    // The personal conversation's owner finds it by a message's words; another
    // member of the same org, with the same read scope, does not.
    expect(await resolveMailConversationMatches({ ...who(other), q: "sturgeon" })).toEqual([])
    const res = await globalSearch({ ...who(other), q: "sturgeon quota", limit: 10 })
    expect(res.entities).toEqual([])
    // An org mailbox conversation is readable by both, fragments included.
    expect(await resolveMailConversationMatches({ ...who(other), q: "osprey" })).toEqual([conv.org])
    // Without the read scope, nothing at all.
    expect(
      await resolveMailConversationMatches({
        ...who(owner),
        scopes: ["kernel:threads:read"],
        q: "osprey",
      }),
    ).toEqual([])
  })

  it("a sealed mailbox contributes no fragment: its words are nowhere in the index", async () => {
    const all = await meili
      .index(INDEX)
      .getDocuments({ filter: `org_id = "${orgId}"`, limit: 1000 })
    expect(JSON.stringify(all.results)).not.toContain("VELLUMFRAGNONCE")
    const fragment = await meili
      .index(INDEX)
      .getDocument(`${orgId}_mail_message_${messageIds.sealed[0]}`)
      .catch(() => null)
    expect(fragment).toBeNull()
  })

  it("a deleted conversation takes its fragments with it", async () => {
    await MailSearchEnrichmentTestAccess.handler({
      event: {
        app: "mail",
        entity: "conversation",
        action: "delete",
        orgId,
        entityId: conv.org,
        data: { id: conv.org },
      },
    } as never)
    await settle()
    const left = await meili.index(INDEX).getDocuments({
      filter: `org_id = "${orgId}" AND parent_type = "conversation" AND dedupe_key = "${orgId}_mail_conversation_${conv.org}"`,
    })
    expect(left.results).toEqual([])
    // The other conversations' fragments are untouched.
    expect(await resolveMailConversationMatches({ ...who(owner), q: "sturgeon" })).toEqual([
      conv.long,
    ])
  })
})
