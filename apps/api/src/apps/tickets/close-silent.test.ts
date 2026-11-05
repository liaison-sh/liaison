// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Close tickets when the customer stays silent" (per inbox, off by default).
// Every rule runs against a real database with a controlled clock: the run's
// `now` is passed in and every ticket timestamp is set relative to it.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import {
  CLOSE_SILENT_MAX_PER_RUN,
  CLOSE_SILENT_ROUTINE_NAME,
  findSilentSteps,
  runCloseSilentCheck,
  type SilentStepTool,
} from "~/apps/tickets/close-silent"
import { recordInboundOnTicket } from "~/apps/tickets/inbound-record"
import * as sendModule from "~/apps/tickets/send"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { autoApprovePolicies, users } from "~/db/schema/kernel"
import type { AppEvent } from "~/infra/events/event-bus"
import * as eventBusModule from "~/infra/events/event-bus"
import { decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { readApprovalRequesters } from "~/modules/approvals/requester"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { processTranslationEvent } from "~/modules/attention/translator"
import { seedContext } from "~/seed/context"
import { grantScopesThroughRole } from "~/seed/factories/people/scoped-role"
import {
  ensureTicketMailboxAccount,
  ensureTicketMailboxInbox,
} from "~/seed/factories/support/inboxes"
import { createOneTicket } from "~/seed/factories/support/ticket"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { realUserContext } from "~/tests/helpers/rls-boundary"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const DAY = 86_400_000
const NOW = new Date("2026-06-15T12:00:00.000Z")
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()

let orgId: string
let userId: string
let admin: UserContext
let inboxId: string
let seq = 0

async function makeInbox(): Promise<string> {
  const key = `cs-${Date.now()}-${++seq}`
  const inbox = await ensureTicketMailboxInbox(seedContext({ orgId, now: new Date() }), {
    key,
    name: "Support",
    emailAddress: `${key}@fabrikam.test`,
    fromDisplayName: "Fabrikam Support",
  })
  return inbox.id
}

/** Switch the option on as `userId`, stamped `enabledDaysAgo` before NOW. */
async function enable(
  id: string,
  opts: {
    enabledDaysAgo?: number
    nudgeDays?: number
    closeDays?: number
    text?: string
    by?: string
  } = {},
) {
  await sql`
    UPDATE app_tickets.inboxes
    SET close_silent_enabled = true,
        close_silent_enabled_at = ${ago(opts.enabledDaysAgo ?? 30)}::timestamptz,
        close_silent_enabled_by = ${opts.by ?? userId}::uuid,
        close_silent_nudge_days = ${opts.nudgeDays ?? 7},
        close_silent_close_days = ${opts.closeDays ?? 5},
        close_silent_nudge_text = ${opts.text ?? null}
    WHERE id = ${id}`
}

async function makeTicket(t: {
  inbox?: string
  status?: string
  lastOutboundDaysAgo: number | null
  lastInboundDaysAgo?: number | null
  nudgeDaysAgo?: number | null
  language?: string | null
}): Promise<string> {
  // A customer's ticket through the seed factory, then its clock set to the case.
  const ticket = await createOneTicket(seedContext({ orgId, now: new Date() }), {
    key: `cst-${Date.now()}-${++seq}`,
    adminUserId: userId,
    subject: "Where is my order?",
    sourceInboxId: t.inbox ?? inboxId,
  })
  await sql`
    UPDATE app_tickets.tickets
    SET status = ${t.status ?? "awaiting_customer"},
        last_outbound_at = ${t.lastOutboundDaysAgo === null ? null : ago(t.lastOutboundDaysAgo)}::timestamptz,
        last_inbound_at = ${t.lastInboundDaysAgo == null ? null : ago(t.lastInboundDaysAgo)}::timestamptz,
        nudge_sent_at = ${t.nudgeDaysAgo == null ? null : ago(t.nudgeDaysAgo)}::timestamptz,
        language = ${t.language ?? null},
        first_response_at = ${ago(40)}::timestamptz
    WHERE id = ${ticket.id}`
  return ticket.id
}

const stepsFor = async (ticketId: string, now = NOW) =>
  (await findSilentSteps(orgId, now)).filter((s) => s.ticketId === ticketId)

async function approvalsFor(ticketId: string) {
  return sql<Array<{ id: string; tool_name: string; status: string; requested_by: string }>>`
    SELECT id::text, tool_name, status, requested_by::text FROM kernel.approval_requests
    WHERE org_id = ${orgId} AND tool_params->>'ticketId' = ${ticketId}
    ORDER BY created_at`
}

async function approvalRow(id: string) {
  const [row] = await sql<Array<{ status: string; reason: string | null }>>`
    SELECT status, reason FROM kernel.approval_requests WHERE id = ${id}`
  return row!
}

/** Approve a staged card as the org's admin, the way the approval card does. */
async function approve(id: string) {
  const [row] = await sql<Array<{ tool_name: string; current_payload: unknown }>>`
    SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${id}`
  return decideApproval({
    orgId,
    requestId: id,
    actor: admin,
    decision: "approve",
    payloadHash: approvalPayloadHash(row!.tool_name, row!.current_payload),
  })
}

/** The refusal the handler recorded for an approval it would not execute. */
async function executionError(approvalId: string): Promise<string | null> {
  const [row] = await sql<Array<{ code: string | null }>>`
    SELECT error->>'code' AS code FROM kernel.approved_handler_executions
    WHERE approval_request_id = ${approvalId}`
  return row?.code ?? null
}

async function ticketRow(id: string) {
  const [row] = await sql<
    Array<{ status: string; nudge_sent_at: Date | null; outbound: number }>
  >`SELECT status, nudge_sent_at,
           (SELECT count(*)::int FROM app_tickets.messages m
            WHERE m.ticket_id = t.id AND m.kind = 'outbound') AS outbound
    FROM app_tickets.tickets t WHERE id = ${id}`
  return row!
}

/** An inbox whose mailbox can send: its connected account, active. */
async function makeSendingInbox(): Promise<string> {
  const key = `cs-send-${Date.now()}-${++seq}`
  const ctx = seedContext({ orgId, now: new Date() })
  const accountId = await ensureTicketMailboxAccount(ctx, {
    key,
    emailAddress: `${key}@fabrikam.test`,
    createdBy: userId,
  })
  return (
    await ensureTicketMailboxInbox(ctx, {
      key,
      name: "Support",
      emailAddress: `${key}@fabrikam.test`,
      connectedAccountId: accountId,
    })
  ).id
}

/** The mail transport, stubbed: these tests are about what is sent, not how. */
function stubSend() {
  return spyOn(sendModule, "sendOutbound").mockImplementation(async () => ({
    externalMessageId: `<close-silent-${++seq}@test>`,
    deliveryState: "delivered" as const,
    rfc2822: "",
  }))
}

/** Another person of the org, holding exactly `scopes` (through a role of their own). */
async function makePerson(scopes: readonly string[]): Promise<{ id: string; actor: UserContext }> {
  const id = await withSystemDb("close-silent-person", async (db) => {
    const [row] = await db
      .insert(users)
      .values({
        orgId,
        email: `cs-person-${crypto.randomUUID()}@fabrikam.test`,
        name: "Support Lead",
        status: "active",
      })
      .returning({ id: users.id })
    return row!.id
  })
  await grantScopesThroughRole(orgId, {
    adminUserId: userId,
    userId: id,
    name: `close-silent-${crypto.randomUUID()}`,
    scopes,
    dimensions: {},
  })
  return { id, actor: await realUserContext(id, orgId) }
}

/** Every scope a support admin needs, except replying to and closing tickets. */
const NO_REPLY_CLOSE_SCOPES = [
  "tickets:inboxes:admin",
  "tickets:tickets:read",
  "tickets:tickets:write",
  "tickets:settings:admin",
]

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  admin = a.actor
  await ensureAppsForOrg(orgId)
})

