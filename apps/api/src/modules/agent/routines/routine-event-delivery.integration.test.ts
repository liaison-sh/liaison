// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every customer message gets its triage run. Prod 2026-09-29 to 2026-10-16:
// the support routine had no tickets tool, every tick reported itself
// "Blocked", every run row read "succeeded", and 40 tickets went untriaged with
// nothing on any board. These cases pin the three halves of the fix against
// the real worker, the real audit log rows and the real monitoring handler:
//   - a tick that could not do its job is a FAILED run, linked to its event;
//   - a failed event run raises ONE incident per routine, resolved by the
//     routine's next successful run;
//   - the reconciler fires the routine again for an event with no successful
//     run, never for a served, closed or answered one, once at a time, at most
//     maxRetries times.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { agentNoticeStoredText } from "@liaison/shared"
import { and, sql as dsql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  agents as agentsTbl,
  auditLog,
  messages as kernelMessages,
  routineRuns,
  routines as routinesTbl,
  users,
} from "~/db/schema/kernel"
import {
  type ReconcileOptions,
  RoutineEventReconcilerTestAccess,
  reconcileEventRoutines,
} from "~/modules/agent/routines/routine-event-reconciler"
import {
  type IncidentEnvelope,
  RoutineIncidentTestAccess,
  runFailedDedupKey,
  undeliveredDedupKey,
} from "~/modules/agent/routines/routine-incident"
import { judgeRoutineTick } from "~/modules/agent/routines/routine-tick-outcome"
import { type RoutineTriggerEvent, runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { webhookHandlers } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { clearRedisPatterns } from "~/tests/route-test-setup"
import { makeCtx } from "../../../../../../bundled-apps/monitoring/src/test-ctx"
import { alertWebhookHandler } from "../../../../../../bundled-apps/monitoring/src/webhooks"

const HOUR = 60 * 60 * 1000

let orgId: string
let userId: string

async function makeEventRoutine(): Promise<typeof routinesTbl.$inferSelect> {
  const [row] = await withPrivilegedDb(orgId, "red-routine", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        name: `support-${crypto.randomUUID().slice(0, 6)}`,
        description: "triage",
        kind: "event",
        event: "tickets:message:create",
        prompt: "triage the ticket",
        scopes: [],
        enabled: true,
        status: "active",
        visibility: "personal",
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning(),
  )
  return row
}

/** A ticket with one message, the message `ageMs` old. */
async function makeTicketMessage(opts: {
  kind?: "inbound" | "outbound"
  status?: string
  ageMs: number
}): Promise<{ ticketId: string; messageId: string; at: Date }> {
  const at = new Date(Date.now() - opts.ageMs)
  return withPrivilegedDb(orgId, "red-ticket", async (tx) => {
    const [t] = extractRows<{ id: string }>(
      await tx.execute(dsql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
          sla_elapsed_seconds, message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`ticket_${crypto.randomUUID().slice(0, 8)}`}, 'Help',
          ${opts.status ?? "open"}, 'normal', 'manual', 'internal',
          ${crypto.randomUUID().slice(0, 12)}, 3600, now() + interval '1 hour', now(),
          0, 1, ${at.toISOString()}::timestamptz, now()
        ) RETURNING id`),
    )
    const [m] = extractRows<{ id: string }>(
      await tx.execute(dsql`
        INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, from_email, from_name, sent_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, ${t!.id}, ${opts.kind ?? "inbound"}, 'c@example.com', 'C',
                ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz, now())
        RETURNING id`),
    )
    return { ticketId: t!.id, messageId: m!.id, at }
  })
}

/** Another inbound message on the same ticket. */
async function addInbound(
  ticketId: string,
  ageMs: number,
): Promise<{ ticketId: string; messageId: string; at: Date }> {
  const at = new Date(Date.now() - ageMs)
  const [m] = await withPrivilegedDb(orgId, "red-inbound", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(dsql`
        INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, from_email, from_name, sent_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', 'c@example.com', 'C',
                ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz, now())
        RETURNING id`),
    ),
  )
  return { ticketId, messageId: m!.id, at }
}

async function addReply(ticketId: string, at: Date): Promise<void> {
  await withPrivilegedDb(orgId, "red-reply", (tx) =>
    tx.execute(dsql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, from_email, from_name, sent_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${orgId}, ${ticketId}, 'outbound', 'support@example.com', 'Support',
              ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz, now())`),
  )
}

