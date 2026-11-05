// SPDX-License-Identifier: FSL-1.1-ALv2
export type EmailAddress = { email: string; name?: string }

/** An attachment on an outbound email — raw bytes carried base64-encoded. */
export type OutboundEmailAttachment = {
  filename: string
  mimeType: string
  /** Raw bytes, base64-encoded. */
  content: string
  /** Default `attachment`. `inline` requires `contentId` for `cid:` references. */
  disposition?: "attachment" | "inline"
  contentId?: string
}

export type StructuredEmail = {
  from: EmailAddress | string
  replyTo?: EmailAddress | string
  to: Array<EmailAddress | string>
  cc?: Array<EmailAddress | string>
  bcc?: Array<EmailAddress | string>
  subject: string
  html?: string
  text?: string
  /** Outbound attachments — emitted as `multipart/mixed` parts by `toRfc2822`. */
  attachments?: OutboundEmailAttachment[]
  headers?: {
    messageId?: string
    inReplyTo?: string | null
    references?: string[]
    extra?: Record<string, string>
  }
}

export type ParsedAttachment = {
  filename: string
  mimeType: string
  sizeBytes?: number
  /** Raw bytes base64-encoded. Required for IMAP/MIME parsers; Gmail parsers
   *  may instead set `providerAttachmentId` and let the sync code fetch the
   *  bytes via the Gmail attachments API. */
  bytesBase64?: string
  /** Gmail-style server-side attachment id used to fetch raw bytes later. */
  providerAttachmentId?: string
  disposition: "inline" | "attachment"
  /** `Content-ID` header value, stripped of angle brackets. Set for inline
   *  parts referenced from HTML via `cid:` URIs. */
  contentId?: string
  /** Raw, original `Content-ID` value including the brackets — preserved so
   *  CID rewriting can match either bracketed or bare values consistently. */
  originalContentId?: string
}

export type ParsedEmail = {
  messageId?: string
  from?: EmailAddress
  to?: EmailAddress[]
  cc?: EmailAddress[]
  subject?: string
  textBody?: string
  htmlBody?: string
  inReplyTo?: string | null
  references?: string[]
  sentAt?: string
  receivedAt?: string
  headers?: Record<string, string | string[]>
  /** Every `Authentication-Results` header value, topmost (the receiving
   *  provider's own) first. See `sender-auth.ts`. */
  authenticationResults?: string[]
  /** Every `Delivered-To` header value, topmost first. Only the first (added by
   *  the receiving server) says where the provider delivered the message. */
  deliveredTo?: string[]
  /** Provider labels (Gmail `labelIds`, for example `SENT`, `INBOX`). */
  labelIds?: string[]
  /** How the message reached us. Decides which `Authentication-Results`
   *  authserv-ids are trusted (see `sender-auth.ts`). Set by the parser only. */
  receivedVia?: "gmail_api" | "imap"
  raw?: string
  attachments?: ParsedAttachment[]
}
