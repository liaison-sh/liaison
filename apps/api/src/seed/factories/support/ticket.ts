// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One ticket at a time, for a test that needs a ticket of a given shape on an
// org it already has (the `/api/_test/seed` route's tickets group). The
// queue factory (`tickets.ts`) seeds a whole backlog from specs; this one
// takes the few fields a test asserts on.
//
// Product services wherever one exists: `createTicket` (status, closed reason,
// external reference, inbox, contact, team, assignee, backdated clock),
// `mergeTickets` for a ticket merged into another, the state machine's close
// for tickets a test needs out of a feed (`closeTickets`), and the tickets app's admin operation for an API key (as the
// person who creates it, the only actor the product lets do that).
//
// Privileged: the tickets app's services run on the privileged connection in
// the product too, with an actor reference naming the org's admin.
// Raw SQL only for HISTORY (`insertTicketMessageHistory`, a later message of
// the thread; `shiftTicketClock`, a deadline or a snooze time has carried past)
// and one resting row: a mailbox inbox bound to a placeholder
// account (`ensureTicketMailboxInbox`, inboxes.ts), as the standard tier
// seeds its inboxes.
import { sql } from "drizzle-orm"
import { runAdminOp } from "~/apps/tickets/admin"
import { createTicket } from "~/apps/tickets/create"
import { mergeTickets } from "~/apps/tickets/merge"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { validateAndApply } from "~/apps/tickets/state-machine"
import { withPrivilegedDb } from "~/db/privileged"
import type { SeedContext } from "~/seed/context"
import { rowsOf } from "~/seed/factories/people/actors"
import {
  insertTicketMessageHistory,
  type TicketMessageKind,
} from "~/seed/factories/support/tickets"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export interface OneTicketInput {
  /** Stable key of this ticket within the org: its customer address and message ids derive from it. */
  key: string
  /** The admin the services act for (system actor reference). */
  adminUserId: string
  subject: string
  status?: "open" | "awaiting_customer" | "awaiting_followup" | "closed"
  priority?: "low" | "normal" | "high" | "urgent"
  closedReason?: "resolved" | "merged" | "spam" | "duplicate" | "no_response"
  sourceInboxId?: string | null
  contactId?: string | null
  externalRef?: string | null
  /** Merge the new ticket into this one (closes it as `merged`). */
  mergedIntoTicketId?: string | null
  /** The customer's first message, five minutes before `now` (or at `createdMinutesAgo`). Default true. */
  withInboundMessage?: boolean
  /** The team the ticket is filed under (a `team` dimension value). */
  team?: string | null
  /** The person the ticket is assigned to. */
  assignedTo?: string | null
  /** Backdate the ticket, its SLA clock and its first message (`createTicket`'s `createdAt`). */
  createdMinutesAgo?: number
  /** When it was first answered (`createTicket`'s `firstResponseAt`), minutes before `now`. */
  firstResponseMinutesAgo?: number
  sensitivity?: "internal" | "confidential" | "restricted"
  /**
   * Snooze it until `at` with `reason` (the state machine's `setFollowup`, which
   * leaves it `awaiting_followup`). An `at` in the past is a snooze that has come
   * due: set an hour ahead, then carried back (`shiftTicketClock`).
   */
  followup?: { at: string; reason: string }
}

export interface OneTicket {
  id: string
  handle: string
  subject: string
}

