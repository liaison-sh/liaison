// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Role-based Knowledge document sharing — DB/RLS integration coverage.
 *
 * Generalises the per-user `document_shares` ACL (0002) into a per-ROLE ACL
 * (0004 migration): `app_knowledge.document_role_shares(document_id, role_id,
 * role)` + the `app_knowledge.has_role(_role_id)` predicate, fed by the new
 * `app.current_roles` GUC (set per-request in db/rls.ts from `UserContext.roles`).
 *
 * Exercises the real DB and RLS policies (not just JS-level assertions):
 * - `knowledge_documents_select` — a role viewer/editor share grants READ.
 * - `knowledge_documents_update` — a role EDITOR share grants WRITE; a role
 *   VIEWER share does not; there is NO admin bypass (an org-admin-scoped actor
 *   not in the role is denied, matching the per-user-share model).
 * - Service-layer `loadDocumentShareRole` composes per-user + per-role shares
 *   (strongest wins), and `getDocumentSharing`/`setDocumentSharing` round-trip
 *   `roleShares` with `undefined` = leave unchanged, `[]` = clear.
 *
 * `document_role_shares.role_id` has NO FK to `kernel.roles` (see the 0004
 * migration) — only `app.current_roles` membership matters for RLS, so these
 * tests use arbitrary UUIDs as role ids without seeding real kernel roles.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  createKnowledgeDocument,
  getDocumentSharing,
  type KnowledgeActor,
  KnowledgeError,
  knowledgeActorFromContext,
  loadDocumentShareRole,
  loadKnowledgeDocument,
  setDocumentSharing,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string
let carol: string

const CREATE = "knowledge:documents:create"
const READ = "knowledge:documents:read"
const UPDATE = "knowledge:documents:update"
const ADMIN = "knowledge:documents:admin"

function actor(
  userId: string,
  scopes: string[],
  roles: string[] = [],
  // Match ctx()'s RLS-layer grants so the service-layer assertCanSetDimensions on
  // create/update is satisfied. Access here is governed by role sharing, not the
  // (decoupled) team/sensitivity ladder — these grants just let docs be authored.
  grants: Record<string, string[]> = { sensitivity: ["internal"], team: ["*"] },
): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: grants, roles })
}

