// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * RLS integration tests for T17 — pins the BS-4 (personal doc requires
 * :read scope) and BS-5 (taggings/memberships filtered by target visibility)
 * floors, plus the I20 source_identities UNIQUE INDEX.
 *
 * These tests bypass the service layer and exercise the raw SQL paths under
 * `liaison_rls` so the assertions are *only* enforced by RLS, not by any
 * defensive code in TypeScript.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-rls-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeRlsIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@rls.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id

  const [b] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@rls.test`}, 'Bob', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  bob = b!.id
})

afterAll(releaseTestLock)

function ctx(userId: string, scopes: string[]) {
  return {
    actorType: "user" as const,
    orgId,
    userId,
    scopes,
    dimensionGrants: { sensitivity: ["internal"], team: ["*"] },
  }
}

describe("RLS hardening (T17)", () => {
  it("BS-4: personal doc SELECT requires knowledge:documents:read even for owner", async () => {
    // Insert as alice with read scope (otherwise the INSERT would be denied).
    const docId = await withRlsContext(
      ctx(alice, ["knowledge:documents:create", "knowledge:documents:read"]),
      async (tx) => {
        const r = await tx.execute(sql`
          INSERT INTO ${knowledgeRel("documents")}
            (id, org_id, title, document_scope, owner_user_id, participant_ids, sensitivity, revision, created_by, required_scopes)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'Mine', 'personal', ${alice}::uuid, '[]'::jsonb, NULL, 1, ${alice}::uuid, '{}'::text[])
          RETURNING id
        `)
        return extractRows<{ id: string }>(r)[0]!.id
      },
    )

    // Same user, but missing :read scope — RLS must hide the row.
    const rowsWithoutRead = await withRlsContext(ctx(alice, []), async (tx) =>
      tx.execute(sql`SELECT id FROM ${knowledgeRel("documents")} WHERE id = ${docId}::uuid`),
    )
    expect(extractRows(rowsWithoutRead)).toHaveLength(0)

    // With :read scope, the row is visible again.
    const rowsWithRead = await withRlsContext(
      ctx(alice, ["knowledge:documents:read"]),
      async (tx) =>
        tx.execute(sql`SELECT id FROM ${knowledgeRel("documents")} WHERE id = ${docId}::uuid`),
    )
    expect(extractRows(rowsWithRead)).toHaveLength(1)
  })

  it("BS-5: bob does NOT see taggings rows whose target is alice's personal doc", async () => {
    // Alice creates a personal doc and tags it.
    const { docId, tagId } = await withRlsContext(
      ctx(alice, [
        "knowledge:documents:create",
        "knowledge:documents:read",
        "knowledge:tags:manage",
      ]),
      async (tx) => {
        const d = await tx.execute(sql`
          INSERT INTO ${knowledgeRel("documents")}
            (id, org_id, title, document_scope, owner_user_id, participant_ids, sensitivity, revision, created_by, required_scopes)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'Hidden', 'personal', ${alice}::uuid, '[]'::jsonb, NULL, 1, ${alice}::uuid, '{}'::text[])
          RETURNING id
        `)
        const docId = extractRows<{ id: string }>(d)[0]!.id

        const name = `hidden-${Date.now()}`
        const t = await tx.execute(sql`
          INSERT INTO ${knowledgeRel("tags")}
            (id, org_id, name, normalized_name)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${name}, ${name.toLowerCase()})
          RETURNING id
        `)
        const tagId = extractRows<{ id: string }>(t)[0]!.id

        await tx.execute(sql`
          INSERT INTO ${knowledgeRel("taggings")}
            (id, org_id, tag_id, target_type, target_id, created_by)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${tagId}::uuid, 'document', ${docId}::uuid, ${alice}::uuid)
        `)
        return { docId, tagId }
      },
    )

    // Bob has :read + :tags:manage but cannot SEE alice's personal doc, so
    // the tagging row joining to it must also be hidden.
    const rows = await withRlsContext(
      ctx(bob, ["knowledge:documents:read", "knowledge:tags:manage"]),
      async (tx) =>
        tx.execute(
          sql`SELECT id FROM ${knowledgeRel("taggings")} WHERE target_id = ${docId}::uuid`,
        ),
    )
    expect(extractRows(rows)).toHaveLength(0)

    // sanity: tag itself is enumerable org-wide (taxonomy not sensitive).
    const tagRows = await withRlsContext(ctx(bob, ["knowledge:documents:read"]), async (tx) =>
      tx.execute(sql`SELECT id FROM ${knowledgeRel("tags")} WHERE id = ${tagId}::uuid`),
    )
    expect(extractRows(tagRows)).toHaveLength(1)
  })

  it("I20: source_identities UNIQUE(org_id, source, external_id) blocks duplicate inserts", async () => {
    const scopes = ["knowledge:sources:read", "knowledge:sources:manage"]
    const ext = `dup-${Date.now()}`
    await withRlsContext(ctx(alice, scopes), (tx) =>
      tx.execute(sql`
        INSERT INTO ${knowledgeRel("source_identities")}
          (id, org_id, source, external_id)
        VALUES (gen_random_uuid(), ${orgId}::uuid, 'google-drive', ${ext})
      `),
    )
    let caught: unknown
    try {
      await withRlsContext(ctx(alice, scopes), (tx) =>
        tx.execute(sql`
          INSERT INTO ${knowledgeRel("source_identities")}
            (id, org_id, source, external_id)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'google-drive', ${ext})
        `),
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    // Drizzle wraps the original PostgresError — inspect the chain for the
    // duplicate-key signature so the index, not some other failure, is the cause.
    const chain: string[] = []
    let cur: unknown = caught
    while (cur && typeof cur === "object") {
      const r = cur as { message?: string; cause?: unknown; code?: string }
      if (r.message) chain.push(r.message)
      if (r.code) chain.push(r.code)
      cur = r.cause
    }
    expect(chain.join("\n")).toMatch(/duplicate key|unique|23505/i)
  })

  // BL-277: the RLS UPDATE policy on app_knowledge.documents was OWNER-ONLY for EVERY scope, so a
  // NON-OWNER member holding knowledge:documents:update could not UPDATE a SHARED ORGANIZATION doc — the
  // UPDATE silently matched ZERO rows (RLS USING false), the service reloaded the unchanged row and
  // returned "success", so a knowledge.update CLAIMED to land but wrote nothing (the firmware-keep-fresh
  // routine tick's troubleshooting-doc body update never persisted). The service-layer authz
  // (assertCanWriteDocumentRow, l724) already allows an org doc + update-scope; the RLS policy now
  // mirrors it. This test pins the floor at the RAW RLS layer (no service code): bob (non-owner) updates
  // alice's ORG doc and the row REALLY changes; a PERSONAL doc stays owner-only.
  it("BL-277: a non-owner with knowledge:documents:update can UPDATE a shared ORGANIZATION doc (RLS)", async () => {
    // Alice owns an ORG-scoped doc (revision 0).
    const orgDocId = await withRlsContext(
      ctx(alice, ["knowledge:documents:create", "knowledge:documents:read"]),
      async (tx) => {
        const r = await tx.execute(sql`
          INSERT INTO ${knowledgeRel("documents")}
            (id, org_id, title, body, document_scope, owner_user_id, participant_ids, sensitivity, team, revision, created_by, required_scopes)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'Shared org guide', 'before', 'organization', ${alice}::uuid, '[]'::jsonb, 'internal', '[]'::jsonb, 0, ${alice}::uuid, '{}'::text[])
          RETURNING id
        `)
        return extractRows<{ id: string }>(r)[0]!.id
      },
    )

    // BOB (NOT the owner) updates the body under RLS with the update scope. The UPDATE must affect the row.
    const updatedRows = await withRlsContext(
      ctx(bob, ["knowledge:documents:read", "knowledge:documents:update"]),
      async (tx) => {
        await tx.execute(sql`
          UPDATE ${knowledgeRel("documents")}
          SET body = 'after — bob appended', revision = revision + 1, updated_by = ${bob}::uuid, updated_at = now()
          WHERE id = ${orgDocId}::uuid AND org_id = ${orgId}::uuid
        `)
        return extractRows<{ body: string; revision: number }>(
          await tx.execute(
            sql`SELECT body, revision FROM ${knowledgeRel("documents")} WHERE id = ${orgDocId}::uuid`,
          ),
        )
      },
    )
    // The write LANDED: body changed + revision bumped (0 → 1). On the old owner-only policy this UPDATE
    // matched 0 rows and the body would still read 'before' at revision 0 (the silent no-op this fixes).
    expect(updatedRows).toHaveLength(1)
    expect(updatedRows[0]!.body).toBe("after — bob appended")
    expect(updatedRows[0]!.revision).toBe(1)

    // A PERSONAL doc owned by alice must STILL be owner-only — bob's UPDATE matches 0 rows (privacy floor).
    const personalDocId = await withRlsContext(
      ctx(alice, ["knowledge:documents:create", "knowledge:documents:read"]),
      async (tx) => {
        const r = await tx.execute(sql`
          INSERT INTO ${knowledgeRel("documents")}
            (id, org_id, title, body, document_scope, owner_user_id, participant_ids, sensitivity, revision, created_by, required_scopes)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'Alice private', 'secret', 'personal', ${alice}::uuid, '[]'::jsonb, NULL, 0, ${alice}::uuid, '{}'::text[])
          RETURNING id
        `)
        return extractRows<{ id: string }>(r)[0]!.id
      },
    )
    const personalAfterBob = await withRlsContext(
      ctx(bob, ["knowledge:documents:read", "knowledge:documents:update"]),
      async (tx) => {
        await tx.execute(sql`
          UPDATE ${knowledgeRel("documents")}
          SET body = 'bob should not be able to write this'
          WHERE id = ${personalDocId}::uuid AND org_id = ${orgId}::uuid
        `)
        return extractRows<{ body: string }>(
          await tx.execute(
            sql`SELECT body FROM ${knowledgeRel("documents")} WHERE id = ${personalDocId}::uuid`,
          ),
        )
      },
    )
    // Bob cannot SELECT alice's personal doc (BS-4) and cannot write it — the body is unchanged.
    // (The SELECT under bob returns 0 rows; re-read as alice to confirm the body never changed.)
    const personalAsAlice = await withRlsContext(ctx(alice, ["knowledge:documents:read"]), (tx) =>
      tx.execute(
        sql`SELECT body FROM ${knowledgeRel("documents")} WHERE id = ${personalDocId}::uuid`,
      ),
    )
    expect(extractRows(personalAfterBob)).toHaveLength(0)
    expect(extractRows<{ body: string }>(personalAsAlice)[0]!.body).toBe("secret")
  })
})
