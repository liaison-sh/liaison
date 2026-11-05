// SPDX-License-Identifier: FSL-1.1-ALv2
import { type ApprovalSummary, formatTicketHandle, htmlToText } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { displayHandleOfRow, loadSegmentConfig } from "~/apps/tickets/display-handle"
import { loadTicketParties } from "~/apps/tickets/participants"
import { resolveTicketRef } from "~/apps/tickets/resolve-ticket-ref"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { buildAttachmentSummaryLines, type FileOrigin } from "~/modules/files/attach"

const K = () => drizzleSql.raw(schemaRef("kernel"))

type TicketSummaryRow = {
  id: string
  /** The DISPLAY handle (`ticket-B2B-123`), computed from the stored one. */
  handle: string
  subject: string
  reply_token: string
  contact_email: string | null
  contact_name: string | null
  /** Timestamp of the ticket's most recent message (inbound/outbound/note) — the
   *  operator-useful date on every ticket approval card (reply/nudge/close all act on the
   *  ticket's current conversation state, not its original creation). Null for a ticket
   *  with no messages yet. */
  last_message_at: string | null
}

/** Slice an ISO-8601 date/date-time value to `YYYY-MM-DD HH:MM` (24h) for a reviewer-legible
 *  approval-card line — time-of-day matters for a ticket's last message. Degrades to null on
 *  anything malformed/absent. */
function formatDateTime(v: string | Date | null | undefined): string | null {
  if (!v) return null
  const ms = v instanceof Date ? v.getTime() : Date.parse(v)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ")
}

/**
 * Resolve a same-app (`tickets`) file origin to its home ticket id, so
 * `buildAttachmentSummaryLines` can flag an attachment pulled from a *different*
 * ticket (a different customer). Only ever called for `tickets`-app origins.
 */
function makeTicketOriginRootResolver(ctx: { tx: RlsClient; orgId: string }) {
  return async (origin: FileOrigin): Promise<string | null> => {
    const { entityType, entityId } = origin.parent
    if (entityType === "ticket") return entityId
    if (entityType === "message") {
      const [row] = extractRows<{ ticket_id: string }>(
        await ctx.tx.execute(drizzleSql`
          SELECT ticket_id FROM ${ticketsRel("messages")}
          WHERE id = ${entityId} AND org_id = ${ctx.orgId} LIMIT 1
        `),
      )
      return row?.ticket_id ?? null
    }
    return null
  }
}

/**
 * Who the email will actually go to, as the send resolves it: the ticket's
 * stored requester, with its participants copied. The approver sees the real
 * addresses, and a warning when the requester is not the linked contact's
 * address (a ticket can be opened for one person while its contact is another).
 */
async function recipientLines(
  ctx: { tx: RlsClient; orgId: string },
  ticket: TicketSummaryRow | null,
): Promise<{ toLabel: string; lines: string[] }> {
  if (!ticket) return { toLabel: "customer", lines: [] }
  const parties = await loadTicketParties(ctx.tx, ctx.orgId, ticket.id)
  const lines: string[] = []
  if (!parties.requester) {
    lines.push("⚠ This ticket has no customer address: the send will fail")
    return { toLabel: ticket.contact_name ?? ticket.contact_email ?? "customer", lines }
  }
  lines.push(`To: ${parties.requester}`)
  if (parties.participants.length)
    lines.push(`Copied (on the ticket): ${parties.participants.join(", ")}`)
  const contact = ticket.contact_email?.trim().toLowerCase()
  if (contact && contact !== parties.requester) {
    lines.push(`⚠ Recipient differs from the linked contact (${contact})`)
  }
  const toLabel =
    ticket.contact_name && contact === parties.requester ? ticket.contact_name : parties.requester
  return { toLabel, lines }
}

async function loadTicketSummary(
  ctx: { tx: RlsClient; orgId: string },
  ticketRef: string,
): Promise<TicketSummaryRow | null> {
  // The approval card is built from the caller's RAW params, which may carry a
  // `ticket-<n>` handle rather than the uuid. Resolve it here too, so staging a
  // gated call by handle renders a card instead of throwing on the uuid cast.
  const ref = await resolveTicketRef(ctx.tx, ctx.orgId, ticketRef)
  if (!ref.ok) return null
  const ticketId = ref.ticketId
  const r = await ctx.tx.execute(drizzleSql`
    SELECT t.id, t.handle, t.subject, t.reply_token, t.audience, t.team,
           t.category_id::text AS category_id, t.source_inbox_id::text AS source_inbox_id,
           c.email AS contact_email, c.name AS contact_name,
           (SELECT MAX(m.sent_at) FROM ${ticketsRel("messages")} m
            WHERE m.ticket_id = t.id AND m.org_id = t.org_id) AS last_message_at
    FROM ${ticketsRel("tickets")} t
    LEFT JOIN ${K()}.contacts c ON c.id = t.contact_id
    WHERE t.id = ${ticketId} AND t.org_id = ${ctx.orgId}
    LIMIT 1
  `)
  const row = extractRows<TicketSummaryRow>(r)[0]
  if (!row) return null
  // The card leads with the ticket id people use: the display handle.
  const segment = await loadSegmentConfig(ctx.orgId)
  return { ...row, handle: displayHandleOfRow(row as unknown as Record<string, unknown>, segment) }
}

