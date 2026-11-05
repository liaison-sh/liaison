// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { cancelSilentCloseCards } from "~/apps/tickets/close-silent"
import { displayHandleFor, loadSegmentConfig } from "~/apps/tickets/display-handle"
import { onPrivilegedDb, type PrivilegedReadOptions } from "~/apps/tickets/privileged-read"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { businessHoursBetween, walkForwardBusinessHours } from "~/apps/tickets/sla"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { UUID_RE } from "~/lib/uuid"
import { currentRunContext } from "~/modules/agent/runtime/run-context"

export type TicketStatus = "open" | "awaiting_customer" | "awaiting_followup" | "closed"
export type ClosedReason =
  | "resolved"
  | "converted_to_mail"
  | "merged"
  | "spam"
  | "duplicate"
  | "no_response"

export type TransitionInput =
  | { kind: "setStatus"; intended: TicketStatus }
  | { kind: "setFollowup"; at: string; reason: string; trigger?: string }
  | { kind: "clearFollowup" }
  | { kind: "reopen" }
  | { kind: "merge"; target: boolean }
  | { kind: "followupCron" }
  | { kind: "inbound" }
  | { kind: "nudge" }
  | { kind: "close"; closedReason: ClosedReason }
  | { kind: "reply" }
  | { kind: "convertToMail"; mailConversationId: string }

export type SlaAction = "init" | "pause" | "resume" | "satisfy" | "recompute" | "none"

export type TransitionEffects = {
  status: TicketStatus
  priority?: string
  closedReason?: ClosedReason | null
  mergedIntoTicketId?: string | null
  convertedToMailConversationId?: string | null
  followupAt?: string | null
  followupReason?: string | null
  followupTrigger?: string | null
  slaAction: SlaAction
  emit: ("status" | "reopened" | "merged" | "converted")[]
  timelineActionLabel?: string
  timelineDetails?: Record<string, unknown>
}

export type ValidationResult =
  | { ok: true; effects: TransitionEffects }
  | { ok: false; code: string; message: string }

export interface CurrentTicketState {
  status: TicketStatus
  closedReason: ClosedReason | null
  mergedIntoTicketId: string | null
  convertedToMailConversationId: string | null
  firstResponseAt: string | null
}

