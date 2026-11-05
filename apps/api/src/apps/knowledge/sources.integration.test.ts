// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for sources.ts (T10) — `app_knowledge.source_policies`
 * load + upsert. Mirrors the collections.integration.test.ts pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import { loadSourcePolicy, updateSourcePolicy } from "~/apps/knowledge/sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string

const SOURCES_READ = "knowledge:sources:read"
const SOURCES_MANAGE = "knowledge:sources:manage"

function actor(userId: string, scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
}

function rlsCtx(userId: string, scopes: string[]) {
  return { actorType: "user" as const, orgId, userId, scopes, dimensionGrants: {} }
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-sources-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeSourcesIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@src.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
})

afterAll(releaseTestLock)

describe("sources.ts (DB integration)", () => {
  it("loadSourcePolicy returns zero-cache default when no row exists", async () => {
    const a = actor(alice, [SOURCES_READ])
    const row = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      loadSourcePolicy(tx, "google-drive", a),
    )
    expect(row.policy).toBe("remote_search")
    expect(row.cacheBytes).toBe(0)
    expect(row.updatedAt).toBeNull()
  })

  it("updateSourcePolicy upserts and returns the new row", async () => {
    const a = actor(alice, [SOURCES_READ, SOURCES_MANAGE])
    const row = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      updateSourcePolicy(tx, "google-drive", { policy: "metadata_only", retentionDays: 30 }, a),
    )
    expect(row.policy).toBe("metadata_only")
    expect(row.retentionDays).toBe(30)
    expect(row.updatedAt).not.toBeNull()

    // Subsequent load reads the persisted row, not the default.
    const reread = await withRlsContext(rlsCtx(alice, [SOURCES_READ]), (tx) =>
      loadSourcePolicy(tx, "google-drive", actor(alice, [SOURCES_READ])),
    )
    expect(reread.policy).toBe("metadata_only")
  })

  it("downgrade from content_cache to remote_search marks cache entries unusable", async () => {
    const a = actor(alice, [SOURCES_READ, SOURCES_MANAGE, "knowledge:cache:manage"])
    const src = `cache-src-${Date.now()}`
    // Upgrade to content_cache.
    await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      updateSourcePolicy(tx, src, { policy: "content_cache" }, a),
    )
    // Seed a source identity + a usable cache row.
    const identityId = await withRlsContext(rlsCtx(alice, a.scopes), async (tx) => {
      const ins = await tx.execute(sql`
        INSERT INTO ${knowledgeRel("source_identities")}
          (id, org_id, source, external_id, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${src}, ${`ext-${Date.now()}`}, now(), now())
        RETURNING id
      `)
      return extractRows<{ id: string }>(ins)[0]!.id
    })
    await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      tx.execute(sql`
        INSERT INTO ${knowledgeRel("content_cache_entries")}
          (id, org_id, source_identity_id, policy, usable)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${identityId}::uuid, 'content_cache', true)
      `),
    )
    // Downgrade — cache rows must flip to usable=false.
    await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      updateSourcePolicy(tx, src, { policy: "remote_search" }, a),
    )
    const rows = await withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
      tx.execute(
        sql`SELECT usable FROM ${knowledgeRel("content_cache_entries")}
            WHERE source_identity_id = ${identityId}::uuid`,
      ),
    )
    const r = extractRows<{ usable: boolean }>(rows)
    expect(r).toHaveLength(1)
    expect(r[0]!.usable).toBe(false)
  })

  it("curator (sources:manage, NO cache:manage) can downgrade — invalidation runs privileged", async () => {
    // The curator role owns source settings but lacks knowledge:cache:manage.
    // Pre-fix, the cache-invalidation UPDATE ran on the request RLS tx and its
    // WITH CHECK aborted the whole downgrade. The fix runs invalidation under a
    // privileged connection, so the curator can downgrade.
    const curatorScopes = [SOURCES_READ, SOURCES_MANAGE]
    const a = actor(alice, curatorScopes)
    const src = `curator-cache-src-${Date.now()}`
    await withRlsContext(rlsCtx(alice, curatorScopes), (tx) =>
      updateSourcePolicy(tx, src, { policy: "content_cache" }, a),
    )
    // Seed identity + a usable cache row via the privileged connection — the
    // curator cannot write content_cache_entries directly (that is the point).
    const identityId = extractRows<{ id: string }>(
      await db.execute(sql`
        INSERT INTO ${knowledgeRel("source_identities")}
          (id, org_id, source, external_id, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${src}, ${`ext-${Date.now()}`}, now(), now())
        RETURNING id
      `),
    )[0]!.id
    await db.execute(sql`
      INSERT INTO ${knowledgeRel("content_cache_entries")}
        (id, org_id, source_identity_id, policy, usable)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${identityId}::uuid, 'content_cache', true)
    `)
    // Downgrade as the curator — must NOT throw, must persist the policy, and
    // must flip the cache row unusable.
    const row = await withRlsContext(rlsCtx(alice, curatorScopes), (tx) =>
      updateSourcePolicy(tx, src, { policy: "remote_search" }, a),
    )
    expect(row.policy).toBe("remote_search")
    const cache = extractRows<{ usable: boolean }>(
      await db.execute(
        sql`SELECT usable FROM ${knowledgeRel("content_cache_entries")}
            WHERE source_identity_id = ${identityId}::uuid`,
      ),
    )
    expect(cache).toHaveLength(1)
    expect(cache[0]!.usable).toBe(false)
  })

  it("write without sources:manage is rejected by RLS", async () => {
    const a = actor(alice, [SOURCES_READ])
    await expect(
      withRlsContext(rlsCtx(alice, a.scopes), (tx) =>
        updateSourcePolicy(tx, "no-manage", { policy: "metadata_only" }, a),
      ),
    ).rejects.toThrow()
  })
})
