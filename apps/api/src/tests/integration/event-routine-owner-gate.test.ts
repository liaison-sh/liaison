// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The event routine owner gate (A32, A52) and the mail sender filter (S26).
//
// A routine runs as its owner, so an event about an entity the owner cannot
// read must never reach it. Each ownership-bearing family gets one pair: the
// owner's own entity fires the routine, another member's personal entity does
// not. The owner holds `*` throughout: personal visibility is not a scope
// question, and an admin's routine must not read a colleague's mailbox either.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "~/db"
import {
  _publishEventInternal,
  flushEventHandlers,
  initEventBus,
  resetEventBus,
} from "~/infra/events/event-bus"
import {
  inboundSenderEmail,
  isMailSenderFilterActive,
  type MailSenderFilter,
  mailSenderFilterMatches,
} from "~/infra/jobs/event-routine-gate"
import { resetAppRegistries, setDeclaredEmits } from "~/modules/apps/app-registries"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const enqueued: unknown[][] = []
const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({
  ...realJobsModule,
  enqueueAppJob: async (...a: unknown[]) => {
    enqueued.push(a)
    return "job-id"
  },
}))

// mock.module outlives this file: put the real jobs module back so the stubs above
// never reach a later file in the same bun process (a later spyOn(Queue.prototype)
// would otherwise watch a queue the stub never touches).
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})

const {
  registerEventRoutineSubscription,
  EventRoutineSubscriberTestAccess,
  __resetEventRoutineSubscriber,
} = await import("~/infra/jobs/event-routine-subscriber")

// Pin a short coalesce window for this file. The subscriber reads its env once at
// module load, and another file in the same bun process may have loaded it first
// with the 30s default, so the env alone cannot set it.
const COALESCE_MS = 100
beforeAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs(COALESCE_MS))
afterAll(() => EventRoutineSubscriberTestAccess.setCoalesceMs())

const ticks = () => enqueued.filter(([app, job]) => app === "kernel" && job === "routine-tick")

const ORG = randomUUID()
const OWNER = randomUUID()
const OTHER = randomUUID()
const ROUTINE = randomUUID()

// Mail: one personal mailbox each.
const ACC_OWNER = randomUUID()
const ACC_OTHER = randomUUID()
const CONV_OWNER = randomUUID()
const CONV_OTHER = randomUUID()
const MSG_OWNER = randomUUID()
const MSG_OTHER = randomUUID()
const MSG_OWNER_2 = randomUUID()
const MSG_OWNER_3 = randomUUID()
const MSG_OWNER_OUT = randomUUID()
// Calendar: one personal account + calendar + event each.
const CAL_ACC_OWNER = randomUUID()
const CAL_ACC_OTHER = randomUUID()
const CAL_OWNER = randomUUID()
const CAL_OTHER = randomUUID()
const EVT_OWNER = randomUUID()
const EVT_OTHER = randomUUID()
// Contacts: an org-visible one, and a private one of OTHER.
const CONTACT_ORG = randomUUID()
const CONTACT_PRIVATE = randomUUID()
const CONTACT_GROUPED = randomUUID()
const GROUP = randomUUID()
// MCP connections and knowledge documents: one personal each.
const MCP_OWNER = randomUUID()
const MCP_OTHER = randomUUID()
const DOC_OWNER = randomUUID()
const DOC_OTHER = randomUUID()

async function insertMailbox(acc: string, conv: string, owner: string, email: string) {
  await sql.unsafe(
    `INSERT INTO app_mail.accounts
       (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
     VALUES ('${acc}', '${ORG}', gen_random_uuid(), 'user', '${owner}', 'gmail', '${email}', 'idle')`,
  )
  await sql.unsafe(
    `INSERT INTO app_mail.conversations
       (id, org_id, account_id, owner_type, owner_id, external_thread_id, status,
        labels, is_read, is_starred, message_count)
     VALUES ('${conv}', '${ORG}', '${acc}', 'user', '${owner}', 'ext-${conv}', 'open', '[]', false, false, 0)`,
  )
}

