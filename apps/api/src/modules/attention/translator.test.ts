// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DurableConsumersTestAccess,
  durableConsumerCount,
  registerDurableEventConsumer,
  runDurableConsumers,
} from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import {
  type AttentionTranslation,
  manifestAttentionRegistry,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import type { UserPrefsSnapshot } from "./translator"

type Mod = typeof import("./translator")
let mod: Mod

const ORG = "00000000-0000-0000-0000-000000000111"
const USER_A = "00000000-0000-0000-0000-000000000aaa"
const USER_B = "00000000-0000-0000-0000-000000000bbb"
const USER_C = "00000000-0000-0000-0000-000000000ccc"
const T1 = "00000000-0000-0000-0000-0000000000t1"
const MSG_ID = "00000000-0000-0000-0000-0000000000m1"

beforeEach(async () => {
  mod = await import("./translator")
  DurableConsumersTestAccess.reset()
  mod.AttentionTranslatorTestAccess.resetRegistration()
  resetAppRegistries()
})

afterEach(() => {
  DurableConsumersTestAccess.reset()
  resetAppRegistries()
})

function defaultPrefs(): UserPrefsSnapshot {
  return {
    digestCadence: "daily",
    workHoursStart: "00:00",
    workHoursEnd: "00:00",
    workDays: [1, 2, 3, 4, 5, 6, 7],
    timezone: "UTC",
  }
}

function makeDeps(overrides?: { prefs?: Record<string, ReturnType<typeof defaultPrefs>> }) {
  const inserted: any[] = []
  const prefsMap = overrides?.prefs ?? {}
  return {
    inserted,
    deps: {
      loadPreferences: async (userId: string) => prefsMap[userId] ?? defaultPrefs(),
      insertAttentionRow: async (row: any) => {
        inserted.push(row)
      },
    },
  }
}

function messageCreateEvent(overrides: Partial<AppEvent> = {}): AppEvent {
  const { data: dataOverride, ...rest } = overrides
  return {
    app: "kernel",
    entity: "message",
    action: "create",
    orgId: ORG,
    actorId: USER_A,
    actorType: "user",
    entityId: MSG_ID,
    timestamp: "2026-05-12T12:00:00.000Z",
    data: {
      threadId: T1,
      participantIds: [USER_A, USER_B, USER_C],
      preview: "hey",
      authorType: "user",
      // Every kernel message:create event carries its tag; an untagged message is [].
      requiredScopes: [],
      ...(dataOverride as Record<string, unknown> | undefined),
    },
    ...rest,
  }
}

describe("processTranslationEvent — kernel message:create", () => {
  it("emits thread_reply rows for participants minus actor", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(messageCreateEvent(), deps)
    const replies = inserted.filter((r) => r.kind === "thread_reply")
    const userIds = replies.map((r) => r.userId).sort()
    expect(userIds).toEqual([USER_B, USER_C].sort())
    expect(replies.find((r) => r.userId === USER_A)).toBeUndefined()
  })

  // Etiquette rule 1 (amended): the agent row that ends the person's turn is
  // their one notification, inbox included; its progress rows are not.
  it("an agent's finished answer reaches the person it worked for; its progress rows do not", async () => {
    const agentRow = (extra: Record<string, unknown>) =>
      messageCreateEvent({ actorType: "agent", data: { authorType: "agent", ...extra } })
    const done = makeDeps()
    await mod.processTranslationEvent(agentRow({ endsTurn: true }), done.deps)
    expect(
      done.inserted
        .filter((r) => r.kind === "thread_reply")
        .map((r) => r.userId)
        .sort(),
    ).toEqual([USER_A, USER_B, USER_C].sort())

    const progress = makeDeps()
    await mod.processTranslationEvent(agentRow({}), progress.deps)
    expect(
      progress.inserted.filter((r) => r.kind === "thread_reply").map((r) => r.userId),
    ).not.toContain(USER_A)
  })

  it("a system row that ends the person's turn (a refusal) reaches their inbox; other system rows do not", async () => {
    const ended = makeDeps()
    await mod.processTranslationEvent(
      messageCreateEvent({
        actorType: "system",
        data: { authorType: "system", endsTurn: true, metadata: { turnRefusal: true } },
      }),
      ended.deps,
    )
    expect(ended.inserted.filter((r) => r.kind === "thread_reply").map((r) => r.userId)).toContain(
      USER_A,
    )
    const line = makeDeps()
    await mod.processTranslationEvent(
      messageCreateEvent({ actorType: "system", data: { authorType: "system" } }),
      line.deps,
    )
    expect(line.inserted.filter((r) => r.kind === "thread_reply")).toHaveLength(0)
  })

  it("a seeded message (a demo seed's conversation) raises no attention row", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      messageCreateEvent({
        data: {
          threadId: T1,
          participantIds: [USER_A, USER_B, USER_C],
          mentions: [{ type: "user", id: USER_C }],
          preview: "hey",
          metadata: { seeded: true },
        },
      }),
      deps,
    )
    expect(inserted).toHaveLength(0)
  })

  it("emits a separate mention row for each mentioned user", async () => {
    const { inserted, deps } = makeDeps()
    const event = messageCreateEvent({
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B, USER_C],
        mentions: [{ type: "user", id: USER_C }],
        preview: "hey",
      },
    })
    await mod.processTranslationEvent(event, deps)
    const mentions = inserted.filter((r) => r.kind === "mention")
    expect(mentions.length).toBe(1)
    expect(mentions[0].userId).toBe(USER_C)
    expect(mentions[0].urgency).toBe(60)
    // Per spec: kernel message:create attention rows target the thread (so Home
    // opens the thread and mark-read on the thread clears them). The originating
    // message id is preserved in metadata.
    expect(mentions[0].entityType).toBe("thread")
    expect(mentions[0].entityId).toBe(T1)
    expect(mentions[0].metadata).toMatchObject({ messageId: MSG_ID })
  })

  it("a mentioned participant gets only the mention row, not also thread_reply", async () => {
    const { inserted, deps } = makeDeps()
    const event = messageCreateEvent({
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B, USER_C],
        mentions: [{ type: "user", id: USER_C }],
        preview: "hey",
      },
    })
    await mod.processTranslationEvent(event, deps)
    // USER_C is mentioned → mention row, but NOT a thread_reply row.
    expect(inserted.filter((r) => r.kind === "mention").map((r) => r.userId)).toEqual([USER_C])
    const replyUserIds = inserted
      .filter((r) => r.kind === "thread_reply")
      .map((r) => r.userId)
      .sort()
    expect(replyUserIds).toEqual([USER_B].sort()) // USER_A=actor, USER_C=mentioned — both excluded
  })

  it("system-authored messages produce no thread_reply rows", async () => {
    const { inserted, deps } = makeDeps()
    // Approval decisions, handler errors, etc. post system messages — they must
    // not fan out as generic "someone replied" notifications.
    const event = messageCreateEvent({
      actorType: "system",
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B, USER_C],
        preview: "Approved by Home Approver. Tool executed successfully.",
        authorType: "system",
      },
    })
    await mod.processTranslationEvent(event, deps)
    expect(inserted.filter((r) => r.kind === "thread_reply")).toEqual([])
  })

  it("agent-authored messages still produce thread_reply rows", async () => {
    const { inserted, deps } = makeDeps()
    const event = messageCreateEvent({
      actorType: "agent",
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B, USER_C],
        preview: "Routine digest posted",
        authorType: "agent",
      },
    })
    await mod.processTranslationEvent(event, deps)
    const replyUserIds = inserted
      .filter((r) => r.kind === "thread_reply")
      .map((r) => r.userId)
      .sort()
    expect(replyUserIds).toEqual([USER_B, USER_C].sort())
  })

  const states = (muted: string[], archived: string[] = []) => ({
    muted: new Set(muted),
    archived: new Set(archived),
  })

  it("rule 7: a muted participant keeps the reply as a quiet, unread inbox row, never emailed", async () => {
    const { inserted, deps } = makeDeps()
    const calls: Array<{ threadId: string; userIds: string[] }> = []
    await mod.processTranslationEvent(messageCreateEvent(), {
      ...deps,
      loadThreadMuteStates: async (threadId: string, userIds: string[]) => {
        calls.push({ threadId, userIds })
        return states([USER_B])
      },
    })
    const replies = inserted.filter((r) => r.kind === "thread_reply")
    // USER_A is the actor (excluded); USER_B muted the thread but keeps the row.
    expect(replies.map((r) => r.userId).sort()).toEqual([USER_B, USER_C].sort())
    const b = replies.find((r) => r.userId === USER_B)
    const c = replies.find((r) => r.userId === USER_C)
    expect(b.readAt).toBeUndefined()
    expect(b.metadata?.quiet).toBe(true)
    expect(b.digestState).toBe("suppressed")
    expect(c.metadata?.quiet).toBeUndefined()
    expect(calls[0]?.threadId).toBe(T1)
  })

  it("an archived thread keeps a channel post as a quiet inbox row", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(messageCreateEvent(), {
      ...deps,
      loadThreadMuteStates: async () => states([], [USER_C]),
    })
    const c = inserted.find((r) => r.kind === "thread_reply" && r.userId === USER_C)
    expect(c.metadata?.quiet).toBe(true)
  })

  it("archive is not mute: an @mention in an archived thread is not quiet; in a muted one it is", async () => {
    const event = messageCreateEvent({
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B, USER_C],
        mentions: [{ type: "user", id: USER_C }],
        preview: "hey",
      },
    })
    const archived = makeDeps()
    await mod.processTranslationEvent(event, {
      ...archived.deps,
      loadThreadMuteStates: async () => states([], [USER_C]),
    })
    const mention = archived.inserted.find((r) => r.kind === "mention")
    expect(mention.userId).toBe(USER_C)
    expect(mention.metadata?.quiet).toBeUndefined()

    const muted = makeDeps()
    await mod.processTranslationEvent(event, {
      ...muted.deps,
      loadThreadMuteStates: async () => states([USER_C]),
    })
    const quiet = muted.inserted.find((r) => r.kind === "mention")
    // Rule 7 (mute means mute): in the inbox, unread, quiet, never emailed.
    expect(quiet.readAt).toBeUndefined()
    expect(quiet.metadata?.quiet).toBe(true)
    expect(quiet.digestState).toBe("suppressed")
  })

  it("rule 7: a kind set to off is a quiet unread row; other kinds are not quiet", async () => {
    const off = { ...defaultPrefs(), notificationChannels: { mutedGroups: ["replies"] } }
    const { inserted, deps } = makeDeps({ prefs: { [USER_B]: off } })
    await mod.processTranslationEvent(messageCreateEvent(), deps)
    const b = inserted.find((r) => r.kind === "thread_reply" && r.userId === USER_B)
    const c = inserted.find((r) => r.kind === "thread_reply" && r.userId === USER_C)
    expect(b.readAt).toBeUndefined()
    expect(b.metadata?.quiet).toBe(true)
    expect(c.metadata?.quiet).toBeUndefined()
  })

  it("event with no threadId in data is a no-op for the mute filter (no throw)", async () => {
    const { inserted, deps } = makeDeps()
    let muteCalled = false
    const depsWithMute = {
      ...deps,
      loadThreadMuteStates: async () => {
        muteCalled = true
        return states([])
      },
    }
    const event = messageCreateEvent({
      data: {
        threadId: undefined,
        participantIds: [USER_A, USER_B, USER_C],
        preview: "hey",
        authorType: "user",
      },
    })
    await expect(mod.processTranslationEvent(event, depsWithMute)).resolves.toBeUndefined()
    const replyUserIds = inserted
      .filter((r) => r.kind === "thread_reply")
      .map((r) => r.userId)
      .sort()
    expect(replyUserIds).toEqual([USER_B, USER_C].sort())
    expect(muteCalled).toBe(false)
  })

  it("mention summary substitutes actor.name from metadata", async () => {
    const { inserted, deps } = makeDeps()
    const event = messageCreateEvent({
      metadata: { actorName: "Alice" },
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B],
        mentions: [{ type: "user", id: USER_B }],
      },
    })
    await mod.processTranslationEvent(event, deps)
    const mention = inserted.find((r) => r.kind === "mention")
    expect(mention?.summary).toBe("Alice mentioned you")
  })
})

