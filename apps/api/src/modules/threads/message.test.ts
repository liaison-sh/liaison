// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

const publishedEvents: any[] = []
const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async (event: any) => {
  publishedEvents.push(event)
}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async (event: any) => {
      publishedEvents.push(event)
    }
    return fn(tx)
  })
}

import {
  deleteMessage,
  editMessage,
  listMessages,
  postAgentAutoAddSystemMessage,
  publishMessageAttachments,
  sendMessage,
} from "~/modules/threads/message"

const ORG = "00000000-0000-0000-0000-000000000001"
const USER1 = "00000000-0000-0000-0000-000000000002"
const USER2 = "00000000-0000-0000-0000-000000000003"
// Every registered user has a personal agent, and an agent-authored row names
// the agent that spoke (0080). Seeded here so the agent sends below look like
// the product's.
const AGENT1 = "00000000-0000-0000-0000-0000000000a1"
const AGENT2 = "00000000-0000-0000-0000-0000000000a2"
let threadId: string

describe("message service", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Org', 'msg-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'a-msg@t.com', 'Alice') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER2}, ${ORG}, 'b-msg@t.com', 'Bob') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
              VALUES (${AGENT1}, ${ORG}, 'personal', '@alice-msg', 'Alice agent', ${USER1})
              ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
              VALUES (${AGENT2}, ${ORG}, 'personal', '@bob-msg', 'Bob agent', ${USER2})
              ON CONFLICT (id) DO NOTHING`
    await sql`SELECT setval('kernel.thread_handle_seq', 200, false)`
    const [t] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'thread-200', 'Msg Test', ${USER1})
      RETURNING id
    `
    threadId = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${USER1}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${USER2}, ${ORG})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER1}, ${threadId}, ${ORG})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER2}, ${threadId}, ${ORG})`
  })

  beforeEach(() => {
    publishedEvents.length = 0
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
    await sql`DELETE FROM kernel.agents WHERE id IN (${AGENT1}, ${AGENT2})`
  })

  it("sends a message and bumps thread updatedAt", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Hello!",
    })
    expect(msg?.id).toBeDefined()
    expect(msg?.content).toBe("Hello!")
    expect(msg?.authorId).toBe(USER1)
    expect(publishedEvents.some((e) => e.entity === "message" && e.action === "create")).toBe(true)
  })

  it("the message:create event carries the message's requiredScopes", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: ["crm:deals:read"],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Scoped reply",
      authorType: "agent",
      agentAuthorLabel: "Alice's agent",
    })
    const created = publishedEvents.find(
      (e) => e.entity === "message" && e.action === "create" && e.entityId === msg?.id,
    )
    expect(created?.data.requiredScopes).toEqual(["crm:deals:read"])
  })

  it("extracts mentions from content", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Hey @[Bob](user:00000000-0000-0000-0000-000000000003) check this",
    })
    expect(msg?.mentions).toEqual([{ type: "user", id: USER2 }])
  })

  it("edits own message and sets editedAt", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Original",
    })
    const edited = await editMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      messageId: msg!.id,
      content: "Edited",
    })
    expect(edited?.content).toBe("Edited")
    expect(edited?.editedAt).not.toBeNull()
  })

  it("prevents editing other user's message", async () => {
    const msg = await sendMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Mine",
      requiredScopes: [],
    })
    const result = await editMessage(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      messageId: msg!.id,
      content: "Hacked",
    })
    expect(result).toBeNull()
  })

  it("soft-deletes message (sets deletedAt)", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Delete me",
    })
    const deleted = await deleteMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      messageId: msg!.id,
    })
    expect(deleted?.deletedAt).not.toBeNull()
  })

  // Deletion is author-only for a plain (non-admin) participant. USER2 is a
  // participant but not the author and has no admin scope, so deletion must
  // fail. The admin bypass (isAdmin: true) is covered separately below.
  it("cannot delete other user's message (non-admin, non-author)", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Protected",
    })
    expect(msg).not.toBeNull()
    const result = await deleteMessage(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      messageId: msg!.id,
    })
    expect(result).toBeNull()
    // The message survives the rejected delete — not soft-deleted.
    const survivors = await listMessages(rlsDb, { orgId: ORG, userId: USER1, threadId, limit: 50 })
    expect(survivors?.messages.some((m: { id: string }) => m.id === msg!.id)).toBe(true)
  })

  it("prevents editing other user's message when not admin", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Mine too",
    })
    const result = await editMessage(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      messageId: msg!.id,
      content: "Hacked",
      isAdmin: false,
    })
    expect(result).toBeNull()
  })

  it("allows an org admin (isAdmin) to edit another user's message", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Original by USER1",
    })
    const edited = await editMessage(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      messageId: msg!.id,
      content: "Corrected by admin",
      isAdmin: true,
    })
    expect(edited?.content).toBe("Corrected by admin")
    expect(edited?.editedAt).not.toBeNull()
  })

  it("allows an org admin (isAdmin) to delete another user's message", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Admin will delete this",
    })
    expect(msg).not.toBeNull()
    const deleted = await deleteMessage(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      messageId: msg!.id,
      isAdmin: true,
    })
    expect(deleted?.deletedAt).not.toBeNull()
  })

  it("admin edit/delete still requires the admin to be a thread participant", async () => {
    const NON_PARTICIPANT = "00000000-0000-0000-0000-000000000098"
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Not touchable by a non-participant admin",
    })
    expect(msg).not.toBeNull()
    const editResult = await editMessage(rlsDb, {
      orgId: ORG,
      userId: NON_PARTICIPANT,
      threadId,
      messageId: msg!.id,
      content: "Should not apply",
      isAdmin: true,
    })
    expect(editResult).toBeNull()
    const deleteResult = await deleteMessage(rlsDb, {
      orgId: ORG,
      userId: NON_PARTICIPANT,
      threadId,
      messageId: msg!.id,
      isAdmin: true,
    })
    expect(deleteResult).toBeNull()
  })

  describe("agent-authored message edit/delete authorization", () => {
    it("the triggering user (authorId) can edit/delete their own agent's message without admin", async () => {
      // sendMessage always persists authorId = the initiating userId, even for
      // authorType='agent' — the agent has no separate identity, only an
      // attribution label. So the plain author-only check already lets the
      // triggering human manage their own agent's messages.
      const agentMsg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "Agent reply to USER1's turn",
        authorType: "agent",
        agentAuthorLabel: "Alice's agent",
      })
      expect(agentMsg?.authorId).toBe(USER1)

      const edited = await editMessage(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        messageId: agentMsg!.id,
        content: "Corrected by the triggering user",
        isAdmin: false,
      })
      expect(edited?.content).toBe("Corrected by the triggering user")

      const deleted = await deleteMessage(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        messageId: agentMsg!.id,
        isAdmin: false,
      })
      expect(deleted?.deletedAt).not.toBeNull()
    })

    it("a non-admin, non-triggering participant cannot edit/delete another user's agent message", async () => {
      const agentMsg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "Agent reply to USER1's turn, attempt 2",
        authorType: "agent",
        agentAuthorLabel: "Alice's agent",
      })
      expect(agentMsg).not.toBeNull()

      const editResult = await editMessage(rlsDb, {
        orgId: ORG,
        userId: USER2,
        threadId,
        messageId: agentMsg!.id,
        content: "Should not apply",
        isAdmin: false,
      })
      expect(editResult).toBeNull()

      const deleteResult = await deleteMessage(rlsDb, {
        orgId: ORG,
        userId: USER2,
        threadId,
        messageId: agentMsg!.id,
        isAdmin: false,
      })
      expect(deleteResult).toBeNull()
    })

    it("an org admin can edit/delete another user's agent-authored message", async () => {
      const agentMsg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "Agent reply an admin will moderate",
        authorType: "agent",
        agentAuthorLabel: "Alice's agent",
      })
      expect(agentMsg).not.toBeNull()

      const edited = await editMessage(rlsDb, {
        orgId: ORG,
        userId: USER2,
        threadId,
        messageId: agentMsg!.id,
        content: "Corrected by admin",
        isAdmin: true,
      })
      expect(edited?.content).toBe("Corrected by admin")

      const deleted = await deleteMessage(rlsDb, {
        orgId: ORG,
        userId: USER2,
        threadId,
        messageId: agentMsg!.id,
        isAdmin: true,
      })
      expect(deleted?.deletedAt).not.toBeNull()
    })
  })

  it("returns null when non-participant tries to send a message (T-2)", async () => {
    const NON_PARTICIPANT = "00000000-0000-0000-0000-000000000099"
    const result = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: NON_PARTICIPANT,
      threadId,
      content: "Should be blocked",
    })
    expect(result).toBeNull()
  })

  it("returns null when editing a soft-deleted message (T-4)", async () => {
    const msg = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "To delete then edit",
    })
    expect(msg).not.toBeNull()
    await deleteMessage(rlsDb, { orgId: ORG, userId: USER1, threadId, messageId: msg!.id })
    const result = await editMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      messageId: msg!.id,
      content: "Should not update",
    })
    expect(result).toBeNull()
  })

  it("lists messages with cursor pagination", async () => {
    const result = await listMessages(rlsDb, { orgId: ORG, userId: USER1, threadId, limit: 5 })
    expect(Array.isArray(result?.messages)).toBe(true)
    expect(result?.messages.length).toBeGreaterThan(0)
  })

  it("returns only newer messages when using after cursor", async () => {
    // Send 3 messages to have enough for pagination
    const msg1 = await sendMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "First",
      requiredScopes: [],
    })
    const msg2 = await sendMessage(rlsDb, {
      requiredScopes: [],
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Second",
    })
    const msg3 = await sendMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Third",
      requiredScopes: [],
    })
    expect(msg1).not.toBeNull()
    expect(msg2).not.toBeNull()
    expect(msg3).not.toBeNull()

    // Request messages after msg1 — should get msg2 and msg3 (and possibly earlier messages from other tests)
    const result = await listMessages(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      limit: 50,
      after: msg1!.id,
    })
    expect(result).not.toBeNull()
    const ids = result!.messages.map((m: any) => m.id)
    // msg1 should NOT be in the result (it's the cursor)
    expect(ids).not.toContain(msg1!.id)
    // msg2 and msg3 should be in the result, in DESC order (newest first)
    expect(ids).toContain(msg2!.id)
    expect(ids).toContain(msg3!.id)
    const idx3 = ids.indexOf(msg3!.id)
    const idx2 = ids.indexOf(msg2!.id)
    expect(idx3).toBeLessThan(idx2)
  })

  describe("listMessages before cursor", () => {
    it("returns only older messages when using before cursor", async () => {
      // Send 5 messages sequentially
      const msgs = []
      for (let i = 1; i <= 5; i++) {
        const msg = await sendMessage(rlsDb, {
          requiredScopes: [],
          orgId: ORG,
          userId: USER1,
          threadId,
          content: `Before-${i}`,
        })
        expect(msg).not.toBeNull()
        msgs.push(msg!)
      }

      // List all messages without cursor — verify all 5 are present
      const allResult = await listMessages(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        limit: 50,
      })
      expect(allResult).not.toBeNull()
      for (const msg of msgs) {
        expect(allResult!.messages.some((m: any) => m.id === msg.id)).toBe(true)
      }

      // Use the last (newest) message's ID as `before` cursor
      const lastMsg = msgs[msgs.length - 1]
      const beforeResult = await listMessages(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        limit: 50,
        before: lastMsg.id,
      })
      expect(beforeResult).not.toBeNull()

      const ids = beforeResult!.messages.map((m: any) => m.id)

      // The cursor message itself must NOT be in the result
      expect(ids).not.toContain(lastMsg.id)

      // Earlier messages (1-4) must be present
      for (let i = 0; i < msgs.length - 1; i++) {
        expect(ids).toContain(msgs[i].id)
      }

      // Results should be in DESC order (newest first)
      for (let i = 0; i < ids.length - 1; i++) {
        const curr = beforeResult!.messages[i] as any
        const next = beforeResult!.messages[i + 1] as any
        expect(new Date(curr.createdAt).getTime()).toBeGreaterThanOrEqual(
          new Date(next.createdAt).getTime(),
        )
      }
    })
  })

  it("hides content for deleted messages in list", async () => {
    const msg = await sendMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "Secret",
      requiredScopes: [],
    })
    expect(msg).not.toBeNull()
    await deleteMessage(rlsDb, { orgId: ORG, userId: USER1, threadId, messageId: msg!.id })
    const result = await listMessages(rlsDb, { orgId: ORG, userId: USER1, threadId, limit: 50 })
    const found = result?.messages.find((m: any) => m.id === msg?.id)
    expect(found?.content).toBeNull()
    expect(found?.deletedAt).not.toBeNull()
  })

  it("listMessages never returns attachments for a deleted message, even if its file rows remain", async () => {
    const msg = await sendMessage(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      content: "with a file",
      requiredScopes: [],
    })
    // A row left behind by a delete that predates attachment deletion.
    await sql`
      INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by, ordinal)
      VALUES (${ORG}, 'kernel', 'message', ${msg!.id}, 'left.png', 'image/png',
              10, ${`test/${msg!.id}/left.png`}, ${USER1}, 0)
    `
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${msg!.id}`
    const result = await listMessages(rlsDb, { orgId: ORG, userId: USER1, threadId, limit: 50 })
    const found = result?.messages.find((m: any) => m.id === msg?.id)
    expect(found?.deletedAt).not.toBeNull()
    expect(found?.attachments).toEqual([])
    await sql`DELETE FROM kernel.files WHERE entity_id = ${msg!.id}`
  })

  it("listMessages returns 400 for invalid cursor", async () => {
    await expect(
      listMessages(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        before: "00000000-0000-0000-0000-000000000000",
        limit: 20,
      }),
    ).rejects.toThrow("Invalid cursor")
  })

  describe("agent message authorship", () => {
    it("attributes an agent message with its label and persists it in metadata", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "agent attributed post",
        authorType: "agent",
        agentAuthorLabel: "Alice's agent",
      })
      expect(msg).not.toBeNull()
      expect(msg!.authorType).toBe("agent")
      expect(msg!.authorName).toBe("Alice's agent")
      expect((msg!.metadata as { agentAuthorLabel?: string })?.agentAuthorLabel).toBe(
        "Alice's agent",
      )
      const evt = publishedEvents.find(
        (e) => e.entity === "message" && e.action === "create" && e.data.id === msg!.id,
      )
      expect(evt.data.authorType).toBe("agent")
      expect(evt.data.authorName).toBe("Alice's agent")
    })

    it("records a routine label when the post originates from a routine", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "routine digest post",
        authorType: "agent",
        agentAuthorLabel: "Routine daily-digest",
      })
      expect(msg!.authorName).toBe("Routine daily-digest")
      expect((msg!.metadata as { agentAuthorLabel?: string })?.agentAuthorLabel).toBe(
        "Routine daily-digest",
      )
    })

    it("carries the speaking agent on the message:create frame", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "frame names the agent",
        authorType: "agent",
      })
      const evt = publishedEvents.find(
        (e) => e.entity === "message" && e.action === "create" && e.data.id === msg!.id,
      )
      expect(evt.data.authorAgentId).toBe(AGENT1)
    })

    it("listMessages surfaces the agent label as authorName", async () => {
      await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "read-path agent post",
        authorType: "agent",
        agentAuthorLabel: "Alice's agent",
      })
      const result = await listMessages(rlsDb, { orgId: ORG, userId: USER1, threadId, limit: 50 })
      const found = result?.messages.find((m: any) => m.content === "read-path agent post")
      expect(found?.authorType).toBe("agent")
      expect(found?.authorName).toBe("Alice's agent")
    })
  })

  // The `message:create` event is queued inside the insert transaction, BEFORE
  // the upload session's files are reparented onto the message — so it can
  // never carry attachments. Every participant other than the sender learns
  // about them from this follow-up `message:update`; without it the message
  // rendered bare until the page was reloaded.
  describe("publishMessageAttachments", () => {
    it("emits a message:update carrying the reparented attachments", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "see attached",
      })
      await sql`
        INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type,
                                  size_bytes, storage_key, uploaded_by, ordinal)
        VALUES (${ORG}, 'kernel', 'message', ${msg!.id}, 'spec.pdf', 'application/pdf',
                1234, ${`test/${msg!.id}/spec.pdf`}, ${USER1}, 0)
      `
      publishedEvents.length = 0

      const attachments = await publishMessageAttachments(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        messageId: msg!.id,
      })

      expect(attachments).toHaveLength(1)
      expect((attachments[0] as { filename: string }).filename).toBe("spec.pdf")

      const ev = publishedEvents.find((e) => e.entity === "message" && e.action === "update")
      expect(ev).toBeTruthy()
      expect(ev.data.id).toBe(msg!.id)
      expect(ev.data.threadId).toBe(threadId)
      expect(ev.data.attachments).toHaveLength(1)
      expect(ev.data.attachments[0].filename).toBe("spec.pdf")
      expect(ev.data.attachments[0].sizeBytes).toBe(1234)
      // Attachments-only: it must not clobber content or editedAt on receivers.
      expect(ev.data.content).toBeUndefined()
      expect(ev.data.editedAt).toBeUndefined()

      await sql`DELETE FROM kernel.files WHERE entity_id = ${msg!.id}`
    })

    it("emits nothing when the message has no attachments", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "no files here",
      })
      publishedEvents.length = 0
      const attachments = await publishMessageAttachments(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        messageId: msg!.id,
      })
      expect(attachments).toHaveLength(0)
      expect(publishedEvents).toHaveLength(0)
    })
  })

  describe("requiredScopes", () => {
    async function storedScopes(id: string): Promise<string[]> {
      const [row] = await sql<{ required_scopes: string[] }[]>`
        SELECT required_scopes FROM kernel.messages WHERE id = ${id}`
      return row?.required_scopes ?? ["<row missing>"]
    }

    it("sendMessage requires an explicit requiredScopes argument", async () => {
      const untagged = {
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "untagged agent reply",
        authorType: "agent",
      } as unknown as Parameters<typeof sendMessage>[1]
      await expect((async () => sendMessage(rlsDb, untagged))()).rejects.toThrow("requiredScopes")
      const rows = await sql`
        SELECT id FROM kernel.messages
        WHERE thread_id = ${threadId} AND content = 'untagged agent reply'`
      expect(rows).toHaveLength(0)
    })

    it("sendMessage persists an empty requiredScopes array distinctly from a missing column default", async () => {
      const empty = await sendMessage(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "turn touched no scoped data",
        authorType: "agent",
        requiredScopes: [],
      })
      expect(await storedScopes(empty!.id)).toEqual([])

      const scoped = await sendMessage(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "turn read deals and tickets",
        authorType: "agent",
        requiredScopes: ["crm:deals:read", "tickets:tickets:read"],
      })
      expect(await storedScopes(scoped!.id)).toEqual(["crm:deals:read", "tickets:tickets:read"])
    })
  })

  // T14. A dedicated thread so the expectation is exact rather than whatever
  // the tests above happened to leave in the shared one. This caller holds no
  // grants, so the two tagged messages are hidden from it and the run marker
  // takes their place, anchored to the visible message before each of them.
  describe("hiddenRuns", () => {
    it("listMessages includes a hiddenRuns field describing hidden message positions", async () => {
      const [t] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, title, created_by)
        VALUES (${ORG}, ${`thread-hidden-runs-${USER1.slice(0, 8)}`}, 'Hidden runs', ${USER1})
        RETURNING id`
      const hrThreadId = t.id
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${hrThreadId}, ${USER1}, ${ORG})`
      const planted: string[] = []
      for (const [seq, content, scopes] of [
        [1, "open one", [] as string[]],
        [2, "scoped one", ["crm:deals:read"]],
        [3, "open two", [] as string[]],
      ] as const) {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO kernel.messages
            (thread_id, org_id, author_id, author_type, content, required_scopes, created_at)
          VALUES (${hrThreadId}, ${ORG}, ${USER1}, 'user', ${content}, ${scopes}::text[],
            ${`2026-03-01T00:00:0${seq}Z`}::timestamptz)
          RETURNING id`
        planted.push(row.id)
      }

      const result = await listMessages(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId: hrThreadId,
        limit: 50,
      })
      expect(result).not.toBeNull()
      expect(result!.hiddenRuns).toEqual([{ afterMessageId: planted[0], count: 1 }])
      expect(result!.messages.map((x: any) => x.content)).toEqual(["open two", "open one"])

      await sql`DELETE FROM kernel.messages WHERE thread_id = ${hrThreadId}`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${hrThreadId}`
      await sql`DELETE FROM kernel.threads WHERE id = ${hrThreadId}`
    })
  })
  describe("agent attribution on the message row", () => {
    // P4b carry-in H1: an agent-authored row NAMES the speaking agent, so the
    // read side resolves its name and avatar from the row instead of a
    // client-side sentinel.
    it("sendMessage records the acting agent on an agent-authored row", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "Attributed reply",
        authorType: "agent",
        agentId: AGENT1,
      })
      const [row] = await sql`SELECT author_agent_id FROM kernel.messages WHERE id = ${msg!.id}`
      expect(row.author_agent_id).toBe(AGENT1)
    })

    it("sendMessage falls back to the requester's personal agent when no agent is named", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "Unnamed reply",
        authorType: "agent",
      })
      const [row] = await sql`SELECT author_agent_id FROM kernel.messages WHERE id = ${msg!.id}`
      expect(row.author_agent_id).toBe(AGENT1)
    })

    it("sendMessage leaves author_agent_id null on a human-authored row", async () => {
      const msg = await sendMessage(rlsDb, {
        requiredScopes: [],
        orgId: ORG,
        userId: USER1,
        threadId,
        content: "Just a human",
      })
      const [row] = await sql`SELECT author_agent_id FROM kernel.messages WHERE id = ${msg!.id}`
      expect(row.author_agent_id).toBeNull()
    })
  })
})

