// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Integration test: Knowledge attachment RLS inheritance.
 *
 * Verifies that the files service correctly enforces Knowledge document
 * visibility rules when authorizing uploads and listing file metadata.
 * Personal document owner-only RLS is inherited through the manifest
 * file-parent registration — no production file-service changes required.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { getDefaultApps, initAppsForOrg } from "~/modules/apps/init"
import { authorizeUpload, listFiles } from "~/modules/files/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let ownerId: string
let otherId: string
let docId: string
let fileId: string

beforeAll(async () => {
  await acquireTestLock()

  // Unique org so tests don't collide with other integration test runs
  const slug = `knowledge-files-${Date.now()}`

  const [org] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'KnowledgeFiles', ${slug}) RETURNING id`,
    ),
  )
  orgId = org!.id

  const [owner] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`owner-${Date.now()}@x.test`}, 'Owner', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  ownerId = owner!.id

  const [other] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${`other-${Date.now()}@x.test`}, 'Other', 'active', 'h', 1, 1)
          RETURNING id`,
    ),
  )
  otherId = other!.id

  // Insert a personal Knowledge document owned by ownerId
  const [doc] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO app_knowledge.documents
            (id, org_id, title, body, document_scope, owner_user_id, participant_ids, created_by, revision, required_scopes)
          VALUES
            (gen_random_uuid(), ${orgId}::uuid, 'Private note', 'body', 'personal', ${ownerId}::uuid, ${JSON.stringify([ownerId])}::jsonb, ${ownerId}::uuid, 1, '{}'::text[])
          RETURNING id`,
    ),
  )
  docId = doc!.id

  // An image the page's text embeds, stored as the page's own file.
  const [file] = extractRows<{ id: string }>(
    await db.execute(
      sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                    size_bytes, storage_key, uploaded_by)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'knowledge', 'document', ${docId}, 'diagram.png',
                  'image/png', 4, ${`test/${docId}/diagram.png`}, ${ownerId}::uuid)
          RETURNING id`,
    ),
  )
  fileId = file!.id

  // Register Knowledge (and other default apps) so the manifest file-parent
  // registry is populated for this org. Required for resolveParent("knowledge", "document").
  resetAppRegistries()
  const apps = await getDefaultApps()
  await initAppsForOrg(orgId, apps)
})

afterAll(releaseTestLock)

describe("Knowledge attachment RLS", () => {
  it("allows the personal document owner to upload attachments", async () => {
    await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: ownerId,
        scopes: [
          "knowledge:attachments:upload",
          "knowledge:documents:read",
          "knowledge:documents:update",
        ],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        const result = await authorizeUpload(
          {
            orgId,
            userId: ownerId,
            scopes: [
              "knowledge:attachments:upload",
              "knowledge:documents:read",
              "knowledge:documents:update",
            ],
            app: "knowledge",
            entityType: "document",
            entityId: docId,
            filename: "note.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
          {
            rlsTx,
            privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
            presignPut: async () => "https://upload.test",
          },
        )
        expect(result.storageKey).toContain(`/knowledge/document/${docId}/`)
      },
    )
  })

  it("denies upload when the actor can read but cannot update the parent document", async () => {
    await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: ownerId,
        scopes: ["knowledge:attachments:upload", "knowledge:documents:read"],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        await expect(
          authorizeUpload(
            {
              orgId,
              userId: ownerId,
              scopes: ["knowledge:attachments:upload", "knowledge:documents:read"],
              app: "knowledge",
              entityType: "document",
              entityId: docId,
              filename: "note.txt",
              mimeType: "text/plain",
              sizeBytes: 4,
            },
            {
              rlsTx,
              privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
              presignPut: async () => "https://upload.test",
            },
          ),
        ).rejects.toThrow(/forbidden/i)
      },
    )
  })

  it("denies another user before exposing attachment metadata", async () => {
    await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: otherId,
        scopes: ["knowledge:attachments:download", "knowledge:documents:read"],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        const result = await listFiles(
          { app: "knowledge", entityType: "document", entityId: docId },
          { rlsTx },
        )
        // RLS filters rows — other user sees empty list
        expect(result.files).toEqual([])
        expect(result.total).toBe(0)
      },
    )
  })

  it("a page's reader reads its images with the page's read scope alone", async () => {
    // No knowledge:attachments:* scope: a page's files follow the page.
    await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: ownerId,
        scopes: ["knowledge:documents:read"],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        const result = await listFiles(
          {
            app: "knowledge",
            entityType: "document",
            entityId: docId,
            orgId,
            scopes: ["knowledge:documents:read"],
          },
          { rlsTx },
        )
        expect(result.files.map((f) => f.id)).toEqual([fileId])
        const direct = extractRows<{ id: string }>(
          await rlsTx.execute(
            sql`SELECT id::text AS id FROM kernel.files WHERE id = ${fileId}::uuid`,
          ),
        )
        expect(direct).toHaveLength(1)
      },
    )
  })

  it("someone who cannot read the page cannot read its images, by list or by id", async () => {
    await withRlsContext(
      {
        actorType: "user",
        orgId,
        userId: otherId,
        scopes: ["knowledge:documents:read", "knowledge:documents:update"],
        dimensionGrants: {},
      },
      async (rlsTx) => {
        const direct = extractRows<{ id: string }>(
          await rlsTx.execute(
            sql`SELECT id::text AS id FROM kernel.files WHERE id = ${fileId}::uuid`,
          ),
        )
        expect(direct).toHaveLength(0)
      },
    )
  })

  it("the page's owner without the page read scope reads no file of it", async () => {
    await withRlsContext(
      { actorType: "user", orgId, userId: ownerId, scopes: [], dimensionGrants: {} },
      async (rlsTx) => {
        const direct = extractRows<{ id: string }>(
          await rlsTx.execute(
            sql`SELECT id::text AS id FROM kernel.files WHERE id = ${fileId}::uuid`,
          ),
        )
        expect(direct).toHaveLength(0)
      },
    )
  })
})