afterAll(async () => {
  broadcastSpy.mockRestore()
  await shutdownSandboxPool()
  await releaseTestLock()
})

beforeEach(async () => {
  // Each test gets its own inbox, so earlier tickets never count against the cap.
  await sql`UPDATE app_tickets.inboxes SET close_silent_enabled = false WHERE org_id = ${orgId}`
  inboxId = await makeInbox()
})

describe("close silent tickets: selection", () => {
  it("is off by default: a long-silent ticket in an inbox that never switched it on is left alone", async () => {
    const [row] = await sql<Array<{ on: boolean }>>`
      SELECT close_silent_enabled AS on FROM app_tickets.inboxes WHERE id = ${inboxId}`
    expect(row!.on).toBe(false)
    const t = await makeTicket({ lastOutboundDaysAgo: 20 })
    expect(await stepsFor(t)).toEqual([])
  })

  it("nudges a ticket awaiting the customer N days after our last message, not before", async () => {
    await enable(inboxId)
    const due = await makeTicket({ lastOutboundDaysAgo: 7, lastInboundDaysAgo: 9 })
    const early = await makeTicket({ lastOutboundDaysAgo: 6 })
    const [step] = await stepsFor(due)
    expect(step?.step).toBe("nudge")
    expect(step?.actingUserId).toBe(userId)
    expect(step?.textBody).toContain("within 5 days")
    expect(await stepsFor(early)).toEqual([])
  })

  it("never touches open or awaiting-follow-up tickets, nor one the customer answered last", async () => {
    await enable(inboxId)
    const open = await makeTicket({ status: "open", lastOutboundDaysAgo: 20 })
    const followup = await makeTicket({ status: "awaiting_followup", lastOutboundDaysAgo: 20 })
    const answered = await makeTicket({ lastOutboundDaysAgo: 20, lastInboundDaysAgo: 10 })
    expect(await stepsFor(open)).toEqual([])
    expect(await stepsFor(followup)).toEqual([])
    expect(await stepsFor(answered)).toEqual([])
  })

  it("does not burst on the backlog: only silences that began after it was switched on count", async () => {
    await enable(inboxId, { enabledDaysAgo: 3 })
    const backlog = await makeTicket({ lastOutboundDaysAgo: 30 })
    expect(await stepsFor(backlog)).toEqual([])
    // A message we send after enabling starts a silence that does count.
    const fresh = await makeTicket({ lastOutboundDaysAgo: 2 })
    expect(await stepsFor(fresh, new Date(NOW.getTime() + 5 * DAY))).toHaveLength(1)
  })

  it(`proposes at most ${CLOSE_SILENT_MAX_PER_RUN} steps per run, oldest silence first`, async () => {
    await enable(inboxId)
    const ids: string[] = []
    for (let i = 0; i < CLOSE_SILENT_MAX_PER_RUN + 5; i++) {
      ids.push(await makeTicket({ lastOutboundDaysAgo: 8 + i / 100 }))
    }
    const steps = await findSilentSteps(orgId, NOW)
    expect(steps).toHaveLength(CLOSE_SILENT_MAX_PER_RUN)
    // The 5 most recent silences (the first created) wait for the next run.
    expect(steps.map((s) => s.ticketId)).not.toContain(ids[0])
    expect(steps.map((s) => s.ticketId)).toContain(ids[ids.length - 1])
  })

  it("closes M days after the nudge, not before, and not when the customer replied since", async () => {
    await enable(inboxId)
    const due = await makeTicket({ lastOutboundDaysAgo: 5, nudgeDaysAgo: 5 })
    const early = await makeTicket({ lastOutboundDaysAgo: 4, nudgeDaysAgo: 4 })
    // Nudged, then the customer answered: the answer clears the nudge mark.
    const replied = await makeTicket({ lastOutboundDaysAgo: 8, nudgeDaysAgo: 8 })
    await withPrivilegedDb(orgId, "close-silent-reply", (tx) =>
      recordInboundOnTicket(tx, {
        orgId,
        ticketId: replied,
        sentAt: new Date().toISOString(),
        actor: { actorType: "system", userId: "system", orgId },
      }),
    )
    expect((await ticketRow(replied)).nudge_sent_at).toBeNull()
    expect((await stepsFor(due))[0]?.step).toBe("close")
    expect(await stepsFor(early)).toEqual([])
    expect(await stepsFor(replied, new Date(Date.now() + 30 * DAY))).toEqual([])
  })

  it("a customer reply starts a new cycle: nudge again after the next silence, then close", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8, nudgeDaysAgo: 8 })
    await withPrivilegedDb(orgId, "close-silent-reply", (tx) =>
      recordInboundOnTicket(tx, {
        orgId,
        ticketId: t,
        sentAt: new Date().toISOString(),
        actor: { actorType: "system", userId: "system", orgId },
      }),
    )
    // We answer and the customer goes quiet again.
    const answered = new Date(Date.now() + 60_000)
    await sql`UPDATE app_tickets.tickets SET status = 'awaiting_customer',
              last_outbound_at = ${answered.toISOString()}::timestamptz WHERE id = ${t}`
    const at = (days: number) => new Date(answered.getTime() + days * DAY)
    expect(await stepsFor(t, at(6))).toEqual([])
    expect((await stepsFor(t, at(7)))[0]?.step).toBe("nudge")
    // The second nudge goes out; the close follows its own delay.
    await sql`UPDATE app_tickets.tickets SET nudge_sent_at = ${at(7).toISOString()}::timestamptz,
              last_outbound_at = ${at(7).toISOString()}::timestamptz WHERE id = ${t}`
    expect(await stepsFor(t, at(11))).toEqual([])
    expect((await stepsFor(t, at(12)))[0]?.step).toBe("close")
  })

  it("uses the inbox's own wording, else the default in the ticket's language", async () => {
    await enable(inboxId)
    const fr = await makeTicket({ lastOutboundDaysAgo: 8, language: "fr" })
    expect((await stepsFor(fr))[0]?.textBody).toContain("Sans réponse de votre part d'ici 5 jours")
    const other = await makeInbox()
    await enable(other, { text: "Any news? We will close this soon." })
    const custom = await makeTicket({ inbox: other, lastOutboundDaysAgo: 8 })
    expect((await stepsFor(custom))[0]?.textBody).toBe("Any news? We will close this soon.")
  })
})

