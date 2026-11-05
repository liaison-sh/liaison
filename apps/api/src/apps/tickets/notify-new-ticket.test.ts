// SPDX-License-Identifier: FSL-1.1-ALv2
// An inbox's "Notify on new ticket": each new ticket raises one attention item
// for the holders of tickets:inboxes:admin, through the one attention pipeline
// (outbox -> translator -> kernel.attention_events). Off by default; a monitoring
// inbox stays silent; history (imports, a backfill, backdated tickets) and a
// thread we opened ourselves are not news; a mail appended to a ticket adds nothing.
import { beforeAll, describe, expect, it } from "bun:test"
import { DEFAULT_GRID, groupForKind } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { runAdminOp } from "~/apps/tickets/admin"
import { createTicket } from "~/apps/tickets/create"
import { isNewTicketNews, processInboundMessage } from "~/apps/tickets/inbound"
import { validateAndApply } from "~/apps/tickets/state-machine"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { type AppEvent, initEventBus } from "~/infra/events/event-bus"
import type { ParsedEmail } from "~/lib/email/types"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { processTranslationEvent, registerTranslatorConsumer } from "~/modules/attention/translator"
import { ticketsPublicRoutes } from "~/modules/webhooks/tickets-public"
import { seedContext } from "~/seed/context"
import {
  ensureTicketMailboxAccount,
  ensureTicketMailboxInbox,
} from "~/seed/factories/support/inboxes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { drainOutbox } from "~/tests/helpers/outbox"

const KIND = "tickets:ticket.created"
const SYSTEM = { actorType: "system", userId: "00000000-0000-0000-0000-000000000000" } as never

let orgId: string
let holder: minimal.Person
let otherHolder: minimal.Person
let member: minimal.Person
let flagged: string
let plain: string
let silent: string
let mailboxInbox: Record<string, unknown>
let mailboxId: string
let apiKey: string
let n = 0

const admin = (op: string, params: Record<string, unknown>) =>
  withPrivilegedDb(orgId, "notify-new-ticket-admin", (tx) =>
    runAdminOp(tx as never, orgId, op as never, params, {
      actorType: "user",
      userId: holder.id,
    }),
  ) as Promise<Record<string, unknown>>

async function items(ticketId: string) {
  return extractRows<{
    user_id: string
    kind: string
    entity_type: string
    summary: string
    urgency: number
    is_urgent: boolean
    digest_state: string
    read_at: Date | null
  }>(
    await db.execute(drizzleSql`
      SELECT user_id::text AS user_id, kind, entity_type, summary, urgency, is_urgent,
             digest_state, read_at
      FROM kernel.attention_events
      WHERE org_id = ${orgId} AND app = 'tickets' AND entity_id = ${ticketId} AND kind = ${KIND}`),
  )
}

const itemFor = async (ticketId: string, userId: string) =>
  (await items(ticketId)).filter((r) => r.user_id === userId)

