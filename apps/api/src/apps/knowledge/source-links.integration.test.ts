// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for source-links.ts (T4). Uses the real DB + RLS pattern
 * from collections.integration.test.ts (no plan-referenced setupTestOrg).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import {
  createKnowledgeSourceRegistry,
  type KnowledgeSourceRegistry,
} from "~/apps/knowledge/federated-search"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import {
  archiveSourceLink,
  linkRemoteDocument,
  refreshSourceLinkMetadata,
  verifySourceLink,
} from "~/apps/knowledge/source-links"
import { registerDefaultKnowledgeSources } from "~/apps/knowledge/source-registry"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { knowledgeItemsRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string

const LINK_CREATE = "knowledge:links:create"
const DOC_READ = "knowledge:documents:read"
const DOC_UPDATE = "knowledge:documents:update"
const SOURCES_READ = "knowledge:sources:read"
const SOURCES_MANAGE = "knowledge:sources:manage"
const COLL_MANAGE = "knowledge:collections:manage"

function actor(scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId: alice, scopes, dimensionGrants: {} })
}

function rlsCtx(scopes: string[]) {
  return {
    actorType: "user" as const,
    orgId,
    userId: alice,
    scopes,
    dimensionGrants: {},
  }
}

function stubRegistry(
  visible: boolean,
  opts?: { title?: string; url?: string },
): KnowledgeSourceRegistry {
  const reg = createKnowledgeSourceRegistry()
  reg.register({
    source: "google-drive",
    searchRemote: async () => ({
      hits: [],
      status: { source: "google-drive", state: "complete", retryable: false },
    }),
    getRemoteMetadata: async () =>
      visible
        ? {
            source: "google-drive",
            externalId: "x",
            title: opts?.title ?? "Doc",
            url: opts?.url ?? "https://drive/x",
          }
        : null,
  })
  return reg
}