/** The audit row the durable audit consumer writes for the message's event. */
async function auditEvent(m: { ticketId: string; messageId: string; at: Date }): Promise<string> {
  const eventId = crypto.randomUUID()
  await withPrivilegedDb(orgId, "red-audit", (tx) =>
    tx.insert(auditLog).values({
      orgId,
      actorType: "system",
      app: "tickets",
      entityType: "message",
      entityId: m.messageId,
      action: "message.create",
      changes: { ticketId: m.ticketId },
      eventId,
      timestamp: m.at,
    }),
  )
  return eventId
}

/** The trigger event the subscriber hands the first tick. */
function firstTrigger(
  m: { ticketId: string; messageId: string },
  eventId: string,
): RoutineTriggerEvent {
  return {
    app: "tickets",
    entity: "message",
    action: "create",
    entityId: m.messageId,
    data: { ticketId: m.ticketId },
    eventId,
  }
}

const blockedInvoker = async () => ({
  turnsAdded: 1,
  failure: "A tool the routine called was unavailable: tickets__get",
})
const okInvoker = async () => ({ turnsAdded: 1, failure: null })

async function runsOf(routineId: string) {
  return withPrivilegedDb(orgId, "red-runs", (tx) =>
    tx.select().from(routineRuns).where(eq(routineRuns.routineId, routineId)),
  )
}

const sent: IncidentEnvelope[] = []
type Enq = Parameters<NonNullable<ReconcileOptions["enqueue"]>>[0]

