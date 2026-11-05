// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Google-Drive-style Knowledge document sharing — DB/RLS integration coverage.
 *
 * Exercises the real DB and the 0002 migration's RLS policies (not just JS-level
 * assertions): org_access + document_shares gate reads/writes on org documents,
 * independent of the team/sensitivity dimension ladder. Also covers the
 * getDocumentSharing/setDocumentSharing round-trip and the org-members listing
 * that backs the share picker.
 *
 * Each RLS-touching assertion below fails without the corresponding 0002
 * migration policy or the service-layer shareRole wiring — e.g. commenting out
 * the document_shares EXISTS branch in knowledge_documents_select, or reverting
 * assertCanReadDocumentRow/assertCanWriteDocumentRow to gate on team/sensitivity,
 * makes these tests fail (see the pre-fix run captured while building this file:
 * B10/B10b in service.integration.test.ts genuinely failed against real RLS
 * before the sharing-model tests were added there).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createKnowledgeDocument,
  getDocumentSharing,
  type KnowledgeActor,
  KnowledgeError,
  knowledgeActorFromContext,
  loadKnowledgeDocument,
  setDocumentSharing,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { listUsers } from "~/modules/users/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string
let carol: string

const READ = "knowledge:documents:read"
const CREATE = "knowledge:documents:create"
const UPDATE = "knowledge:documents:update"
const ADMIN = "knowledge:documents:admin"

function actor(
  userId: string,
  scopes: string[],
  grants: Record<string, string[]> = {},
): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: grants })
}

function ctx(userId: string, scopes: string[], dimensionGrants: Record<string, string[]> = {}) {
  return { actorType: "user" as const, orgId, userId, scopes, dimensionGrants }
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-sharing-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeSharingIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const mkUser = async (name: string) => {
    const [row] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2)}@x.test`}, ${name}, 'active', 'h', 1, 1)
            RETURNING id`,
      ),
    )
    return row!.id
  }
  alice = await mkUser("Alice")
  bob = await mkUser("Bob")
  carol = await mkUser("Carol")
})

afterAll(releaseTestLock)