async function insertMessage(id: string, conv: string, acc: string, owner: string, from: string) {
  await sql.unsafe(
    `INSERT INTO app_mail.messages
       (id, org_id, conversation_id, account_id, message_references, from_address,
        to_addresses, cc_addresses, bcc_addresses, labels, direction, raw_headers,
        owner_type, owner_id, is_read, is_starred)
     VALUES ('${id}', '${ORG}', '${conv}', '${acc}', '[]', '{"email":"${from}"}', '[]', '[]', '[]',
             '[]', 'inbound', '{}', 'user', '${owner}', false, false)`,
  )
}

async function insertCalendar(acc: string, cal: string, evt: string, owner: string) {
  await sql.unsafe(
    `INSERT INTO app_calendar.accounts
       (id, org_id, connected_account_id, owner_type, owner_id, email_address, sync_status)
     VALUES ('${acc}', '${ORG}', gen_random_uuid(), 'user', '${owner}', '${acc}@cal.test', 'active')`,
  )
  await sql.unsafe(
    `INSERT INTO app_calendar.calendars
       (id, org_id, account_id, google_calendar_id, name, calaccess)
     VALUES ('${cal}', '${ORG}', '${acc}', 'g-${cal}', 'Cal', '${acc}')`,
  )
  await sql.unsafe(
    `INSERT INTO app_calendar.events
       (id, org_id, calendar_id, google_event_id, title, start, "end", calaccess)
     VALUES ('${evt}', '${ORG}', '${cal}', 'g-${evt}', 'Meeting', '{"dateTime":"2026-10-08T09:00:00Z"}', '{"dateTime":"2026-10-08T10:00:00Z"}', '${acc}')`,
  )
}

async function fire(evt: {
  app: string
  entity: string
  action: string
  entityId: string
  data?: Record<string, unknown>
}) {
  await _publishEventInternal({ ...evt, orgId: ORG })
  await flushEventHandlers()
  // The gate reads the database before it enqueues; give it the time to.
  await new Promise((r) => setTimeout(r, COALESCE_MS + 150))
}

