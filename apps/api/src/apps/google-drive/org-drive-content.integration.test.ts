// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Knowledge an ORGANIZATION Drive connection synced before it read only the
// shared drives an admin chose does not stay readable: hidden while no drive is
// chosen (at the org's setup and at every sync), read again when the choice
// changes, and deleted at the next sync for a folder in none of the chosen
// drives. A folder synced through a person's own Drive connection is never
// touched. Also: an org connection answers an unknown file id like one outside
// its drives, and uploads nothing.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { DriveScopeError, makeDriveFetchers } from "~/apps/google-drive/drive-rest"
import {
  gateDriveSourceSync,
  hideUnscopedOrgDriveContent,
  ORG_DRIVE_NOT_CHOSEN_REASON,
  ORG_DRIVE_OUTSIDE_REASON,
  ORG_DRIVE_RECHECK_REASON,
} from "~/apps/google-drive/org-drive-content"
import { chooseSharedDrives } from "~/apps/google-drive/shared-drives"
import { loadSyncedSourceForOrgSystem } from "~/apps/knowledge/knowledge-jobs"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import type { KnowledgeSourceAdapter } from "~/apps/knowledge/source-protocol"
import { reconcileSyncedSource } from "~/apps/knowledge/sync-reconciler"
import { createSyncedSource, type SyncedSourceRow } from "~/apps/knowledge/synced-sources"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SOURCE_SCOPES = [
  "knowledge:sources:manage",
  "knowledge:documents:read",
  "google-drive:accounts:read",
]
const ADMIN_SCOPES = ["google-drive:accounts:admin", ...SOURCE_SCOPES]

let orgId: string
let alice: string
let bob: string

/** Folders by id: one in the connecting account's My Drive, one in the shared drive "Team". */
const FOLDERS: Record<string, { driveId?: string }> = {
  mydrivefold1: {},
  teamfolder01: { driveId: "DRIVE_TEAM" },
  bobsfolder01: {},
}

function fakeDrive(): void {
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^.*\/drive\/v3/, "")
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } })
    if (path === "/drives") return json({ drives: [{ id: "DRIVE_TEAM", name: "Team" }] })
    const id = /^\/files\/([^/?]+)/.exec(path)?.[1] ?? ""
    const f = FOLDERS[id]
    if (!f)
      return new Response(JSON.stringify({ error: { message: "File not found" } }), { status: 404 })
    return json({
      id,
      name: id,
      mimeType: "application/vnd.google-apps.folder",
      driveId: f.driveId,
    })
  }) as never)
}

/** A stand-in Drive listing: each folder holds one text document and one image (a link). */
function adapter(root: string): KnowledgeSourceAdapter {
  return {
    source: "google-drive",
    searchRemote: async () => ({
      hits: [],
      status: { source: "google-drive", state: "complete", retryable: false },
    }),
    listFolder: async ({ folderRef }) => ({
      items:
        folderRef === root
          ? [
              {
                kind: "file" as const,
                externalId: `${root}-doc`,
                name: "notes.md",
                parentExternalId: root,
                mimeType: "text/markdown",
              },
              {
                kind: "file" as const,
                externalId: `${root}-img`,
                name: "logo.png",
                parentExternalId: root,
                mimeType: "image/png",
              },
            ]
          : [],
    }),
    fetchRemoteContent: async ({ sourceEntityId }) =>
      sourceEntityId.endsWith("-doc")
        ? { status: "ok", text: `# ${root}` }
        : { status: "unsupported" },
  }
}

async function user(name: string): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-${Date.now()}@org-drive.test`},
              ${name}, 'active', 'h', 1, 1)
      RETURNING id`),
  )
  return u!.id
}

async function driveAccount(
  owner: { type: "org" } | { type: "user"; id: string },
  identifier: string,
): Promise<string> {
  const ownerId = owner.type === "user" ? owner.id : null
  const [row] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         access_token_encrypted, status, created_by, updated_at, metadata)
      VALUES (${orgId}::uuid, 'google-drive', 'drive', ${owner.type}, ${ownerId}::uuid, 'oauth2',
              ${identifier},
              ${encryptSecret(`token-${identifier}`, env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
              'active', ${alice}::uuid, now(),
              ${JSON.stringify({ grantedOAuthScopes: ["https://www.googleapis.com/auth/drive.readonly"] })}::jsonb)
      RETURNING id`),
  )
  return row!.id
}

async function syncedFolder(
  userId: string,
  root: string,
  scope: "organization" | "personal",
): Promise<SyncedSourceRow> {
  const source = await withRlsContext(
    { actorType: "user" as const, orgId, userId, scopes: SOURCE_SCOPES, dimensionGrants: {} },
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
        knowledgeActorFromContext({ orgId, userId, scopes: SOURCE_SCOPES, dimensionGrants: {} }),
        { skipPrecheck: true },
      ),
  )
  await reconcileSyncedSource(source, adapter(root))
  return source
}

/** Live (unarchived) documents and links of a source, and all of them. */
async function content(sourceId: string): Promise<{ live: number; total: number }> {
  const [r] = extractRows<{ live: number; total: number }>(
    await db.execute(sql`
      SELECT
        (SELECT count(*) FROM ${knowledgeRel("documents")} WHERE synced_source_id = ${sourceId}::uuid AND archived_at IS NULL)
        + (SELECT count(*) FROM ${knowledgeRel("source_links")} WHERE synced_source_id = ${sourceId}::uuid AND archived_at IS NULL) AS live,
        (SELECT count(*) FROM ${knowledgeRel("documents")} WHERE synced_source_id = ${sourceId}::uuid)
        + (SELECT count(*) FROM ${knowledgeRel("source_links")} WHERE synced_source_id = ${sourceId}::uuid) AS total`),
  )
  return { live: Number(r?.live), total: Number(r?.total) }
}

async function reload(id: string): Promise<SyncedSourceRow> {
  const s = await loadSyncedSourceForOrgSystem(orgId, id)
  if (!s) throw new Error(`source ${id} vanished`)
  return s
}

let orgMyDrive: SyncedSourceRow
let orgTeam: SyncedSourceRow
let bobOwn: SyncedSourceRow

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'OrgDriveContent', ${`org-drive-content-${Date.now()}`})
      RETURNING id`),
  )
  orgId = org!.id
  alice = await user("alice")
  bob = await user("bob")
  // An org connection made before shared drives: nothing chosen. Alice has no
  // Drive of her own, so her folders sync through it; Bob's through his own.
  await driveAccount({ type: "org" }, "ops@acme.example")
  await driveAccount({ type: "user", id: bob }, "bob@acme.example")
  // Synced while the org connection still read everything (before the rule).
  orgMyDrive = await syncedFolder(alice, "mydrivefold1", "organization")
  orgTeam = await syncedFolder(alice, "teamfolder01", "organization")
  bobOwn = await syncedFolder(bob, "bobsfolder01", "personal")
  expect(orgMyDrive.sourceAccount).toBe("ops@acme.example")
  expect(bobOwn.sourceAccount).toBe("bob@acme.example")
})

