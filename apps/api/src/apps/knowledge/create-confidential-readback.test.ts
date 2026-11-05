// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (l347): the knowledge_documents_select RLS must let a document's CREATOR/OWNER read
// back their OWN doc regardless of the sensitivity ladder. Previously org docs were gated purely on
// can_read_knowledge_dimensions (sensitivity), with NO owner/creator exception — so a path that
// inserts a confidential doc without a matching sensitivity grant (e.g. capture_business_knowledge)
// then failed its own read-back ("Knowledge document not found after insert"). The SELECT policy now
// ORs in: a creator/owner (created_by/owner_user_id = current user) who holds knowledge:documents:read
// sees their own doc. Non-owners without the sensitivity grant still cannot (negative control).
// (Surfaced by knowledge-capture-dealer-pricing-from-chat.)
//
// UPDATED (Google-Drive-style sharing, 0002 migration): access to an org doc is now ALSO governed by
// `org_access` — a broad 'viewer'/'editor' org-wide audience — independent of team/sensitivity. The
// migration's column DEFAULT is 'editor' (preserves pre-sharing collaborative-editing behavior), so the
// negative control below must explicitly set org_access='none' (restricted) on the fixture row —
// otherwise EVERY org member would see it via the org_access broad-audience clause, not just the
// owner/creator clause this test targets, and the control would no longer isolate what it claims to.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createKnowledgeDocument, knowledgeActorFromContext } from "~/apps/knowledge/service"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"

let orgId: string
let ownerId: string
let otherId: string
let docId: string

beforeAll(async () => {
  const slug = `kconf-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("kconf-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'KConf Test', ${slug}) RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const ow = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`owner-${slug}@x.test`}, 'Owner', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    ownerId = (ow.rows ?? ow)[0].id
    const ot = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`other-${slug}@x.test`}, 'Other', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    otherId = (ot.rows ?? ot)[0].id
    // A CONFIDENTIAL, RESTRICTED (org_access='none') org doc owned+authored by `owner`, inserted
    // privileged (mimics the capture_business_knowledge insert path that skips the set-dimensions
    // pre-check). org_access is explicitly 'none' so this test isolates the owner/creator clause from
    // the (now default 'editor') org-wide broad-audience clause — see the file-header note.
    const d = (await tx.execute(drizzleSql`
      INSERT INTO app_knowledge.documents
        (id, org_id, title, body, document_scope, sensitivity, team, review_status, revision, owner_user_id, created_by, org_access, required_scopes)
      VALUES (gen_random_uuid(), ${orgId}, 'Tonwerk dealer terms', '40% @10 / 45% @25 / NET-30', 'organization', 'confidential', '[]'::jsonb, 'unverified', 0, ${ownerId}::uuid, ${ownerId}::uuid, 'none', '{}'::text[])
      RETURNING id
    `)) as any
    docId = (d.rows ?? d)[0].id
  })
})

function actor(userId: string) {
  return {
    actorType: "user" as const,
    userId,
    orgId,
    scopes: ["knowledge:documents:read"],
    dimensionGrants: {}, // NO sensitivity grant — only the owner clause can grant visibility
  }
}

async function visibleTo(userId: string): Promise<boolean> {
  return withRlsContext(actor(userId), async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM app_knowledge.documents WHERE id = ${docId}::uuid AND org_id = ${orgId}::uuid LIMIT 1
      `),
    )
    return rows.length > 0
  })
}

describe("knowledge confidential doc read-back — owner/creator clause (l347 regression)", () => {
  it("the OWNER/creator reads back their own confidential doc without a sensitivity grant", async () => {
    expect(await visibleTo(ownerId)).toBe(true) // pre-fix: false → 'not found after insert'
  })

  it("a NON-owner without the sensitivity grant still cannot see the confidential doc (control)", async () => {
    expect(await visibleTo(otherId)).toBe(false)
  })
})

// BL-197 end-to-end: the REAL knowledge__create path (createKnowledgeDocument inserts then read-backs
// the row under the caller's RLS to RETURN it). A team-less confidential ORG doc — exactly what
// knowledge-capture-dealer-pricing-from-chat writes — is only readable back via the l347 creator/owner
// clause, which (per the BS-4 floor) requires knowledge:documents:read. So a create-ONLY actor's
// read-back returns 0 rows → "Knowledge document not found after insert" (the scenario's blocker); a
// create+read actor succeeds. Pins WHY the sales persona must hold :read alongside :create.
//
// orgAccess is explicitly 'none' below so this scenario still isolates the l347 owner/creator clause —
// the column's DEFAULT is now 'editor' (0002 sharing migration), which would let ANY :read-scoped actor
// read the doc back via the org-wide broad-audience clause, masking the :read-scope requirement this
// test exists to pin.
function createActor(userId: string, scopes: string[]) {
  // dimensionGrants carry the seed's prefixed knowledge keys; knowledgeActorFromContext aliases them
  // to bare team/sensitivity + expands the ladder so assertCanSetDimensions admits confidential.
  const dimensionGrants = { "knowledge:sensitivity": ["confidential"], "knowledge:team": ["*"] }
  const rls = { actorType: "user" as const, userId, orgId, scopes, dimensionGrants }
  const knowledgeActor = knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants })
  return { rls, knowledgeActor }
}

async function capture(userId: string, scopes: string[]): Promise<string> {
  const { rls, knowledgeActor } = createActor(userId, scopes)
  return withRlsContext(rls, async (tx) => {
    const doc = await createKnowledgeDocument(
      tx,
      {
        documentScope: "organization",
        title: "Tonwerk Audio — dealer terms",
        body: "40% @10 / 45% @25 / NET-30",
        sensitivity: "confidential",
        team: [],
        orgAccess: "none",
        collectionIds: [],
        tagNames: [],
        verifyNow: false,
      },
      knowledgeActor,
      [],
    )
    return doc.id
  })
}

describe("knowledge capture read-back through the real create service (BL-197)", () => {
  it("a CREATE+READ actor captures a confidential org doc and the create read-back succeeds", async () => {
    const id = await capture(ownerId, ["knowledge:documents:create", "knowledge:documents:read"])
    expect(id).toBeTruthy()
  })

  it("a CREATE-ONLY actor (no :read) fails the read-back — reproduces 'not found after insert'", async () => {
    // pre-fix sales had exactly this bundle → every knowledge__create errored. The persona now also
    // holds :read (personas.ts); this asserts the create tool genuinely needs it.
    await expect(capture(otherId, ["knowledge:documents:create"])).rejects.toThrow(
      /not found after insert/i,
    )
  })
})
