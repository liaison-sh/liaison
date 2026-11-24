// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What leaves a folder change: the event names nobody and no folder, only who it
 * concerns; the audit log keeps ids; a routine hears only of what its owner sees.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  addCollectionMembership,
  archiveKnowledgeCollection,
  createKnowledgeCollection,
  removeCollectionMembership,
  updateKnowledgeCollection,
} from "~/apps/knowledge/collections"
import {
  createKnowledgeDocument,
  type KnowledgeActor,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess, runDurableConsumers } from "~/infra/events/durable-consumers"
import { type AppEvent, initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { isOwnerScopedEvent, ownerCanSeeEventEntity } from "~/infra/jobs/event-routine-gate"
import { handleAuditSearch } from "~/modules/agent/tools/admin-tools"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:collections:manage",
]

let orgId: string
let ana: string
let ben: string

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  ana = (await minimal.person(orgId, { name: "Ana" })).id
  ben = (await minimal.person(orgId, { name: "Ben" })).id
})
afterAll(async () => {
  DurableConsumersTestAccess.reset()
  resetEventBus()
  await releaseTestLock()
})

const ctxOf = (userId: string, scopes = SCOPES) => ({
  actorType: "user" as const,
  orgId,
  userId,
  scopes,
  dimensionGrants: { "*": ["*"] },
})

function as<T>(userId: string, fn: (tx: RlsClient, a: KnowledgeActor) => Promise<T>): Promise<T> {
  const ctx = ctxOf(userId)
  return withRlsContext(ctx, (tx) => fn(tx, knowledgeActorFromContext(ctx)))
}

/** The folder events `fn` queued, as the outbox holds them. */
async function emitted(fn: () => Promise<unknown>): Promise<AppEvent[]> {
  const read = async () =>
    extractRows<{ id: string; payload: AppEvent }>(
      await withPrivilegedDb(orgId, "test-folder-events", (tx) =>
        tx.execute(sql`
          SELECT id::text AS id, payload FROM kernel.pending_events
           WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'knowledge'
             AND payload->>'entity' IN ('collection', 'collection_membership')
           ORDER BY created_at, id`),
      ),
    )
  const before = new Set((await read()).map((r) => r.id))
  await fn()
  return (await read()).filter((r) => !before.has(r.id)).map((r) => r.payload)
}

const SECRET = "Ana's severance notes"

async function page(userId: string): Promise<string> {
  const doc = await as(userId, (tx, a) =>
    createKnowledgeDocument(
      tx,
      {
        documentScope: "organization",
        title: "Event page",
        body: "",
        collectionIds: [],
        tagNames: [],
        team: [],
        sensitivity: "internal",
        verifyNow: false,
      },
      a,
      [],
    ),
  )
  return doc.id
}

describe("folder events", () => {
  it("carry ids and who they concern, never a name", async () => {
    let id = ""
    const doc = await page(ana)
    const create = await emitted(async () => {
      id = (
        await as(ana, (tx, a) =>
          createKnowledgeCollection(tx, { name: SECRET, description: SECRET, ownerUserId: ana }, a),
        )
      ).id
    })
    const target = { collectionId: "", targetType: "document" as const, targetId: doc }
    const file = await emitted(() =>
      as(ana, (tx, a) => addCollectionMembership(tx, { ...target, collectionId: id }, a)),
    )
    const rename = await emitted(() =>
      as(ana, (tx, a) => updateKnowledgeCollection(tx, id, { name: `${SECRET} 2` }, a)),
    )
    const share = await emitted(() =>
      as(ana, (tx, a) => updateKnowledgeCollection(tx, id, { ownerUserId: null }, a)),
    )
    const unshare = await emitted(() =>
      as(ana, (tx, a) => updateKnowledgeCollection(tx, id, { ownerUserId: ana }, a)),
    )
    const unfile = await emitted(() =>
      as(ana, (tx, a) => removeCollectionMembership(tx, { ...target, collectionId: id }, a)),
    )
    const remove = await emitted(() => as(ana, (tx, a) => archiveKnowledgeCollection(tx, id, a)))

    const mine = { orgWide: false, wasOrgWide: false, userIds: [ana] }
    expect(create.map((e) => e.data)).toEqual([{ id, ...mine }])
    expect(rename.map((e) => e.data)).toEqual([{ id, ...mine }])
    expect(share.map((e) => e.data)).toEqual([
      { id, orgWide: true, wasOrgWide: false, userIds: [] },
    ])
    expect(unshare.map((e) => e.data)).toEqual([
      { id, orgWide: false, wasOrgWide: true, userIds: [ana] },
    ])
    expect(remove.map((e) => e.data)).toEqual([{ id, ...mine }])
    const membership = { ...target, collectionId: id, orgWide: false, userIds: [ana] }
    expect(file.map((e) => e.data)).toEqual([membership])
    expect(unfile.map((e) => e.data)).toEqual([membership])
    expect(JSON.stringify([create, file, rename, share, unshare, unfile, remove])).not.toContain(
      "severance",
    )
  })

  it("a page moved out of sight tells the readers of the folder it leaves", async () => {
    const doc = await page(ana)
    const from = await as(ana, (tx, a) =>
      createKnowledgeCollection(tx, { name: "Team", ownerUserId: null }, a),
    )
    const to = await as(ana, (tx, a) =>
      createKnowledgeCollection(tx, { name: SECRET, ownerUserId: ana }, a),
    )
    await as(ana, (tx, a) =>
      addCollectionMembership(
        tx,
        { collectionId: from.id, targetType: "document", targetId: doc },
        a,
      ),
    )
    const { moveDocument } = await import("~/apps/knowledge/move")
    const move = await emitted(() =>
      as(ana, (tx, a) =>
        moveDocument(tx, { documentId: doc, fromCollectionId: from.id, toCollectionId: to.id }, a),
      ),
    )
    expect(move.map((e) => e.data)).toEqual([
      {
        collectionId: to.id,
        targetType: "document",
        targetId: doc,
        orgWide: false,
        wasOrgWide: true,
        userIds: [ana],
      },
    ])
  })
})