export async function summarizeTicketReply(
  params: {
    ticketId: string
    textBody?: string
    htmlBody?: string
    attachments?: string[]
    attachmentSessionId?: string
    cc?: string[]
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const ticket = await loadTicketSummary(ctx, params.ticketId)
  const subject = ticket?.subject ?? "(no subject)"
  const ref = ticket?.handle
  const recipients = await recipientLines(ctx, ticket)
  const toLabel = recipients.toLabel

  // Mirror the handler's ergonomics normalization (tools.ts): an imported kernel
  // file id passed in `attachmentSessionId` is treated as an attachment, so the
  // approval card the human reviews shows the file too — not a blank attachment list.
  const attachmentIds = [...(params.attachments ?? [])]
  const lines: string[] = [...recipients.lines]
  if (params.attachmentSessionId) {
    const fileRows = extractRows<{ id: string }>(
      await ctx.tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${kernelRel("files")}
        WHERE id = ${params.attachmentSessionId} AND org_id = ${ctx.orgId} LIMIT 1`),
    )
    if (fileRows.length > 0) {
      attachmentIds.push(fileRows[0].id)
    } else {
      // A staged upload session: EVERY file on it goes out with the email, so
      // the card lists every one of them, and says so loudly when the session
      // was not started on this ticket (the send refuses it).
      const sessionRows = extractRows<{
        target_app: string
        target_entity_type: string
        target_entity_id: string | null
      }>(
        await ctx.tx.execute(drizzleSql`
          SELECT target_app, target_entity_type, target_entity_id
          FROM ${kernelRel("file_upload_sessions")}
          WHERE id::text = ${params.attachmentSessionId} AND org_id = ${ctx.orgId} LIMIT 1`),
      )
      const session = sessionRows[0]
      const staged = extractRows<{ id: string }>(
        await ctx.tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${kernelRel("files")}
          WHERE org_id = ${ctx.orgId}
            AND app = 'kernel' AND entity_type = 'file_upload_session'
            AND entity_id = ${params.attachmentSessionId}
          ORDER BY created_at, id`),
      )
      attachmentIds.push(...staged.map((r) => r.id))
      const ticketId = ticket?.id ?? params.ticketId
      if (
        staged.length > 0 &&
        (session?.target_app !== "tickets" ||
          session.target_entity_type !== "ticket" ||
          session.target_entity_id !== ticketId)
      ) {
        lines.push("⚠ Staged files were not attached on this ticket: the send will refuse them")
      }
    }
  }

  // No body-preview line here — the approval card renders the full outgoing
  // message in its own "Message" block (primaryMessageBody in ApprovalCard.tsx),
  // sourced from the exact payload. A clipped duplicate in `lines` would show
  // the same text twice: once cropped, once in full.
  const lastMessageAt = formatDateTime(ticket?.last_message_at)
  if (lastMessageAt) lines.push(`Last message: ${lastMessageAt}`)
  // Who else the email goes to: an approver must see every recipient.
  const cc = Array.isArray(params.cc) ? params.cc.filter((a) => typeof a === "string" && a) : []
  if (cc.length) lines.push(`Cc: ${cc.join(", ")}`)
  if (attachmentIds.length) {
    lines.push(
      ...(await buildAttachmentSummaryLines(attachmentIds, {
        rlsTx: ctx.tx,
        orgId: ctx.orgId,
        surfaceApp: "tickets",
        replyTargetRootId: ticket?.id ?? params.ticketId,
        resolveOriginRoot: makeTicketOriginRootResolver(ctx),
      })),
    )
  }

  return {
    kind: "tickets.reply",
    ...(ref ? { ref } : {}),
    title: subject,
    subtitle: `Reply to ${toLabel}`,
    lines,
    links: [
      {
        label: "Open ticket",
        app: "tickets",
        entityType: "ticket",
        entityId: ticket?.id ?? params.ticketId,
      },
    ],
  }
}

