// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration tests for synced-sources.ts (S-1).
 *
 * Same test fixture pattern as collections.integration.test.ts:
 * - acquireTestLock / releaseTestLock around the suite
 * - direct INSERTs (via privileged db) to seed org + users
 * - service calls go through withRlsContext-bound transactions
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import type {
  KnowledgeFolderListResult,
  KnowledgeSourceAdapter,
} from "~/apps/knowledge/source-protocol"
import {
  archiveSyncedSource,
  createSyncedSource,
  listSyncedSources,
  updateSyncedSource,
} from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
let bob: string

const SOURCES_MANAGE = "knowledge:sources:manage"
const DOC_READ = "knowledge:documents:read"

function actor(userId: string, scopes: string[]): KnowledgeActor {
  return knowledgeActorFromContext({ orgId, userId, scopes, dimensionGrants: {} })
}

function rlsCtx(userId: string, scopes: string[]) {
  return { actorType: "user" as const, orgId, userId, scopes, dimensionGrants: {} }
}

function stubAdapter(result: KnowledgeFolderListResult = { items: [] }): KnowledgeSourceAdapter {
  return {
    source: "google-drive",
    searchRemote: async () => ({
      hits: [],
      status: { source: "google-drive", state: "complete", retryable: false },
    }),
    listFolder: async () => result,
  }
}

function failingAdapter(): KnowledgeSourceAdapter {
  return {
    source: "google-drive",
    searchRemote: async () => ({
      hits: [],
      status: { source: "google-drive", state: "complete", retryable: false },
    }),
    listFolder: async () => {
      throw Object.assign(new Error("forbidden"), { status: 403 })
    },
  }
}

beforeAll(async () => {
  await acquireTestLock()
  // The knowledge app's manifest columns (synced_sources.source_account) come
  // from its registration, not from the migrated template: register the apps
  // here so this file does not depend on an earlier file having done it.
  await createTestOrg()
  const slug = `knowledge-synced-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'SyncedSourcesIntegration', ${slug})
          RETURNING id`,
    ),
  )
  orgId = org!.id
  const [a] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@synced.test`}, 'Alice', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  alice = a!.id
  const [b] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@synced.test`}, 'Bob', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  bob = b!.id
})

afterAll(releaseTestLock)

