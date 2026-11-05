// SPDX-License-Identifier: FSL-1.1-ALv2
// S17: the agent's notification settings tools. Self only, refused outside a
// live turn a person started, no approval, every change audited with its
// before/after diff and announced by a feed item no setting can silence, and
// every result a small digest.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, onEvent, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { registerSkillRoutineTools } from "~/modules/agent/tools/skills-routines-tools"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerTranslatorConsumer } from "~/modules/attention/translator"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  handleNotificationRulesSet,
  handleNotificationsGet,
  handleNotificationsSet,
  handleThreadMuteSet,
  type NotificationToolContext,
  notificationsSetParams,
  threadMuteSetParams,
} from "./agent-tools"
import { getNotificationSettings } from "./settings"

let orgId: string
let me: string
let other: string

const SCOPES = ["kernel:agent:memory", "kernel:threads:read", "kernel:threads:write"]

function frame(extra: Partial<RunContext> = {}): RunContext {
  const runId = crypto.randomUUID()
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, ...extra }
}

/** Run a handler as `userId`'s agent turn, under that user's RLS. */
function asTurn<T>(
  userId: string,
  fn: (ctx: NotificationToolContext) => Promise<T>,
  opts: { frame?: RunContext | null; originRoutineId?: string } = {},
): Promise<T> {
  const run = () =>
    withRlsContext(
      { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: {} },
      (tx) =>
        fn({
          userId,
          orgId,
          db: tx,
          actorType: "agent",
          ...(opts.originRoutineId ? { originRoutineId: opts.originRoutineId } : {}),
        }),
    )
  const f = opts.frame === undefined ? frame() : opts.frame
  return f ? runContextStore.run(f, run) : run()
}

async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await processOutboxBatch()
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function workPush(userId: string): Promise<boolean> {
  const s = (await asTurn(userId, (ctx) => handleNotificationsGet({}, ctx))) as {
    channelsOn: Record<string, string>
  }
  return s.channelsOn.work!.split(",").includes("push")
}

beforeAll(async () => {
  await acquireTestLock()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
  } as never)
  registerTranslatorConsumer()
  orgId = (await createTestOrg()).id
  me = (await minimal.person(orgId)).id
  other = (await minimal.person(orgId)).id
})