describe("Knowledge document sharing (DB integration)", () => {
  // ── 1. RLS + service: owner shares a restricted doc with a viewer, admin (uninvited) still 404s ──
  it("restricted doc: owner shares viewer → viewer reads, non-shared user (even admin) 404s, owner always reads; editor share unlocks write", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], { sensitivity: ["internal"] })
    const created = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Board deck (restricted)",
            body: "confidential numbers",
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

    // Owner sets sharing: viewer = bob.
    const sharingAsOwner = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        created.id,
        { orgAccess: "none", editScope: null, shares: [{ userId: bob, role: "viewer" }] },
        aliceActor,
      ),
    )
    expect(sharingAsOwner.orgAccess).toBe("none")
    expect(sharingAsOwner.shares).toEqual([{ userId: bob, role: "viewer" }])

    // Bob (viewer share) CAN read via the real RLS-scoped load.
    const bobActor = actor(bob, [READ, UPDATE])
    const bobRead = await withRlsContext(ctx(bob, bobActor.scopes), (tx) =>
      loadKnowledgeDocument(tx, created.id, bobActor),
    )
    expect(bobRead?.id).toBe(created.id)

    // Carol — NOT shared, NOT owner/creator, even holding the ADMIN scope — must 404 (Drive-style: a
    // restriction is invisible to admins not on the list, per the 0002 migration's documented model).
    const carolAdminActor = actor(carol, [READ, ADMIN])
    const carolRead = await withRlsContext(ctx(carol, carolAdminActor.scopes), (tx) =>
      loadKnowledgeDocument(tx, created.id, carolAdminActor),
    )
    expect(carolRead).toBeNull()

    // Owner (Alice) can always read her own restricted doc.
    const aliceRead = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      loadKnowledgeDocument(tx, created.id, aliceActor),
    )
    expect(aliceRead?.id).toBe(created.id)

    // Bob (viewer share) attempts to WRITE — forbidden (viewer share does not grant write).
    await expect(
      withRlsContext(ctx(bob, bobActor.scopes), (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: created.id, revision: created.revision, title: "Bob hijack" },
          bobActor,
          [],
        ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // Owner upgrades Bob to editor.
    const sharingUpgraded = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        created.id,
        { orgAccess: "none", editScope: null, shares: [{ userId: bob, role: "editor" }] },
        aliceActor,
      ),
    )
    expect(sharingUpgraded.shares).toEqual([{ userId: bob, role: "editor" }])

    // Bob (now editor share) CAN write.
    const bobUpdated = await withRlsContext(ctx(bob, bobActor.scopes), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: created.id, revision: created.revision, title: "Bob maintains it (editor share)" },
        bobActor,
        [],
      ),
    )
    expect(bobUpdated.title).toBe("Bob maintains it (editor share)")
  })

  // ── 2. orgAccess='viewer' broad audience: any member reads; only owner/editor-share writes ──
  it("orgAccess='viewer': any org member reads via RLS; a non-owner without an editor share cannot write; orgAccess='editor' lets any member write", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["internal"] })
    const viewerDoc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Org handbook (viewer audience)",
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

    const carolActor = actor(carol, [READ, UPDATE])
    const carolRead = await withRlsContext(ctx(carol, carolActor.scopes), (tx) =>
      loadKnowledgeDocument(tx, viewerDoc.id, carolActor),
    )
    expect(carolRead?.id).toBe(viewerDoc.id)

    await expect(
      withRlsContext(ctx(carol, carolActor.scopes), (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: viewerDoc.id, revision: viewerDoc.revision, title: "Carol hijack" },
          carolActor,
          [],
        ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // orgAccess='editor' → any member with update scope may write, no explicit share needed.
    const editorDoc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Org handbook (editor audience)",
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
    const carolUpdated = await withRlsContext(ctx(carol, carolActor.scopes), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: editorDoc.id, revision: editorDoc.revision, title: "Carol maintains it" },
        carolActor,
        [],
      ),
    )
    expect(carolUpdated.title).toBe("Carol maintains it")
  })

  // ── 3. GET/PUT sharing round-trip via the service layer (routes.ts calls these directly) ──
  it("getDocumentSharing/setDocumentSharing round-trip: set orgAccess+shares, read back the same state", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], { sensitivity: ["internal"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Roundtrip doc",
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

    // Read back the default sharing state (editor audience, no explicit shares).
    const initial = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      getDocumentSharing(tx, doc.id, aliceActor),
    )
    expect(initial).toEqual({ orgAccess: "editor", editScope: null, shares: [], roleShares: [] })

    // Set: restrict + share with bob (viewer) and carol (editor).
    const setResult = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        {
          orgAccess: "none",
          editScope: null,
          shares: [
            { userId: bob, role: "viewer" },
            { userId: carol, role: "editor" },
          ],
        },
        aliceActor,
      ),
    )
    expect(setResult.orgAccess).toBe("none")
    expect(new Set(setResult.shares)).toEqual(
      new Set([
        { userId: bob, role: "viewer" },
        { userId: carol, role: "editor" },
      ]),
    )

    // Read back via getDocumentSharing (a different call path) — reflects the same state.
    const readBack = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      getDocumentSharing(tx, doc.id, aliceActor),
    )
    expect(readBack.orgAccess).toBe("none")
    expect(readBack.shares.slice().sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(
      [
        { userId: bob, role: "viewer" as const },
        { userId: carol, role: "editor" as const },
      ].sort((a, b) => a.userId.localeCompare(b.userId)),
    )

    // REPLACE semantics: setting shares to just [carol as viewer] drops bob entirely.
    const replaced = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        { orgAccess: "none", editScope: null, shares: [{ userId: carol, role: "viewer" }] },
        aliceActor,
      ),
    )
    expect(replaced.shares).toEqual([{ userId: carol, role: "viewer" }])

    // Bob, now dropped from shares, loses read access (RLS re-evaluated).
    const bobActor = actor(bob, [READ])
    const bobReadAfterDrop = await withRlsContext(ctx(bob, bobActor.scopes), (tx) =>
      loadKnowledgeDocument(tx, doc.id, bobActor),
    )
    expect(bobReadAfterDrop).toBeNull()

    // A non-owner, non-writer (bob, viewer-only, was never given update scope) cannot call setDocumentSharing.
    await expect(
      withRlsContext(ctx(carol, ["knowledge:documents:read"]), (tx) =>
        setDocumentSharing(
          tx,
          doc.id,
          { orgAccess: "editor", editScope: null, shares: [] },
          actor(carol, ["knowledge:documents:read"]),
        ),
      ),
    ).rejects.toThrow(KnowledgeError)
  })

  // ── 4. GET /members-equivalent: any authenticated org member (non-admin) can list org members ──
  it("listUsers (backing GET /knowledge/members) returns org members for a NON-ADMIN caller", async () => {
    // The knowledge members route gates only on knowledge:documents:read (any org member), not
    // kernel:users:admin — reusing listUsers must not require admin scope at the DB layer either.
    // kernel.users' own RLS policy (`users_select_rls`) already allows any org member to read all
    // users in the same org, so this call succeeds under a bare knowledge:documents:read actor.
    const { rows } = await withRlsContext(ctx(bob, [READ]), (tx) =>
      listUsers(tx, { orgId, page: 1, limit: 200 }),
    )
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(alice)
    expect(ids).toContain(bob)
    expect(ids).toContain(carol)
    // Minimal projection fields the route exposes are present on each row.
    const aliceRow = rows.find((r) => r.id === alice)
    expect(aliceRow?.name).toBe("Alice")
    expect(typeof aliceRow?.email).toBe("string")
  })

  // ── Cross-org isolation for members: a caller in a DIFFERENT org never sees this org's users ──
  it("listUsers never leaks members across orgs (RLS org_id scoping)", async () => {
    const [otherOrg] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.organizations (id, name, slug)
            VALUES (gen_random_uuid(), 'OtherOrgForSharingIsolation', ${`other-org-${Date.now()}`})
            RETURNING id`,
      ),
    )
    const otherOrgId = otherOrg!.id
    const [otherUser] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
            VALUES (gen_random_uuid(), ${otherOrgId}::uuid, ${`dave-${Date.now()}@x.test`}, 'Dave', 'active', 'h', 1, 1)
            RETURNING id`,
      ),
    )
    const dave = otherUser!.id

    const { rows } = await withRlsContext(
      { actorType: "user", orgId: otherOrgId, userId: dave, scopes: [READ], dimensionGrants: {} },
      (tx) => listUsers(tx, { orgId: otherOrgId, page: 1, limit: 200 }),
    )
    const ids = rows.map((r) => r.id)
    expect(ids).toContain(dave)
    expect(ids).not.toContain(alice)
    expect(ids).not.toContain(bob)
    expect(ids).not.toContain(carol)
  })

  // ── Scoped edit (0003 migration): everyone can view, only holders of the EXACT 'clevel' scope
  // can edit. Real RLS coverage for `has_exact_scope` — an org admin holding '*' must NOT bypass it,
  // proving the exact-match predicate (not the wildcard-honouring app_has_scope) governs the gate.
  it("scoped edit: orgAccess='viewer' + editScope='clevel' — everyone reads, only the literal 'clevel' holder writes; admin with '*' cannot; owner always can", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], { sensitivity: ["internal"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Exec compensation plan",
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

    // Owner (alice) sets: everyone can view, only 'clevel' scope holders can edit.
    const sharing = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        { orgAccess: "viewer", editScope: "clevel", shares: [] },
        aliceActor,
      ),
    )
    expect(sharing.orgAccess).toBe("viewer")
    expect(sharing.editScope).toBe("clevel")

    // GET /sharing reflects the same state for anyone who can read (alice, the owner).
    const readBack = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      getDocumentSharing(tx, doc.id, aliceActor),
    )
    expect(readBack).toEqual({
      orgAccess: "viewer",
      editScope: "clevel",
      shares: [],
      roleShares: [],
    })

    // Bob carries the LITERAL 'clevel' scope (a dedicated C-Level role grant) — everyone can view,
    // and bob specifically can edit.
    const bobActor = actor(bob, [READ, UPDATE, "clevel"])
    const bobRead = await withRlsContext(ctx(bob, bobActor.scopes), (tx) =>
      loadKnowledgeDocument(tx, doc.id, bobActor),
    )
    expect(bobRead?.id).toBe(doc.id)
    const bobUpdated = await withRlsContext(ctx(bob, bobActor.scopes), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: doc.id, revision: doc.revision, title: "Bob (C-Level) edits the comp plan" },
        bobActor,
        [],
      ),
    )
    expect(bobUpdated.title).toBe("Bob (C-Level) edits the comp plan")

    // Carol is an org admin holding the wildcard '*' scope but NOT the literal 'clevel' scope. She can
    // still VIEW (orgAccess='viewer' is a broad read grant unaffected by editScope), but her write is
    // rejected — has_exact_scope does not honour '*', so admin status alone does not unlock this doc.
    const carolAdminActor = actor(carol, [READ, UPDATE, "*"])
    const carolRead = await withRlsContext(ctx(carol, carolAdminActor.scopes), (tx) =>
      loadKnowledgeDocument(tx, doc.id, carolAdminActor),
    )
    expect(carolRead?.id).toBe(doc.id)
    await expect(
      withRlsContext(ctx(carol, carolAdminActor.scopes), (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: doc.id, revision: bobUpdated.revision, title: "Carol (admin, no clevel) hijack" },
          carolAdminActor,
          [],
        ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // The owner (alice) can always update, scope or no scope.
    const aliceUpdated = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: doc.id, revision: bobUpdated.revision, title: "Alice (owner) still maintains it" },
        aliceActor,
        [],
      ),
    )
    expect(aliceUpdated.title).toBe("Alice (owner) still maintains it")
  })

  // ── Regression: dimension-authority check must only fire when team/sensitivity ACTUALLY change ──
  // Before the fix, updateKnowledgeDocument computed `changingDimensions` as
  // `parsed.team !== undefined || parsed.sensitivity !== undefined` — true on ANY patch that merely
  // echoed the current values (e.g. a form re-submitting the doc's existing sensitivity alongside an
  // edited summary). That unconditionally called assertCanSetDimensions, which requires a `sensitivity`
  // dimension grant — so a legitimate editor authorized purely via the sharing model (here: the
  // 'clevel' edit_scope), but holding NO dimension grants, got 404'd editing a doc whose sensitivity
  // defaults to 'internal'. The fix compares the patched value against the CURRENT row value and only
  // demands dimension authority when team or sensitivity truly change.
  it("scoped-edit: a C-Level editor with NO dimension grants can edit body/summary of an org doc (default sensitivity) without touching dimensions", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], { sensitivity: ["internal"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Exec severance policy",
            body: "v1 body",
            summary: "v1 summary",
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

    // Owner restricts editing to the literal 'clevel' scope.
    await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        { orgAccess: "viewer", editScope: "clevel", shares: [] },
        aliceActor,
      ),
    )

    // Bob holds the literal 'clevel' scope plus read/update, but ZERO dimension grants — no
    // 'sensitivity' or 'team' entries at all (not even a wildcard). Under the old unconditional
    // check this update would throw FORBIDDEN ("Forbidden by Knowledge sensitivity grant") because
    // `parsed.sensitivity` is absent from this patch but the OLD code didn't care — it still fired
    // on `parsed.team !== undefined` for any create-shaped payload; for a bare update like this one
    // (only `summary` in the patch) neither field is present, so this specific call previously
    // relied on both being `undefined`. To pin the real regression, this patch changes `summary`
    // AND explicitly echoes the CURRENT sensitivity value ('internal') — exactly the "form
    // re-submits unchanged dimensions" shape the fix targets.
    const bobActor: KnowledgeActor = actor(bob, [READ, UPDATE, "clevel"], {})
    expect(bobActor.dimensionGrants).toEqual({})
    const bobUpdated = await withRlsContext(ctx(bob, bobActor.scopes, {}), (tx) =>
      updateKnowledgeDocument(
        tx,
        {
          id: doc.id,
          revision: doc.revision,
          summary: "Bob (C-Level, no dimension grants) updates the summary",
          sensitivity: "internal", // unchanged — echoes the row's current value
        },
        bobActor,
        [],
      ),
    )
    expect(bobUpdated.summary).toBe("Bob (C-Level, no dimension grants) updates the summary")

    // Complementary case: the authority check still fires when a dimension REALLY changes. Bob
    // (still zero dimension grants) tries to escalate sensitivity to 'confidential' — forbidden.
    await expect(
      withRlsContext(ctx(bob, bobActor.scopes, {}), (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: doc.id, revision: bobUpdated.revision, sensitivity: "confidential" },
          bobActor,
          [],
        ),
      ),
    ).rejects.toThrow(KnowledgeError)
  })
})