export function validateTransition(
  current: CurrentTicketState,
  input: TransitionInput,
): ValidationResult {
  const isClosed = current.status === "closed"
  const slaActive = current.firstResponseAt === null

  switch (input.kind) {
    case "setStatus": {
      if (input.intended === "closed") {
        return {
          ok: false,
          code: "invalid_transition",
          message: `cannot transition ${current.status} → ${input.intended}`,
        }
      }
      if (isClosed) {
        const terminal =
          current.closedReason === "merged" || current.closedReason === "converted_to_mail"
        if (
          input.intended === "open" &&
          !terminal &&
          !current.mergedIntoTicketId &&
          !current.convertedToMailConversationId
        ) {
          return {
            ok: true,
            effects: {
              status: "open",
              closedReason: null,
              followupAt: null,
              followupReason: null,
              followupTrigger: null,
              slaAction: slaActive ? "resume" : "none",
              emit: ["reopened"],
              timelineActionLabel: "manual_reopen",
            },
          }
        }
        return {
          ok: false,
          code: "invalid_transition",
          message: `cannot transition ${current.status} → ${input.intended}`,
        }
      }
      const slaAction: SlaAction = !slaActive
        ? "none"
        : current.status === "open" && input.intended !== "open"
          ? "pause"
          : current.status !== "open" && input.intended === "open"
            ? "resume"
            : "none"
      return { ok: true, effects: { status: input.intended, slaAction, emit: ["status"] } }
    }
    case "setFollowup": {
      if (new Date(input.at).getTime() <= Date.now()) {
        return {
          ok: false,
          code: "followup_in_past",
          message: "followup_at must be in the future",
        }
      }
      const slaAction: SlaAction = slaActive && current.status === "open" ? "pause" : "none"
      return {
        ok: true,
        effects: {
          status: "awaiting_followup",
          followupAt: input.at,
          followupReason: input.reason,
          followupTrigger: input.trigger ?? null,
          slaAction,
          emit: ["status"],
        },
      }
    }
    case "clearFollowup": {
      if (current.status !== "awaiting_followup") {
        return {
          ok: false,
          code: "not_in_awaiting_followup",
          message: "ticket is not awaiting_followup",
        }
      }
      return {
        ok: true,
        effects: {
          status: "open",
          followupAt: null,
          followupReason: null,
          followupTrigger: null,
          slaAction: slaActive ? "resume" : "none",
          emit: ["status"],
        },
      }
    }
    case "reopen": {
      if (!isClosed) {
        return { ok: false, code: "invalid_transition", message: "ticket is not closed" }
      }
      if (current.convertedToMailConversationId) {
        return { ok: false, code: "converted_ticket", message: "ticket was converted to mail" }
      }
      if (current.mergedIntoTicketId) {
        return { ok: false, code: "merged_ticket", message: "ticket was merged" }
      }
      return {
        ok: true,
        effects: {
          status: "open",
          closedReason: null,
          followupAt: null,
          followupReason: null,
          followupTrigger: null,
          slaAction: slaActive ? "resume" : "none",
          emit: ["reopened"],
          timelineActionLabel: "manual_reopen",
        },
      }
    }
    case "merge": {
      if (input.target) {
        if (current.mergedIntoTicketId) {
          return {
            ok: false,
            code: "merge_target_invalid",
            message: "target is itself merged",
          }
        }
        if (current.closedReason === "converted_to_mail") {
          return {
            ok: false,
            code: "merge_target_invalid",
            message: "target is converted",
          }
        }
        return {
          ok: true,
          effects: {
            status: current.status,
            slaAction: "none",
            emit: [],
            timelineActionLabel: "merged_in",
          },
        }
      }
      if (current.mergedIntoTicketId) {
        return {
          ok: false,
          code: "ticket_already_merged",
          message: "source already merged",
        }
      }
      if (current.closedReason === "converted_to_mail") {
        return { ok: false, code: "converted_ticket", message: "source was converted" }
      }
      return {
        ok: true,
        effects: {
          status: "closed",
          closedReason: "merged",
          slaAction: slaActive ? "satisfy" : "none",
          emit: ["merged"],
          timelineActionLabel: "merged_into",
        },
      }
    }
    case "followupCron": {
      if (current.status !== "awaiting_followup") {
        return { ok: false, code: "invalid_transition", message: "not awaiting_followup" }
      }
      return {
        ok: true,
        effects: {
          status: "open",
          followupAt: null,
          followupReason: null,
          followupTrigger: null,
          slaAction: slaActive ? "resume" : "none",
          emit: ["reopened"],
          timelineActionLabel: "followup_due",
        },
      }
    }
    case "inbound": {
      if (current.mergedIntoTicketId) {
        return { ok: false, code: "merged_ticket", message: "ticket was merged" }
      }
      if (current.convertedToMailConversationId) {
        return { ok: false, code: "converted_ticket", message: "ticket was converted to mail" }
      }
      if (
        isClosed &&
        (current.closedReason === "merged" || current.closedReason === "converted_to_mail")
      ) {
        return { ok: false, code: "invalid_transition", message: "terminal closed reason" }
      }
      const wasFollowup = current.status === "awaiting_followup"
      const shouldReopen = wasFollowup || isClosed
      return {
        ok: true,
        effects: {
          status: "open",
          closedReason: isClosed ? null : undefined,
          followupAt: shouldReopen ? null : undefined,
          followupReason: shouldReopen ? null : undefined,
          followupTrigger: shouldReopen ? null : undefined,
          slaAction: slaActive && current.status !== "open" ? "resume" : "none",
          emit: shouldReopen ? ["status", "reopened"] : ["status"],
          timelineActionLabel: isClosed ? "auto_reopen" : undefined,
        },
      }
    }
    case "nudge": {
      return {
        ok: true,
        effects: {
          status: current.status,
          slaAction: "none",
          emit: [],
        },
      }
    }
    case "close": {
      if (isClosed) {
        return { ok: false, code: "invalid_transition", message: "ticket is already closed" }
      }
      return {
        ok: true,
        effects: {
          status: "closed",
          closedReason: input.closedReason,
          slaAction: slaActive ? "satisfy" : "none",
          emit: ["status"],
        },
      }
    }
    case "reply": {
      // An agent reply on an open ticket hands the ball to the customer -- same
      // resting state the in-app reply tool sets. Other statuses are preserved:
      // awaiting_followup keeps its scheduled follow-up, awaiting_customer is
      // already correct, and closed is unreachable (guarded above by callers'
      // fetch; a reply synced onto a closed ticket must not silently reopen it).
      return {
        ok: true,
        effects: {
          status: current.status === "open" ? "awaiting_customer" : current.status,
          slaAction: current.firstResponseAt === null ? "satisfy" : "none",
          emit: ["status"],
        },
      }
    }
    case "convertToMail": {
      if (current.mergedIntoTicketId) {
        return { ok: false, code: "merged_ticket", message: "ticket was merged" }
      }
      const alreadyConverted =
        current.closedReason === "converted_to_mail" &&
        current.convertedToMailConversationId === input.mailConversationId
      if (alreadyConverted) {
        return {
          ok: true,
          effects: {
            status: "closed",
            closedReason: "converted_to_mail",
            convertedToMailConversationId: input.mailConversationId,
            slaAction: "none",
            emit: [],
          },
        }
      }
      if (isClosed && current.closedReason === "converted_to_mail") {
        return {
          ok: false,
          code: "converted_ticket",
          message: "ticket already converted to a different mail conversation",
        }
      }
      if (isClosed) {
        return { ok: false, code: "invalid_transition", message: "ticket is already closed" }
      }
      return {
        ok: true,
        effects: {
          status: "closed",
          closedReason: "converted_to_mail",
          convertedToMailConversationId: input.mailConversationId,
          slaAction: slaActive ? "pause" : "none",
          emit: ["status", "converted"],
          timelineActionLabel: "converted_to_mail",
        },
      }
    }
    default:
      return {
        ok: false,
        code: "invalid_transition",
        message: `unsupported transition: ${(input as { kind: string }).kind}`,
      }
  }
}

