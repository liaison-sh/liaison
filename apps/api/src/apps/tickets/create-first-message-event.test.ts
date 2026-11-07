// SPDX-License-Identifier: FSL-1.1-ALv2
// A ticket created with its first customer message announces that message as
// `tickets/message:create`, like every later message on the thread. Before, only
// appends to an existing ticket fired it, so an event routine bound to it (draft
// a reply to every inbound customer message) never ran on a brand-new ticket.
// An initial internal note stays off that event (note-create-event.test.ts).
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { initEventBus } from "~/infra/events/event-bus"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { drainOutbox } from "~/tests/helpers/outbox"

// Record routine-tick enqueues instead of touching BullMQ (event-routine-subscriber.test.ts).
const enqueued: unknown[][] = []
const realJobsModule = { ...(await import("~/infra/jobs/jobs")) }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (...a: unknown[]) => {
    enqueued.push(a)
    return "job-id"
  },
}))
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})
const { registerEventRoutineSubscription, EventRoutineSubscriberTestAccess } = await import(
  "~/infra/jobs/event-routine-subscriber"
)
const { createTicket } = await import("~/apps/tickets/create")
const { runAsSeed } = await import("~/modules/notifications/seeded")
const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())
const ticks = () => enqueued.filter(([app, job]) => app === "kernel" && job === "routine-tick")

let orgId: string

interface EventPayload {
  entityId: string
  actorType: string
  data: Record<string, unknown>
}

beforeAll(async () => {
  const slug = `first-msg-evt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("first-message-event-fixture", async (tx) => {
    orgId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'FirstMsgEvt', ${slug}) RETURNING id
      `),
    )[0]!.id
  })
  await ensureAppsForOrg(orgId, {})
})

async function messageEvents(messageId: string): Promise<EventPayload[]> {
  return extractRows<{ payload: EventPayload }>(
    await db.execute(drizzleSql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'tickets'
        AND payload->>'entity' = 'message' AND payload->>'action' = 'create'
        AND payload->>'entityId' = ${messageId}
    `),
  ).map((r) => r.payload)
}

async function create(kind: "inbound" | "outbound" | "note") {
  const out = (await withSystemDb("first-message-event", (tx) =>
    createTicket(
      tx as never,
      orgId,
      {
        subject: `First message ${kind}`,
        channel: "email",
        team: "support",
        initialMessage: {
          kind,
          fromEmail: "customer@cust.test",
          textBody: "my controller does not boot",
        },
      },
      { actorType: "system", userId: "00000000-0000-0000-0000-000000000000" },
      { privilegedTx: tx },
    ),
  )) as { ticketId: string; initialMessageId: string | null; error?: unknown }
  expect(out.error).toBeUndefined()
  expect(out.initialMessageId).toBeTruthy()
  return { ticketId: out.ticketId, messageId: out.initialMessageId! }
}

describe("createTicket first message event", () => {
  it("queues tickets/message:create for an inbound first message, with the ticket's dimension keys", async () => {
    const { ticketId, messageId } = await create("inbound")
    const events = await messageEvents(messageId)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.actorType).toBe("system")
    expect(e.data.ticketId).toBe(ticketId)
    expect(e.data.kind).toBe("inbound")
    expect(e.data["tickets:team"]).toBe("support")
    expect(Object.keys(e.data)).toContain("tickets:sensitivity")
  })

  it("never queues it for a first internal note", async () => {
    const { messageId } = await create("note")
    expect(await messageEvents(messageId)).toHaveLength(0)
  })

  it("ticks a routine bound to tickets:message:create when a ticket is created", async () => {
    initEventBus()
    await drainOutbox()
    await registerEventRoutineSubscription({
      routineId: crypto.randomUUID(),
      orgId,
      event: "tickets:message:create",
    })
    enqueued.length = 0
    const { messageId } = await create("inbound")
    await drainOutbox()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    const t = ticks()
    expect(t).toHaveLength(1)
    const payload = t[0]![2] as { triggerEvent: { entityId: string } }
    expect(payload.triggerEvent.entityId).toBe(messageId)
  })

  // A seed's tickets are its own world, not customers writing in: the warm demo
  // pool seeded a workspace before any visitor owned it, and its support routine
  // ran (refused, then paused) on the seeded backlog (notifications/seeded.ts).
  it("a ticket a seed creates is marked as the seed's own and ticks no routine", async () => {
    initEventBus()
    await drainOutbox()
    await registerEventRoutineSubscription({
      routineId: crypto.randomUUID(),
      orgId,
      event: "tickets:message:create",
    })
    enqueued.length = 0
    const { messageId } = await runAsSeed(() => create("inbound"))
    const queued = extractRows<{ metadata: unknown }>(
      await db.execute(drizzleSql`
        SELECT payload->'metadata' AS metadata FROM kernel.pending_events
        WHERE org_id = ${orgId} AND payload->>'entityId' = ${messageId}`),
    )
    expect(queued.map((r) => r.metadata)).toEqual([{ seeded: true }])
    await drainOutbox()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks()).toHaveLength(0)
  })
})
