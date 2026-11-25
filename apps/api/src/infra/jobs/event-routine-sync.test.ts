// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Event-routine subscriptions are cell-wide (P2 T4). An event routine's handler
// is `once`: it runs only in the process that publishes the event (the outbox
// leader). A routine created or changed on another process must therefore reach
// every process's bus: an announce on Redis, plus a resync that recovers a lost
// announce (subscriber reconnect, leader takeover, a periodic timer).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import Redis from "ioredis"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { auditLog, routines, users } from "~/db/schema/kernel"
import { _publishEventInternal, EventBusTestAccess, initEventBus } from "~/infra/events/event-bus"
import {
  __resetEventRoutineSubscriber,
  catchUpMissedEvents,
  disposeEventRoutineSubscription,
  EVENT_ROUTINE_SYNC_CHANNEL,
  EventRoutineSubscriberTestAccess,
  registerEventRoutineSubscription,
  resyncEventRoutineSubscriptions,
  startEventRoutineSync,
  stopEventRoutineSync,
} from "~/infra/jobs/event-routine-subscriber"
import * as jobs from "~/infra/jobs/jobs"
import { LeadershipTestAccess, startLeadership } from "~/infra/leadership"
import { env } from "~/lib/env"
import { RESP_PROTOCOL } from "~/lib/redis"
import { enableEventRoutine } from "~/seed/factories/agent/routines"
import { createTestOrg } from "~/tests/helpers/org"

const EVENT = "tickets:ticket:create"
const registered = (id: string) => EventRoutineSubscriberTestAccess.registeredEvent(id)

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never met")
    await new Promise((r) => setTimeout(r, 20))
  }
}

let orgId: string
let userId: string
// A second Redis client stands in for another process of the cell.
let peer: Redis

async function insertEventRoutine(opts: { enabled?: boolean; event?: string } = {}) {
  const [row] = await withPrivilegedDb(orgId, "ers-insert", (tx) =>
    tx
      .insert(routines)
      .values({
        orgId,
        ownerUserId: userId,
        name: `sync-${crypto.randomUUID()}`,
        description: "x",
        kind: "event",
        event: opts.event ?? EVENT,
        prompt: "p",
        scopes: [],
        enabled: opts.enabled ?? true,
        status: "active",
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routines.id }),
  )
  return row.id
}

/** What another process does after its commit: announce on the cell channel. */
async function announceFromPeer(routineId: string): Promise<void> {
  await peer.publish(EVENT_ROUTINE_SYNC_CHANNEL, JSON.stringify({ routineId, orgId }))
}