afterEach(() => OutboundFetchTestAccess.setFetch(null))

afterAll(async () => {
  await db.execute(sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}::uuid`)
  await releaseTestLock()
})

describe("Knowledge an organization Drive connection synced", () => {
  it("is hidden at the org's setup while no shared drive is chosen; a personal folder stays", async () => {
    expect((await content(orgMyDrive.id)).live).toBe(2)
    await hideUnscopedOrgDriveContent(orgId)
    expect(await content(orgMyDrive.id)).toEqual({ live: 0, total: 2 })
    expect(await content(orgTeam.id)).toEqual({ live: 0, total: 2 })
    expect(await content(bobOwn.id)).toEqual({ live: 1, total: 1 })
    const s = await reload(orgMyDrive.id)
    expect(s.lastSyncStatus).toBe("error")
    expect(s.lastError).toBe(ORG_DRIVE_NOT_CHOSEN_REASON)
    // The search index drops them on the archive events.
    const [events] = extractRows<{ n: number }>(
      await db.execute(sql`SELECT count(*)::int AS n FROM kernel.pending_events
        WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'knowledge'
          AND payload->>'action' = 'archive'
          AND payload->'data'->>'syncedSourceId' = ${orgMyDrive.id}`),
    )
    expect(events?.n).toBe(2)
  })

  it("stays hidden at its sync while no drive is chosen; a personal folder syncs", async () => {
    fakeDrive()
    expect(await gateDriveSourceSync(await reload(orgMyDrive.id))).toBe("skip")
    expect((await content(orgMyDrive.id)).live).toBe(0)
    expect(await gateDriveSourceSync(await reload(bobOwn.id))).toBe("sync")
    expect((await content(bobOwn.id)).live).toBe(1)
  })

  it("once drives are chosen: a folder in none of them is deleted, one in a chosen drive comes back", async () => {
    fakeDrive()
    await chooseSharedDrives({ orgId, userId: alice, scopes: ADMIN_SCOPES }, {}, ["Team"])
    const [audit] = extractRows<{ metadata: { before: string[]; after: string[] } }>(
      await db.execute(sql`SELECT metadata FROM kernel.audit_log
        WHERE org_id = ${orgId}::uuid AND action = 'google-drive.shared_drives.changed'`),
    )
    expect(audit?.metadata).toMatchObject({ before: [], after: ["DRIVE_TEAM"] })
    const due = await reload(orgTeam.id)
    expect(due.lastSyncAt).toBeNull()
    expect(due.lastError).toBe(ORG_DRIVE_RECHECK_REASON)

    expect(await gateDriveSourceSync(await reload(orgMyDrive.id))).toBe("skip")
    expect(await content(orgMyDrive.id)).toEqual({ live: 0, total: 0 })
    expect((await reload(orgMyDrive.id)).lastError).toBe(ORG_DRIVE_OUTSIDE_REASON)

    expect(await gateDriveSourceSync(await reload(orgTeam.id))).toBe("sync")
    await reconcileSyncedSource(await reload(orgTeam.id), adapter("teamfolder01"))
    // The document comes back as the same row; a link is linked anew (the
    // hidden one stays archived).
    expect((await content(orgTeam.id)).live).toBe(2)

    expect(await content(bobOwn.id)).toEqual({ live: 1, total: 1 })
  })

  it("answers an unknown file id like one outside the chosen drives, and uploads nothing", async () => {
    fakeDrive()
    const fetchers = makeDriveFetchers(async () => ({
      token: "t",
      readScope: { kind: "sharedDrives", drives: [{ id: "DRIVE_TEAM", name: "Team" }] },
    }))
    for (const id of ["nosuchfile01", "mydrivefold1"]) {
      const err = await fetchers.getMetadata({ id }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(DriveScopeError)
      expect(err).toMatchObject({ code: "OUTSIDE_SHARED_DRIVES", status: 404 })
    }
    const upload = await fetchers
      .uploadMultipart({ name: "r.txt", mimeType: "text/plain", bytes: Buffer.from("x") })
      .catch((e: unknown) => e)
    expect(upload).toMatchObject({ code: "ORG_UPLOAD_UNSUPPORTED" })
  })
})
