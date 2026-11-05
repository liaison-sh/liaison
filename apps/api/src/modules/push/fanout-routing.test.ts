// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S2/S3 (P2-TD): every push the fanout sends is decided by the router, against
// REAL rows (users, threads, mute state, push tokens, the stored grid). Only
// the wire (`send`) and the desktop emitter are doubles.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { processTranslationEvent } from "~/modules/attention/translator"
import {
  BURST_QUIET_MS,
  BURST_THRESHOLD,
  type BurstFlushJob,
  BurstTestAccess,
  burstCollapseId,
  runBurstFlush,
} from "~/modules/notifications/burst"
import {
  type DesktopNotifyPayload,
  registerDesktopEmitter,
} from "~/modules/notifications/desktop-hook"
import type { RouterDecision } from "~/modules/notifications/router"
import {
  deliverPayloadToUser,
  handlePushFanout,
  PushFanoutTestAccess,
} from "~/modules/push/fanout-consumer"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"

const ORG = "00000000-0000-0000-0000-0000000008d0"
const ALICE = "00000000-0000-0000-0000-0000000008d1"
const BOB = "00000000-0000-0000-0000-0000000008d2"

let channelId = ""
let dmId = ""

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
function messageEvent(threadId: string, data: Record<string, unknown> = {}): AppEvent {
  seq += 1
  const id = `00000000-0000-0000-0000-0000000089${String(seq).padStart(2, "0")}`
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: id,
    orgId: ORG,
    actorId: ALICE,
    actorType: "user",
    timestamp: new Date().toISOString(),
    data: {
      id,
      threadId,
      authorId: ALICE,
      authorName: "Alice",
      authorType: "user",
      content: "hello",
      participantIds: [ALICE, BOB],
      mentions: [],
      requiredScopes: [],
      disclosureList: null,
      ...data,
    },
  } as AppEvent
}

async function fanout(event: AppEvent, send: ReturnType<typeof spy>["send"]) {
  await handlePushFanout({ eventId: `evt-route-${event.entityId}`, event }, { send })
}

async function setBobGrid(grid: Record<string, Record<string, boolean>> | null): Promise<void> {
  const stored = grid ? JSON.stringify({ grid }) : null
  await sql`INSERT INTO kernel.user_preferences (user_id, notification_channels)
    VALUES (${BOB}, ${stored}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET notification_channels = EXCLUDED.notification_channels`
}

async function setBobNotifyAll(threadId: string, on: boolean): Promise<void> {
  await sql`UPDATE kernel.user_thread_state SET notify_all_posts = ${on}
    WHERE user_id = ${BOB} AND thread_id = ${threadId}`
}

async function setBobMuted(threadId: string, muted: boolean): Promise<void> {
  await sql`UPDATE kernel.user_thread_state SET is_muted = ${muted}
    WHERE user_id = ${BOB} AND thread_id = ${threadId}`
}