type SqlClient = RlsClient | RlsTx | PrivilegedDb

interface TicketRow {
  id: string
  handle: string
  status: string
  priority: string
  closed_reason: string | null
  merged_into_ticket_id: string | null
  converted_to_mail_conversation_id: string | null
  first_response_at: string | Date | null
  sla_target_seconds: number
  sla_deadline: string | Date | null
  sla_active_started_at: string | Date | null
  sla_paused_at: string | Date | null
  sla_elapsed_seconds: number | null
  sla_breached_at: string | Date | null
  followup_at: string | Date | null
  last_inbound_at: string | Date | null
  last_outbound_at: string | Date | null
}

const COL_MAP: Record<string, string> = {
  status: "status",
  closedReason: "closed_reason",
  mergedIntoTicketId: "merged_into_ticket_id",
  convertedToMailConversationId: "converted_to_mail_conversation_id",
  followupAt: "followup_at",
  followupReason: "followup_reason",
  followupTrigger: "followup_trigger",
  slaActiveStartedAt: "sla_active_started_at",
  slaPausedAt: "sla_paused_at",
  slaElapsedSeconds: "sla_elapsed_seconds",
  slaBreachedAt: "sla_breached_at",
  slaTargetSeconds: "sla_target_seconds",
  slaDeadline: "sla_deadline",
  firstResponseAt: "first_response_at",
  updatedAt: "updated_at",
}

function fetchTicketRow(tx: SqlClient, ticketId: string, orgId: string): Promise<TicketRow | null> {
  return tx
    .execute(
      drizzleSql`SELECT * FROM ${ticketsRel("tickets")} WHERE id = ${ticketId} AND org_id = ${orgId} LIMIT 1`,
    )
    .then((r) => extractRows<TicketRow>(r)[0] ?? null)
}

export async function loadTicketsSlaSettings(
  orgId: string,
  privilegedTx?: PrivilegedDb,
): Promise<{
  targets: Record<string, number>
  businessHours: import("~/apps/tickets/sla").BusinessHours
}> {
  return onPrivilegedDb(orgId, "tickets-load-settings", privilegedTx, async (tx) => {
    const result = await tx.execute(
      drizzleSql`SELECT settings->'tickets'->'sla' AS sla FROM ${kernelRel("organizations")} WHERE id = ${orgId} LIMIT 1`,
    )
    const sla = extractRows<{ sla: { targets: Record<string, number>; businessHours: any } }>(
      result,
    )[0]?.sla
    if (!sla) {
      throw new Error("tickets settings not seeded for org")
    }
    return sla
  })
}

