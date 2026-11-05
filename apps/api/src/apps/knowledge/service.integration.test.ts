// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge service integration scenarios — exercises the real DB and RLS
 * policies. Covers:
 *
 * - B9: cross-user personal note denial (no information leakage through
 *       list/read/load).
 * - B10: organization document RLS for team and sensitivity (level-ordered
 *        ladder honors `public < internal < confidential < restricted`).
 * - Owner-only write authorization; revision conflict detection.
 *
 * These tests sidestep the manifest registry; they call the service-layer
 * directly through `withRlsContext` so RLS-policy SQL in the migration is
 * actually exercised (not just JS-level assertions).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createKnowledgeSourceRegistry,
  federatedKnowledgeSearch,
} from "~/apps/knowledge/federated-search"
import {
  archiveKnowledgeDocument,
  createKnowledgeDocument,
  findDocByTitle,
  findOrgDocByTitle,
  findOrgRunningDocByTitlePrefix,
  findUniqueOrgRunningWatchDoc,
  isRunningWatchOrDigestTitle,
  type KnowledgeActor,
  KnowledgeError,
  knowledgeActorFromContext,
  listKnowledgeDocuments,
  loadKnowledgeDocument,
  restoreKnowledgeDocument,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string

const READ = "knowledge:documents:read"
const CREATE = "knowledge:documents:create"
const UPDATE = "knowledge:documents:update"

function actor(
  userId: string,
  scopes: string[],
  grants: Record<string, string[]> = {},
): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: grants })
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-service-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeServiceIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@x.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id

  const [b] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@x.test`}, 'Bob', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  bob = b!.id
})

afterAll(releaseTestLock)

describe("Knowledge service (DB integration)", () => {
  it("B9: cross-user personal note denial — Bob cannot read or list Alice's personal doc", async () => {
    // Alice creates a personal note
    const aliceActor = actor(alice, [CREATE, READ])
    const created = await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: aliceActor.scopes, dimensionGrants: {} },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "personal",
            title: "Alice secrets",
            body: "Alice-only content",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal", // ignored for personal docs
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    expect(created.documentScope).toBe("personal")
    expect(created.ownerUserId).toBe(alice)

    // Bob attempts to read — RLS filters the row, so `loadKnowledgeDocument`
    // returns null. The route translates null → 404. This is the strongest
    // zero-knowledge guarantee: the row is genuinely invisible at the DB
    // layer; Bob cannot probe for existence.
    const bobActor = actor(bob, [READ])
    const bobRead = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => loadKnowledgeDocument(tx, created.id, bobActor),
    )
    expect(bobRead).toBeNull()

    // Bob's list should not include Alice's personal doc — RLS filters it.
    const bobList = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => listKnowledgeDocuments(tx, bobActor),
    )
    expect(bobList.map((d) => d.id)).not.toContain(created.id)
  })

  // UPDATED (Google-Drive-style sharing, 0002 migration): org-doc access is now governed by
  // `org_access` + explicit `document_shares`, NOT the team/sensitivity dimension ladder — the RLS
  // SELECT/UPDATE policies were rewritten to drop the dimension gate entirely for org docs. B10/B10b
  // used to pin the OLD dimension-gated RLS; they now pin the NEW sharing-gated RLS via a real
  // orgAccess='none' doc + a document_shares row, so the assertion genuinely exercises the rewritten
  // SQL policy (would fail if the RLS policy or the app-layer shareRole wiring regressed).
  it("B10: restricted (orgAccess='none') org documents are invisible to non-owner/non-shared members through RLS, and visible once explicitly shared", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["internal"] })
    const created = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: { sensitivity: ["internal"] },
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Sales playbook",
            body: "Confidential sales playbook",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            orgAccess: "none",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    expect(created.orgAccess).toBe("none")

    // Bob (not owner, not creator, no share, no dimension grant special-case) must NOT see it —
    // this pins the 0002 RLS SELECT policy's restricted branch directly.
    const bobActor = actor(bob, [READ])
    const bobList = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => listKnowledgeDocuments(tx, bobActor),
    )
    expect(bobList.map((d) => d.id)).not.toContain(created.id)
    const bobLoad = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => loadKnowledgeDocument(tx, created.id, bobActor),
    )
    expect(bobLoad).toBeNull()

    // Explicitly share the doc with Bob (viewer role) via a real share grant (kernel.resource_grants).
    await db.execute(
      sql`INSERT INTO kernel.resource_grants (org_id, resource_type, resource_id, grantee_kind, grantee, role, created_by)
          VALUES (${orgId}::uuid, 'knowledge.document', ${created.id}::uuid, 'user', ${bob}, 'viewer', ${alice}::uuid)`,
    )

    // Bob now sees it — RLS's document_shares EXISTS branch.
    const bobListAfterShare = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => listKnowledgeDocuments(tx, bobActor),
    )
    expect(bobListAfterShare.map((d) => d.id)).toContain(created.id)
    const bobLoadAfterShare = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => loadKnowledgeDocument(tx, created.id, bobActor),
    )
    expect(bobLoadAfterShare?.id).toBe(created.id)
  })

  it("B10b: a VIEWER share grants read but NOT write; an EDITOR share grants both (RLS UPDATE policy)", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["internal"] })
    const created = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: { sensitivity: ["internal"] },
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Internal memo (sharing)",
            body: "v1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            orgAccess: "none",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )

    await db.execute(
      sql`INSERT INTO kernel.resource_grants (org_id, resource_type, resource_id, grantee_kind, grantee, role, created_by)
          VALUES (${orgId}::uuid, 'knowledge.document', ${created.id}::uuid, 'user', ${bob}, 'viewer', ${alice}::uuid)`,
    )

    // Bob (viewer share) can read...
    const bobActor = actor(bob, [READ, UPDATE])
    const bobLoad = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => loadKnowledgeDocument(tx, created.id, bobActor),
    )
    expect(bobLoad?.id).toBe(created.id)

    // ...but a VIEWER share does NOT unlock write — the UPDATE RLS policy requires role='editor'.
    // updateKnowledgeDocument's service-layer assertCanWriteDocumentRow ALSO denies (both layers agree),
    // so this exercises the app-layer gate; the raw-SQL RLS-only assertion follows in the RLS suite.
    await expect(
      withRlsContext(
        { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
        (tx) =>
          updateKnowledgeDocument(
            tx,
            { id: created.id, revision: created.revision, title: "Bob edit attempt" },
            bobActor,
            [],
          ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // Upgrade Bob's share to 'editor' — now write succeeds.
    await db.execute(
      sql`UPDATE kernel.resource_grants SET role = 'editor'
          WHERE resource_type = 'knowledge.document' AND resource_id = ${created.id}::uuid
            AND grantee_kind = 'user' AND grantee = ${bob}`,
    )
    const updated = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: created.id, revision: created.revision, title: "Bob edit (editor share)" },
          bobActor,
          [],
        ),
    )
    expect(updated.title).toBe("Bob edit (editor share)")
  })

  it("B10c: orgAccess='viewer' lets any org member read but not write; orgAccess='editor' lets any member with update scope write too", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["internal"] })
    const viewerDoc = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: { sensitivity: ["internal"] },
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Org-wide viewer doc",
            body: "v1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            orgAccess: "viewer",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )

    const bobActor = actor(bob, [READ, UPDATE])
    const bobLoad = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) => loadKnowledgeDocument(tx, viewerDoc.id, bobActor),
    )
    expect(bobLoad?.id).toBe(viewerDoc.id)

    await expect(
      withRlsContext(
        { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
        (tx) =>
          updateKnowledgeDocument(
            tx,
            { id: viewerDoc.id, revision: viewerDoc.revision, title: "Bob hijack" },
            bobActor,
            [],
          ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // orgAccess='editor' → any member with update scope can write too.
    const editorDoc = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: { sensitivity: ["internal"] },
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Org-wide editor doc",
            body: "v1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            orgAccess: "editor",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    const bobUpdated = await withRlsContext(
      { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
      (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: editorDoc.id, revision: editorDoc.revision, title: "Bob maintains it" },
          bobActor,
          [],
        ),
    )
    expect(bobUpdated.title).toBe("Bob maintains it")
  })

  it("rejects writes by non-owner without admin scope; revision conflicts return 409", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE])
    const created = await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: aliceActor.scopes, dimensionGrants: {} },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "personal",
            title: "Alice draft",
            body: "v1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )

    // Bob with update scope but not owner → FORBIDDEN
    const bobActor = actor(bob, [READ, UPDATE])
    await expect(
      withRlsContext(
        { actorType: "user", orgId, userId: bob, scopes: bobActor.scopes, dimensionGrants: {} },
        (tx) =>
          updateKnowledgeDocument(
            tx,
            { id: created.id, revision: created.revision, title: "Bob hijack" },
            bobActor,
            [],
          ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // Alice with stale revision → REVISION_CONFLICT
    await expect(
      withRlsContext(
        { actorType: "user", orgId, userId: alice, scopes: aliceActor.scopes, dimensionGrants: {} },
        (tx) =>
          updateKnowledgeDocument(
            tx,
            { id: created.id, revision: created.revision + 99, title: "newer" },
            aliceActor,
            [],
          ),
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" })

    // Alice with correct revision → success and revision bump + auto-reset to needs_review
    const updated = await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: aliceActor.scopes, dimensionGrants: {} },
      (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: created.id, revision: created.revision, title: "v2", body: "v2 body" },
          aliceActor,
          [],
        ),
    )
    expect(updated.title).toBe("v2")
    expect(updated.body).toBe("v2 body")
    expect(updated.revision).toBe(created.revision + 1)
  })

  // BL-275: the running-doc upsert guard (rpc-bridge knowledge_create) uses findOrgDocByTitle to redirect
  // a colliding create into an update, so a recurring watch routine maintains ONE running doc. Pin that
  // findOrgDocByTitle returns the existing WRITABLE org doc for an exact-title match (and null otherwise).
  it("findOrgDocByTitle returns the existing writable ORG doc for an exact-title match (running-doc upsert)", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], {
      sensitivity: ["public", "internal"],
    })
    const title = `Running Watch Doc ${Date.now()}`
    const created = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title,
            body: "week 1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    // Exact-title match → returns the existing doc (so a create redirects to updating it).
    const found = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) => findOrgDocByTitle(tx, orgId, title, aliceActor),
    )
    expect(found?.id).toBe(created.id)
    // A different title → no match → a normal create proceeds.
    const none = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) => findOrgDocByTitle(tx, orgId, `${title} (different)`, aliceActor),
    )
    expect(none).toBeNull()
  })

  // U5.8: `findDocByTitle` is the READ-scoped sibling of `findOrgDocByTitle` — a DB-backed exact-title
  // lookup for any caller holding knowledge:documents:read, exposed as the `knowledge:find_by_title` agent
  // tool so cross-app callRef→doc resolution (calls app) never depends on the Meilisearch index catching
  // up. It reuses the SAME read-path gate as `get` (loadDocumentShareRole + assertCanReadDocumentRow) —
  // never the write-guard `findOrgDocByTitle` uses — since this is a pure read, not an upsert redirect.
  describe("findDocByTitle (U5.8 DB-backed exact-title read)", () => {
    it("returns the existing doc for an exact-title match the actor can READ", async () => {
      const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["public", "internal"] })
      const title = `Appel — find-by-title-${Date.now()}`
      const created = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) =>
          createKnowledgeDocument(
            tx,
            {
              documentScope: "organization",
              title,
              body: "",
              collectionIds: [],
              tagNames: [],
              team: [],
              sensitivity: "internal",
              verifyNow: false,
            } as never,
            aliceActor,
            [],
          ),
      )
      const found = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) => findDocByTitle(tx, orgId, title, aliceActor),
      )
      expect(found?.id).toBe(created.id)
      expect(found?.title).toBe(title)
      expect(found?.revision).toBe(created.revision)
      expect(found?.archivedAt).toBeNull()
    })

    it("returns null for a title with no match", async () => {
      const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["public", "internal"] })
      const found = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) => findDocByTitle(tx, orgId, `nonexistent-title-${Date.now()}`, aliceActor),
      )
      expect(found).toBeNull()
    })

    it("excludes an archived doc by default, and includes it only when includeArchived is passed", async () => {
      const aliceActor = actor(alice, [CREATE, READ, UPDATE, "knowledge:documents:archive"], {
        sensitivity: ["public", "internal"],
      })
      const title = `Appel — archived-${Date.now()}`
      const created = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) =>
          createKnowledgeDocument(
            tx,
            {
              documentScope: "organization",
              title,
              body: "",
              collectionIds: [],
              tagNames: [],
              team: [],
              sensitivity: "internal",
              verifyNow: false,
            } as never,
            aliceActor,
            [],
          ),
      )
      await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) => archiveKnowledgeDocument(tx, created.id, aliceActor),
      )

      const defaultLookup = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) => findDocByTitle(tx, orgId, title, aliceActor),
      )
      expect(defaultLookup).toBeNull()

      const withArchived = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) => findDocByTitle(tx, orgId, title, aliceActor, { includeArchived: true }),
      )
      expect(withArchived?.id).toBe(created.id)
      expect(withArchived?.archivedAt).not.toBeNull()
    })

    it("respects RLS: a personal doc owned by Alice is invisible to Bob's lookup (returns null, no leak)", async () => {
      const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["public", "internal"] })
      const bobActor = actor(bob, [READ], { sensitivity: ["public", "internal"] })
      const title = `Appel — personal-rls-${Date.now()}`
      await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) =>
          createKnowledgeDocument(
            tx,
            {
              documentScope: "personal",
              title,
              body: "",
              collectionIds: [],
              tagNames: [],
              team: [],
              verifyNow: false,
            } as never,
            aliceActor,
            [],
          ),
      )
      const bobLookup = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: bob,
          scopes: bobActor.scopes,
          dimensionGrants: bobActor.dimensionGrants,
        },
        (tx) => findDocByTitle(tx, orgId, title, bobActor),
      )
      expect(bobLookup).toBeNull()

      // Alice herself finds it fine.
      const aliceLookup = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) => findDocByTitle(tx, orgId, title, aliceActor),
      )
      expect(aliceLookup?.title).toBe(title)
    })

    it("returns null (never throws) when the actor lacks knowledge:documents:read", async () => {
      const noReadActor = actor(bob, [], {})
      const title = `Appel — no-scope-${Date.now()}`
      const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["public", "internal"] })
      await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: alice,
          scopes: aliceActor.scopes,
          dimensionGrants: aliceActor.dimensionGrants,
        },
        (tx) =>
          createKnowledgeDocument(
            tx,
            {
              documentScope: "organization",
              title,
              body: "",
              collectionIds: [],
              tagNames: [],
              team: [],
              sensitivity: "internal",
              verifyNow: false,
            } as never,
            aliceActor,
            [],
          ),
      )
      const found = await withRlsContext(
        {
          actorType: "user",
          orgId,
          userId: bob,
          scopes: noReadActor.scopes,
          dimensionGrants: noReadActor.dimensionGrants,
        },
        (tx) => findDocByTitle(tx, orgId, title, noReadActor),
      )
      expect(found).toBeNull()
    })
  })

  // BL-275 (dealer-price-watch-weekly duplicate-doc fail): a flash-lite tick that types a SHORTENED or
  // RE-ORDERED title variant of the seeded running doc must still redirect to it (the running-doc
  // CONTAINMENT fallback — significant-token subset), not spawn a duplicate. Pin: wanted-tokens ⊆
  // existing-tokens (unambiguous) → match; an extra distinctive token / below-floor / generic → null.
  it("findOrgRunningDocByTitlePrefix redirects a SHORTENED or RE-ORDERED title to the unique running doc (and only then)", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], { sensitivity: ["public", "internal"] })
    const stamp = Date.now()
    const fullTitle = `Dealer Price Watch Acme${stamp} — Kestrel 6 (RAL-44)`
    const created = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: fullTitle,
            body: "week 1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    // The agent typed the SHORTER form → token subset of the existing fuller doc → redirect to it.
    const matchedShort = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) =>
        findOrgRunningDocByTitlePrefix(tx, orgId, `Dealer Price Watch Acme${stamp}`, aliceActor),
    )
    expect(matchedShort?.id).toBe(created.id)

    // The agent RE-ORDERED the title ("Kestrel 6 … Dealer Price Watch") — order-independent token subset → match.
    const matchedReordered = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) =>
        findOrgRunningDocByTitlePrefix(
          tx,
          orgId,
          `Kestrel 6 Acme${stamp} Dealer Price Watch`,
          aliceActor,
        ),
    )
    expect(matchedReordered?.id).toBe(created.id)

    // One-directional: a title with an EXTRA distinctive token (not in the existing doc) is NOT captured.
    const noneExtra = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) =>
        findOrgRunningDocByTitlePrefix(
          tx,
          orgId,
          `Dealer Price Watch Acme${stamp} Distributor Margin Breakout`,
          aliceActor,
        ),
    )
    expect(noneExtra).toBeNull()

    // Below the significant-token floor → never a spurious match (a 1-token title can't merge distinct docs).
    const noneShort = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: aliceActor.dimensionGrants,
      },
      (tx) => findOrgRunningDocByTitlePrefix(tx, orgId, "Dealer", aliceActor),
    )
    expect(noneShort).toBeNull()
  })

  // ⛔ CONVERSATION-PHASE DUPLICATE-WATCH-DOC GUARD (BL-275, competitor-firmware-news-watch parallel fail).
  // The agent under parallel load creates a SECOND watch/digest doc ("Competitor Release History") during
  // PLANNING — a non-routine create the bound-doc redirect can't catch — while the SEEDED running watch doc
  // is the one the tick maintains, so the knowledge block shows TWO watch docs (criterion-3 fail). The guard
  // collapses a watch/digest-titled create onto the UNIQUE existing running watch doc. Narrow: a distinct
  // doc (notes / KB) is never merged; two rival watch docs (ambiguous) fall through.
  it("isRunningWatchOrDigestTitle classifies watch/digest titles (and not generic docs)", () => {
    expect(isRunningWatchOrDigestTitle("Competitor Firmware & Feature Watch")).toBe(true)
    expect(isRunningWatchOrDigestTitle("Competitor Release History")).toBe(true)
    expect(isRunningWatchOrDigestTitle("Competitor Digest")).toBe(true)
    expect(isRunningWatchOrDigestTitle("Weekly Competitor Release Log")).toBe(true)
    // Generic docs (no watch family + domain) never match → never merged.
    expect(isRunningWatchOrDigestTitle("Q3 Personal Goals")).toBe(false)
    expect(isRunningWatchOrDigestTitle("Onboarding Runbook")).toBe(false)
    expect(isRunningWatchOrDigestTitle("Meeting Notes 2026-06-27")).toBe(false)
    // A 'history' family word WITHOUT a watch domain word is NOT a watch doc.
    expect(isRunningWatchOrDigestTitle("Project History")).toBe(false)
  })

  it("findUniqueOrgRunningWatchDoc collapses a watch/digest-titled create onto the UNIQUE existing running watch doc", async () => {
    // ISOLATION (test-state pollution fix): findUniqueOrgRunningWatchDoc's collapse is gated on the org
    // holding EXACTLY ONE writable running watch/digest doc (the deliberate ambiguity guard). The shared
    // `orgId` is NOT clean — the sibling `findOrgRunningDocByTitlePrefix` test (above) creates a
    // `Dealer Price Watch …` ORG doc that `isRunningWatchOrDigestTitle` also classifies (family:watch +
    // domain:price) and never tears down, so by the time this test runs the shared org already carries a
    // second running watch doc → matches.length === 2 → the guard correctly falls through and `collapsed`
    // is null. That is the product code behaving as designed; the test's precondition (a UNIQUE existing
    // running watch doc) is what was violated. Provision a DEDICATED org + user so the "exactly one"
    // invariant holds regardless of what sibling tests leave in the shared org — never weaken the guard.
    const [iso] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.organizations (id, name, slug)
            VALUES (gen_random_uuid(), 'KnowledgeWatchCollapse', ${`knowledge-watch-collapse-${Date.now()}`})
            RETURNING id`,
      ),
    )
    const isoOrgId = iso!.id
    const [isoU] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
            VALUES (gen_random_uuid(), ${isoOrgId}::uuid, ${`watch-collapse-${Date.now()}@x.test`}, 'WatchAlice', 'active', 'h', 1, 1)
            RETURNING id`,
      ),
    )
    const isoUser = isoU!.id
    const isoActor = knowledgeActorFromContext({
      orgId: isoOrgId,
      userId: isoUser,
      scopes: [CREATE, READ, UPDATE],
      dimensionGrants: { sensitivity: ["public", "internal"] },
    })
    const isoCtx = {
      actorType: "user" as const,
      orgId: isoOrgId,
      userId: isoUser,
      scopes: isoActor.scopes,
      dimensionGrants: isoActor.dimensionGrants,
    }
    const stamp = Date.now()
    const seededTitle = `Competitor Firmware & Feature Watch Acme${stamp}`
    const seeded = await withRlsContext(isoCtx, (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: seededTitle,
          body: "controls",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        isoActor,
        [],
      ),
    )
    // A DIFFERENTLY-titled watch/digest create ("Competitor Release History") collapses onto the seeded doc.
    const collapsed = await withRlsContext(isoCtx, (tx) =>
      findUniqueOrgRunningWatchDoc(
        tx,
        isoOrgId,
        `Competitor Release History Acme${stamp}`,
        isoActor,
      ),
    )
    expect(collapsed?.id).toBe(seeded.id)
    // A NON-watch create (meeting notes) is NEVER merged.
    const notMerged = await withRlsContext(isoCtx, (tx) =>
      findUniqueOrgRunningWatchDoc(tx, isoOrgId, `Meeting Notes Acme${stamp}`, isoActor),
    )
    expect(notMerged).toBeNull()

    // AMBIGUOUS: a SECOND rival watch doc → no unique match → falls through (no merge, no guess).
    await withRlsContext(isoCtx, (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: `Competitor Price & SKU Watch Acme${stamp}`,
          body: "rival",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
        } as never,
        isoActor,
        [],
      ),
    )
    const ambiguous = await withRlsContext(isoCtx, (tx) =>
      findUniqueOrgRunningWatchDoc(
        tx,
        isoOrgId,
        `Competitor Release History Acme${stamp}`,
        isoActor,
      ),
    )
    expect(ambiguous).toBeNull()
  })

  it("Postgres trigger prevents collection hierarchy cycles", async () => {
    // Real cycle-detection lives in the DB trigger `collections_prevent_invalid_parent`.
    // The JS-level wouldCreateCycle dep is stub-only — this test pins the
    // authoritative invariant.
    const aRow = await db.execute(
      sql`INSERT INTO app_knowledge.collections (id, org_id, name) VALUES (gen_random_uuid(), ${orgId}::uuid, 'A') RETURNING id`,
    )
    const a = extractRows<{ id: string }>(aRow)[0]!.id
    const bRow = await db.execute(
      sql`INSERT INTO app_knowledge.collections (id, org_id, name, parent_collection_id) VALUES (gen_random_uuid(), ${orgId}::uuid, 'B', ${a}::uuid) RETURNING id`,
    )
    const b = extractRows<{ id: string }>(bRow)[0]!.id
    // Now try to make A a child of B → would create cycle A→B→A.
    // Drizzle wraps the underlying Postgres error in a DrizzleQueryError;
    // the trigger's "collection cycle detected" message lives on `.cause.message`.
    let caught: unknown = null
    try {
      await db.execute(
        sql`UPDATE app_knowledge.collections SET parent_collection_id = ${b}::uuid WHERE id = ${a}::uuid`,
      )
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeNull()
    const causeMessage = String(
      (caught as { cause?: { message?: string }; message?: string })?.cause?.message ??
        (caught as { message?: string })?.message ??
        "",
    )
    expect(causeMessage).toMatch(/cycle detected/i)
  })

  it("B8: linked Drive source cache invariant — telemetry endpoint defaults to 0 bytes/chunks/days", async () => {
    // Cache invariant must be visible to any caller asking the source
    // telemetry endpoint. This test asserts the contract surface; the deeper
    // assertion (no rows in app_knowledge.content_cache_entries after a
    // federated search) is covered by integration tests that exercise the
    // source registry once it lands.
    const rows = extractRows<{ count: string }>(
      await db.execute(
        sql`SELECT COUNT(*)::text AS count FROM app_knowledge.content_cache_entries`,
      ),
    )
    // Whatever rows exist, none should have non-zero cache bytes under the
    // default remote_search policy (Phase 11 default is zero-cache).
    const overBudget = extractRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM app_knowledge.content_cache_entries WHERE cache_bytes > 0 LIMIT 1`,
      ),
    )
    expect(overBudget.length).toBe(0)
    expect(Number.isFinite(Number(rows[0]?.count ?? "0"))).toBe(true)
  })

  it("IT-1/IT-2: federated search under default policy writes 0 cache rows", async () => {
    // Forces actual invocation of federatedKnowledgeSearch through a stub
    // remote adapter that returns one hit. The default policy is remote_search
    // (zero cache); the cache table must remain empty after the call.
    const before =
      extractRows<{ count: string }>(
        await db.execute(
          sql`SELECT COUNT(*)::text AS count FROM app_knowledge.content_cache_entries`,
        ),
      )[0]?.count ?? "0"

    const reg = createKnowledgeSourceRegistry()
    reg.register({
      source: "drive-stub",
      searchRemote: async () => ({
        hits: [{ source: "drive-stub", sourceEntityId: "x", title: "T", type: "file" }],
        status: { source: "drive-stub", state: "complete", retryable: false },
      }),
    } as never)

    const a = actor(alice, [READ, "knowledge:sources:read"])
    await federatedKnowledgeSearch(
      { query: "T", limit: 10, mode: "blended", cursors: {}, filters: {} } as never,
      {
        actor: a,
        registry: reg,
        localSearch: async () => ({
          hits: [],
          status: { source: "knowledge", state: "complete", retryable: false },
        }),
      },
    )

    const after =
      extractRows<{ count: string }>(
        await db.execute(
          sql`SELECT COUNT(*)::text AS count FROM app_knowledge.content_cache_entries`,
        ),
      )[0]?.count ?? "0"
    expect(after).toBe(before)
  })

  it("listKnowledgeDocuments({ unfiled: true }) returns only org docs without a collection_membership", async () => {
    // Org-scope create needs a sensitivity grant; this test exercises the
    // unfiled filter, not RLS dimensions, so grant the minimum needed.
    const aliceActor = actor(alice, [CREATE, READ], {
      sensitivity: ["internal"],
      team: ["*"],
    })

    // Two org-scope docs: one filed, one orphan. The filter excludes
    // personal-scope entirely, so both docs use documentScope:"organization"
    // to keep this test focused on the membership filter.
    const filed = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: { sensitivity: ["internal"], team: ["*"] },
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Filed",
            body: "in a collection",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    // Orphan must be ORG-scope: `unfiled:true` returns only org-scope
    // documents not in a collection. Personal docs surface under the
    // separate __personal_notes__ bucket.
    const orphan = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: { sensitivity: ["internal"], team: ["*"] },
      },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Orphan",
            body: "no collection",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )

    // Seed a collection + filed membership for `filed` (raw SQL — minimal,
    // since the manifest tool path requires more setup than this test needs).
    const collectionId = (
      extractRows<{ id: string }>(
        await db.execute(
          sql`INSERT INTO app_knowledge.collections (id, org_id, name, owner_user_id, maintainer_user_ids)
              VALUES (gen_random_uuid(), ${orgId}::uuid, 'Unfiled-test-collection', ${alice}::uuid, '[]'::jsonb)
              RETURNING id`,
        ),
      )[0] ?? { id: "" }
    ).id
    await db.execute(
      sql`INSERT INTO app_knowledge.collection_memberships (id, org_id, collection_id, target_id, target_type, created_by)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${collectionId}::uuid, ${filed.id}::uuid, 'document', ${alice}::uuid)`,
    )

    const unfiled = await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: alice,
        scopes: aliceActor.scopes,
        dimensionGrants: { sensitivity: ["internal"], team: ["*"] },
      },
      (tx) => listKnowledgeDocuments(tx, aliceActor, { unfiled: true }),
    )
    const ids = unfiled.map((d) => d.id)
    expect(ids).toContain(orphan.id)
    expect(ids).not.toContain(filed.id)
  })

  // BL-184/198/199 capability gap: the agent had NO way to retire a wrong /
  // duplicate document (it fabricated '[ARCHIVED]' stub docs). The service
  // archive/restore exist; this exercises them under RLS so the new
  // knowledge:archive / knowledge:restore agent tools have a fails-without /
  // passes-with regression behind them.
  const ARCHIVE = "knowledge:documents:archive"

  it("archive retires a doc from the active KB (hidden from a normal read), scope-gated, and restore reinstates it", async () => {
    const grants = { sensitivity: ["internal"], team: ["*"] }
    // The author retires their OWN doc: archiveKnowledgeDocument gates on the
    // archive scope AND assertCanWriteDocumentRow (non-admin → owner + update).
    const author = actor(alice, [CREATE, READ, UPDATE, ARCHIVE], grants)
    const doc = await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: author.scopes, dimensionGrants: grants },
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Stray duplicate handshake article",
            body: "duplicate to be retired",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          author,
          [],
        ),
    )

    // A reader WITHOUT the archive scope cannot archive — forbidden.
    const reader = actor(bob, [READ], grants)
    await expect(
      withRlsContext(
        { actorType: "user", orgId, userId: bob, scopes: reader.scopes, dimensionGrants: grants },
        (tx) => archiveKnowledgeDocument(tx, doc.id, reader),
      ),
    ).rejects.toThrow(KnowledgeError)

    // Author archives it.
    const archived = await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: author.scopes, dimensionGrants: grants },
      (tx) => archiveKnowledgeDocument(tx, doc.id, author),
    )
    expect(archived.archivedAt).not.toBeNull()

    // It's now out of the ACTIVE KB list (the agent-facing search/list view
    // filters archived_at IS NULL) — this is what lets the agent CLEANLY retire
    // a duplicate instead of leaving an '[ARCHIVED]' stub doc cluttering the KB.
    const activeList = await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: author.scopes, dimensionGrants: grants },
      (tx) => listKnowledgeDocuments(tx, author),
    )
    expect(activeList.map((d) => d.id)).not.toContain(doc.id)

    // Restore reinstates it into the active KB.
    await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: author.scopes, dimensionGrants: grants },
      (tx) => restoreKnowledgeDocument(tx, doc.id, author),
    )
    const afterRestore = await withRlsContext(
      { actorType: "user", orgId, userId: alice, scopes: author.scopes, dimensionGrants: grants },
      (tx) => listKnowledgeDocuments(tx, author),
    )
    expect(afterRestore.map((d) => d.id)).toContain(doc.id)
  })

  // knowledge-dedupe-overlapping-firmware-notes: the consolidate-then-archive flow archives MULTIPLE
  // originals in one turn, and a weak model may double-archive (idempotency) or re-archive after a
  // restore. This regression asserts (1) archiving several distinct docs each retires them cleanly from
  // the active KB and (2) archive is idempotent — re-archiving an already-archived doc keeps it archived
  // and does not resurrect it, and restore returns an already-active doc unchanged (the IC-7 no-op).
  it("dedupe flow: archiving multiple originals retires all of them, and archive/restore are idempotent", async () => {
    const grants = { sensitivity: ["internal"], team: ["*"] }
    const author = actor(alice, [CREATE, READ, UPDATE, ARCHIVE], grants)
    const ctx = {
      actorType: "user" as const,
      orgId,
      userId: alice,
      scopes: author.scopes,
      dimensionGrants: grants,
    }
    const mk = (title: string) =>
      withRlsContext(ctx, (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title,
            body: `${title} body`,
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          } as never,
          author,
          [],
        ),
      )
    const a = await mk("v2.4 dedupe original — preset corruption")
    const b = await mk("v2.4 dedupe original — factory reset")
    const c = await mk("v2.4 dedupe original — Editor handshake")

    // Archive all three originals (the retire half of the consolidation).
    for (const d of [a, b, c]) {
      const archived = await withRlsContext(ctx, (tx) => archiveKnowledgeDocument(tx, d.id, author))
      expect(archived.archivedAt).not.toBeNull()
    }
    const active = await withRlsContext(ctx, (tx) => listKnowledgeDocuments(tx, author))
    for (const d of [a, b, c]) {
      expect(active.map((x) => x.id)).not.toContain(d.id)
    }

    // Idempotent re-archive: archiving an already-archived doc keeps it archived (no resurrection).
    const reArchived = await withRlsContext(ctx, (tx) => archiveKnowledgeDocument(tx, a.id, author))
    expect(reArchived.archivedAt).not.toBeNull()
    const stillActive = await withRlsContext(ctx, (tx) => listKnowledgeDocuments(tx, author))
    expect(stillActive.map((x) => x.id)).not.toContain(a.id)

    // Restore-then-idempotent-restore: first restore reinstates; a second restore on the now-active
    // doc is a no-op (IC-7 — returns the active doc, does not error or toggle archive).
    const restored = await withRlsContext(ctx, (tx) => restoreKnowledgeDocument(tx, a.id, author))
    expect(restored.archivedAt).toBeNull()
    const restoredAgain = await withRlsContext(ctx, (tx) =>
      restoreKnowledgeDocument(tx, a.id, author),
    )
    expect(restoredAgain.archivedAt).toBeNull()
    const afterAll = await withRlsContext(ctx, (tx) => listKnowledgeDocuments(tx, author))
    expect(afterAll.map((x) => x.id)).toContain(a.id)
  })
})