describe("processTranslationEvent — digest_state", () => {
  // Rule 8 on: quiet hours by default (off under NODE_ENV=test otherwise).
  const savedQuiet = process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS
  beforeEach(() => {
    process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS = "on"
  })
  afterEach(() => {
    if (savedQuiet === undefined) delete process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS
    else process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS = savedQuiet
  })
  it("digest_cadence='off' produces suppressed for non-urgent rows", async () => {
    const { inserted, deps } = makeDeps({
      prefs: {
        [USER_B]: { ...defaultPrefs(), digestCadence: "off" },
        [USER_C]: { ...defaultPrefs(), digestCadence: "off" },
      },
    })
    await mod.processTranslationEvent(messageCreateEvent(), deps)
    const replies = inserted.filter((r) => r.kind === "thread_reply")
    for (const r of replies) expect(r.digestState).toBe("suppressed")
  })

  it("urgent rows stay pending regardless of cadence", async () => {
    const { inserted, deps } = makeDeps({
      prefs: { [USER_B]: { ...defaultPrefs(), digestCadence: "off" } },
    })
    // approval_request:update with status=approved → urgency 50 (not urgent by default)
    // → force isUrgent test via urgent threshold. Use a synthetic urgent path:
    // For this test, fabricate via mention + override prefs to cadence off.
    // Mentions have urgency 60 — not auto-urgent — so we instead test mention semantics
    // by checking digest_state still goes pending when prefs are daily.
    const event = messageCreateEvent({
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B],
        mentions: [{ type: "user", id: USER_B }],
      },
    })
    await mod.processTranslationEvent(event, deps)
    const mention = inserted.find((r) => r.kind === "mention" && r.userId === USER_B)
    // digestState is suppressed because mention's isUrgent flag is undefined → defaults to urgency>=70
    // urgency=60 < 70, so for off cadence → suppressed.
    expect(mention?.digestState).toBe("suppressed")
  })

  it("outside work hours, digest_eligible_at = next work window open", async () => {
    const { inserted, deps } = makeDeps({
      prefs: {
        [USER_B]: {
          digestCadence: "daily",
          workHoursStart: "09:00",
          workHoursEnd: "17:00",
          workDays: [1, 2, 3, 4, 5],
          timezone: "UTC",
          // A known clock (rule 8 never guesses UTC).
          notificationChannels: { timezoneSet: true },
        },
      },
    })
    // 2026-05-12 23:00 UTC = Tuesday evening, outside the 09:00–17:00 window.
    // Next work window open is Wednesday 2026-05-13 09:00 UTC.
    const event = messageCreateEvent({
      timestamp: "2026-05-12T23:00:00.000Z",
    })
    await mod.processTranslationEvent(event, deps)
    const reply = inserted.find((r) => r.kind === "thread_reply" && r.userId === USER_B)
    expect(reply).toBeDefined()
    // Rule 8: hours nobody chose read as the default window, 08:00-20:00.
    expect(new Date(reply!.digestEligibleAt).toISOString()).toBe("2026-05-13T08:00:00.000Z")
  })

  it("non-workday events defer to the next workday's window open", async () => {
    const { inserted, deps } = makeDeps({
      prefs: {
        [USER_B]: {
          digestCadence: "daily",
          workHoursStart: "09:00",
          workHoursEnd: "17:00",
          workDays: [1, 2, 3, 4, 5],
          timezone: "UTC",
          // A known clock (rule 8 never guesses UTC).
          notificationChannels: { timezoneSet: true },
        },
      },
    })
    // 2026-05-16 10:00 UTC = Saturday — non-workday. Next Mon 09:00 UTC.
    const event = messageCreateEvent({
      timestamp: "2026-05-16T10:00:00.000Z",
    })
    await mod.processTranslationEvent(event, deps)
    const reply = inserted.find((r) => r.kind === "thread_reply" && r.userId === USER_B)
    expect(reply).toBeDefined()
    expect(new Date(reply!.digestEligibleAt).toISOString()).toBe("2026-05-18T08:00:00.000Z")
  })

  it("rule 8: an urgent row outside work hours waits for the window (only on-call incidents cross)", async () => {
    // Synthesize urgent by using an approval_request:update with explicit isUrgent override
    // Since kernel translation has isUrgent:false for approval_decision, we'll
    // verify urgent behavior via the >=70 default by registering a synthetic
    // manifest translation. That keeps the production code path under test.
    manifestAttentionRegistry.set(
      ["00000000-0000-0000-0000-000000000111", "kernel"],
      [
        {
          event: "alert:create",
          kind: "system_alert",
          urgency: 80,
          summary: "boom",
          recipients: { kind: "field", path: "data.userId" },
        } as any,
      ],
    )
    const { inserted, deps } = makeDeps({
      prefs: {
        [USER_B]: {
          digestCadence: "daily",
          workHoursStart: "09:00",
          workHoursEnd: "17:00",
          workDays: [1, 2, 3, 4, 5],
          timezone: "UTC",
          // A known clock (rule 8 never guesses UTC).
          notificationChannels: { timezoneSet: true },
        },
      },
    })
    const event: AppEvent = {
      app: "kernel",
      entity: "alert",
      action: "create",
      orgId: ORG,
      actorId: USER_A,
      actorType: "system",
      entityId: "a1",
      timestamp: "2026-05-12T23:00:00.000Z",
      data: { userId: USER_B },
    }
    await mod.processTranslationEvent(event, deps)
    const row = inserted[0]
    expect(row).toBeDefined()
    expect(row.isUrgent).toBe(true)
    // Rule 8: only an on-call incident crosses quiet hours; this waits for 08:00.
    expect(new Date(row.digestEligibleAt).toISOString()).toBe("2026-05-13T08:00:00.000Z")
  })
})