async function createdEvents(ticketId: string): Promise<AppEvent[]> {
  return extractRows<{ payload: AppEvent }>(
    await db.execute(drizzleSql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'tickets' AND payload->>'entity' = 'ticket'
        AND payload->>'action' = 'create' AND payload->>'entityId' = ${ticketId}`),
  ).map((r) => r.payload)
}

async function create(params: Record<string, unknown>, opts = {}, actor: never = SYSTEM) {
  const result = await withPrivilegedDb(orgId, "notify-new-ticket-create", (tx) =>
    createTicket(
      tx as never,
      orgId,
      {
        subject: `Subject ${++n}`,
        channel: "api",
        initialMessage: {
          kind: "inbound",
          fromEmail: "jane@customer.test",
          fromName: "Jane Doe",
          textBody: "THE-PRIVATE-BODY",
        },
        ...params,
      } as never,
      actor,
      { privilegedTx: tx, ...opts },
    ),
  )
  if ("error" in result) throw new Error(result.error.message)
  return result.ticketId
}

function mail(over: Partial<ParsedEmail> = {}): ParsedEmail {
  const id = ++n
  return {
    messageId: `<notify-${id}@customer.test>`,
    from: { email: "jane@customer.test", name: "Jane Doe" },
    to: [{ email: "desk@notify.test" }],
    cc: [],
    subject: `Mail ${id}`,
    textBody: "THE-PRIVATE-BODY",
    headers: {},
    sentAt: new Date().toISOString(),
    ...over,
  } as ParsedEmail
}

async function ingest(raw: ParsedEmail, ctx: { noAcknowledgement?: boolean } = {}) {
  const inbox = { ...mailboxInbox, org_id: orgId }
  const result = await withPrivilegedDb(orgId, "notify-new-ticket-inbound", (tx) =>
    processInboundMessage(raw, inbox as never, { db: tx, orgId, ...ctx } as never),
  )
  if ("error" in result) throw new Error(result.error.message)
  return result
}

beforeAll(async () => {
  orgId = (await createTestOrg()).id
  initEventBus()
  registerTranslatorConsumer()
  await ensureAppsForOrg(orgId, {})
  holder = await minimal.person(orgId)
  otherHolder = await minimal.person(orgId)
  member = await minimal.person(orgId)
  await minimal.grantScope(holder.id, "tickets:inboxes:admin")
  await minimal.grantScope(otherHolder.id, "tickets:inboxes:admin")

  flagged = String(
    (await admin("inboxesCreate", { kind: "api", name: "Website", notifyNewTicket: true })).id,
  )
  plain = String((await admin("inboxesCreate", { kind: "api", name: "Plain" })).id)
  silent = String(
    (
      await admin("inboxesCreate", {
        kind: "api",
        name: "Telemetry",
        notifyNewTicket: true,
        suppressAttention: true,
      })
    ).id,
  )
  const seed = seedContext({ orgId, now: new Date() })
  const inbox = await ensureTicketMailboxInbox(seed, {
    key: "notify-desk",
    name: "Desk",
    emailAddress: "desk@notify.test",
    // The default inbox for new tickets must have an active mailbox.
    connectedAccountId: await ensureTicketMailboxAccount(seed, {
      key: "notify-desk",
      emailAddress: "desk@notify.test",
      createdBy: holder.id,
    }),
  })
  mailboxId = inbox.id
  await admin("inboxesUpdate", { id: mailboxId, notifyNewTicket: true })
  const list = (await admin("inboxesList", {})) as unknown as Array<Record<string, unknown>>
  mailboxInbox = list.find((i) => i.id === mailboxId)!
  apiKey = String((await admin("apiKeysCreate", { label: "form", inboxId: flagged })).key)
  await drainOutbox()
})

describe("the setting", () => {
  it("is off by default and surfaces in the inbox list", async () => {
    const list = (await admin("inboxesList", {})) as unknown as Array<Record<string, unknown>>
    expect(list.find((i) => i.id === plain)?.notify_new_ticket).toBe(false)
    expect(list.find((i) => i.id === flagged)?.notify_new_ticket).toBe(true)
  })

  it("can be switched on and off by update", async () => {
    await admin("inboxesUpdate", { id: plain, notifyNewTicket: true })
    let list = (await admin("inboxesList", {})) as unknown as Array<Record<string, unknown>>
    expect(list.find((i) => i.id === plain)?.notify_new_ticket).toBe(true)
    await admin("inboxesUpdate", { id: plain, notifyNewTicket: false })
    list = (await admin("inboxesList", {})) as unknown as Array<Record<string, unknown>>
    expect(list.find((i) => i.id === plain)?.notify_new_ticket).toBe(false)
  })
})

describe("the API path, through the real pipeline", () => {
  const post = (body: unknown) =>
    new Hono().route("/webhooks", ticketsPublicRoutes).fetch(
      new Request(`http://x/webhooks/${orgId}/inboxes/${flagged}/tickets/create`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      }),
    )

  it("a website form's ticket reaches kernel.attention_events for each holder, nobody else", async () => {
    const res = await post({
      subject: "Pricing question",
      fromEmail: "visitor@customer.test",
      fromName: "Vera Visitor",
      textBody: "THE-PRIVATE-BODY",
      externalRef: `form-${Date.now()}`,
    })
    expect(res.status).toBeLessThan(300)
    const body = (await res.json()) as { data?: { ticketId?: string }; ticketId?: string }
    const ticketId = body.data?.ticketId ?? body.ticketId ?? ""
    expect(ticketId).not.toBe("")
    await drainOutbox()

    const [row] = await itemFor(ticketId, holder.id)
    expect(row?.entity_type).toBe("ticket")
    expect(row?.summary).toBe(
      "New ticket in Website: Pricing question (from Vera Visitor <visitor@customer.test>)",
    )
    expect(row?.summary).not.toContain("THE-PRIVATE-BODY")
    // Not urgent: it follows quiet hours. The digest holds it.
    expect(row?.is_urgent).toBe(false)
    expect(row?.digest_state).toBe("pending")
    expect(await itemFor(ticketId, otherHolder.id)).toHaveLength(1)
    expect(await itemFor(ticketId, member.id)).toHaveLength(0)
  })

  it("an API ticket in an inbox without the flag raises nothing", async () => {
    const ticketId = await create({ sourceInboxId: plain })
    await drainOutbox()
    expect(await items(ticketId)).toHaveLength(0)
  })

  it("a flagged monitoring inbox stays silent", async () => {
    const ticketId = await create({ sourceInboxId: silent })
    const [event] = await createdEvents(ticketId)
    expect((event as AppEvent).data).not.toHaveProperty("notifyNewTicket")
    await drainOutbox()
    expect(await items(ticketId)).toHaveLength(0)
  })

  it("carries the ticket's dimensions, so the socket keeps the notice in its team", async () => {
    const ticketId = await create({ sourceInboxId: flagged, team: "Sales" })
    const [event] = await createdEvents(ticketId)
    expect(event?.data).toMatchObject({
      notifyNewTicket: true,
      inboxName: "Website",
      "tickets:team": "Sales",
      "tickets:sensitivity": "internal",
    })
    await drainOutbox()
  })
})

