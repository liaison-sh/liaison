// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Disconnecting Google Drive deletes the Drive folders synced into Knowledge on
// the user's connection: the materialised documents, the source links, the
// collections the sync created and the source itself. A document a user wrote
// stays, and a user who still holds an active Drive connection keeps everything.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { purgeDriveContent } from "~/apps/google-drive/disconnect"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import type { KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { reconcileSyncedSource } from "~/apps/knowledge/sync-reconciler"
import { createSyncedSource, type SyncedSourceRow } from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let alice: string
const SCOPES = ["knowledge:sources:manage", "knowledge:documents:read"]

function adapter(root: string): KnowledgeSourceAdapter {
  const tree: Record<
    string,
    Array<{ id: string; name: string; mime?: string; folder?: boolean }>
  > = {
    [root]: [
      { id: `${root}-a`, name: "handbook.md", mime: "text/markdown" },
      { id: `${root}-b`, name: "logo.png", mime: "image/png" },
      { id: `${root}-sub`, name: "chapter", folder: true },
    ],
    [`${root}-sub`]: [{ id: `${root}-c`, name: "page.md", mime: "text/markdown" }],
  }
  const text: Record<string, string> = { [`${root}-a`]: "# Handbook", [`${root}-c`]: "# Page" }
  return {
    source: "google-drive",
    searchRemote: async () => ({
      hits: [],
      status: { source: "google-drive", state: "complete", retryable: false },
    }),
    listFolder: async ({ folderRef }) => ({
      items: (tree[folderRef] ?? []).map((i) => ({
        kind: i.folder ? "folder" : "file",
        externalId: i.id,
        name: i.name,
        parentExternalId: folderRef,
        ...(i.folder ? {} : { mimeType: i.mime ?? "text/markdown" }),
      })),
    }),
    fetchRemoteContent: async ({ sourceEntityId }) =>
      text[sourceEntityId] == null
        ? { status: "unsupported" }
        : { status: "ok", text: text[sourceEntityId] },
  }
}

async function syncedFolder(
  root: string,
  scope: "organization" | "personal" = "organization",
): Promise<SyncedSourceRow> {
  const source = await withRlsContext(
    { actorType: "user" as const, orgId, userId: alice, scopes: SCOPES, dimensionGrants: {} },
    (tx) =>
      createSyncedSource(
        tx,
        {
          appName: "google-drive",
          folderRef: root,
          displayName: `Drive ${root}`,
          syncIntervalSeconds: 3600,
          scope,
          defaultSensitivity: scope === "organization" ? "internal" : null,
        },
        knowledgeActorFromContext({ orgId, userId: alice, scopes: SCOPES, dimensionGrants: {} }),
        { skipPrecheck: true },
      ),
  )
  await reconcileSyncedSource(source, adapter(root))
  return source
}

async function count(table: string, where: ReturnType<typeof sql>): Promise<number> {
  return (
    extractRows<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM ${knowledgeRel(table)} WHERE org_id = ${orgId}::uuid AND ${where}`,
      ),
    )[0]?.n ?? 0
  )
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'DriveDisconnect', ${`drive-disconnect-${Date.now()}`})
      RETURNING id`),
  )
  orgId = org!.id
  const [a] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@drive.test`}, 'Alice',
              'active', 'h', 1, 1)
      RETURNING id`),
  )
  alice = a!.id
})

afterAll(releaseTestLock)

async function driveConnection(identifier: string): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         status, created_by, updated_at)
      VALUES (${orgId}::uuid, 'google-drive', 'drive', 'user', ${alice}::uuid, 'oauth2',
              ${identifier}, 'active', ${alice}::uuid, now())
      RETURNING id`),
  )
  return row!.id
}

async function orgDriveConnection(identifier: string): Promise<string> {
  const [row] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         status, created_by, updated_at)
      VALUES (${orgId}::uuid, 'google-drive', 'drive', 'org', NULL, 'oauth2',
              ${identifier}, 'active', ${alice}::uuid, now())
      RETURNING id`),
  )
  return row!.id
}

async function markDisconnected(id: string): Promise<void> {
  await db.execute(sql`UPDATE kernel.connected_accounts SET status = 'disconnected'
    WHERE id = ${id}::uuid`)
}

function purge(connectionId: string) {
  return withPrivilegedDb(orgId, "drive-purge-test", (tx) =>
    purgeDriveContent(tx, orgId, connectionId),
  )
}