describe("the audit log", () => {
  it("row has the id, no name, no owner; audit_search by B returns no name", async () => {
    DurableConsumersTestAccess.reset()
    initEventBus()
    registerEventSubscribers()
    let id = ""
    const doc = await page(ana)
    const events = await emitted(async () => {
      id = (
        await as(ana, (tx, a) =>
          createKnowledgeCollection(tx, { name: SECRET, ownerUserId: ana }, a),
        )
      ).id
      await as(ana, (tx, a) =>
        addCollectionMembership(tx, { collectionId: id, targetType: "document", targetId: doc }, a),
      )
    })
    // The shape a previous release queued, drained by this one.
    const old = {
      ...(events[0] as AppEvent),
      action: "update",
      data: { id, name: SECRET, description: SECRET },
    }
    for (const event of [...events, old]) {
      await runDurableConsumers({ eventId: crypto.randomUUID(), event })
    }
    const rows = extractRows<{ entity_type: string; changes: unknown }>(
      await withPrivilegedDb(orgId, "test-folder-audit", (tx) =>
        tx.execute(sql`
          SELECT entity_type, changes FROM kernel.audit_log
           WHERE org_id = ${orgId}::uuid AND app = 'knowledge'
             AND (entity_id = ${id} OR changes->>'collectionId' = ${id})
           ORDER BY timestamp, entity_type`),
      ),
    )
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { entity_type: "collection", changes: { id } },
      {
        entity_type: "collection_membership",
        changes: { collectionId: id, targetType: "document", targetId: doc },
      },
      { entity_type: "collection", changes: { id } },
    ])
    const found = JSON.stringify(
      await handleAuditSearch({ action: "collection", limit: 100 }, { orgId, userId: ben }),
    )
    expect(found).toContain("collection.create")
    expect(found).not.toContain("severance")
  })
})

describe("a routine", () => {
  it("B's routine on collection:create never fires for A's personal folder, and fires for a shared one", async () => {
    const doc = await page(ana)
    const build = (ownerUserId: string | null) =>
      emitted(async () => {
        const f = await as(ana, (tx, a) =>
          createKnowledgeCollection(tx, { name: SECRET, ownerUserId }, a),
        )
        const target = { collectionId: f.id, targetType: "document" as const, targetId: doc }
        await as(ana, (tx, a) => addCollectionMembership(tx, target, a))
        await as(ana, (tx, a) => removeCollectionMembership(tx, target, a))
      })
    const heard = async (userId: string, events: AppEvent[], scopes?: string[]) => {
      const out: boolean[] = []
      for (const e of events) {
        expect(isOwnerScopedEvent(e)).toBe(true)
        out.push(await ownerCanSeeEventEntity(ctxOf(userId, scopes), e as never))
      }
      return out
    }
    const hidden = await build(ana)
    expect(hidden).toHaveLength(3)
    expect(await heard(ben, hidden)).toEqual([false, false, false])
    expect(await heard(ben, hidden, ["*"])).toEqual([false, false, false])
    // The membership is gone by now: its folder decides.
    expect(await heard(ana, hidden)).toEqual([true, true, true])
    expect(await heard(ben, await build(null))).toEqual([true, true, true])
  })
})
