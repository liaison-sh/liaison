// SPDX-License-Identifier: FSL-1.1-ALv2
import addressparser from "nodemailer/lib/addressparser"
import { parseRfc2822 } from "./rfc2822"
import type { EmailAddress, ParsedAttachment, ParsedEmail } from "./types"

export type GmailHeader = { name: string; value: string }
export type GmailMessagePayload = {
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { data?: string; size?: number; attachmentId?: string }
  parts?: GmailMessagePayload[]
}

export type GmailMessageResource = {
  id: string
  threadId?: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailMessagePayload
}

/** Convert a value to an ISO timestamp, returning `undefined` for anything
 *  that does not parse to a valid date. A malformed `Date:` header (or a
 *  garbage `internalDate`) must never throw: an unguarded
 *  `new Date(x).toISOString()` raises `RangeError` on an invalid date, which —
 *  in the per-message sync loops — would abort the whole batch and turn one
 *  poison-pill message into a permanently wedged mailbox. */
function safeIsoDate(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const date = new Date(value)
  const ms = date.getTime()
  if (Number.isNaN(ms)) return undefined
  return date.toISOString()
}

function decodeBase64Url(input: string): string {
  if (!input) return ""
  const padded = input.replace(/-/g, "+").replace(/_/g, "/")
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  try {
    return Buffer.from(padded + padding, "base64").toString("utf-8")
  } catch {
    return ""
  }
}

/** Parse a single address string using the RFC 5322-compliant nodemailer parser.
 *  Falls back gracefully when the input is bare (no angle brackets). */
function parseEmailAddress(raw: string): EmailAddress | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const [addr] = addressparser(trimmed, { flatten: true })
  if (!addr?.address) return undefined
  return {
    name: addr.name || undefined,
    email: addr.address.toLowerCase(),
  }
}

/** Parse an RFC 5322 address-list header value (To/Cc/Bcc).
 *  Uses the nodemailer addressparser which correctly handles quoted display
 *  names containing commas (e.g. `"Smith, Alice" <alice@example.com>`). */
function parseEmailAddressList(raw: string): EmailAddress[] {
  if (!raw.trim()) return []
  return addressparser(raw, { flatten: true })
    .filter((addr) => Boolean(addr.address))
    .map((addr) => ({
      name: addr.name || undefined,
      email: addr.address.toLowerCase(),
    }))
}

/**
 * The message's own text and HTML, read from the Gmail MIME tree.
 *
 * Every text part used to count, the first one winning: a `.html` file
 * attached to a plain-text message, or the HTML of a forwarded `.eml`, became
 * the body, and an HTML body split around an inline attachment (Apple Mail)
 * kept only its opening fragment. A part carrying a filename or an
 * `attachment` disposition is a file, a `message/rfc822` part is a message of
 * its own, the alternatives of a `multipart/alternative` are not added
 * together, and the fragments of any other multipart are joined in order.
 * A named text part with no `attachment` disposition is still the body when
 * the message has no unnamed one (a body shipped as an inline
 * `text/plain; name="message.txt"`); it never joins a message that has its own.
 * The mail app's sandboxed Gmail ingest mirrors these rules.
 */
function extractBody(part: GmailMessagePayload | undefined): { text: string; html: string } {
  const strict = extractBodyParts(part, false)
  if (strict.text || strict.html) return strict
  return extractBodyParts(part, true)
}

function extractBodyParts(
  part: GmailMessagePayload | undefined,
  allowNamedInline: boolean,
): { text: string; html: string } {
  const out = { text: "", html: "" }
  if (!part) return out
  const mime = (part.mimeType ?? "").toLowerCase()
  if (mime === "message/rfc822") return out
  if (part.parts && part.parts.length > 0) {
    const alternative = mime === "multipart/alternative"
    for (const sub of part.parts) {
      const body = extractBodyParts(sub, allowNamedInline)
      if (alternative) {
        if (!out.text) out.text = body.text
        if (!out.html) out.html = body.html
      } else {
        out.text += body.text
        out.html += body.html
      }
    }
    return out
  }
  if (!part.body?.data) return out
  const disposition =
    part.headers?.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? ""
  if (disposition.toLowerCase().startsWith("attachment")) return out
  if (part.filename && !allowNamedInline) return out
  // A single-part message may omit mimeType; it is plain text by default.
  const leafMime = mime || "text/plain"
  if (leafMime === "text/plain") out.text = decodeBase64Url(part.body.data)
  else if (leafMime === "text/html") out.html = decodeBase64Url(part.body.data)
  return out
}