/** A ticket from a customer, through `createTicket` (and `mergeTickets` when asked). */
export async function createOneTicket(ctx: SeedContext, input: OneTicketInput): Promise<OneTicket> {
  const { orgId } = ctx
  const actor = { actorType: "system" as const, userId: input.adminUserId }
  const minutesAgo = (m: number) => new Date(ctx.now.getTime() - m * MINUTE_MS)
  const sentAt = minutesAgo(input.createdMinutesAgo ?? 5)
  const customer = `customer-${ctx.id("ticket-customer", input.key).slice(0, 8)}@e2e.test`
  const merging = Boolean(input.mergedIntoTicketId)
  return withPrivilegedDb(orgId, "seed-ticket:create", async (tx) => {
    // A ticket from a known contact carries their own address and name.
    const [from] = input.contactId
      ? rowsOf<{ email: string | null; name: string | null }>(
          await tx.execute(
            sql`SELECT email, name FROM ${kernelRel("contacts")}
                WHERE id = ${input.contactId}::uuid AND org_id = ${orgId}::uuid`,
          ),
        )
      : []
    const created = await createTicket(
      tx as never,
      orgId,
      {
        subject: input.subject,
        channel: "manual",
        priority: input.priority ?? "normal",
        // A merged ticket is created open, then merged: the merge closes it.
        ...(input.status && !merging ? { status: input.status } : {}),
        ...(input.closedReason && !merging ? { closedReason: input.closedReason } : {}),
        sensitivity: input.sensitivity ?? "internal",
        contactId: input.contactId ?? null,
        sourceInboxId: input.sourceInboxId ?? null,
        externalRef: input.externalRef ?? null,
        ...(input.team ? { team: input.team } : {}),
        ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
        ...(input.createdMinutesAgo !== undefined ? { createdAt: sentAt.toISOString() } : {}),
        ...(input.firstResponseMinutesAgo !== undefined
          ? { firstResponseAt: minutesAgo(input.firstResponseMinutesAgo).toISOString() }
          : {}),
        // A reply is addressed to the customer's message: tickets:reply refuses
        // a ticket with no inbound sender (no_recipient).
        ...(input.withInboundMessage === false
          ? {}
          : {
              initialMessage: {
                kind: "inbound" as const,
                fromEmail: from?.email ?? customer,
                fromName: from?.name ?? "E2E Customer",
                textBody: "hello world",
                sentAt: sentAt.toISOString(),
              },
            }),
      },
      actor,
      { privilegedTx: tx },
    )
    if ("error" in created) {
      throw new Error(`ticket seed: '${input.subject}' refused: ${created.error.message}`)
    }
    if (input.followup) {
      const due = new Date(input.followup.at).getTime()
      const ahead =
        due > Date.now() ? input.followup.at : new Date(Date.now() + HOUR_MS).toISOString()
      const snoozed = await validateAndApply(
        tx as never,
        created.ticketId,
        { kind: "setFollowup", at: ahead, reason: input.followup.reason },
        { ...actor, orgId },
        { privilegedTx: tx },
      )
      if (!snoozed.ok) {
        throw new Error(
          `ticket seed: snoozing '${input.subject}' refused: ${snoozed.code} ${snoozed.message}`,
        )
      }
      if (ahead !== input.followup.at) {
        await shiftClockIn(tx, orgId, created.ticketId, {
          followupAt: new Date(input.followup.at),
        })
      }
    }
    if (input.mergedIntoTicketId) {
      const merged = await mergeTickets(
        tx as never,
        orgId,
        { targetTicketId: input.mergedIntoTicketId, sourceTicketIds: [created.ticketId] },
        actor,
        { privilegedTx: tx },
      )
      if ("error" in merged) {
        throw new Error(`ticket seed: merging '${input.subject}' refused: ${merged.error.message}`)
      }
    }
    return { id: created.ticketId, handle: created.ticketHandle, subject: input.subject }
  })
}

export interface TicketMessageInput {
  kind: TicketMessageKind
  textBody: string
  htmlBody?: string | null
  fromEmail?: string | null
  fromName?: string | null
  subject?: string | null
  /** Seconds from `now` (negative = past). Default: one minute apart, the last one a minute ago. */
  sentAtOffsetSeconds?: number
}

/**
 * HISTORY: later messages of a ticket's thread, through the queue factory's
 * history writer (same columns and counters `createTicket` keeps). An outbound
 * message also stamps the ticket's first response, as a sent reply does.
 * `key` makes the message ids stable, so a repeated call adds nothing.
 */
export async function appendTicketMessages(
  ctx: SeedContext,
  input: { key: string; ticketId: string; adminUserId: string; messages: TicketMessageInput[] },
): Promise<{ count: number; ids: string[] }> {
  const { orgId } = ctx
  return withPrivilegedDb(orgId, "seed-ticket:messages", async (tx) => {
    let count = 0
    const ids: string[] = []
    for (const [i, m] of input.messages.entries()) {
      const offsetSeconds = m.sentAtOffsetSeconds ?? -(input.messages.length - i) * 60
      const sentAt = new Date(ctx.now.getTime() + offsetSeconds * 1000)
      const messageId = ctx.id("ticket-message", `${input.key}:${i}`)
      const added = await insertTicketMessageHistory(
        tx as never,
        orgId,
        input.ticketId,
        messageId,
        {
          kind: m.kind,
          fromEmail: m.fromEmail ?? null,
          fromName: m.fromName ?? null,
          toEmails: [],
          subject: m.subject ?? null,
          textBody: m.textBody,
          htmlBody: m.htmlBody ?? null,
          sentAt,
          createdBy: input.adminUserId,
        },
      )
      if (!added) continue
      count++
      ids.push(messageId)
      if (m.kind === "outbound") {
        await tx.execute(
          sql`UPDATE ${ticketsRel("tickets")}
              SET first_response_at = coalesce(first_response_at, ${sentAt.toISOString()}::timestamptz)
              WHERE id = ${input.ticketId}::uuid`,
        )
      }
    }
    return { count, ids }
  })
}

type PrivilegedTx = Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]