beforeAll(async () => {
  await acquireTestLock()
  const slug = `knowledge-srclinks-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'KnowledgeSourceLinksIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id

  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@srclinks.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
})

afterAll(releaseTestLock)

describe("source-links.ts (DB integration)", () => {
  it("upserts identity + link once per (org, source, externalId); idempotent on rerun", async () => {
    const a = actor([LINK_CREATE, SOURCES_READ, SOURCES_MANAGE, DOC_READ, DOC_UPDATE])
    const reg = stubRegistry(true)
    const r1 = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        { source: "google-drive", externalId: "file_1", title: "Doc" },
        reg,
        a,
      ),
    )
    const r2 = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        { source: "google-drive", externalId: "file_1", title: "Doc" },
        reg,
        a,
      ),
    )
    expect(r1.id).toBe(r2.id)
    const idents = await withRlsContext(rlsCtx(a.scopes), async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(sql`
          SELECT id FROM ${knowledgeRel("source_identities")}
          WHERE org_id = ${orgId}::uuid AND source = 'google-drive' AND external_id = 'file_1'
        `),
      ),
    )
    expect(idents).toHaveLength(1)
  })

  it("rejects when adapter says remote is not visible", async () => {
    const a = actor([LINK_CREATE, SOURCES_READ, SOURCES_MANAGE, DOC_READ])
    const reg = stubRegistry(false)
    await expect(
      withRlsContext(rlsCtx(a.scopes), (tx) =>
        linkRemoteDocument(
          (fn) => fn(tx),
          { source: "google-drive", externalId: "x_invisible", title: "Doc" },
          reg,
          a,
        ),
      ),
    ).rejects.toThrow(/visible|FORBIDDEN/i)
  })

  it("hierarchical scope `knowledge:*` allows link creation (hasScope, not Array.includes)", async () => {
    const a = actor(["knowledge:*", DOC_READ])
    const reg = stubRegistry(true)
    const r = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        { source: "google-drive", externalId: "file_hier", title: "Doc" },
        reg,
        a,
      ),
    )
    expect(r.id).toBeTruthy()
  })

  it("verify requires only knowledge:documents:update (drops :source-links:write)", async () => {
    const a = actor([LINK_CREATE, DOC_UPDATE, DOC_READ, SOURCES_READ, SOURCES_MANAGE])
    const reg = stubRegistry(true)
    const r = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        { source: "google-drive", externalId: "file_verify", title: "Doc" },
        reg,
        a,
      ),
    )
    const verified = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      verifySourceLink((fn) => fn(tx), r.id, reg, a),
    )
    expect(verified.reviewStatus).toBe("verified")
    expect(verified.verifiedAt).not.toBeNull()
  })

  it("verify marks link stale when remote is gone", async () => {
    const a = actor([LINK_CREATE, DOC_UPDATE, DOC_READ, SOURCES_READ, SOURCES_MANAGE])
    const regOk = stubRegistry(true)
    const link = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        { source: "google-drive", externalId: "file_gone", title: "Doc" },
        regOk,
        a,
      ),
    )
    const regGone = stubRegistry(false)
    const result = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      verifySourceLink((fn) => fn(tx), link.id, regGone, a),
    )
    expect(result.reviewStatus).toBe("stale")
    expect(result.visibilityStatus).toBe("unavailable")
  })

  it("archived link cannot be verified", async () => {
    const a = actor([LINK_CREATE, DOC_UPDATE, DOC_READ, SOURCES_READ, SOURCES_MANAGE])
    const reg = stubRegistry(true)
    const link = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        { source: "google-drive", externalId: "file_arch", title: "Doc" },
        reg,
        a,
      ),
    )
    const archived = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      archiveSourceLink(tx, link.id, a),
    )
    expect(archived.archivedAt).not.toBeNull()
    await expect(
      withRlsContext(rlsCtx(a.scopes), (tx) => verifySourceLink((fn) => fn(tx), link.id, reg, a)),
    ).rejects.toThrow(/archived/i)
  })

  it("refreshSourceLinkMetadata updates title/url from adapter", async () => {
    const a = actor([LINK_CREATE, DOC_UPDATE, DOC_READ, SOURCES_READ, SOURCES_MANAGE])
    const regOld = stubRegistry(true, { title: "Old", url: "https://drive/old" })
    const link = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        { source: "google-drive", externalId: "file_refresh", title: "Old" },
        regOld,
        a,
      ),
    )
    const regNew = stubRegistry(true, { title: "New", url: "https://drive/new" })
    const refreshed = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      refreshSourceLinkMetadata((fn) => fn(tx), link.id, regNew, a),
    )
    expect(refreshed.visibilityStatus).toBe("available")
    const row = await withRlsContext(rlsCtx(a.scopes), async (tx) =>
      extractRows<{ title: string; url: string | null }>(
        await tx.execute(sql`
          SELECT title, url FROM ${knowledgeRel("source_links")}
          WHERE id = ${link.id}::uuid
        `),
      ),
    )
    expect(row[0]!.title).toBe("New")
    expect(row[0]!.url).toBe("https://drive/new")
  })

  it("rejects link creation without knowledge:links:create scope", async () => {
    const a = actor([DOC_READ, SOURCES_READ])
    const reg = stubRegistry(true)
    await expect(
      withRlsContext(rlsCtx(a.scopes), (tx) =>
        linkRemoteDocument(
          (fn) => fn(tx),
          { source: "google-drive", externalId: "file_nope", title: "Doc" },
          reg,
          a,
        ),
      ),
    ).rejects.toThrow(/FORBIDDEN|scope/i)
  })

  it("attaches collection membership when collectionId provided", async () => {
    const a = actor([LINK_CREATE, DOC_READ, SOURCES_READ, SOURCES_MANAGE, COLL_MANAGE])
    // Create a collection inline via direct SQL (avoids cross-module import noise)
    const collId = await withRlsContext(rlsCtx(a.scopes), async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(sql`
          INSERT INTO ${knowledgeRel("collections")} (id, org_id, name, owner_user_id)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`coll-${Date.now()}`}, ${alice}::uuid)
          RETURNING id
        `),
      )
      return rows[0]!.id
    })

    const reg = stubRegistry(true)
    const link = await withRlsContext(rlsCtx(a.scopes), (tx) =>
      linkRemoteDocument(
        (fn) => fn(tx),
        {
          source: "google-drive",
          externalId: "file_in_coll",
          title: "Doc",
          collectionId: collId,
        },
        reg,
        a,
      ),
    )

    const memberships = await withRlsContext(rlsCtx(a.scopes), async (tx) =>
      extractRows<{ collection_id: string }>(
        await tx.execute(sql`
          SELECT collection_id FROM ${knowledgeRel("collection_memberships")}
          WHERE target_type = 'source_link' AND target_id = ${link.id}::uuid
        `),
      ),
    )
    expect(memberships).toHaveLength(1)
    expect(memberships[0]!.collection_id).toBe(collId)
  })
})

// Source links resolve through the app that owns them: the app named by the
// link's `source` declares `knowledgeItems.resolve` (source-registry.ts). A link
// an earlier release wrote (source = the app's name, external id = the item's
// reference) resolves the same way, with no data step.
describe("source links served by the owning app (knowledgeItems)", () => {
  const APP = "items-app"
  const resolves: Array<{ ref: unknown; userId: string }> = []
  let answer: () => unknown = () => ({
    found: true,
    title: "Live sheet",
    url: "https://x.example/s",
  })

  beforeAll(() => {
    knowledgeItemsRegistry.set([orgId, APP], {
      decl: { resolve: "resolveItem", readScope: "items_app:read", searchByDefault: true },
      dispatch: async (_entry, input, tenant) => {
        resolves.push({ ref: input.ref, userId: tenant.userId })
        return answer()
      },
    })
  })
  afterAll(() => knowledgeItemsRegistry.delete([orgId, APP]))

  const scopes = [LINK_CREATE, DOC_UPDATE, DOC_READ, SOURCES_READ, SOURCES_MANAGE, "items_app:read"]
  const run =
    (a: KnowledgeActor) =>
    <T>(fn: (tx: never) => Promise<T>) =>
      withRlsContext(rlsCtx(a.scopes), (tx) => fn(tx as never))
  const registryFor = (a: KnowledgeActor) =>
    registerDefaultKnowledgeSources({ orgId, userId: alice, scopes: a.scopes })

  /** A link row as an earlier release wrote it (no app involved). */
  async function legacyLink(externalId: string): Promise<string> {
    const [row] = extractRows<{ id: string }>(
      await db.execute(sql`
        WITH ident AS (
          INSERT INTO ${knowledgeRel("source_identities")} (id, org_id, source, external_id)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${APP}, ${externalId})
          RETURNING id
        )
        INSERT INTO ${knowledgeRel("source_links")}
          (id, org_id, source_identity_id, source, external_id, title, owner_user_id)
        SELECT gen_random_uuid(), ${orgId}::uuid, ident.id, ${APP}, ${externalId}, 'Old title', ${alice}::uuid
        FROM ident
        RETURNING id
      `),
    )
    return row!.id
  }
  const statusOf = async (id: string) =>
    extractRows<{ review_status: string; visibility_status: string; title: string }>(
      await db.execute(sql`
        SELECT review_status, visibility_status, title FROM ${knowledgeRel("source_links")}
        WHERE id = ${id}::uuid
      `),
    )[0]!

  it("creates a link the app resolves, for the person asking", async () => {
    const a = actor(scopes)
    resolves.length = 0
    const { id } = await linkRemoteDocument(
      run(a),
      { source: APP, externalId: "proj:main:docs/a.md", title: "A" },
      await registryFor(a),
      a,
    )
    expect(id).toBeTruthy()
    expect(resolves).toEqual([{ ref: "proj:main:docs/a.md", userId: alice }])
  })

  it("an existing link verifies and refreshes through the app", async () => {
    const a = actor(scopes)
    const id = await legacyLink("proj:main:docs/b.md")
    const verified = await verifySourceLink(run(a), id, await registryFor(a), a)
    expect(verified).toMatchObject({ reviewStatus: "verified", visibilityStatus: "available" })
    await refreshSourceLinkMetadata(run(a), id, await registryFor(a), a)
    expect((await statusOf(id)).title).toBe("Live sheet")
  })

  it("an item the app says is gone goes stale", async () => {
    const a = actor(scopes)
    const id = await legacyLink("proj:main:docs/gone.md")
    answer = () => ({ found: false })
    try {
      const r = await verifySourceLink(run(a), id, await registryFor(a), a)
      expect(r).toMatchObject({ reviewStatus: "stale", visibilityStatus: "unavailable" })
    } finally {
      answer = () => ({ found: true, title: "Live sheet", url: "https://x.example/s" })
    }
  })

  it("an app that fails, or a source the person cannot reach, leaves the link as it was", async () => {
    const a = actor(scopes)
    const id = await legacyLink("proj:main:docs/c.md")
    answer = () => {
      throw new Error("provider outage")
    }
    try {
      await expect(verifySourceLink(run(a), id, await registryFor(a), a)).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
      })
    } finally {
      answer = () => ({ found: true, title: "Live sheet", url: "https://x.example/s" })
    }
    const noScope = actor(scopes.filter((s) => s !== "items_app:read"))
    await expect(
      verifySourceLink(run(noScope), id, await registryFor(noScope), noScope),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_ENABLED" })
    expect(await statusOf(id)).toMatchObject({
      review_status: "unverified",
      visibility_status: "available",
    })
  })
})
