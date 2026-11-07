// SPDX-License-Identifier: FSL-1.1-ALv2
// addNote announces the new internal note as its OWN declared event,
// `tickets/note:create`, in the same data shape as the reply event (tools.ts
// ticketsReply): the ticket's dimension values under their grant keys (the WS
// dimension filter reads them) and the acting user as the event actor. It is
// never `tickets/message:create`: that one means a message on the customer
// thread, and every routine bound to it (triage, draft replies) would otherwise
// fire on an internal note.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { _publishEventInternal, flushEventHandlers, initEventBus } from "~/infra/events/event-bus"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { asOrgMember } from "~/tests/helpers/org-caller"
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
const { runAdminOp } = await import("~/apps/tickets/admin")
const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())
const ticks = () => enqueued.filter(([app, job]) => app === "kernel" && job === "routine-tick")

let orgId: string
let userId: string
let ticketId: string

interface EventRow {
  payload: {
    app: string
    entity: string
    action: string
    entityId: string
    actorId: string | null
    actorType: string
    data: Record<string, unknown>
  }
}

beforeAll(async () => {
  const slug = `note-evt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("note-create-event-fixture", async (tx) => {
    orgId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'NoteEvt', ${slug}) RETURNING id
      `),
    )[0]!.id
    userId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id
      `),
    )[0]!.id
  })
  await ensureAppsForOrg(orgId, {})
  ticketId = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_tickets.tickets
        (org_id, handle, subject, channel, reply_token, status, message_count,
         sla_target_seconds, sla_deadline, team, sensitivity)
      VALUES (${orgId}, ${`ticket-${Math.floor(Math.random() * 1e9)}`}, 'Note event', 'email',
              ${`tok-${slug}`}, 'open', 0, 3600, now() + interval '1 day', 'support', 'confidential')
      RETURNING id
    `),
  )[0]!.id
})

async function ticketEvents(entity: string, messageId: string): Promise<EventRow["payload"][]> {
  return extractRows<EventRow>(
    await db.execute(drizzleSql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'tickets'
        AND payload->>'entity' = ${entity} AND payload->>'action' = 'create'
        AND payload->>'entityId' = ${messageId}
    `),
  ).map((r) => r.payload)
}
const noteEvents = (messageId: string) => ticketEvents("note", messageId)

async function addNote(text: string): Promise<{ messageId: string }> {
  return (await asOrgMember(orgId, userId, (tx) =>
    runAdminOp(tx as never, orgId, "addNote", { ticketId, text }, { actorType: "user", userId }),
  )) as { messageId: string }
}

describe("tickets admin addNote event", () => {
  it("the result names the ticket the note went to, and that nothing left Liaison", async () => {
    const [row] = extractRows<{ handle: string }>(
      await db.execute(drizzleSql`SELECT handle FROM app_tickets.tickets WHERE id = ${ticketId}`),
    )
    const r = (await addNote("where did it go")) as unknown as {
      ticketId: string
      ticket: string
      savedTo: string
    }
    expect(r.ticketId).toBe(ticketId)
    expect(r.ticket).toBe(row!.handle)
    expect(r.savedTo).toBe(
      `Internal note added to Liaison ticket ${row!.handle} (visible to teammates on that ticket only). Nothing was written to any external system such as a CRM.`,
    )
  })

  it("queues tickets/note:create (never message:create) kind note with the ticket's dimension keys", async () => {
    const r = (await asOrgMember(orgId, userId, (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "addNote",
        { ticketId, text: "checked the invoice" },
        { actorType: "user", userId },
      ),
    )) as { messageId: string }
    expect(r.messageId).toBeTruthy()
    expect(await ticketEvents("message", r.messageId)).toHaveLength(0)
    const events = await noteEvents(r.messageId)
    expect(events).toHaveLength(1)
    const e = events[0]!
    expect(e.actorId).toBe(userId)
    expect(e.actorType).toBe("user")
    expect(e.data.id).toBe(r.messageId)
    expect(e.data.ticketId).toBe(ticketId)
    expect(e.data.kind).toBe("note")
    expect(e.data.textBody).toBe("checked the invoice")
    expect(e.data.orgId).toBe(orgId)
    expect(typeof e.data.sentAt).toBe("string")
    expect(Object.keys(e.data)).toContain("tickets:team")
    expect(Object.keys(e.data)).toContain("tickets:sensitivity")
    expect(e.data["tickets:team"]).toBe("support")
    expect(e.data["tickets:sensitivity"]).toBe("confidential")
  })

  it("an agent turn's note names the requesting user as actor and the agent type", async () => {
    const r = (await asOrgMember(orgId, userId, (tx) =>
      runAdminOp(
        tx as never,
        orgId,
        "addNote",
        { ticketId, text: "agent finding" },
        { actorType: "user", auditActorType: "agent", userId },
      ),
    )) as { messageId: string }
    const [e] = await noteEvents(r.messageId)
    expect(e?.actorId).toBe(userId)
    expect(e?.actorType).toBe("agent")
  })

  it("a note does not tick a routine bound to tickets:message:create; a customer message does", async () => {
    initEventBus()
    await drainOutbox()
    await registerEventRoutineSubscription({
      routineId: crypto.randomUUID(),
      orgId,
      event: "tickets:message:create",
    })
    enqueued.length = 0
    await addNote("internal only")
    await drainOutbox()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks()).toHaveLength(0)
    // The same routine does fire on a message on the customer thread.
    await _publishEventInternal({
      app: "tickets",
      entity: "message",
      action: "create",
      orgId,
      entityId: crypto.randomUUID(),
      data: { ticketId, kind: "inbound" },
    })
    await flushEventHandlers()
    await new Promise((r) => setTimeout(r, COALESCE_MS + 50))
    expect(ticks()).toHaveLength(1)
  })
})
