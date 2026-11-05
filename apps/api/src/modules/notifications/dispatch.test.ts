// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S2/S4 (P2-TD): an attention row goes live (push, desktop) only through a
// RouterDecision, and quiet time holds push back only for explicit work hours
// and never for an urgent item. Real router against real rows; only the wire
// and the desktop emitter are doubles.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { pushRouted } from "~/modules/push/fanout-consumer"
import { pushCollapseId, pushThreadId } from "~/modules/push/sender"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"
import { BurstTestAccess } from "./burst"
import { desktopTag } from "./desktop-emitter"
import { type DesktopNotifyPayload, registerDesktopEmitter } from "./desktop-hook"
import { dispatchAttentionLive, emailEnqueue, REDACTED_ATTENTION_BODY } from "./dispatch"
import { type RouterItem, resolveChannels } from "./router"

const ORG = "00000000-0000-0000-0000-0000000009d0"
const QUIET = "00000000-0000-0000-0000-0000000009d1" // explicit 09-17 Mon-Fri UTC
const PLAIN = "00000000-0000-0000-0000-0000000009d2" // no preferences row

// Monday 2026-09-28 20:00 UTC: outside 09-17.
const EVENING = new Date("2026-09-28T20:00:00.000Z")

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

let n = 0
async function goLive(userId: string, item: RouterItem, send: ReturnType<typeof spy>["send"]) {
  n += 1
  const decision = await resolveChannels({ userId, orgId: ORG }, item, { now: EVENING })
  await dispatchAttentionLive(
    decision,
    {
      notifyId: `attention:dispatch-test-${n}`,
      summary: "Something needs you",
      app: item.app,
      entityType: "x",
      entityId: `e${n}`,
    },
    { pushDeps: { send, badgeCount: async () => 0 } },
  )
  return decision
}

const agentAlert: RouterItem = { kind: "agent_notification", app: "kernel", isUrgent: false }
const urgentAlert: RouterItem = { kind: "agent_notification", app: "kernel", isUrgent: true }

