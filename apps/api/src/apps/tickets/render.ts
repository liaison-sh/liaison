// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  htmlToText,
  resolveLocale,
  type ShippedLocale,
  stripTicketHandleTags,
} from "@liaison/shared"
import { SELF_SEND_HEADER, selfSendMarkerFor } from "~/apps/tickets/self-send-marker"
import { applyTeamPlaceholder } from "~/apps/tickets/team-placeholder"
import { sanitizeAgentHtml, sanitizeCustomerHtml } from "~/lib/email/sanitize"
import type { StructuredEmail } from "~/lib/email/types"
import { serverT } from "~/modules/i18n/server-i18n"

export type RenderTicketRow = {
  id: string
  /** The DISPLAY handle (`ticket-B2B-12`, display-handle.ts); the subject tag
   *  and the body reference carry it. */
  handle: string
  subject: string
  reply_token: string
  /** The ticket's tagged language (ISO code, or a display name like
   *  "French" an agent's setLanguage wrote). Decides the email's own copy. */
  language?: string | null
  /** The ticket's team: fills `{{team}}` in the inbox's
   *  sender name and signature. */
  team?: string | null
}

export type RenderInboxRow = {
  id: string
  email_address: string
  from_display_name: string | null
  // Per-inbox ("virtual mailbox") email identity/config (Task 1). All optional
  // for callers/tests that only ever exercised from_display_name — a missing
  // reply_to_email falls back to email_address (unchanged behaviour); the
  // signature is only rendered for ack sends (replies carry it in the body);
  // footer default is handled in orgSettings/renderTicketEmail, not here.
  reply_to_email?: string | null
  signature_html?: string | null
  signature_text?: string | null
  sla_promise_phrase?: string | null
}

export type RenderOrgSettings = {
  name: string
  /** kernel.organizations.default_locale: the email language when the
   *  ticket carries none. */
  defaultLocale?: string | null
  /** kernel.organizations.timezone, for the quoted messages' dates. */
  timezone?: string | null
  tickets?: {
    emailTemplate?: {
      headerName?: string
      footerText?: string
      accentColor?: string
    }
  }
}

export type RenderPriorMessage = {
  externalMessageId: string | null
  /** Message direction — the reply recipient may only ever be taken from an
   *  inbound message. Outbound rows now persist OUR from identity (the inbox
   *  address), so a from.email-only pick would address the reply to ourselves. */
  kind: "inbound" | "outbound" | "note"
  htmlBody: string | null
  textBody: string | null
  sentAt: string
  from: { email: string; name: string | null }
}

export type RenderOptions = {
  kind: "reply" | "nudge" | "close" | "ack"
  /** The ticket's stored requester: the `To` of the email. When absent, the
   *  sender of the EARLIEST inbound message (who opened the ticket) is used,
   *  never the newest sender. */
  requester?: string | null
  /** Further addresses to copy, from the ticket's stored participants. */
  participants?: string[]
  /** Acknowledgement only: echo the request's subject. False when nobody has
   *  shown they own the recipient address (a web form): the ack then carries a
   *  fixed subject and nothing the submitter wrote. */
  echoSubject?: boolean
}

function buildReplyToWithToken(inbox: RenderInboxRow, token: string): string {
  // The plus-token reply-to is built on a BASE address, not necessarily the
  // inbox's own email_address: Task 1 makes that base configurable per inbox
  // (reply_to_email, e.g. an API inbox whose replies go out from support@
  // rather than its own address). Falls back to email_address, unchanged.
  const base = inbox.reply_to_email?.trim() || inbox.email_address
  const [local, domain] = base.split("@")
  if (!local || !domain) return base
  return `${local}+tkt_${token}@${domain}`
}

/** A subject with URLs and bare domains-with-paths removed, bounded in length. */
export function subjectWithoutLinks(subject: string): string {
  const cleaned = subject
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
  return (cleaned || "Your request").slice(0, 120)
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Turn a plain-text signature (what a human types in the tickets settings
 * signature box) into safe HTML: escape the text and preserve line breaks.
 * Used for the ack's inbox signature and for deriving the HTML half of the
 * signature injected into reply drafts. Returns "" for an empty/whitespace-only
 * signature so the caller can treat it as "no signature".
 */
export function plainTextToHtml(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) return ""
  return trimmed
    .split(/\r?\n/)
    .map((line) => htmlEscape(line))
    .join("<br>")
}

// Language display names an agent's tickets:setLanguage may have written.
const LANGUAGE_NAMES: Record<string, string> = {
  english: "en",
  anglais: "en",
  french: "fr",
  francais: "fr",
  français: "fr",
}

/**
 * The language of everything a customer reads in a ticket email: the
 * ticket's own language, else the org default locale, else English. The
 * body is whatever the agent wrote; the chrome around it (reference line,
 * reply hint, quote header, acknowledgement) follows this, so one email
 * never mixes two languages.
 */