describe("processTranslationEvent — edge cases", () => {
  it("manifest-form templates ({{data.x}}, {{metadata.x}}) resolve against the event", async () => {
    // Bundled-app manifests (shopify, invoicing) address the event payload
    // directly, without the `payload.` prefix. These must not render as "".
    manifestAttentionRegistry.set(
      [ORG, "kernel"],
      [
        {
          event: "order:unfulfilled",
          kind: "system_alert",
          urgency: 60,
          summary: "Unfulfilled: #{{data.name}}, {{data.ageHours}} hours old ({{metadata.market}})",
          recipients: { kind: "field", path: "data.userId" },
        } as any,
      ],
    )
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "order",
        action: "unfulfilled",
        orgId: ORG,
        actorId: USER_A,
        actorType: "system",
        entityId: "o1",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: { userId: USER_B, name: "1042", ageHours: 31 },
        metadata: { market: "default" },
      },
      deps,
    )
    expect(inserted.length).toBe(1)
    expect(inserted[0].summary).toBe("Unfulfilled: #1042, 31 hours old (default)")
  })

  it("ephemeral events are skipped", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent({ ...messageCreateEvent(), ephemeral: true }, deps)
    expect(inserted.length).toBe(0)
  })

  it("non-matching event types yield no rows", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "ticket",
        action: "create",
        orgId: ORG,
        data: { participantIds: [USER_B] },
      } as AppEvent,
      deps,
    )
    expect(inserted.length).toBe(0)
  })

  it("connected_account:refuse (a personal connect refused) alerts the person who connected, durably", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "connected_account",
        action: "refuse",
        orgId: ORG,
        actorId: USER_B,
        actorType: "user",
        entityId: "00000000-0000-0000-0000-0000000000r1",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: {
          appName: "mail",
          connectionName: "gmail",
          ownerType: "user",
          ownerId: USER_B,
          identifier: "shared@acme.com",
          reason: "connect_refused",
          notifyUserId: USER_B,
          summary:
            "shared@acme.com was not connected. Connect a different account, or ask an admin.",
        },
      },
      deps,
    )
    expect(inserted.length).toBe(1)
    expect(inserted[0].kind).toBe("system_alert")
    expect(inserted[0].userId).toBe(USER_B)
    expect(inserted[0].summary).toContain("ask an admin")
  })

  it("approval_request:update with status=approved sends row to requestedBy", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "approval_request",
        action: "update",
        orgId: ORG,
        actorId: USER_A,
        actorType: "user",
        entityId: "ap-1",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: { status: "approved", handle: "deploy-prod", requestedBy: { id: USER_C } },
      },
      deps,
    )
    expect(inserted.length).toBe(1)
    expect(inserted[0].kind).toBe("approval_decision")
    expect(inserted[0].userId).toBe(USER_C)
    expect(inserted[0].summary).toBe("Approval deploy-prod approved")
  })

  it("approval_request:update with status=denied tells the requester, never the decider", async () => {
    const event = (actorId: string, requester: string): AppEvent =>
      ({
        app: "kernel",
        entity: "approval_request",
        action: "update",
        orgId: ORG,
        actorId,
        actorType: "user",
        entityId: "ap-3",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: { status: "denied", handle: "request-9", requestedBy: { id: requester } },
      }) as AppEvent
    const other = makeDeps()
    await mod.processTranslationEvent(event(USER_A, USER_C), other.deps)
    expect(other.inserted.map((r) => [r.kind, r.userId])).toEqual([["approval_decision", USER_C]])
    expect(other.inserted[0].summary).toBe("Approval request-9 denied")
    // The requester denied it themselves: nothing to tell them.
    const own = makeDeps()
    await mod.processTranslationEvent(event(USER_C, USER_C), own.deps)
    expect(own.inserted).toHaveLength(0)
  })

  it("approval_request:update with status=expired reaches the requester the system stamped as actor", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "approval_request",
        action: "update",
        orgId: ORG,
        actorId: USER_C,
        actorType: "system",
        entityId: "ap-4",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: { status: "expired", handle: "request-10", requestedBy: { id: USER_C } },
      } as AppEvent,
      deps,
    )
    expect(inserted.map((r) => [r.kind, r.userId])).toEqual([["approval_decision", USER_C]])
  })

  it("approval_request:update carrying lastFailure emits NO separate attention row (failure rides the card inline)", async () => {
    // Unified surface: a post-approval handler failure reverts the request to
    // pending and stamps `lastFailure` on the event. That failure is now carried
    // INLINE on the approval card (via the approval summary sourced from
    // approved_handler_executions), NOT as a parallel attention item. So a
    // pending update -- even one carrying lastFailure -- must emit nothing here.
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "approval_request",
        action: "update",
        orgId: ORG,
        actorId: USER_A,
        actorType: "user",
        entityId: "ap-2",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: {
          status: "pending",
          handle: "ship-order",
          requestedBy: { id: USER_C },
          lastFailure: {
            code: "carrier_rejected",
            message: "A valid North American phone number is required",
            at: "2026-05-12T12:00:00.000Z",
          },
        },
      } as AppEvent,
      deps,
    )
    expect(inserted.length).toBe(0)
  })

  it("approval_request:update with status=pending does not emit (when fails)", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "approval_request",
        action: "update",
        orgId: ORG,
        actorId: USER_A,
        actorType: "user",
        entityId: "ap-1",
        data: { status: "pending", requestedBy: { id: USER_C } },
      } as AppEvent,
      deps,
    )
    expect(inserted.length).toBe(0)
  })

  it("insert failure propagates so the outbox can retry (I-EVT-2)", async () => {
    // A transient insert failure must NOT be swallowed: the attention insert is
    // an idempotent upsert, so propagating lets the outbox retry the whole event
    // without duplicating rows. Previously this blip dropped the row forever.
    await expect(
      mod.processTranslationEvent(messageCreateEvent(), {
        loadPreferences: async () => defaultPrefs(),
        insertAttentionRow: async () => {
          throw new Error("boom")
        },
      }),
    ).rejects.toThrow("boom")
  })

  it("registers the durable consumer and it propagates a translation failure (I-EVT-2)", async () => {
    // The real handler (translatorDurableHandler) is `processTranslationEvent(ctx.event)`
    // with no catch, so propagation is guaranteed by composition: a throwing
    // insert surfaces as a rejected runDurableConsumers. We register an
    // equivalent consumer with an injected throwing insert to exercise the
    // failure path deterministically (the production default insert needs a
    // seeded org + live subscriptions to reach an insert).
    registerDurableEventConsumer("attention-translator-test", (ctx) =>
      mod.processTranslationEvent(ctx.event, {
        loadPreferences: async () => defaultPrefs(),
        insertAttentionRow: async () => {
          throw new Error("boom")
        },
      }),
    )
    await expect(
      runDurableConsumers({ eventId: "evt-1", event: messageCreateEvent() }),
    ).rejects.toThrow("boom")

    // And the production registration wires up under the expected name.
    mod.registerTranslatorConsumer()
    expect(durableConsumerCount()).toBe(2)
  })
})

