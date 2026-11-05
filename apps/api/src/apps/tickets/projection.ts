// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure handler-boundary mapping functions: convert raw snake_case rows from
// `searchTickets` / `getTicket` into the camelCase envelope consumed by the
// frontend stores. ISO-string timestamps everywhere, `null` for empty refs.

import { displayTicketHandle, type TicketIdSegment } from "@liaison/shared"

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? value : d.toISOString()
  }
  return null
}

function n<T>(v: T | undefined | null): T | null {
  return v === undefined || v === null ? null : v
}

export interface CamelTicket {
  id: string
  handle: string
  subject: string
  status: string
  priority: string
  channel: string | null
  team: string | null
  audience: string | null
  language: string | null
  sensitivity: string
  categoryId: string | null
  /** The category's display NAME (e.g. "Shipping"), resolved server-side from
   *  category_id when search/get joins it — so a caller can identify a ticket's
   *  topic (e.g. which slaApproaching tickets are shipping-related) without a
   *  second lookup. Null when uncategorized or when the query didn't join it. */
  categoryName: string | null
  contactId: string | null
  assignedTo: string | null
  /** The assignee's display NAME (resolved server-side from assigned_to →
   *  kernel.users), so a backlog/owner readout can name WHO owns each ticket
   *  without an extra users_search per row. Null when unassigned or when the
   *  query didn't join it. Mirrors categoryName's resolve-the-opaque-id pattern. */
  assigneeName: string | null
  replyToken: string
  sourceAccountId: string | null
  sourceInboxId: string | null
  sourceConversationId: string | null
  convertedToMailConversationId: string | null
  mergedIntoTicketId: string | null
  closedReason: string | null
  firstResponseAt: string | null
  slaTargetSeconds: number
  slaDeadline: string | null
  slaActiveStartedAt: string | null
  slaPausedAt: string | null
  slaElapsedSeconds: number
  slaBreachedAt: string | null
  lastInboundAt: string | null
  lastOutboundAt: string | null
  lastMessageAt: string | null
  messageCount: number
  nudgeSentAt: string | null
  followupAt: string | null
  followupReason: string | null
  followupTrigger: string | null
  internalThreadId: string | null
  externalRef: string | null
  summaryText: string | null
  summaryAt: string | null
  summaryMessageCount: number
  summaryStatus: string
  summaryModel: string | null
  summaryError: string | null
  createdAt: string | null
  updatedAt: string | null
  unread?: boolean
  readByCount?: number
  readByRecent?: Array<{ userId: string; name: string | null; readAt: string }>
  /** Who the ticket is with (requester, else linked contact, else first external inbound
   *  sender; a plain addr-spec only): the customer card's lookup key. `tickets:get` only. */
  participantEmail?: string | null
  /** Resolved contact (by email at ticket creation) for inbox display. Present on search rows that
   *  selected contact_name/contact_email; undefined on projections that did not. */
  contact?: { id: string; name: string | null; email: string | null } | null
  /** One-line inbox preview — the latest message's snippet (or first 200 chars of its body). Present on
   *  search rows that selected it; undefined otherwise. */
  snippet?: string | null
  urgencyRank?: number
  /** Whole days since the ticket was opened (server-computed, mirrors backlogHealth.oldest). Present on
   *  search rows; undefined on projections that did not select it. Use it to flag 'aging past N days'. */
  ageDays?: number
  /** Server-computed aging discrimination: true iff ageDays > the search's agingThresholdDays (default
   *  3). Present on search rows; undefined when not selected. RENDER this boolean for 'aging past N
   *  days' flags instead of recomputing the comparison. */
  aging?: boolean
  /** Server-computed follow-up DUE-ness: true iff followupAt is non-null AND already in the PAST
   *  (followup_at <= now()) — i.e. the scheduled follow-up is DUE NOW; false when followupAt is in the
   *  FUTURE (not yet due); undefined when there is no followupAt or the projection did not select it.
   *  RENDER this boolean for a "due follow-ups" sweep (the vip-mailbox-followup-scheduler routine)
   *  instead of comparing the followupAt ISO timestamp to "now" in-context — a flash-lite routine tick
   *  mis-computes ISO-date arithmetic, so the discrimination is moved server-side (the l710 lesson:
   *  the tick copies a boolean, it does not do date math). */
  followupDue?: boolean
  /** Server-computed whole days since the LAST INBOUND customer message (last_inbound_at). Present on
   *  search rows for tickets that have an inbound customer message; undefined when there is none or the
   *  projection did not select it. For an awaiting_customer ticket this is the CUSTOMER-SILENCE age — days
   *  since the customer last wrote — that an auto-close routine reads to judge staleness. */
  customerSilentDays?: number
  /** Server-computed customer-silence discrimination: true iff the customer has been silent for >= the
   *  search's silentForDays (default 7) — i.e. last_inbound_at is older than the threshold; false when
   *  they replied more recently; undefined when there is no inbound customer message or the projection did
   *  not select it. RENDER this boolean for an auto-close "no reply for 7+ days" sweep instead of
   *  recomputing the last-inbound age in-context (a flash-lite tick acted on fresh tickets) — the same
   *  lever as aging/followupDue: the tick copies a boolean, it does not do date math. */
  customerSilent?: boolean
}