export async function applyEffects(
  tx: SqlClient,
  ticketId: string,
  effects: TransitionEffects,
  actor: {
    actorType: "user" | "agent" | "system" | "mcp"
    /**
     * The AUDIT category for what this call emits, when it differs from the RLS
     * actor above (X10's split, extended by FX2 to every audit-bearing seam).
     * A sandboxed app tool call made inside an agent turn is an AGENT action and
     * audits as one, while `actorType` keeps deciding the RLS actor, the
     * self-assignment sentinel, `created_by` and the note author. Absent means
     * "the same as actorType", which is every non-agent caller.
     */
    auditActorType?: "user" | "agent" | "system" | "mcp"
    /** The routine the call runs for (it runs as its owner): named on what it emits. */
    originRoutineId?: string
    /** The approval the call executes, if any: its own status change never cancels it. */
    approvalRequestId?: string | null
    userId: string
    orgId: string
  },
  opts: PrivilegedReadOptions = {},
): Promise<void> {
  const ticket = await fetchTicketRow(tx, ticketId, actor.orgId)
  if (!ticket) throw new Error("ticket_not_found")
  const needsSettings =
    effects.slaAction === "pause" ||
    effects.slaAction === "resume" ||
    effects.slaAction === "recompute"
  const settings = needsSettings
    ? await loadTicketsSlaSettings(actor.orgId, opts.privilegedTx)
    : null
  const now = new Date()
  const nowIso = now.toISOString()

  const update: Record<string, unknown> = {
    status: effects.status,
    updatedAt: nowIso,
  }
  if (effects.closedReason !== undefined) update.closedReason = effects.closedReason
  if (effects.priority !== undefined) update.priority = effects.priority
  if (effects.mergedIntoTicketId !== undefined)
    update.mergedIntoTicketId = effects.mergedIntoTicketId
  if (effects.convertedToMailConversationId !== undefined)
    update.convertedToMailConversationId = effects.convertedToMailConversationId
  if (effects.followupAt !== undefined) update.followupAt = effects.followupAt
  if (effects.followupReason !== undefined) update.followupReason = effects.followupReason
  if (effects.followupTrigger !== undefined) update.followupTrigger = effects.followupTrigger

  if (effects.slaAction === "pause") {
    if (ticket.sla_active_started_at) {
      const elapsed = businessHoursBetween(
        new Date(ticket.sla_active_started_at as string),
        now,
        settings!.businessHours,
      )
      update.slaElapsedSeconds = (ticket.sla_elapsed_seconds ?? 0) + Math.max(0, elapsed)
    }
    update.slaPausedAt = nowIso
    update.slaActiveStartedAt = null
  } else if (effects.slaAction === "resume") {
    update.slaActiveStartedAt = nowIso
    update.slaPausedAt = null
    const remaining = Math.max(0, ticket.sla_target_seconds - (ticket.sla_elapsed_seconds ?? 0))
    update.slaDeadline = walkForwardBusinessHours(
      now,
      remaining,
      settings!.businessHours,
    ).toISOString()
  } else if (effects.slaAction === "satisfy") {
    update.firstResponseAt = nowIso
    update.slaActiveStartedAt = null
    update.slaPausedAt = null
    update.slaBreachedAt = null
  } else if (effects.slaAction === "recompute") {
    const priority = (effects.priority ?? ticket.priority) as string
    const target = settings!.targets[priority]
    if (target !== undefined) update.slaTargetSeconds = target
    update.slaBreachedAt = null
    if (ticket.sla_active_started_at) {
      const elapsed = businessHoursBetween(
        new Date(ticket.sla_active_started_at as string),
        now,
        settings!.businessHours,
      )
      update.slaElapsedSeconds = (ticket.sla_elapsed_seconds ?? 0) + Math.max(0, elapsed)
      update.slaActiveStartedAt = nowIso
    }
    const elapsedSec =
      (update.slaElapsedSeconds as number | undefined) ?? ticket.sla_elapsed_seconds ?? 0
    const remaining = Math.max(
      0,
      ((update.slaTargetSeconds as number | undefined) ?? ticket.sla_target_seconds) - elapsedSec,
    )
    update.slaDeadline = walkForwardBusinessHours(
      now,
      remaining,
      settings!.businessHours,
    ).toISOString()
  }

  const setFragments = Object.entries(update).map(([k, v]) => {
    const col = COL_MAP[k] ?? k.replace(/([A-Z])/g, "_$1").toLowerCase()
    return drizzleSql`${drizzleSql.raw(`"${col}"`)} = ${v}`
  })
  const setClause = drizzleSql.join(setFragments, drizzleSql.raw(", "))
  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("tickets")}
    SET ${setClause}
    WHERE id = ${ticketId} AND org_id = ${actor.orgId}
  `)

  // The ticket stopped waiting on the customer: the close-silent routine's
  // cards proposed on that silence no longer apply.
  if (ticket.status === "awaiting_customer" && effects.status !== "awaiting_customer") {
    await cancelSilentCloseCards(tx, {
      orgId: actor.orgId,
      ticketId,
      reason: "status_changed",
      exceptApprovalId: actor.approvalRequestId ?? null,
    })
  }

  // Outbox events. A merge event names the source by its display handle.
  const sourceHandle = effects.emit.includes("merged")
    ? ((await displayHandleFor(
        tx,
        actor.orgId,
        ticketId,
        opts.privilegedTx ? await loadSegmentConfig(actor.orgId, opts.privilegedTx) : undefined,
      )) ?? ticket.handle)
    : ticket.handle
  for (const e of effects.emit) {
    const data: Record<string, unknown> =
      e === "status"
        ? { ticketId, changes: update }
        : e === "reopened"
          ? {
              ticketId,
              reason: effects.timelineActionLabel === "manual_reopen" ? "manual" : "followup_due",
            }
          : e === "merged"
            ? {
                sourceTicketId: ticketId,
                sourceHandle,
                targetTicketId: effects.mergedIntoTicketId,
                targetHandle: effects.timelineDetails?.targetHandle,
                mergedMessageCount: effects.timelineDetails?.mergedMessageCount,
              }
            : e === "converted"
              ? { ticketId, mailConversationId: effects.convertedToMailConversationId }
              : { ticketId }
    const action = e === "status" ? "update" : e
    const eventActorId = UUID_RE.test(actor.userId) ? actor.userId : null
    await (tx as RlsClient).queueEvent({
      app: "tickets",
      entity: "ticket",
      action,
      entityId: ticketId,
      data,
      actorId: eventActorId,
      actorType: actor.auditActorType ?? actor.actorType,
      orgId: actor.orgId,
      // The audit row of a routine's change names the routine.
      ...(actor.originRoutineId ? { metadata: { routineId: actor.originRoutineId } } : {}),
    })
  }

  if (effects.timelineActionLabel) {
    const { generateTimelineEntries } = await import("~/modules/audit/timeline")
    await generateTimelineEntries(
      tx as RlsClient,
      {
        orgId: actor.orgId,
        app: "tickets",
        entity: "ticket",
        entityId: ticketId,
        action: effects.timelineActionLabel,
        userId: UUID_RE.test(actor.userId) ? actor.userId : null,
        actorType: actor.auditActorType ?? actor.actorType,
        data: effects.timelineDetails ?? {},
        actionLabel: effects.timelineActionLabel,
        details: effects.timelineDetails,
      } as never,
    )
  }
}

export async function setPriorityAndRecompute(
  tx: SqlClient,
  ticketId: string,
  priority: string,
  actor: {
    actorType: "user" | "agent" | "system" | "mcp"
    /**
     * The AUDIT category for what this call emits, when it differs from the RLS
     * actor above (X10's split, extended by FX2 to every audit-bearing seam).
     * A sandboxed app tool call made inside an agent turn is an AGENT action and
     * audits as one, while `actorType` keeps deciding the RLS actor, the
     * self-assignment sentinel, `created_by` and the note author. Absent means
     * "the same as actorType", which is every non-agent caller.
     */
    auditActorType?: "user" | "agent" | "system" | "mcp"
    userId: string
    orgId: string
  },
): Promise<
  | { ticketId: string; priority: string; slaDeadline: string | null }
  | { error: { code: string; message: string; retryable: boolean } }
> {
  const ticket = await fetchTicketRow(tx, ticketId, actor.orgId)
  if (!ticket) {
    return { error: { code: "not_found", message: "ticket not found", retryable: false } }
  }
  await applyEffects(
    tx,
    ticketId,
    {
      status: ticket.status as TicketStatus,
      priority,
      slaAction: ticket.first_response_at === null ? "recompute" : "none",
      emit: ["status"],
    },
    actor,
  )
  const updated = await fetchTicketRow(tx, ticketId, actor.orgId)
  const slaDeadline = updated?.sla_deadline
  return {
    ticketId,
    priority,
    slaDeadline: slaDeadline instanceof Date ? slaDeadline.toISOString() : (slaDeadline ?? null),
  }
}

/**
 * A routine may not move a ticket out of "we owe the customer a reply" (open)
 * into a waiting state while the customer still has the last word. A drafted
 * reply sitting in approvals is not a reply: parking the ticket in Follow-ups
 * hid it from Needs attention until the follow-up came due, days later. The
 * real reply moves the ticket to awaiting_customer by itself once it is sent.
 * Humans keep the right to defer (a customer away until next month).
 */
function routineParksAnsweredCustomer(
  ticket: TicketRow,
  input: TransitionInput,
): ValidationResult | null {
  const parks =
    input.kind === "setFollowup" ||
    (input.kind === "setStatus" &&
      (input.intended === "awaiting_customer" || input.intended === "awaiting_followup"))
  if (!parks || !currentRunContext()?.routineId) return null
  const lastIn = ticket.last_inbound_at ? new Date(ticket.last_inbound_at).getTime() : null
  const lastOut = ticket.last_outbound_at ? new Date(ticket.last_outbound_at).getTime() : null
  if (lastIn === null || (lastOut !== null && lastOut >= lastIn)) return null
  return {
    ok: false,
    code: "customer_awaiting_reply",
    message:
      "the customer wrote last and has not been answered yet; a routine cannot park this ticket. Leave it open: a drafted reply moves it to awaiting_customer once it is actually sent.",
  }
}

export async function validateAndApply(
  tx: SqlClient,
  ticketId: string,
  input: TransitionInput,
  actor: {
    actorType: "user" | "agent" | "system" | "mcp"
    /**
     * The AUDIT category for what this call emits, when it differs from the RLS
     * actor above (X10's split, extended by FX2 to every audit-bearing seam).
     * A sandboxed app tool call made inside an agent turn is an AGENT action and
     * audits as one, while `actorType` keeps deciding the RLS actor, the
     * self-assignment sentinel, `created_by` and the note author. Absent means
     * "the same as actorType", which is every non-agent caller.
     */
    auditActorType?: "user" | "agent" | "system" | "mcp"
    /** The routine the call runs for (it runs as its owner): named on what it emits. */
    originRoutineId?: string
    /** The approval the call executes, if any: its own status change never cancels it. */
    approvalRequestId?: string | null
    userId: string
    orgId: string
  },
  // A caller inside a privileged transaction passes it (privileged-read.ts).
  opts: PrivilegedReadOptions = {},
): Promise<ValidationResult> {
  const ticket = await fetchTicketRow(tx, ticketId, actor.orgId)
  if (!ticket) {
    return { ok: false, code: "ticket_not_found", message: "ticket not found" }
  }
  const parked = routineParksAnsweredCustomer(ticket, input)
  if (parked) return parked
  const validation = validateTransition(
    {
      status: ticket.status as TicketStatus,
      closedReason: (ticket.closed_reason as ClosedReason | null) ?? null,
      mergedIntoTicketId: ticket.merged_into_ticket_id,
      convertedToMailConversationId: ticket.converted_to_mail_conversation_id,
      firstResponseAt:
        ticket.first_response_at instanceof Date
          ? ticket.first_response_at.toISOString()
          : ticket.first_response_at,
    },
    input,
  )
  if (!validation.ok) return validation
  await applyEffects(tx, ticketId, validation.effects, actor, opts)
  return validation
}
