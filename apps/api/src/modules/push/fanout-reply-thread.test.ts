// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A5, A6: a reply the channel does not show pushes to the reply thread's
// FOLLOWERS only, never to the channel's members, in a titled channel and in a
// DM alike, and the tap carries the root so the client opens the reply panel.
// A reply also sent to the channel pushes exactly as a channel message does.
// Real rows, the real router with its default settings; only the wire is a
// double.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { groupForKind } from "@liaison/shared"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import {
  type DesktopNotifyPayload,
  registerDesktopEmitter,
} from "~/modules/notifications/desktop-hook"
import { isAttentionLiveGroup } from "~/modules/notifications/dispatch"
import { handlePushFanout, PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"
import { resolveThreadAnchorForReaders } from "~/modules/threads/thread-anchor"

const ORG = crypto.randomUUID()
const ALICE = crypto.randomUUID()
const BOB = crypto.randomUUID()
const CAROL = crypto.randomUUID()
const ROOT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let channel = ""
let trio = ""

interface Sent {
  token: PushTokenRow
  payload: PushPayload
}

function spy() {
  const calls: Sent[] = []
  return {
    calls,
    send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
      calls.push({ token, payload })
      return { kind: "sent" }
    },
  }
}

function replyEvent(threadId: string, data: Record<string, unknown>): AppEvent {
  const id = crypto.randomUUID()
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: id,
    orgId: ORG,
    actorId: BOB,
    actorType: "user",
    data: {
      id,
      threadId,
      authorId: BOB,
      authorName: "Bob",
      authorType: "user",
      content: "a reply in the thread",
      participantIds: [ALICE, BOB, CAROL],
      mentions: null,
      requiredScopes: [],
      disclosureList: null,
      replyRootId: ROOT,
      alsoInChannel: false,
      followerIds: [ALICE, BOB],
      ...data,
    },
  } as AppEvent
}

async function fan(event: AppEvent) {
  const wire = spy()
  await handlePushFanout({ event, eventId: crypto.randomUUID() } as never, {
    send: wire.send,
    badgeCount: async () => 1,
  })
  return wire.calls
}

const recipients = (calls: Sent[]) =>
  [...new Set(calls.map((c) => c.token.token.replace("token-", "")))].sort()

