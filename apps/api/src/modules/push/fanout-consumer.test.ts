// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The push fanout, driven by synthetic durable events against REAL rows: real
// users, a real thread, real `push_tokens` rows and real grants. Only two
// things are doubles, and both are the outside world: the HTTP transport and,
// where a case is about the DECISION rather than the wire, `sendPush` itself.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { sinkCount } from "~/lib/effect-sink"
import { LoadHarnessTestAccess } from "~/lib/load-harness"
import { BurstTestAccess } from "~/modules/notifications/burst"
import { handlePushFanout, PushFanoutTestAccess } from "~/modules/push/fanout-consumer"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"

const ORG = "00000000-0000-0000-0000-0000000007d0"
const ALICE = "00000000-0000-0000-0000-0000000007d1"
const BOB = "00000000-0000-0000-0000-0000000007d2"
// In the org, with a registered device, and NOT in the thread.
const CAROL = "00000000-0000-0000-0000-0000000007d3"
const AGENT = "00000000-0000-0000-0000-0000000007da"
// The two extra humans that make the untitled-room fanout FIVE people, which
// is where the volume of this rule is visible rather than implied.
const DAVE = "00000000-0000-0000-0000-0000000007d4"
const ERIN = "00000000-0000-0000-0000-0000000007d5"
const CROWD = [ALICE, BOB, CAROL, DAVE, ERIN]

const SCOPE = "pennylane:payouts:read"

async function grantScope(userId: string): Promise<void> {
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${userId}, ${ORG}, ${SCOPE}) ON CONFLICT DO NOTHING`
}

async function revokeScope(userId: string): Promise<void> {
  await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${userId} AND scope = ${SCOPE}`
}

let threadId = ""
let dmThreadId = ""
let trioThreadId = ""
let agentChatId = ""
let titledAgentRoomId = ""
let crowdThreadId = ""
let routineThreadId = ""
let routineSoloThreadId = ""

interface SentCall {
  token: PushTokenRow
  payload: PushPayload
}

function spy(result: PushSendResult = { kind: "sent" }) {
  const calls: SentCall[] = []
  return {
    calls,
    send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
      calls.push({ token, payload })
      return result
    },
  }
}

function messageEvent(
  overrides: Partial<AppEvent> & { data?: Record<string, unknown> } = {},
): AppEvent {
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: "00000000-0000-0000-0000-0000000007e0",
    orgId: ORG,
    actorId: ALICE,
    actorType: "user",
    ...overrides,
    data: {
      id: "00000000-0000-0000-0000-0000000007e0",
      threadId,
      authorId: ALICE,
      authorName: "Alice",
      authorType: "user",
      content: "standup at ten",
      participantIds: [ALICE, BOB],
      mentions: [{ type: "user", id: BOB }],
      requiredScopes: [],
      disclosureList: null,
      ...(overrides.data ?? {}),
    },
  } as AppEvent
}

const APPROVE_SCOPE = "kernel:skills:approve"

function approvalEvent(overrides: Record<string, unknown> = {}): AppEvent {
  return {
    app: "kernel",
    entity: "approval_request",
    action: "create",
    entityId: "00000000-0000-0000-0000-0000000007f0",
    orgId: ORG,
    actorId: ALICE,
    actorType: "user",
    data: {
      id: "00000000-0000-0000-0000-0000000007f0",
      handle: "request-1",
      status: "pending",
      toolName: "kernel:update_skill",
      approveScope: APPROVE_SCOPE,
      summary: { title: "Update the refund skill" },
      threadId,
      originatingThreadId: threadId,
      requestedBy: { id: ALICE },
      requester: { kind: "user", id: ALICE, name: "Alice" },
      notifyUserIds: [ALICE, BOB],
      resourceOwnerId: null,
      ...overrides,
    },
  } as AppEvent
}