async function subscribe(event: string, filter?: MailSenderFilter) {
  await registerEventRoutineSubscription({ routineId: ROUTINE, orgId: ORG, event, filter })
  const [app, ...rest] = event.split(":")
  setDeclaredEmits(ORG, app as string, new Set([rest.join(":")]))
}

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_mail")
  await acquireAppSchemaJsLock("app_tickets")
  await acquireAppSchemaJsLock("app_calendar")
  try {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Owner Gate Org', ${`owner-gate-${ORG}`})`
    for (const [id, name] of [
      [OWNER, "Owner"],
      [OTHER, "Other"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${`${id}@gate.test`}, ${name}, 'active', 'hash')`
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${id}, ${ORG}, '*')`
    }
    await sql`INSERT INTO kernel.routines
        (id, org_id, owner_user_id, name, description, kind, event, prompt, scopes, created_by_actor_type)
      VALUES (${ROUTINE}, ${ORG}, ${OWNER}, 'gate', 'gate', 'event', 'mail:message:create',
              'react', ${sql.array(["mail:conversations:read"])}, 'user')`

    // Imported after the jobs mock: the app runtime pulls in the subscriber.
    const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
    const { mailAppManifest } = await import("~/apps/mail/manifest-descriptor")
    const { ticketsAppManifest } = await import("~/apps/tickets/manifest-descriptor")
    const { registerApps } = await import("~/modules/apps/runtime")
    initEventBus()
    setDeclaredEmits(
      "*",
      "kernel",
      new Set(["connected_account:create", "connected_account:disconnect", "user:registered"]),
    )
    await registerApps(
      [
        mailAppManifest as unknown as AppDescriptor,
        ticketsAppManifest as unknown as AppDescriptor,
        calendarAppManifest as unknown as AppDescriptor,
      ],
      ORG,
    )

    await insertMailbox(ACC_OWNER, CONV_OWNER, OWNER, "owner@gate.test")
    await insertMailbox(ACC_OTHER, CONV_OTHER, OTHER, "other@gate.test")
    await insertMessage(MSG_OWNER, CONV_OWNER, ACC_OWNER, OWNER, "client@acme.test")
    await insertMessage(MSG_OTHER, CONV_OTHER, ACC_OTHER, OTHER, "client@acme.test")
    await insertMessage(MSG_OWNER_2, CONV_OWNER, ACC_OWNER, OWNER, "grouped@acme.test")
    await insertMessage(MSG_OWNER_3, CONV_OWNER, ACC_OWNER, OWNER, "private@acme.test")
    await insertMessage(MSG_OWNER_OUT, CONV_OWNER, ACC_OWNER, OWNER, "owner@gate.test")

    await insertCalendar(CAL_ACC_OWNER, CAL_OWNER, EVT_OWNER, OWNER)
    await insertCalendar(CAL_ACC_OTHER, CAL_OTHER, EVT_OTHER, OTHER)
    // Connecting a calendar grants its access dimension. The owner holds BOTH accounts'
    // values here: the personal-owner check, not the dimension, must keep OTHER's out.
    await sql`INSERT INTO kernel.user_dimension_grants (id, user_id, org_id, dimension_key, dimension_values)
      VALUES (gen_random_uuid(), ${OWNER}, ${ORG}, 'calendar:calaccess',
              ${JSON.stringify([CAL_ACC_OWNER, CAL_ACC_OTHER])}::jsonb)`

    await sql`INSERT INTO kernel.contacts (id, org_id, handle, email, org_access)
      VALUES (${CONTACT_ORG}, ${ORG}, ${`c-${CONTACT_ORG}`}, 'client@acme.test', 'viewer')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, email, org_access)
      VALUES (${CONTACT_GROUPED}, ${ORG}, ${`c-${CONTACT_GROUPED}`}, 'grouped@acme.test', 'viewer')`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, email, org_access, owner_user_id)
      VALUES (${CONTACT_PRIVATE}, ${ORG}, ${`c-${CONTACT_PRIVATE}`}, 'private@acme.test', 'none', ${OTHER})`
    await sql`INSERT INTO kernel.contact_segments (id, org_id, name, kind)
      VALUES (${GROUP}, ${ORG}, 'VIP', 'manual')`
    await sql`INSERT INTO kernel.contact_group_members (segment_id, contact_id, org_id)
      VALUES (${GROUP}, ${CONTACT_GROUPED}, ${ORG}), (${GROUP}, ${CONTACT_PRIVATE}, ${ORG})`

    for (const [id, owner] of [
      [MCP_OWNER, OWNER],
      [MCP_OTHER, OTHER],
    ] as const) {
      await sql.unsafe(
        `INSERT INTO app_mcp_manager.mcp_connections
           (id, org_id, slug, display_name, transport, ownership_scope, owner_user_id, http_url, created_by)
         VALUES ('${id}', '${ORG}', 'mcp-${id.slice(0, 8)}', 'MCP', 'http', 'personal', '${owner}', 'https://mcp.test', '${owner}')`,
      )
    }
    for (const [id, owner] of [
      [DOC_OWNER, OWNER],
      [DOC_OTHER, OTHER],
    ] as const) {
      await sql.unsafe(
        `INSERT INTO app_knowledge.documents
           (id, org_id, title, created_by, required_scopes, document_scope, owner_user_id, participant_ids)
         VALUES ('${id}', '${ORG}', 'Doc', '${owner}', '{}', 'personal', '${owner}', '[]')`,
      )
    }
  } catch (err) {
    await releaseAppSchemaJsLock("app_calendar")
    await releaseAppSchemaJsLock("app_tickets")
    await releaseAppSchemaJsLock("app_mail")
    throw err
  }
}, 120_000)

afterAll(async () => {
  try {
    await sql.unsafe(`DELETE FROM app_knowledge.documents WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_mcp_manager.mcp_connections WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_calendar.events WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_calendar.calendars WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_calendar.accounts WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_mail.messages WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_mail.conversations WHERE org_id = '${ORG}'`)
    await sql.unsafe(`DELETE FROM app_mail.accounts WHERE org_id = '${ORG}'`)
    await sql`DELETE FROM kernel.contact_group_members WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contact_segments WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    resetAppRegistries()
  } finally {
    await releaseAppSchemaJsLock("app_calendar")
    await releaseAppSchemaJsLock("app_tickets")
    await releaseAppSchemaJsLock("app_mail")
  }
})