describe("push for a reply thread (A5)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Fanout RT', ${`frt-${tag}`})`
    for (const [id, name] of [
      [ALICE, "Alice"],
      [BOB, "Bob"],
      [CAROL, "Carol"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`frt-${name}-${tag}@t.com`}, ${name}, 'x')`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${id}, 'ios', ${`token-${id}`})`
    }
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, ${`frt-channel-${tag}`}, 'general', ${ALICE}) RETURNING id`
    channel = c.id
    // An untitled room of three: a DM, where every channel message pushes.
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${ORG}, ${`frt-trio-${tag}`}, ${ALICE}) RETURNING id`
    trio = t.id
    for (const threadId of [channel, trio]) {
      for (const userId of [ALICE, BOB, CAROL]) {
        await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
          VALUES (${threadId}, ${userId}, ${ORG})`
      }
    }
  })

  beforeEach(() => {
    PushFanoutTestAccess.resetDedupe()
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("in a channel, only the followers are pushed, and the tap names the root", async () => {
    const calls = await fan(replyEvent(channel, {}))
    expect(recipients(calls)).toEqual([ALICE])
    expect(calls[0].payload.replyRootId).toBe(ROOT)
    expect(calls[0].payload.threadId).toBe(channel)
  })

  it("in a DM, the members who do not follow are not pushed either", async () => {
    const calls = await fan(replyEvent(trio, {}))
    expect(recipients(calls)).toEqual([ALICE])
  })

  it("a reply also sent to the channel pushes like a channel message", async () => {
    const calls = await fan(replyEvent(trio, { alsoInChannel: true }))
    expect(recipients(calls)).toEqual([ALICE, CAROL].sort())
  })

  it("thread_followup is a chat kind: its push comes from the message, never from its attention row", () => {
    expect(isAttentionLiveGroup(groupForKind("thread_followup"))).toBe(false)
  })
})

// A message in an ENTITY's thread (a thread created from an entity: a task's
// comments, a contact's discussion) is pushed as news of that entity: the
// title names it and the tap opens it, on the message. A plain conversation
// is pushed as before. The entity's words are read under EACH recipient's own
// visibility: a member who may not see the entity (seated by a mention, or in
// a thread whose anchor someone else chose) is told only that a thread has a
// new message. Real rows, the real router and the real policies; only the
// wire and the desktop emitter are doubles.
describe("entity threads", () => {
  const ORG = crypto.randomUUID()
  const ALICE = crypto.randomUUID()
  const BOB = crypto.randomUUID()
  const CAROL = crypto.randomUUID()
  const CONTACT = crypto.randomUUID()
  const tag = crypto.randomUUID().slice(0, 8)

  let anchored = ""
  let forged = ""
  let plain = ""
  const desktop: Array<{ userId: string; payload: DesktopNotifyPayload }> = []
  const anchorCalls: string[][] = []

  function mentionEvent(threadId: string, author: string, mentioned: string[]): AppEvent {
    const id = crypto.randomUUID()
    return {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: id,
      orgId: ORG,
      actorId: author,
      actorType: "user",
      data: {
        id,
        threadId,
        authorId: author,
        authorName: author === BOB ? "Bob" : "Carol",
        authorType: "user",
        content: "can you call them back?",
        participantIds: [ALICE, BOB, CAROL],
        mentions: mentioned.map((uid) => ({ type: "user", id: uid })),
        requiredScopes: [],
        disclosureList: null,
      },
    } as AppEvent
  }

  async function fan(event: AppEvent): Promise<Array<{ userId: string; payload: PushPayload }>> {
    const calls: Array<{ userId: string; payload: PushPayload }> = []
    await handlePushFanout({ event, eventId: crypto.randomUUID() } as never, {
      send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
        calls.push({ userId: token.token.replace(/^token-/, ""), payload })
        return { kind: "sent" }
      },
      badgeCount: async () => 1,
      resolveThreadAnchors: async (orgId, ref, userIds) => {
        anchorCalls.push([...userIds].sort())
        return resolveThreadAnchorForReaders(orgId, ref, userIds)
      },
    })
    return calls
  }

  describe("push for a message in an entity's thread", () => {
    beforeAll(async () => {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Fanout anchor', ${`fan-${tag}`})`
      for (const [id, name] of [
        [ALICE, "Alice"],
        [BOB, "Bob"],
        [CAROL, "Carol"],
      ] as const) {
        await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
          VALUES (${id}, ${ORG}, ${`fan-${name}-${tag}@t.com`}, ${name}, 'x')`
        await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
          VALUES (${ORG}, ${id}, 'ios', ${`token-${id}`})`
      }
      // ALICE's own contact, shared with nobody: only she may see its name.
      await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, owner_user_id, org_access)
        VALUES (${CONTACT}, ${ORG}, ${`fan-contact-${tag}`}, 'Northwind Studio', ${ALICE}, 'none')`
      const createdFrom = JSON.stringify({
        app: "kernel",
        entityType: "contact",
        entityId: CONTACT,
      })
      const [a] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, hidden_from_list, created_from, created_by)
        VALUES (${ORG}, ${`fan-anchored-${tag}`}, true, ${createdFrom}::jsonb, ${ALICE}) RETURNING id`
      anchored = a.id
      // A thread CAROL anchored on an entity she may not see (a forged anchor),
      // titled with what she wants the lock screen to say.
      const [f] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, title, hidden_from_list, created_from, created_by)
        VALUES (${ORG}, ${`fan-forged-${tag}`}, 'Northwind Studio', true, ${createdFrom}::jsonb, ${CAROL})
        RETURNING id`
      forged = f.id
      const [p] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, title, created_by)
        VALUES (${ORG}, ${`fan-plain-${tag}`}, 'general', ${ALICE}) RETURNING id`
      plain = p.id
      for (const threadId of [anchored, forged, plain]) {
        for (const userId of [ALICE, BOB, CAROL]) {
          await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
            VALUES (${threadId}, ${userId}, ${ORG})`
        }
      }
      registerDesktopEmitter(async (decision, payload) => {
        desktop.push({ userId: decision.userId, payload })
      })
    })

    beforeEach(() => {
      PushFanoutTestAccess.resetDedupe()
      desktop.length = 0
      anchorCalls.length = 0
    })

    afterAll(async () => {
      registerDesktopEmitter(null)
      await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    })

    it("names the entity and opens it on the message, for a reader who may see it", async () => {
      const event = mentionEvent(anchored, BOB, [ALICE])
      const calls = await fan(event)
      const payload = calls.find((c) => c.userId === ALICE)?.payload as PushPayload
      expect(payload).toBeDefined()
      expect(payload.title).toBe("Contact: Northwind Studio")
      expect(payload.body).toBe("Bob: can you call them back?")
      expect(payload.deepLink).toBe(`liaison://attention/kernel/contact/${CONTACT}`)
      expect(payload.route).toBe(`attention/kernel/contact/${CONTACT}`)
      expect(payload.messageId).toBe(event.entityId)
      expect(payload.threadId).toBe(anchored)
      for (const shown of desktop.filter((d) => d.userId === ALICE)) {
        expect(shown.payload.title).toBe("Contact: Northwind Studio")
        expect(shown.payload.route).toBe(
          `attention/kernel/contact/${CONTACT}?thread=${anchored}&message=${event.entityId}`,
        )
      }
    })

    it("a member mentioned in who may not see the entity gets no name of it", async () => {
      const event = mentionEvent(anchored, BOB, [ALICE, CAROL])
      const calls = await fan(event)
      const carol = calls.find((c) => c.userId === CAROL)?.payload
      expect(carol).toBeDefined()
      expect(carol?.title).toBe("New message in a thread")
      expect(JSON.stringify(carol)).not.toContain("Northwind")
      expect(carol?.deepLink).toBe(`liaison://thread/${anchored}`)
      expect(carol?.route).toBeUndefined()
      expect(carol?.messageId).toBeUndefined()
      for (const shown of desktop.filter((d) => d.userId === CAROL)) {
        expect(shown.payload.title).toBe("New message in a thread")
        expect(JSON.stringify(shown.payload)).not.toContain("Northwind")
        expect(shown.payload.route).toBe(`thread/${anchored}`)
      }
      // ALICE, who owns the contact, still gets its name in the same event.
      expect(calls.find((c) => c.userId === ALICE)?.payload.title).toBe("Contact: Northwind Studio")
      // One batched anchor read for the event, covering every live recipient.
      expect(anchorCalls).toEqual([[ALICE, CAROL].sort()])
    })

    it("a forged anchor names nothing to a recipient who may not see the entity", async () => {
      const calls = await fan(mentionEvent(forged, CAROL, [BOB]))
      const bob = calls.find((c) => c.userId === BOB)?.payload as PushPayload
      expect(bob).toBeDefined()
      expect(bob.title).toBe("New message in a thread")
      expect(JSON.stringify(bob)).not.toContain("Northwind")
      expect(bob.deepLink).toBe(`liaison://thread/${forged}`)
      for (const shown of desktop.filter((d) => d.userId === BOB)) {
        expect(JSON.stringify(shown.payload)).not.toContain("Northwind")
      }
    })

    it("a plain conversation is pushed as before", async () => {
      const calls = await fan(mentionEvent(plain, BOB, [ALICE]))
      const alice = calls.find((c) => c.userId === ALICE)?.payload as PushPayload
      expect(alice.title).toBe("general")
      expect(alice.deepLink).toBe(`liaison://thread/${plain}`)
      expect(alice.route).toBeUndefined()
      expect(alice.messageId).toBeUndefined()
      expect(anchorCalls).toEqual([])
    })
  })
})
