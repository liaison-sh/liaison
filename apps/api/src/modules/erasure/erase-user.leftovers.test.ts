// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a GDPR erasure leaves outside the rows its cascade rewrites: the
// person's profile picture (served without authentication by its key), their
// live WebSocket connections, and the search documents of the app rows the
// cascade deletes with plain SQL (no entity event reaches the indexer).
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import * as searchClientModule from "~/infra/search/client"
import { getWsManager, setWsManager, type WebSocketManager } from "~/infra/websocket"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { eraseUser } from "~/modules/erasure/erase-user"
import { documentId } from "~/modules/search/document-id"
import { resolveAvatarForServe } from "~/modules/users/avatar-service"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  userId = await withSystemDb("erase-leftovers-user", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    return rows[0].id
  })
})

describe("erasure leftovers", () => {
  test("the erased person's profile picture is no longer served by its key", async () => {
    const avatarKey = crypto.randomBytes(16).toString("hex")
    await withSystemDb("erase-leftovers-avatar", (tx) =>
      tx.execute(drizzleSql`
        UPDATE kernel.users
           SET avatar_key = ${avatarKey}, avatar_url = ${`/api/avatars/${avatarKey}`}
         WHERE id = ${userId}`),
    )
    // Positive control: before the erasure the key resolves to the stored object.
    const before = await withSystemDb("erase-leftovers-avatar-before", (tx) =>
      resolveAvatarForServe(tx, avatarKey),
    )
    expect(before).not.toBeNull()

    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)

    // `GET /api/avatars/:key` is unauthenticated: anyone holding the URL (a
    // colleague's cache, a forwarded mail) keeps fetching the face otherwise.
    const after = await withSystemDb("erase-leftovers-avatar-after", (tx) =>
      resolveAvatarForServe(tx, avatarKey),
    )
    expect(after).toBeNull()
  })

  test("the erased person's open WebSocket connections are closed", async () => {
    const closed: string[] = []
    const previous = getWsManager()
    setWsManager({
      closeConnectionsForUser: (id: string) => {
        closed.push(id)
      },
    } as unknown as WebSocketManager)
    try {
      const res = await eraseUser(userId)
      expect(res.exitCode).toBe(0)
    } finally {
      if (previous) setWsManager(previous)
    }
    // Either path closes them: a direct close, or the `user deactivate` event the
    // permission subscriber turns into a close on every node (what deactivateUser
    // queues). Without one, a socket that never pings keeps receiving the org's
    // live events after the account is gone.
    const queued = await withSystemDb("erase-leftovers-events", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM kernel.pending_events
           WHERE org_id = ${orgId}
             AND payload->>'entity' = 'user'
             AND payload->>'action' = 'deactivate'
             AND payload->>'entityId' = ${userId}`),
      ),
    )
    expect(closed.includes(userId) || queued[0].n > 0).toBe(true)
  })

  test("the search documents of the mail the erasure deletes are removed too", async () => {
    const accountId = crypto.randomUUID()
    const conversationId = crypto.randomUUID()
    await withSystemDb("erase-leftovers-mail", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
        VALUES (${accountId}, ${orgId}, gen_random_uuid(), 'user', ${userId}, 'gmail',
          ${`erased-${accountId.slice(0, 8)}@example.test`}, 'idle')`)
      await tx.execute(drizzleSql`
        INSERT INTO app_mail.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, status,
           labels, is_read, is_starred, message_count)
        VALUES (${conversationId}, ${orgId}, ${accountId}, 'user', ${userId},
          ${`ext-${conversationId}`}, 'Private medical appointment', 'open', '[]', false, false, 0)`)
    })

    const deleted: string[] = []
    const spy = spyOn(searchClientModule, "getMeili").mockReturnValue({
      index: () => ({
        deleteDocuments: async (ids: string[]) => {
          deleted.push(...ids)
          return { taskUid: 1 }
        },
        addDocuments: async () => ({ taskUid: 1 }),
        updateDocuments: async () => ({ taskUid: 1 }),
      }),
      tasks: { waitForTask: async () => undefined },
    } as never)
    const { LiveIndexTestAccess, flushLiveIndexOnce } = await import(
      "~/modules/search/live-index-queue"
    )
    await LiveIndexTestAccess.clear()
    try {
      const res = await eraseUser(userId)
      expect(res.exitCode).toBe(0)
      // The cascade did delete the row (onErase: delete on ownerId).
      const left = await withSystemDb("erase-leftovers-mail-rows", async (tx) =>
        extractRows<{ n: number }>(
          await tx.execute(
            drizzleSql`SELECT count(*)::int AS n FROM app_mail.conversations WHERE id = ${conversationId}`,
          ),
        ),
      )
      expect(left[0].n).toBe(0)
      while ((await flushLiveIndexOnce()) > 0) {}
    } finally {
      spy.mockRestore()
      await LiveIndexTestAccess.clear()
    }
    // Its document (subject, sender) must not outlive the row in the index.
    expect(deleted).toContain(documentId(orgId, "mail", "conversation", conversationId))
  })
})