/** Walk the Gmail MIME tree and collect every non-text part that is an
 *  attachment (has a filename or carries a server-side `attachmentId`). Inline
 *  bytes (`body.data`) are decoded eagerly; large parts expose only an
 *  `attachmentId` so the sync layer can fetch the bytes via the Gmail
 *  attachments API. Without this, real inbound attachments were silently
 *  dropped because nothing ever populated `ParsedEmail.attachments`. */
function collectGmailAttachments(
  part: GmailMessagePayload | undefined,
  out: ParsedAttachment[],
): void {
  if (!part) return
  const mime = part.mimeType ?? ""
  const isContainer = mime.startsWith("multipart/")
  const headers: Record<string, string> = {}
  for (const h of part.headers ?? []) headers[String(h.name).toLowerCase()] = h.value
  const rawContentId = headers["content-id"]
  const contentDisposition = (headers["content-disposition"] ?? "").toLowerCase()
  const hasFilename = Boolean(part.filename && part.filename.length > 0)
  const hasAttachmentRef = Boolean(part.body?.attachmentId)
  // A leaf is an attachment when it carries a filename or a server-side
  // attachment id, OR it is explicitly dispositioned as one. Plain inline
  // text/* body parts (no filename) are not attachments.
  const isAttachment =
    !isContainer && (hasFilename || hasAttachmentRef || contentDisposition.startsWith("attachment"))

  if (isAttachment) {
    const disposition: "inline" | "attachment" =
      contentDisposition.startsWith("inline") || (rawContentId && !contentDisposition)
        ? "inline"
        : "attachment"
    out.push({
      filename: part.filename || "attachment",
      mimeType: mime || "application/octet-stream",
      sizeBytes: part.body?.size,
      bytesBase64: part.body?.data ? part.body.data : undefined,
      providerAttachmentId: part.body?.attachmentId,
      disposition,
      contentId: rawContentId ? rawContentId.replace(/^<|>$/g, "") : undefined,
      originalContentId: rawContentId,
    })
  }

  for (const sub of part.parts ?? []) collectGmailAttachments(sub, out)
}

export function parseGmailPayload(msg: GmailMessageResource): ParsedEmail {
  const headers: Record<string, string> = {}
  for (const h of msg.payload?.headers ?? []) {
    headers[String(h.name).toLowerCase()] = h.value
  }
  const authenticationResults: string[] = []
  const deliveredTo: string[] = []
  for (const h of msg.payload?.headers ?? []) {
    const name = String(h.name).toLowerCase()
    if (name === "authentication-results") authenticationResults.push(String(h.value))
    if (name === "delivered-to") deliveredTo.push(String(h.value))
  }
  const { text: textBody, html: htmlBody } = extractBody(msg.payload)

  const refs = (headers.references ?? "").split(/\s+/).filter(Boolean)

  const attachments: ParsedAttachment[] = []
  collectGmailAttachments(msg.payload, attachments)

  return {
    messageId: headers["message-id"] ?? `<${msg.id}@mail.gmail.com>`,
    from: parseEmailAddress(headers.from ?? ""),
    to: parseEmailAddressList(headers.to ?? ""),
    cc: parseEmailAddressList(headers.cc ?? ""),
    subject: headers.subject ?? "",
    textBody: textBody || undefined,
    htmlBody: htmlBody || undefined,
    inReplyTo: headers["in-reply-to"] ?? null,
    references: refs.length > 0 ? refs : undefined,
    sentAt:
      safeIsoDate(headers.date) ??
      (msg.internalDate ? safeIsoDate(Number(msg.internalDate)) : undefined),
    headers,
    authenticationResults: authenticationResults.length > 0 ? authenticationResults : undefined,
    deliveredTo: deliveredTo.length > 0 ? deliveredTo : undefined,
    labelIds: msg.labelIds?.length ? msg.labelIds : undefined,
    receivedVia: "gmail_api",
    attachments: attachments.length > 0 ? attachments : undefined,
  }
}

export async function parseImapMessage(blob: string): Promise<ParsedEmail> {
  return parseRfc2822(blob)
}