beforeAll(async () => {
  const org = await createTestOrg()
  orgId = org.id
  userId = await withSystemDb("red-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId,
        email: `red-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Routine Owner",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
})

beforeEach(async () => {
  sent.length = 0
  RoutineIncidentTestAccess.setSink(async (_org, env) => {
    sent.push(env)
  })
  await clearRedisPatterns(["routine-lock:*"])
})

afterEach(async () => {
  RoutineIncidentTestAccess.setSink()
  await withPrivilegedDb(orgId, "red-cleanup", async (tx) => {
    const rs = await tx
      .select({ id: routinesTbl.id })
      .from(routinesTbl)
      .where(eq(routinesTbl.orgId, orgId))
    for (const r of rs) await RoutineEventReconcilerTestAccess.clearInFlight(r.id)
    await tx.delete(routineRuns).where(eq(routineRuns.orgId, orgId))
    await tx.delete(routinesTbl).where(eq(routinesTbl.orgId, orgId))
    await tx.delete(auditLog).where(and(eq(auditLog.orgId, orgId), eq(auditLog.app, "tickets")))
  })
})

afterAll(() => RoutineIncidentTestAccess.setSink())

describe("a routine tick that could not do its job", () => {
  it("is recorded failed with its reason, linked to the event it ran for", async () => {
    const r = await makeEventRoutine()
    const m = await makeTicketMessage({ ageMs: HOUR })
    const eventId = await auditEvent(m)
    const res = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: firstTrigger(m, eventId),
      agentInvoker: blockedInvoker,
    })
    expect(res.status).toBe("failed")
    const [run] = await runsOf(r.id)
    expect(run.status).toBe("failed")
    expect(run.error).toContain("tickets__get")
    expect(run.trigger).toBe("event")
    expect(run.eventId).toBe(eventId)
    expect(run.eventEntityId).toBe(m.messageId)
    expect(run.attempt).toBe(0)
  })
})

describe("judging a tick from its output thread", () => {
  it("reads the tool calls and final text the tick posted, and only those", async () => {
    const threadId = await minimal.thread(orgId, userId)
    const [agent] = await withPrivilegedDb(orgId, "red-agent", (tx) =>
      tx
        .insert(agentsTbl)
        .values({
          orgId,
          kind: "role",
          handle: `@red-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Support",
          scopeCeiling: [],
          systemPrompt: "",
        })
        .returning({ id: agentsTbl.id }),
    )
    const post = (content: string, toolCalls: unknown[], at: Date) =>
      withPrivilegedDb(orgId, "red-post", (tx) =>
        tx.insert(kernelMessages).values({
          threadId,
          orgId,
          authorId: userId,
          authorType: "agent",
          authorAgentId: agent!.id,
          content,
          metadata: { toolCalls },
          requiredScopes: [],
          createdAt: at,
        }),
      )
    const tickStart = new Date(Date.now() - 60_000)
    // An earlier tick's blocked report is not this tick's.
    await post("**Classification:** Blocked", [], new Date(tickStart.getTime() - 60_000))
    expect(await judgeRoutineTick(orgId, threadId, tickStart)).toBeNull()
    await post(
      "Ticket message event received, triage could not proceed.",
      [
        {
          toolName: "tickets__get",
          error: {
            message:
              'Error repairing tool call: Error: No tool named "tickets__get" is available to you.',
          },
        },
      ],
      new Date(),
    )
    expect(await judgeRoutineTick(orgId, threadId, tickStart)).toContain("tickets__get")
  })

  it("a refused lookup the tick carried on from, ending with its reply drafted, is not a failure", async () => {
    // The live shape: a skill the prompt named was not held, the input of one
    // search was refused, and the run still read the ticket and drafted the reply.
    const threadId = await minimal.thread(orgId, userId)
    const tickStart = new Date(Date.now() - 1_000)
    const [agent] = await withPrivilegedDb(orgId, "carried-on-agent", (tx) =>
      tx
        .insert(agentsTbl)
        .values({
          orgId,
          kind: "role",
          handle: `@carried-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Support",
          scopeCeiling: [],
          systemPrompt: "",
        })
        .returning({ id: agentsTbl.id }),
    )
    await withPrivilegedDb(orgId, "carried-on-post", (tx) =>
      tx.insert(kernelMessages).values({
        threadId,
        orgId,
        authorId: userId,
        authorType: "agent",
        authorAgentId: agent!.id,
        content: "Added the internal note and drafted the reply; it waits for approval.",
        metadata: {
          toolCalls: [
            { toolName: "tickets__get", status: "completed" },
            {
              toolName: "kernel__skill_read",
              error: {
                message:
                  'AI_ToolCallRepairError: Error repairing tool call: Error: No tool named "kernel__skill_read" is available to you.',
              },
            },
            {
              toolName: "tickets__search",
              error: {
                message:
                  "AI_InvalidToolInputError: Invalid input for tool tickets__search: Type validation failed",
              },
            },
            { toolName: "tickets__search", status: "completed" },
            { toolName: "tickets__reply", status: "completed" },
          ],
        },
        requiredScopes: [],
        createdAt: new Date(),
      }),
    )
    expect(await judgeRoutineTick(orgId, threadId, tickStart)).toBeNull()
  })

  it("a tick whose turn ended in an error is a failure carrying the error's detail and code", async () => {
    // The live shape: a refusal before the provider call ended the turn with no
    // text; the runtime stored its failure line, and the run used to read succeeded.
    const threadId = await minimal.thread(orgId, userId)
    const tickStart = new Date(Date.now() - 1_000)
    const [agent] = await withPrivilegedDb(orgId, "errored-agent", (tx) =>
      tx
        .insert(agentsTbl)
        .values({
          orgId,
          kind: "role",
          handle: `@errored-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Support",
          scopeCeiling: [],
          systemPrompt: "",
        })
        .returning({ id: agentsTbl.id }),
    )
    const refusal = "The AI budget for today is used up. It resets at midnight UTC."
    await withPrivilegedDb(orgId, "errored-post", (tx) =>
      tx.insert(kernelMessages).values({
        threadId,
        orgId,
        authorId: userId,
        authorType: "agent",
        authorAgentId: agent!.id,
        content: agentNoticeStoredText(refusal),
        metadata: {
          finishReason: "error",
          error: refusal,
          errorCode: "budget_exhausted",
          agentNotice: "provider_error",
        },
        requiredScopes: [],
        createdAt: new Date(),
      }),
    )
    const failure = await judgeRoutineTick(orgId, threadId, tickStart)
    expect(failure).toContain(refusal)
    expect(failure).toContain("(code: budget_exhausted)")
  })
})

