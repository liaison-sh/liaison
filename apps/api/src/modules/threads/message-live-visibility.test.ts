// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A message EDIT and a message DELETE reach exactly the connections that may
// read the message, and no others.
//
// The fan-out fails closed on a kernel `message` frame with no requiredScopes
// array, so an untagged producer reaches NOBODY: not a leak, but a silent loss
// of live delivery for the very people entitled to it. These are the two
// producers that carry no tag of their own, driven end to end: the real
// editMessage / deleteMessage against a real row, the event they actually
// queued read back out of the outbox, and a real WebSocketManager with two
// connections in the same thread whose ONLY difference is their grants.
//
// Membership can therefore never explain a difference in delivery here, and
// nothing is asserted through a proxy: the assertion is what each socket was
// sent.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import crypto from "node:crypto"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  deleteMessage,
  editMessage,
  publishMessageAttachments,
  sendMessage,
} from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { messageVisibilityFacts } from "~/services/security/visibility"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPE = "mlv:deals:read"
const ORIGINAL = "Deal 42 closes Friday"
const EDITED = "Deal 42 closes Monday for 90k"

type WsEvent = Parameters<WebSocketManager["bufferAndBroadcast"]>[0]

interface FakeSocket {
  send: ReturnType<typeof mock>
  readyState: number
}