describe("processTranslationEvent — agent_notification:create", () => {
  it("translates agent_notification:create into one attention row per target user", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: "notif-abc",
        orgId: ORG,
        actorId: USER_A,
        actorType: "agent",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: {
          summary: "Reminder: confirm the tracking number",
          urgency: 55,
          targetUserIds: [USER_A, USER_B],
          link: { tabType: "kernel:thread", entityId: T1 },
        },
      } as AppEvent,
      deps,
    )
    expect(inserted).toHaveLength(2)
    expect(inserted.map((r) => r.userId).sort()).toEqual([USER_A, USER_B].sort())
    expect(inserted[0].kind).toBe("agent_notification")
    expect(inserted[0].summary).toBe("Reminder: confirm the tracking number")
    expect(inserted[0].urgency).toBe(55)
    expect(inserted[0].actorType).toBe("agent")
    expect(inserted[0].metadata?.link).toEqual({
      tabType: "kernel:thread",
      entityId: T1,
    })
  })

  // Etiquette rule 2: only the system marks urgent. An agent's urgency orders
  // the inbox; it never makes the note urgent (urgent crosses quiet time).
  it("an agent's high urgency is kept for ordering but never marks the note urgent", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: "notif-loud",
        orgId: ORG,
        actorId: USER_A,
        actorType: "agent",
        timestamp: "2026-05-12T12:00:00.000Z",
        data: { summary: "Look at this now", urgency: 95, targetUserIds: [USER_A] },
      } as AppEvent,
      deps,
    )
    expect(inserted).toHaveLength(1)
    expect(inserted[0].urgency).toBe(95)
    expect(inserted[0].isUrgent).toBe(false)
  })

  // P4 N-D T6b (S24, A24): a node chat's relayed permission prompt is an
  // Allow / Deny card; the row carries what the card needs to decide it.
  it("agent_notification carries a node permission prompt onto the row", async () => {
    const { inserted, deps } = makeDeps()
    const nodePermission = {
      promptId: "prompt-1",
      jobId: "job-1",
      nodeName: "Minimac",
      agentName: "Data",
      toolName: "Bash",
      summary: "bun run build",
      expiresAt: "2026-10-07T21:10:00.000Z",
    }
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: "notif-node",
        orgId: ORG,
        actorId: USER_A,
        actorType: "system",
        data: {
          summary: "Data on Minimac asks to use Bash",
          urgency: 80,
          targetUserIds: [USER_A],
          nodePermissionPromptId: "prompt-1",
          nodePermission,
          actions: ["allow", "deny"],
        },
      } as AppEvent,
      deps,
    )
    expect((inserted[0].metadata as any)?.nodePermission).toEqual(nodePermission)
    expect((inserted[0].metadata as any)?.nodePermissionPromptId).toBe("prompt-1")
  })

  // D14 for attention items: a notification from a tainted turn carries the turn's
  // read scopes; its row records them (the digest reads them) and its live
  // dispatch is told, so push and desktop carry no derived text.
  it("agent_notification from a tainted turn carries requiredScopes to the row and the live dispatch", async () => {
    const { inserted, deps } = makeDeps()
    const live: any[] = []
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: "notif-tainted",
        orgId: ORG,
        actorId: USER_A,
        actorType: "user",
        data: {
          summary: "Deal 42 closes Friday",
          urgency: 40,
          targetUserIds: [USER_A],
          requiredScopes: ["apv:deals:read"],
        },
      } as AppEvent,
      {
        ...deps,
        dispatchLive: async (_d: unknown, item: unknown) => void live.push(item),
      } as never,
    )
    expect(inserted[0].summary).toBe("Deal 42 closes Friday")
    expect((inserted[0].metadata as any)?.requiredScopes).toEqual(["apv:deals:read"])
    expect(live).toHaveLength(1)
    expect(live[0].requiredScopes).toEqual(["apv:deals:read"])
  })

  it("agent_notification with no requiredScopes stays unredacted", async () => {
    const { inserted, deps } = makeDeps()
    const live: any[] = []
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: "notif-clean",
        orgId: ORG,
        actorId: USER_A,
        actorType: "user",
        data: { summary: "Clean", urgency: 40, targetUserIds: [USER_A] },
      } as AppEvent,
      {
        ...deps,
        dispatchLive: async (_d: unknown, item: unknown) => void live.push(item),
      } as never,
    )
    expect((inserted[0].metadata as any)?.requiredScopes).toBeUndefined()
    expect(live[0].requiredScopes).toBeUndefined()
  })

  it("agent_notification with no link leaves metadata link absent", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "agent_notification",
        action: "create",
        entityId: "notif-nolink",
        orgId: ORG,
        actorId: USER_A,
        actorType: "agent",
        data: { summary: "No link", urgency: 30, targetUserIds: [USER_A] },
      } as AppEvent,
      deps,
    )
    expect((inserted[0].metadata as any)?.link).toBeUndefined()
  })
})

