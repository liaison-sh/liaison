// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for the SQL-backed computeAttentionItems (T5).
 * Mirrors collections.integration.test.ts pattern (acquireTestLock +
 * withRlsContext, raw-SQL org/user inserts; no plan-referenced helpers).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/knowledge/attention"
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

const DOC_CREATE = "knowledge:documents:create"
const DOC_UPDATE = "knowledge:documents:update"
const DOC_READ = "knowledge:documents:read"

function actor(scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({
    orgId,
    userId: alice,
    scopes,
    dimensionGrants: { sensitivity: ["internal"], team: ["*"] },
  })
}

function rlsCtx(scopes: string[]) {
  return {
    actorType: "user" as const,
    orgId,
    userId: alice,
    scopes,
    dimensionGrants: { sensitivity: ["internal"], team: ["*"] },
  }
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-attention-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeAttentionIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@attn.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
})

afterAll(releaseTestLock)

describe("computeAttentionItems (SQL-backed)", () => {
  it("emits 'review_needed' for documents whose status is needs_review", async () => {
    const a = actor([DOC_CREATE, DOC_UPDATE, DOC_READ])
    const d = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "Review me",
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
    // Flip review_status to needs_review directly to avoid coupling this test
    // to whatever produces that status in the broader review lifecycle.
    await withRlsContext(rlsCtx(a.scopes), (tx) =>
      tx.execute(sql`
        UPDATE ${knowledgeRel("documents")}
        SET review_status = 'needs_review', review_reason = 'review_needed'
        WHERE id = ${d.id}::uuid
      `),
    )
    const items = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      computeAttentionItems(tx, orgId, alice),
    )
    expect(items.some((i) => i.entityId === d.id && i.metadata?.reason === "review_needed")).toBe(
      true,
    )
  })

  it("collapses duplicate reasons via dedupe key", async () => {
    const a = actor([DOC_CREATE, DOC_READ])
    await withRlsContext(rlsCtx(a.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "OldDue",
          body: "",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
          reviewDueAt: "1970-01-01T00:00:00Z",
        } as never,
        a,
        [],
      ),
    )
    const items = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      computeAttentionItems(tx, orgId, alice),
    )
    const keys = items.map((i) => i.id)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("returns 'expired' for documents past their reviewDueAt", async () => {
    const a = actor([DOC_CREATE, DOC_READ])
    const d = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      createKnowledgeDocument(
        tx,
        {
          documentScope: "organization",
          title: "ExpiredDoc",
          body: "",
          collectionIds: [],
          tagNames: [],
          team: [],
          sensitivity: "internal",
          verifyNow: false,
          reviewDueAt: "2000-01-01T00:00:00Z",
        } as never,
        a,
        [],
      ),
    )
    const items = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      computeAttentionItems(tx, orgId, alice),
    )
    expect(items.some((i) => i.entityId === d.id && i.metadata?.reason === "expired")).toBe(true)
  })

  it("collapses an owner_missing flood into one aggregate item opening the Knowledge tab", async () => {
    const a = actor([DOC_READ])
    // A bulk import writes docs directly (no service-level owner default), so
    // seed the flood with raw inserts carrying owner_user_id = NULL.
    for (let i = 0; i < 6; i++) {
      await db.execute(sql`
        INSERT INTO ${knowledgeRel("documents")} (
          id, org_id, title, body, document_scope, owner_user_id,
          team, sensitivity, created_by
        , required_scopes)
        VALUES (
          gen_random_uuid(), ${orgId}::uuid, ${`flood-${i}.md`}, '', 'organization', NULL,
          '[]'::jsonb, 'internal', ${alice}::uuid
        , '{}'::text[])
      `)
    }
    const items = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      computeAttentionItems(tx, orgId, alice),
    )
    const ownerMissing = items.filter((i) => i.metadata?.reason === "owner_missing")
    expect(ownerMissing).toHaveLength(1)
    const agg = ownerMissing[0]!
    expect(agg.entity).toBe("home")
    expect(agg.action).toEqual({ type: "open_entity", tabType: "knowledge:home", entityId: "" })
    expect(agg.metadata?.aggregateCount).toBeGreaterThanOrEqual(6)
    expect(agg.summary).toContain("no owner assigned")
  })
})