/**
 * `segment` is the org's ticket-id segment config: when given, `handle` is the
 * DISPLAY handle (`ticket-B2B-12`) computed from the row's current segment
 * field, which every search/get row carries. Without it, the stored handle.
 */
export function toCamelTicket(
  row: Record<string, unknown>,
  segment?: TicketIdSegment,
): CamelTicket {
  return {
    id: String(row.id),
    handle: segment
      ? displayTicketHandle(
          String(row.handle ?? ""),
          {
            audience: row.audience as string | null | undefined,
            team: row.team as string | null | undefined,
            categoryId: row.category_id as string | null | undefined,
            sourceInboxId: row.source_inbox_id as string | null | undefined,
          },
          segment,
        )
      : String(row.handle ?? ""),
    subject: String(row.subject ?? ""),
    status: String(row.status ?? "open"),
    priority: String(row.priority ?? "normal"),
    channel: n(row.channel as string | null | undefined),
    team: n(row.team as string | null | undefined),
    audience: n(row.audience as string | null | undefined),
    language: n(row.language as string | null | undefined),
    sensitivity: String(row.sensitivity ?? "internal"),
    categoryId: n(row.category_id as string | null | undefined),
    categoryName: n(row.category_name as string | null | undefined),
    contactId: n(row.contact_id as string | null | undefined),
    // Inbox-row contact object (search path selects contact_name/contact_email). Only present when the
    // ticket has a contact_id; the get/detail path doesn't select these, leaving it undefined.
    contact:
      row.contact_id != null && (row.contact_name != null || row.contact_email != null)
        ? {
            id: String(row.contact_id),
            name: n(row.contact_name as string | null | undefined),
            email: n(row.contact_email as string | null | undefined),
          }
        : undefined,
    snippet: row.snippet === undefined ? undefined : n(row.snippet as string | null | undefined),
    assignedTo: n(row.assigned_to as string | null | undefined),
    assigneeName: n(row.assignee_name as string | null | undefined),
    replyToken: String(row.reply_token ?? ""),
    sourceAccountId: n(row.source_account_id as string | null | undefined),
    sourceInboxId: n(row.source_inbox_id as string | null | undefined),
    sourceConversationId: n(row.source_conversation_id as string | null | undefined),
    convertedToMailConversationId: n(
      row.converted_to_mail_conversation_id as string | null | undefined,
    ),
    mergedIntoTicketId: n(row.merged_into_ticket_id as string | null | undefined),
    closedReason: n(row.closed_reason as string | null | undefined),
    firstResponseAt: iso(row.first_response_at),
    slaTargetSeconds: Number(row.sla_target_seconds ?? 0),
    slaDeadline: iso(row.sla_deadline),
    slaActiveStartedAt: iso(row.sla_active_started_at),
    slaPausedAt: iso(row.sla_paused_at),
    slaElapsedSeconds: Number(row.sla_elapsed_seconds ?? 0),
    slaBreachedAt: iso(row.sla_breached_at),
    lastInboundAt: iso(row.last_inbound_at),
    lastOutboundAt: iso(row.last_outbound_at),
    lastMessageAt: iso(row.last_message_at),
    messageCount: Number(row.message_count ?? 0),
    nudgeSentAt: iso(row.nudge_sent_at),
    followupAt: iso(row.followup_at),
    followupReason: n(row.followup_reason as string | null | undefined),
    followupTrigger: n(row.followup_trigger as string | null | undefined),
    internalThreadId: n(row.internal_thread_id as string | null | undefined),
    externalRef: n(row.external_ref as string | null | undefined),
    summaryText: n(row.summary_text as string | null | undefined),
    summaryAt: iso(row.summary_at),
    summaryMessageCount: Number(row.summary_message_count ?? 0),
    summaryStatus: String(row.summary_status ?? "idle"),
    summaryModel: n(row.summary_model as string | null | undefined),
    summaryError: n(row.summary_error as string | null | undefined),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    urgencyRank: row.urgency_rank === undefined ? undefined : Number(row.urgency_rank),
    // Server-computed whole-days-open age (mirrors backlogHealth.oldest). Present on search rows so an
    // agent flagging 'aging past N days' compares this integer to N instead of re-deriving it from
    // createdAt; absent (undefined) on projections that did not select it (e.g. the get path).
    ageDays: row.age_days === undefined || row.age_days === null ? undefined : Number(row.age_days),
    // Server-computed aging discrimination (ageDays > agingThresholdDays). The agent RENDERS this
    // boolean for the 'aging' flag — no in-context comparison. Undefined when not selected (get path).
    aging: row.aging === undefined || row.aging === null ? undefined : Boolean(row.aging),
    // Server-computed follow-up due-ness (followup_at IS NOT NULL AND followup_at <= now()). The agent
    // RENDERS this boolean to decide which scheduled follow-ups are DUE now vs not-yet-due — no
    // in-context ISO-date arithmetic. Undefined when not selected (get path) or when there is no
    // followup_at (the SQL returns NULL → undefined here, not a misleading `false`).
    followupDue:
      row.followup_due === undefined || row.followup_due === null
        ? undefined
        : Boolean(row.followup_due),
    // Server-computed days since last inbound customer message (last_inbound_at). The auto-close routine
    // reads this CUSTOMER-SILENCE age; undefined when there is no inbound message (SQL NULL) or not
    // selected (get path) — never a misleading 0.
    customerSilentDays:
      row.customer_silent_days === undefined || row.customer_silent_days === null
        ? undefined
        : Number(row.customer_silent_days),
    // Server-computed customer-silence discrimination (last_inbound_at <= now() - silentForDays). The
    // auto-close tick RENDERS this boolean to pick the STALE awaiting_customer tickets — no in-context
    // last-inbound arithmetic. Undefined when there is no inbound message (SQL NULL → undefined, never a
    // false-stale) or when not selected (get path).
    customerSilent:
      row.customer_silent === undefined || row.customer_silent === null
        ? undefined
        : Boolean(row.customer_silent),
  }
}

