// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for the rewritten tags.ts (T3).
 * Mirrors the pattern in service.integration.test.ts and
 * collections.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import {
  listKnowledgeTags,
  normalizeKnowledgeTagName,
  upsertKnowledgeTag,
} from "~/apps/knowledge/tags"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string

const TAG_MANAGE = "knowledge:tags:manage"
const DOC_READ = "knowledge:documents:read"

function actor(
  uid: string,
  scopes: string[],
  grants: Record<string, string[]> = {},
): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId: uid, scopes, dimensionGrants: grants })
}

function rls(uid: string, scopes: string[], grants: Record<string, string[]> = {}) {
  return { actorType: "user" as const, orgId, userId: uid, scopes, dimensionGrants: grants }
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-tags-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeTagsIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id
  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@tags.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
})

afterAll(releaseTestLock)

describe("tags.ts (DB integration)", () => {
  it("normalises name: trim, lowercase, single-space", () => {
    expect(normalizeKnowledgeTagName("  Foo   Bar ")).toBe("foo bar")
  })

  it("requires knowledge:tags:manage scope", async () => {
    const a = actor(alice, [DOC_READ])
    await expect(
      withRlsContext(rls(alice, a.scopes), (tx) => upsertKnowledgeTag(tx, { name: "x" }, a)),
    ).rejects.toThrow(/Forbidden/i)
  })

  it("upsert is idempotent by (orgId, normalizedName)", async () => {
    const a = actor(alice, [TAG_MANAGE, DOC_READ])
    const t1 = await withRlsContext(rls(alice, a.scopes), (tx) =>
      upsertKnowledgeTag(tx, { name: "Engineering-T3" }, a),
    )
    const t2 = await withRlsContext(rls(alice, a.scopes), (tx) =>
      upsertKnowledgeTag(tx, { name: "  engineering-t3  " }, a),
    )
    expect(t1.id).toBe(t2.id)
    expect(t2.normalizedName).toBe("engineering-t3")
    expect(t2.orgId).toBe(orgId)
  })

  it("listKnowledgeTags returns org-local tags", async () => {
    const a = actor(alice, [TAG_MANAGE, DOC_READ])
    await withRlsContext(rls(alice, a.scopes), (tx) =>
      upsertKnowledgeTag(tx, { name: "alpha-list" }, a),
    )
    const tags = await withRlsContext(rls(alice, a.scopes), (tx) => listKnowledgeTags(tx, a))
    expect(tags.some((t) => t.normalizedName === "alpha-list")).toBe(true)
  })
})