describe("the auto-add system line", () => {
  // P4b-T15: one fixed line, from spec.md's copy table, so a room always says
  // who pulled an agent in and why.
  const ORG2 = "00000000-0000-0000-0000-0000000000d1"
  const USER = "00000000-0000-0000-0000-0000000000d2"
  let lineThreadId: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG2}, 'LineOrg', 'line-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG2}, 'line@t.com', 'Taylor') ON CONFLICT (id) DO NOTHING`
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG2}, 'line-thread', 'Line', ${USER}) RETURNING id`
    lineThreadId = t!.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${lineThreadId}, ${USER}, ${ORG2})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG2}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG2}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG2}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG2}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG2}`
  })

  it("postAgentAutoAddSystemMessage writes the join line as a system EVENT, not a post", async () => {
    const msg = await postAgentAutoAddSystemMessage(rlsDb, {
      orgId: ORG2,
      threadId: lineThreadId,
      actorUserId: USER,
      adderName: "Taylor",
      agentName: "Support Agent",
    })
    const [row] = await sql`
      SELECT content, author_type, author_agent_id, metadata
        FROM kernel.messages WHERE id = ${msg.id}`
    // The room sees the agent's NAME, exactly as it sees a person's name when
    // somebody is added by hand: no handle, no "(mentioned)" tail.
    expect(row.content).toBe("Taylor added Support Agent")
    expect(row.author_type).toBe("system")
    expect(row.author_agent_id).toBeNull()
    // Marked in the DATA MODEL as a membership event: without this every
    // surface has to guess from the sentence, and the line renders as a
    // message from the person who did the mentioning.
    expect(row.metadata?.type).toBe("participant-added")
    expect(row.metadata?.participantKind).toBe("agent")
    expect(row.metadata?.actorName).toBe("Taylor")
    expect(row.metadata?.participantName).toBe("Support Agent")
    // House style: no dash punctuation in anything a customer reads.
    expect(row.content.includes("--")).toBe(false)
    expect(row.content.includes("\u2014")).toBe(false)
    expect(row.content.includes("\u2013")).toBe(false)
  })
})

