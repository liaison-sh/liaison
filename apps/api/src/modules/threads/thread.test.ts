// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import postgres from "postgres"
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

import { parseMentions } from "~/lib/mentions"
import {
  createThread,
  DuplicateThreadError,
  getThread,
  listDiscoverableChannels,
  listThreads,
  readThreadParticipantsAsSystem,
  updateThread,
} from "~/modules/threads/thread"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000001"
const TEST_USER_ID = "00000000-0000-0000-0000-000000000002"
const TEST_USER2_ID = "00000000-0000-0000-0000-000000000003"

describe("thread service", () => {
  beforeAll(async () => {
    await sql`DELETE FROM kernel.threads WHERE org_id = ${TEST_ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG_ID}`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${TEST_ORG_ID}, 'Test Org', 'test-thread-svc') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TEST_USER_ID}, ${TEST_ORG_ID}, 'alice-thread@test.com', 'Alice') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TEST_USER2_ID}, ${TEST_ORG_ID}, 'bob-thread@test.com', 'Bob') ON CONFLICT (id) DO NOTHING`
    await sql`SELECT setval('kernel.thread_handle_seq', 1, false)`
  })

  beforeEach(() => {
    publishedEvents.length = 0
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.threads WHERE org_id = ${TEST_ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
  })

  it("creates a thread with participants and generates handle", async () => {
    const result = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Test Thread",
      forceCreate: true,
    })
    expect(result.id).toBeDefined()
    // A35: a titled room is a channel and its handle is its name.
    expect(result.handle).toBe("test-thread")
    expect(result.title).toBe("Test Thread")
    expect(result.participants.length).toBe(2)
    expect(publishedEvents.some((e) => e.entity === "thread" && e.action === "create")).toBe(true)
  })

  it("readThreadParticipantsAsSystem: the thread's seats in its own org, nothing for another org", async () => {
    const thread = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "System Seats",
      forceCreate: true,
    })
    const own = await readThreadParticipantsAsSystem(TEST_ORG_ID, thread.id, "test:seats")
    expect(own.map((p) => p.id).sort()).toEqual([TEST_USER_ID, TEST_USER2_ID].sort())
    const OTHER_ORG_ID = "00000000-0000-0000-0000-0000000000ff"
    const foreign = await readThreadParticipantsAsSystem(OTHER_ORG_ID, thread.id, "test:seats")
    expect(foreign).toEqual([])
  })

  it("creates thread with initial message — title stays null (named by participants)", async () => {
    const result = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      initialMessage: { content: "Hello from the new thread!", requiredScopes: [] },
    })
    expect(result.title).toBeNull()
    expect((result as { initialMessageId?: string }).initialMessageId).toBeDefined()
    expect(publishedEvents.some((e) => e.entity === "message" && e.action === "create")).toBe(true)
  })

  it("deduplicates DMs — returns existing thread when 1 participant, no title, no refs, not pinned", async () => {
    const first = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    const second = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    expect(second.id).toBe(first.id)
    expect(second.deduplicated).toBe(true)
  })

  it("deduplicates DMs symmetrically — B->A finds the same thread as A->B", async () => {
    const first = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    // USER2 creates DM to USER1 — should find the same thread
    const second = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER2_ID,
      participantIds: [TEST_USER_ID],
    })
    expect(second.id).toBe(first.id)
    expect(second.deduplicated).toBe(true)
  })

  // A TITLED create for people who already have a thread is a mistake, not a new
  // conversation: it used to skip dedup entirely (dedup required title IS NULL)
  // and silently open a second thread with the same person (prod, 2026-08-02).
  it("refuses a titled thread when these participants already have one", async () => {
    const first = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    let caught: unknown
    try {
      await createThread(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        participantIds: [TEST_USER2_ID],
        title: "Some new topic",
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DuplicateThreadError)
    // The error names the thread to reply in, so the caller can recover.
    expect((caught as DuplicateThreadError).existing.id).toBe(first.id)
    expect((caught as DuplicateThreadError).code).toBe("duplicate_thread")
    expect((caught as DuplicateThreadError).message).toContain(first.handle)
  })

  it("refuses symmetrically — B->A is the same participant set as A->B", async () => {
    await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    expect(
      createThread(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER2_ID,
        participantIds: [TEST_USER_ID],
        title: "Same people, other direction",
      }),
    ).rejects.toBeInstanceOf(DuplicateThreadError)
  })

  it("refuses a SECOND titled thread too (guard sees titled threads, not just DMs)", async () => {
    const first = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "First topic",
      forceCreate: true,
    })
    let caught: unknown
    try {
      await createThread(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        participantIds: [TEST_USER2_ID],
        title: "Second topic",
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DuplicateThreadError)
    expect([first.id]).toContain((caught as DuplicateThreadError).existing.id)
  })

  it("forceCreate is the deliberate override and still creates", async () => {
    const first = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    const forced = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Deliberately separate",
      forceCreate: true,
    })
    expect(forced.id).not.toBe(first.id)
    expect(forced.title).toBe("Deliberately separate")
  })

  it("still allows entity-anchored threads for the same participants (tickets, mail)", async () => {
    await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    const anchored = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Ticket 42",
      createdFrom: { app: "tickets", entityType: "ticket", entityId: "t-42" },
    })
    expect(anchored.id).toBeDefined()
    const withRefs = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "About an invoice",
      references: [{ app: "invoicing", entityType: "document", entityId: "d-1" }],
    })
    expect(withRefs.id).toBeDefined()
  })

  it("does not dedup contextual threads even with same participants", async () => {
    const organic = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    const contextual = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      createdFrom: { app: "test", entityType: "item", entityId: "item-1" },
    })
    expect(contextual.id).not.toBe(organic.id)
    expect(contextual.createdFrom).toEqual({ app: "test", entityType: "item", entityId: "item-1" })
  })

  it("creates thread with references", async () => {
    const result = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "With Refs",
      references: [{ app: "test", entityType: "item", entityId: "item-42" }],
    })
    expect(result.id).toBeDefined()
    // Verify reference was inserted
    const refs = await sql`SELECT * FROM kernel.thread_references WHERE thread_id = ${result.id}`
    expect(refs.length).toBe(1)
    expect(refs[0].app).toBe("test")
    expect(refs[0].entity_id).toBe("item-42")
  })

  // References are context the conversation carries, not an anchor: an
  // untitled create with references between people who already have a DM
  // lands in that DM, posts there and attaches the references to it.
  it("an untitled create with references lands in the existing DM and attaches them", async () => {
    const dm = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
    })
    const withRefs = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      initialMessage: { content: "About order 1042", requiredScopes: [] },
      references: [
        { app: "shopify", entityType: "order", entityId: "o-1042" },
        { app: "tickets", entityType: "ticket", entityId: "t-7" },
      ],
    })
    expect(withRefs.id).toBe(dm.id)
    expect(withRefs.deduplicated).toBe(true)
    // The other side asking again, with one reference already attached, is the same room too.
    const again = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER2_ID,
      participantIds: [TEST_USER_ID],
      references: [{ app: "shopify", entityType: "order", entityId: "o-1042" }],
    })
    expect(again.id).toBe(dm.id)
    const refs = await sql`
      SELECT app, entity_id FROM kernel.thread_references WHERE thread_id = ${dm.id} ORDER BY entity_id`
    expect(refs.map((r) => `${r.app}:${r.entity_id}`)).toEqual(["shopify:o-1042", "tickets:t-7"])
    const posted = await sql`SELECT content FROM kernel.messages WHERE thread_id = ${dm.id}`
    expect(posted.map((m) => m.content)).toContain("About order 1042")
    const rooms = await sql`
      SELECT t.id FROM kernel.threads t
      WHERE t.org_id = ${TEST_ORG_ID} AND t.type = 'thread' AND t.title IS NULL
        AND t.created_from IS NULL AND t.is_pinned = false
        AND (SELECT COUNT(*) FROM kernel.thread_participants tp WHERE tp.thread_id = t.id) = 2`
    expect(rooms.length).toBe(1)
  })

  it("does not collapse a self-DM into an existing single-user agent_chat", async () => {
    // An agent_chat with a single participant and no title/createdFrom/pin
    // otherwise matches the DM dedup shape. The dedup must constrain on
    // `type = 'thread'` so a self-DM never forwards into the agent chat.
    const agentChatId = "00000000-0000-0000-0000-00000000ac01"
    await sql`DELETE FROM kernel.threads WHERE id = ${agentChatId}`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, type, created_by)
      VALUES (${agentChatId}, ${TEST_ORG_ID}, 'self-dm-agent-chat', NULL, 'agent_chat', ${TEST_USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${agentChatId}, ${TEST_USER_ID}, ${TEST_ORG_ID}, 'owner')`

    // Self-DM: no other participants → participant set is just the caller.
    const selfDm = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [],
    })
    expect(selfDm.id).not.toBe(agentChatId)
    const [row] = await sql`SELECT type FROM kernel.threads WHERE id = ${selfDm.id}`
    expect(row.type).toBe("thread")
  })

  // Was "does not dedup when title is provided" — that silent second thread is
  // exactly the bug the guard now refuses. A title no longer buys a new thread;
  // forceCreate does.
  it("a title alone no longer opens a second thread — forceCreate does", async () => {
    const first = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Named group",
      forceCreate: true,
    })
    const second = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Another named group",
      forceCreate: true,
    })
    expect(second.id).not.toBe(first.id)
  })

  it("an agent's last message is previewed under the agent's name, with its failure code", async () => {
    // An agent reply keeps the REQUESTER as author_id (sendMessage). The Home unread
    // preview read "<the user's own name>: <the agent's failure line>" (third QA walk).
    const thread = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Agent preview room",
      forceCreate: true,
    })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${TEST_ORG_ID}, 'role', '@preview-desk', 'Preview Desk', '[]'::jsonb)
      RETURNING id`
    try {
      await sql`
        INSERT INTO kernel.messages
          (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, metadata)
        VALUES (${thread.id}, ${TEST_ORG_ID}, ${TEST_USER_ID}, 'agent', ${agent!.id},
                'failure line', '{}'::text[], ${JSON.stringify({ agentNotice: "provider_quota" })}::jsonb)`
      const result = await listThreads(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        limit: 50,
      })
      const row = result.threads.find((t: { id: string }) => t.id === thread.id) as
        | { lastMessage: Record<string, unknown> | null }
        | undefined
      expect(row?.lastMessage?.authorName).toBe("Preview Desk")
      expect(row?.lastMessage?.authorType).toBe("agent")
      expect(row?.lastMessage?.metadata).toEqual({ agentNotice: "provider_quota" })

      // A platform-written line carries the decision the reader's language is rebuilt from.
      await sql`
        INSERT INTO kernel.messages
          (thread_id, org_id, author_id, author_type, content, required_scopes, metadata, created_at)
        VALUES (${thread.id}, ${TEST_ORG_ID}, ${TEST_USER_ID}, 'system',
                'Withdrawn by the requester. Reason: plus utile.', '{}'::text[],
                ${JSON.stringify({ type: "approval-decision", decision: "withdrawn", reason: "plus utile" })}::jsonb,
                now() + interval '1 second')`
      const again = await listThreads(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        limit: 50,
      })
      const withdrawn = again.threads.find((t: { id: string }) => t.id === thread.id) as
        | { lastMessage: Record<string, unknown> | null }
        | undefined
      expect(withdrawn?.lastMessage?.metadata).toEqual({
        type: "approval-decision",
        decision: "withdrawn",
        reason: "plus utile",
      })
    } finally {
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${thread.id}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agent!.id}`
    }
  })

  // A DM opened from "+" with its first message: the author has no read mark
  // on it yet, and the sidebar showed an unread pill for their OWN message.
  it("never counts the reader's own first message as unread", async () => {
    const [third] = await sql<{ id: string }[]>`
      INSERT INTO kernel.users (org_id, email, name)
      VALUES (${TEST_ORG_ID}, ${`carol-${crypto.randomUUID().slice(0, 8)}@test.com`}, 'Carol')
      RETURNING id`
    const thread = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [third!.id],
      initialMessage: { content: "First words in a brand new DM", requiredScopes: [] },
    })
    try {
      const unreadFor = async (userId: string, unreadOnly = false) => {
        const { threads } = await listThreads(rlsDb, {
          orgId: TEST_ORG_ID,
          userId,
          limit: 50,
          ...(unreadOnly ? { unreadOnly } : {}),
        })
        return threads.find((t: { id: string }) => t.id === thread.id) as
          | { unreadCount: number }
          | undefined
      }
      // The author: nothing unread, and not in the unread-only list.
      expect((await unreadFor(TEST_USER_ID))?.unreadCount).toBe(0)
      expect(await unreadFor(TEST_USER_ID, true)).toBeUndefined()
      // The recipient: the message IS unread for them.
      expect((await unreadFor(third!.id))?.unreadCount).toBe(1)
      // An agent row stored under the author's id is NOT their own words: it
      // counts, exactly as the push badge counts it.
      const [agent] = await sql<{ id: string }[]>`
        INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${TEST_ORG_ID}, 'role', ${`@unread-desk-${thread.id.slice(0, 8)}`}, 'Unread Desk', '[]'::jsonb)
        RETURNING id`
      try {
        await sql`INSERT INTO kernel.messages
            (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, created_at)
          VALUES (${thread.id}, ${TEST_ORG_ID}, ${TEST_USER_ID}, 'agent', ${agent!.id}, 'agent answer',
                  '{}'::text[], now() + interval '1 second')`
        expect((await unreadFor(TEST_USER_ID))?.unreadCount).toBe(1)
      } finally {
        await sql`DELETE FROM kernel.messages WHERE thread_id = ${thread.id}`
        await sql`DELETE FROM kernel.agents WHERE id = ${agent!.id}`
      }
    } finally {
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${thread.id}`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${thread.id}`
      await sql`DELETE FROM kernel.threads WHERE id = ${thread.id}`
      await sql`DELETE FROM kernel.users WHERE id = ${third!.id}`
    }
  })

  it("lists threads for a user sorted by updatedAt desc", async () => {
    const result = await listThreads(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      limit: 50,
    })
    expect(Array.isArray(result.threads)).toBe(true)
    expect(result.threads.length).toBeGreaterThan(0)
    for (let i = 1; i < result.threads.length; i++) {
      expect(new Date(result.threads[i - 1].updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(result.threads[i].updatedAt).getTime(),
      )
    }
  })

  describe("listThreads — mail discussion filtering", () => {
    const MAIL_THREAD_ID = "00000000-0000-4000-a000-000000000099"
    const OTHER_APP_THREAD_ID = "00000000-0000-4000-a000-000000000098"

    beforeAll(async () => {
      await sql`
        INSERT INTO kernel.threads (id, org_id, handle, title, type, created_from, created_by)
        VALUES (
          ${MAIL_THREAD_ID}, ${TEST_ORG_ID}, 'thread-mail-99',
          'Discussion: Test email', 'thread',
          '{"app":"mail","entityType":"conversation","entityId":"conv-1"}'::jsonb,
          ${TEST_USER_ID}
        ) ON CONFLICT (id) DO NOTHING
      `
      await sql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${MAIL_THREAD_ID}, ${TEST_USER_ID}, ${TEST_ORG_ID})
        ON CONFLICT DO NOTHING
      `
      await sql`
        INSERT INTO kernel.threads (id, org_id, handle, title, type, created_from, created_by)
        VALUES (
          ${OTHER_APP_THREAD_ID}, ${TEST_ORG_ID}, 'thread-ticket-99',
          'Ticket discussion', 'thread',
          '{"app":"tickets","entityType":"ticket","entityId":"ticket-1"}'::jsonb,
          ${TEST_USER_ID}
        ) ON CONFLICT (id) DO NOTHING
      `
      await sql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${OTHER_APP_THREAD_ID}, ${TEST_USER_ID}, ${TEST_ORG_ID})
        ON CONFLICT DO NOTHING
      `
    })

    it("excludes single-participant mail discussion threads", async () => {
      const result = await listThreads(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        limit: 50,
      })
      const mailThread = result.threads.find((t: any) => t.id === MAIL_THREAD_ID)
      expect(mailThread).toBeUndefined()
    })

    it("includes mail discussion thread once second participant added", async () => {
      await sql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${MAIL_THREAD_ID}, ${TEST_USER2_ID}, ${TEST_ORG_ID})
        ON CONFLICT DO NOTHING
      `
      const result = await listThreads(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        limit: 50,
      })
      const mailThread = result.threads.find((t: any) => t.id === MAIL_THREAD_ID)
      expect(mailThread).toBeDefined()
      expect(mailThread!.title).toBe("Discussion: Test email")
    })

    it("applies the same hidden-until-shared behavior to non-mail app-created threads", async () => {
      const hiddenResult = await listThreads(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        limit: 50,
      })
      expect(hiddenResult.threads.find((t: any) => t.id === OTHER_APP_THREAD_ID)).toBeUndefined()

      await sql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${OTHER_APP_THREAD_ID}, ${TEST_USER2_ID}, ${TEST_ORG_ID})
        ON CONFLICT DO NOTHING
      `
      const sharedResult = await listThreads(rlsDb, {
        orgId: TEST_ORG_ID,
        userId: TEST_USER_ID,
        limit: 50,
      })
      const appThread = sharedResult.threads.find((t: any) => t.id === OTHER_APP_THREAD_ID)
      expect(appThread).toBeDefined()
      expect(appThread!.title).toBe("Ticket discussion")
    })
  })

  it("gets thread detail by ID", async () => {
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Detail Test",
      forceCreate: true,
    })
    const thread = await getThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      threadId: created.id,
    })
    expect(thread).not.toBeNull()
    expect(thread?.title).toBe("Detail Test")
    expect(thread?.participants.length).toBe(2)
  })

  it("returns null for thread user is not a participant of", async () => {
    const otherUserId = "00000000-0000-0000-0000-000000000099"
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Private Thread",
      forceCreate: true,
    })
    const thread = await getThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: otherUserId,
      threadId: created.id,
    })
    expect(thread).toBeNull()
  })

  it("updates thread title", async () => {
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Original",
      forceCreate: true,
    })
    const updated = await updateThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      threadId: created.id,
      scopes: ["*"],
      changes: { title: "Updated Title" },
    })
    expect(updated?.title).toBe("Updated Title")
  })

  it("persists per-model agentReasoningLevels and round-trips via getThread", async () => {
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Reasoning Thread",
      forceCreate: true,
    })
    const levels = { "claude-opus-4-6": "high", "gpt-5.4": "low" }
    const updated = await updateThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      threadId: created.id,
      scopes: ["*"],
      changes: { agentReasoningLevels: levels },
    })
    expect(updated?.agentReasoningLevels).toEqual(levels)

    const fetched = await getThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      threadId: created.id,
    })
    expect(fetched?.agentReasoningLevels).toEqual(levels)
  })

  it("returns null when non-participant tries to update thread (T-3)", async () => {
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Private Thread",
      forceCreate: true,
    })
    const NON_PARTICIPANT = "00000000-0000-0000-0000-000000000099"
    const result = await updateThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: NON_PARTICIPANT,
      threadId: created.id,
      scopes: ["*"],
      changes: { title: "Hacked Title" },
    })
    expect(result).toBeNull()
  })

  it("forbids a non-admin participant from changing type / hiddenFromList / agentModelId", async () => {
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Shared Thread",
      forceCreate: true,
    })
    // TEST_USER2 is a participant but only a `member` (the creator is admin).
    await sql`UPDATE kernel.thread_participants SET role = 'member'
      WHERE thread_id = ${created.id} AND user_id = ${TEST_USER2_ID}`

    const memberScopes = ["kernel:threads:read", "kernel:threads:write"]
    for (const changes of [
      { hiddenFromList: true },
      { type: "agent_chat" as const },
      { agentModelId: "some-model" },
    ]) {
      await expect(
        updateThread(rlsDb, {
          orgId: TEST_ORG_ID,
          userId: TEST_USER2_ID,
          threadId: created.id,
          scopes: memberScopes,
          changes,
        }),
      ).rejects.toMatchObject({ status: 403 })
    }
  })

  it("allows a thread admin to change hiddenFromList without the org admin scope", async () => {
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Admin-owned Thread",
      forceCreate: true,
    })
    // Creator is `admin`; non-wildcard scopes prove the thread-role path (not the
    // org `kernel:threads:admin` scope) is what grants the change.
    const updated = await updateThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      threadId: created.id,
      scopes: ["kernel:threads:read", "kernel:threads:write"],
      changes: { hiddenFromList: true },
    })
    expect(updated).not.toBeNull()
  })

  it("allows the org threads-admin scope to change shared settings even for a member", async () => {
    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Org-admin override",
      forceCreate: true,
    })
    await sql`UPDATE kernel.thread_participants SET role = 'member'
      WHERE thread_id = ${created.id} AND user_id = ${TEST_USER2_ID}`
    const updated = await updateThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER2_ID,
      threadId: created.id,
      scopes: ["kernel:threads:write", "kernel:threads:admin"],
      changes: { hiddenFromList: true },
    })
    expect(updated).not.toBeNull()
  })

  it("cross-org isolation: listThreads from org B returns nothing when threads exist only in org A", async () => {
    const ORG_B = "00000000-0000-0000-0000-bbb000000001"
    const ORG_B_USER = "00000000-0000-0000-0000-bbb000000002"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_B}, 'Org B', 'test-thread-orgb') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ORG_B_USER}, ${ORG_B}, 'orgb-user@test.com', 'OrgB User') ON CONFLICT (id) DO NOTHING`

    // Create a thread in org A (TEST_ORG_ID)
    await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Cross-Org Test",
      forceCreate: true,
    })

    // Query from org B context — should see no threads
    const result = await listThreads(rlsDb, {
      orgId: ORG_B,
      userId: ORG_B_USER,
      limit: 50,
    })
    expect(result.threads).toHaveLength(0)

    // Cleanup
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_B}`
  })

  it("cross-org isolation: getThread returns null when querying org A thread from org B context", async () => {
    const ORG_B = "00000000-0000-0000-0000-bbb000000001"
    const ORG_B_USER = "00000000-0000-0000-0000-bbb000000002"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_B}, 'Org B', 'test-thread-orgb') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ORG_B_USER}, ${ORG_B}, 'orgb-user@test.com', 'OrgB User') ON CONFLICT (id) DO NOTHING`

    const created = await createThread(rlsDb, {
      orgId: TEST_ORG_ID,
      userId: TEST_USER_ID,
      participantIds: [TEST_USER2_ID],
      title: "Isolation Test",
      forceCreate: true,
    })

    const result = await getThread(rlsDb, {
      orgId: ORG_B,
      userId: ORG_B_USER,
      threadId: created.id,
    })
    expect(result).toBeNull()

    // Cleanup
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_B}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_B}`
  })
})