describe("routine incidents", () => {
  it("a burst of failed event runs raises one incident per routine, the next success resolves it", async () => {
    const r = await makeEventRoutine()
    for (let i = 0; i < 2; i++) {
      const m = await makeTicketMessage({ ageMs: HOUR })
      await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        triggerEvent: firstTrigger(m, await auditEvent(m)),
        agentInvoker: blockedInvoker,
      })
    }
    const raised = sent.filter((e) => !("status" in e))
    expect(raised).toHaveLength(2)
    expect(new Set(raised.map((e) => e.dedupKey))).toEqual(new Set([runFailedDedupKey(r.id)]))

    const m = await makeTicketMessage({ ageMs: HOUR })
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: firstTrigger(m, await auditEvent(m)),
      agentInvoker: okInvoker,
    })
    expect(sent.at(-1)).toMatchObject({ dedupKey: runFailedDedupKey(r.id), status: "resolved" })
  })

  it("a failed scheduled run raises no incident (its owner alert covers it)", async () => {
    const r = await makeEventRoutine()
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      agentInvoker: blockedInvoker,
    })
    expect(sent).toHaveLength(0)
  })

  it("the default sink reaches the monitoring app, which folds the burst into one incident and resolves it", async () => {
    RoutineIncidentTestAccess.setSink()
    const { ctx, spy } = makeCtx()
    webhookHandlers.set([orgId, "monitoring", "alert"], {
      handler: (payload: unknown) => alertWebhookHandler(payload, ctx),
      verify: async () => ({ ok: true }) as never,
      appName: "monitoring",
      orgId,
    })
    try {
      const r = await makeEventRoutine()
      for (let i = 0; i < 2; i++) {
        const m = await makeTicketMessage({ ageMs: HOUR })
        await runRoutineTick({
          orgId,
          routineId: r.id,
          scheduledAt: new Date().toISOString(),
          triggerEvent: firstTrigger(m, await auditEvent(m)),
          agentInvoker: blockedInvoker,
        })
      }
      const incidents = spy.rows.get("incidents") ?? []
      expect(incidents).toHaveLength(1)
      expect(incidents[0]).toMatchObject({
        dedup_key: runFailedDedupKey(r.id),
        status: "open",
        count: 2,
        severity: "warning",
      })
      const m = await makeTicketMessage({ ageMs: HOUR })
      await runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        triggerEvent: firstTrigger(m, await auditEvent(m)),
        agentInvoker: okInvoker,
      })
      expect((spy.rows.get("incidents") ?? [])[0]).toMatchObject({ status: "resolved" })
    } finally {
      webhookHandlers.delete([orgId, "monitoring", "alert"])
    }
  })
})