// ---------------------------------------------------------------------------
// Sensitivity-coupled org_access defaults (0008 search convergence)
// ---------------------------------------------------------------------------
describe("sensitivity-coupled org_access defaults", () => {
  async function rawDocRow(id: string) {
    const [row] = extractRows<{
      org_access: string
      acl_user_ids: string[]
      acl_role_ids: string[]
      org_wide: boolean
    }>(
      await db.execute(
        sql`SELECT org_access, acl_user_ids, acl_role_ids, org_wide
            FROM app_knowledge.documents WHERE id = ${id}::uuid`,
      ),
    )
    return row!
  }

  it("create: confidential with no explicit orgAccess defaults to 'none'", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["confidential"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["confidential"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Confidential defaults to none",
            body: "v1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "confidential",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    expect(doc.orgAccess).toBe("none")
  })

  it("create: restricted with no explicit orgAccess defaults to 'none'", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["restricted"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["restricted"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Restricted defaults to none",
            body: "v1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "restricted",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    expect(doc.orgAccess).toBe("none")
  })

  it("create: internal (default sensitivity) with no explicit orgAccess defaults to 'editor'", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["internal"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Internal defaults to editor",
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
    expect(doc.orgAccess).toBe("editor")
  })

  it("create: explicit orgAccess wins over the sensitivity default", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["confidential"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["confidential"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Explicit orgAccess wins",
            body: "v1",
            collectionIds: [],
            tagNames: [],
            team: [],
            sensitivity: "confidential",
            orgAccess: "viewer",
            verifyNow: false,
          } as never,
          aliceActor,
          [],
        ),
    )
    expect(doc.orgAccess).toBe("viewer")
  })

  it("update: reclassifying internal→confidential with no explicit orgAccess auto-tightens to 'none'", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], {
      sensitivity: ["internal", "confidential"],
    })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal", "confidential"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Reclassify auto-tighten",
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
    expect(doc.orgAccess).toBe("editor")

    const updated = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal", "confidential"] }),
      (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: doc.id, revision: doc.revision, sensitivity: "confidential" },
          aliceActor,
          [],
        ),
    )
    expect(updated.orgAccess).toBe("none")
  })

  it("update: the SAME reclassify WITH an explicit orgAccess in the patch is respected instead", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], {
      sensitivity: ["internal", "confidential"],
    })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal", "confidential"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Reclassify with explicit orgAccess",
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

    const updated = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal", "confidential"] }),
      (tx) =>
        updateKnowledgeDocument(
          tx,
          {
            id: doc.id,
            revision: doc.revision,
            sensitivity: "confidential",
            orgAccess: "viewer",
          },
          aliceActor,
          [],
        ),
    )
    expect(updated.orgAccess).toBe("viewer")
  })

  it("create: acl_user_ids contains owner+creator deduped; org_wide reflects org_access", async () => {
    const aliceActor = actor(alice, [CREATE, READ], { sensitivity: ["internal"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "ACL seeded from owner+creator",
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
    const row = await rawDocRow(doc.id)
    // Owner === creator (alice) on a plain create → deduped to one entry.
    expect(row.acl_user_ids).toEqual([alice])
    expect(row.acl_role_ids).toEqual([])
    expect(row.org_wide).toBe(false)
  })

  it("setDocumentSharing updates acl_user_ids to reflect the new share roster", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], { sensitivity: ["internal"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "ACL updates on share",
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
    await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        { orgAccess: "none", editScope: null, shares: [{ userId: bob, role: "viewer" }] },
        aliceActor,
      ),
    )
    const row = await rawDocRow(doc.id)
    expect(row.acl_user_ids.sort()).toEqual([alice, bob].sort())
  })

  it("owner reassignment recomputes acl_user_ids", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE, "knowledge:documents:assign-owner"], {
      sensitivity: ["internal"],
    })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "Owner reassignment recomputes ACL",
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
    const before = await rawDocRow(doc.id)
    expect(before.acl_user_ids).toEqual([alice])

    await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: doc.id, revision: doc.revision, ownerUserId: bob },
        aliceActor,
        [],
      ),
    )
    const after = await rawDocRow(doc.id)
    // owner is now bob, creator is still alice — both must be on the ACL.
    expect(after.acl_user_ids.sort()).toEqual([alice, bob].sort())
  })

  it("the search ACL is derived: its owner cannot write acl_user_ids / acl_role_ids directly", async () => {
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], { sensitivity: ["internal"] })
    const doc = await withRlsContext(
      ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }),
      (tx) =>
        createKnowledgeDocument(
          tx,
          {
            documentScope: "organization",
            title: "ACL guard",
            body: "b",
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
    await expect(
      withRlsContext(ctx(alice, aliceActor.scopes, { sensitivity: ["internal"] }), (tx) =>
        tx.execute(
          sql`UPDATE app_knowledge.documents SET acl_user_ids = ${JSON.stringify([bob])}::jsonb WHERE id = ${doc.id}::uuid`,
        ),
      ),
    ).rejects.toThrow()
    expect((await rawDocRow(doc.id)).acl_user_ids).toEqual([alice])
  })
})
