// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person reading a conversation is not buzzed on another device for it
// (Messenger, Slack, WhatsApp). The reported case: the owner had their personal
// agent's chat open and focused in the desktop app, had just sent a message,
// and the agent's answer still reached their phone. Real rows, the real router
// and the real presence registry in Redis; only the wire (`send`) is a double.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { type NotifyClientKind, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import { BurstTestAccess } from "~/modules/notifications/burst"
import { registerDesktopEmitter } from "~/modules/notifications/desktop-hook"
import { ThreadActivityTestAccess } from "~/modules/notifications/thread-activity"
import { handlePushFanout, PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"

const ORG = "00000000-0000-0000-0000-0000000009a0"
const OWNER = "00000000-0000-0000-0000-0000000009a1"
const AGENT = "00000000-0000-0000-0000-0000000009a2"

let dmId = ""
let otherId = ""

function spy() {
  const calls: Array<{ token: PushTokenRow; payload: PushPayload }> = []
  return {
    calls,
    send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
      calls.push({ token, payload })
      return { kind: "sent" }
    },
  }
}

let seq = 0
function messageEvent(
  threadId: string,
  authorType: "user" | "agent",
  extra: Record<string, unknown> = {},
): AppEvent {
  seq += 1
  const id = `00000000-0000-0000-0000-0000000099${String(seq).padStart(2, "0")}`
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: id,
    orgId: ORG,
    actorId: OWNER,
    actorType: authorType,
    timestamp: new Date().toISOString(),
    data: {
      id,
      threadId,
      // An agent-authored row keeps the requester as its author.
      authorId: OWNER,
      authorName: authorType === "agent" ? "Agent" : "Owner",
      authorType,
      content: authorType === "agent" ? "here is the answer" : "a question",
      participantIds: [OWNER],
      mentions: [],
      requiredScopes: [],
      disclosureList: null,
      // An agent row here is the answer that ends the owner's turn, unless a
      // case says otherwise (etiquette rule 1).
      ...(authorType === "agent" ? { endsTurn: true } : {}),
      ...extra,
    },
  } as AppEvent
}

async function fanout(event: AppEvent): Promise<number> {
  const s = spy()
  await handlePushFanout({ eventId: `evt-presence-${event.entityId}`, event }, { send: s.send })
  return s.calls.length
}

function fakeWs() {
  return { readyState: 1, send(_data: string) {}, close() {} }
}

const manager = new WebSocketManager(redis, undefined, { instanceId: "presence-test" })
const sockets: Array<ReturnType<typeof fakeWs>> = []

/** A connection of the owner, with what it reports on screen. */
async function client(
  kind: NotifyClientKind,
  viewing: { threadIds: string[]; focused: boolean } | undefined,
  lastActiveAt = Date.now(),
) {
  const ws = fakeWs()
  sockets.push(ws)
  manager.addConnection(OWNER, ws, ["*"], ORG)
  await manager.registerNotifyClient(ws, kind, lastActiveAt, viewing ? { viewing } : {})
  return ws
}

