// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { ensureAppsForOrg } from "~/modules/apps/init"

const K = () => drizzleSql.raw(schemaRef("kernel"))

export interface TicketFixture {
  tx: typeof db
  orgId: string
  userId: string
  ticketId: string
  messageId: string
  actor: ActorContext
}

export interface TicketFixtureOptions {
  closed?: boolean
}

async function ensureOrg(): Promise<{ orgId: string; userId: string }> {
  const slug = `tickets-readstate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO ${K()}.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Read State Org', ${slug}) RETURNING id
    `),
  )
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO ${K()}.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${org.id}, ${`rs-${slug}@test.com`}, 'RS Tester', 'active', 'hash', 1, 1) RETURNING id
    `),
  )
  await ensureAppsForOrg(org.id, {})
  return { orgId: org.id, userId: user.id }
}

async function seedTicket(
  orgId: string,
  options: TicketFixtureOptions,
): Promise<{ ticketId: string; messageId: string }> {
  const ticketId = crypto.randomUUID()
  const status = options.closed ? "closed" : "open"
  const handle = `ticket-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const replyToken = `RT${Date.now().toString().slice(-13)}`
  await withSystemDb("read-state-fixture-ticket", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        last_inbound_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${ticketId}, ${orgId}, ${handle}, 'Read state fixture', ${status}, 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1,
        now(), now(),
        now(), now()
      )
    `)
  })
  const messageId = crypto.randomUUID()
  await withSystemDb("read-state-fixture-message", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, text_body, sent_at, created_at, updated_at)
      VALUES (${messageId}, ${orgId}, ${ticketId}, 'inbound', 'hi', now(), now(), now())
    `)
  })
  return { ticketId, messageId }
}

export async function withTicketFixture<T>(
  optionsOrFn: TicketFixtureOptions | ((f: TicketFixture) => Promise<T>),
  maybeFn?: (f: TicketFixture) => Promise<T>,
): Promise<T> {
  const options: TicketFixtureOptions = typeof optionsOrFn === "function" ? {} : optionsOrFn
  const fn = (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn) as (
    f: TicketFixture,
  ) => Promise<T>
  const { orgId, userId } = await ensureOrg()
  const { ticketId, messageId } = await seedTicket(orgId, options)
  const actor: ActorContext = {
    actorType: "user",
    userId,
    orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: { team: ["*"], sensitivity: ["restricted"] },
  } as ActorContext
  return fn({ tx: db, orgId, userId, ticketId, messageId, actor })
}

export interface InboxFixture {
  tx: typeof db
  orgId: string
  userId: string
  inboxA: string
  inboxB: string
  otherOrgInboxId?: string
}

export interface InboxFixtureOptions {
  noInbound?: boolean
  otherOrgInbox?: boolean
  /** Also seed one unread open ticket with NO source inbox (imported/API). */
  orphanUnread?: boolean
  /** Also seed one unread open ticket in inbox B that was MERGED into another. */
  mergedUnread?: boolean
}

async function seedInbox(orgId: string, name: string, emailAddress: string): Promise<string> {
  const id = crypto.randomUUID()
  const connectedAccountId = crypto.randomUUID()
  await withSystemDb("read-state-fixture-inbox", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address, default_sensitivity, is_default_for_create, created_at, updated_at)
      VALUES (${id}, ${orgId}, ${connectedAccountId}, ${name}, ${emailAddress}, 'internal', false, now(), now())
    `)
  })
  return id
}

async function seedTicketInInbox(
  orgId: string,
  inboxId: string | null,
  status: "open" | "closed",
  options: { withInbound: boolean },
): Promise<string> {
  const ticketId = crypto.randomUUID()
  const handle = `ticket-${Date.now()}-${Math.floor(Math.random() * 100000)}`
  const replyToken = `RT${Math.floor(Math.random() * 1e16)}`
  const lastInbound = options.withInbound
    ? drizzleSql`now() - interval '5 minutes'`
    : drizzleSql`NULL`
  await withSystemDb("read-state-fixture-ticket-inbox", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, sensitivity,
        reply_token, sla_target_seconds, sla_deadline,
        sla_active_started_at, sla_elapsed_seconds, message_count,
        source_inbox_id, last_inbound_at, last_message_at,
        created_at, updated_at
      ) VALUES (
        ${ticketId}, ${orgId}, ${handle}, 'fixture', ${status}, 'normal', 'manual', 'internal',
        ${replyToken}, 3600, now() + interval '1 hour',
        now(), 0, 1,
        ${inboxId}, ${lastInbound}, ${lastInbound},
        now(), now()
      )
    `)
  })
  return ticketId
}