beforeAll(async () => {
  initEventBus()
  const org = await createTestOrg()
  orgId = org.id
  userId = await withSystemDb("ers-user", async (db) => {
    const [u] = await db
      .insert(users)
      .values({
        orgId,
        email: `ers-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Routine sync tester",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  peer = new Redis(env.REDIS_URL, { protocol: RESP_PROTOCOL, maxRetriesPerRequest: null })
})

afterEach(async () => {
  await stopEventRoutineSync()
  await LeadershipTestAccess.reset()
  __resetEventRoutineSubscriber()
})

afterAll(async () => {
  await withPrivilegedDb(orgId, "ers-cleanup", (tx) =>
    tx.delete(routines).where(eq(routines.orgId, orgId)),
  )
  await withPrivilegedDb(orgId, "ers-cleanup-audit", (tx) =>
    tx.delete(auditLog).where(eq(auditLog.orgId, orgId)),
  )
  peer.disconnect()
})

describe("event-routine sync across the cell", () => {
  it("a routine change announced elsewhere registers it here", async () => {
    const id = await insertEventRoutine()
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    expect(registered(id)).toBeNull()
    await announceFromPeer(id)
    await waitFor(() => registered(id) === EVENT)
  })

  it("a disabled routine announced elsewhere is disposed here", async () => {
    const id = await insertEventRoutine()
    await registerEventRoutineSubscription({ routineId: id, orgId, event: EVENT })
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    await withPrivilegedDb(orgId, "ers-disable", (tx) =>
      tx.update(routines).set({ enabled: false }).where(eq(routines.id, id)),
    )
    await announceFromPeer(id)
    await waitFor(() => registered(id) === null)
  })

  it("a deleted routine announced elsewhere is disposed here", async () => {
    const id = await insertEventRoutine()
    await registerEventRoutineSubscription({ routineId: id, orgId, event: EVENT })
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    await withPrivilegedDb(orgId, "ers-delete", (tx) =>
      tx.delete(routines).where(eq(routines.id, id)),
    )
    await announceFromPeer(id)
    await waitFor(() => registered(id) === null)
  })

  it("a changed trigger announced elsewhere re-registers on the new event", async () => {
    const id = await insertEventRoutine()
    await registerEventRoutineSubscription({ routineId: id, orgId, event: EVENT })
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    await withPrivilegedDb(orgId, "ers-retrigger", (tx) =>
      tx.update(routines).set({ event: "tickets:note:create" }).where(eq(routines.id, id)),
    )
    await announceFromPeer(id)
    await waitFor(() => registered(id) === "tickets:note:create")
  })

  it("a dropped announce is recovered by the periodic resync", async () => {
    // Created elsewhere, and its announce never arrived: only the timer finds it.
    const added = await insertEventRoutine()
    // Disabled elsewhere, announce lost too: the resync drops the stale handler.
    const stale = await insertEventRoutine()
    await registerEventRoutineSubscription({ routineId: stale, orgId, event: EVENT })
    await withPrivilegedDb(orgId, "ers-disable-stale", (tx) =>
      tx.update(routines).set({ enabled: false }).where(eq(routines.id, stale)),
    )
    await startEventRoutineSync({ resyncIntervalMs: 200 })
    await waitFor(() => registered(added) === EVENT && registered(stale) === null)
  })

  it("a subscriber reconnect resyncs (an announce sent while it was down is lost)", async () => {
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    const id = await insertEventRoutine()
    // Drop the connection and reconnect: what was published meanwhile never arrives.
    EventRoutineSubscriberTestAccess.subscriber()?.disconnect(true)
    await waitFor(() => registered(id) === EVENT)
  })

  it("taking the leader lease resyncs (the new leader runs the once handlers)", async () => {
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    const id = await insertEventRoutine()
    expect(registered(id)).toBeNull()
    await startLeadership({
      role: "all",
      lease: { key: `ers-lease:${crypto.randomUUID()}`, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
    })
    await waitFor(() => registered(id) === EVENT)
  })

  it("the announcing process applies its own announce idempotently", async () => {
    const id = await insertEventRoutine()
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    await registerEventRoutineSubscription({ routineId: id, orgId, event: EVENT })
    const before = EventRoutineSubscriberTestAccess.registrationCount(id)
    await announceFromPeer(id)
    // A later announce for another routine marks that the first was processed.
    const marker = await insertEventRoutine()
    await announceFromPeer(marker)
    await waitFor(() => registered(marker) === EVENT)
    // Same row, same registration: no dispose-and-resubscribe gap.
    expect(EventRoutineSubscriberTestAccess.registrationCount(id)).toBe(before)
    expect(registered(id)).toBe(EVENT)
  })

  // Direct registrations (a routine created or enabled here, an app resumed)
  // and the cell sync touch the same routine at once. Each subscribes before
  // recording its disposer, so without per-routine serialization the loser's
  // handler is orphaned: still on the bus, out of reach of every later dispose.
  it("a direct registration racing others and a resync leaves exactly one handler; a disable removes it", async () => {
    const id = await insertEventRoutine()
    await startEventRoutineSync({ resyncIntervalMs: 0 })
    const sub = { routineId: id, orgId, event: EVENT }
    await Promise.all([
      registerEventRoutineSubscription(sub),
      registerEventRoutineSubscription(sub),
      resyncEventRoutineSubscriptions(),
    ])
    const handlers = () => EventRoutineSubscriberTestAccess.routeCount(id)
    expect(handlers()).toBe(1)
    // One shared handler on the bus for the event type, none orphaned by the race.
    expect(EventBusTestAccess.handlerCount(`event-routines:${EVENT}`)).toBe(1)
    expect(registered(id)).toBe(EVENT)

    await withPrivilegedDb(orgId, "ers-disable-race", (tx) =>
      tx.update(routines).set({ enabled: false }).where(eq(routines.id, id)),
    )
    await announceFromPeer(id)
    await waitFor(() => registered(id) === null)
    expect(handlers()).toBe(0)
  })

  // A cell holds thousands of workspaces, each with its own routine on the same
  // event: the bus holds one handler per event type, not one per routine.
  it("routines of many orgs on one event share one bus handler; it goes with the last", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    const orgs = [orgId, crypto.randomUUID(), crypto.randomUUID()]
    for (let i = 0; i < ids.length; i++) {
      await registerEventRoutineSubscription({ routineId: ids[i]!, orgId: orgs[i]!, event: EVENT })
    }
    await registerEventRoutineSubscription({
      routineId: crypto.randomUUID(),
      orgId,
      event: "tickets:note:create",
    })
    expect(EventBusTestAccess.handlerCount(`event-routines:${EVENT}`)).toBe(1)
    expect(EventRoutineSubscriberTestAccess.eventTypeHandlerCount()).toBe(2)
    await disposeEventRoutineSubscription(ids[0]!)
    await disposeEventRoutineSubscription(ids[1]!)
    expect(EventBusTestAccess.handlerCount(`event-routines:${EVENT}`)).toBe(1)
    expect(registered(ids[2]!)).toBe(EVENT)
    await disposeEventRoutineSubscription(ids[2]!)
    expect(EventBusTestAccess.handlerCount(`event-routines:${EVENT}`)).toBe(0)
    expect(EventRoutineSubscriberTestAccess.eventTypeHandlerCount()).toBe(1)
  })

  it("the timer resyncs in full only when the table changed since the last full resync", async () => {
    await resyncEventRoutineSubscriptions()
    const full = () => EventRoutineSubscriberTestAccess.fullResyncCount()
    const base = full()
    await startEventRoutineSync({ resyncIntervalMs: 100 })
    await new Promise((r) => setTimeout(r, 450))
    expect(full()).toBe(base)
    // Created elsewhere, announce lost: the fingerprint moved, so the timer resyncs.
    const added = await insertEventRoutine()
    await waitFor(() => registered(added) === EVENT)
    expect(full()).toBe(base + 1)
  })
})

// The race the services demo's support tour hit: a routine is switched on, its
// event comes in before the routine's subscription reaches the process that
// publishes the event (its announce lost, or never sent), and the `once`
// handler never sees that event again. The process that arms the routine late
// catches it up from the audit log, once for the whole cell.
describe("a routine armed after its event", () => {
  // Each case logs its own events: none of another case's may fall in its window.
  beforeEach(async () => {
    await withPrivilegedDb(orgId, "ers-audit-reset", (tx) =>
      tx.delete(auditLog).where(eq(auditLog.orgId, orgId)),
    )
  })

  const ticks = (spy: { mock: { calls: unknown[][] } }, routineId: string) =>
    spy.mock.calls.filter(
      ([app, job, payload]) =>
        app === "kernel" &&
        job === "routine-tick" &&
        (payload as { routineId?: string }).routineId === routineId,
    )

  /** An event of the routine's type, logged as the outbox's audit consumer logs it. */
  async function logTicketCreated(at: Date): Promise<{ eventId: string; ticketId: string }> {
    const eventId = crypto.randomUUID()
    const ticketId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "ers-audit", (tx) =>
      tx.insert(auditLog).values({
        orgId,
        timestamp: at,
        actorId: userId,
        actorType: "user",
        app: "tickets",
        entityType: "ticket",
        entityId: ticketId,
        action: "ticket.create",
        changes: { subject: "Order question" },
        eventId,
      }),
    )
    return { eventId, ticketId }
  }

  async function armedAt(id: string): Promise<Date> {
    const [row] = await withPrivilegedDb(orgId, "ers-armed", (tx) =>
      tx.select({ at: routines.updatedAt }).from(routines).where(eq(routines.id, id)),
    )
    return row!.at
  }

  it("the event arrives before the subscription is ready: the routine still runs it, once", async () => {
    const enqueue = spyOn(jobs, "enqueueAppJob").mockResolvedValue("job-id" as never)
    try {
      // Switched on, then its ticket comes in while no process routes the event to it.
      const id = await insertEventRoutine()
      const armed = await armedAt(id)
      const { eventId, ticketId } = await logTicketCreated(new Date(armed.getTime() + 500))
      expect(registered(id)).toBeNull()
      // The subscription reaches this process only now (a late announce or resync).
      await startEventRoutineSync({ resyncIntervalMs: 0 })
      await announceFromPeer(id)
      await waitFor(() => ticks(enqueue, id).length === 1)
      const [, , payload] = ticks(enqueue, id)[0]!
      const trigger = (payload as { triggerEvent: { eventId: string; entityId: string } })
        .triggerEvent
      expect(trigger.eventId).toBe(eventId)
      expect(trigger.entityId).toBe(ticketId)
      // The event's late live copy, and another process's catch-up, start nothing more.
      await _publishEventInternal({
        app: "tickets",
        entity: "ticket",
        action: "create",
        entityId: ticketId,
        orgId,
        actorId: userId,
        actorType: "user",
        _eventId: eventId,
      } as never)
      expect(await catchUpMissedEvents({ routineId: id, orgId, event: EVENT }, armed)).toBe(0)
      await new Promise((r) => setTimeout(r, 200))
      expect(ticks(enqueue, id)).toHaveLength(1)
    } finally {
      enqueue.mockRestore()
    }
  })

  it("an event from before the routine was armed is not its to run", async () => {
    const enqueue = spyOn(jobs, "enqueueAppJob").mockResolvedValue("job-id" as never)
    try {
      const id = await insertEventRoutine()
      const armed = await armedAt(id)
      await logTicketCreated(new Date(armed.getTime() - 60_000))
      expect(await catchUpMissedEvents({ routineId: id, orgId, event: EVENT }, armed)).toBe(0)
      expect(ticks(enqueue, id)).toHaveLength(0)
    } finally {
      enqueue.mockRestore()
    }
  })

  it("a routine armed long ago is never swept: catch-up is for a routine just armed", async () => {
    const enqueue = spyOn(jobs, "enqueueAppJob").mockResolvedValue("job-id" as never)
    try {
      const id = await insertEventRoutine()
      const armed = await armedAt(id)
      await logTicketCreated(new Date(armed.getTime() + 500))
      const later = new Date(armed.getTime() + 60 * 60_000)
      expect(await catchUpMissedEvents({ routineId: id, orgId, event: EVENT }, armed, later)).toBe(
        0,
      )
      expect(ticks(enqueue, id)).toHaveLength(0)
    } finally {
      enqueue.mockRestore()
    }
  })

  it("switching a seeded routine on announces it to the cell", async () => {
    const id = await insertEventRoutine({ enabled: false })
    const listener = new Redis(env.REDIS_URL, {
      protocol: RESP_PROTOCOL,
      maxRetriesPerRequest: null,
    })
    const heard: string[] = []
    try {
      listener.on("message", (_channel: string, message: string) => {
        heard.push((JSON.parse(message) as { routineId: string }).routineId)
      })
      await listener.subscribe(EVENT_ROUTINE_SYNC_CHANNEL)
      await enableEventRoutine(orgId, id)
      await waitFor(() => heard.includes(id))
    } finally {
      listener.disconnect()
      await disposeEventRoutineSubscription(id)
    }
  })
})
