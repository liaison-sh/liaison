// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for collections.ts (T2) and createKnowledgeDocument
 * collection/tag wiring (T2 / IC-5). Uses the real DB and RLS pattern from
 * service.integration.test.ts (no plan-referenced setupTestOrg helpers).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  addCollectionMembership,
  archiveKnowledgeCollection,
  createKnowledgeCollection,
  listKnowledgeCollections,
  listKnowledgeCollectionTree,
  loadCollection,
  updateKnowledgeCollection,
} from "~/apps/knowledge/collections"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  type KnowledgeActor,
  knowledgeActorFromContext,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string

const COLL_MANAGE = "knowledge:collections:manage"
const TAG_MANAGE = "knowledge:tags:manage"
const DOC_CREATE = "knowledge:documents:create"
const DOC_READ = "knowledge:documents:read"

function actor(
  userId: string,
  scopes: string[],
  grants: Record<string, string[]> = {},
): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: grants })
}

function rlsCtx(userId: string, scopes: string[], grants: Record<string, string[]> = {}) {
  return { actorType: "user" as const, orgId, userId, scopes, dimensionGrants: grants }
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-collections-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeCollectionsIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@coll.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id

  const [b] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@coll.test`}, 'Bob', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  bob = b!.id
})

afterAll(releaseTestLock)

describe("collections.ts (DB integration)", () => {
  it("creates an org-local collection (orgId from actor)", async () => {
    const a = actor(alice, [COLL_MANAGE, DOC_READ])
    const result = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      createKnowledgeCollection(tx, { name: "Engineering" }, a),
    )
    expect(result.orgId).toBe(orgId)
    expect(result.name).toBe("Engineering")
    // ownerUserId defaults to the caller when omitted (personal collection).
    expect(result.ownerUserId).toBe(alice)
  })

  it("creates an org-shared collection when ownerUserId is explicitly null", async () => {
    const a = actor(alice, [COLL_MANAGE, DOC_READ])
    const result = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      createKnowledgeCollection(tx, { name: "Org Wiki", ownerUserId: null }, a),
    )
    // Explicit null → org-shared (powers the Personal/Shared split in the
    // Knowledge sidebar). Nullish coalescing on the server would collapse
    // this back to the caller, which is the bug this test guards against.
    expect(result.ownerUserId).toBeNull()
  })

  it("rejects creation without knowledge:collections:manage scope", async () => {
    const a = actor(alice, [DOC_READ])
    await expect(
      withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
        createKnowledgeCollection(tx, { name: "X" }, a),
      ),
    ).rejects.toThrow(/Forbidden/i)
  })

  it("rejects cycle in parent_collection_id (DB trigger)", async () => {
    const a = actor(alice, [COLL_MANAGE, DOC_READ])
    const colA = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      createKnowledgeCollection(tx, { name: "A-cycle" }, a),
    )
    const colB = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      createKnowledgeCollection(tx, { name: "B-cycle", parentCollectionId: colA.id }, a),
    )
    await expect(
      withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
        updateKnowledgeCollection(tx, colA.id, { parentCollectionId: colB.id }, a),
      ),
    ).rejects.toThrow(/cycle|invalid|parent/i)
  })

  it("archives a collection and excludes it from listKnowledgeCollections", async () => {
    const a = actor(alice, [COLL_MANAGE, DOC_READ])
    const coll = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      createKnowledgeCollection(tx, { name: "ToArchive" }, a),
    )
    await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      archiveKnowledgeCollection(tx, coll.id, a),
    )
    const listed = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      listKnowledgeCollections(tx, a),
    )
    expect(listed.some((c) => c.id === coll.id)).toBe(false)
  })

  it("loadCollection answers not-found for a non-uuid id without aborting the transaction", async () => {
    // Live QA 2026-09-23: an agent passed collectionId "none" to knowledge:create;
    // the ::uuid cast raised 22P02, aborted the tx and surfaced raw SQL to the
    // agent instead of the create's own "collection_not_found + list" answer.
    const a = actor(alice, [COLL_MANAGE, DOC_READ])
    const { missing, listed } = await withRlsContext(rlsCtx(alice, a.scopes), async (tx) => ({
      missing: await loadCollection(tx, "none", a),
      // Same tx, next statement: the create path lists collections right after.
      listed: await listKnowledgeCollections(tx, a),
    }))
    expect(missing).toBeNull()
    expect(Array.isArray(listed)).toBe(true)
  })

  it("addCollectionMembership rejects target the actor cannot read", async () => {
    // Alice creates a personal doc (only she can read it)
    const aliceA = actor(alice, [DOC_CREATE, DOC_READ, COLL_MANAGE])
    const personalDoc = await withRlsContext(rlsCtx(alice, aliceA.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "personal",
          title: "Alice secret",
          body: "",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        aliceA,
        [],
      ),
    )
    // Bob creates a collection then tries to add Alice's personal doc as member
    const bobA = actor(bob, [COLL_MANAGE, DOC_READ])
    const bobColl = await withRlsContext(rlsCtx(bob, bobA.scopes), (tx) =>
      createKnowledgeCollection(tx, { name: "Bob coll" }, bobA),
    )
    await expect(
      withRlsContext(rlsCtx(bob, bobA.scopes), (tx) =>
        addCollectionMembership(
          tx,
          { collectionId: bobColl.id, targetType: "document", targetId: personalDoc.id },
          bobA,
        ),
      ),
    ).rejects.toThrow(/not found|forbidden/i)
  })

  it("createKnowledgeDocument(collectionIds, tagNames) inserts memberships and taggings (IC-5)", async () => {
    const a = actor(alice, [DOC_CREATE, DOC_READ, COLL_MANAGE, TAG_MANAGE], {
      sensitivity: ["internal"],
      team: ["*"],
    })
    const coll = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      createKnowledgeCollection(tx, { name: "Onboarding-IC5" }, a),
    )
    const doc = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Welcome IC5",
          body: "",
          collectionIds: [coll.id],
          tagNames: ["onboarding-ic5", "engineering-ic5"],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        a,
        [],
      ),
    )

    const memberships = await withRlsContext(
      rlsCtx(alice, a.scopes, a.dimensionGrants),
      async (tx) => {
        const r = await tx.execute(sql`
          SELECT collection_id FROM ${knowledgeRel("collection_memberships")}
          WHERE target_type = 'document' AND target_id = ${doc.id}::uuid
        `)
        return extractRows<{ collection_id: string }>(r)
      },
    )
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.collection_id).toBe(coll.id)

    const taggings = await withRlsContext(
      rlsCtx(alice, a.scopes, a.dimensionGrants),
      async (tx) => {
        const r = await tx.execute(sql`
          SELECT t.normalized_name FROM ${knowledgeRel("taggings")} tg
          JOIN ${knowledgeRel("tags")} t ON t.id = tg.tag_id
          WHERE tg.target_type = 'document' AND tg.target_id = ${doc.id}::uuid
          ORDER BY t.normalized_name
        `)
        return extractRows<{ normalized_name: string }>(r)
      },
    )
    expect(taggings.map((r) => r.normalized_name)).toEqual(["engineering-ic5", "onboarding-ic5"])
  })

  it("listKnowledgeCollectionTree returns nested collections with document memberships", async () => {
    const a = actor(alice, [DOC_CREATE, DOC_READ, COLL_MANAGE], {
      sensitivity: ["internal"],
      team: ["*"],
    })
    const root = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      createKnowledgeCollection(tx, { name: `Tree-root-${Date.now()}` }, a),
    )
    const child = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      createKnowledgeCollection(tx, { name: "Tree-child", parentCollectionId: root.id }, a),
    )
    const doc = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Tree-doc",
          body: "",
          collectionIds: [child.id],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        a,
        [],
      ),
    )

    const tree = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      listKnowledgeCollectionTree(tx, a),
    )
    const rootNode = tree.find((n) => n.id === root.id)
    expect(rootNode).toBeDefined()
    expect(rootNode!.children.some((ch) => ch.id === child.id)).toBe(true)
    const childNode = rootNode!.children.find((ch) => ch.id === child.id)!
    expect(childNode.documents.some((d) => d.id === doc.id && d.title === "Tree-doc")).toBe(true)
  })

  it("listKnowledgeCollectionTree exposes visible unfiled documents under a virtual root", async () => {
    const a = actor(alice, [DOC_CREATE, DOC_READ, COLL_MANAGE], {
      sensitivity: ["internal"],
      team: ["*"],
    })
    // Personal-scope orphan → __personal_notes__ virtual bucket (owned by
    // caller, surfaces under the sidebar's Personal section).
    const personalDoc = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "personal",
          title: "Loose-note",
          body: "",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        a,
        [],
      ),
    )
    // Org-scope orphan → __unfiled__ virtual bucket (shared section).
    const orgOrphan = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Org-orphan",
          body: "",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        a,
        [],
      ),
    )
    const tree = await withRlsContext(rlsCtx(alice, a.scopes, a.dimensionGrants), (tx) =>
      listKnowledgeCollectionTree(tx, a),
    )
    const personalNotes = tree.find((n) => n.id === "__personal_notes__")
    expect(personalNotes).toBeDefined()
    expect(personalNotes!.virtual).toBe(true)
    expect(personalNotes!.ownerUserId).toBe(alice)
    expect(personalNotes!.documents.some((d) => d.id === personalDoc.id)).toBe(true)

    const unfiled = tree.find((n) => n.id === "__unfiled__")
    expect(unfiled).toBeDefined()
    expect(unfiled!.virtual).toBe(true)
    expect(unfiled!.ownerUserId).toBeNull()
    expect(unfiled!.documents.some((d) => d.id === orgOrphan.id)).toBe(true)
    // Personal-scope doc must NOT appear in the org Unfiled bucket.
    expect(unfiled!.documents.some((d) => d.id === personalDoc.id)).toBe(false)
  })
})