export function ticketEmailLocale(
  ticketLanguage: string | null | undefined,
  orgDefaultLocale: string | null | undefined,
): ShippedLocale {
  const named = ticketLanguage ? LANGUAGE_NAMES[ticketLanguage.trim().toLowerCase()] : undefined
  return resolveLocale(named ?? ticketLanguage, orgDefaultLocale)
}

function formatSentAt(sentAt: string, locale: ShippedLocale, timeZone: string | null | undefined) {
  const d = new Date(sentAt)
  if (Number.isNaN(d.getTime())) return sentAt
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: timeZone || "UTC",
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(d)
  }
}

function buildQuote(
  prior: RenderPriorMessage[],
  locale: ShippedLocale,
  timeZone: string | null | undefined,
): string {
  if (prior.length === 0) return ""
  const blocks = prior
    .slice(0, 5)
    .map((m) => {
      const fromLabel = htmlEscape(m.from.name ?? m.from.email)
      const sanitized = sanitizeCustomerHtml(m.htmlBody ?? `<p>${htmlEscape(m.textBody ?? "")}</p>`)
      const date = htmlEscape(formatSentAt(m.sentAt, locale, timeZone))
      const header = serverT(locale, "tickets.email.quoteHeader", { date, name: fromLabel })
      return `<blockquote style="border-left:3px solid #ccc;margin:1em 0;padding-left:1em">
<div style="color:#666;font-size:0.9em">${header}</div>
${sanitized}
</blockquote>`
    })
    .join("\n")
  return blocks
}

/** Whether `text` already carries a `[#ticket-...]` tag naming this ticket. */
function carriesTicketTag(text: string, handle: string): boolean {
  if (text.toLowerCase().includes(`[#${handle.toLowerCase()}]`)) return true
  return stripTicketHandleTags(text, handle) !== text.trimEnd()
}