describe("close silent tickets: the run goes through the gated tools", () => {
  it("stages one pending nudge approval per ticket as the person who switched it on, once", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    const report = await runCloseSilentCheck(orgId, { now: NOW })
    expect(report.staged).toBe(1)
    const rows = await approvalsFor(t)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tool_name: "tickets:nudge",
      status: "pending",
      requested_by: userId,
    })
    // The next run does not stage a second card for the same ticket.
    await runCloseSilentCheck(orgId, { now: new Date(NOW.getTime() + 3_600_000) })
    expect(await approvalsFor(t)).toHaveLength(1)
  })

  it("does not propose a rejected nudge again until something new is said", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    await runCloseSilentCheck(orgId, { now: NOW })
    await sql`UPDATE kernel.approval_requests SET status = 'rejected', decided_at = now()
              WHERE org_id = ${orgId} AND tool_params->>'ticketId' = ${t}`
    expect(await stepsFor(t)).toEqual([])
    expect(await stepsFor(t, new Date(Date.now() + 30 * DAY))).toEqual([])
    // We write again: a new silence, and the nudge is proposed once it is due.
    const wrote = new Date(Date.now() + 60_000)
    await sql`UPDATE app_tickets.tickets SET last_outbound_at = ${wrote.toISOString()}::timestamptz
              WHERE id = ${t}`
    expect(await stepsFor(t, new Date(wrote.getTime() + 6 * DAY))).toEqual([])
    expect((await stepsFor(t, new Date(wrote.getTime() + 7 * DAY)))[0]?.step).toBe("nudge")
  })

  it("follows the org's approval policy: a policy for tickets:close lets the close run", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 6, nudgeDaysAgo: 6 })
    await withSystemDb("close-silent-policy", (db) =>
      db
        .insert(autoApprovePolicies)
        .values({ orgId, toolName: "tickets:close", createdBy: userId }),
    )
    try {
      const report = await runCloseSilentCheck(orgId, { now: NOW })
      expect(report.ran).toBe(1)
      const [row] = await sql<Array<{ status: string; closed_reason: string }>>`
        SELECT status, closed_reason FROM app_tickets.tickets WHERE id = ${t}`
      expect(row).toEqual({ status: "closed", closed_reason: "no_response" })
    } finally {
      await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${orgId} AND tool_name = 'tickets:close'`
    }
  })

  it("a customer reply between the nudge and the close cancels the pending close", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 6, nudgeDaysAgo: 6 })
    await runCloseSilentCheck(orgId, { now: NOW })
    const [staged] = await approvalsFor(t)
    expect(staged).toMatchObject({ tool_name: "tickets:close", status: "pending" })
    await withPrivilegedDb(orgId, "close-silent-reply", (tx) =>
      recordInboundOnTicket(tx, {
        orgId,
        ticketId: t,
        sentAt: new Date().toISOString(),
        actor: { actorType: "system", userId: "system", orgId },
      }),
    )
    const [after] = await approvalsFor(t)
    expect(after?.status).toBe("cancelled")
    const [ticket] = await sql<Array<{ status: string }>>`
      SELECT status FROM app_tickets.tickets WHERE id = ${t}`
    expect(ticket!.status).toBe("open")
    expect(await stepsFor(t, new Date(Date.now() + 30 * DAY))).toEqual([])
  })

  it("names the routine, not the person, as the approval card's requester", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    await runCloseSilentCheck(orgId, { now: NOW })
    const [row] = await approvalsFor(t)
    const requesters = await withSystemDb("close-silent-requester", (db) =>
      readApprovalRequesters(db, orgId, [row!.id]),
    )
    expect(requesters.get(row!.id)).toMatchObject({
      kind: "agent",
      name: `Routine ${CLOSE_SILENT_ROUTINE_NAME}`,
    })
    // The routine is the person's own, so RLS and permissions stay theirs.
    const [routine] = await sql<Array<{ owner: string; enabled: boolean; name: string }>>`
      SELECT owner_user_id::text AS owner, enabled, name FROM kernel.routines
      WHERE org_id = ${orgId} AND id = (
        SELECT (metadata->>'originRoutineId')::uuid FROM kernel.approval_requests WHERE id = ${row!.id})`
    expect(routine).toEqual({ owner: userId, enabled: false, name: CLOSE_SILENT_ROUTINE_NAME })
  })

  it("sends the nudge as the routine: the message is labelled with the routine, not the person", async () => {
    inboxId = await makeSendingInbox()
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    await withSystemDb("close-silent-policy", (db) =>
      db
        .insert(autoApprovePolicies)
        .values({ orgId, toolName: "tickets:nudge", createdBy: userId }),
    )
    // The send itself is the mail transport's; this test is about who it is attributed to.
    const sendSpy = stubSend()
    try {
      const report = await runCloseSilentCheck(orgId, { now: NOW })
      expect(report.ran).toBe(1)
    } finally {
      sendSpy.mockRestore()
      await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${orgId} AND tool_name = 'tickets:nudge'`
    }
    const [msg] = await sql<Array<{ author_label: string | null }>>`
      SELECT author_label FROM app_tickets.messages
      WHERE org_id = ${orgId} AND ticket_id = ${t} AND kind = 'outbound'`
    expect(msg?.author_label).toBe(`Routine: ${CLOSE_SILENT_ROUTINE_NAME}`)
  })

  it("closes as the routine: the close is audited as a system action, never as the person's", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 6, nudgeDaysAgo: 6 })
    await withSystemDb("close-silent-policy", (db) =>
      db
        .insert(autoApprovePolicies)
        .values({ orgId, toolName: "tickets:close", createdBy: userId }),
    )
    try {
      expect((await runCloseSilentCheck(orgId, { now: NOW })).ran).toBe(1)
    } finally {
      await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${orgId} AND tool_name = 'tickets:close'`
    }
    // The events the close queued are what the audit log records (the outbox
    // worker writes them): none of them is the person's own action.
    const events = await sql<
      Array<{ actorId: string | null; actorType: string; routineId: string | null }>
    >`
      SELECT payload->>'actorId' AS "actorId", payload->>'actorType' AS "actorType",
             payload->'metadata'->>'routineId' AS "routineId"
      FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'app' = 'tickets' AND payload->>'entity' = 'ticket'
        AND payload->>'action' <> 'create' AND payload->>'entityId' = ${t}`
    expect(events.length).toBeGreaterThan(0)
    expect(events.filter((e) => e.actorType === "user" && e.actorId === userId)).toEqual([])
    expect(events.map((e) => e.actorType)).toEqual(events.map(() => "system"))
    // ...each naming the routine it ran for.
    const [routine] = await sql<Array<{ id: string }>>`
      SELECT id::text FROM kernel.routines
      WHERE org_id = ${orgId} AND owner_user_id = ${userId} AND name = ${CLOSE_SILENT_ROUTINE_NAME}`
    expect(events.map((e) => e.routineId)).toEqual(events.map(() => routine!.id))
  })

  it("switches the option off and tells the inbox admins when the person who switched it on is inactive", async () => {
    await enable(inboxId)
    await makeTicket({ lastOutboundDaysAgo: 8 })
    await runCloseSilentCheck(orgId, { now: NOW, loadActor: async () => null })
    const [inbox] = await sql<Array<{ on: boolean; by: string | null }>>`
      SELECT close_silent_enabled AS on, close_silent_enabled_by::text AS by
      FROM app_tickets.inboxes WHERE id = ${inboxId}`
    expect(inbox).toEqual({ on: false, by: null })
    const [notice] = await sql<Array<{ payload: { data: Record<string, unknown> } }>>`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'inbox'
        AND payload->>'action' = 'close_silent_stopped' AND payload->>'entityId' = ${inboxId}`
    expect(notice?.payload.data).toMatchObject({ id: inboxId, reason: "owner_inactive" })
    // The inbox admins (holders of tickets:inboxes:admin) get an attention item.
    await processTranslationEvent(notice!.payload as unknown as AppEvent)
    const [item] = await sql<Array<{ kind: string; summary: string }>>`
      SELECT kind, summary FROM kernel.attention_events
      WHERE org_id = ${orgId} AND user_id = ${userId} AND entity_id = ${inboxId}`
    expect(item?.kind).toBe("admin_action")
    expect(item?.summary).toContain("Closing silent tickets stopped")
  })

  it("stops when the person who switched it on is deactivated (their permissions reloaded for real)", async () => {
    const lead = await makePerson(["tickets:*"])
    await enable(inboxId, { by: lead.id })
    await makeTicket({ lastOutboundDaysAgo: 8 })
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${lead.id}`
    const calls: string[] = []
    const runTool: SilentStepTool = async (c) => {
      calls.push(c.toolName)
      return {}
    }
    const report = await runCloseSilentCheck(orgId, { now: NOW, runTool })
    expect(report.skipped).toBeGreaterThan(0)
    expect(calls).toEqual([])
    const [inbox] = await sql<Array<{ on: boolean }>>`
      SELECT close_silent_enabled AS on FROM app_tickets.inboxes WHERE id = ${inboxId}`
    expect(inbox!.on).toBe(false)
  })

  it("stops, like for a person who left, when the person no longer may reply to or close tickets", async () => {
    const lead = await makePerson(NO_REPLY_CLOSE_SCOPES)
    // Switched on while they could; their role lost the reply and close permissions since.
    await enable(inboxId, { by: lead.id })
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    const report = await runCloseSilentCheck(orgId, { now: NOW })
    expect(report).toMatchObject({ staged: 0, ran: 0, failed: 0 })
    expect(report.skipped).toBeGreaterThan(0)
    expect(await approvalsFor(t)).toHaveLength(0)
    const [inbox] = await sql<Array<{ on: boolean; by: string | null }>>`
      SELECT close_silent_enabled AS on, close_silent_enabled_by::text AS by
      FROM app_tickets.inboxes WHERE id = ${inboxId}`
    expect(inbox).toEqual({ on: false, by: null })
    const [notice] = await sql<Array<{ payload: { data: Record<string, unknown> } }>>`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId} AND payload->>'entity' = 'inbox'
        AND payload->>'action' = 'close_silent_stopped' AND payload->>'entityId' = ${inboxId}`
    expect(notice?.payload.data).toMatchObject({ id: inboxId, reason: "owner_forbidden" })
    await processTranslationEvent(notice!.payload as unknown as AppEvent)
    const [item] = await sql<Array<{ summary: string }>>`
      SELECT summary FROM kernel.attention_events
      WHERE org_id = ${orgId} AND user_id = ${userId} AND entity_id = ${inboxId}`
    expect(item?.summary).toContain("Closing silent tickets stopped")
    expect(item?.summary).not.toMatch(/routine/i)
  })

  it("calls the tools as a non-human system-origin caller", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    const seen: Array<Parameters<SilentStepTool>[0]> = []
    await runCloseSilentCheck(orgId, {
      now: NOW,
      runTool: async (c) => {
        seen.push(c)
        return { blocked: {} }
      },
      loadActor: async () => admin,
    })
    const call = seen.find((c) => c.params.ticketId === t)
    expect(call?.toolName).toBe("tickets:nudge")
    expect(call?.origin).toBe("system")
  })
})