describe("the event reconciler", () => {
  it("fires again an event with no successful run, and never a served, closed, answered or outbound one", async () => {
    const r = await makeEventRoutine()
    const missed = await makeTicketMessage({ ageMs: 3 * HOUR })
    const missedId = await auditEvent(missed)
    // A first run that failed.
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: firstTrigger(missed, missedId),
      agentInvoker: blockedInvoker,
    })
    const lost = await makeTicketMessage({ ageMs: 3 * HOUR })
    const lostId = await auditEvent(lost) // no run at all
    const served = await makeTicketMessage({ ageMs: 3 * HOUR })
    const servedId = await auditEvent(served)
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: firstTrigger(served, servedId),
      agentInvoker: okInvoker,
    })
    const closed = await makeTicketMessage({ ageMs: 3 * HOUR, status: "closed" })
    await auditEvent(closed)
    const answered = await makeTicketMessage({ ageMs: 3 * HOUR })
    await auditEvent(answered)
    await addReply(answered.ticketId, new Date(Date.now() - 2 * HOUR))
    const outbound = await makeTicketMessage({ ageMs: 3 * HOUR, kind: "outbound" })
    await auditEvent(outbound)
    const fresh = await makeTicketMessage({ ageMs: 60 * 1000 })
    await auditEvent(fresh) // its first run may still be running

    const enq: Enq[] = []
    const report = await reconcileEventRoutines({
      routineId: r.id,
      enqueue: async (p) => {
        enq.push(p)
      },
    })
    expect(enq.map((p) => p.triggerEvent.eventId).sort()).toEqual([missedId, lostId].sort())
    for (const p of enq) {
      expect(p.routineId).toBe(r.id)
      expect(p.triggerEvent).toMatchObject({
        app: "tickets",
        entity: "message",
        action: "create",
        retryAttempt: 1,
      })
    }
    const byEntity = new Map(report.events.map((e) => [e.entityId, e.outcome]))
    expect(byEntity.get(served.messageId)).toBe("served")
    expect(byEntity.get(closed.messageId)).toBe("skipped:ticket_closed")
    expect(byEntity.get(answered.messageId)).toBe("skipped:answered")
    expect(byEntity.get(outbound.messageId)).toBe("skipped:not_inbound")
    expect(byEntity.has(fresh.messageId)).toBe(false)
  })

  it("is idempotent: a retry in flight is not started twice, and a dry run starts nothing", async () => {
    const r = await makeEventRoutine()
    const m = await makeTicketMessage({ ageMs: 3 * HOUR })
    await auditEvent(m)
    const enq: Enq[] = []
    const enqueue = async (p: Enq) => {
      enq.push(p)
    }
    const dry = await reconcileEventRoutines({ routineId: r.id, dryRun: true, enqueue })
    expect(dry.counts.would_retry).toBe(1)
    expect(enq).toHaveLength(0)
    await reconcileEventRoutines({ routineId: r.id, enqueue })
    const second = await reconcileEventRoutines({ routineId: r.id, enqueue })
    expect(enq).toHaveLength(1)
    expect(second.counts.in_flight).toBe(1)
  })

  // A run that waits for an approval (routine-run-resume.ts) is that event's
  // run, still going: firing the event again would handle the same message
  // twice while the first run waits.
  it("counts a run waiting for an approval as the event's run: never fired again", async () => {
    const r = await makeEventRoutine()
    const m = await makeTicketMessage({ ageMs: 3 * HOUR })
    const eventId = await auditEvent(m)
    await withPrivilegedDb(orgId, "reconcile-test-waiting-run", (tx) =>
      tx.insert(routineRuns).values({
        orgId,
        routineId: r.id,
        status: "waiting_approval",
        ranAt: new Date(Date.now() - 2 * HOUR),
        trigger: "event",
        eventId,
        eventEntityId: m.messageId,
      }),
    )
    const enq: Enq[] = []
    const report = await reconcileEventRoutines({
      routineId: r.id,
      enqueue: async (p) => {
        enq.push(p)
      },
    })
    expect(enq).toHaveLength(0)
    expect(new Map(report.events.map((e) => [e.entityId, e.outcome])).get(m.messageId)).toBe(
      "served",
    )
  })

  it("stops after maxRetries failed retries, keeps the event in a critical incident, and backs off between retries", async () => {
    const r = await makeEventRoutine()
    const m = await makeTicketMessage({ ageMs: 10 * HOUR })
    const eventId = await auditEvent(m)
    const tick = (attempt: number) =>
      runRoutineTick({
        orgId,
        routineId: r.id,
        scheduledAt: new Date().toISOString(),
        triggerEvent: { ...firstTrigger(m, eventId), retryAttempt: attempt },
        agentInvoker: blockedInvoker,
      })
    const enq: Enq[] = []
    const enqueue = async (p: Enq) => {
      enq.push(p)
    }
    // A retry that failed just now: the next one waits out the backoff.
    await tick(1)
    const waiting = await reconcileEventRoutines({ routineId: r.id, enqueue })
    expect(waiting.counts.backoff).toBe(1)
    expect(enq).toHaveLength(0)
    // Past the backoff the second retry starts, attempt 2.
    await reconcileEventRoutines({ routineId: r.id, enqueue, now: new Date(Date.now() + 2 * HOUR) })
    expect(enq.map((p) => p.triggerEvent.retryAttempt)).toEqual([2])
    await tick(2)
    await tick(3)
    sent.length = 0
    const done = await reconcileEventRoutines({
      routineId: r.id,
      enqueue,
      maxRetries: 3,
      now: new Date(Date.now() + 9 * HOUR),
    })
    expect(done.counts.exhausted).toBe(1)
    expect(enq).toHaveLength(1)
    expect(sent).toContainEqual(
      expect.objectContaining({ dedupKey: undeliveredDedupKey(r.id), severity: "critical" }),
    )
  })
})