beforeEach(async () => {
  await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${me}, ${other})`
  await sql`DELETE FROM kernel.attention_subscriptions WHERE user_id IN (${me}, ${other})`
})

afterAll(async () => {
  resetEventBus()
  await releaseTestLock()
})

describe("notifications_set", () => {
  it("flips work.push off, returns a small digest, audits the diff and posts a feed item", async () => {
    // Default: work has no push. Turn it on first so the S18 sentence has something to flip.
    await asTurn(me, (ctx) =>
      handleNotificationsSet({ cells: [{ group: "work", channel: "push", on: true }] }, ctx),
    )
    expect(await workPush(me)).toBe(true)
    await drainOutbox()

    const res = await asTurn(me, (ctx) =>
      handleNotificationsSet({ cells: [{ group: "work", channel: "push", on: false }] }, ctx),
    )
    expect(res).toEqual({
      changed: ["work.push: true -> false"],
      now: expect.stringContaining("Phone (push): Direct messages and mentions"),
      note: expect.any(String),
    })
    // Still a small digest: the change plus the settings as plain sentences.
    expect(JSON.stringify(res).length).toBeLessThan(1200)
    expect(await workPush(me)).toBe(false)

    await drainOutbox()
    const audit = await sql<Array<{ changes: any; actor_id: string; actor_type: string }>>`
      SELECT changes, actor_id, actor_type FROM kernel.audit_log
       WHERE org_id = ${orgId} AND action = 'notification_settings.update' AND entity_id = ${me}
       ORDER BY timestamp DESC LIMIT 1`
    expect(audit[0]?.changes.before).toEqual({ "work.push": true })
    expect(audit[0]?.changes.after).toEqual({ "work.push": false })
    expect(audit[0]?.changes.tool).toBe("notifications_set")
    expect(audit[0]?.actor_id).toBe(me)

    const feed = await sql<Array<{ kind: string; summary: string }>>`
      SELECT kind, summary FROM kernel.attention_events
       WHERE org_id = ${orgId} AND user_id = ${me} AND entity_type = 'notification_settings'
       ORDER BY occurred_at DESC LIMIT 1`
    expect(feed[0]?.kind).toBe("system_alert")
    expect(feed[0]?.summary).toBe(
      "Your agent changed your notification settings: Tickets, tasks and knowledge: phone off",
    )
  })

  it("renders the feed item in French for a French user", async () => {
    await sql`INSERT INTO kernel.user_preferences (user_id, language)
              VALUES (${other}, 'fr')
              ON CONFLICT (user_id) DO UPDATE SET language = 'fr'`
    await asTurn(other, (ctx) => handleNotificationsSet({ digestCadence: "hourly" }, ctx))
    await drainOutbox()
    const feed = await sql<Array<{ summary: string }>>`
      SELECT summary FROM kernel.attention_events
       WHERE org_id = ${orgId} AND user_id = ${other} AND entity_type = 'notification_settings'
       ORDER BY occurred_at DESC LIMIT 1`
    expect(feed[0]?.summary).toBe(
      "Votre agent a modifié vos réglages de notification : récapitulatif par mail toutes les heures",
    )
  })

  it("sets the approval reminder frequency (off, weekly) for the caller only, announced", async () => {
    const before = (await asTurn(me, (ctx) => handleNotificationsGet({}, ctx))) as {
      approvalReminder: string
      summary: string
    }
    // Nobody chose: daily.
    expect(before.approvalReminder).toBe("daily")
    expect(before.summary).toContain("waiting for a decision: daily")

    const off = await asTurn(me, (ctx) => handleNotificationsSet({ approvalReminder: "off" }, ctx))
    expect(off).toMatchObject({
      changed: ["approvalReminder: daily -> off"],
      now: expect.stringContaining("waiting for a decision: off"),
    })
    const [row] = await sql<Array<{ notification_channels: any }>>`
      SELECT notification_channels FROM kernel.user_preferences WHERE user_id = ${me}`
    expect(row?.notification_channels).toEqual({ approvalReminder: "off" })
    await drainOutbox()
    const feed = await sql<Array<{ summary: string }>>`
      SELECT summary FROM kernel.attention_events
       WHERE org_id = ${orgId} AND user_id = ${me} AND entity_type = 'notification_settings'
       ORDER BY occurred_at DESC LIMIT 1`
    expect(feed[0]?.summary).toBe(
      "Your agent changed your notification settings: approval reminders off",
    )

    const weekly = await asTurn(me, (ctx) =>
      handleNotificationsSet({ approvalReminder: "weekly" }, ctx),
    )
    expect(weekly).toMatchObject({ changed: ["approvalReminder: off -> weekly"] })
    // The other person keeps the default.
    const theirs = (await asTurn(other, (ctx) => handleNotificationsGet({}, ctx))) as {
      approvalReminder: string
    }
    expect(theirs.approvalReminder).toBe("daily")
    expect(notificationsSetParams.safeParse({ approvalReminder: "hourly" }).success).toBe(false)
  })

  it("a per-app rule switching kernel off does not silence the announcement", async () => {
    await sql`INSERT INTO kernel.attention_subscriptions (user_id, source, kinds, filters, enabled)
              VALUES (${me}, 'kernel', ${["*"]}, '{}'::jsonb, false)`
    await asTurn(me, (ctx) =>
      handleNotificationsSet({ workHours: { start: "08:00", end: "18:00" } }, ctx),
    )
    await drainOutbox()
    const feed = await sql<Array<{ summary: string }>>`
      SELECT summary FROM kernel.attention_events
       WHERE org_id = ${orgId} AND user_id = ${me} AND entity_type = 'notification_settings'
         AND summary LIKE '%08:00-18:00%'`
    expect(feed).toHaveLength(1)
  })

  it("is refused in a routine, a background run, an agents_ask turn and outside any turn", async () => {
    const cells = [{ group: "work" as const, channel: "push" as const, on: true }]
    const cases: Array<Parameters<typeof asTurn>[2]> = [
      { frame: frame({ routineId: crypto.randomUUID(), background: true }) },
      { originRoutineId: crypto.randomUUID() },
      { frame: frame({ background: true }) },
      { frame: frame({ nestingDepth: 1 }) },
      { frame: frame({ coordinated: true }) },
      { frame: null },
    ]
    for (const opts of cases) {
      const res = (await asTurn(me, (ctx) => handleNotificationsSet({ cells }, ctx), opts)) as {
        error?: { code: string }
      }
      expect(res.error?.code).toBe("E_INTERACTIVE_ONLY")
    }
    expect(await workPush(me)).toBe(false)
  })

  it("stores quiet hours as said (21:00-08:00 weekdays, all weekend) as work 08:00-21:00 Mon-Fri", async () => {
    process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS = "on"
    const res = (await asTurn(me, (ctx) =>
      handleNotificationsSet(
        { quietHours: { from: "21:00", to: "08:00", allWeekend: true, timezone: "Europe/Paris" } },
        ctx,
      ),
    )) as { changed: string[]; now: string }
    // Before: the default quiet-hours window (08:00-20:00 on weekdays, rule 8).
    expect(res.changed).toContain("workHours: 08:00-20:00 -> 08:00-21:00")
    expect(res.now).toContain("21:00 to 08:00 on Mon-Fri, and all day on Sat, Sun")
    const s = await withRlsContext(
      { actorType: "user", userId: me, orgId, scopes: SCOPES, dimensionGrants: {} },
      (tx) => getNotificationSettings(me, orgId, tx),
    )
    expect(s.workHours).toEqual({
      start: "08:00",
      end: "21:00",
      days: [1, 2, 3, 4, 5],
      timezone: "Europe/Paris",
      explicit: true,
      timezoneSource: "user",
      quiet: true,
    })
    delete process.env.NOTIFICATIONS_DEFAULT_QUIET_HOURS
  })

  it("refuses quietHours mixed with workHours instead of guessing", async () => {
    const res = (await asTurn(me, (ctx) =>
      handleNotificationsSet(
        { quietHours: { from: "21:00", to: "08:00" }, workHours: { start: "09:00", end: "17:00" } },
        ctx,
      ),
    )) as { error?: { code: string } }
    expect(res.error?.code).toBe("E_INVALID_SETTING")
  })

  it("S17: notifications_set accepts session_done/push off, and a full 33-cell grid", async () => {
    const res = await asTurn(me, (ctx) =>
      handleNotificationsSet(
        { cells: [{ group: "session_done", channel: "push", on: false }] },
        ctx,
      ),
    )
    expect((res as { changed: string[] }).changed).toEqual(["session_done.push: true -> false"])
    const s = await withRlsContext(
      { actorType: "user", userId: me, orgId, scopes: SCOPES, dimensionGrants: {} },
      (tx) => getNotificationSettings(me, orgId, tx),
    )
    expect(s.grid.session_done).toEqual({ in_app: true, desktop: true, push: false, email: false })
    await drainOutbox()
    const feed = await sql<Array<{ summary: string }>>`
      SELECT summary FROM kernel.attention_events
       WHERE org_id = ${orgId} AND user_id = ${me} AND entity_type = 'notification_settings'
       ORDER BY occurred_at DESC LIMIT 1`
    expect(feed[0]?.summary).toBe(
      "Your agent changed your notification settings: Computer session done: phone off",
    )

    const groups = [
      "direct",
      "replies",
      "approvals",
      "decisions",
      "work",
      "mail",
      "agent",
      "session_needs_you",
      "session_done",
      "session_failed",
      "monitoring",
      "system",
    ] as const
    const cells = groups.flatMap((group) =>
      (["desktop", "push", "email"] as const).map((channel) => ({ group, channel, on: true })),
    )
    // A literal on purpose: adding a group must update this number knowingly.
    expect(cells).toHaveLength(36)
    expect(notificationsSetParams.safeParse({ cells }).success).toBe(true)
    expect(notificationsSetParams.safeParse({ cells: [...cells, cells[0]] }).success).toBe(false)
  })

  it("S17: monitoring is a switchable group and the change notice is labelled", async () => {
    const res = await asTurn(me, (ctx) =>
      handleNotificationsSet({ cells: [{ group: "monitoring", channel: "push", on: false }] }, ctx),
    )
    // Monitoring push is on by default.
    expect((res as { changed: string[] }).changed).toEqual(["monitoring.push: true -> false"])
    const s = await withRlsContext(
      { actorType: "user", userId: me, orgId, scopes: SCOPES, dimensionGrants: {} },
      (tx) => getNotificationSettings(me, orgId, tx),
    )
    expect(s.grid.monitoring).toEqual({ in_app: true, desktop: true, push: false, email: false })
    await drainOutbox()
    const feed = await sql<Array<{ summary: string }>>`
      SELECT summary FROM kernel.attention_events
       WHERE org_id = ${orgId} AND user_id = ${me} AND entity_type = 'notification_settings'
       ORDER BY occurred_at DESC LIMIT 1`
    expect(feed[0]?.summary).toBe(
      "Your agent changed your notification settings: Monitoring incidents: phone off",
    )
  })

  it("S17: the cells description names the monitoring group", () => {
    expect(notificationsSetParams.shape.cells.description).toContain(
      "monitoring (monitoring incidents)",
    )
  })

  it("cannot target another user: the schema has no user field and rejects one", () => {
    const parsed = notificationsSetParams.safeParse({ userId: other, digestCadence: "off" })
    expect(parsed.success).toBe(false)
    expect(
      threadMuteSetParams.safeParse({ threadId: crypto.randomUUID(), muted: true, userId: other })
        .success,
    ).toBe(false)
  })
})

describe("notifications_get", () => {
  it("reads the person's own settings with no agent run around the call (their MCP client)", async () => {
    const res = (await asTurn(me, (ctx) => handleNotificationsGet({}, ctx), { frame: null })) as {
      summary?: string
      error?: unknown
    }
    expect(res.error).toBeUndefined()
    expect(res.summary).toContain("Quiet hours: none set")
  })

  it("is still refused in a routine run", async () => {
    const res = (await asTurn(me, (ctx) => handleNotificationsGet({}, ctx), {
      frame: frame({ routineId: crypto.randomUUID() }),
    })) as { error?: { code: string } }
    expect(res.error?.code).toBe("E_INTERACTIVE_ONLY")
  })
})

describe("notification_rules_set", () => {
  it("refuses to silence an app everywhere without the explicit confirmation", async () => {
    const res = await asTurn(me, (ctx) =>
      handleNotificationRulesSet({ app: "projects", enabled: false }, ctx),
    )
    expect(res).toMatchObject({ error: { code: "E_USE_CHANNEL_SETTING" } })
    const rows = await sql`
      SELECT 1 FROM kernel.attention_subscriptions WHERE source = 'projects' AND user_id = ${me}`
    expect(rows.length).toBe(0)
  })

  it("switches one app off for the caller only, audited", async () => {
    const res = await asTurn(me, (ctx) =>
      handleNotificationRulesSet({ app: "tickets", enabled: false, everywhere: true }, ctx),
    )
    expect(res).toMatchObject({ changed: ["tickets: default -> off (all)"] })
    const rows = await sql<Array<{ user_id: string; enabled: boolean }>>`
      SELECT user_id, enabled FROM kernel.attention_subscriptions WHERE source = 'tickets'
         AND user_id IN (${me}, ${other})`
    expect([...rows]).toEqual([{ user_id: me, enabled: false }])
    await drainOutbox()
    const audit = await sql<Array<{ changes: any }>>`
      SELECT changes FROM kernel.audit_log
       WHERE org_id = ${orgId} AND action = 'notification_settings.update' AND entity_id = ${me}
         AND changes->>'tool' = 'notification_rules_set'`
    expect(audit[0]?.changes.after).toEqual({ "rule.tickets": "off (all)" })
  })
})

describe("thread_mute_set", () => {
  const stateFrames: Record<string, unknown>[] = []
  // Registered after the file's beforeAll reset the bus.
  beforeAll(() => {
    onEvent(
      async (event) => {
        if (event.app === "kernel" && event.entity === "read_state") {
          stateFrames.push(event.data as Record<string, unknown>)
        }
      },
      { delivery: "per-replica" },
    )
  })

  it("mutes a thread the user is in, refuses one they are not in", async () => {
    const t = { id: await minimal.thread(orgId, me) }

    const res = await asTurn(me, (ctx) =>
      handleThreadMuteSet({ threadId: t!.id, muted: true }, ctx),
    )
    expect(res).toMatchObject({ changed: ["thread muted"] })
    const [state] = await sql<Array<{ is_muted: boolean }>>`
      SELECT is_muted FROM kernel.user_thread_state WHERE user_id = ${me} AND thread_id = ${t!.id}`
    expect(state?.is_muted).toBe(true)
    // Nothing is sent from inside the tool's transaction: the frame waits on
    // the outbox, which only ever holds committed events.
    await new Promise((r) => setTimeout(r, 30))
    expect(stateFrames.filter((d) => d.threadId === t.id)).toEqual([])
    await drainOutbox()
    // The user's other devices hear the new flag, and only theirs.
    for (let i = 0; i < 50 && !stateFrames.some((d) => d.threadId === t.id); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const muteFrames = stateFrames.filter((d) => d.threadId === t.id)
    expect(muteFrames).toEqual([
      {
        forUserId: me,
        kind: "thread_state",
        threadId: t.id,
        isArchived: false,
        isMuted: true,
        isPinned: false,
        notifyAllPosts: false,
      },
    ])

    const refused = (await asTurn(other, (ctx) =>
      handleThreadMuteSet({ threadId: t!.id, muted: true }, ctx),
    )) as { error?: { code: string } }
    expect(refused.error?.code).toBe("E_NOT_A_PARTICIPANT")
  })

  it("a mute whose transaction rolls back tells no device", async () => {
    const t = { id: await minimal.thread(orgId, me) }
    await expect(
      asTurn(me, async (ctx) => {
        await handleThreadMuteSet({ threadId: t.id, muted: true }, ctx)
        throw new Error("the tool pipeline failed after the handler")
      }),
    ).rejects.toThrow("the tool pipeline failed")
    await drainOutbox()
    await new Promise((r) => setTimeout(r, 30))
    expect(stateFrames.filter((d) => d.threadId === t.id)).toEqual([])
  })
})

describe("registration and discovery", () => {
  it("registers the four tools ungated, deferred and found by tool_search", async () => {
    const ORG = crypto.randomUUID()
    await registerSkillRoutineTools(ORG)
    try {
      for (const name of [
        "notifications_get",
        "notifications_set",
        "notification_rules_set",
        "thread_mute_set",
      ]) {
        const def = toolRegistry.get([ORG, "kernel", name])
        expect(def?.deferLoading).toBe(true)
        expect(def?.requiredScopes).toEqual(["kernel:agent:memory"])
      }
      for (const query of ["notification", "notify", "mute", "quiet hours"]) {
        const res = await runContextStore.run(frame({ discoveredTools: new Set() }), () =>
          handleToolSearch({ query }, { orgId: ORG, userId: me, scopes: SCOPES }),
        )
        const names = res.matches.map((m) => m.name)
        expect(names.some((n) => /notification|thread_mute/.test(n))).toBe(true)
      }
    } finally {
      toolRegistry.deleteByPrefix([ORG])
    }
  })
})