export async function summarizeTicketNudge(
  params: { ticketId: string; textBody?: string; htmlBody?: string },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const ticket = await loadTicketSummary(ctx, params.ticketId)
  const subject = ticket?.subject ?? "(no subject)"
  const ref = ticket?.handle
  const recipients = await recipientLines(ctx, ticket)
  const toLabel = recipients.toLabel
  const lastMessageAt = formatDateTime(ticket?.last_message_at)

  // No body-preview line — the Message block on the card carries the full
  // outgoing text; see the identical note in summarizeTicketReply.
  return {
    kind: "tickets.nudge",
    ...(ref ? { ref } : {}),
    title: subject,
    subtitle: `Nudge ${toLabel}`,
    lines: [...recipients.lines, ...(lastMessageAt ? [`Last message: ${lastMessageAt}`] : [])],
    links: [
      {
        label: "Open ticket",
        app: "tickets",
        entityType: "ticket",
        entityId: ticket?.id ?? params.ticketId,
      },
    ],
  }
}

/** Shared shape for the two internal-note maintenance summarizers (edit/delete):
 *  loads the target note so the reviewer sees WHICH note is affected, not just an id. */
async function summarizeTicketNoteAction(
  action: "Edit" | "Delete",
  params: { ticketId: string; messageId: string; text?: string },
  ctx: { tx: RlsClient; orgId: string },
): Promise<ApprovalSummary> {
  const ticket = await loadTicketSummary(ctx, params.ticketId)
  const ref = ticket?.handle
  // Keyed by the RESOLVED uuid: a handle bound into the uuid column threw and
  // the card fell back to raw params. No ticket, no note to show.
  const [note] = ticket
    ? extractRows<{ text_body: string | null; sent_at: string | null }>(
        await ctx.tx.execute(drizzleSql`
          SELECT text_body, sent_at FROM ${ticketsRel("messages")}
          WHERE id = ${params.messageId} AND ticket_id = ${ticket.id}
            AND org_id = ${ctx.orgId} AND kind = 'note'
          LIMIT 1
        `),
      )
    : []
  const preview = (note?.text_body ?? "").replace(/\s+/g, " ").trim()
  const lines = [
    ...(note?.sent_at ? [`Note added: ${formatDateTime(note.sent_at) ?? note.sent_at}`] : []),
    `Current text: ${preview ? (preview.length > 200 ? `${preview.slice(0, 200)}…` : preview) : "(not found or empty)"}`,
  ]
  if (action === "Edit" && params.text) {
    const next = params.text.replace(/\s+/g, " ").trim()
    lines.push(`New text: ${next.length > 200 ? `${next.slice(0, 200)}…` : next}`)
  }
  return {
    kind: action === "Edit" ? "tickets.editNote" : "tickets.deleteNote",
    ...(ref ? { ref } : {}),
    title: ticket?.subject ?? "(no subject)",
    subtitle: `${action} internal note`,
    impact: "internal",
    lines,
    links: [
      {
        label: "Open ticket",
        app: "tickets",
        entityType: "ticket",
        entityId: ticket?.id ?? params.ticketId,
      },
    ],
  }
}

export async function summarizeTicketNoteEdit(
  params: { ticketId: string; messageId: string; text: string },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  return summarizeTicketNoteAction("Edit", params, ctx)
}

export async function summarizeTicketNoteDelete(
  params: { ticketId: string; messageId: string },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  return summarizeTicketNoteAction("Delete", params, ctx)
}