describe("the reconciler never drafts twice", () => {
  it("of a ticket's unanswered inbound messages only the newest is fired again, the older ones are superseded", async () => {
    const r = await makeEventRoutine()
    const first = await makeTicketMessage({ ageMs: 5 * HOUR })
    const second = await addInbound(first.ticketId, 4 * HOUR)
    const third = await addInbound(first.ticketId, 3 * HOUR)
    for (const m of [first, second, third]) await auditEvent(m)
    const enq: Enq[] = []
    const report = await reconcileEventRoutines({
      routineId: r.id,
      enqueue: async (p) => {
        enq.push(p)
      },
    })
    expect(enq.map((p) => p.triggerEvent.entityId)).toEqual([third.messageId])
    const byEntity = new Map(report.events.map((e) => [e.entityId, e.outcome]))
    expect(byEntity.get(first.messageId)).toBe("skipped:superseded")
    expect(byEntity.get(second.messageId)).toBe("skipped:superseded")
  })

  it("a retry counts as in flight from its enqueue until its run row lands: a dry run and a second pass both see it", async () => {
    const r = await makeEventRoutine()
    const m = await makeTicketMessage({ ageMs: 3 * HOUR })
    const eventId = await auditEvent(m)
    const enq: Enq[] = []
    const enqueue = async (p: Enq) => {
      enq.push(p)
    }
    await reconcileEventRoutines({ routineId: r.id, enqueue })
    expect(enq).toHaveLength(1)
    // The agent queue is slow: no run row yet.
    const dry = await reconcileEventRoutines({ routineId: r.id, dryRun: true, enqueue })
    expect(dry.counts.would_retry).toBeUndefined()
    expect(dry.counts.in_flight).toBe(1)
    const again = await reconcileEventRoutines({
      routineId: r.id,
      enqueue,
      now: new Date(Date.now() + 3 * HOUR),
    })
    expect(again.counts.in_flight).toBe(1)
    expect(enq).toHaveLength(1)
    // The retry's run row lands (it failed): the event is judged from it again.
    await runRoutineTick({
      ...enq[0]!,
      agentInvoker: blockedInvoker,
    })
    const later = await reconcileEventRoutines({
      routineId: r.id,
      dryRun: true,
      enqueue,
      now: new Date(Date.now() + 3 * HOUR),
    })
    expect(later.counts.would_retry).toBe(1)
    expect(eventId).toBeTruthy()
  })

  it("the event's own first tick counts as in flight from the subscriber's enqueue", async () => {
    const { markEventTickInFlight } = await import(
      "~/modules/agent/routines/routine-event-reconciler"
    )
    const r = await makeEventRoutine()
    const m = await makeTicketMessage({ ageMs: 3 * HOUR })
    const eventId = await auditEvent(m)
    await markEventTickInFlight(r.id, eventId)
    const dry = await reconcileEventRoutines({ routineId: r.id, dryRun: true })
    expect(dry.counts.in_flight).toBe(1)
    // Its run row lands and clears it.
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: firstTrigger(m, eventId),
      agentInvoker: blockedInvoker,
    })
    const after = await reconcileEventRoutines({ routineId: r.id, dryRun: true })
    expect(after.counts.would_retry).toBe(1)
  })
})