describe("push fanout, recipient already in the thread", () => {
  beforeAll(async () => {
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'PresenceOrg', 'presence-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${OWNER}, ${ORG}, 'presence-owner@t.com', 'owner', 'x') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', '@presence-agent', 'Agent', '["*"]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    // The personal agent chat: one human seat, one agent seat.
    const [d] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, 'presence-dm', 'agent_chat', ${OWNER}) RETURNING id`
    dmId = d.id
    const [o] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, 'presence-other', 'agent_chat', ${OWNER}) RETURNING id`
    otherId = o.id
    for (const threadId of [dmId, otherId]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${OWNER}, ${ORG})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, participant_type, org_id)
        VALUES (${threadId}, ${AGENT}, 'agent', ${ORG})`
      await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
        VALUES (${OWNER}, ${threadId}, ${ORG})`
    }
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${OWNER}, 'ios', 'presence-token-owner')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  beforeEach(async () => {
    PushFanoutTestAccess.resetDedupe()
    // Not a burst (notifications/burst.ts): every case starts from none.
    await BurstTestAccess.resetOrg(ORG)
    registerDesktopEmitter(async () => {})
    await ThreadActivityTestAccess.clear(ORG, OWNER, dmId)
  })

  afterEach(async () => {
    for (const ws of sockets.splice(0)) manager.removeConnection(ws)
    // Let the presence cleanup land before the next case reads the registry.
    await new Promise((r) => setTimeout(r, 50))
    registerDesktopEmitter(null)
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
  })

  it("the agent's answer is not pushed while its chat is open in a focused desktop window", async () => {
    await client("desktop_app", { threadIds: [dmId], focused: true })
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(0)
    const [row] = await sql<{ reason: string }[]>`
      SELECT reason FROM kernel.notification_deliveries
       WHERE org_id = ${ORG} AND channel = 'push' ORDER BY attempted_at DESC LIMIT 1`
    expect(row?.reason).toBe("active_in_thread")
  })

  it("it is pushed once the window loses focus, or shows another thread", async () => {
    const ws = await client("desktop_app", { threadIds: [dmId], focused: false })
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(1)
    await manager.touchNotifyPresence(ws, Date.now(), {
      viewing: { threadIds: [otherId], focused: true },
    })
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(1)
  })

  it("the phone in the foreground on that thread suppresses too", async () => {
    await client("mobile_app", { threadIds: [dmId], focused: true })
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(0)
  })

  // Etiquette rule 1 (amended): the agent's finished answer is ONE
  // notification to the person who asked, held back only while that very chat
  // is on screen. Having asked a moment ago and moved on to another
  // conversation is not looking at it.
  it("the finished answer reaches the person who asked and moved on to another conversation", async () => {
    await client("desktop_app", { threadIds: [otherId], focused: true })
    await fanout(messageEvent(dmId, "user"))
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(1)
  })

  it("an agent row that does not end its turn interrupts nobody who asked for it", async () => {
    // Nobody is looking: a progress line, a question to another agent, a post
    // it makes on the way still lands unread in the chat, and pushes nothing.
    expect(await fanout(messageEvent(dmId, "agent", { endsTurn: false }))).toBe(0)
    // Control: the row that ends the turn does push.
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(1)
  })

  // A turn that ends in a refusal or a failure ends like a finished answer:
  // the person who started it is told once, unless they are looking at it.
  it("a system row that ends the person's turn (a refusal, a failed resume) notifies them like an answer", async () => {
    const ending = () =>
      messageEvent(dmId, "user", {
        authorType: "system",
        content: "This workspace is out of agent usage.",
        metadata: { turnRefusal: true },
        endsTurn: true,
      })
    expect(await fanout(ending())).toBe(1)
    await client("desktop_app", { threadIds: [dmId], focused: true })
    expect(await fanout(ending())).toBe(0)
  })

  it("a system line in the chat interrupts nobody", async () => {
    expect(
      await fanout(
        messageEvent(dmId, "user", {
          authorType: "system",
          content: "Routine Weekly digest is running.",
          metadata: { type: "routine-run" },
        }),
      ),
    ).toBe(0)
  })

  it("having just posted from a phone that is now locked still pushes the answer", async () => {
    await client("mobile_app", { threadIds: [], focused: false })
    await fanout(messageEvent(dmId, "user"))
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(1)
  })

  // A reply that lives only in its reply thread is on screen when that reply
  // thread is, not when its channel is.
  it("a reply-thread-only message is held back by its open reply pane, not by the channel", async () => {
    const root = crypto.randomUUID()
    const reply = () =>
      messageEvent(dmId, "agent", {
        replyRootId: root,
        alsoInChannel: false,
        followerIds: [OWNER],
      })
    const ws = await client("desktop_app", { threadIds: [dmId], focused: true })
    expect(await fanout(reply())).toBe(1)
    await manager.touchNotifyPresence(ws, Date.now(), {
      viewing: { threadIds: [dmId, root], focused: true },
    })
    expect(await fanout(reply())).toBe(0)
  })

  it("having just posted in the channel does not hold back a reply-thread-only message", async () => {
    const root = crypto.randomUUID()
    await client("desktop_app", { threadIds: [otherId], focused: true })
    await fanout(messageEvent(dmId, "user"))
    const reply = messageEvent(dmId, "agent", {
      replyRootId: root,
      alsoInChannel: false,
      followerIds: [OWNER],
    })
    expect(await fanout(reply)).toBe(1)
  })

  it("a malformed viewing report clears the last one (fail open)", async () => {
    const ws = await client("desktop_app", { threadIds: [dmId], focused: true })
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(0)
    await manager.touchNotifyPresence(ws, Date.now(), { viewing: { threadIds: "nope" } })
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(1)
    // A heartbeat without the field keeps a valid report.
    await manager.touchNotifyPresence(ws, Date.now(), {
      viewing: { threadIds: [dmId], focused: true },
    })
    await manager.touchNotifyPresence(ws, Date.now())
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(0)
  })

  it("a client from before the viewing report never suppresses", async () => {
    await client("browser", undefined)
    expect(await fanout(messageEvent(dmId, "agent"))).toBe(1)
  })
})
