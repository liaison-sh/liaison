// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T10. The two derivations the phone ticket list is made of, kept pure so
// they can be pinned by a test rather than read off a rendered row: the chip
// row (which saved views exist, and what each one currently counts) and the
// state pills a row carries.
//
// Both take the STORE's own shapes as arguments: nothing here imports a store,
// so a test states the store state instead of mocking a module.
import type { SmartFilter } from "~/modules/tickets/ticket-list-store"

/** The saved views the chip row offers, in the order the sidebar lists them. */
export const TICKET_PHONE_VIEWS: ReadonlyArray<{ id: SmartFilter; labelKey: string }> = [
  { id: "needs-attention", labelKey: "kernel.ticketViewNeedsAttention" },
  { id: "awaiting-customer", labelKey: "kernel.ticketViewAwaitingCustomer" },
  { id: "follow-ups", labelKey: "kernel.ticketViewFollowUps" },
  { id: "closed", labelKey: "kernel.ticketViewClosed" },
  { id: "all-open", labelKey: "kernel.ticketViewAllOpen" },
]

export interface TicketViewChip {
  id: SmartFilter
  labelKey: string
  /** Undefined when nothing has counted this view yet: a chip with no number
   *  is honest, a chip reading 0 is a claim the store has not made. */
  count?: number
}

/**
 * The chip row. Counts come from the SAME per-view counts the desktop sidebar
 * badges read (`ticketFilterCountStore`), `all-open` included: it is the
 * number of open tickets the view lists, not an unread total.
 */
export function ticketViewChips(
  countByFilter: Partial<Record<SmartFilter, number>>,
): TicketViewChip[] {
  return TICKET_PHONE_VIEWS.map((view) => {
    const count = countByFilter[view.id]
    return count === undefined ? { id: view.id, labelKey: view.labelKey } : { ...view, count }
  })
}

export type TicketPhonePill = "sla" | "waiting" | "draft" | "replied"

/** How soon an unanswered SLA counts as at risk. */
export const SLA_RISK_WINDOW_MS = 60 * 60 * 1000

export interface TicketPillInput {
  status: string
  firstResponseAt?: string | null
  slaDeadline?: string | null
  lastInboundAt?: string | null
  lastOutboundAt?: string | null
}

/**
 * The state pills for one row. Several can hold at once (a ticket waiting on us
 * with an SLA about to breach is both), and the order here is the order they
 * paint: the thing that costs money first.
 */
export function ticketPhonePills(
  ticket: TicketPillInput,
  opts: { hasAgentDraft: boolean; now: number },
): TicketPhonePill[] {
  const pills: TicketPhonePill[] = []

  if (!ticket.firstResponseAt && ticket.slaDeadline) {
    const deadline = Date.parse(ticket.slaDeadline)
    if (Number.isFinite(deadline) && deadline - opts.now < SLA_RISK_WINDOW_MS) pills.push("sla")
  }

  // "Waiting on us" is a fact about the conversation, not about the status
  // label: the customer wrote last and nobody has answered.
  if (ticket.status === "open" && ticket.lastInboundAt) {
    const inbound = Date.parse(ticket.lastInboundAt)
    const outbound = ticket.lastOutboundAt ? Date.parse(ticket.lastOutboundAt) : Number.NaN
    if (!Number.isFinite(outbound) || inbound > outbound) pills.push("waiting")
  }

  if (opts.hasAgentDraft) pills.push("draft")
  if (ticket.status === "awaiting_customer") pills.push("replied")

  return pills
}

/**
 * One SLA vocabulary for every surface. The desktop row said "SLA breached"
 * while the phone card said "Risque SLA" for the same ticket: both now read
 * this state and its label, so a breached ticket says breached everywhere
 * and one inside the risk window says at risk everywhere.
 */
export type TicketSlaState = "breached" | "approaching"

export function ticketSlaState(
  ticket: Pick<TicketPillInput, "firstResponseAt" | "slaDeadline"> & {
    slaBreachedAt?: string | null
  },
  now: number,
): TicketSlaState | null {
  if (ticket.firstResponseAt) return null
  if (ticket.slaBreachedAt) return "breached"
  if (!ticket.slaDeadline) return null
  const deadline = Date.parse(ticket.slaDeadline)
  if (!Number.isFinite(deadline)) return null
  if (deadline <= now) return "breached"
  if (deadline - now < SLA_RISK_WINDOW_MS) return "approaching"
  return null
}

export const TICKET_SLA_LABEL_KEY: Record<TicketSlaState, string> = {
  breached: "kernel.ticketsSlaBreached",
  approaching: "kernel.ticketPillSla",
}

export const TICKET_PILL_LABEL_KEY: Record<TicketPhonePill, string> = {
  sla: "kernel.ticketPillSla",
  waiting: "kernel.ticketPillWaiting",
  draft: "kernel.ticketPillDraft",
  replied: "kernel.ticketPillReplied",
}

export const TICKET_PILL_CLASS: Record<TicketPhonePill, string> = {
  sla: "bg-red-500/15 text-red-300",
  waiting: "bg-amber-500/15 text-amber-300",
  draft: "bg-blue-500/15 text-blue-300",
  replied: "bg-emerald-500/15 text-emerald-300",
}