export async function summarizeTicketClose(
  params: {
    ticketId: string
    closedReason?: "resolved" | "duplicate" | "spam" | "no_response"
    textBody?: string
    htmlBody?: string
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const ticket = await loadTicketSummary(ctx, params.ticketId)
  const subject = ticket?.subject ?? "(no subject)"
  const ref = ticket?.handle
  const lastMessageAt = formatDateTime(ticket?.last_message_at)
  const lines = [
    ...(lastMessageAt ? [`Last message: ${lastMessageAt}`] : []),
    `Reason: ${params.closedReason ?? "resolved"}`,
  ]
  // Only the METADATA fact of whether an email goes out is a summary line —
  // the actual text (when there is one) belongs solely to the card's Message
  // block, not duplicated here (see the identical note in summarizeTicketReply).
  const bodyPreview =
    params.textBody?.trim() || (params.htmlBody ? htmlToText(params.htmlBody) : "")
  if (!bodyPreview) {
    lines.push("(no email — silent close)")
  } else {
    lines.push(...(await recipientLines(ctx, ticket)).lines)
  }
  return {
    kind: "tickets.close",
    ...(ref ? { ref } : {}),
    title: subject,
    subtitle: "Close",
    // Param-dependent blast radius: a silent close is org-internal and
    // reversible (the manifest's static approvalImpact "internal"), but a
    // close WITH a body emails the customer a closing message — external.
    // Mirrors hasBody() in tools.ts (trimmed text or html body present).
    impact: params.textBody?.trim() || params.htmlBody?.trim() ? "external" : "internal",
    lines,
    links: [
      {
        label: "Open ticket",
        app: "tickets",
        entityType: "ticket",
        entityId: ticket?.id ?? params.ticketId,
      },
    ],
  }
}

const SEGMENT_KEY_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The display names of segment keys that are row ids (an inbox or a category),
 * as `"<by>:<id>" -> name`. A key whose row is gone (or that is no id) has no
 * entry, so the card falls back to the raw key. Audience and team keys are
 * already readable values.
 */
async function segmentKeyLabels(
  ctx: { tx: RlsClient; orgId: string },
  groups: Array<{ by: string; keys: string[] }>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>()
  for (const { by, keys } of groups) {
    const table = by === "inbox" ? "inboxes" : by === "category" ? "categories" : null
    const ids = [...new Set(keys.filter((k) => SEGMENT_KEY_UUID_RE.test(k)))]
    if (!table || ids.length === 0) continue
    const rows = extractRows<{ id: string; name: string | null }>(
      await ctx.tx.execute(drizzleSql`
        SELECT id::text AS id, name
        FROM ${ticketsRel(table)}
        WHERE org_id = ${ctx.orgId}
          AND id IN (${drizzleSql.join(
            ids.map((id) => drizzleSql`${id}::uuid`),
            drizzleSql.raw(", "),
          )})
      `),
    )
    for (const row of rows) {
      const name = row.name?.trim()
      if (name) labels.set(`${by}:${row.id.toLowerCase()}`, name)
    }
  }
  return labels
}

/** The ticket-id prefix change: what it is now, and what ticket 123 will read
 *  as per code. External: the tag in customer email subjects changes too. */
export async function summarizeTicketIdSegmentSet(
  params: { by?: string; codes?: Record<string, string> },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const current = await loadSegmentConfig(ctx.orgId)
  const by = params.by ?? "none"
  const codes = Object.entries(params.codes ?? {})
  const currentCodes = Object.entries(current.codes)
  const labels = await segmentKeyLabels(ctx, [
    ...(by === current.by ? [] : [{ by: current.by, keys: currentCodes.map(([k]) => k) }]),
    { by, keys: [...codes, ...(by === current.by ? currentCodes : [])].map(([k]) => k) },
  ])
  // An id may arrive in either case: matched lowercased, shown as given when gone.
  const label = (b: string, k: string) => labels.get(`${b}:${k.toLowerCase()}`) ?? k
  const describe = (b: string, cs: [string, string][]) =>
    b === "none"
      ? "none"
      : `${b} (${cs.map(([k, c]) => `${label(b, k)} → ${c.trim().toUpperCase()}`).join(", ")})`
  const lines = [
    `Now: ${describe(current.by, currentCodes)}`,
    ...(by === "none"
      ? [`Every ticket displays as ${formatTicketHandle(123)}`]
      : codes.map(
          ([k, c]) => `${label(by, k)}: ${formatTicketHandle(123, c.trim().toUpperCase())}`,
        )),
    "Changes the [#ticket-…] tag in customer email subjects",
  ]
  return {
    kind: "tickets.idSegment.set",
    title: `Ticket id prefix: ${describe(by, codes)}`,
    subtitle: "Settings",
    impact: "external",
    lines,
  }
}

/** Whether a pending ticket reply can be decided from its Home card. Internal:
 *  it changes where the team approves, not what customers receive. */
export async function summarizeTicketApproveFromHomeSet(params: {
  enabled?: boolean
}): Promise<ApprovalSummary> {
  const on = params.enabled === true
  return {
    kind: "tickets.approveFromHome.set",
    title: `Approve ticket replies from Home: ${on ? "on" : "off"}`,
    subtitle: "Settings",
    impact: "internal",
    lines: [
      on
        ? "A pending customer reply can be approved, edited or rejected from its Home card"
        : "A pending customer reply is approved from the ticket; Home only opens the ticket",
    ],
  }
}

/** tickets:apiKeys.create: a new key that can file tickets from outside. */
export async function summarizeTicketApiKeyCreate(params: {
  label?: string
  allowedOrigins?: string[]
}): Promise<ApprovalSummary> {
  const label = typeof params.label === "string" && params.label.trim() ? params.label.trim() : null
  const origins = Array.isArray(params.allowedOrigins)
    ? params.allowedOrigins.filter((o) => typeof o === "string" && o)
    : []
  return {
    kind: "tickets.apiKeys.create",
    title: label ? `Create a tickets API key "${label}"` : "Create a tickets API key",
    subtitle: "Settings",
    impact: "internal",
    lines: [
      "A new key that lets an outside website or service create tickets.",
      origins.length
        ? `Allowed origins: ${origins.join(", ")}`
        : "Allowed origins: any (no restriction)",
    ],
  }
}