describe("push fanout consumer", () => {
  beforeAll(async () => {
    // A run killed mid-file leaves marks behind, and these event ids are
    // fixtures: start from none rather than from whatever the last run died
    // holding.
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'FanoutOrg', 'fanout-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${ALICE}, ${ORG}, 'fanout-alice@t.com', 'Alice', 'x') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${BOB}, ${ORG}, 'fanout-bob@t.com', 'Bob', 'x') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${CAROL}, ${ORG}, 'fanout-carol@t.com', 'Carol', 'x') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', '@fanout-agent', 'Fanout Agent', '["*"]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'fanout-thread', 'standup', ${ALICE}) RETURNING id`
    threadId = t.id
    for (const userId of [ALICE, BOB]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${userId}, ${ORG})`
      await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
        VALUES (${userId}, ${threadId}, ${ORG})`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${userId}, 'ios', ${`token-${userId}`})`
    }
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${CAROL}, 'ios', ${`token-${CAROL}`})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${threadId}, ${AGENT}, ${ORG}, 'agent')`

    // An untitled plain thread between two people: the shape createThread
    // dedupes as a DM (thread.ts, `isDmCandidate`).
    const [dm] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${ORG}, 'fanout-dm', ${ALICE}) RETURNING id`
    dmThreadId = dm.id
    for (const userId of [ALICE, BOB]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${dmThreadId}, ${userId}, ${ORG})`
    }

    // An UNTITLED plain thread between THREE people. `isDmCandidate` puts no
    // bound on the party count, so this room is the same shape as the two
    // person one and every message in it is addressed to everybody in it.
    const [trio] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${ORG}, 'fanout-trio', ${ALICE}) RETURNING id`
    trioThreadId = trio.id
    for (const userId of [ALICE, BOB, CAROL]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${trioThreadId}, ${userId}, ${ORG})`
    }

    // AN UNTITLED ROOM WITH FIVE PEOPLE IN IT. The rule puts no bound on the
    // party count, so a message here buzzes every other human in the room: the
    // volume is pinned as a number rather than left to be discovered on a
    // handset.
    for (const userId of [DAVE, ERIN]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${userId}, ${ORG}, ${`fanout-${userId}@t.com`}, 'Extra', 'x')
        ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${userId}, 'ios', ${`token-${userId}`})`
    }
    const [crowd] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${ORG}, 'fanout-crowd', ${ALICE}) RETURNING id`
    crowdThreadId = crowd.id
    for (const userId of CROWD) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${crowdThreadId}, ${userId}, ${ORG})`
    }

    // A 1:1 room with an AGENT seat.
    const [chat] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${ORG}, 'fanout-agent-chat', 'agent_chat', ${ALICE}) RETURNING id`
    agentChatId = chat.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${agentChatId}, ${ALICE}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${agentChatId}, ${AGENT}, ${ORG}, 'agent')`

    // A TITLED room whose only other seat is an agent (P6d-FX7, SK-3). The
    // sidebar names it by the agent and draws it under Direct messages, so the
    // push layer has to read it the same way: reading the title as a channel
    // meant the agent's replies reached a handset only when they carried a
    // mention, in a row the user had been shown as a DM.
    const [titledAgentRoom] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'fanout-agent-room', 'Local session walk', ${ALICE}) RETURNING id`
    titledAgentRoomId = titledAgentRoom.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${titledAgentRoomId}, ${ALICE}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${titledAgentRoomId}, ${AGENT}, ${ORG}, 'agent')`

    // A shared routine's OUTPUT THREAD (routine-worker.ts `ensureOutputThread`):
    // titled with the routine's name, every member enrolled. It is a run log.
    const [routineThread] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${ORG}, 'routine-fanout-1', 'support-on-message', 'routine', ${ALICE})
      RETURNING id`
    routineThreadId = routineThread.id
    for (const userId of [ALICE, BOB]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${routineThreadId}, ${userId}, ${ORG})`
    }
    // A personal routine's log with an agent seat: the shape `isDirectRoom`
    // would read as a 1:1 with the agent.
    const [routineSolo] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${ORG}, 'routine-fanout-2', 'weekly review', 'routine', ${ALICE})
      RETURNING id`
    routineSoloThreadId = routineSolo.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${routineSoloThreadId}, ${ALICE}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${routineSoloThreadId}, ${AGENT}, ${ORG}, 'agent')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  // The consumer's in-process dedupe is a module-level set, shared by every
  // test file the runner loads into this process, and these event ids are
  // fixtures other files use too (`src/infra/events/event-subscribers.test.ts`
  // drives "evt-1" through every registered durable consumer, this one
  // included). Cleaning up after our own cases is not enough: the set has to be
  // empty before each one, or a file that ran earlier decides our first case
  // was already handled and no push is ever attempted.
  beforeEach(async () => {
    PushFanoutTestAccess.resetDedupe()
    // Every case pushes to the same few people within seconds: a burst
    // (notifications/burst.ts) is not what these cases are about.
    await BurstTestAccess.resetOrg(ORG)
  })

  afterEach(async () => {
    PushFanoutTestAccess.resetDedupe()
    // The durable "already handled" marks are keyed by event id, and these
    // event ids are fixtures: left behind, they would make every later run of
    // this file skip the fanout it is asserting on.
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
  })

  it("pushes once to the mentioned user's registered token", async () => {
    const sender = spy()
    await handlePushFanout({ eventId: "evt-1", event: messageEvent() }, { send: sender.send })
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0].token.token).toBe(`token-${BOB}`)
    expect(sender.calls[0].payload.type).toBe("mention")
    expect(sender.calls[0].payload.deepLink).toBe(`liaison://thread/${threadId}`)
  })

  it("does not send twice when the same event id is handled again", async () => {
    const sender = spy()
    const ctx = { eventId: "evt-2", event: messageEvent() }
    await handlePushFanout(ctx, { send: sender.send })
    await handlePushFanout(ctx, { send: sender.send })
    expect(sender.calls).toHaveLength(1)
  })

  it("gives up after the retry budget and dead-letters instead of throwing", async () => {
    const attempts: string[] = []
    const dead: string[] = []
    await handlePushFanout(
      { eventId: "evt-3", event: messageEvent() },
      {
        send: async (token) => {
          attempts.push(token.id)
          return { kind: "transient", detail: "503" }
        },
        retryBaseMs: 0,
        onDeadLetter: (info) => dead.push(info.reason),
      },
    )
    expect(attempts.length).toBeGreaterThan(1)
    expect(dead).toHaveLength(1)
  })

  it("an agent's failure line reaches the phone in the recipient's language, never the provider's text", async () => {
    // The runtime writes a failed turn's message in fixed English; rows written before the
    // failure code existed also carry the provider's raw text (third QA walk).
    await sql`INSERT INTO kernel.user_preferences (user_id, language) VALUES (${BOB}, 'fr')
      ON CONFLICT (user_id) DO UPDATE SET language = 'fr'`
    try {
      const sender = spy()
      await handlePushFanout(
        {
          eventId: "evt-agent-notice-1",
          event: messageEvent({
            data: {
              authorType: "agent",
              authorName: "Fanout Agent",
              content:
                "⚠️ I couldn't complete that response — the AI provider returned an error:\n\nYour project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.",
            },
          }),
        },
        { send: sender.send },
      )
      const toBob = sender.calls.filter((c) => c.token.token === `token-${BOB}`)
      expect(toBob).toHaveLength(1)
      const body = String(toBob[0].payload.body)
      expect(body).toContain("plafond de dépenses atteint")
      expect(body).not.toContain("ai.studio")
    } finally {
      await sql`DELETE FROM kernel.user_preferences WHERE user_id = ${BOB}`
    }
  })

  it("sends no push when the recipient lacks the message's requiredScopes", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-a18-1",
        event: messageEvent({ data: { requiredScopes: [SCOPE], content: "the payout cleared" } }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(0)
  })

  it("sends a redacted push when the recipient holds the scope", async () => {
    await grantScope(BOB)
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-a18-2",
        event: messageEvent({ data: { requiredScopes: [SCOPE], content: "the payout cleared" } }),
      },
      { send: sender.send },
    )
    await revokeScope(BOB)
    expect(sender.calls).toHaveLength(1)
    // Visible to them, and STILL redacted: a lock screen is not a read.
    expect("body" in sender.calls[0].payload).toBe(false)
    expect(JSON.stringify(sender.calls[0].payload)).not.toContain("payout")
  })

  it("sends to a recipient on the disclosure list without the scope", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-a18-3",
        event: messageEvent({
          data: { requiredScopes: [SCOPE], disclosureList: [BOB], content: "the payout cleared" },
        }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(1)
  })

  it("fails closed when the event carries no readable requiredScopes", async () => {
    const sender = spy()
    await handlePushFanout(
      { eventId: "evt-a18-4", event: messageEvent({ data: { requiredScopes: undefined } }) },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(0)
  })

  it("a grant issued after send time triggers no retroactive push for the earlier message", async () => {
    const sender = spy()
    const ctx = {
      eventId: "evt-a18-5",
      event: messageEvent({ data: { requiredScopes: [SCOPE], content: "the payout cleared" } }),
    }
    // Sent while Bob cannot see it: nobody is told.
    await handlePushFanout(ctx, { send: sender.send })
    expect(sender.calls).toHaveLength(0)

    // Bob is granted the scope afterwards. He will find the message on his
    // next fetch; the push for it has already NOT happened and must not
    // happen now.
    await grantScope(BOB)
    try {
      // The grant's own event reaches the consumer like any other.
      await handlePushFanout(
        {
          eventId: "evt-a18-6",
          event: {
            app: "kernel",
            entity: "user_scope_grant",
            action: "create",
            entityId: BOB,
            orgId: ORG,
            actorId: ALICE,
            actorType: "user",
            data: { userId: BOB, scope: SCOPE },
          } as AppEvent,
        },
        { send: sender.send },
      )
      expect(sender.calls).toHaveLength(0)

      // And the ORIGINAL event, replayed after the grant, is still not re-fanned:
      // the consumer has already handled that event id.
      await handlePushFanout(ctx, { send: sender.send })
      expect(sender.calls).toHaveLength(0)
    } finally {
      await revokeScope(BOB)
    }
  })

  // The in-process "handled" set dies with the process. An outbox row whose
  // OTHER consumers threw is still unprocessed, so a restarted API replays it,
  // and a replay evaluated against the grants of the moment is exactly the
  // retroactive push A18 forbids.
  it("a fresh consumer instance replaying an event after a grant sends nothing", async () => {
    const sender = spy()
    const ctx = {
      eventId: "evt-a18-restart",
      event: messageEvent({ data: { requiredScopes: [SCOPE], content: "the payout cleared" } }),
    }
    await handlePushFanout(ctx, { send: sender.send })
    expect(sender.calls).toHaveLength(0)

    await grantScope(BOB)
    try {
      // THE RESTART: every process-local memory of this event is gone.
      PushFanoutTestAccess.resetDedupe()
      await handlePushFanout(ctx, { send: sender.send })
      expect(sender.calls).toHaveLength(0)
    } finally {
      await revokeScope(BOB)
    }
  })

  // The event level mark is written AFTER the sends, so a process that dies
  // between the last send and that write replays the whole fanout. The mark
  // per RECIPIENT narrows that window to the one recipient who was in flight:
  // everybody already told stays told, and nobody is told twice.
  it("a crash after the first recipient does not push that recipient again on replay", async () => {
    const attempted: string[] = []
    const ctx = {
      eventId: "evt-recipient-crash",
      event: messageEvent({
        data: { threadId: trioThreadId, mentions: null, participantIds: [ALICE, BOB, CAROL] },
      }),
    }
    // THE CRASH: the first recipient is delivered and marked, and the process
    // dies inside the second one's delivery, so the event level mark is never
    // written and the outbox replays the row.
    await handlePushFanout(ctx, {
      concurrency: 1,
      retryBaseMs: 0,
      maxWaitMs: 0,
      send: async (token) => {
        attempted.push(token.token)
        return token.token === `token-${CAROL}`
          ? { kind: "transient", detail: "provider down" }
          : { kind: "sent" }
      },
      onDeadLetter: () => {
        throw new Error("the process died here")
      },
    })
    expect(attempted).toContain(`token-${BOB}`)

    // THE REPLAY, on a fresh process: no in-memory anything survives.
    PushFanoutTestAccess.resetDedupe()
    const second = spy()
    await handlePushFanout(ctx, { send: second.send, concurrency: 1 })
    expect(second.calls.map((c) => c.token.token)).toEqual([`token-${CAROL}`])
  })

  // S11 (P3 T16): the device's push is claimed in the effect ledger before the
  // send. A process that died after the send and before ANY mark (the
  // recipient's own included) replays the whole fanout; the device is not
  // pushed again. On the base the replay pushes Bob a second time.
  it("effect runs once when its consumer is run twice with the same event", async () => {
    const ctx = { eventId: `evt-once-${crypto.randomUUID()}`, event: messageEvent() }
    const first = spy()
    await handlePushFanout(ctx, { send: first.send, concurrency: 1 })
    expect(first.calls.map((c) => c.token.token)).toEqual([`token-${BOB}`])

    // THE CRASH before the marks: none survive, and neither does memory.
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE event_id LIKE ${`${ctx.eventId}%`}`
    PushFanoutTestAccess.resetDedupe()
    const second = spy()
    await handlePushFanout(ctx, { send: second.send, concurrency: 1 })
    expect(second.calls).toEqual([])
  })

  // A13: a load org's pushes are counted in the effect sink, never sent.
  it("a load org's push goes to the effect sink, not to the device", async () => {
    LoadHarnessTestAccess.setKey(crypto.randomBytes(32).toString("hex"))
    await sql`UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || '{"loadHarness": true}'::jsonb WHERE id = ${ORG}`
    try {
      const ctx = { eventId: `evt-sink-${crypto.randomUUID()}`, event: messageEvent() }
      const s = spy()
      await handlePushFanout(ctx, { send: s.send, concurrency: 1 })
      expect(s.calls).toEqual([])
      const [tok] = await sql`SELECT id FROM kernel.push_tokens WHERE org_id = ${ORG}
        AND token = ${`token-${BOB}`}`
      expect(await sinkCount(ORG, "push", `push:${ctx.eventId}:${tok?.id}`)).toBe(1)
      // A replay after a crash before the marks: the ledger holds the sunk
      // push, so the sink counts it once (the sink measures doubled effects).
      await sql`DELETE FROM kernel.durable_consumer_marks WHERE event_id LIKE ${`${ctx.eventId}%`}`
      PushFanoutTestAccess.resetDedupe()
      await handlePushFanout(ctx, { send: s.send, concurrency: 1 })
      expect(await sinkCount(ORG, "push", `push:${ctx.eventId}:${tok?.id}`)).toBe(1)
    } finally {
      await sql`UPDATE kernel.organizations SET settings = settings - 'loadHarness' WHERE id = ${ORG}`
      LoadHarnessTestAccess.setKey(undefined)
    }
  })

  // Push source per group (spec, P2-TD): the approvals group pushes from its
  // attention row (state-materializer.ts, first sighting of approval_pending),
  // so the approval's own event pushes nobody: one approval, one push.
  it("an approval-created event pushes nobody from the event, even to a decider", async () => {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${ALICE}, ${ORG}, ${APPROVE_SCOPE}) ON CONFLICT DO NOTHING`
    const sender = spy()
    try {
      await handlePushFanout(
        { eventId: "evt-appr-1", event: approvalEvent() },
        { send: sender.send },
      )
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants
        WHERE user_id = ${ALICE} AND scope = ${APPROVE_SCOPE}`
    }
    expect(sender.calls).toHaveLength(0)
  })

  it("an approval nobody can decide pushes to nobody", async () => {
    const sender = spy()
    await handlePushFanout({ eventId: "evt-appr-2", event: approvalEvent() }, { send: sender.send })
    expect(sender.calls).toHaveLength(0)
  })

  it("an owner-routed approval pushes nobody from the event either", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-appr-3",
        event: approvalEvent({ resourceOwnerId: BOB, notifyUserIds: [ALICE, BOB] }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(0)
  })

  it("never pushes the author for their own mention of somebody else", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-mention-1",
        event: messageEvent({
          data: {
            mentions: [
              { type: "user", id: BOB },
              { type: "user", id: ALICE },
            ],
          },
        }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0].token.token).toBe(`token-${BOB}`)
  })

  it("never pushes for an agent mention", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-mention-2",
        event: messageEvent({ data: { mentions: [{ type: "agent", id: AGENT }] } }),
      },
      { send: sender.send },
    )
    // The agent has no phone, and the member's ordinary channel post is
    // inbox news (replies push is off by default): no push at all.
    expect(sender.calls.map((c) => c.token.token)).toEqual([])
  })

  it("never pushes somebody who is not in the thread, however they were mentioned", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-mention-3",
        event: messageEvent({ data: { mentions: [{ type: "user", id: CAROL }] } }),
      },
      { send: sender.send },
    )
    // The mentioned outsider gets none (and the member's ordinary channel post
    // is inbox news by default).
    expect(sender.calls.map((c) => c.token.token)).toEqual([])
  })

  it("a DM message pushes to the other human participant with no mention needed", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-dm-1",
        event: messageEvent({
          data: { threadId: dmThreadId, mentions: null, participantIds: [ALICE, BOB] },
        }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0].token.token).toBe(`token-${BOB}`)
    expect(sender.calls[0].payload.type).toBe("dm")
  })

  // A demo seed writes its conversations through sendMessage, so each seeded
  // DM was a live message event and buzzed the phones of everyone in it on
  // every reseed (walk 2026-10-19, #17). A seed's message says so in its
  // metadata and pushes nobody.
  it("a seeded message pushes nobody", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-dm-seeded",
        event: messageEvent({
          data: {
            threadId: dmThreadId,
            mentions: null,
            participantIds: [ALICE, BOB],
            metadata: { seeded: true },
          },
        }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(0)
  })

  it("an agent participant is never a push target", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-dm-2",
        event: messageEvent({
          data: {
            threadId: agentChatId,
            mentions: null,
            authorType: "agent",
            authorName: "Fanout Agent",
            participantIds: [ALICE],
            // The answer that ends Alice's turn (etiquette rule 1).
            endsTurn: true,
          },
        }),
      },
      { send: sender.send },
    )
    // The human owner is told their agent answered; the agent seat is not a
    // device and never receives one.
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0].token.token).toBe(`token-${ALICE}`)
  })

  it("an untitled thread with three humans pushes the other humans", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-dm-trio",
        event: messageEvent({
          data: {
            threadId: trioThreadId,
            mentions: null,
            participantIds: [ALICE, BOB, CAROL],
          },
        }),
      },
      { send: sender.send },
    )
    const told = sender.calls.map((c) => c.token.token).sort()
    expect(told).toEqual([`token-${BOB}`, `token-${CAROL}`].sort())
    expect(sender.calls[0].payload.type).toBe("dm")
  })

  // THE VOLUME OF THE DM RULE, stated. `isDmShapedThread` puts no bound on how
  // many humans an untitled room holds, so one message in a room of five is
  // four notifications, and a room of fifty would be forty nine. That is the
  // deliberate consequence of sharing the predicate with createThread's dedupe
  // (dm-shape.ts), and this test is where a change to it becomes visible.
  it("an untitled room of five humans pushes the other four", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-dm-crowd",
        event: messageEvent({
          data: { threadId: crowdThreadId, mentions: null, participantIds: CROWD },
        }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(4)
    expect(sender.calls.map((c) => c.token.token).sort()).toEqual(
      [BOB, CAROL, DAVE, ERIN].map((id) => `token-${id}`).sort(),
    )
    expect(sender.calls.every((c) => c.payload.type === "dm")).toBe(true)
  })

  // P6d-FX7 (SK-3): the row the sidebar calls a DM and the fanout called a
  // channel. It notified on a mention only, so an agent answering in it was
  // silent on the one handset the room is for.
  it("a titled room whose only other seat is an agent pushes its human", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-titled-agent-room",
        event: messageEvent({
          data: {
            threadId: titledAgentRoomId,
            mentions: null,
            authorId: ALICE,
            authorType: "agent",
            participantIds: [ALICE],
            endsTurn: true,
          },
        }),
      },
      { send: sender.send },
    )
    expect(sender.calls.map((c) => c.token.token)).toEqual([`token-${ALICE}`])
    expect(sender.calls[0].payload.type).toBe("dm")
  })

  it("a routine run log pushes nobody, not even a member its run mentions", async () => {
    const sender = spy()
    await handlePushFanout(
      {
        eventId: "evt-routine-log-mention",
        event: messageEvent({
          data: {
            threadId: routineThreadId,
            authorType: "agent",
            participantIds: [ALICE, BOB],
            mentions: [{ type: "user", id: BOB }],
          },
        }),
      },
      { send: sender.send },
    )
    await handlePushFanout(
      {
        eventId: "evt-routine-log-solo",
        event: messageEvent({
          data: {
            threadId: routineSoloThreadId,
            authorType: "agent",
            participantIds: [ALICE],
            mentions: null,
          },
        }),
      },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(0)
  })

  // Etiquette rule 2: a channel post is inbox news for its members unless it
  // mentions them (or they opted that channel into every post).
  it("a titled group thread does not push its other members without a mention", async () => {
    const sender = spy()
    await handlePushFanout(
      { eventId: "evt-dm-3", event: messageEvent({ data: { mentions: null } }) },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(0)
  })

  // One phone that cannot be reached must not hold up the rest of the batch,
  // and the handler's own backoff is BOUNDED: it runs inside the outbox tick.
  it("delivers to the tokens concurrently and caps the wait one failing token imposes", async () => {
    const extra = await sql<{ id: string; token: string }[]>`
      INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${BOB}, 'ios', 'batch-1'),
             (${ORG}, ${BOB}, 'ios', 'batch-2'),
             (${ORG}, ${BOB}, 'ios', 'batch-3')
      RETURNING id, token`
    try {
      let inFlight = 0
      let maxInFlight = 0
      const dead: string[] = []
      const startedAt = Date.now()
      await handlePushFanout(
        { eventId: "evt-concurrency", event: messageEvent() },
        {
          send: async (token) => {
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 20))
            inFlight -= 1
            return token.token === "batch-1"
              ? { kind: "transient", detail: "503" }
              : { kind: "sent" }
          },
          retryBaseMs: 1_500,
          onDeadLetter: (info) => dead.push(info.tokenId),
        },
      )
      const elapsed = Date.now() - startedAt
      expect(maxInFlight).toBeGreaterThan(1)
      expect(dead).toHaveLength(1)
      expect(elapsed).toBeLessThan(2_000)
    } finally {
      await sql`DELETE FROM kernel.push_tokens WHERE id IN ${sql(extra.map((r) => r.id))}`
    }
  })

  it("deletes the push_tokens row when the provider says the device is gone", async () => {
    const [dead] = await sql<{ id: string }[]>`
      INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${BOB}, 'android', 'dead-token') RETURNING id`
    try {
      await handlePushFanout(
        { eventId: "evt-dead-1", event: messageEvent() },
        { send: async () => ({ kind: "invalid_token", detail: "Unregistered" }) },
      )
      const left = await sql<{ id: string }[]>`
        SELECT id FROM kernel.push_tokens WHERE user_id = ${BOB}`
      expect(left).toHaveLength(0)
    } finally {
      await sql`DELETE FROM kernel.push_tokens WHERE id = ${dead.id}`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${BOB}, 'ios', ${`token-${BOB}`}) ON CONFLICT DO NOTHING`
    }
  })

  // APNs: delete only when the token was not registered again after Apple's
  // timestamp, nor after this send started. A phone that re-registered (an
  // app update, a fresh sign-in) while the push was in flight keeps its row.
  it("keeps a row registered again after the provider's unregistered timestamp", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.push_tokens (org_id, user_id, platform, token, updated_at)
      VALUES (${ORG}, ${BOB}, 'android', 're-registered-token', now()) RETURNING id`
    try {
      await handlePushFanout(
        { eventId: "evt-dead-ts-1", event: messageEvent() },
        {
          send: async (token) => ({
            kind: "invalid_token",
            detail: "Unregistered",
            ...(token.id === row.id ? { unregisteredAt: new Date(Date.now() - 60 * 60_000) } : {}),
          }),
        },
      )
      const left = await sql<{ id: string }[]>`
        SELECT id FROM kernel.push_tokens WHERE id = ${row.id}`
      expect(left).toHaveLength(1)
    } finally {
      await sql`DELETE FROM kernel.push_tokens WHERE id = ${row.id}`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${BOB}, 'ios', ${`token-${BOB}`}) ON CONFLICT DO NOTHING`
    }
  })

  it("keeps a row the phone re-registered while the send was in flight", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.push_tokens (org_id, user_id, platform, token, updated_at)
      VALUES (${ORG}, ${BOB}, 'android', 'racing-token', now() - interval '1 day') RETURNING id`
    try {
      await handlePushFanout(
        { eventId: "evt-dead-race-1", event: messageEvent() },
        {
          send: async (token) => {
            if (token.id === row.id) {
              // The registration POST lands between the send and its verdict.
              await sql`UPDATE kernel.push_tokens SET updated_at = now() + interval '1 second'
                WHERE id = ${row.id}`
            }
            return { kind: "invalid_token", detail: "Unregistered" }
          },
        },
      )
      const left = await sql<{ id: string }[]>`
        SELECT id FROM kernel.push_tokens WHERE id = ${row.id}`
      expect(left).toHaveLength(1)
    } finally {
      await sql`DELETE FROM kernel.push_tokens WHERE id = ${row.id}`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${BOB}, 'ios', ${`token-${BOB}`}) ON CONFLICT DO NOTHING`
    }
  })

  it("deletes a row registered before the provider's unregistered timestamp", async () => {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.push_tokens (org_id, user_id, platform, token, updated_at)
      VALUES (${ORG}, ${BOB}, 'android', 'stale-token', now() - interval '2 days') RETURNING id`
    try {
      await handlePushFanout(
        { eventId: "evt-dead-ts-2", event: messageEvent() },
        {
          send: async () => ({
            kind: "invalid_token",
            detail: "Unregistered",
            unregisteredAt: new Date(Date.now() - 60 * 60_000),
          }),
        },
      )
      const left = await sql<{ id: string }[]>`
        SELECT id FROM kernel.push_tokens WHERE id = ${row.id}`
      expect(left).toHaveLength(0)
    } finally {
      await sql`DELETE FROM kernel.push_tokens WHERE id = ${row.id}`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${BOB}, 'ios', ${`token-${BOB}`}) ON CONFLICT DO NOTHING`
    }
  })

  it("hands the sender the token's recorded APNs environment", async () => {
    await sql`UPDATE kernel.push_tokens SET environment = 'sandbox' WHERE user_id = ${BOB}`
    try {
      const sender = spy()
      await handlePushFanout({ eventId: "evt-env-1", event: messageEvent() }, { send: sender.send })
      expect(sender.calls).toHaveLength(1)
      expect(sender.calls[0].token.environment).toBe("sandbox")
    } finally {
      await sql`UPDATE kernel.push_tokens SET environment = 'production' WHERE user_id = ${BOB}`
    }
  })

  // S11: the sender found the device on the OTHER APNs host. The row learns
  // the host that accepted it, and is not deleted.
  it("rewrites the row's environment when the other host accepted the push", async () => {
    try {
      await handlePushFanout(
        { eventId: "evt-env-2", event: messageEvent() },
        { send: async () => ({ kind: "sent", environment: "sandbox" }) },
      )
      const left = await sql<{ environment: string }[]>`
        SELECT environment FROM kernel.push_tokens WHERE user_id = ${BOB}`
      expect(left).toHaveLength(1)
      expect(left[0].environment).toBe("sandbox")
    } finally {
      await sql`UPDATE kernel.push_tokens SET environment = 'production' WHERE user_id = ${BOB}`
    }
  })

  it("keeps the row when the send merely failed", async () => {
    await handlePushFanout(
      { eventId: "evt-dead-2", event: messageEvent() },
      {
        send: async () => ({ kind: "transient", detail: "503" }),
        retryBaseMs: 0,
        onDeadLetter: () => {},
      },
    )
    const left = await sql<{ id: string }[]>`
      SELECT id FROM kernel.push_tokens WHERE user_id = ${BOB}`
    expect(left).toHaveLength(1)
  })

  it("ignores an event that is not a message create", async () => {
    const sender = spy()
    await handlePushFanout(
      { eventId: "evt-4", event: messageEvent({ action: "update" }) },
      { send: sender.send },
    )
    expect(sender.calls).toHaveLength(0)
  })
})