describe("concurrent DM creation", () => {
  const DM_USER1 = "00000000-0000-0000-0000-000000000011"
  const DM_USER2 = "00000000-0000-0000-0000-000000000012"

  beforeAll(async () => {
    // Ensure org exists (may have been deleted by thread service afterAll in the same file)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${TEST_ORG_ID}, 'Test Org', 'test-org-dm') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${DM_USER1}, ${TEST_ORG_ID}, 'dm-alice@test.com', 'DM Alice') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${DM_USER2}, ${TEST_ORG_ID}, 'dm-bob@test.com', 'DM Bob') ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    // Clean up DM threads between these users
    await sql`
      DELETE FROM kernel.threads WHERE id IN (
        SELECT tp.thread_id FROM kernel.thread_participants tp
        WHERE tp.user_id IN (${DM_USER1}, ${DM_USER2})
      )
    `
    await sql`DELETE FROM kernel.users WHERE id IN (${DM_USER1}, ${DM_USER2})`
  })

  it("concurrent DM creation deduplicates correctly", async () => {
    // Fire 5 parallel createThread calls with the same participant set
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createThread(rlsDb, {
          orgId: TEST_ORG_ID,
          userId: DM_USER1,
          participantIds: [DM_USER2],
        }),
      ),
    )

    // All results should reference the same thread ID
    const uniqueIds = new Set(results.map((r) => r.id))
    expect(uniqueIds.size).toBe(1)

    // At least some should be marked as deduplicated (the first one creates, the rest dedup)
    const deduplicated = results.filter((r) => r.deduplicated)
    expect(deduplicated.length).toBe(4) // 4 of 5 should be deduped
  })
})