describe("synced_sources CRUD (S-1)", () => {
  it("creates an org-shared source + root collection with default_sensitivity", async () => {
    const s = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "drive-folder-1",
          displayName: "Tessera Manual",
          syncIntervalSeconds: 3600,
          scope: "organization",
          defaultSensitivity: "internal",
        },
        actor(alice, [SOURCES_MANAGE, DOC_READ]),
        { adapter: stubAdapter() },
      ),
    )
    expect(s.rootCollectionId).toBeTruthy()
    expect(s.ownerUserId).toBeNull()
    expect(s.defaultSensitivity).toBe("internal")
    expect(s.lastSyncStatus).toBe("idle")

    const list = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      listSyncedSources(tx, actor(alice, [SOURCES_MANAGE, DOC_READ])),
    )
    expect(list.map((r) => r.id)).toContain(s.id)
  })

  it("creates a personal source — owner is the actor, sensitivity is null", async () => {
    const s = await withRlsContext(rlsCtx(alice, [DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "mine",
          displayName: "My notes",
          syncIntervalSeconds: 3600,
          scope: "personal",
        },
        actor(alice, [DOC_READ]),
        { adapter: stubAdapter() },
      ),
    )
    expect(s.ownerUserId).toBe(alice)
    expect(s.defaultSensitivity).toBeNull()
  })

  it("rejects sync_interval_seconds < 60 at the service layer", async () => {
    await expect(
      withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: "x",
            displayName: "x",
            syncIntervalSeconds: 30,
            scope: "organization",
            defaultSensitivity: "internal",
          },
          actor(alice, [SOURCES_MANAGE, DOC_READ]),
          { adapter: stubAdapter() },
        ),
      ),
    ).rejects.toThrow(/interval/i)
  })

  it("rejects an org-scope create without knowledge:sources:manage", async () => {
    // Tighter regex than the original (which matched "missing" — too permissive).
    await expect(
      withRlsContext(rlsCtx(alice, [DOC_READ]), (tx) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: "x",
            displayName: "x",
            syncIntervalSeconds: 3600,
            scope: "organization",
            defaultSensitivity: "internal",
          },
          actor(alice, [DOC_READ]),
          { adapter: stubAdapter() },
        ),
      ),
    ).rejects.toThrow(/knowledge:sources:manage/)
  })

  it("C2: rejects a personal-scope create when caller lacks knowledge:documents:read", async () => {
    // The privileged-DB write would otherwise bypass the RLS WITH CHECK that
    // requires this scope. Without the app-layer guard this used to silently
    // succeed for an actor with zero `knowledge:*` scopes.
    await expect(
      withRlsContext(rlsCtx(alice, []), (tx) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: "noscope",
            displayName: "NoScope",
            syncIntervalSeconds: 3600,
            scope: "personal",
          },
          actor(alice, []),
          { adapter: stubAdapter() },
        ),
      ),
    ).rejects.toThrow(/knowledge:documents:read/)
  })

  it("rejects an org-scope create missing defaultSensitivity", async () => {
    await expect(
      withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: "x",
            displayName: "x",
            syncIntervalSeconds: 3600,
            scope: "organization",
          },
          actor(alice, [SOURCES_MANAGE, DOC_READ]),
          { adapter: stubAdapter() },
        ),
      ),
    ).rejects.toThrow(/sensitivity/i)
  })

  it("rejects personal source carrying defaultSensitivity", async () => {
    await expect(
      withRlsContext(rlsCtx(alice, [DOC_READ]), (tx) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: "x",
            displayName: "x",
            syncIntervalSeconds: 3600,
            scope: "personal",
            defaultSensitivity: "internal",
          },
          actor(alice, [DOC_READ]),
          { adapter: stubAdapter() },
        ),
      ),
    ).rejects.toThrow(/sensitivity/i)
  })

  it("H5: refuses when the adapter listFolder precheck fails AND leaves no orphan row", async () => {
    // Gap #11: the prior assertion only checked the throw; the spec invariant
    // is that NO synced_sources row or root collection is persisted when the
    // precheck fails. A naive implementation that inserts then prechecks
    // would leak rows.
    const beforeRows = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM app_knowledge.synced_sources
            WHERE org_id = ${orgId}::uuid AND display_name = 'Blocked-orphan-test'`,
      ),
    )
    await expect(
      withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
        createSyncedSource(
          tx,
          {
            appName: "google-drive",
            folderRef: "no-read",
            displayName: "Blocked-orphan-test",
            syncIntervalSeconds: 3600,
            scope: "organization",
            defaultSensitivity: "internal",
          },
          actor(alice, [SOURCES_MANAGE, DOC_READ]),
          { adapter: failingAdapter() },
        ),
      ),
    ).rejects.toThrow(/cannot read folder|forbidden/i)
    const afterRows = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM app_knowledge.synced_sources
            WHERE org_id = ${orgId}::uuid AND display_name = 'Blocked-orphan-test'`,
      ),
    )
    expect(afterRows[0]!.count).toBe(beforeRows[0]!.count)
    // No orphan collection either.
    const cols = extractRows<{ count: number }>(
      await db.execute(
        sql`SELECT COUNT(*)::int AS count FROM app_knowledge.collections
            WHERE org_id = ${orgId}::uuid AND name = 'Blocked-orphan-test'`,
      ),
    )
    expect(cols[0]!.count).toBe(0)
  })

  it("gap #12: non-owner cannot update or archive another user's personal source", async () => {
    // Alice owns the personal source.
    const personal = await withRlsContext(rlsCtx(alice, [DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "alice-personal-12",
          displayName: "AlicePersonal12",
          syncIntervalSeconds: 3600,
          scope: "personal",
        },
        actor(alice, [DOC_READ]),
        { adapter: stubAdapter() },
      ),
    )
    // Bob (different user, same org, has DOC_READ + SOURCES_MANAGE — so RLS
    // would *see* the row if it were org-shared) tries to mutate.
    await expect(
      withRlsContext(rlsCtx(bob, [DOC_READ, SOURCES_MANAGE]), (tx) =>
        updateSyncedSource(
          tx,
          personal.id,
          { displayName: "HACKED" },
          actor(bob, [DOC_READ, SOURCES_MANAGE]),
        ),
      ),
    ).rejects.toThrow(/owner|not found/i)
    await expect(
      withRlsContext(rlsCtx(bob, [DOC_READ, SOURCES_MANAGE]), (tx) =>
        archiveSyncedSource(tx, personal.id, actor(bob, [DOC_READ, SOURCES_MANAGE])),
      ),
    ).rejects.toThrow(/owner|not found/i)
    // Confirm the row is unchanged.
    const after = extractRows<{ display_name: string; archived_at: string | null }>(
      await db.execute(
        sql`SELECT display_name, archived_at FROM app_knowledge.synced_sources
            WHERE id = ${personal.id}::uuid`,
      ),
    )
    expect(after[0]!.display_name).toBe("AlicePersonal12")
    expect(after[0]!.archived_at).toBeNull()
  })

  it("update changes displayName + syncIntervalSeconds; list reflects it", async () => {
    const s = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "u1",
          displayName: "Before",
          syncIntervalSeconds: 3600,
          scope: "organization",
          defaultSensitivity: "internal",
        },
        actor(alice, [SOURCES_MANAGE, DOC_READ]),
        { adapter: stubAdapter() },
      ),
    )
    const updated = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      updateSyncedSource(
        tx,
        s.id,
        { displayName: "After", syncIntervalSeconds: 1800 },
        actor(alice, [SOURCES_MANAGE, DOC_READ]),
      ),
    )
    expect(updated.displayName).toBe("After")
    expect(updated.syncIntervalSeconds).toBe(1800)
  })

  it("archive marks the source as archived (drops from list)", async () => {
    const s = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "del",
          displayName: "ToDelete",
          syncIntervalSeconds: 3600,
          scope: "organization",
          defaultSensitivity: "internal",
        },
        actor(alice, [SOURCES_MANAGE, DOC_READ]),
        { adapter: stubAdapter() },
      ),
    )
    await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      archiveSyncedSource(tx, s.id, actor(alice, [SOURCES_MANAGE, DOC_READ])),
    )
    const list = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      listSyncedSources(tx, actor(alice, [SOURCES_MANAGE, DOC_READ])),
    )
    expect(list.map((r) => r.id)).not.toContain(s.id)
  })

  it("personal source not visible to other users; org source is", async () => {
    const personal = await withRlsContext(rlsCtx(alice, [DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "alice-private",
          displayName: "AlicePrivate",
          syncIntervalSeconds: 3600,
          scope: "personal",
        },
        actor(alice, [DOC_READ]),
        { adapter: stubAdapter() },
      ),
    )
    const orgShared = await withRlsContext(rlsCtx(alice, [SOURCES_MANAGE, DOC_READ]), (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: "shared",
          displayName: "Shared",
          syncIntervalSeconds: 3600,
          scope: "organization",
          defaultSensitivity: "internal",
        },
        actor(alice, [SOURCES_MANAGE, DOC_READ]),
        { adapter: stubAdapter() },
      ),
    )

    const bobList = await withRlsContext(rlsCtx(bob, [DOC_READ]), (tx) =>
      listSyncedSources(tx, actor(bob, [DOC_READ])),
    )
    const ids = bobList.map((r) => r.id)
    expect(ids).not.toContain(personal.id)
    expect(ids).toContain(orgShared.id)
  })
})