export interface CamelMessageAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  disposition: "inline" | "attachment"
  contentId: string | null
  ordinal: number
}

export interface CamelMessage {
  id: string
  ticketId: string
  kind: string
  fromEmail: string | null
  fromName: string | null
  toEmails: unknown[]
  ccEmails: unknown[]
  subject: string | null
  htmlBody: string | null
  textBody: string | null
  snippet: string | null
  externalMessageId: string | null
  inReplyTo: string | null
  headerReferences: unknown
  sentAt: string | null
  createdBy: string | null
  /** Display name of the Liaison user who authored this row (resolved from
   *  created_by) — the conversation view's author for outbound replies and
   *  notes. Null for inbound/system rows. */
  authorName: string | null
  createdAt: string | null
  updatedAt: string | null
  attachments?: CamelMessageAttachment[]
  /** True ONLY for the ticket-creation acknowledgement send (Task 2 contract) —
   *  the frontend hides any message where this is true. Absent/false for every
   *  other message (inbound, ordinary reply/nudge/close outbound, note). */
  isAcknowledgement: boolean
  /** The receiving provider's SPF/DKIM/DMARC verdict for the From address: pass, fail or none. Null on messages stored before it was recorded. */
  senderAuth: string | null
  /** The user who APPROVED this outbound send, when it went through the gated
   *  approval flow. An approved handler executes as the REQUESTER (deliberate,
   *  for RLS/scope reasons), so `createdBy` is whoever drafted/requested it and
   *  this is whoever authorised it. Prod 2026-08-05: replies requested by
   *  one teammate and approved by another rendered as written by the requester, because only
   *  the requester was ever persisted. Null for a direct send. */
  approvedBy: string | null
  /** Display name for {@link approvedBy}, resolved the same way as authorName. */
  approverName: string | null
  /** Shown INSTEAD of `authorName` when the send did not really come from that
   *  person: a routine executes as its owner, so a routine-drafted reply would
   *  otherwise read as written by whoever created the routine. */
  authorLabel: string | null
}