describe("push fanout, routed (S3)", () => {
  beforeAll(async () => {
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'RouteOrg', 'route-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, name] of [
      [ALICE, "alice"],
      [BOB, "bob"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`route-${name}@t.com`}, ${name}, 'x') ON CONFLICT (id) DO NOTHING`
    }
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, 'route-channel', 'general', ${ALICE}) RETURNING id`
    channelId = c.id
    const [d] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${ORG}, 'route-dm', ${ALICE}) RETURNING id`
    dmId = d.id
    for (const threadId of [channelId, dmId]) {
      for (const userId of [ALICE, BOB]) {
        await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
          VALUES (${threadId}, ${userId}, ${ORG})`
        await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
          VALUES (${userId}, ${threadId}, ${ORG})`
      }
    }
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${BOB}, 'ios', 'route-token-bob')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${ALICE}, ${BOB})`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  beforeEach(async () => {
    PushFanoutTestAccess.resetDedupe()
    // Not a burst (notifications/burst.ts): every case starts from none.
    await BurstTestAccess.resetOrg(ORG)
  })

  afterEach(async () => {
    registerDesktopEmitter(null)
    PushFanoutTestAccess.resetDedupe()
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
    await setBobGrid(null)
    await setBobMuted(channelId, false)
    await setBobMuted(dmId, false)
    await setBobNotifyAll(channelId, false)
  })

  it("a message in a muted thread produces zero APNs calls, unmuted one", async () => {
    // The channel opted into every post, so only the mute is under test.
    await setBobNotifyAll(channelId, true)
    await setBobMuted(channelId, true)
    const muted = spy()
    await fanout(messageEvent(channelId), muted.send)
    expect(muted.calls).toHaveLength(0)

    await setBobMuted(channelId, false)
    const unmuted = spy()
    await fanout(messageEvent(channelId), unmuted.send)
    expect(unmuted.calls).toHaveLength(1)
    expect(unmuted.calls[0].token.token).toBe("route-token-bob")
  })

  it("rule 7: mute means mute: an @mention in a muted thread does not push", async () => {
    await setBobMuted(channelId, true)
    const sender = spy()
    await fanout(messageEvent(channelId, { mentions: [{ type: "user", id: BOB }] }), sender.send)
    expect(sender.calls).toHaveLength(0)
    await setBobMuted(channelId, false)
    await fanout(messageEvent(channelId, { mentions: [{ type: "user", id: BOB }] }), sender.send)
    expect(sender.calls).toHaveLength(1)
  })

  it("every push names the organisation it comes from, so a phone on several servers can tell them apart", async () => {
    const sender = spy()
    await fanout(messageEvent(channelId, { mentions: [{ type: "user", id: BOB }] }), sender.send)
    expect(sender.calls).toHaveLength(1)
    expect(sender.calls[0].payload.serverLabel).toBe("RouteOrg")
    // The phone said it is single server: the sender keeps the label out of the alert.
    expect(sender.calls[0].token.multiServer).toBe(false)
    await sql`UPDATE kernel.push_tokens SET multi_server = true WHERE token = 'route-token-bob'`
    const again = spy()
    PushFanoutTestAccess.resetDedupe()
    await fanout(messageEvent(channelId, { mentions: [{ type: "user", id: BOB }] }), again.send)
    await sql`UPDATE kernel.push_tokens SET multi_server = false WHERE token = 'route-token-bob'`
    expect(again.calls[0].token.multiServer).toBe(true)
  })

  // Etiquette rule 2: a channel interrupts its members only for a mention by
  // default; every post is a per-channel opt-in (user_thread_state).
  it("a channel post does not push a member by default; a mention of them does", async () => {
    const sender = spy()
    await fanout(messageEvent(channelId), sender.send)
    expect(sender.calls).toHaveLength(0)
    await fanout(messageEvent(channelId, { mentions: [{ type: "user", id: BOB }] }), sender.send)
    expect(sender.calls).toHaveLength(1)
  })

  it("a channel the member opted into every post pushes every post", async () => {
    await setBobNotifyAll(channelId, true)
    const sender = spy()
    await fanout(messageEvent(channelId), sender.send)
    expect(sender.calls).toHaveLength(1)
    // The opt-in is per channel: another channel stays mentions-only.
    await setBobNotifyAll(channelId, false)
    const after = spy()
    await fanout(messageEvent(channelId), after.send)
    expect(after.calls).toHaveLength(0)
  })

  it("the grid's replies push cell switched on pushes every channel post", async () => {
    await setBobGrid({ replies: { push: true } })
    const sender = spy()
    await fanout(messageEvent(channelId), sender.send)
    expect(sender.calls).toHaveLength(1)
  })

  // An app's post is a system row. In a direct room it is addressed to the
  // person there like a direct message; elsewhere it follows the channel rule.
  it("an app's post in a direct room pushes the person there; in a channel only a mention does", async () => {
    const appPost = (threadId: string, extra: Record<string, unknown> = {}) =>
      messageEvent(threadId, {
        authorType: "system",
        authorName: "Liaison",
        content: "Your order shipped.",
        metadata: { origin_kind: "app_post", origin_app_id: "shopify" },
        ...extra,
      })
    const dm = spy()
    await fanout(appPost(dmId), dm.send)
    expect(dm.calls.map((c) => c.token.token)).toEqual(["route-token-bob"])
    const channel = spy()
    await fanout(appPost(channelId), channel.send)
    expect(channel.calls).toHaveLength(0)
    await fanout(appPost(channelId, { mentions: [{ type: "user", id: BOB }] }), channel.send)
    expect(channel.calls).toHaveLength(1)
  })

  // Etiquette rule 1: a post the person's agent makes in a channel because
  // they asked is their own work: it interrupts nobody who asked for it.
  it("an agent's post in a channel on someone's behalf never pushes the person who asked", async () => {
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${ORG}, ${ALICE}, 'ios', 'route-token-alice')`
    try {
      const sender = spy()
      await fanout(
        messageEvent(dmId, { authorType: "agent", authorName: "Alice's agent" }),
        sender.send,
      )
      // Bob is told (a direct room); Alice, who asked, is not.
      expect(sender.calls.map((c) => c.token.token)).toEqual(["route-token-bob"])
    } finally {
      await sql`DELETE FROM kernel.push_tokens WHERE token = 'route-token-alice'`
    }
  })

  it("the grid's direct push cell switched off stops a DM push", async () => {
    await setBobGrid({ direct: { push: false } })
    const sender = spy()
    await fanout(messageEvent(dmId), sender.send)
    expect(sender.calls).toHaveLength(0)
  })

  it("an @mention in a direct thread produces exactly one APNs call, not one per source", async () => {
    const event = messageEvent(dmId, { mentions: [{ type: "user", id: BOB }] })
    const sender = spy()
    await fanout(event, sender.send)
    // The same event through the translator: its `mention` row is a chat
    // group row, which never goes live (no second push from the row).
    const live: RouterDecision[] = []
    await processTranslationEvent(event, {
      dispatchLive: async (d) => {
        live.push(d)
      },
    })
    expect(sender.calls).toHaveLength(1)
    expect(live).toHaveLength(0)
  })

  // An approval's lifecycle line ("Approval request request-N opened.",
  // "Denied by X. Reason: ...") is a system notice, not a chat message: its
  // news is the approvals row (approval_pending / approval_decision), so it
  // must never push or raise the desktop as a reply or a mention, and never to
  // the person whose decision it records.
  for (const notice of [
    { type: "approval-created", requestHandle: "request-7", toolName: "x__y" },
    { type: "approval-decision", decision: "denied", actorId: BOB, reason: "no" },
  ]) {
    it(`a ${notice.type} notice is not pushed or raised as a chat message, even to its actor`, async () => {
      const raised: RouterDecision[] = []
      registerDesktopEmitter((d) => {
        raised.push(d)
      })
      for (const author of [ALICE, BOB]) {
        PushFanoutTestAccess.resetDedupe()
        const sender = spy()
        await fanout(
          messageEvent(channelId, {
            authorId: author,
            authorType: "system",
            authorName: "Liaison",
            content: "Denied by bob. Reason: no.",
            metadata: notice,
          }),
          sender.send,
        )
        expect(sender.calls).toHaveLength(0)
      }
      expect(raised).toHaveLength(0)
    })
  }

  it("calls the desktop hook for a delivered desktop channel, and not when the cell is off", async () => {
    const raised: Array<{ d: RouterDecision; p: DesktopNotifyPayload }> = []
    registerDesktopEmitter((d, p) => {
      raised.push({ d, p })
    })
    const event = messageEvent(dmId)
    await fanout(event, spy().send)
    expect(raised).toHaveLength(1)
    expect(raised[0].d.userId).toBe(BOB)
    expect(raised[0].d.group).toBe("direct")
    expect(raised[0].p.notifyId).toBe(`message:${event.entityId}`)
    expect(raised[0].p.route).toBe(`thread/${dmId}`)

    raised.length = 0
    await setBobGrid({ direct: { desktop: false } })
    await fanout(messageEvent(dmId), spy().send)
    expect(raised).toHaveLength(0)
  })
})

// Burst collapse end to end through the push fanout, against REAL rows: an
// agent posts a note in each of 23 task discussions within a minute, each
// mentioning the person. The person's phone gets the first notes one by one,
// then ONE summary; the desktop the same; the inbox keeps every note. Only
// the wire (`send`), the desktop emitter and the clock are doubles.
const BURST_ORG = "00000000-0000-0000-0000-0000000009b0"
const BURST_ALICE = "00000000-0000-0000-0000-0000000009b1"
const BURST_BOB = "00000000-0000-0000-0000-0000000009b2"
const TASKS = 23

const burstTaskThreads: string[] = []
let burstPlainThread = ""

function burstSpy() {
  const calls: Array<{ token: PushTokenRow; payload: PushPayload }> = []
  return {
    calls,
    send: async (token: PushTokenRow, payload: PushPayload): Promise<PushSendResult> => {
      calls.push({ token, payload })
      return { kind: "sent" }
    },
  }
}

let burstSeq = 0
function agentNote(threadId: string): AppEvent {
  burstSeq += 1
  const id = `00000000-0000-0000-0000-0000000${String(9000 + burstSeq).padStart(5, "0")}`
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    entityId: id,
    orgId: BURST_ORG,
    actorId: BURST_ALICE,
    actorType: "agent",
    timestamp: new Date().toISOString(),
    data: {
      id,
      threadId,
      // An agent row's author is the requester; its name is the agent's.
      authorId: BURST_ALICE,
      authorName: "Ops Agent",
      authorType: "agent",
      content: "@[Bob](user:bob) noted the next step",
      participantIds: [BURST_ALICE, BURST_BOB],
      mentions: [{ type: "user", id: BURST_BOB }],
      requiredScopes: [],
      disclosureList: null,
    },
  } as AppEvent
}

describe("push fanout, burst collapse", () => {
  let clock = 0
  const armed: BurstFlushJob[] = []
  const burst = {
    now: () => clock,
    scheduleFlush: async (job: BurstFlushJob, _delayMs: number) => {
      armed.push(job)
    },
  }
  const desktop: DesktopNotifyPayload[] = []

  beforeAll(async () => {
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${BURST_ORG}, 'BurstFanoutOrg', 'burst-fanout-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, name] of [
      [BURST_ALICE, "alice"],
      [BURST_BOB, "bob"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${BURST_ORG}, ${`burst-${name}@t.com`}, ${name}, 'x') ON CONFLICT (id) DO NOTHING`
    }
    for (let i = 0; i < TASKS; i++) {
      const [t] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, type, hidden_from_list, created_from, created_by)
        VALUES (${BURST_ORG}, ${`burst-task-${i}`}, 'thread', true,
          ${JSON.stringify({ app: "projects", entityType: "task", entityId: `task-${i}` })}::jsonb,
          ${BURST_ALICE}) RETURNING id`
      burstTaskThreads.push(t.id)
    }
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, created_by)
      VALUES (${BURST_ORG}, 'burst-dm', ${BURST_ALICE}) RETURNING id`
    burstPlainThread = p.id
    for (const threadId of [...burstTaskThreads, burstPlainThread]) {
      for (const userId of [BURST_ALICE, BURST_BOB]) {
        await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
          VALUES (${threadId}, ${userId}, ${BURST_ORG})`
        await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
          VALUES (${userId}, ${threadId}, ${BURST_ORG})`
      }
    }
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${BURST_ORG}, ${BURST_BOB}, 'ios', 'burst-token-bob')`
  })

  afterAll(async () => {
    await BurstTestAccess.reset(BURST_ORG, [BURST_ALICE, BURST_BOB])
    await sql`DELETE FROM kernel.notification_deliveries WHERE org_id = ${BURST_ORG}`
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${BURST_ORG}`
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${BURST_ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${BURST_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${BURST_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${BURST_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${BURST_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${BURST_ORG}`
  })

  beforeEach(async () => {
    PushFanoutTestAccess.resetDedupe()
    await BurstTestAccess.reset(BURST_ORG, [BURST_ALICE, BURST_BOB])
    clock = 5_000_000
    armed.length = 0
    desktop.length = 0
    // Bob's computer only: the requester (Alice) is told about her agent's
    // notes too, and has her own burst.
    registerDesktopEmitter(async (d, payload) => {
      if (d.userId === BURST_BOB) desktop.push(payload)
    })
  })

  afterEach(async () => {
    registerDesktopEmitter(null)
    PushFanoutTestAccess.resetDedupe()
    await sql`DELETE FROM kernel.durable_consumer_marks WHERE consumer = 'push-fanout'`
  })

  it("23 agent notes in 23 tasks: the first notify, then ONE summary push and desktop notice; every note stays in the inbox", async () => {
    const sender = burstSpy()
    for (const threadId of burstTaskThreads) {
      const event = agentNote(threadId)
      await handlePushFanout(
        { eventId: `evt-burst-${event.entityId}`, event },
        { send: sender.send, burst },
      )
      // The in-app row of the same note, through the translator.
      await processTranslationEvent(event, { dispatchLive: async () => {} })
      clock += 2_500
    }
    const individual = BURST_THRESHOLD - 1
    expect(sender.calls).toHaveLength(individual)
    expect(desktop).toHaveLength(individual)
    // Each single push stacks by its own task's thread; a mention keeps its
    // own banner (a later message of the thread does not replace it).
    expect(sender.calls[0]?.payload.threadId).toBe(burstTaskThreads[0])
    expect(sender.calls[0]?.payload.collapseId).toBe(`n:${sender.calls[0]?.payload.notificationId}`)
    expect(armed).toContainEqual(expect.objectContaining({ orgId: BURST_ORG, userId: BURST_BOB }))

    clock += BURST_QUIET_MS
    const outcome = await runBurstFlush(
      { orgId: BURST_ORG, userId: BURST_BOB },
      {
        ...burst,
        push: (d, id, build) => deliverPayloadToUser(d, id, build, { send: sender.send }),
      },
    )
    expect(outcome).toBe("sent")
    expect(sender.calls).toHaveLength(individual + 1)
    const summary = sender.calls.at(-1)?.payload
    expect(summary).toMatchObject({
      type: "attention",
      title: "Ops Agent",
      body: `${TASKS} new messages in ${TASKS} tasks`,
      collapseId: burstCollapseId(BURST_ORG),
      groupId: burstCollapseId(BURST_ORG),
      deepLink: "liaison://attention",
    })
    expect(summary?.notificationId).toBeString()
    expect(desktop).toHaveLength(individual + 1)
    expect(desktop.at(-1)).toMatchObject({
      title: "Ops Agent",
      body: `${TASKS} new messages in ${TASKS} tasks`,
      tag: burstCollapseId(BURST_ORG),
    })

    // The inbox has every note: no row was dropped or merged.
    const [rows] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.attention_events
       WHERE org_id = ${BURST_ORG} AND user_id = ${BURST_BOB}`
    expect(rows?.n).toBe(TASKS)
    // The held notes are in the delivery log as held for the burst.
    const [held] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.notification_deliveries
       WHERE org_id = ${BURST_ORG} AND user_id = ${BURST_BOB} AND channel = 'push' AND reason = 'burst'`
    expect(held?.n).toBe(TASKS - individual)
  })

  it("two notes a minute apart are two pushes", async () => {
    const sender = burstSpy()
    for (const threadId of [burstPlainThread, burstPlainThread]) {
      const event = agentNote(threadId)
      await handlePushFanout(
        { eventId: `evt-burst-${event.entityId}`, event },
        { send: sender.send, burst },
      )
      clock += 61_000
    }
    expect(sender.calls).toHaveLength(2)
    expect(armed).toHaveLength(0)
  })

  it("a direct message from someone else during the agent's burst is delivered on its own, with its own banner", async () => {
    const sender = burstSpy()
    for (const threadId of burstTaskThreads.slice(0, 6)) {
      const event = agentNote(threadId)
      await handlePushFanout(
        { eventId: `evt-burst-${event.entityId}`, event },
        { send: sender.send, burst },
      )
      clock += 1_000
    }
    const before = sender.calls.length
    expect(before).toBe(BURST_THRESHOLD - 1)
    // Alice herself (not her agent) writes to Bob in their direct room.
    const dm = agentNote(burstPlainThread)
    const data = dm.data as Record<string, unknown>
    dm.actorType = "user"
    data.authorType = "user"
    data.authorName = "alice"
    data.content = "can you call me?"
    data.mentions = []
    await handlePushFanout(
      { eventId: `evt-burst-${dm.entityId}`, event: dm },
      { send: sender.send, burst },
    )
    expect(sender.calls).toHaveLength(before + 1)
    const pushed = sender.calls.at(-1)?.payload
    expect(pushed?.threadId).toBe(burstPlainThread)
    expect(pushed?.body).toContain("can you call me?")
    expect(pushed?.collapseId).toBe(`n:${pushed?.notificationId}`)
    expect(desktop.at(-1)?.tag).toBe(`n:${pushed?.notificationId}`)
  })
})