describe("close silent tickets: a broken silence", () => {
  it("our reply while a close card waits cancels it: approving it then closes nothing", async () => {
    inboxId = await makeSendingInbox()
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 6, nudgeDaysAgo: 6 })
    await runCloseSilentCheck(orgId, { now: NOW })
    const [card] = await approvalsFor(t)
    expect(card).toMatchObject({ tool_name: "tickets:close", status: "pending" })
    const sendSpy = stubSend()
    try {
      await executeTool({
        toolName: "tickets:reply",
        orgId,
        actor: admin,
        params: { ticketId: t, textBody: "Here is the tracking number." },
        origin: "human-ui",
      })
    } finally {
      sendSpy.mockRestore()
    }
    expect((await approvalRow(card!.id)).status).toBe("cancelled")
    await expect(approve(card!.id)).rejects.toThrow()
    expect((await ticketRow(t)).status).not.toBe("closed")
  })

  it("a late approval refuses to close once something was said since the card, and marks it no longer applicable", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 6, nudgeDaysAgo: 6 })
    await runCloseSilentCheck(orgId, { now: NOW })
    const [card] = await approvalsFor(t)
    expect(card).toMatchObject({ tool_name: "tickets:close", status: "pending" })
    // A message went out after the card was raised, by a path that did not cancel it.
    await sql`UPDATE app_tickets.tickets SET last_outbound_at = now() + interval '1 minute' WHERE id = ${t}`
    await expect(approve(card!.id)).rejects.toThrow()
    expect((await ticketRow(t)).status).toBe("awaiting_customer")
    expect(await executionError(card!.id)).toBe("no_longer_applicable")
    expect(await approvalRow(card!.id)).toEqual({
      status: "cancelled",
      reason: "no_longer_applicable",
    })
  })

  it("a late nudge approval after our fresh message is refused: nothing is sent", async () => {
    inboxId = await makeSendingInbox()
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    await runCloseSilentCheck(orgId, { now: NOW })
    const [card] = await approvalsFor(t)
    expect(card).toMatchObject({ tool_name: "tickets:nudge", status: "pending" })
    await sql`UPDATE app_tickets.tickets SET last_outbound_at = now() + interval '1 minute' WHERE id = ${t}`
    const before = (await ticketRow(t)).outbound
    const sendSpy = stubSend()
    try {
      await expect(approve(card!.id)).rejects.toThrow()
      expect(sendSpy).not.toHaveBeenCalled()
    } finally {
      sendSpy.mockRestore()
    }
    const after = await ticketRow(t)
    expect(after.nudge_sent_at).toBeNull()
    expect(after.outbound).toBe(before)
    expect(await executionError(card!.id)).toBe("no_longer_applicable")
    expect((await approvalRow(card!.id)).status).toBe("cancelled")
  })

  it("setting the ticket back to open cancels the routine's waiting card", async () => {
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    await runCloseSilentCheck(orgId, { now: NOW })
    const [card] = await approvalsFor(t)
    expect(card).toMatchObject({ tool_name: "tickets:nudge", status: "pending" })
    await executeTool({
      toolName: "tickets:setStatus",
      orgId,
      actor: admin,
      params: { ticketId: t, status: "open" },
      origin: "human-ui",
    })
    expect((await ticketRow(t)).status).toBe("open")
    expect(await approvalRow(card!.id)).toEqual({ status: "cancelled", reason: "status_changed" })
  })

  it("an approved nudge is not cancelled by its own message", async () => {
    inboxId = await makeSendingInbox()
    await enable(inboxId)
    const t = await makeTicket({ lastOutboundDaysAgo: 8 })
    await runCloseSilentCheck(orgId, { now: NOW })
    const [card] = await approvalsFor(t)
    const sendSpy = stubSend()
    try {
      await approve(card!.id)
    } finally {
      sendSpy.mockRestore()
    }
    expect((await approvalRow(card!.id)).status).toBe("approved")
    expect((await ticketRow(t)).nudge_sent_at).not.toBeNull()
  })
})