beforeEach(() => {
  enqueued.length = 0
  __resetEventRoutineSubscriber()
  resetEventBus()
  initEventBus()
})

describe("owner gate: one pair per ownership-bearing family", () => {
  test("mail message: another member's personal mailbox never reaches the routine", async () => {
    await subscribe("mail:message:create")
    const data = (id: string, conv: string, acc: string) => ({
      id,
      conversationId: conv,
      accountId: acc,
      direction: "inbound",
      from: { email: "client@acme.test" },
    })
    await fire({
      app: "mail",
      entity: "message",
      action: "create",
      entityId: MSG_OTHER,
      data: data(MSG_OTHER, CONV_OTHER, ACC_OTHER),
    })
    expect(ticks().length).toBe(0)
    await fire({
      app: "mail",
      entity: "message",
      action: "create",
      entityId: MSG_OWNER,
      data: data(MSG_OWNER, CONV_OWNER, ACC_OWNER),
    })
    expect(ticks().length).toBe(1)
  })

  test("mail conversation: another member's personal conversation is dropped", async () => {
    await subscribe("mail:conversation:create")
    await fire({
      app: "mail",
      entity: "conversation",
      action: "create",
      entityId: CONV_OTHER,
      data: { id: CONV_OTHER, accountId: ACC_OTHER },
    })
    expect(ticks().length).toBe(0)
    await fire({
      app: "mail",
      entity: "conversation",
      action: "create",
      entityId: CONV_OWNER,
      data: { id: CONV_OWNER, accountId: ACC_OWNER },
    })
    expect(ticks().length).toBe(1)
  })

  test("mail conversation delete: the mailbox decides once the row is gone", async () => {
    await subscribe("mail:conversation:delete")
    const gone = randomUUID()
    await fire({
      app: "mail",
      entity: "conversation",
      action: "delete",
      entityId: gone,
      data: { id: gone, accountId: ACC_OTHER },
    })
    expect(ticks().length).toBe(0)
    await fire({
      app: "mail",
      entity: "conversation",
      action: "delete",
      entityId: gone,
      data: { id: gone, accountId: ACC_OWNER },
    })
    expect(ticks().length).toBe(1)
  })

  test("calendar event: another member's personal calendar is dropped", async () => {
    await subscribe("calendar:event:create")
    await fire({ app: "calendar", entity: "event", action: "create", entityId: EVT_OTHER })
    expect(ticks().length).toBe(0)
    await fire({ app: "calendar", entity: "event", action: "create", entityId: EVT_OWNER })
    expect(ticks().length).toBe(1)
  })

  test("contact: a private contact of another member (org_access none) is dropped", async () => {
    await subscribe("kernel:contact:update")
    await fire({ app: "kernel", entity: "contact", action: "update", entityId: CONTACT_PRIVATE })
    expect(ticks().length).toBe(0)
    await fire({ app: "kernel", entity: "contact", action: "update", entityId: CONTACT_ORG })
    expect(ticks().length).toBe(1)
  })

  test("mcp-manager connection: another member's personal connection is dropped", async () => {
    await subscribe("mcp-manager:connection:updated")
    await fire({
      app: "mcp-manager",
      entity: "connection",
      action: "updated",
      entityId: MCP_OTHER,
    })
    expect(ticks().length).toBe(0)
    await fire({
      app: "mcp-manager",
      entity: "connection",
      action: "updated",
      entityId: MCP_OWNER,
    })
    expect(ticks().length).toBe(1)
  })

  test("knowledge document: another member's private document is dropped", async () => {
    await subscribe("knowledge:document:update")
    await fire({ app: "knowledge", entity: "document", action: "update", entityId: DOC_OTHER })
    expect(ticks().length).toBe(0)
    await fire({ app: "knowledge", entity: "document", action: "update", entityId: DOC_OWNER })
    expect(ticks().length).toBe(1)
  })

  test("a family with no owner-scoped entity passes as before", async () => {
    await subscribe("tickets:ticket:create")
    await fire({ app: "tickets", entity: "ticket", action: "create", entityId: randomUUID() })
    expect(ticks().length).toBe(1)
  })
})