export async function withInboxFixture<T>(
  optionsOrFn: InboxFixtureOptions | ((f: InboxFixture) => Promise<T>),
  maybeFn?: (f: InboxFixture) => Promise<T>,
): Promise<T> {
  const options: InboxFixtureOptions = typeof optionsOrFn === "function" ? {} : optionsOrFn
  const fn = (typeof optionsOrFn === "function" ? optionsOrFn : maybeFn) as (
    f: InboxFixture,
  ) => Promise<T>
  const { orgId, userId } = await ensureOrg()
  const inboxA = await seedInbox(orgId, "Inbox A", `a-${Date.now()}@test.com`)
  const inboxB = await seedInbox(orgId, "Inbox B", `b-${Date.now()}@test.com`)
  if (options.noInbound) {
    await seedTicketInInbox(orgId, inboxA, "open", { withInbound: false })
    await seedTicketInInbox(orgId, inboxA, "open", { withInbound: false })
  } else {
    await seedTicketInInbox(orgId, inboxA, "open", { withInbound: true })
    await seedTicketInInbox(orgId, inboxA, "open", { withInbound: true })
    const readTicket = await seedTicketInInbox(orgId, inboxA, "open", { withInbound: true })
    await seedTicketInInbox(orgId, inboxA, "closed", { withInbound: true })
    await seedTicketInInbox(orgId, inboxB, "open", { withInbound: true })
    await withSystemDb("read-state-mark-read", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.ticket_reads (ticket_id, user_id, org_id, read_at)
        VALUES (${readTicket}, ${userId}, ${orgId}, now())
      `)
    })
  }
  if (options.orphanUnread) {
    await seedTicketInInbox(orgId, null, "open", { withInbound: true })
  }
  if (options.mergedUnread) {
    const survivor = await seedTicketInInbox(orgId, inboxB, "closed", { withInbound: false })
    const merged = await seedTicketInInbox(orgId, inboxB, "open", { withInbound: true })
    await withSystemDb("read-state-fixture-merge", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_tickets.tickets SET merged_into_ticket_id = ${survivor} WHERE id = ${merged}
      `)
    })
  }
  let otherOrgInboxId: string | undefined
  if (options.otherOrgInbox) {
    const { orgId: otherOrg } = await ensureOrg()
    otherOrgInboxId = await seedInbox(otherOrg, "Other Org Inbox", `other-${Date.now()}@test.com`)
    await seedTicketInInbox(otherOrg, otherOrgInboxId, "open", { withInbound: true })
  }
  return fn({ tx: db, orgId, userId, inboxA, inboxB, otherOrgInboxId })
}

export interface CrossOrgTicketFixture {
  orgAActor: ActorContext
  orgAId: string
  orgAUserId: string
  orgAOwnTicketId: string
  orgBTicketId: string
}

export async function withCrossOrgTicketFixture<T>(
  fn: (f: CrossOrgTicketFixture) => Promise<T>,
): Promise<T> {
  const a = await ensureOrg()
  const b = await ensureOrg()
  const { ticketId: orgAOwnTicketId } = await seedTicket(a.orgId, {})
  const { ticketId: orgBTicketId } = await seedTicket(b.orgId, {})
  const orgAActor: ActorContext = {
    actorType: "user",
    userId: a.userId,
    orgId: a.orgId,
    scopes: ["tickets:tickets:read", "tickets:tickets:write"],
    dimensionGrants: {
      team: ["*"],
      sensitivity: ["restricted"],
      "tickets:team": ["*"],
      "tickets:sensitivity": ["restricted"],
    },
  } as ActorContext
  return fn({
    orgAActor,
    orgAId: a.orgId,
    orgAUserId: a.userId,
    orgAOwnTicketId,
    orgBTicketId,
  })
}