describe("close silent tickets: the inbox setting", () => {
  const update = (params: Record<string, unknown>, actor: UserContext = admin) =>
    executeTool({
      toolName: "tickets:inboxes.update",
      orgId,
      actor,
      params: { id: inboxId, ...params },
      origin: "human-ui",
    })
  const read = async () =>
    (
      await sql<
        Array<{
          on: boolean
          at: Date | string | null
          by: string | null
          nudge: number
          close: number
          text: string | null
        }>
      >`SELECT close_silent_enabled AS on, close_silent_enabled_at AS at,
               close_silent_enabled_by::text AS by, close_silent_nudge_days AS nudge,
               close_silent_close_days AS close, close_silent_nudge_text AS text
        FROM app_tickets.inboxes WHERE id = ${inboxId}`
    )[0]!

  it("defaults to off with 7 and 5 days, stamps who and when on switch-on, keeps the stamp on re-save, clears it off", async () => {
    expect(await read()).toMatchObject({ on: false, at: null, by: null, nudge: 7, close: 5 })
    await update({ closeSilentEnabled: true, closeSilentNudgeDays: 10, closeSilentNudgeText: "  " })
    const on = await read()
    expect(on).toMatchObject({ on: true, by: userId, nudge: 10, close: 5, text: null })
    expect(on.at).not.toBeNull()
    await sql`UPDATE app_tickets.inboxes SET close_silent_enabled_at = ${ago(10)}::timestamptz WHERE id = ${inboxId}`
    await update({ closeSilentEnabled: true, closeSilentCloseDays: 3 })
    const again = await read()
    expect(new Date(again.at as Date | string).toISOString()).toBe(ago(10))
    expect(again.close).toBe(3)
    await update({ closeSilentEnabled: false })
    expect(await read()).toMatchObject({ on: false, at: null, by: null })
  })

  it("refuses to switch it on for someone not allowed to reply to and close tickets", async () => {
    const lead = await makePerson(NO_REPLY_CLOSE_SCOPES)
    const err = await update({ closeSilentEnabled: true }, lead.actor).then(
      () => null,
      (e: Error) => e,
    )
    expect(err?.message).toMatch(/allowed to reply to and close tickets/)
    expect(err?.message).not.toMatch(/routine/i)
    expect((await read()).on).toBe(false)
  })

  it("refuses a delay outside 1 to 90 days", async () => {
    await expect(update({ closeSilentNudgeDays: 0 })).rejects.toThrow(/closeSilentNudgeDays/)
    await expect(update({ closeSilentCloseDays: 91 })).rejects.toThrow()
  })
})