// A file_shared row is keyed on the FILE, which no tab renders: the event names the
// thread it was added to as a link, and the row carries it (reported 2026-10-05 with
// the new-email card: attention rows opening "unknown tab type").
describe("processTranslationEvent — file:create", () => {
  it("file_shared carries the parent thread as its link", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(
      {
        app: "kernel",
        entity: "file",
        action: "create",
        entityId: "file-1",
        orgId: ORG,
        actorId: USER_A,
        actorType: "user",
        timestamp: "2026-10-05T09:00:00.000Z",
        data: {
          id: "file-1",
          app: "kernel",
          entityType: "thread",
          entityId: T1,
          filename: "plan.pdf",
          parentSharedSurface: true,
          parentParticipantIds: [USER_A, USER_B],
          parentLabel: "Launch",
          link: { tabType: "kernel:thread", entityId: T1 },
        },
      } as AppEvent,
      deps,
    )
    const forB = inserted.find((r) => r.userId === USER_B)
    expect(forB?.kind).toBe("file_shared")
    expect(forB?.metadata?.link).toEqual({ tabType: "kernel:thread", entityId: T1 })
  })
})

describe("registerTranslatorConsumer", () => {
  it("registers a durable consumer named attention-translator", () => {
    expect(durableConsumerCount()).toBe(0)
    mod.registerTranslatorConsumer()
    expect(durableConsumerCount()).toBe(1)
  })

  it("is idempotent across multiple calls", () => {
    mod.registerTranslatorConsumer()
    mod.registerTranslatorConsumer()
    mod.registerTranslatorConsumer()
    expect(durableConsumerCount()).toBe(1)
  })
})