describe("a message edit and delete reach only the connections that may read the row", () => {
  let orgId: string

  async function userWith(scopes: string[]): Promise<string> {
    const user = await minimal.person(orgId)
    await minimal.revokeRole(user.id, "member")
    for (const scope of scopes) await minimal.grantScope(user.id, scope)
    return user.id
  }

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-mlv-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  async function seedThread(createdBy: string, participantIds: string[]): Promise<string> {
    return withPrivilegedDb(orgId, "test-mlv-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `mlv-${crypto.randomUUID().slice(0, 8)}`,
          type: "thread",
          createdBy,
        })
        .returning({ id: threads.id })
      for (const userId of participantIds) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
  }

  /** Posts a message as `userId`, tagged, optionally disclosed to someone. */
  async function post(
    threadId: string,
    userId: string,
    requiredScopes: string[],
    disclosureList: string[] | null = null,
  ): Promise<string> {
    const msg = await withPrivilegedDb(orgId, "test-mlv-post", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        orgId,
        userId,
        threadId,
        content: ORIGINAL,
        requiredScopes,
        disclosureList,
      }),
    )
    if (!msg) throw new Error("the author could not post into the test thread")
    return msg.id
  }

  /**
   * The event the producer ACTUALLY queued, read back out of the transactional
   * outbox rather than reconstructed here, so the test cannot pass on a frame
   * the production path never emitted.
   */
  async function queuedEvent(action: string, messageId: string): Promise<WsEvent> {
    const rows = await sql<{ payload: WsEvent }[]>`
      SELECT payload FROM kernel.pending_events
      WHERE payload->>'app' = 'kernel'
        AND payload->>'entity' = 'message'
        AND payload->>'action' = ${action}
        AND payload->>'entityId' = ${messageId}
      ORDER BY seq DESC LIMIT 1`
    if (rows.length === 0) throw new Error(`no queued message:${action} for ${messageId}`)
    return rows[0].payload
  }

  /**
   * Two connections, both members of the same thread, differing only in grants.
   * The manager is fresh per test so no earlier socket can absorb a send.
   */
  function connect(
    threadId: string,
    holderId: string,
    lackerId: string,
  ): { manager: WebSocketManager; holder: FakeSocket; lacker: FakeSocket } {
    const manager = new WebSocketManager(redis)
    const holder: FakeSocket = { send: mock(() => {}), readyState: 1 }
    const lacker: FakeSocket = { send: mock(() => {}), readyState: 1 }
    manager.addConnection(holderId, holder as never, ["kernel", SCOPE], orgId)
    manager.addConnection(lackerId, lacker as never, ["kernel"], orgId)
    manager.setThreadMembership(holder as never, new Set([threadId]))
    manager.setThreadMembership(lacker as never, new Set([threadId]))
    return { manager, holder, lacker }
  }

  function sentText(socket: FakeSocket): string {
    return socket.send.mock.calls.map((c: unknown[]) => String(c[0])).join("")
  }

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  test("an edit reaches the connection holding the scope, carrying the new content, and not the one lacking it", async () => {
    const holderId = await userWith([SCOPE])
    const lackerId = await userWith([])
    const threadId = await seedThread(holderId, [holderId, lackerId])
    const messageId = await post(threadId, holderId, [SCOPE])

    const edited = await withRlsContext(await actorFor(holderId), (tx) =>
      editMessage(tx, { orgId, userId: holderId, threadId, messageId, content: EDITED }),
    )
    expect(edited).not.toBeNull()

    const event = await queuedEvent("update", messageId)
    const { manager, holder, lacker } = connect(threadId, holderId, lackerId)
    await manager.bufferAndBroadcast(event)

    expect(holder.send).toHaveBeenCalledTimes(1)
    expect(sentText(holder)).toContain(EDITED)
    // Nothing at all, not a redacted copy: the edit is not announced to a
    // connection that cannot read the message.
    expect(lacker.send).not.toHaveBeenCalled()
  })

  test("the edit event carries the row's own tag, not an empty one", async () => {
    const holderId = await userWith([SCOPE])
    const threadId = await seedThread(holderId, [holderId])
    const messageId = await post(threadId, holderId, [SCOPE])

    await withRlsContext(await actorFor(holderId), (tx) =>
      editMessage(tx, { orgId, userId: holderId, threadId, messageId, content: EDITED }),
    )

    const data = (await queuedEvent("update", messageId)).data as Record<string, unknown>
    // An empty array would be a positive claim that the row carries no scoped
    // data, which would show the edit to the whole room.
    expect(data.requiredScopes).toEqual([SCOPE])
  })

  test("a delete reaches the connection holding the scope and not the one lacking it", async () => {
    const holderId = await userWith([SCOPE])
    const lackerId = await userWith([])
    const threadId = await seedThread(holderId, [holderId, lackerId])
    const messageId = await post(threadId, holderId, [SCOPE])

    const deleted = await withRlsContext(await actorFor(holderId), (tx) =>
      deleteMessage(tx, { orgId, userId: holderId, threadId, messageId }),
    )
    expect(deleted).not.toBeNull()

    const event = await queuedEvent("delete", messageId)
    const { manager, holder, lacker } = connect(threadId, holderId, lackerId)
    await manager.bufferAndBroadcast(event)

    expect(holder.send).toHaveBeenCalledTimes(1)
    expect(sentText(holder)).toContain(messageId)
    expect(lacker.send).not.toHaveBeenCalled()
  })

  test("the delete tag is read from the row while it is still there, so it survives the soft delete", async () => {
    const holderId = await userWith([SCOPE])
    const threadId = await seedThread(holderId, [holderId])
    const messageId = await post(threadId, holderId, [SCOPE])

    await withRlsContext(await actorFor(holderId), (tx) =>
      deleteMessage(tx, { orgId, userId: holderId, threadId, messageId }),
    )

    const data = (await queuedEvent("delete", messageId)).data as Record<string, unknown>
    expect(data.requiredScopes).toEqual([SCOPE])
  })

  test("an edit of a row with a disclosure list reaches the disclosed to connection, which holds none of the scopes", async () => {
    const holderId = await userWith([SCOPE])
    const disclosedId = await userWith([])
    const threadId = await seedThread(holderId, [holderId, disclosedId])
    // Share anyway's shape: the row is scoped, and one member is disclosed to.
    const messageId = await post(threadId, holderId, [SCOPE], [disclosedId])

    await withRlsContext(await actorFor(holderId), (tx) =>
      editMessage(tx, { orgId, userId: holderId, threadId, messageId, content: EDITED }),
    )

    const event = await queuedEvent("update", messageId)
    const { manager, holder, lacker: disclosed } = connect(threadId, holderId, disclosedId)
    await manager.bufferAndBroadcast(event)

    // The disclosure list is the only thing letting the second connection
    // through: it holds no scopes at all.
    expect(disclosed.send).toHaveBeenCalledTimes(1)
    expect(sentText(disclosed)).toContain(EDITED)
    expect(holder.send).toHaveBeenCalledTimes(1)
  })

  test("a disclosure list is carried onto the edit event rather than dropped", async () => {
    const holderId = await userWith([SCOPE])
    const disclosedId = await userWith([])
    const threadId = await seedThread(holderId, [holderId, disclosedId])
    const messageId = await post(threadId, holderId, [SCOPE], [disclosedId])

    await withRlsContext(await actorFor(holderId), (tx) =>
      editMessage(tx, { orgId, userId: holderId, threadId, messageId, content: EDITED }),
    )

    const data = (await queuedEvent("update", messageId)).data as Record<string, unknown>
    expect(data.disclosureList).toEqual([disclosedId])
  })

  test("an edit never leaks the visibility columns into what the route returns", async () => {
    const holderId = await userWith([SCOPE])
    const threadId = await seedThread(holderId, [holderId])
    const messageId = await post(threadId, holderId, [SCOPE])

    const edited = await withRlsContext(await actorFor(holderId), (tx) =>
      editMessage(tx, { orgId, userId: holderId, threadId, messageId, content: EDITED }),
    )
    const deleted = await withRlsContext(await actorFor(holderId), (tx) =>
      deleteMessage(tx, { orgId, userId: holderId, threadId, messageId }),
    )

    // The route serialises these straight to the client; the tag is fan-out
    // metadata and has no business in the message body response.
    expect(edited).not.toHaveProperty("requiredScopes")
    expect(edited).not.toHaveProperty("disclosureList")
    expect(deleted).not.toHaveProperty("requiredScopes")
    expect(deleted).not.toHaveProperty("disclosureList")
  })

  /** Links one file to the message, the way the send route's reparent leaves it. */
  async function attachFile(messageId: string, uploadedBy: string): Promise<void> {
    await sql`
      INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by, ordinal, disposition)
      VALUES (${orgId}, 'kernel', 'message', ${messageId}, 'screenshot.png', 'image/png',
              312000, ${`test/${messageId}/screenshot.png`}, ${uploadedBy}, 0, 'inline')`
  }

  /**
   * The send route's publish step. Privileged like `post` above: these users
   * carry only the test scope, and what is under test is the frame, not the
   * files read policy.
   */
  function publishAs(userId: string, threadId: string, messageId: string) {
    return withPrivilegedDb(orgId, "test-mlv-attachments", (tx) =>
      publishMessageAttachments(tx as unknown as RlsClient, { orgId, userId, threadId, messageId }),
    )
  }

  // The attachments of a sent message reach the thread in a follow-up
  // `message:update`, because the create event is queued before the files are
  // reparented. That update used to go out UNTAGGED, so the fan-out, which
  // fails closed, delivered it to nobody: everyone already in the thread saw
  // the text and never the file until they reloaded.
  test("the attachments update of an unscoped message reaches every member, carrying the file", async () => {
    const senderId = await userWith([])
    const otherId = await userWith([])
    const threadId = await seedThread(senderId, [senderId, otherId])
    const messageId = await post(threadId, senderId, [])
    await attachFile(messageId, senderId)

    const attachments = await publishAs(senderId, threadId, messageId)
    expect(attachments).toHaveLength(1)

    const event = await queuedEvent("update", messageId)
    // Both connections hold no scope: the unscoped row is readable by the room.
    const { manager, holder: sender, lacker: other } = connect(threadId, senderId, otherId)
    await manager.bufferAndBroadcast(event)

    expect(other.send).toHaveBeenCalledTimes(1)
    expect(sentText(other)).toContain("screenshot.png")
    // The sender's OTHER devices learn about the file the same way.
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sentText(sender)).toContain("screenshot.png")
  })

  test("the attachments update of a scoped message reaches the connection holding the scope and not the one lacking it", async () => {
    const holderId = await userWith([SCOPE])
    const lackerId = await userWith([])
    const threadId = await seedThread(holderId, [holderId, lackerId])
    const messageId = await post(threadId, holderId, [SCOPE])
    await attachFile(messageId, holderId)

    await publishAs(holderId, threadId, messageId)

    const event = await queuedEvent("update", messageId)
    expect((event.data as Record<string, unknown>).requiredScopes).toEqual([SCOPE])
    const { manager, holder, lacker } = connect(threadId, holderId, lackerId)
    await manager.bufferAndBroadcast(event)

    expect(holder.send).toHaveBeenCalledTimes(1)
    expect(sentText(holder)).toContain("screenshot.png")
    expect(lacker.send).not.toHaveBeenCalled()
  })

  test("a row whose visibility facts cannot be determined is left untagged and stays hidden from everyone", async () => {
    // The fail-closed rule at the point where the facts are assembled: an
    // unreadable tag yields NO keys, never `[]`, so the fan-out drops the frame
    // instead of publishing a scoped message to the whole room.
    expect(messageVisibilityFacts({ requiredScopes: null })).toEqual({})
    expect(messageVisibilityFacts({ requiredScopes: undefined })).toEqual({})
    expect(messageVisibilityFacts({ requiredScopes: [SCOPE, 7] })).toEqual({})

    const holderId = await userWith([SCOPE])
    const lackerId = await userWith([])
    const threadId = await seedThread(holderId, [holderId, lackerId])
    const messageId = await post(threadId, holderId, [SCOPE])

    const { manager, holder, lacker } = connect(threadId, holderId, lackerId)
    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "message",
      action: "update",
      entityId: messageId,
      orgId,
      data: {
        id: messageId,
        threadId,
        content: EDITED,
        ...messageVisibilityFacts({ requiredScopes: null }),
      },
    } as WsEvent)

    // Not even the member who holds every scope the row could have required.
    expect(holder.send).not.toHaveBeenCalled()
    expect(lacker.send).not.toHaveBeenCalled()
  })

  test("an unreadable disclosure list narrows to null rather than inventing a disclosure", async () => {
    expect(messageVisibilityFacts({ requiredScopes: [SCOPE], disclosureList: "nope" })).toEqual({
      requiredScopes: [SCOPE],
      disclosureList: null,
    })
  })
})
