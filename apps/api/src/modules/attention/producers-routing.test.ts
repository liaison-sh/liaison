// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S2/S9 (P2-TD): the attention producers route every row. The translator
// (incl. `notify_user`'s agent_notification event), the state materializer
// (computed items, first sighting only) and the digest (cadence off, grid read
// at send time) each obey the RouterDecision.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import type { AttentionItem } from "@liaison/shared"
import { extractRows, sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { attentionItemsRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import type { AttentionLiveItem } from "~/modules/notifications/dispatch"
import type { RouterDecision } from "~/modules/notifications/router"
import type { PendingAttentionRow } from "./digest"
import { defaultLoadUser, runDigestCadenceOnce, runDigestUrgentOnce } from "./digest-jobs"
import { runStateMaterializeOnce } from "./state-materializer"
import { processTranslationEvent, type UserPrefsSnapshot } from "./translator"

const ORG = "00000000-0000-0000-0000-000000000ad0"
const USER = "00000000-0000-0000-0000-000000000ad1"
const OFF = "00000000-0000-0000-0000-000000000ad2"

function prefs(over: Partial<UserPrefsSnapshot> = {}): UserPrefsSnapshot {
  return {
    digestCadence: "daily",
    workHoursStart: "00:00",
    workHoursEnd: "00:00",
    // ISO weekdays (1 = Monday … 7 = Sunday): every day, so no run falls outside them.
    workDays: [1, 2, 3, 4, 5, 6, 7],
    timezone: "UTC",
    ...over,
  }
}

/** The event `handleNotifyUser` queues (skills-routines-tools.ts). */
function notifyUserEvent(): AppEvent {
  return {
    app: "kernel",
    entity: "agent_notification",
    action: "create",
    entityId: crypto.randomUUID(),
    orgId: ORG,
    actorId: USER,
    actorType: "agent",
    timestamp: new Date().toISOString(),
    data: { summary: "Your report is ready", urgency: 40, targetUserIds: [USER] },
  }
}

describe("translator: notify_user is routed", () => {
  function run(p: UserPrefsSnapshot) {
    const inserted: Array<{ digestState: string }> = []
    const live: Array<{ d: RouterDecision; i: AttentionLiveItem }> = []
    return processTranslationEvent(notifyUserEvent(), {
      loadPreferences: async () => p,
      insertAttentionRow: async (row) => {
        inserted.push(row)
      },
      loadPushDeviceUsers: async (ids) => new Set(ids),
      dispatchLive: async (d, i) => {
        live.push({ d, i })
      },
    }).then(() => ({ inserted, live }))
  }

  it("default grid: the row is inserted and goes live on push and desktop", async () => {
    const { inserted, live } = await run(prefs())
    expect(inserted).toHaveLength(1)
    expect(inserted[0].digestState).toBe("pending")
    expect(live).toHaveLength(1)
    expect(live[0].d.group).toBe("agent")
    expect(live[0].d.channels.push.deliver).toBe(true)
    expect(live[0].d.channels.desktop.deliver).toBe(true)
    expect(live[0].i.summary).toBe("Your report is ready")
  })

  it("agent cells off: the feed keeps it, push/desktop/email are suppressed", async () => {
    const { inserted, live } = await run(
      prefs({
        notificationChannels: { grid: { agent: { push: false, desktop: false, email: false } } },
      }),
    )
    expect(inserted).toHaveLength(1)
    expect(inserted[0].digestState).toBe("suppressed")
    expect(live[0].d.channels.push).toEqual({ deliver: false, reason: "grid_off" })
    expect(live[0].d.channels.desktop).toEqual({ deliver: false, reason: "grid_off" })
  })

  it("a re-delivered event whose row already existed does not go live twice", async () => {
    const live: RouterDecision[] = []
    await processTranslationEvent(notifyUserEvent(), {
      loadPreferences: async () => prefs(),
      insertAttentionRow: async (row) => ({
        id: "r1",
        userId: row.userId,
        app: row.app,
        entityType: row.entityType,
        entityId: row.entityId,
        kind: row.kind,
        inserted: false,
      }),
      dispatchLive: async (d) => {
        live.push(d)
      },
    })
    expect(live).toHaveLength(0)
  })
})

function computed(over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "c1",
    app: "kernel",
    entity: "approval_request",
    entityId: "ap-1",
    kind: "approval_pending",
    summary: "Approve the refund",
    urgency: 50,
    occurredAt: new Date().toISOString(),
    action: { type: "decide_approval", approvalId: "ap-1" },
    ...over,
  } as AttentionItem
}

describe("state materializer: computed items routed on first sighting", () => {
  beforeEach(() => {
    resetAppRegistries()
    attentionItemsRegistry.set(["*", "kernel"], {
      handler: "providerFn",
      bundlePath: "/fake/bundle",
      core: true,
    })
  })

  function deps(items: AttentionItem[], known: Set<string>) {
    const upserted: Array<{ sourceKey: string; digestState: string; isUrgent: boolean }> = []
    const live: RouterDecision[] = []
    return {
      upserted,
      live,
      deps: {
        listActiveUsers: async () => [USER],
        invokeProvider: async () => items,
        listKnownSourceKeys: async () => known,
        upsertEmailOnlyRow: async (row: {
          sourceKey: string
          digestState: "pending" | "suppressed"
          isUrgent: boolean
        }) => {
          upserted.push(row)
          known.add(row.sourceKey)
          return true
        },
        dispatchLive: async (d: RouterDecision) => {
          live.push(d)
        },
      },
    }
  }

  it("a first-seen approval (any urgency) is routed live once, then only refreshed", async () => {
    const known = new Set<string>()
    const a = deps([computed()], known)
    await runStateMaterializeOnce({ orgId: ORG }, a.deps)
    expect(a.upserted).toHaveLength(1)
    expect(a.live).toHaveLength(1)
    expect(a.live[0].group).toBe("approvals")
    // The provider ran as the user, so they are an approver: urgent.
    expect(a.live[0].urgent).toBe(true)

    const b = deps([computed()], known)
    await runStateMaterializeOnce({ orgId: ORG }, b.deps)
    expect(b.upserted).toHaveLength(1) // refresh
    expect(b.live).toHaveLength(0) // routed once
  })

  // A SEED WRITES THE WORLD, IT DOES NOT HAPPEN TO ANYONE. A demo reseed writes
  // pending approvals hours old and clears the attention rows, so every one was
  // a first sighting inside the live window: about eight approval pushes landed
  // on phones on every reseed (walk 2026-10-19, #17).
  it("a seeded approval is neither recorded nor pushed", async () => {
    const a = deps([computed({ metadata: { seeded: true } })], new Set())
    await runStateMaterializeOnce({ orgId: ORG }, a.deps)
    expect(a.upserted).toHaveLength(0)
    expect(a.live).toHaveLength(0)
  })

  it("an item first seen more than a day after it appeared is recorded but not pushed", async () => {
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
    const a = deps([computed({ occurredAt: old })], new Set())
    await runStateMaterializeOnce({ orgId: ORG }, a.deps)
    expect(a.upserted).toHaveLength(1)
    expect(a.live).toHaveLength(0)
  })
})

describe("digest: cadence off and the grid at send time (S9)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'ProducersOrg', 'producers-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, name] of [
      [USER, "user"],
      [OFF, "off"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`producers-${name}@t.com`}, ${name}, 'x') ON CONFLICT (id) DO NOTHING`
    }
    await sql`INSERT INTO kernel.user_preferences (user_id, digest_cadence)
      VALUES (${OFF}, 'off') ON CONFLICT (user_id) DO UPDATE SET digest_cadence = 'off'`
    await sql`INSERT INTO kernel.user_preferences (user_id, digest_cadence, notification_channels)
      VALUES (${USER}, 'immediate', ${JSON.stringify({ grid: { work: { email: false } } })}::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET digest_cadence = 'immediate',
        notification_channels = EXCLUDED.notification_channels`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${USER}, ${OFF})`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("a user on cadence off receives no urgent digest, whatever a row says", async () => {
    const [row] = extractRows<{ id: string }>(
      await sql`INSERT INTO kernel.attention_events
      (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type,
       occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
      VALUES (${ORG}, ${OFF}, 'kernel', 'digest', 'd1', 'system_alert', 90, 'x', 'system',
              now(), true, 'pending', now() - interval '1 minute', false) RETURNING id`,
    )
    const seen: string[] = []
    // Every double records, nothing writes: the real urgent query decides.
    await runDigestUrgentOnce({
      loadUser: async () => null,
      markRowsSuppressed: async (ids) => {
        seen.push(...ids)
      },
      provider: { send: async () => {} } as never,
    })
    expect(seen).not.toContain(row.id)
  })

  it("a pending row whose group's email cell is now off is suppressed, not sent", async () => {
    await sql`INSERT INTO kernel.attention_events
      (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_type,
       occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
      VALUES (${ORG}, ${USER}, 'tickets', 'ticket', 't1', 'sla_risk', 40, 'late', 'system',
              now(), false, 'pending', now() - interval '1 minute', false),
             (${ORG}, ${USER}, 'kernel', 'agent_notification', 'n1', 'agent_notification', 40,
              'ready', 'system', now(), false, 'pending', now() - interval '1 minute', false)`
    const user = await defaultLoadUser(USER)
    expect(user?.grid?.work.email).toBe(false)
    const sent: string[][] = []
    await runDigestCadenceOnce({
      fetchCadencePending: async () => {
        const rows = extractRows<{ id: string; kind: string }>(
          await sql`SELECT id, kind FROM kernel.attention_events
            WHERE user_id = ${USER} AND digest_state = 'pending'`,
        )
        return rows.map(
          (r) =>
            ({
              id: r.id,
              orgId: ORG,
              userId: USER,
              app: "x",
              entityType: "x",
              entityId: "x",
              kind: r.kind,
              urgency: 40,
              summary: "s",
              isUrgent: false,
              occurredAt: new Date(),
            }) as PendingAttentionRow,
        )
      },
      markRowsSent: async (ids) => {
        sent.push(ids)
      },
      provider: { send: async () => {} } as never,
    })
    const states = extractRows<{ kind: string; digest_state: string }>(
      await sql`SELECT kind, digest_state FROM kernel.attention_events WHERE user_id = ${USER}
        ORDER BY kind`,
    )
    expect(states).toEqual([
      { kind: "agent_notification", digest_state: "pending" }, // markRowsSent is a double
      { kind: "sla_risk", digest_state: "suppressed" },
    ])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(1)
  })
})