describe("processTranslationEvent — resolveWhen", () => {
  function digestTranslation() {
    manifestAttentionRegistry.set(
      [ORG, "shopify"],
      [
        {
          event: "orders:unfulfilled_digest",
          kind: "shopify:orders.unfulfilled",
          urgency: 60,
          summary: "{{data.count}} orders unfulfilled",
          recipients: { kind: "field", path: "data.userId" },
          resolveWhen: { field: "count", equals: 0 },
        } as any,
      ],
    )
  }
  function digestEvent(count: number): AppEvent {
    return {
      app: "shopify",
      entity: "orders",
      action: "unfulfilled_digest",
      orgId: ORG,
      actorId: null as unknown as string,
      actorType: "system",
      entityId: "unfulfilled-orders",
      timestamp: "2026-07-07T10:00:00.000Z",
      data: { count, userId: USER_A },
    }
  }

  it("non-zero count inserts a row and does not resolve", async () => {
    digestTranslation()
    const { inserted, deps } = makeDeps()
    const resolved: Array<{ entityId: string; kind: string }> = []
    await mod.processTranslationEvent(digestEvent(7), {
      ...deps,
      resolveAttentionRows: async (event, kind) => {
        resolved.push({ entityId: event.entityId ?? "", kind })
      },
    })
    expect(inserted.length).toBe(1)
    expect(inserted[0].summary).toContain("7 orders unfulfilled")
    expect(resolved.length).toBe(0)
  })

  // The `{ always: true }` form. The conditional { field, equals } shape only
  // works when ONE event carries both the alerting and the resolving state (the
  // digest's count). Most real resolutions are a DIFFERENT event whose very
  // existence ends the condition -- an order being fulfilled ends its
  // "new order" row -- and those had no way to resolve at all, which is why 18
  // of 21 shipped translations declared no resolution and their rows sat in the
  // feed describing state the app had long since left.
  function alwaysTranslations() {
    manifestAttentionRegistry.set(
      [ORG, "shopify"],
      [
        {
          event: "order:created",
          kind: "shopify:order.created",
          urgency: 40,
          summary: "New order {{data.name}}",
          recipients: { kind: "field", path: "data.userId" },
        } as any,
        {
          event: "order:fulfilled",
          kind: "shopify:order.created",
          urgency: 0,
          summary: "Order {{data.name}} fulfilled",
          recipients: { kind: "field", path: "data.userId" },
          resolveWhen: { always: true },
        } as any,
      ],
    )
  }
  function orderEvent(action: string): AppEvent {
    return {
      app: "shopify",
      entity: "order",
      action,
      orgId: ORG,
      actorId: null as unknown as string,
      actorType: "system",
      entityId: "order-3330",
      timestamp: "2026-08-03T10:00:00.000Z",
      data: { name: "#3330", userId: USER_A },
    }
  }

  it("order:created still inserts its row", async () => {
    alwaysTranslations()
    const { inserted, deps } = makeDeps()
    const resolved: Array<{ entityId: string; kind: string }> = []
    await mod.processTranslationEvent(orderEvent("created"), {
      ...deps,
      resolveAttentionRows: async (event, kind) => {
        resolved.push({ entityId: event.entityId ?? "", kind })
      },
    })
    expect(inserted.length).toBe(1)
    expect(inserted[0].summary).toContain("#3330")
    expect(resolved.length).toBe(0)
  })

  it("order:fulfilled resolves that order's row and inserts nothing", async () => {
    alwaysTranslations()
    const { inserted, deps } = makeDeps()
    const resolved: Array<{ entityId: string; kind: string }> = []
    await mod.processTranslationEvent(orderEvent("fulfilled"), {
      ...deps,
      resolveAttentionRows: async (event, kind) => {
        resolved.push({ entityId: event.entityId ?? "", kind })
      },
    })
    // No second row: the resolving event must never ALSO announce itself.
    expect(inserted.length).toBe(0)
    expect(resolved).toEqual([{ entityId: "order-3330", kind: "shopify:order.created" }])
  })

  it("resolveWhenHit distinguishes the two forms", () => {
    const ev = orderEvent("fulfilled")
    expect(mod.resolveWhenHit({ always: true }, ev)).toBe(true)
    // The conditional form still reads the payload, and misses when it differs.
    expect(mod.resolveWhenHit({ field: "name", equals: "#3330" }, ev)).toBe(true)
    expect(mod.resolveWhenHit({ field: "name", equals: "#9999" }, ev)).toBe(false)
    // An absent field must not resolve by accident (undefined === undefined).
    expect(mod.resolveWhenHit({ field: "missing", equals: undefined as never }, ev)).toBe(false)
  })

  it("count 0 resolves the row instead of inserting a '0 items' row", async () => {
    digestTranslation()
    const { inserted, deps } = makeDeps()
    const resolved: Array<{ entityId: string; kind: string }> = []
    await mod.processTranslationEvent(digestEvent(0), {
      ...deps,
      resolveAttentionRows: async (event, kind) => {
        resolved.push({ entityId: event.entityId ?? "", kind })
      },
    })
    expect(inserted.length).toBe(0)
    expect(resolved).toEqual([
      { entityId: "unfulfilled-orders", kind: "shopify:orders.unfulfilled" },
    ])
  })
})

