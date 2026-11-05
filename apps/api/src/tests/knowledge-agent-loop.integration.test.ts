// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent loop end-to-end: search → get → create → organize.
 *
 * Exercises the production agent-tool handlers (and, for get, the document read
 * the knowledge_get bridge makes) wired against the live RLS-bound
 * DB (no manifests/sandbox detour). Covers (1) the happy-path multi-step loop
 * for an authorized user, (2) RLS denial when a peer lacks the sensitivity/team
 * grants, and (3) scope denial for collection mutation.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  handleKnowledgeAddToCollection,
  handleKnowledgeCollectionCreate,
  handleKnowledgeCollectionDelete,
  handleKnowledgeCollectionUpdate,
  handleKnowledgeCreate,
  handleKnowledgeRemoveFromCollection,
} from "~/apps/knowledge/agent-tools"
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
  loadKnowledgeDocument,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string

const DOC_READ = "knowledge:documents:read"
const DOC_CREATE = "knowledge:documents:create"
const DOC_UPDATE = "knowledge:documents:update"
const COLL_MANAGE = "knowledge:collections:manage"

function aliceActor(): KnowledgeActor {
  return knowledgeActorFromContext({
    orgId,
    userId: alice,
    scopes: [DOC_READ, DOC_CREATE, DOC_UPDATE, COLL_MANAGE],
    dimensionGrants: { sensitivity: ["confidential"], team: ["engineering"] },
  })
}

function bobActor(scopes: string[] = [DOC_READ]): KnowledgeActor {
  return knowledgeActorFromContext({
    orgId,
    userId: bob,
    scopes,
    dimensionGrants: { sensitivity: ["internal"], team: ["sales"] },
  })
}

function rlsCtx(userId: string, actor: KnowledgeActor) {
  return {
    actorType: "user" as const,
    orgId,
    userId,
    scopes: actor.scopes,
    dimensionGrants: actor.dimensionGrants,
  }
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-agent-loop-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeAgentLoop', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@loop.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id

  const [b] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@loop.test`}, 'Bob', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  bob = b!.id
})

afterAll(releaseTestLock)

describe("Knowledge agent loop", () => {
  it("alice can search, get, create, and organize through agent tools", async () => {
    const actor = aliceActor()

    // Seed: alice creates a personal doc
    const seeded = await withRlsContext(rlsCtx(alice, actor), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "personal",
          title: "Personal deploy notes",
          body: "deploy notes content",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        actor,
        [],
      ),
    )

    // get: the read knowledge_get makes, under the reader's RLS context
    const got = await withRlsContext(rlsCtx(alice, actor), (tx) =>
      loadKnowledgeDocument(tx, seeded.id, actor),
    )
    expect(got?.title).toBe("Personal deploy notes")
    expect(got?.body).toContain("deploy")

    // create (via agent handler)
    const created = await withRlsContext(rlsCtx(alice, actor), (tx) =>
      handleKnowledgeCreate(
        {
          documentScope: "personal",
          title: "Synthesized notes",
          body: "summary",
        } as never,
        {
          actor,
          orgId,
          createDocument: (params: never, a: KnowledgeActor) =>
            createKnowledgeDocument(
              tx,
              { ...(params as object), collectionIds: [], tagNames: [] } as never,
              a,
              [],
            ),
          updateDocument: (params: never, a: KnowledgeActor) =>
            updateKnowledgeDocument(tx, params as never, a, []),
        } as never,
      ),
    )
    expect(created.id).toBeTruthy()

    // organize: collection_create + add_to_collection
    const folder = await withRlsContext(rlsCtx(alice, actor), (tx) =>
      handleKnowledgeCollectionCreate({ name: "deploy-archive" }, {
        actor,
        createCollection: (input: never, a: KnowledgeActor) =>
          createKnowledgeCollection(tx, input, a),
      } as never),
    )
    await withRlsContext(rlsCtx(alice, actor), (tx) =>
      handleKnowledgeAddToCollection(
        { collectionId: folder.id, documentId: created.id as string },
        {
          actor,
          addMembership: (input: never, a: KnowledgeActor) => addCollectionMembership(tx, input, a),
        } as never,
      ),
    )

    // rename + remove + archive
    const renamed = await withRlsContext(rlsCtx(alice, actor), (tx) =>
      handleKnowledgeCollectionUpdate({ id: folder.id, name: "deploy-summaries" }, {
        actor,
        updateCollection: (id: string, patch: never, a: KnowledgeActor) =>
          updateKnowledgeCollection(tx, id, patch, a),
      } as never),
    )
    expect(renamed.name).toBe("deploy-summaries")

    await withRlsContext(rlsCtx(alice, actor), (tx) =>
      handleKnowledgeRemoveFromCollection(
        { collectionId: folder.id, documentId: created.id as string },
        {
          actor,
          removeMembership: (input: never, a: KnowledgeActor) =>
            removeCollectionMembership(tx, input, a),
        } as never,
      ),
    )

    const archived = await withRlsContext(rlsCtx(alice, actor), (tx) =>
      handleKnowledgeCollectionDelete({ id: folder.id }, {
        actor,
        archiveCollection: (id: string, a: KnowledgeActor) => archiveKnowledgeCollection(tx, id, a),
      } as never),
    )
    expect(archived.archivedAt).toBeTruthy()
  })

  it("bob cannot get alice's confidential engineering org doc (RLS)", async () => {
    const aActor = aliceActor()
    const ace = await withRlsContext(rlsCtx(alice, aActor), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Engineering secret",
          body: "encrypt at rest",
          collectionIds: [],
          tagNames: [],
          team: ["engineering"],
          sensitivity: "confidential",
          verifyNow: false,
        } as never,
        aActor,
        [],
      ),
    )

    const bActor = bobActor()
    const seen = await withRlsContext(rlsCtx(bob, bActor), (tx) =>
      loadKnowledgeDocument(tx, ace.id, bActor),
    )
    expect(seen).toBeNull()
  })

  it("bob cannot archive a collection without knowledge:collections:manage", async () => {
    const aActor = aliceActor()
    const folder = await withRlsContext(rlsCtx(alice, aActor), (tx) =>
      createKnowledgeCollection(tx, { name: "Alice-only" }, aActor),
    )
    const bActor = bobActor([DOC_READ]) // no COLL_MANAGE
    await expect(
      withRlsContext(rlsCtx(bob, bActor), (tx) =>
        handleKnowledgeCollectionDelete({ id: folder.id }, {
          actor: bActor,
          archiveCollection: (id: string, a: KnowledgeActor) =>
            archiveKnowledgeCollection(tx, id, a),
        } as never),
      ),
    ).rejects.toThrow(/knowledge:collections:manage/i)
  })
})
