// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Behavioural RLS proof for the upload-session / moveFilesToParent flow.
 *
 * Hits a real Postgres so we observe what the row-level security policies
 * actually deny — not just that the service code happened to throw. Covers:
 *   - upload sessions are visible only to their owner
 *   - moveFilesToParent rejects a target that doesn't match the session's
 *     stored target_app/target_entity_type
 *   - moveFilesToParent rejects a target_entity_id that doesn't match the
 *     session's pinned target_entity_id
 *   - moveFilesToParent rejects file ids that are not parented to the session
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { FileServiceError, moveFilesToParent } from "~/modules/files/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let aliceId: string
let bobId: string
let threadId: string
let sessionAlice: string
let fileAlice: string

beforeAll(async () => {
  await acquireTestLock()
  const slug = `files-rls-${Date.now()}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'FilesRlsOrg', ${slug}) RETURNING id
    `),
  )
  orgId = org!.id
  const [a] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-${Date.now()}@x.test`}, 'Alice', 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  aliceId = a!.id
  const [b] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`bob-${Date.now()}@x.test`}, 'Bob', 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  bobId = b!.id

  // Thread owned by Alice — Bob is NOT a participant.
  const [t] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`thr-${Date.now()}`}, 'thread', ${aliceId}::uuid)
      RETURNING id
    `),
  )
  threadId = t!.id
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}::uuid, ${aliceId}::uuid, ${orgId}::uuid, 'owner')
  `)

  // Alice creates an upload session pinned to that thread.
  const [s] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.file_upload_sessions (org_id, created_by, target_app, target_entity_type, target_entity_id)
      VALUES (${orgId}::uuid, ${aliceId}::uuid, 'kernel', 'thread', ${threadId}::uuid)
      RETURNING id
    `),
  )
  sessionAlice = s!.id

  // A file staged onto Alice's session.
  const [f] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.files
        (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by, disposition)
      VALUES (${orgId}::uuid, 'kernel', 'file_upload_session', ${sessionAlice},
              'staged.png', 'image/png', 12, ${`orgs/${orgId}/k/upload/${sessionAlice}/staged.png`}, ${aliceId}::uuid, 'attachment')
      RETURNING id
    `),
  )
  fileAlice = f!.id
})

afterAll(async () => {
  await releaseTestLock()
})

describe("kernel.file_upload_sessions RLS — owner visibility", () => {
  it("session created by Alice is NOT visible to Bob", async () => {
    const visible = await withRlsContext(
      {
        actorType: "user",
        userId: bobId,
        orgId,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (rls) =>
        extractRows<{ id: string }>(
          await rls.execute(drizzleSql`
            SELECT id FROM kernel.file_upload_sessions WHERE id = ${sessionAlice}::uuid
          `),
        ),
    )
    expect(visible).toHaveLength(0)
  })

  it("session created by Alice IS visible to Alice", async () => {
    const visible = await withRlsContext(
      {
        actorType: "user",
        userId: aliceId,
        orgId,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (rls) =>
        extractRows<{ id: string }>(
          await rls.execute(drizzleSql`
            SELECT id FROM kernel.file_upload_sessions WHERE id = ${sessionAlice}::uuid
          `),
        ),
    )
    expect(visible).toHaveLength(1)
  })
})

describe("moveFilesToParent — behavioural validation", () => {
  it("rejects when target.app differs from session.target_app", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: aliceId,
        orgId,
        scopes: ["kernel:threads:write", "mail:conversations:write"],
        dimensionGrants: {},
      },
      async (rls) => {
        await expect(
          moveFilesToParent(
            {
              orgId,
              userId: aliceId,
              scopes: ["kernel:threads:write", "mail:conversations:write"],
              sourceSessionId: sessionAlice,
              target: { app: "mail", entityType: "message", entityId: threadId },
              fileIds: [fileAlice],
            },
            {
              rlsTx: rls,
              privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
            },
          ),
        ).rejects.toThrow(FileServiceError)
      },
    )
  })

  it("rejects when target.entityId differs from session's pinned entity", async () => {
    const wrongEntityId = "00000000-0000-0000-0000-0000000000ff"
    await withRlsContext(
      {
        actorType: "user",
        userId: aliceId,
        orgId,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (rls) => {
        await expect(
          moveFilesToParent(
            {
              orgId,
              userId: aliceId,
              scopes: ["kernel:threads:write"],
              sourceSessionId: sessionAlice,
              target: { app: "kernel", entityType: "thread", entityId: wrongEntityId },
              fileIds: [fileAlice],
            },
            {
              rlsTx: rls,
              privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
            },
          ),
        ).rejects.toThrow(FileServiceError)
      },
    )
  })

  it("rejects when a fileId is not parented to the source session", async () => {
    // Create an unrelated file on a different session.
    const [otherSess] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.file_upload_sessions (org_id, created_by, target_app, target_entity_type, target_entity_id)
        VALUES (${orgId}::uuid, ${aliceId}::uuid, 'kernel', 'thread', ${threadId}::uuid)
        RETURNING id
      `),
    )
    const [other] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.files
          (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by, disposition)
        VALUES (${orgId}::uuid, 'kernel', 'file_upload_session', ${otherSess!.id},
                'other.png', 'image/png', 12, ${`orgs/${orgId}/k/upload/${otherSess!.id}/other.png`}, ${aliceId}::uuid, 'attachment')
        RETURNING id
      `),
    )

    await withRlsContext(
      {
        actorType: "user",
        userId: aliceId,
        orgId,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (rls) => {
        await expect(
          moveFilesToParent(
            {
              orgId,
              userId: aliceId,
              scopes: ["kernel:threads:write"],
              sourceSessionId: sessionAlice,
              target: { app: "kernel", entityType: "thread", entityId: threadId },
              fileIds: [other!.id], // belongs to otherSess, not sessionAlice
            },
            {
              rlsTx: rls,
              privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
            },
          ),
        ).rejects.toThrow(FileServiceError)
      },
    )
  })

  it("rejects when caller is not the session owner (RLS denies session lookup)", async () => {
    // Bob attempts to move Alice's staged file. Even with the right scopes
    // and a valid target, owner-RLS on `kernel.file_upload_sessions` hides
    // the session from Bob so the service throws FORBIDDEN.
    await withRlsContext(
      {
        actorType: "user",
        userId: bobId,
        orgId,
        scopes: ["kernel:threads:write"],
        dimensionGrants: {},
      },
      async (rls) => {
        await expect(
          moveFilesToParent(
            {
              orgId,
              userId: bobId,
              scopes: ["kernel:threads:write"],
              sourceSessionId: sessionAlice,
              target: { app: "kernel", entityType: "thread", entityId: threadId },
              fileIds: [fileAlice],
            },
            {
              rlsTx: rls,
              privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
            },
          ),
        ).rejects.toThrow(FileServiceError)
      },
    )
  })
})