describe("dispatchAttentionLive (routed)", () => {
  // Not a burst (burst.ts): every case starts from none.
  beforeEach(async () => {
    await BurstTestAccess.resetOrg(ORG)
  })

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'DispatchOrg', 'dispatch-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, name] of [
      [QUIET, "quiet"],
      [PLAIN, "plain"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`dispatch-${name}@t.com`}, ${name}, 'x') ON CONFLICT (id) DO NOTHING`
      await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
        VALUES (${ORG}, ${id}, 'ios', ${`dispatch-token-${name}`})`
    }
    await sql`INSERT INTO kernel.user_preferences
        (user_id, work_hours_start, work_hours_end, work_days, timezone, notification_channels)
      VALUES (${QUIET}, '09:00', '17:00', '{1,2,3,4,5}', 'UTC',
              ${JSON.stringify({ workHoursExplicit: true })}::jsonb)
      ON CONFLICT (user_id) DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.push_tokens WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_preferences WHERE user_id IN (${QUIET}, ${PLAIN})`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  afterEach(() => registerDesktopEmitter(null))

  it("quiet time (explicit work hours) holds a non-urgent push back", async () => {
    const sender = spy()
    const d = await goLive(QUIET, agentAlert, sender.send)
    expect(d.channels.push).toEqual({ deliver: false, reason: "quiet_time" })
    expect(sender.calls).toHaveLength(0)
  })

  it("rule 8: an urgent item at quiet time waits (only an on-call incident crosses)", async () => {
    const sender = spy()
    await goLive(QUIET, urgentAlert, sender.send)
    expect(sender.calls).toHaveLength(0)
  })

  it("non-explicit work hours at 20:00 UTC push (no quiet time on defaults)", async () => {
    const sender = spy()
    await goLive(PLAIN, agentAlert, sender.send)
    expect(sender.calls).toHaveLength(1)
  })

  it("a chat-group row never goes live (its message event did)", async () => {
    const sender = spy()
    const raised: string[] = []
    registerDesktopEmitter((_d, p) => {
      raised.push(p.notifyId)
    })
    await goLive(PLAIN, { kind: "mention", app: "kernel", isUrgent: false }, sender.send)
    expect(sender.calls).toHaveLength(0)
    expect(raised).toHaveLength(0)
  })

  it("raises the desktop hook for a non-chat group whose desktop cell is on", async () => {
    const raised: string[] = []
    registerDesktopEmitter((_d, p) => {
      raised.push(p.route)
    })
    await goLive(PLAIN, agentAlert, spy().send)
    expect(raised).toEqual([`attention/kernel/x/e${n}`])
  })

  it("an item carrying requiredScopes goes live with no derived text (D14), push and desktop", async () => {
    const sender = spy()
    const desktop: Array<{ title: string; body: string }> = []
    registerDesktopEmitter((_d, p) => {
      desktop.push({ title: p.title, body: p.body })
    })
    n += 1
    const decision = await resolveChannels({ userId: PLAIN, orgId: ORG }, agentAlert, {
      now: EVENING,
    })
    await dispatchAttentionLive(
      decision,
      {
        notifyId: `attention:dispatch-test-${n}`,
        summary: "Deal 42 closes Friday at 1.2M",
        app: "kernel",
        entityType: "x",
        entityId: `e${n}`,
        requiredScopes: ["apv:deals:read"],
      },
      { pushDeps: { send: sender.send, badgeCount: async () => 0 } },
    )
    expect(sender.calls).toHaveLength(1)
    const wire = JSON.stringify(sender.calls[0].payload)
    expect(wire).not.toContain("Deal 42")
    expect(wire).not.toContain("apv:deals:read")
    expect(sender.calls[0].payload.title).toBe("Agent and routine alerts")
    expect(sender.calls[0].payload.body).toBe(REDACTED_ATTENTION_BODY)
    expect(desktop).toEqual([{ title: "Agent and routine alerts", body: REDACTED_ATTENTION_BODY }])
  })

  it("an unreadable requiredScopes value fails closed; an empty one keeps the summary", async () => {
    for (const [scopes, expected] of [
      ["garbage" as unknown as string[], REDACTED_ATTENTION_BODY],
      [[], "Plain summary"],
    ] as const) {
      const sender = spy()
      n += 1
      const decision = await resolveChannels({ userId: PLAIN, orgId: ORG }, agentAlert, {
        now: EVENING,
      })
      await dispatchAttentionLive(
        decision,
        {
          notifyId: `attention:dispatch-test-${n}`,
          summary: "Plain summary",
          app: "kernel",
          entityType: "x",
          entityId: `e${n}`,
          requiredScopes: scopes as string[],
        },
        { pushDeps: { send: sender.send, badgeCount: async () => 0 } },
      )
      expect(sender.calls[0]?.payload.body).toBe(expected)
    }
  })

  it("a thread-less item's push carries its route and an attention deep link (LIF-18)", async () => {
    const sender = spy()
    n += 1
    const approvalId = "5f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
    const decision = await resolveChannels({ userId: PLAIN, orgId: ORG }, urgentAlert, {
      now: EVENING,
    })
    await dispatchAttentionLive(
      decision,
      {
        notifyId: `attention:dispatch-test-${n}`,
        summary: "Approve the reply",
        app: "kernel",
        entityType: "approval_request",
        entityId: approvalId,
      },
      { pushDeps: { send: sender.send, badgeCount: async () => 0 } },
    )
    expect(sender.calls).toHaveLength(1)
    const sent = sender.calls[0].payload
    expect(sent.route).toBe(`attention/kernel/approval_request/${approvalId}`)
    expect(sent.deepLink).toBe(`liaison://attention/kernel/approval_request/${approvalId}`)
    // Rule 5: the key the phone asks the server about, to withdraw the banner
    // once this approval is decided or its row read, and never before.
    expect(sent.settle).toBe(`attention/kernel/approval_request/${approvalId}`)
  })

  it("an item with a thread keeps the thread deep link and carries no route", async () => {
    const sender = spy()
    n += 1
    const decision = await resolveChannels({ userId: PLAIN, orgId: ORG }, urgentAlert, {
      now: EVENING,
    })
    await dispatchAttentionLive(
      decision,
      {
        notifyId: `attention:dispatch-test-${n}`,
        summary: "Routine output",
        app: "kernel",
        entityType: "x",
        entityId: `e${n}`,
        threadId: "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      },
      { pushDeps: { send: sender.send, badgeCount: async () => 0 } },
    )
    expect(sender.calls[0].payload.deepLink).toBe(
      "liaison://thread/7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    )
    expect(sender.calls[0].payload.route).toBeUndefined()
    // Settled by the item itself, not by its thread's read mark.
    expect(sender.calls[0].payload.settle).toBe(`attention/kernel/x/e${n}`)
  })

  it("an urgent item in a thread keeps its own banner: a later message of the thread does not replace it", async () => {
    const sender = spy()
    const raised: DesktopNotifyPayload[] = []
    registerDesktopEmitter((_d, p) => {
      raised.push(p)
    })
    const threadId = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e"
    n += 1
    const decision = await resolveChannels({ userId: PLAIN, orgId: ORG }, urgentAlert, {
      now: EVENING,
    })
    await dispatchAttentionLive(
      decision,
      {
        notifyId: `attention:dispatch-test-${n}`,
        summary: "Approve the refund",
        app: "kernel",
        entityType: "x",
        entityId: `e${n}`,
        threadId,
      },
      { pushDeps: { send: sender.send, badgeCount: async () => 0 } },
    )
    const approval = sender.calls[0]?.payload
    expect(approval).toBeDefined()
    // The ordinary message of the same thread keys on the thread.
    const message: PushPayload = { type: "mention", threadId, deepLink: "x", badgeCount: 0 }
    expect(pushCollapseId(message)).toBe(`thread:${threadId}`)
    expect(pushCollapseId(approval as PushPayload)).not.toBe(pushCollapseId(message))
    // Still stacked with its conversation.
    expect(pushThreadId(approval as PushPayload)).toBe(threadId)
    const later = desktopTag({
      notifyId: "message:m",
      title: "",
      body: "",
      route: `thread/${threadId}`,
    })
    expect(raised).toHaveLength(1)
    expect(desktopTag(raised[0] as DesktopNotifyPayload)).not.toBe(later)
  })

  it("emailEnqueue: delivered is pending at its eligibility, suppressed otherwise", async () => {
    const at = new Date("2026-09-28T10:00:00.000Z")
    const on = await resolveChannels({ userId: PLAIN, orgId: ORG }, agentAlert, { now: at })
    expect(emailEnqueue(on, at)).toEqual({ digestState: "pending", digestEligibleAt: at })
    const off = await resolveChannels({ userId: PLAIN, orgId: ORG }, agentAlert, {
      now: at,
      loadContext: async () => {
        throw new Error("db down")
      },
    })
    // Degraded: left pending for the digest to decide again.
    expect(emailEnqueue(off, at).digestState).toBe("pending")
  })
})

// S2: a push cannot be sent without a decision built by the router. The
// function below is never called; it only has to typecheck.
export function _typecheckOnly(): void {
  void pushRouted(
    // @ts-expect-error a hand-made object is not a RouterDecision (branded)
    { userId: "u", orgId: "o", channels: { push: { deliver: true } } },
    {
      notifyId: "n",
      title: "t",
      body: "b",
    },
  )
  void dispatchAttentionLive(
    // @ts-expect-error same for the attention live path
    { group: "agent", channels: { push: { deliver: true }, desktop: { deliver: true } } },
    { notifyId: "n", summary: "s", app: "a", entityType: "e", entityId: "i" },
  )
  // @ts-expect-error and for the digest enqueue
  void emailEnqueue({ channels: { email: { deliver: true } } }, new Date())
}