describe("the mailbox path", () => {
  it("a new mail raises one item; a reply on the thread raises none", async () => {
    const first = mail()
    const created = await ingest(first)
    expect(created).toMatchObject({ outcome: "created" })
    const ticketId = (created as { ticketId: string }).ticketId
    await drainOutbox()
    const [row] = await itemFor(ticketId, holder.id)
    expect(row?.summary).toBe(
      `New ticket in Desk: ${first.subject} (from Jane Doe <jane@customer.test>)`,
    )
    expect(await itemFor(ticketId, holder.id)).toHaveLength(1)

    // Read, so a second notice could not hide in the unread upsert.
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events SET read_at = now()
      WHERE org_id = ${orgId} AND entity_id = ${ticketId} AND kind = ${KIND}`)
    const appended = await ingest(
      mail({ subject: `Re: ${first.subject}`, inReplyTo: first.messageId as string }),
    )
    expect(appended).toMatchObject({ outcome: "appended", ticketId })
    await drainOutbox()
    expect(await itemFor(ticketId, holder.id)).toHaveLength(1)
  })

  it("a first sync's history raises nothing", async () => {
    const created = await ingest(mail(), { noAcknowledgement: true })
    const ticketId = (created as { ticketId: string }).ticketId
    await drainOutbox()
    expect(await items(ticketId)).toHaveLength(0)
  })

  it("a thread we opened by writing first raises nothing", async () => {
    const created = await ingest(
      mail({
        from: { email: "desk@notify.test", name: "Desk" },
        to: [{ email: "jane@customer.test" }],
        receivedVia: "gmail_api",
        labelIds: ["SENT"],
      }),
    )
    const ticketId = (created as { ticketId: string }).ticketId
    await drainOutbox()
    expect(await items(ticketId)).toHaveLength(0)
  })

  it("mail counts as news only while recent, and an undated one counts", () => {
    const now = Date.parse("2026-11-05T12:00:00Z")
    const at = (iso: string) => ({ sentAt: iso }) as ParsedEmail
    expect(isNewTicketNews(at("2026-11-05T02:00:00Z"), "inbound", false, now)).toBe(true)
    expect(isNewTicketNews(at("2026-10-20T12:00:00Z"), "inbound", false, now)).toBe(false)
    expect(isNewTicketNews({} as ParsedEmail, "inbound", false, now)).toBe(true)
    expect(isNewTicketNews(at("2026-11-05T02:00:00Z"), "inbound", true, now)).toBe(false)
    expect(isNewTicketNews(at("2026-11-05T02:00:00Z"), "outbound", false, now)).toBe(false)
  })
})

describe("every creation path, and what is not news", () => {
  it("the default inbox's flag counts when the caller names no inbox", async () => {
    await admin("inboxesUpdate", { id: mailboxId, isDefaultForCreate: true })
    const ticketId = await create({})
    await drainOutbox()
    expect(await itemFor(ticketId, holder.id)).toHaveLength(1)
  })

  it("an import and a backdated ticket raise nothing", async () => {
    const imported = await create({ sourceInboxId: flagged }, { notNews: true })
    const backdated = await create({
      sourceInboxId: flagged,
      createdAt: "2024-01-02T03:04:05Z",
    })
    await drainOutbox()
    expect(await items(imported)).toHaveLength(0)
    expect(await items(backdated)).toHaveLength(0)
  })

  it("the person who opens the ticket is not told, the other admins are", async () => {
    const ticketId = await create({ sourceInboxId: flagged }, {}, {
      actorType: "user",
      userId: holder.id,
    } as never)
    await drainOutbox()
    expect(await itemFor(ticketId, holder.id)).toHaveLength(0)
    expect(await itemFor(ticketId, otherHolder.id)).toHaveLength(1)
  })

  it("a redelivered event stays one unread item and one per ticket", async () => {
    const ticketId = await create({ sourceInboxId: flagged })
    const [event] = await createdEvents(ticketId)
    await drainOutbox()
    await processTranslationEvent(event as AppEvent)
    expect(await itemFor(ticketId, holder.id)).toHaveLength(1)
  })
})

describe("after the notice", () => {
  it("the item leaves the feed once someone handled the ticket", async () => {
    const ticketId = await create({ sourceInboxId: flagged })
    await drainOutbox()
    const [before] = await itemFor(ticketId, holder.id)
    expect(before?.read_at).toBeNull()
    const closed = await withPrivilegedDb(orgId, "notify-new-ticket-close", (tx) =>
      validateAndApply(tx as never, ticketId, { kind: "close", closedReason: "resolved" }, {
        actorType: "system",
        userId: holder.id,
        orgId,
      } as never),
    )
    expect("error" in (closed as object)).toBe(false)
    await drainOutbox()
    const [after] = await itemFor(ticketId, holder.id)
    expect(after?.read_at).not.toBeNull()
  })
})

describe("the channels it reaches by default", () => {
  it("is the 'Approvals and access requests' row: feed, computer, phone and digest", () => {
    expect(groupForKind(KIND)).toBe("approvals")
    expect(DEFAULT_GRID.approvals).toEqual({ in_app: true, desktop: true, push: true, email: true })
  })
})