describe("parseMentions", () => {
  const U1 = "00000000-0000-0000-0000-000000000001"
  const U2 = "00000000-0000-0000-0000-000000000002"
  const U3 = "00000000-0000-0000-0000-000000000003"

  it("parses user mentions", () => {
    const result = parseMentions(`Hey @[Alice](user:${U1})`)
    expect(result).toEqual([{ type: "user", id: U1 }])
  })

  it("parses thread mentions", () => {
    const result = parseMentions(`See @[Engineering](thread:${U2})`)
    expect(result).toEqual([{ type: "thread", id: U2 }])
  })

  it("parses entity mentions", () => {
    const result = parseMentions(`Fix @[TICKET-42](tickets:ticket:${U3})`)
    expect(result).toEqual([{ type: "entity", app: "tickets", entityType: "ticket", id: U3 }])
  })

  it("parses multiple mixed mentions", () => {
    const result = parseMentions(
      `Hey @[Alice](user:${U1}) check @[TICKET-42](tickets:ticket:${U2}) in @[Eng](thread:${U3})`,
    )
    expect(result.length).toBe(3)
  })

  it("returns empty array for no mentions", () => {
    expect(parseMentions("No mentions here")).toEqual([])
  })

  it("ignores malformed mention with empty label @[](user:)", () => {
    // Regex requires one or more non-] chars in label — empty label won't match
    expect(parseMentions("@[](user:)")).toEqual([])
  })

  it("ignores malformed mention with no colon separator @[Alice](invalid)", () => {
    // ref = "invalid", no ":" → only 1 part → skipped
    expect(parseMentions("@[Alice](invalid)")).toEqual([])
  })

  it("skips mention with empty id @[Alice](user:)", () => {
    // ref = "user:", splits to ["user",""] → empty id is filtered out
    const result = parseMentions("@[Alice](user:)")
    expect(result).toEqual([])
  })

  it("ignores malformed mention with empty label and ref @[]()", () => {
    // Empty label fails regex [^\]]+ requirement
    expect(parseMentions("@[]()")).toEqual([])
  })
})