/**
 * Rewrite `cid:<contentId>` references in HTML to authenticated inline-route
 * URLs. Matches both bracketed and bare forms; missing CIDs are left alone so
 * upstream HTML doesn't break when an attachment failed to persist.
 */
export function rewriteCidReferences(html: string, attachments: CamelMessageAttachment[]): string {
  if (!html) return html
  let out = html
  for (const att of attachments) {
    if (att.disposition !== "inline" || !att.contentId) continue
    const cid = att.contentId
    const replacement = `/api/files/${att.id}/inline`
    // Replace both `cid:hero@cid` and the URL-encoded variants.
    const variants = [cid, encodeURIComponent(cid)]
    for (const v of variants) {
      const re = new RegExp(`cid:${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi")
      out = out.replace(re, replacement)
    }
  }
  return out
}

export function toCamelMessage(row: Record<string, unknown>): CamelMessage {
  return {
    id: String(row.id),
    ticketId: String(row.ticket_id),
    kind: String(row.kind),
    fromEmail: n(row.from_email as string | null | undefined),
    fromName: n(row.from_name as string | null | undefined),
    toEmails: Array.isArray(row.to_emails) ? (row.to_emails as unknown[]) : [],
    ccEmails: Array.isArray(row.cc_emails) ? (row.cc_emails as unknown[]) : [],
    subject: n(row.subject as string | null | undefined),
    htmlBody: n(row.html_body as string | null | undefined),
    textBody: n(row.text_body as string | null | undefined),
    snippet: n(row.snippet as string | null | undefined),
    externalMessageId: n(row.external_message_id as string | null | undefined),
    inReplyTo: n(row.in_reply_to as string | null | undefined),
    headerReferences: row.header_references ?? null,
    sentAt: iso(row.sent_at),
    createdBy: n(row.created_by as string | null | undefined),
    authorName: n(row.author_name as string | null | undefined),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    isAcknowledgement: Boolean(row.is_acknowledgement),
    senderAuth: n(row.sender_auth as string | null | undefined),
    approvedBy: n(row.approved_by as string | null | undefined),
    approverName: n(row.approver_name as string | null | undefined),
    authorLabel: n(row.author_label as string | null | undefined),
  }
}