describe("Drive disconnect purge", () => {
  it("deletes only the disconnected account's folders when a user has two Drive accounts", async () => {
    const work = await driveConnection("work@drive.test")
    const workFolder = await syncedFolder("work-root")
    const home = await driveConnection("home@drive.test")
    const homeFolder = await syncedFolder("home-root")
    // Each folder records the account it syncs from (the newest active one at creation).
    expect(workFolder.sourceAccount).toBe("work@drive.test")
    expect(homeFolder.sourceAccount).toBe("home@drive.test")

    // Still active: refused, nothing deleted (the sandbox cannot trigger a purge early).
    expect((await purge(work)).kept).toBe(true)
    expect(await count("documents", sql`synced_source_id = ${workFolder.id}::uuid`)).toBe(2)

    await markDisconnected(work)
    const result = await purge(work)

    expect(result.kept).toBe(false)
    expect(await count("documents", sql`synced_source_id = ${workFolder.id}::uuid`)).toBe(0)
    expect(await count("source_links", sql`synced_source_id = ${workFolder.id}::uuid`)).toBe(0)
    expect(await count("synced_sources", sql`id = ${workFolder.id}::uuid`)).toBe(0)
    expect(await count("collections", sql`description LIKE ${`synced:${workFolder.id}:%`}`)).toBe(0)
    // The other account's folder stays, and so does the cache (a Drive connection remains).
    expect(await count("documents", sql`synced_source_id = ${homeFolder.id}::uuid`)).toBe(2)
    expect(await count("synced_sources", sql`id = ${homeFolder.id}::uuid`)).toBe(1)
    expect(result.cacheEntries).toBe(0)
    await markDisconnected(home)
    await purge(home)
  })

  it("keeps everything while the same account is connected again (re-authorization)", async () => {
    const old = await driveConnection("reauth@drive.test")
    const folder = await syncedFolder("reauth-root")
    await markDisconnected(old)
    const fresh = await driveConnection("reauth@drive.test")

    expect((await purge(old)).kept).toBe(true)
    expect(await count("documents", sql`synced_source_id = ${folder.id}::uuid`)).toBe(2)
    await markDisconnected(fresh)
    await purge(fresh)
  })

  it("one account as the org's Drive and a person's own: each disconnect takes only its own folders", async () => {
    const orgRow = await orgDriveConnection("both@drive.test")
    const personalRow = await driveConnection("both@drive.test")
    const orgFolder = await syncedFolder("both-org-root")
    const personalFolder = await syncedFolder("both-own-root", "personal")
    expect(orgFolder.sourceAccount).toBe("both@drive.test")
    expect(personalFolder.sourceAccount).toBe("both@drive.test")
    expect(personalFolder.ownerUserId).toBe(alice)

    await markDisconnected(personalRow)
    const first = await purge(personalRow)
    expect(first.kept).toBe(false)
    expect(await count("synced_sources", sql`id = ${personalFolder.id}::uuid`)).toBe(0)
    expect(await count("documents", sql`synced_source_id = ${personalFolder.id}::uuid`)).toBe(0)
    // The org's folder reads through the org's row, still connected.
    expect(await count("synced_sources", sql`id = ${orgFolder.id}::uuid`)).toBe(1)
    expect(await count("documents", sql`synced_source_id = ${orgFolder.id}::uuid`)).toBe(2)

    await markDisconnected(orgRow)
    await purge(orgRow)
    expect(await count("synced_sources", sql`id = ${orgFolder.id}::uuid`)).toBe(0)
  })

  it("a folder added before accounts were recorded goes with its owner's last Drive connection, not a user's own document", async () => {
    const last = await driveConnection("legacy@drive.test")
    const folder = await syncedFolder("legacy-root")
    await db.execute(sql`UPDATE ${knowledgeRel("synced_sources")} SET source_account = NULL
      WHERE id = ${folder.id}::uuid`)
    await db.execute(sql`INSERT INTO ${knowledgeRel("documents")}
        (org_id, title, body, document_scope, created_by, updated_by, required_scopes, sensitivity)
      VALUES (${orgId}::uuid, 'Written here', 'Mine', 'organization', ${alice}::uuid, ${alice}::uuid,
              '{}'::text[], 'internal')`)

    await markDisconnected(last)
    const result = await purge(last)

    expect(result.kept).toBe(false)
    expect(await count("documents", sql`synced_source_id IS NOT NULL`)).toBe(0)
    expect(await count("source_links", sql`synced_source_id IS NOT NULL`)).toBe(0)
    expect(await count("synced_sources", sql`app_name = 'google-drive'`)).toBe(0)
    if (folder.rootCollectionId) {
      expect(await count("collections", sql`id = ${folder.rootCollectionId}::uuid`)).toBe(0)
    }
    expect(await count("documents", sql`title = 'Written here'`)).toBe(1)
  })
})
