// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for sync-reconciler.ts (R-1).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import {
  type KnowledgeActor,
  knowledgeActorFromContext,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import type { KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { reconcileSyncedSource } from "~/apps/knowledge/sync-reconciler"
import {
  createSyncedSource,
  loadSyncedSource,
  type SyncedSourceRow,
} from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
const SOURCES_MANAGE = "knowledge:sources:manage"
const DOC_READ = "knowledge:documents:read"
const DOC_UPDATE = "knowledge:documents:update"

function actor(userId: string, scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
}
function rlsCtx(userId: string, scopes: string[]) {
  return { actorType: "user" as const, orgId, userId, scopes, dimensionGrants: {} }
}

function makeAdapter(opts: {
  tree: Record<string, Array<{ id: string; name: string; mime?: string; folder?: boolean }>>
  fetch: Record<string, string>
  failFetchFor?: string
}): KnowledgeSourceAdapter {
  return {
    source: "google-drive",
    searchRemote: async () => ({
      hits: [],
      status: { source: "google-drive", state: "complete", retryable: false },
    }),
    listFolder: async ({ folderRef }) => {
      const items = opts.tree[folderRef] ?? []
      return {
        items: items.map((i) => ({
          kind: i.folder ? "folder" : "file",
          externalId: i.id,
          name: i.name,
          parentExternalId: folderRef,
          ...(i.folder ? {} : { mimeType: i.mime ?? "text/markdown" }),
        })),
      }
    },
    fetchRemoteContent: async ({ sourceEntityId }) => {
      if (opts.failFetchFor === sourceEntityId) {
        throw new Error("network down")
      }
      const text = opts.fetch[sourceEntityId]
      if (text == null) return { status: "unsupported" }
      return { status: "ok", text }
    },
  }
}

beforeAll(async () => {
  await acquireTestLock()
  // The knowledge app's manifest columns (synced_sources.source_account) come
  // from its registration, not from the migrated template: register the apps
  // here so this file does not depend on an earlier file having done it.
  await createTestOrg()
  const slug = `knowledge-reconciler-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'SyncReconcilerIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id
  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@reconciler.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
})

afterAll(releaseTestLock)

async function newOrgSource(opts: {
  folderRef: string
  displayName: string
  defaultSensitivity?: "internal" | "confidential"
}): Promise<SyncedSourceRow> {
  return withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
    createSyncedSource(
      tx,
      {
        appName: "google-drive",
        folderRef: opts.folderRef,
        displayName: opts.displayName,
        syncIntervalSeconds: 3600,
        scope: "organization",
        defaultSensitivity: opts.defaultSensitivity ?? "internal",
      },
      actor(alice, [SOURCES_MANAGE, DOC_READ]),
      { skipPrecheck: true },
    ),
  )
}

describe("sync reconciler (R-1)", () => {
  // A failing sync must still advance last_sync_at, or the scheduler's due query
  // ("status IN (idle,ok,error) AND last_sync_at + interval < now()") keeps the
  // row due on every tick and retries it ~1/min forever. With a permanent
  // failure (revoked GitLab token, prod 2026-07-31) that hot loop emitted ~12
  // error logs/min and pinned the watchdog's error-rate-spike alert for days.
  it("advances last_sync_at when the sync FAILS, so a broken source cannot hot-loop", async () => {
    const source = await newOrgSource({ folderRef: "root-fail", displayName: "Broken" })
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")}
          SET last_sync_at = now() - interval '2 hours'
          WHERE id = ${source.id}::uuid`,
    )
    const before = extractRows<{ last_sync_at: Date }>(
      await db.execute(
        sql`SELECT last_sync_at FROM ${knowledgeRel("synced_sources")} WHERE id = ${source.id}::uuid`,
      ),
    )[0]!
    const exploding = {
      listFolder: async () => {
        throw new Error("GitLab authentication failed (AUTH_REVOKED)")
      },
      fetchContent: async () => {
        throw new Error("GitLab authentication failed (AUTH_REVOKED)")
      },
    } as unknown as Parameters<typeof reconcileSyncedSource>[1]

    await expect(reconcileSyncedSource(source, exploding)).rejects.toThrow(/AUTH_REVOKED/)

    const after = extractRows<{ last_sync_at: Date; last_sync_status: string; last_error: string }>(
      await db.execute(
        sql`SELECT last_sync_at, last_sync_status, last_error FROM ${knowledgeRel("synced_sources")}
            WHERE id = ${source.id}::uuid`,
      ),
    )[0]!
    expect(after.last_sync_status).toBe("error")
    expect(after.last_error).toContain("AUTH_REVOKED")
    expect(new Date(after.last_sync_at).getTime()).toBeGreaterThan(
      new Date(before.last_sync_at).getTime(),
    )
  })

  it("materializes text files as documents and binaries as source_links", async () => {
    const source = await newOrgSource({ folderRef: "root-a", displayName: "ManualA" })
    const adapter = makeAdapter({
      tree: {
        "root-a": [
          { id: "a", name: "intro.md", mime: "text/markdown" },
          { id: "b", name: "logo.png", mime: "image/png" },
          { id: "sub", name: "chapter-1", folder: true },
        ],
        sub: [{ id: "c", name: "p1.md", mime: "text/markdown" }],
      },
      fetch: { a: "# Intro", c: "# Page 1" },
    })
    const stats = await reconcileSyncedSource(source, adapter)
    expect(stats.documentsUpserted).toBe(2)
    expect(stats.sourceLinksUpserted).toBe(1)
    expect(stats.collectionsUpserted).toBe(1)
    expect(stats.status).toBe("ok")

    const docs = extractRows<{ title: string; body: string; synced_source_id: string }>(
      await db.execute(
        sql`SELECT title, body, synced_source_id FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL
            ORDER BY title`,
      ),
    )
    expect(docs).toEqual([
      expect.objectContaining({ title: "intro.md", body: "# Intro" }),
      expect.objectContaining({ title: "p1.md", body: "# Page 1" }),
    ])
  })

  it("archives documents whose source file disappeared on a second run", async () => {
    const source = await newOrgSource({ folderRef: "root-b", displayName: "ManualB" })
    const first = makeAdapter({
      tree: { "root-b": [{ id: "x", name: "doc.md", mime: "text/markdown" }] },
      fetch: { x: "# X" },
    })
    await reconcileSyncedSource(source, first)
    const second = makeAdapter({ tree: { "root-b": [] }, fetch: {} })
    const stats = await reconcileSyncedSource(source, second)
    expect(stats.documentsArchived).toBe(1)
    const remaining = extractRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(remaining.length).toBe(0)
  })

  it("H-4: archive then resurrect — doc.id is preserved", async () => {
    const source = await newOrgSource({ folderRef: "root-c", displayName: "ManualC" })
    const adapter1 = makeAdapter({
      tree: { "root-c": [{ id: "y", name: "y.md", mime: "text/markdown" }] },
      fetch: { y: "# v1" },
    })
    await reconcileSyncedSource(source, adapter1)
    const first = extractRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM ${knowledgeRel("documents")} WHERE synced_source_id = ${source.id}::uuid LIMIT 1`,
      ),
    )
    const firstId = first[0]!.id

    // Disappear
    await reconcileSyncedSource(source, makeAdapter({ tree: { "root-c": [] }, fetch: {} }))
    // Reappear with new body
    const adapter3 = makeAdapter({
      tree: { "root-c": [{ id: "y", name: "y.md", mime: "text/markdown" }] },
      fetch: { y: "# v2" },
    })
    await reconcileSyncedSource(source, adapter3)
    const after = extractRows<{ id: string; body: string; archived_at: string | null }>(
      await db.execute(
        sql`SELECT id, body, archived_at FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND source_identity_id IS NOT NULL`,
      ),
    )
    expect(after.length).toBe(1)
    expect(after[0]!.id).toBe(firstId)
    expect(after[0]!.body).toBe("# v2")
    expect(after[0]!.archived_at).toBeNull()
  })

  it("personal sources produce documentScope='personal' rows owned by the source owner", async () => {
    const source = await withRlsContext(rlsCtx(alice, [DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "root-personal",
          displayName: "MyDocs",
          syncIntervalSeconds: 3600,
          scope: "personal",
        },
        actor(alice, [DOC_READ]),
        { skipPrecheck: true },
      ),
    )
    const adapter = makeAdapter({
      tree: {
        "root-personal": [
          { id: "p1", name: "p1.md", mime: "text/markdown" },
          { id: "ignore", name: "ignore.png", mime: "image/png" },
        ],
      },
      fetch: { p1: "# personal" },
    })
    const stats = await reconcileSyncedSource(source, adapter)
    expect(stats.documentsUpserted).toBe(1)
    // Personal sources skip non-text files (no source_link materialization)
    // and say which, while the sync stays ok.
    expect(stats.sourceLinksUpserted).toBe(0)
    expect(stats.skipped).toEqual([{ name: "ignore.png", mimeType: "image/png" }])
    const [stamped] = extractRows<{ last_sync_status: string; last_error: string | null }>(
      await db.execute(
        sql`SELECT last_sync_status, last_error FROM ${knowledgeRel("synced_sources")}
            WHERE id = ${source.id}::uuid`,
      ),
    )
    expect(stamped).toEqual({
      last_sync_status: "ok",
      last_error: "Not imported, no text form: ignore.png (image/png)",
    })

    const docs = extractRows<{
      document_scope: string
      owner_user_id: string | null
      sensitivity: string | null
    }>(
      await db.execute(
        sql`SELECT document_scope, owner_user_id, sensitivity FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(docs[0]!.document_scope).toBe("personal")
    expect(docs[0]!.owner_user_id).toBe(alice)
    expect(docs[0]!.sensitivity).toBeNull()
  })

  it("org sources stamp sensitivity from source.defaultSensitivity (C2)", async () => {
    const source = await newOrgSource({ folderRef: "root-sens", displayName: "Sensitive" })
    const adapter = makeAdapter({
      tree: { "root-sens": [{ id: "s1", name: "s1.md", mime: "text/markdown" }] },
      fetch: { s1: "# s" },
    })
    await reconcileSyncedSource(source, adapter)
    const docs = extractRows<{ sensitivity: string | null }>(
      await db.execute(
        sql`SELECT sensitivity FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(docs[0]!.sensitivity).toBe("internal")
  })

  // A new synced row gets its search ACL projection (owner and creator), as
  // every other document write point keeps it.
  it("a synced document's search ACL names its creator", async () => {
    const source = await newOrgSource({
      folderRef: "root-conf",
      displayName: "Finance",
      defaultSensitivity: "confidential",
    })
    const adapter = makeAdapter({
      tree: { "root-conf": [{ id: "c1", name: "pl.md", mime: "text/markdown" }] },
      fetch: { c1: "# P&L" },
    })
    await reconcileSyncedSource(source, adapter)
    const docs = extractRows<{ acl_user_ids: string[] }>(
      await db.execute(
        sql`SELECT acl_user_ids FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(docs[0]!.acl_user_ids).toContain(alice)
  })

  it("org sources default document owner to the source creator (no owner_missing flood)", async () => {
    const source = await newOrgSource({ folderRef: "root-owner", displayName: "Owned" })
    const adapter = makeAdapter({
      tree: { "root-owner": [{ id: "o1", name: "o1.md", mime: "text/markdown" }] },
      fetch: { o1: "# o" },
    })
    await reconcileSyncedSource(source, adapter)
    const docs = extractRows<{ owner_user_id: string | null; document_scope: string }>(
      await db.execute(
        sql`SELECT owner_user_id, document_scope FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(docs[0]!.document_scope).toBe("organization")
    expect(docs[0]!.owner_user_id).toBe(alice)
  })

  it("fetch failure on one file marks status='error' and last_error; other files still commit", async () => {
    const source = await newOrgSource({ folderRef: "root-err", displayName: "Errs" })
    const adapter = makeAdapter({
      tree: {
        "root-err": [
          { id: "ok", name: "ok.md", mime: "text/markdown" },
          { id: "boom", name: "boom.md", mime: "text/markdown" },
        ],
      },
      fetch: { ok: "# ok" },
      failFetchFor: "boom",
    })
    const stats = await reconcileSyncedSource(source, adapter)
    expect(stats.documentsUpserted).toBe(1)
    expect(stats.fetchErrors.length).toBe(1)
    expect(stats.status).toBe("error")

    const reloaded = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      loadSyncedSource(tx, source.id, actor(alice, [SOURCES_MANAGE, DOC_READ])),
    )
    expect(reloaded!.lastSyncStatus).toBe("error")
    expect(reloaded!.lastError).toMatch(/boom/)
  })

  // -----------------------------------------------------------------------
  // Gaps surfaced by the test-coverage review — these exercise branches that
  // previously had no assertion that would fail under a mutation.
  // -----------------------------------------------------------------------

  it("body changed → outbox event queued; body unchanged → NO event (gaps #1, #2)", async () => {
    const source = await newOrgSource({ folderRef: "root-evt", displayName: "EventTest" })
    const adapter1 = makeAdapter({
      tree: { "root-evt": [{ id: "e1", name: "e1.md", mime: "text/markdown" }] },
      fetch: { e1: "# v1" },
    })
    // First run materialises the doc; bodyChanged=true on insert → event queued
    await reconcileSyncedSource(source, adapter1)
    const eventsAfterFirst = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge'
              AND payload->>'entity' = 'document'
              AND payload->>'action' = 'update'
              AND (payload->'data'->>'syncedSourceId')::uuid = ${source.id}::uuid`,
      ),
    )
    expect(eventsAfterFirst[0]!.count).toBe(1)

    // Second run with identical body — no new event must be queued.
    await reconcileSyncedSource(source, adapter1)
    const eventsAfterSecond = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge'
              AND payload->>'entity' = 'document'
              AND payload->>'action' = 'update'
              AND (payload->'data'->>'syncedSourceId')::uuid = ${source.id}::uuid`,
      ),
    )
    expect(eventsAfterSecond[0]!.count).toBe(1)

    // Third run with a different body — exactly one new event.
    const adapter2 = makeAdapter({
      tree: { "root-evt": [{ id: "e1", name: "e1.md", mime: "text/markdown" }] },
      fetch: { e1: "# v2 — changed" },
    })
    await reconcileSyncedSource(source, adapter2)
    const eventsAfterThird = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge'
              AND payload->>'entity' = 'document'
              AND payload->>'action' = 'update'
              AND (payload->'data'->>'syncedSourceId')::uuid = ${source.id}::uuid`,
      ),
    )
    expect(eventsAfterThird[0]!.count).toBe(2)
  })

  it("reconciler honours adapter pagination cursor across multiple pages (gap #3)", async () => {
    const source = await newOrgSource({ folderRef: "root-pg", displayName: "Paginated" })

    let listCalls = 0
    const adapter: KnowledgeSourceAdapter = {
      source: "google-drive",
      searchRemote: async () => ({
        hits: [],
        status: { source: "google-drive", state: "complete", retryable: false },
      }),
      listFolder: async ({ folderRef, cursor }) => {
        if (folderRef !== "root-pg") return { items: [] }
        listCalls += 1
        if (!cursor) {
          return {
            items: [
              {
                kind: "file" as const,
                externalId: "p1",
                name: "p1.md",
                parentExternalId: "root-pg",
                mimeType: "text/markdown",
              },
              {
                kind: "file" as const,
                externalId: "p2",
                name: "p2.md",
                parentExternalId: "root-pg",
                mimeType: "text/markdown",
              },
            ],
            nextCursor: "PAGE2",
          }
        }
        if (cursor === "PAGE2") {
          return {
            items: [
              {
                kind: "file" as const,
                externalId: "p3",
                name: "p3.md",
                parentExternalId: "root-pg",
                mimeType: "text/markdown",
              },
            ],
            nextCursor: "PAGE3",
          }
        }
        if (cursor === "PAGE3") {
          return {
            items: [
              {
                kind: "file" as const,
                externalId: "p4",
                name: "p4.md",
                parentExternalId: "root-pg",
                mimeType: "text/markdown",
              },
            ],
          }
        }
        return { items: [] }
      },
      fetchRemoteContent: async ({ sourceEntityId }) => ({
        status: "ok",
        text: `body-${sourceEntityId}`,
      }),
    }
    const stats = await reconcileSyncedSource(source, adapter)
    expect(listCalls).toBe(3) // 3 pages, cursor honored at each step
    expect(stats.documentsUpserted).toBe(4)
    const titles = extractRows<{ title: string }>(
      await db.execute(
        sql`SELECT title FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL
            ORDER BY title`,
      ),
    ).map((r) => r.title)
    expect(titles).toEqual(["p1.md", "p2.md", "p3.md", "p4.md"])
  })

  it("a synced write is explicitly untagged and a re-sync keeps the document's existing requiredScopes", async () => {
    const source = await newOrgSource({ folderRef: "root-rs", displayName: "ScopeTagTest" })
    const adapter1 = makeAdapter({
      tree: { "root-rs": [{ id: "rs1", name: "rs1.md", mime: "text/markdown" }] },
      fetch: { rs1: "# v1" },
    })
    await reconcileSyncedSource(source, adapter1)
    const [doc] = extractRows<{ id: string; required_scopes: string[] }>(
      await db.execute(
        sql`SELECT id, required_scopes FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid`,
      ),
    )
    // The reconciler runs outside any turn, on content from an external
    // source: it asserts the empty set rather than inheriting anything.
    expect(doc!.required_scopes).toEqual([])

    // A later tag (put there by the read-side classification or an operator)
    // must survive the next sync: an external-source write never narrows it.
    await db.execute(
      sql`UPDATE ${knowledgeRel("documents")}
          SET required_scopes = ARRAY['mail:read']::text[]
          WHERE id = ${doc!.id}::uuid`,
    )
    const adapter2 = makeAdapter({
      tree: { "root-rs": [{ id: "rs1", name: "rs1.md", mime: "text/markdown" }] },
      fetch: { rs1: "# v2 changed upstream" },
    })
    await reconcileSyncedSource(source, adapter2)
    const [after] = extractRows<{ body: string; required_scopes: string[] }>(
      await db.execute(
        sql`SELECT body, required_scopes FROM ${knowledgeRel("documents")}
            WHERE id = ${doc!.id}::uuid`,
      ),
    )
    expect(after!.body).toContain("v2 changed upstream")
    expect(after!.required_scopes).toEqual(["mail:read"])
  })

  it("idempotency: two consecutive runs return the same document id (gap #4)", async () => {
    const source = await newOrgSource({ folderRef: "root-idem", displayName: "Idempotent" })
    const adapter = makeAdapter({
      tree: { "root-idem": [{ id: "i", name: "i.md", mime: "text/markdown" }] },
      fetch: { i: "# body" },
    })
    await reconcileSyncedSource(source, adapter)
    const after1 = extractRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    await reconcileSyncedSource(source, adapter)
    const after2 = extractRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(after1.length).toBe(1)
    expect(after2.length).toBe(1)
    expect(after2[0]!.id).toBe(after1[0]!.id)
  })

  it("file rename: same externalId, new name → title updates, doc.id preserved (gap #5)", async () => {
    const source = await newOrgSource({ folderRef: "root-rn", displayName: "Rename" })
    const adapter1 = makeAdapter({
      tree: { "root-rn": [{ id: "f", name: "old-name.md", mime: "text/markdown" }] },
      fetch: { f: "# body" },
    })
    await reconcileSyncedSource(source, adapter1)
    const before = extractRows<{ id: string; title: string }>(
      await db.execute(
        sql`SELECT id, title FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    const adapter2 = makeAdapter({
      tree: { "root-rn": [{ id: "f", name: "new-name.md", mime: "text/markdown" }] },
      fetch: { f: "# body" }, // body unchanged — rename only
    })
    await reconcileSyncedSource(source, adapter2)
    const after = extractRows<{ id: string; title: string }>(
      await db.execute(
        sql`SELECT id, title FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(after.length).toBe(1)
    expect(after[0]!.id).toBe(before[0]!.id) // identity preserved
    expect(after[0]!.title).toBe("new-name.md") // title updated
  })

  it("file moved between folders: identity stable, collection membership swaps (gap #6)", async () => {
    const source = await newOrgSource({ folderRef: "root-mv", displayName: "Moved" })
    const adapter1 = makeAdapter({
      tree: {
        "root-mv": [
          { id: "subA", name: "A", folder: true },
          { id: "subB", name: "B", folder: true },
        ],
        subA: [{ id: "m", name: "m.md", mime: "text/markdown" }],
        subB: [],
      },
      fetch: { m: "# m" },
    })
    await reconcileSyncedSource(source, adapter1)
    const initialDoc = extractRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    const docId = initialDoc[0]!.id
    const initialMemberships = extractRows<{ collection_id: string }>(
      await db.execute(
        sql`SELECT collection_id FROM ${knowledgeRel("collection_memberships")}
            WHERE target_type = 'document' AND target_id = ${docId}::uuid`,
      ),
    )
    expect(initialMemberships.length).toBe(1)
    const subACollectionId = initialMemberships[0]!.collection_id

    // Move m.md from subA → subB
    const adapter2 = makeAdapter({
      tree: {
        "root-mv": [
          { id: "subA", name: "A", folder: true },
          { id: "subB", name: "B", folder: true },
        ],
        subA: [],
        subB: [{ id: "m", name: "m.md", mime: "text/markdown" }],
      },
      fetch: { m: "# m" },
    })
    await reconcileSyncedSource(source, adapter2)
    const after = extractRows<{ id: string }>(
      await db.execute(
        sql`SELECT id FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(after.length).toBe(1)
    expect(after[0]!.id).toBe(docId) // identity stable across the move
    const memberships = extractRows<{ collection_id: string }>(
      await db.execute(
        sql`SELECT collection_id FROM ${knowledgeRel("collection_memberships")}
            WHERE target_type = 'document' AND target_id = ${docId}::uuid`,
      ),
    )
    expect(memberships.length).toBe(1)
    expect(memberships[0]!.collection_id).not.toBe(subACollectionId)
  })

  it("a type the adapter has text for becomes a document, and its old link is archived", async () => {
    const source = await newOrgSource({ folderRef: "root-sheet", displayName: "Sheets" })
    const SHEET = "application/vnd.google-apps.spreadsheet"
    const tree = { "root-sheet": [{ id: "sheet-x", name: "Prices", mime: SHEET }] }
    // An adapter without text for Sheets (an older release): a link.
    const before = await reconcileSyncedSource(source, makeAdapter({ tree, fetch: {} }))
    expect(before.sourceLinksUpserted).toBe(1)
    // The adapter now exports Sheets as CSV: a document, and no link beside it.
    const withText = {
      ...makeAdapter({ tree, fetch: { "sheet-x": "sku,price\nA,1" } }),
      hasText: (m: string | undefined) => m === SHEET,
    }
    const after = await reconcileSyncedSource(source, withText)
    expect(after.documentsUpserted).toBe(1)
    const links = extractRows<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM ${knowledgeRel("source_links")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(links[0]!.n).toBe(0)
    const docs = extractRows<{ body: string }>(
      await db.execute(
        sql`SELECT body FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(docs.map((d) => d.body)).toEqual(["sku,price\nA,1"])
  })

  it("source_link materialization preserves identity-level details (gap #14)", async () => {
    const source = await newOrgSource({ folderRef: "root-sl", displayName: "Links" })
    const adapter = makeAdapter({
      tree: {
        "root-sl": [
          { id: "doc-text", name: "intro.md", mime: "text/markdown" },
          { id: "pdf", name: "diagram.pdf", mime: "application/pdf" },
        ],
      },
      fetch: { "doc-text": "# Intro" },
    })
    await reconcileSyncedSource(source, adapter)

    // Verify the PDF became a source_link with title + mime preserved AND the
    // text file did NOT (i.e. they didn't get swapped).
    const links = extractRows<{
      title: string
      mime_type: string
      external_id: string
    }>(
      await db.execute(
        sql`SELECT sl.title, sl.mime_type, si.external_id
            FROM ${knowledgeRel("source_links")} sl
            JOIN ${knowledgeRel("source_identities")} si ON si.id = sl.source_identity_id
            WHERE sl.source = ${source.appName} AND sl.archived_at IS NULL
              AND sl.org_id = ${orgId}::uuid
              AND si.external_id IN ('pdf', 'doc-text')`,
      ),
    )
    expect(links.length).toBe(1)
    expect(links[0]!.title).toBe("diagram.pdf")
    expect(links[0]!.mime_type).toBe("application/pdf")
    expect(links[0]!.external_id).toBe("pdf")

    // The text file should NOT have become a source_link.
    const noTextLink = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count
            FROM ${knowledgeRel("source_links")} sl
            JOIN ${knowledgeRel("source_identities")} si ON si.id = sl.source_identity_id
            WHERE si.external_id = 'doc-text' AND sl.archived_at IS NULL`,
      ),
    )
    expect(noTextLink[0]!.count).toBe(0)
  })

  it("I2: source_links + empty subcollections are archived when upstream disappears", async () => {
    const source = await newOrgSource({ folderRef: "root-arch", displayName: "ArchAll" })
    const adapter1 = makeAdapter({
      tree: {
        "root-arch": [
          { id: "subarc", name: "section", folder: true },
          { id: "pdf-here", name: "p.pdf", mime: "application/pdf" },
        ],
        subarc: [{ id: "doc-here", name: "d.md", mime: "text/markdown" }],
      },
      fetch: { "doc-here": "# d" },
    })
    await reconcileSyncedSource(source, adapter1)
    // Now everything disappears.
    const adapter2 = makeAdapter({ tree: { "root-arch": [] }, fetch: {} })
    const stats = await reconcileSyncedSource(source, adapter2)
    expect(stats.documentsArchived).toBeGreaterThanOrEqual(1)
    expect(stats.sourceLinksArchived).toBeGreaterThanOrEqual(1)
    expect(stats.collectionsArchived).toBeGreaterThanOrEqual(1)

    // Each archived row must queue an `archive` event, or the search indexer
    // never drops it and knowledge.search keeps returning a not_found doc.
    const archiveEvents = extractRows<{ entity: string; count: number }>(
      await db.execute(
        sql`SELECT payload->>'entity' AS entity, COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge'
              AND payload->>'action' = 'archive'
              AND (payload->'data'->>'syncedSourceId')::uuid = ${source.id}::uuid
            GROUP BY 1 ORDER BY 1`,
      ),
    )
    expect(archiveEvents).toEqual([
      { entity: "document", count: stats.documentsArchived },
      { entity: "source_link", count: stats.sourceLinksArchived },
    ])

    const activeLinks = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM ${knowledgeRel("source_links")}
            WHERE synced_source_id = ${source.id}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(activeLinks[0]!.count).toBe(0)

    const activeSubcols = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM ${knowledgeRel("collections")}
            WHERE org_id = ${orgId}::uuid
              AND description LIKE ${`synced:${source.id}:%`}
              AND archived_at IS NULL`,
      ),
    )
    expect(activeSubcols[0]!.count).toBe(0)

    // Root collection MUST remain active — the source still owns it.
    const rootActive = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM ${knowledgeRel("collections")}
            WHERE id = ${source.rootCollectionId}::uuid AND archived_at IS NULL`,
      ),
    )
    expect(rootActive[0]!.count).toBe(1)
  })

  it("reconciling one synced source never archives another source's links (cross-source isolation)", async () => {
    // Two org sources (same google-drive app) coexisting in one org, each with
    // one binary → one source_link apiece.
    const sourceA = await newOrgSource({ folderRef: "root-xsrc-a", displayName: "XSrcA" })
    const sourceB = await newOrgSource({ folderRef: "root-xsrc-b", displayName: "XSrcB" })
    await reconcileSyncedSource(
      sourceA,
      makeAdapter({
        tree: { "root-xsrc-a": [{ id: "xa-pdf", name: "a.pdf", mime: "application/pdf" }] },
        fetch: {},
      }),
    )
    await reconcileSyncedSource(
      sourceB,
      makeAdapter({
        tree: { "root-xsrc-b": [{ id: "xb-pdf", name: "b.pdf", mime: "application/pdf" }] },
        fetch: {},
      }),
    )

    // Re-reconcile A with an empty upstream. A's link must be archived; B's must
    // survive — the pre-fix bug archived every same-app link in the org.
    await reconcileSyncedSource(sourceA, makeAdapter({ tree: { "root-xsrc-a": [] }, fetch: {} }))

    const countActive = async (syncedSourceId: string) =>
      extractRows<{ count: number }>(
        await db.execute(
          sql`SELECT COUNT(*)::int AS count FROM ${knowledgeRel("source_links")}
              WHERE synced_source_id = ${syncedSourceId}::uuid AND archived_at IS NULL`,
        ),
      )[0]!.count

    expect(await countActive(sourceA.id)).toBe(0) // A's link archived
    expect(await countActive(sourceB.id)).toBe(1) // B's link survives
  })

  it("H-2 service-layer: updateKnowledgeDocument rejects synced docs as read-only", async () => {
    const source = await newOrgSource({ folderRef: "root-ro", displayName: "ReadOnly" })
    const adapter = makeAdapter({
      tree: { "root-ro": [{ id: "rw", name: "rw.md", mime: "text/markdown" }] },
      fetch: { rw: "# initial" },
    })
    await reconcileSyncedSource(source, adapter)
    const docs = extractRows<{ id: string; revision: number }>(
      await db.execute(
        sql`SELECT id, revision FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${source.id}::uuid AND archived_at IS NULL`,
      ),
    )
    const docId = docs[0]!.id

    const aliceCtx = {
      actorType: "user" as const,
      orgId,
      userId: alice,
      scopes: [DOC_READ, DOC_UPDATE],
      dimensionGrants: { sensitivity: ["public", "internal", "confidential", "restricted"] },
    }
    const aliceActor = knowledgeActorFromContext({
      orgId,
      userId: alice,
      scopes: [DOC_READ, DOC_UPDATE],
      dimensionGrants: { sensitivity: ["public", "internal", "confidential", "restricted"] },
    })
    await expect(
      withRlsContext(aliceCtx, (tx) =>
        updateKnowledgeDocument(tx, { id: docId, revision: 0, body: "tampered" }, aliceActor, []),
      ),
    ).rejects.toThrow(/read-only|synced/i)
  })
})

// A synced document's org-wide access follows its source's sensitivity, as a
// document created in Knowledge does: a file from a confidential or restricted
// source is readable by its owner, its creator and whoever it is shared with,
// not by every member because it arrived through a sync.
describe("sync reconciler: org-wide access follows the source's sensitivity", () => {
  let bob: string

  beforeAll(async () => {
    const [b] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@reconciler.test`}, 'Bob', 'active', 'h', 1, 1)
            RETURNING id`,
      ),
    )
    bob = b!.id
  })

  type Row = {
    id: string
    org_access: string
    org_wide: boolean
    sensitivity: string | null
    acl_user_ids: string[]
  }
  async function syncedDocs(sourceId: string): Promise<Row[]> {
    return extractRows<Row>(
      await db.execute(
        sql`SELECT id, org_access, org_wide, sensitivity, acl_user_ids
            FROM ${knowledgeRel("documents")}
            WHERE synced_source_id = ${sourceId}::uuid AND archived_at IS NULL
            ORDER BY external_path`,
      ),
    )
  }
  async function visibleTo(userId: string, docId: string): Promise<boolean> {
    const rows = await withRlsContext(rlsCtx(userId, [DOC_READ]), async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${knowledgeRel("documents")} WHERE id = ${docId}::uuid`,
        ),
      ),
    )
    return rows.length === 1
  }
  function oneFile(folderRef: string, body: string): KnowledgeSourceAdapter {
    return makeAdapter({
      tree: { [folderRef]: [{ id: `${folderRef}-f1`, name: "plan.md", mime: "text/markdown" }] },
      fetch: { [`${folderRef}-f1`]: body },
    })
  }

  it("a confidential source's new document is not org-wide; owner and creator still read it", async () => {
    const source = await newOrgSource({
      folderRef: "root-acc-conf",
      displayName: "Board",
      defaultSensitivity: "confidential",
    })
    await reconcileSyncedSource(source, oneFile("root-acc-conf", "# plan v1"))
    const [doc] = await syncedDocs(source.id)
    expect(doc?.org_access).toBe("none")
    expect(doc?.org_wide).toBe(false)
    expect(doc?.sensitivity).toBe("confidential")
    expect(doc?.acl_user_ids).toContain(alice)
    expect(await visibleTo(alice, doc!.id)).toBe(true)
    expect(await visibleTo(bob, doc!.id)).toBe(false)
  })

  it("a re-sync of a confidential source keeps the document at 'none'", async () => {
    const source = await newOrgSource({
      folderRef: "root-acc-resync",
      displayName: "Board 2",
      defaultSensitivity: "confidential",
    })
    await reconcileSyncedSource(source, oneFile("root-acc-resync", "# v1"))
    await reconcileSyncedSource(source, oneFile("root-acc-resync", "# v1"))
    await reconcileSyncedSource(source, oneFile("root-acc-resync", "# v2 changed"))
    const docs = await syncedDocs(source.id)
    expect(docs).toHaveLength(1)
    expect(docs[0]?.org_access).toBe("none")
    expect(await visibleTo(bob, docs[0]!.id)).toBe(false)
  })

  it("an internal source's document stays org-wide 'editor'", async () => {
    const source = await newOrgSource({ folderRef: "root-acc-int", displayName: "Handbook" })
    await reconcileSyncedSource(source, oneFile("root-acc-int", "# handbook"))
    await reconcileSyncedSource(source, oneFile("root-acc-int", "# handbook v2"))
    const [doc] = await syncedDocs(source.id)
    expect(doc?.org_access).toBe("editor")
    expect(doc?.org_wide).toBe(true)
    expect(await visibleTo(bob, doc!.id)).toBe(true)
  })

  it("a re-sync keeps sharing someone set on the document while the sensitivity is unchanged", async () => {
    const source = await newOrgSource({
      folderRef: "root-acc-shared",
      displayName: "Board 3",
      defaultSensitivity: "confidential",
    })
    await reconcileSyncedSource(source, oneFile("root-acc-shared", "# v1"))
    const [doc] = await syncedDocs(source.id)
    // The owner opens it to the org deliberately (setDocumentSharing writes this column).
    await db.execute(
      sql`UPDATE ${knowledgeRel("documents")} SET org_access = 'viewer' WHERE id = ${doc!.id}::uuid`,
    )
    await reconcileSyncedSource(source, oneFile("root-acc-shared", "# v2"))
    const [after] = await syncedDocs(source.id)
    expect(after?.org_access).toBe("viewer")
  })

  it("a source reclassified confidential closes its documents' org-wide access and reindexes them", async () => {
    const source = await newOrgSource({ folderRef: "root-acc-reclass", displayName: "Pricing" })
    await reconcileSyncedSource(source, oneFile("root-acc-reclass", "# prices"))
    const [before] = await syncedDocs(source.id)
    expect(before?.org_access).toBe("editor")
    await db.execute(
      sql`UPDATE ${knowledgeRel("synced_sources")} SET default_sensitivity = 'confidential'
          WHERE id = ${source.id}::uuid`,
    )
    // Same body: only the access changed, and the search index must still hear of it.
    const reclassified = { ...source, defaultSensitivity: "confidential" }
    await reconcileSyncedSource(reclassified, oneFile("root-acc-reclass", "# prices"))
    const [after] = await syncedDocs(source.id)
    expect(after?.sensitivity).toBe("confidential")
    expect(after?.org_access).toBe("none")
    expect(await visibleTo(bob, after!.id)).toBe(false)
    const events = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM kernel.pending_events
            WHERE payload->>'app' = 'knowledge' AND payload->>'entity' = 'document'
              AND payload->>'action' = 'update' AND payload->>'entityId' = ${after!.id}`,
      ),
    )
    expect(events[0]!.count).toBe(2)
  })
})