async function shiftClockIn(
  tx: PrivilegedTx,
  orgId: string,
  ticketId: string,
  to: { slaDeadline?: Date; followupAt?: Date },
): Promise<void> {
  const rows = rowsOf<{ id: string }>(
    await tx.execute(
      sql`UPDATE ${ticketsRel("tickets")}
          SET sla_deadline = coalesce(${to.slaDeadline?.toISOString() ?? null}::timestamptz, sla_deadline),
              followup_at = coalesce(${to.followupAt?.toISOString() ?? null}::timestamptz, followup_at)
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          RETURNING id`,
    ),
  )
  if (!rows[0]) throw new Error(`ticket seed: no ticket ${ticketId} to move the clock of`)
}

/**
 * HISTORY: time passing on a ticket, and nothing else. An SLA deadline that
 * has gone by and a snooze that has come due are what the clock does to a
 * ticket the services wrote; no product writer produces either (the state
 * machine refuses a follow-up in the past, and the SLA deadline is derived
 * from the creation time and the targets). Seconds from `now`, negative for
 * the past: the deadline or the follow-up time is set to that instant, the
 * rest of the row is left as the services wrote it.
 */
export async function shiftTicketClock(
  ctx: SeedContext,
  input: { ticketId: string; slaDeadlineInSeconds?: number; followupInSeconds?: number },
): Promise<{ ticketId: string }> {
  const at = (s: number | undefined) =>
    s === undefined ? undefined : new Date(ctx.now.getTime() + s * 1000)
  await withPrivilegedDb(ctx.orgId, "seed-ticket:clock", (tx) =>
    shiftClockIn(tx, ctx.orgId, input.ticketId, {
      slaDeadline: at(input.slaDeadlineInSeconds),
      followupAt: at(input.followupInSeconds),
    }),
  )
  return { ticketId: input.ticketId }
}

/** A tickets API key created by `userId`, through the admin operation the settings page calls. */
export async function createTicketApiKey(
  ctx: SeedContext,
  input: {
    userId: string
    label: string
    inboxId?: string | null
    allowedOrigins?: string[]
    /** Revoke it right away (the settings page's revoke), for a test of a dead key. */
    revoked?: boolean
  },
): Promise<{ id: string; plaintext: string }> {
  const actor = { actorType: "user" as const, userId: input.userId }
  const created = (await withPrivilegedDb(ctx.orgId, "seed-ticket:api-key", async (tx) => {
    const made = (await runAdminOp(
      tx as never,
      ctx.orgId,
      "apiKeysCreate",
      {
        label: input.label,
        inboxId: input.inboxId ?? null,
        ...(input.allowedOrigins ? { allowedOrigins: input.allowedOrigins } : {}),
      },
      actor,
    )) as { id?: string; key?: string; error?: { message: string } }
    if (made.id && input.revoked) {
      const revoked = (await runAdminOp(
        tx as never,
        ctx.orgId,
        "apiKeysRevoke",
        { id: made.id },
        actor,
      )) as { error?: { message: string } }
      if (revoked.error) return { error: revoked.error }
    }
    return made
  })) as { id?: string; key?: string; error?: { message: string } }
  if (!created.id || !created.key) {
    throw new Error(`ticket seed: API key '${input.label}' refused: ${created.error?.message}`)
  }
  return { id: created.id, plaintext: created.key }
}

/**
 * Close these tickets through the state machine (the agent's and the UI's
 * close), as the admin. Already closed ones are left alone. For a test that
 * needs the tickets a person currently sees out of their feed: the caller
 * names them, never "every ticket of the org".
 */
export async function closeTickets(
  ctx: SeedContext,
  input: {
    adminUserId: string
    ticketIds: string[]
    closedReason: "resolved" | "spam" | "duplicate" | "no_response"
  },
): Promise<{ closed: number }> {
  const { orgId } = ctx
  const actor = { actorType: "system" as const, userId: input.adminUserId, orgId }
  return withPrivilegedDb(orgId, "seed-ticket:close", async (tx) => {
    let closed = 0
    for (const ticketId of input.ticketIds) {
      const [row] = rowsOf<{ status: string }>(
        await tx.execute(
          sql`SELECT status FROM ${ticketsRel("tickets")}
              WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid`,
        ),
      )
      if (!row) throw new Error(`ticket seed: no ticket ${ticketId} to close`)
      if (row.status === "closed") continue
      const applied = await validateAndApply(
        tx as never,
        ticketId,
        { kind: "close", closedReason: input.closedReason },
        actor,
        { privilegedTx: tx },
      )
      if (!applied.ok) {
        throw new Error(
          `ticket seed: closing ${ticketId} refused: ${applied.code} ${applied.message}`,
        )
      }
      closed++
    }
    return { closed }
  })
}