describe("thread initial message agent attribution", () => {
  // P4b carry-in H1: an agent-opened thread's FIRST message is an agent row
  // like any other and names the speaking agent (A8).
  const ORG = "00000000-0000-0000-0000-0000000000b1"
  const USER = "00000000-0000-0000-0000-0000000000b2"
  const USER2 = "00000000-0000-0000-0000-0000000000b3"
  const AGENT = "00000000-0000-0000-0000-0000000000b4"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Attr Org', 'attr-thread-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'attr-a@test.com', 'Alice') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER2}, ${ORG}, 'attr-b@test.com', 'Bob') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
              VALUES (${AGENT}, ${ORG}, 'personal', '@alice', 'Alice agent', ${USER})
              ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("createThread records the acting agent on an agent-authored initial message", async () => {
    const result = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
      title: "Agent opened",
      forceCreate: true,
      initialMessage: {
        content: "Opening on your behalf",
        authorType: "agent",
        agentAuthorLabel: "Alice's agent",
        agentId: AGENT,
        requiredScopes: [],
      },
    })
    const [row] = await sql`
      SELECT author_agent_id, author_type FROM kernel.messages WHERE thread_id = ${result.id}`
    expect(row.author_type).toBe("agent")
    expect(row.author_agent_id).toBe(AGENT)
  })
})