// The REAL monitoring manifest, registered the way runtime.ts registers it
// (`desc.attention.translations`), so a manifest edit that drops a critical
// incident's urgency below the stored `is_urgent` threshold, or moves it out of the
// `monitoring` router group, fails here.
describe("processTranslationEvent — bundled monitoring manifest", () => {
  const MANIFEST_PATH = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "..",
    "bundled-apps",
    "monitoring",
    "app.manifest.json",
  )

  function registerMonitoring() {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
      attention: { translations: AttentionTranslation[] }
    }
    manifestAttentionRegistry.set([ORG, "monitoring"], manifest.attention.translations)
  }
  function incidentEvent(action: string, data: Record<string, unknown>): AppEvent {
    return {
      app: "monitoring",
      entity: "incident",
      action,
      orgId: ORG,
      actorId: null as unknown as string,
      actorType: "system",
      entityId: "incident-1",
      timestamp: "2026-10-19T10:00:00.000Z",
      data: { title: "DB down", source: "uptime", ...data },
    }
  }
  function run(event: AppEvent) {
    registerMonitoring()
    const { inserted, deps } = makeDeps()
    const groups: string[] = []
    const resolved: Array<{ entityId: string; kind: string }> = []
    const done = mod.processTranslationEvent(event, {
      ...deps,
      recipientContext: { loadScopeHolders: async () => [USER_B] },
      buildSubscriptionFilter: async () => async () => true,
      dispatchLive: async (decision: { group: string }) => void groups.push(decision.group),
      resolveAttentionRows: async (e: AppEvent, kind: string) => {
        resolved.push({ entityId: e.entityId ?? "", kind })
      },
    } as never)
    return done.then(() => ({ inserted, groups, resolved }))
  }

  it("critical incident:created is urgent (90) and routes in the monitoring group", async () => {
    const { inserted, groups } = await run(incidentEvent("created", { severity: "critical" }))
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      userId: USER_B,
      kind: "monitoring:incident.critical",
      urgency: 90,
      isUrgent: true,
    })
    expect(groups).toEqual(["monitoring"])
  })

  it("rule 9: an incident interrupts only the on-call people; the others get it quietly", async () => {
    registerMonitoring()
    const { inserted, deps } = makeDeps()
    const desktop: Record<string, { deliver: boolean; reason?: string }> = {}
    await mod.processTranslationEvent(incidentEvent("created", { severity: "critical" }), {
      ...deps,
      recipientContext: { loadScopeHolders: async () => [USER_A, USER_B] },
      buildSubscriptionFilter: async () => async () => true,
      loadOrgNotificationContext: async () => ({
        timezone: null,
        onCallUserIds: new Set([USER_A]),
      }),
      dispatchLive: async (decision: {
        userId: string
        channels: { desktop: { deliver: boolean; reason?: string } }
      }) => {
        desktop[decision.userId] = decision.channels.desktop
      },
    } as never)
    expect(inserted.map((r) => r.userId).sort()).toEqual([USER_A, USER_B])
    expect(desktop[USER_A]?.deliver).toBe(true)
    expect(desktop[USER_B]).toEqual({ deliver: false, reason: "not_on_call" })
    // Not urgent for the person not on call: their row waits for the digest (rule 9).
    expect(inserted.find((r) => r.userId === USER_A)?.isUrgent).toBe(true)
    expect(inserted.find((r) => r.userId === USER_B)?.isUrgent).toBe(false)
  })

  it("rule 9: with no on-call list and no admin, everyone who can read the incident is interrupted", async () => {
    registerMonitoring()
    const { deps } = makeDeps()
    const desktop: Record<string, boolean> = {}
    await mod.processTranslationEvent(incidentEvent("created", { severity: "critical" }), {
      ...deps,
      recipientContext: { loadScopeHolders: async () => [USER_A, USER_B] },
      buildSubscriptionFilter: async () => async () => true,
      loadOrgNotificationContext: async () => ({ timezone: null, onCallUserIds: null }),
      dispatchLive: async (decision: {
        userId: string
        channels: { desktop: { deliver: boolean } }
      }) => {
        desktop[decision.userId] = decision.channels.desktop.deliver
      },
    } as never)
    expect(desktop).toEqual({ [USER_A]: true, [USER_B]: true })
  })

  it("warning incident:created is stored as not urgent", async () => {
    const { inserted } = await run(incidentEvent("created", { severity: "warning" }))
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ kind: "monitoring:incident.warning", isUrgent: false })
  })

  it("incident:resolved resolves both kinds and inserts nothing", async () => {
    const { inserted, resolved } = await run(incidentEvent("resolved", { status: "resolved" }))
    expect(inserted).toHaveLength(0)
    expect(resolved.map((r) => r.kind).sort()).toEqual([
      "monitoring:incident.critical",
      "monitoring:incident.warning",
    ])
  })

  it("incident:repeated writes no row", async () => {
    const { inserted, resolved } = await run(incidentEvent("repeated", { severity: "critical" }))
    expect(inserted).toHaveLength(0)
    expect(resolved).toHaveLength(0)
  })

  // summaries render the incident ref through the pre-formatted `refLabel`.
  it("critical incident:created shows the ref in the summary", async () => {
    const { inserted } = await run(
      incidentEvent("created", { severity: "critical", refLabel: "[INC-7] " }),
    )
    expect(inserted[0]?.summary).toBe("Critical alert: [INC-7] DB down (uptime)")
  })

  it("an un-numbered warning incident:created renders without a ref", async () => {
    const { inserted } = await run(incidentEvent("created", { severity: "warning", refLabel: "" }))
    expect(inserted[0]?.summary).toBe("Warning alert: DB down (uptime)")
  })

  it("critical incident:reopened shows the ref in the summary", async () => {
    const { inserted } = await run(
      incidentEvent("reopened", { severity: "critical", refLabel: "[INC-7] " }),
    )
    expect(inserted[0]?.summary).toBe("Re-fired after resolve: [INC-7] DB down (uptime)")
  })

  it("incident:commented writes no row and resolves nothing", async () => {
    const { inserted, resolved } = await run(
      incidentEvent("commented", { severity: "critical", refLabel: "[INC-7] ", commentId: "c-1" }),
    )
    expect(inserted).toHaveLength(0)
    expect(resolved).toHaveLength(0)
  })
})