// P4c-T10: the thread send path must reach the agent turn with the same context
// the retiring agent panel's /agent/chat send carried — the app the user is
// looking at, and the mailbox turn nonce that lets the turn ask that browser to
// decrypt. Both ride the message create body and land on the run's context.
describe("thread message dispatch carries the surface's turn context", () => {
  const ORG3 = "00000000-0000-0000-0000-0000000000c1"
  const USER3 = "00000000-0000-0000-0000-0000000000c2"
  let dmThreadId: string
  let token: string
  let calls: unknown[][]
  // Kept so afterAll can put the real module back — `mock.module` patches the
  // module registry for the WHOLE process, so a stub left in place here silences
  // every later file's agent dispatch (agent-mention's replies never arrive).
  let realAgentService: typeof import("~/modules/agent/runtime/agent-service")
  // `mock.module` mutates the live module record, so the namespace captured above
  // reports the STUB afterwards: the real function has to be held by reference.
  let realInvokeAgentForThread: (typeof realAgentService)["invokeAgentForThread"]

  beforeAll(async () => {
    const { signAccessToken } = await import("~/modules/auth/jwt")
    const { env } = await import("~/lib/env")
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG3}, 'Ctx Org', 'ctx-org-t10') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER3}, ${ORG3}, 'ctx-t10@t.com', 'Ctx User') ON CONFLICT (id) DO NOTHING`
    const [t] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, type)
      VALUES (${ORG3}, 'thread-t10-ctx', 'Ctx DM', ${USER3}, 'agent_chat')
      RETURNING id`
    dmThreadId = t.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${dmThreadId}, ${USER3}, ${ORG3})`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER3}, ${dmThreadId}, ${ORG3})`
    token = await signAccessToken(
      {
        userId: USER3,
        orgId: ORG3,
        name: "Ctx User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )

    // The turn itself is another slice's business: this pins WHAT the dispatch
    // hands it. mock.module patches the module the route imports dynamically.
    realAgentService = await import("~/modules/agent/runtime/agent-service")
    realInvokeAgentForThread = realAgentService.invokeAgentForThread
    calls = []
    mock.module("~/modules/agent/runtime/agent-service", () => ({
      ...realAgentService,
      invokeAgentForThread: (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve({ finishReason: "stop" })
      },
    }))
  })

  afterAll(async () => {
    // Undo the process-wide module patch before anything else: a later file that
    // posts an @mention must reach the REAL invokeAgentForThread.
    mock.module("~/modules/agent/runtime/agent-service", () => ({
      ...realAgentService,
      invokeAgentForThread: realInvokeAgentForThread,
    }))
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG3}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG3}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG3}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG3}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG3}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG3}`
  })

  beforeEach(() => {
    calls.length = 0
  })

  const post = async (body: Record<string, unknown>) => {
    const { app } = await import("~/app")
    const res = await app.request(`/api/threads/${dmThreadId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    // The dispatch is fire and forget; give it a tick to reach the turn.
    await new Promise((r) => setTimeout(r, 100))
    return res
  }

  it("a thread message carrying currentView and turnNonce hands both to the agent turn", async () => {
    const res = await post({
      content: "what does this ticket say",
      currentView: { tabType: "ticket", entityId: "tk-1" },
      turnNonce: "nonce-abcdef12",
    })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    // Last positional: the surface's turn context, exactly as /agent/chat's
    // route hands runAgentChat its currentView + mailboxTurnNonce.
    expect(calls[0][11]).toEqual({
      currentView: { tabType: "ticket", entityId: "tk-1" },
      mailboxTurnNonce: "nonce-abcdef12",
    })
  })

  it("a thread message without them dispatches unchanged", async () => {
    const res = await post({ content: "just a message" })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0][11]).toBeUndefined()
  })

  // A restricted (device-flow) session's turn is marked, so the agent tools
  // whose REST counterpart refuses such a session (assertUnrestrictedSession:
  // steering a session on the computer) refuse it too.
  it("a thread message from a restricted session marks its agent turn", async () => {
    const { signAccessToken } = await import("~/modules/auth/jwt")
    const { env } = await import("~/lib/env")
    const restricted = await signAccessToken(
      {
        userId: USER3,
        orgId: ORG3,
        name: "Ctx User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
        restricted: true,
      },
      env.JWT_SECRET,
    )
    const { app } = await import("~/app")
    const res = await app.request(`/api/threads/${dmThreadId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${restricted}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: "stop that session" }),
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
    expect(calls[0][11]).toEqual({ sessionRestricted: true })
  })

  // The surface the sender is on (desktop app, browser, mobile app) chooses
  // which steps to computer mode a server turn gives. It rides the same turn
  // context as currentView.
  for (const clientSurface of ["desktop", "web", "mobile"] as const) {
    it(`a thread message from the ${clientSurface} surface hands it to the agent turn`, async () => {
      const res = await post({ content: "make the monthly report", clientSurface })
      expect(res.status).toBe(200)
      expect(calls.length).toBe(1)
      expect(calls[0][11]).toEqual({ clientSurface })
    })
  }

  it("a thread message naming an unknown surface is refused", async () => {
    const res = await post({ content: "make the monthly report", clientSurface: "fridge" })
    expect(res.status).toBe(400)
    expect(calls.length).toBe(0)
  })
})