function ctx(userId: string, scopes: string[], roles: string[] = []) {
  return {
    actorType: "user" as const,
    orgId,
    userId,
    scopes,
    dimensionGrants: { sensitivity: ["internal"], team: ["*"] },
    roles,
  }
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-role-sharing-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeRoleSharingIntegration', ${slug})
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

describe("Knowledge role-based document sharing (DB integration)", () => {
  it("role viewer-share grants READ: a caller holding the role sees the doc via RLS; a caller not in the role sees nothing", async () => {
    const roleR = randomUUID()
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], [])
    const created = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Marketing plan (role-restricted)",
          body: "q3 plan",
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

    // Owner shares the doc with role R as viewer.
    const sharing = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        created.id,
        {
          orgAccess: "none",
          editScope: null,
          shares: [],
          roleShares: [{ roleId: roleR, role: "viewer" }],
        },
        aliceActor,
      ),
    )
    expect(sharing.roleShares).toEqual([{ roleId: roleR, role: "viewer" }])

    // Bob holds role R (via app.current_roles) — RLS SELECT returns the row directly.
    const bobRlsRows = await withRlsContext(ctx(bob, [READ], [roleR]), (tx) =>
      tx.execute(sql`SELECT id FROM ${knowledgeRel("documents")} WHERE id = ${created.id}::uuid`),
    )
    expect(extractRows(bobRlsRows)).toHaveLength(1)

    // Bob's KnowledgeActor also carries role R — the service-layer path agrees.
    const bobActor = actor(bob, [READ], [roleR])
    const bobRead = await withRlsContext(ctx(bob, bobActor.scopes, [roleR]), (tx) =>
      loadKnowledgeDocument(tx, created.id, bobActor),
    )
    expect(bobRead?.id).toBe(created.id)

    // Carol does NOT hold role R — RLS hides the row entirely (0 rows).
    const carolRlsRows = await withRlsContext(ctx(carol, [READ], []), (tx) =>
      tx.execute(sql`SELECT id FROM ${knowledgeRel("documents")} WHERE id = ${created.id}::uuid`),
    )
    expect(extractRows(carolRlsRows)).toHaveLength(0)

    // Same via the service layer: loadKnowledgeDocument returns null for Carol.
    const carolActor = actor(carol, [READ], [])
    const carolRead = await withRlsContext(ctx(carol, carolActor.scopes, []), (tx) =>
      loadKnowledgeDocument(tx, created.id, carolActor),
    )
    expect(carolRead).toBeNull()
  })

  it("role editor-share grants WRITE: a caller in the role can UPDATE; a caller in a VIEWER-only role-share can read but not write", async () => {
    const roleR = randomUUID()
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], [])
    const doc = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Runbook (editor role-share)",
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
        {
          orgAccess: "none",
          editScope: null,
          shares: [],
          roleShares: [{ roleId: roleR, role: "editor" }],
        },
        aliceActor,
      ),
    )

    // Bob holds role R — service-layer WRITE succeeds.
    const bobActor = actor(bob, [READ, UPDATE], [roleR])
    const bobUpdated = await withRlsContext(ctx(bob, bobActor.scopes, [roleR]), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: doc.id, revision: doc.revision, title: "Bob (role editor) maintains it" },
        bobActor,
        [],
      ),
    )
    expect(bobUpdated.title).toBe("Bob (role editor) maintains it")

    // Raw RLS: the UPDATE actually lands (not a silent 0-row no-op) for a fresh caller in the role.
    const rlsUpdateRows = await withRlsContext(ctx(bob, [READ, UPDATE], [roleR]), async (tx) => {
      await tx.execute(sql`
        UPDATE ${knowledgeRel("documents")}
        SET body = 'raw rls role-editor write', revision = revision + 1, updated_by = ${bob}::uuid, updated_at = now()
        WHERE id = ${doc.id}::uuid AND org_id = ${orgId}::uuid
      `)
      return tx.execute(
        sql`SELECT body, revision FROM ${knowledgeRel("documents")} WHERE id = ${doc.id}::uuid`,
      )
    })
    const rlsUpdated = extractRows<{ body: string; revision: number }>(rlsUpdateRows)[0]!
    expect(rlsUpdated.body).toBe("raw rls role-editor write")

    // Now downgrade to a VIEWER-only role-share for a different role R2, held by Carol.
    const roleR2 = randomUUID()
    await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        {
          orgAccess: "none",
          editScope: null,
          shares: [],
          roleShares: [{ roleId: roleR2, role: "viewer" }],
        },
        aliceActor,
      ),
    )
    const carolActor = actor(carol, [READ, UPDATE], [roleR2])
    const carolRead = await withRlsContext(ctx(carol, carolActor.scopes, [roleR2]), (tx) =>
      loadKnowledgeDocument(tx, doc.id, carolActor),
    )
    expect(carolRead?.id).toBe(doc.id)

    await expect(
      withRlsContext(ctx(carol, carolActor.scopes, [roleR2]), (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: doc.id, revision: rlsUpdated.revision, title: "Carol (role viewer only) hijack" },
          carolActor,
          [],
        ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // Raw RLS: the viewer-role UPDATE matches 0 rows under the write policy, so the
    // body is UNCHANGED. Carol CAN still read (viewer role-share), so we prove the
    // write was denied by asserting the body was not mutated — not by row visibility.
    const carolRlsUpdateRows = await withRlsContext(
      ctx(carol, [READ, UPDATE], [roleR2]),
      async (tx) => {
        await tx.execute(sql`
        UPDATE ${knowledgeRel("documents")}
        SET body = 'carol should not be able to write this'
        WHERE id = ${doc.id}::uuid AND org_id = ${orgId}::uuid
      `)
        return tx.execute(
          sql`SELECT body FROM ${knowledgeRel("documents")} WHERE id = ${doc.id}::uuid`,
        )
      },
    )
    expect(extractRows<{ body: string }>(carolRlsUpdateRows)[0]?.body).toBe(
      "raw rls role-editor write",
    )
  })

  it("no admin bypass: org_access='viewer' + editor role-share to R — an admin-scoped caller not in R can READ but the UPDATE is DENIED; a caller in R can write", async () => {
    const roleR = randomUUID()
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], [])
    const doc = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Comp plan (role-gated edit, viewer audience)",
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

    await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        {
          orgAccess: "viewer",
          editScope: null,
          shares: [],
          roleShares: [{ roleId: roleR, role: "editor" }],
        },
        aliceActor,
      ),
    )

    // Carol holds broad admin/wildcard scopes but is NOT in role R.
    const carolAdminActor = actor(carol, [READ, UPDATE, ADMIN, "*"], [])
    const carolRead = await withRlsContext(ctx(carol, carolAdminActor.scopes, []), (tx) =>
      loadKnowledgeDocument(tx, doc.id, carolAdminActor),
    )
    // org_access='viewer' is a broad read grant — Carol can still view.
    expect(carolRead?.id).toBe(doc.id)

    // But the UPDATE is denied: no admin bypass on the role-gated editor share.
    await expect(
      withRlsContext(ctx(carol, carolAdminActor.scopes, []), (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: doc.id, revision: doc.revision, title: "Carol (admin, not in role R) hijack" },
          carolAdminActor,
          [],
        ),
      ),
    ).rejects.toThrow(KnowledgeError)

    // Raw RLS: the admin's UPDATE matches 0 rows (no bypass), so the body is
    // UNCHANGED. Carol CAN still read (org_access='viewer'), so denial is proven by
    // the body NOT being mutated, not by row visibility.
    const carolRlsUpdateRows = await withRlsContext(
      ctx(carol, [READ, UPDATE, ADMIN, "*"], []),
      async (tx) => {
        await tx.execute(sql`
          UPDATE ${knowledgeRel("documents")}
          SET body = 'carol (admin) should not be able to write this'
          WHERE id = ${doc.id}::uuid AND org_id = ${orgId}::uuid
        `)
        return tx.execute(
          sql`SELECT body FROM ${knowledgeRel("documents")} WHERE id = ${doc.id}::uuid`,
        )
      },
    )
    expect(extractRows<{ body: string }>(carolRlsUpdateRows)[0]?.body).toBe("v1")

    // Bob, who DOES hold role R, can write.
    const bobActor = actor(bob, [READ, UPDATE], [roleR])
    const bobUpdated = await withRlsContext(ctx(bob, bobActor.scopes, [roleR]), (tx) =>
      updateKnowledgeDocument(
        tx,
        {
          id: doc.id,
          revision: doc.revision,
          title: "Bob (role R editor) maintains the comp plan",
        },
        bobActor,
        [],
      ),
    )
    expect(bobUpdated.title).toBe("Bob (role R editor) maintains the comp plan")
  })

  it("service round-trip: setDocumentSharing({roleShares}) → getDocumentSharing reflects it; undefined leaves unchanged; [] clears", async () => {
    const roleR = randomUUID()
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], [])
    const doc = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Role-share roundtrip doc",
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

    // Default sharing state: no role shares yet.
    const initial = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      getDocumentSharing(tx, doc.id, aliceActor),
    )
    expect(initial.roleShares).toEqual([])

    // Set roleShares: [{roleId: R, role: 'editor'}].
    const setResult = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        {
          orgAccess: "editor",
          editScope: null,
          shares: [],
          roleShares: [{ roleId: roleR, role: "editor" }],
        },
        aliceActor,
      ),
    )
    expect(setResult.roleShares).toEqual([{ roleId: roleR, role: "editor" }])

    const afterSet = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      getDocumentSharing(tx, doc.id, aliceActor),
    )
    expect(afterSet.roleShares).toEqual([{ roleId: roleR, role: "editor" }])

    // Calling setDocumentSharing again WITHOUT roleShares (undefined) leaves the role ACL intact.
    const withoutRoleShares = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        { orgAccess: "editor", editScope: null, shares: [] },
        aliceActor,
      ),
    )
    expect(withoutRoleShares.roleShares).toEqual([{ roleId: roleR, role: "editor" }])

    const afterOmit = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      getDocumentSharing(tx, doc.id, aliceActor),
    )
    expect(afterOmit.roleShares).toEqual([{ roleId: roleR, role: "editor" }])

    // Calling with roleShares: [] CLEARS the role ACL.
    const cleared = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        { orgAccess: "editor", editScope: null, shares: [], roleShares: [] },
        aliceActor,
      ),
    )
    expect(cleared.roleShares).toEqual([])

    const afterClear = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      getDocumentSharing(tx, doc.id, aliceActor),
    )
    expect(afterClear.roleShares).toEqual([])
  })

  it("combined: loadDocumentShareRole returns 'editor' when the actor has a viewer per-user share AND an editor role-share (strongest wins)", async () => {
    const roleR = randomUUID()
    const aliceActor = actor(alice, [CREATE, READ, UPDATE], [])
    const doc = await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Combined share-strength doc",
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

    // Bob gets a per-user VIEWER share AND role R gets an EDITOR role-share; Bob holds role R.
    await withRlsContext(ctx(alice, aliceActor.scopes), (tx) =>
      setDocumentSharing(
        tx,
        doc.id,
        {
          orgAccess: "none",
          editScope: null,
          shares: [{ userId: bob, role: "viewer" }],
          roleShares: [{ roleId: roleR, role: "editor" }],
        },
        aliceActor,
      ),
    )

    const bobActor = actor(bob, [READ, UPDATE], [roleR])
    const effectiveRole = await withRlsContext(ctx(bob, bobActor.scopes, [roleR]), (tx) =>
      loadDocumentShareRole(tx, doc.id, bobActor),
    )
    expect(effectiveRole).toBe("editor")

    // And that composed role actually unlocks a write via the service layer.
    const bobUpdated = await withRlsContext(ctx(bob, bobActor.scopes, [roleR]), (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: doc.id, revision: doc.revision, title: "Bob (viewer share + editor role) writes" },
        bobActor,
        [],
      ),
    )
    expect(bobUpdated.title).toBe("Bob (viewer share + editor role) writes")
  })
})