export async function renderTicketEmail(
  ticket: RenderTicketRow,
  bodyParts: { htmlBody: string; textBody?: string },
  orgSettings: RenderOrgSettings,
  inbox: RenderInboxRow,
  priorMessages: RenderPriorMessage[],
  opts: RenderOptions,
): Promise<StructuredEmail> {
  const sanitizedBody = sanitizeAgentHtml(bodyParts.htmlBody)
  const locale = ticketEmailLocale(ticket.language, orgSettings.defaultLocale)
  const accentColor = orgSettings.tickets?.emailTemplate?.accentColor ?? "#0066cc"
  const headerName = orgSettings.tickets?.emailTemplate?.headerName ?? orgSettings.name
  // WYSIWYG contract: replies/nudges/closes carry their signature INSIDE the
  // composed body (prefilled in the composer, injected into agent drafts at
  // draft time) so what the sender saw is byte-for-byte what ships. Only the
  // ack — a config-driven system send nobody composes — still renders the
  // inbox's configured signature here.
  const signatureSource =
    opts.kind === "ack"
      ? applyTeamPlaceholder(inbox.signature_html?.trim() ?? "", ticket.team, "html") ||
        (inbox.signature_text
          ? plainTextToHtml(applyTeamPlaceholder(inbox.signature_text, ticket.team))
          : "")
      : ""
  const signature = signatureSource ? sanitizeAgentHtml(signatureSource) : ""
  // The From display name is the mailbox's configured identity, never the
  // individual agent's personal name: a support@ send must not out the human
  // behind it (customers reply "Hi <first name>" off the From header).
  // Fallback is the org's email-template header name, then the org name.
  const namedFrom = applyTeamPlaceholder(inbox.from_display_name, ticket.team)
  // A name that was only the placeholder, on a ticket with no team, is empty:
  // fall back like an unset name rather than send a blank From name.
  const fromName =
    namedFrom === "" && inbox.from_display_name ? headerName : (namedFrom ?? headerName)
  // Footer default: an unset org footer never renders blank. It falls back to
  // the mailbox's own signature (plain text, since the footer is a
  // plain-text-styled strip), else the same sender identity as the From name,
  // so every outbound email carries this org's own identity in its footer.
  const footerText =
    orgSettings.tickets?.emailTemplate?.footerText?.trim() ||
    applyTeamPlaceholder(inbox.signature_text?.trim(), ticket.team) ||
    fromName

  const subjectPrefix = opts.kind === "reply" ? "Re: " : opts.kind === "close" ? "" : ""
  // An acknowledgement echoes the request's subject without any link in it, and
  // only to a sender whose address the receiving provider authenticated; one to
  // an address nobody has shown they own (a web form) carries a fixed subject.
  const ticketSubject =
    opts.kind !== "ack"
      ? ticket.subject
      : opts.echoSubject === false
        ? serverT(locale, "tickets.email.ackSubject")
        : subjectWithoutLinks(ticket.subject)
  const baseSubject = ticketSubject.startsWith("Re: ")
    ? ticketSubject
    : `${subjectPrefix}${ticketSubject}`
  // `ticket.handle` is the DISPLAY handle (`ticket-B2B-12`). Any tag already
  // naming the same ticket number (an older `[#ticket-12]`, a stale segment)
  // is replaced, never doubled; inbound still threads every form by number.
  const subjectWithHandle = [
    stripTicketHandleTags(baseSubject, ticket.handle),
    `[#${ticket.handle}]`,
  ]
    .filter(Boolean)
    .join(" ")

  // The addressees: the stored requester and participants. Earlier messages are
  // quoted only to them, and only the ones they could already see: our replies
  // and what the requester or a participant wrote. A stranger's message that
  // reached the thread, and internal notes, are never echoed.
  const requesterAddr = (
    opts.requester ??
    [...priorMessages].reverse().find((m) => m.kind === "inbound" && m.from.email)?.from.email ??
    ""
  )
    .trim()
    .toLowerCase()
  const participantAddrs = (opts.participants ?? []).map((p) => p.trim().toLowerCase())
  const isParty = (email: string) =>
    email !== "" && (email === requesterAddr || participantAddrs.includes(email))
  const quotable = priorMessages.filter(
    (m) =>
      m.kind === "outbound" || (m.kind === "inbound" && isParty(m.from.email.trim().toLowerCase())),
  )
  // An acknowledgement is a fixed template: it never echoes what was received.
  const quote = opts.kind === "ack" ? "" : buildQuote(quotable, locale, orgSettings.timezone)

  // Reply-only affordances (Task 3): a visible reply-by-email hint, plus the
  // ticket reference surfaced in the BODY (not just the subject line) so it
  // reads clearly even when a mail client hides/truncates the subject.
  const replyHint =
    opts.kind === "reply"
      ? `<p style="margin:0 0 1em;color:#555">${htmlEscape(serverT(locale, "tickets.email.replyHint"))}</p>`
      : ""
  const ticketRef = htmlEscape(
    serverT(locale, "tickets.email.ticketReference", { handle: ticket.handle }),
  )
  const ticketRefLine = `<div style="color:#888;font-size:0.85em">${ticketRef}</div>`

  const html = [
    `<div style="font-family:system-ui,Helvetica,Arial,sans-serif">`,
    `<div style="border-bottom:2px solid ${accentColor};padding:0.5em 0;font-weight:bold">${htmlEscape(headerName)}</div>`,
    ticketRefLine,
    replyHint,
    `<div style="margin:1em 0">${sanitizedBody}</div>`,
    signature ? `<div style="margin-top:1.5em;color:#444">${signature}</div>` : "",
    quote ? `<hr style="margin:1.5em 0;border:0;border-top:1px solid #eee" />${quote}` : "",
    `<div style="margin-top:1.5em;color:#888;font-size:0.85em">${htmlEscape(footerText)}<br />${ticketRef}</div>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join("\n")

  // An agent-supplied plain-text body ships as the text/plain part; it carries
  // the ticket reference too (the HTML part always does), once: a body that
  // already names this ticket, in any form of its id, is left as written.
  const agentText = bodyParts.textBody?.trim()
  const plainRef = serverT(locale, "tickets.email.ticketReference", { handle: ticket.handle })
  const text = agentText
    ? carriesTicketTag(agentText, ticket.handle)
      ? agentText
      : `${agentText}\n\n${plainRef}`
    : htmlToText(html)

  const lastExternalId = quotable.find((m) => m.externalMessageId)?.externalMessageId ?? null
  const references = quotable
    .map((m) => m.externalMessageId)
    .filter((id): id is string => Boolean(id))

  const replyToAddr = buildReplyToWithToken(inbox, ticket.reply_token)

  // The `To:` recipient must be a real customer address, i.e. the most recent
  // INBOUND message's from. Two failure modes ruled this out being anything
  // looser: `priorMessages[0]` (most recent of any kind) could be a system send
  // with an empty `from` — the provider rejected the resulting empty `To:` with
  // a 400; and "most recent message with a from.email" broke once outbound rows
  // started persisting OUR from identity (the inbox address) — a reply issued
  // right after an ack/reply would address the customer reply to ourselves.
  // Web-form tickets still resolve correctly here: their first inbound message
  // has an empty `externalMessageId` (nothing to thread against yet) but always
  // has a real `from.email`.
  // Now the ticket's stored requester (see `requesterAddr`), with the stored
  // participants copied. A newer message from anyone else changes neither.
  const to = requesterAddr ? [{ email: requesterAddr }] : []
  const cc = participantAddrs.filter((p) => p && p !== requesterAddr).map((email) => ({ email }))

  return {
    from: { email: inbox.email_address, name: fromName },
    replyTo: { email: replyToAddr, name: fromName },
    to,
    cc,
    subject: subjectWithHandle,
    html,
    text,
    headers: {
      messageId: `<tkt-${ticket.id}-${Date.now()}@${inbox.email_address.split("@")[1]}>`,
      inReplyTo: lastExternalId,
      references,
      // Lets the mailbox sync recognise this message when it sees it again as a
      // Sent copy. Providers rewrite `Message-ID` but preserve custom `X-`
      // headers, so this survives where the message id does not.
      // See self-send-marker.ts.
      extra: { [SELF_SEND_HEADER]: selfSendMarkerFor(ticket.id) },
    },
  }
}