describe("agent seats on the thread read side", () => {
  // P4b carry-in H2: the read side names the participant kind, and every
  // count that means "how many PEOPLE are in this room" stops counting agent
  // seats as people.
  const ORG = "00000000-0000-0000-0000-0000000000c1"
  const USER = "00000000-0000-0000-0000-0000000000c2"
  const USER2 = "00000000-0000-0000-0000-0000000000c3"
  const AGENT = "00000000-0000-0000-0000-0000000000c4"

  async function seatAgent(threadId: string) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id)
              VALUES (${threadId}, ${ORG}, 'agent', ${AGENT})`
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Seat Org', 'seat-thread-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'seat-a@test.com', 'Alice') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER2}, ${ORG}, 'seat-b@test.com', 'Bob') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
              VALUES (${AGENT}, ${ORG}, 'role', '@support', 'Support') ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("getThread names each participant's kind and the agent behind an agent seat", async () => {
    const created = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
      title: "Seated",
      forceCreate: true,
    })
    await seatAgent(created.id)

    const thread = await getThread(rlsDb, { orgId: ORG, userId: USER, threadId: created.id })
    const seat = thread!.participants.find((p: any) => p.participantType === "agent")
    expect(seat).toBeDefined()
    expect(seat!.agentId).toBe(AGENT)
    expect(seat!.name).toBe("Support")
    const human = thread!.participants.find((p: any) => p.id === USER)
    expect(human!.participantType).toBe("user")
    expect(human!.agentId).toBeNull()
  })

  it("listThreads names each participant's kind and the agent behind an agent seat", async () => {
    const created = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
      title: "Seated for the list",
      forceCreate: true,
    })
    await seatAgent(created.id)

    const { threads: rows } = await listThreads(rlsDb, {
      orgId: ORG,
      userId: USER,
      limit: 50,
    })
    const row = rows.find((t: any) => t.id === created.id)
    const seat = row!.participants.find((p: any) => p.participantType === "agent")
    expect(seat!.agentId).toBe(AGENT)
    expect(row!.participants.find((p: any) => p.id === USER)!.participantType).toBe("user")
  })

  // D23 (2026-10-12), replacing P4b H2's "a DM with an agent seated in it is
  // still the DM": the DM between two people is the room with exactly those
  // two seats. A room that also seats an agent is a group conversation, listed
  // under its own row ("Bob, Support", dmCounterpartKey) and read by that
  // agent, so "message Bob" must not land in it.
  it("D23: the DM dedup never hands back a room that also seats an agent; a fresh 1:1 is created", async () => {
    const first = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
    })
    await seatAgent(first.id)

    const second = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
    })
    expect(second.id).not.toBe(first.id)
    expect(second.deduplicated).toBe(false)
    const seats =
      await sql`SELECT participant_type FROM kernel.thread_participants WHERE thread_id = ${second.id}`
    expect(seats.map((s: any) => s.participant_type).sort()).toEqual(["user", "user"])

    // ...and that fresh 1:1 is the DM from then on.
    const third = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
    })
    expect(third.id).toBe(second.id)
    expect(third.deduplicated).toBe(true)
  })

  it("D23: a promoted agent chat (a person added to someone's chat with an agent) is not the DM between the two people", async () => {
    // The demo row 24740130: Bob's agent_chat with an agent, Alice added to it
    // (participant.ts promotes it to an untitled `thread`).
    const [chat] = await sql`INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, 'seat-promoted-chat', 'thread', ${USER2}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, user_id) VALUES (${chat.id}, ${ORG}, ${USER2})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, user_id) VALUES (${chat.id}, ${ORG}, ${USER})`
    await seatAgent(chat.id)

    const dm = await createThread(rlsDb, { orgId: ORG, userId: USER, participantIds: [USER2] })
    expect(dm.id).not.toBe(chat.id)
    const agentSeats = await sql`SELECT 1 FROM kernel.thread_participants
      WHERE thread_id = ${dm.id} AND participant_type = 'agent'`
    expect(agentSeats.length).toBe(0)
  })

  it("D23: a GUEST agent seat (a hidden-reply turn in progress) does not make the DM a group", async () => {
    const [room] = await sql`INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, 'seat-guest-dm', 'thread', ${USER}) RETURNING id`
    const U3 = "00000000-0000-0000-0000-0000000000c5"
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${U3}, ${ORG}, 'seat-c@test.com', 'Carol') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, user_id) VALUES (${room.id}, ${ORG}, ${USER})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, user_id) VALUES (${room.id}, ${ORG}, ${U3})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id, role)
              VALUES (${room.id}, ${ORG}, 'agent', ${AGENT}, 'guest')`

    const dm = await createThread(rlsDb, { orgId: ORG, userId: USER, participantIds: [U3] })
    expect(dm.id).toBe(room.id)
    expect(dm.deduplicated).toBe(true)
  })

  // D23a (2026-10-12, refines D23): when a PERSON @mentions an agent in their
  // DM, the agent keeps a member seat. That seat must not take the room out
  // of the DM lookup: "Message Dan" has to keep opening the same DM. Only an
  // agent added on purpose (the tests above) makes it a group.
  it("D23a: an agent seated by an @mention keeps the DM; the seat says how it came", async () => {
    const U4 = "00000000-0000-0000-0000-0000000000c6"
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${U4}, ${ORG}, 'seat-d@test.com', 'Dan') ON CONFLICT (id) DO NOTHING`
    const room = await createThread(rlsDb, { orgId: ORG, userId: USER, participantIds: [U4] })
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id, seat_origin)
              VALUES (${room.id}, ${ORG}, 'agent', ${AGENT}, 'mention')`

    const again = await createThread(rlsDb, { orgId: ORG, userId: USER, participantIds: [U4] })
    expect(again.id).toBe(room.id)
    expect(again.deduplicated).toBe(true)

    // The read side carries the seat's origin, so the web applies the same rule.
    const thread = await getThread(rlsDb, { orgId: ORG, userId: USER, threadId: room.id })
    const seat = thread!.participants.find((p: any) => p.participantType === "agent") as any
    expect(seat.seatOrigin).toBe("mention")
    const { threads: rows } = await listThreads(rlsDb, { orgId: ORG, userId: USER, limit: 100 })
    const listed = rows.find((t: any) => t.id === room.id)!
    const listedSeat = listed.participants.find((p: any) => p.participantType === "agent") as any
    expect(listedSeat.seatOrigin).toBe("mention")
    expect(listedSeat.role).toBe("member")
  })

  it("D23a: 0137/0138 backfill a mention-summoned seat in a people DM, never a seat no earlier mention summoned (an added agent, a promoted chat)", async () => {
    const U5 = "00000000-0000-0000-0000-0000000000c7"
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${U5}, ${ORG}, 'seat-e@test.com', 'Eve') ON CONFLICT (id) DO NOTHING`
    const seed = async (handle: string, opts: { mentionFirst: boolean }) => {
      const [room] = await sql`INSERT INTO kernel.threads (org_id, handle, type, created_by)
        VALUES (${ORG}, ${handle}, 'thread', ${USER}) RETURNING id`
      await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, user_id) VALUES (${room.id}, ${ORG}, ${USER})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, user_id) VALUES (${room.id}, ${ORG}, ${U5})`
      const t0 = new Date(Date.now() - 3_600_000)
      if (opts.mentionFirst) {
        // As production writes it: the message keeps microseconds, the seat
        // anchored at it carries the JS Date's milliseconds (demo 0ea6134d:
        // 19:52:46.753696 vs 19:52:46.753).
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, mentions, required_scopes, created_at)
          VALUES (${room.id}, ${ORG}, ${USER}, 'user', '@Support hi', ${JSON.stringify([{ type: "agent", id: AGENT }])}::jsonb, '{}'::text[], ${t0.toISOString()}::timestamptz + interval '696 microseconds')`
      }
      // A legacy seat: no origin recorded, as every seat before 0137.
      await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id, created_at)
                VALUES (${room.id}, ${ORG}, 'agent', ${AGENT}, ${t0.toISOString()})`
      if (!opts.mentionFirst) {
        // Mentioned only AFTER it was added on purpose.
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, mentions, required_scopes, created_at)
          VALUES (${room.id}, ${ORG}, ${USER}, 'user', '@Support later', ${JSON.stringify([{ type: "agent", id: AGENT }])}::jsonb, '{}'::text[], ${new Date(t0.getTime() + 60_000).toISOString()})`
      }
      return room.id as string
    }
    const mentioned = await seed(`seat-backfill-m-${crypto.randomUUID().slice(0, 6)}`, {
      mentionFirst: true,
    })
    const added = await seed(`seat-backfill-a-${crypto.randomUUID().slice(0, 6)}`, {
      mentionFirst: false,
    })
    // Replayed as the migrator would run them: DDL needs the table owner, which
    // the app role behind `sql` is not. The runner points DATABASE_URL_SUPERUSER
    // at this run's database.
    const ownerUrl = process.env.DATABASE_URL_SUPERUSER ?? process.env.MIGRATION_DATABASE_URL
    if (!ownerUrl) throw new Error("DATABASE_URL_SUPERUSER is not set: run through the test runner")
    const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} })
    try {
      for (const file of [
        "0137_thread_participant_seat_origin.sql",
        "0138_mention_seat_backfill_ms.sql",
      ]) {
        const migration = await Bun.file(
          new URL(`../../db/migrations/${file}`, import.meta.url),
        ).text()
        for (const stmt of migration.split("--> statement-breakpoint")) await owner.unsafe(stmt)
      }
    } finally {
      await owner.end()
    }

    const origin = async (threadId: string) =>
      (
        await sql`SELECT seat_origin FROM kernel.thread_participants
          WHERE thread_id = ${threadId} AND participant_type = 'agent'`
      )[0]?.seat_origin ?? null
    expect(await origin(mentioned)).toBe("mention")
    expect(await origin(added)).toBeNull()
    const dm = await createThread(rlsDb, { orgId: ORG, userId: USER, participantIds: [U5] })
    expect(dm.id).toBe(mentioned)
  })

  it("the titled-thread duplicate guard counts humans, so an agent seat never hides the duplicate", async () => {
    const first = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
      title: "Titled once",
      forceCreate: true,
    })
    await seatAgent(first.id)

    await expect(
      createThread(rlsDb, {
        orgId: ORG,
        userId: USER,
        participantIds: [USER2],
        title: "Titled twice",
      }),
    ).rejects.toBeInstanceOf(DuplicateThreadError)
  })

  it("the thread read payload carries discoverable on every row", async () => {
    // The sidebar groups Channels against Direct Messages on this field alone.
    const created = await createThread(rlsDb, {
      orgId: ORG,
      userId: USER,
      participantIds: [USER2],
      title: "A channel",
      forceCreate: true,
    })
    await sql`UPDATE kernel.threads SET discoverable = true WHERE id = ${created.id}`

    const thread = await getThread(rlsDb, { orgId: ORG, userId: USER, threadId: created.id })
    expect(thread!.discoverable).toBe(true)
    const { threads: rows } = await listThreads(rlsDb, { orgId: ORG, userId: USER, limit: 50 })
    expect(rows.find((t: any) => t.id === created.id)!.discoverable).toBe(true)
    expect(rows.find((t: any) => t.title === "Seated")!.discoverable).toBe(false)
  })

  it("listThreads hides a solo entity thread whose only other seat is an agent", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, created_from)
      VALUES (${ORG}, 'seat-entity', 'From a ticket', ${USER},
              '{"app":"tickets","entityType":"ticket","entityId":"t1"}'::jsonb)
      RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row!.id}, ${USER}, ${ORG})`
    await seatAgent(row!.id)

    const { threads: rows } = await listThreads(rlsDb, { orgId: ORG, userId: USER, limit: 50 })
    expect(rows.find((t: any) => t.id === row!.id)).toBeUndefined()
  })
  it("listDiscoverableChannels returns metadata for a channel the user has not joined", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG}, 'seat-open-channel', 'Support', ${USER2}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row!.id}, ${USER2}, ${ORG})`
    await seatAgent(row!.id)
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
              VALUES (${row!.id}, ${ORG}, ${USER2}, 'user', 'members only', '{}')`

    const rows = await listDiscoverableChannels(rlsDb, { orgId: ORG, userId: USER })
    const channel = rows.find((c) => c.id === row!.id)
    expect(channel).toBeDefined()
    expect(channel!.handle).toBe("seat-open-channel")
    expect(channel!.title).toBe("Support")
    expect(channel!.participantCount).toBe(1)
    expect(channel!.agentCount).toBe(1)
    // Metadata only: a non-member is never handed message content.
    expect(Object.keys(channel!)).not.toContain("lastMessage")
    expect(JSON.stringify(channel)).not.toContain("members only")
  })

  it("listDiscoverableChannels excludes a non-discoverable thread the user is not in", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'seat-private', 'Private', ${USER2}) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row!.id}, ${USER2}, ${ORG})`

    const rows = await listDiscoverableChannels(rlsDb, { orgId: ORG, userId: USER })
    expect(rows.find((c) => c.id === row!.id)).toBeUndefined()
  })

  it("listDiscoverableChannels excludes a channel the user has already joined", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${ORG}, 'seat-joined-channel', 'Joined', ${USER}, true) RETURNING id`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
              VALUES (${row!.id}, ${USER}, ${ORG})`

    const rows = await listDiscoverableChannels(rlsDb, { orgId: ORG, userId: USER })
    expect(rows.find((c) => c.id === row!.id)).toBeUndefined()
  })
})