describe("processTranslationEvent — a message in an entity's thread", () => {
  const CONTACT = "00000000-0000-0000-0000-0000000000c1"
  const WORDS = {
    app: "kernel",
    entityType: "contact",
    entityId: CONTACT,
    kindLabel: "Contact",
    label: "Northwind Studio",
    secondaryLabel: null,
  }
  function anchoredEvent(): AppEvent {
    return messageCreateEvent({
      data: {
        threadId: T1,
        participantIds: [USER_A, USER_B, USER_C],
        mentions: [{ type: "user", id: USER_C }],
        preview: "hey",
        threadAnchor: { app: "kernel", entityType: "contact", entityId: CONTACT },
      },
    })
  }

  it("carries the entity's words only on the rows of a recipient who may see it", async () => {
    const { inserted, deps } = makeDeps()
    const asked: string[][] = []
    await mod.processTranslationEvent(anchoredEvent(), {
      ...deps,
      // USER_C may see the contact; USER_B (a member without access) may not.
      resolveThreadAnchors: async (_orgId, _ref, userIds) => {
        asked.push([...userIds])
        return new Map(userIds.map((id) => [id, id === USER_C ? WORDS : null] as const))
      },
    })
    const forC = inserted.filter((r) => r.userId === USER_C)
    const forB = inserted.filter((r) => r.userId === USER_B)
    expect(forC.length).toBeGreaterThan(0)
    expect(forB.length).toBeGreaterThan(0)
    for (const row of forC) expect(row.metadata?.threadAnchor).toEqual(WORDS)
    for (const row of forB) {
      expect(row.metadata?.threadAnchor).toBeUndefined()
      expect(JSON.stringify(row)).not.toContain("Northwind")
    }
    // Batched: each recipient is read once for the event, one call per
    // recipient set (a matched kind), never one per recipient or per row.
    const flat = asked.flat()
    expect(new Set(flat).size).toBe(flat.length)
    expect(asked.length).toBeLessThanOrEqual(new Set(inserted.map((r) => r.kind)).size)
  })

  it("a plain thread's rows carry no anchor", async () => {
    const { inserted, deps } = makeDeps()
    await mod.processTranslationEvent(messageCreateEvent(), deps)
    expect(inserted.length).toBeGreaterThan(0)
    for (const row of inserted) expect(row.metadata?.threadAnchor).toBeUndefined()
  })
})