describe("a seed's own events", () => {
  it("are never fired again: the seeded backlog is not a lost event", async () => {
    const r = await makeEventRoutine()
    const seeded = await makeTicketMessage({ ageMs: 3 * HOUR })
    const seededId = await auditEvent(seeded)
    await withPrivilegedDb(orgId, "red-seeded", (tx) =>
      tx
        .update(auditLog)
        .set({ metadata: { seeded: true } })
        .where(eq(auditLog.eventId, seededId)),
    )
    const lost = await makeTicketMessage({ ageMs: 3 * HOUR })
    const lostId = await auditEvent(lost)
    const enq: Enq[] = []
    await reconcileEventRoutines({
      routineId: r.id,
      enqueue: async (p) => {
        enq.push(p)
      },
    })
    expect(enq.map((p) => p.triggerEvent.eventId)).toEqual([lostId])
  })
})

describe("the one shot backfill", () => {
  it("liaison routines reconcile --since reaches past the 14 day window and is a dry run without --execute", async () => {
    const { runRoutinesReconcileCli } = await import("~/cli/routines/reconcile")
    const r = await makeEventRoutine()
    const old = await makeTicketMessage({ ageMs: 20 * 24 * HOUR })
    await auditEvent(old)
    const inWindow = await reconcileEventRoutines({ routineId: r.id, dryRun: true })
    expect(inWindow.counts.would_retry).toBeUndefined()
    const since = new Date(Date.now() - 30 * 24 * HOUR).toISOString()
    const res = await runRoutinesReconcileCli(["--since", since, "--routine", r.id])
    expect(res.exitCode).toBe(0)
    expect(res.report).toMatchObject({ dryRun: true, counts: { would_retry: 1 } })
    expect(await runsOf(r.id)).toHaveLength(0)
  })
})

describe("every customer message gets its triage run", () => {
  it("inbound message, run fails on a missing tool, the reconciler fires it again, the second run succeeds, exactly one success", async () => {
    const r = await makeEventRoutine()
    const m = await makeTicketMessage({ ageMs: HOUR })
    const eventId = await auditEvent(m)
    // The run the event fired: the tickets tool was missing.
    await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      triggerEvent: firstTrigger(m, eventId),
      agentInvoker: blockedInvoker,
    })
    // The reconciler's pass hands the retry to the routine-tick worker.
    const enq: Enq[] = []
    await reconcileEventRoutines({
      routineId: r.id,
      enqueue: async (p) => {
        enq.push(p)
      },
    })
    expect(enq).toHaveLength(1)
    const seen: Array<RoutineTriggerEvent | undefined> = []
    await runRoutineTick({
      ...enq[0]!,
      agentInvoker: async (input) => {
        seen.push(input.triggerEvent)
        return okInvoker()
      },
    })
    // The retry ran for that exact event.
    expect(seen[0]).toMatchObject({ entityId: m.messageId, data: { ticketId: m.ticketId } })
    // Later passes leave it alone.
    const after = await reconcileEventRoutines({
      routineId: r.id,
      enqueue: async (p) => {
        enq.push(p)
      },
      now: new Date(Date.now() + 5 * HOUR),
    })
    expect(enq).toHaveLength(1)
    expect(after.counts.served).toBe(1)
    const runs = await runsOf(r.id)
    expect(runs.filter((x) => x.status === "succeeded")).toHaveLength(1)
    const retry = runs.find((x) => x.trigger === "retry")
    expect(retry).toMatchObject({ status: "succeeded", attempt: 1, eventId })
  })
})
