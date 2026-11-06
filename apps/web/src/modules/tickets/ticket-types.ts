// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared TS interfaces for the Tickets frontend module — wire format mirrors
// the camelCase envelope produced by the backend handlers' projection adapter.

export interface Ticket {
  id: string
  handle: string
  subject: string
  status: string
  priority: string
  channel: string | null
  team: string | null
  /** "b2b" | "b2c" | null — which side wrote. Orthogonal to `team` (which
   *  centre): the same centre carries both. null means nobody established it. */
  audience: string | null
  sensitivity: string
  categoryId: string | null
  /** The category's display NAME, resolved server-side (CamelTicket.categoryName
   *  on the API side). Present on search rows and the ticket-detail `tickets:get`
   *  payload; undefined only if a projection didn't select it. */
  categoryName?: string | null
  contactId: string | null
  assignedTo: string | null
  assigneeName?: string | null
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
  snippet?: string | null
  contact?: {
    id: string
    name: string | null
    email: string | null
    avatarUrl?: string | null
  } | null
  /** Who the ticket is with, resolved server side by the agent's own rule (tickets:get only). */
  participantEmail?: string | null
  assignee?: { id: string; name: string | null; avatarUrl?: string | null } | null
  category?: { id: string; name: string | null } | null
}

export interface TicketMessageAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  thumbnailUrl?: string | null
  disposition?: "inline" | "attachment"
  contentId?: string | null
  ordinal?: number
}

export interface TicketMessage {
  id: string
  ticketId: string
  kind: "inbound" | "outbound" | "note" | "outbound-pending" | string
  fromEmail: string | null
  fromName: string | null
  /** Liaison user who authored this row (resolved server-side from created_by).
   *  The conversation view shows this as the author of outbound replies and
   *  notes; from_email/from_name stay the email-wire identity. */
  authorName?: string | null
  /** Who APPROVED a gated send. The approved handler runs as the REQUESTER, so
   *  `authorName` is the drafter and this is the authoriser; the conversation
   *  shows both when they differ. Null/absent on a direct send. */
  approvedBy?: string | null
  approverName?: string | null
  /** Shown instead of `authorName` when a routine produced the message: a
   *  routine runs as its owner, so authorName would name that person. */
  authorLabel?: string | null
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
  createdAt: string | null
  updatedAt: string | null
  attachments?: TicketMessageAttachment[]
  clientPlaceholderId?: string
  payloadHash?: string
  approvalRequestId?: string
  // CONTRACT with the backend: the ticket-creation acknowledgement email
  // (sendTicketAcknowledgement, apps/api/src/apps/tickets/tools.ts) is a real
  // outbound message sent to the customer and persisted like any other, but
  // it's system-generated boilerplate ("we got your request") rather than
  // agent conversation — the agent thread hides it (still exists server-side
  // and was actually delivered).
  isAcknowledgement?: boolean
  /** The receiving provider's SPF/DKIM/DMARC verdict for an inbound message's From: pass, fail or none. */
  senderAuth?: string | null
}

export interface TicketInbox {
  id: string
  // "mailbox" (default, connected mail account) or "api" (pure receiving
  // bucket, no mail account — see inboxesCreateApi on the backend). Missing
  // on older cached rows -> treat as "mailbox".
  kind?: "mailbox" | "api"
  connectedAccountId: string | null
  name: string
  emailAddress: string | null
  defaultTeam: string | null
  defaultSensitivity: string | null
  fromDisplayName: string | null
  // Reply transport for an "api" inbox: the mailbox inbox its replies are
  // sent through. Wire format is snake_case (`reply_via_inbox_id`) straight
  // off the admin SQL row -- mirror both here like the rest of this type.
  replyViaInboxId?: string | null
  reply_via_inbox_id?: string | null
  replyFromEmail?: string | null
  reply_from_email?: string | null
  // Per-inbox ("virtual mailbox") email identity/config. Wire format is
  // snake_case straight off the admin SQL row, same convention as the fields
  // above -- mirror both here.
  replyToEmail?: string | null
  reply_to_email?: string | null
  signatureHtml?: string | null
  signature_html?: string | null
  signatureText?: string | null
  signature_text?: string | null
  ackEnabled?: boolean
  ack_enabled?: boolean
  ackBodyText?: string | null
  ack_body_text?: string | null
  slaPromisePhrase?: string | null
  sla_promise_phrase?: string | null
  suppressAttention?: boolean
  suppress_attention?: boolean
  // Notify on new ticket: each new ticket raises an attention item for the inbox
  // admins. Off by default. Wire format is snake_case off the admin row.
  notifyNewTicket?: boolean
  notify_new_ticket?: boolean
  // SLA-exempt inbox: its tickets carry no SLA (no deadline/breach). Admin toggle,
  // independent of suppress_attention. Wire format is snake_case off the admin row.
  slaExempt?: boolean
  sla_exempt?: boolean
  // Close tickets when the customer stays silent (off by default): nudge after
  // N days, close M days after the nudge. Snake_case off the admin row.
  close_silent_enabled?: boolean
  close_silent_nudge_days?: number | null
  close_silent_close_days?: number | null
  close_silent_nudge_text?: string | null
  close_silent_enabled_at?: string | null
  isDefaultForCreate: boolean
  archivedAt: string | null
  // Health of the backing connected mail account, computed server-side by the
  // same classifier as the connection-health attention feed (inboxesList join).
  // Null for API inboxes (no account). Wire format is snake_case off the admin
  // SQL row -- mirror both here like the fields above.
  connectionHealth?: InboxConnectionHealth | null
  connection_health?: InboxConnectionHealth | null
}

export interface InboxConnectionHealth {
  status: "ok" | "needs_reconnect"
  // The account's connection name ("gmail" | "imap") so Reconnect starts the
  // right flow.
  connection?: string
  // "error" | "expired_no_refresh" | "missing_scopes" | "disconnected"
  reason?: string
  missingScopes?: string[]
  statusMessage?: string
}

export interface TicketCategory {
  id: string
  parentId: string | null
  name: string
  sortOrder: number
  archivedAt: string | null
}

// Saved reply template (canned-response macro) — the wire row produced by the
// tickets `templates.list` admin handler (apps/api/src/apps/tickets/admin.ts
// templatesList) is snake_case `body_text` / `created_at`; the composer maps it
// to camelCase on read (mirror of how TicketCategory is declared above).
export interface ReplyTemplateRow {
  id: string
  name: string
  category: string | null
  body_text: string
  created_at: string | null
}

export interface ReplyTemplate {
  id: string
  name: string
  category: string | null
  bodyText: string
  createdAt: string | null
}