describe("mail sender filter (S26)", () => {
  const msgEvent = (id: string, from: string, direction = "inbound", senderAuth = "pass") => ({
    app: "mail",
    entity: "message",
    action: "create",
    entityId: id,
    data: {
      id,
      conversationId: CONV_OWNER,
      accountId: ACC_OWNER,
      direction,
      from: { email: from },
      senderAuth,
    },
  })

  test("pure: inbound only, contact or group match, empty filter passes", () => {
    const evt = { ...msgEvent(MSG_OWNER, "Client@Acme.test"), orgId: ORG }
    expect(inboundSenderEmail(evt)).toBe("client@acme.test")
    expect(inboundSenderEmail({ ...msgEvent(MSG_OWNER, "x@y.z", "outbound"), orgId: ORG })).toBe(
      null,
    )
    expect(isMailSenderFilterActive({})).toBe(false)
    expect(isMailSenderFilterActive({ fromGroupIds: [GROUP] })).toBe(true)
    const none = { contactIds: [], groupIds: [] }
    expect(mailSenderFilterMatches(undefined, evt, none)).toBe(true)
    expect(mailSenderFilterMatches({ fromContactIds: ["c1"] }, evt, none)).toBe(false)
    expect(
      mailSenderFilterMatches({ fromContactIds: ["c1"] }, evt, {
        contactIds: ["c1"],
        groupIds: [],
      }),
    ).toBe(true)
    expect(
      mailSenderFilterMatches({ fromGroupIds: ["g1"] }, evt, {
        contactIds: ["c9"],
        groupIds: ["g1"],
      }),
    ).toBe(true)
    const outbound = { ...msgEvent(MSG_OWNER, "client@acme.test", "outbound"), orgId: ORG }
    expect(
      mailSenderFilterMatches({ fromContactIds: ["c1"] }, outbound, {
        contactIds: ["c1"],
        groupIds: [],
      }),
    ).toBe(false)
  })

  test("a contact filter: the matching sender enqueues one tick, any other none", async () => {
    await subscribe("mail:message:create", { fromContactIds: [CONTACT_ORG] })
    await fire(msgEvent(MSG_OWNER_2, "grouped@acme.test"))
    expect(ticks().length).toBe(0)
    await fire(msgEvent(MSG_OWNER, "client@acme.test"))
    expect(ticks().length).toBe(1)
  })

  test("a group filter: a visible member enqueues, an invisible member does not", async () => {
    await subscribe("mail:message:create", { fromGroupIds: [GROUP] })
    // private@acme.test is in the group, but as OTHER's private contact the owner cannot see it.
    await fire(msgEvent(MSG_OWNER_3, "private@acme.test"))
    expect(ticks().length).toBe(0)
    await fire(msgEvent(MSG_OWNER_2, "grouped@acme.test"))
    expect(ticks().length).toBe(1)
  })

  test("pure: a sender the provider did not authenticate never matches a sender filter", () => {
    const member = { contactIds: ["c1"], groupIds: ["g1"] }
    for (const verdict of ["none", "fail"]) {
      const evt = { ...msgEvent(MSG_OWNER, "client@acme.test", "inbound", verdict), orgId: ORG }
      expect(mailSenderFilterMatches({ fromContactIds: ["c1"] }, evt, member)).toBe(false)
      expect(mailSenderFilterMatches({ fromGroupIds: ["g1"] }, evt, member)).toBe(false)
      // An inactive filter still passes everything.
      expect(mailSenderFilterMatches(undefined, evt, member)).toBe(true)
    }
  })

  test("a contact filter does not fire for a forged sender", async () => {
    await subscribe("mail:message:create", { fromContactIds: [CONTACT_ORG] })
    await fire(msgEvent(MSG_OWNER, "client@acme.test", "inbound", "none"))
    expect(ticks().length).toBe(0)
  })

  test("an outbound message never matches a sender filter", async () => {
    await subscribe("mail:message:create", { fromContactIds: [CONTACT_ORG] })
    await fire(msgEvent(MSG_OWNER_OUT, "client@acme.test", "outbound"))
    expect(ticks().length).toBe(0)
  })
})
