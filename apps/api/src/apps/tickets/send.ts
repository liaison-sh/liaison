// SPDX-License-Identifier: FSL-1.1-ALv2
import { GmailSendError, sendViaGmail } from "~/lib/email/gmail-send"
import { toRfc2822 } from "~/lib/email/rfc2822"
import type { StructuredEmail } from "~/lib/email/types"

export type OutboundErrorReason = "preflight_failed" | "ambiguous" | "rejected" | "auth_failed"

export class OutboundError extends Error {
  readonly reason: OutboundErrorReason
  readonly providerCode?: string
  readonly retryable: boolean

  constructor(
    reason: OutboundErrorReason,
    message: string,
    opts?: { providerCode?: string; retryable?: boolean },
  ) {
    super(message)
    this.reason = reason
    this.providerCode = opts?.providerCode
    this.retryable = opts?.retryable ?? false
  }
}

export type OutboundResult = {
  externalMessageId: string | null
  externalThreadId?: string
  deliveryState: "delivered" | "ambiguous"
  rfc2822: string
}

export type OutboundProvider =
  | {
      kind: "smtp"
      smtpSend: (
        accountEmail: string,
        message: unknown,
      ) => Promise<{
        messageId: string
        deliveryState?: "delivered" | "ambiguous" | "rejected" | "unknown"
      }>
    }
  | {
      kind: "gmail"
      ctx: {
        connections_getToken(name: "gmail", email: string): Promise<string>
        fetch?: typeof fetch
      }
    }

export type SendOutboundOptions = {
  accountEmail: string
  externalThreadId?: string
  preflight?: () => Promise<void>
  onDispatch?: () => void
}

export async function sendOutbound(
  email: StructuredEmail,
  provider: OutboundProvider,
  opts: SendOutboundOptions,
): Promise<OutboundResult> {
  if (opts.preflight) {
    try {
      await opts.preflight()
    } catch (err) {
      throw new OutboundError("preflight_failed", (err as Error).message)
    }
  }

  const rfc2822 = toRfc2822(email)
  opts.onDispatch?.()

  if (provider.kind === "gmail") {
    try {
      const r = await sendViaGmail(provider.ctx, opts.accountEmail, rfc2822, opts.externalThreadId)
      return {
        // Prefer the Message-ID Gmail actually DELIVERED. Gmail rewrites the one
        // we render, so persisting ours made the mailbox sync's dedupe (an exact
        // `external_message_id` match) miss every time and store our own Sent
        // copy as a duplicate outbound message. Falls back to the synthetic id
        // when the read-back is unavailable; the ingest body-hash dedupe covers
        // that case. See GmailSendResult.rfc822MessageId.
        externalMessageId: r.rfc822MessageId ?? email.headers?.messageId ?? null,
        externalThreadId: r.threadId,
        deliveryState: "delivered",
        rfc2822,
      }
    } catch (err) {
      if (err instanceof GmailSendError) {
        if (err.providerRejected) {
          throw new OutboundError("rejected", err.message, { providerCode: err.code })
        }
        throw new OutboundError("preflight_failed", err.message, {
          providerCode: err.code,
          retryable: !err.providerRejected,
        })
      }
      throw err
    }
  }

  // SMTP path
  // The smtp-bridge accepts `inReplyTo` and `references` as top-level fields
  // (see SmtpSendParams in smtp-bridge.ts). Earlier code passed them nested
  // under `headers`, which was silently dropped — outbound emails went out
  // without threading headers, breaking customer-side conversation grouping.
  try {
    const send = await provider.smtpSend(opts.accountEmail, {
      from: typeof email.from === "string" ? email.from : email.from.email,
      to: email.to.map((a) => (typeof a === "string" ? a : a.email)),
      cc: (email.cc ?? []).map((a) => (typeof a === "string" ? a : a.email)),
      bcc: (email.bcc ?? []).map((a) => (typeof a === "string" ? a : a.email)),
      replyTo: email.replyTo,
      subject: email.subject,
      htmlBody: email.html ?? "",
      textBody: email.text ?? "",
      messageId: email.headers?.messageId,
      inReplyTo: email.headers?.inReplyTo,
      references: email.headers?.references,
      // Forward attachments to the nodemailer transport. The SMTP path builds
      // its MIME from these structured params (not from `rfc2822`), so without
      // this map an attachment-bearing reply would silently ship without its
      // files. nodemailer owns Content-Disposition / RFC 2231 encoding here.
      attachments: (email.attachments ?? []).map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        bytesBase64: a.content,
        disposition: a.disposition,
        contentId: a.contentId,
      })),
      rfc2822,
    })
    if (send.deliveryState === "ambiguous" || send.deliveryState === "unknown") {
      throw new OutboundError("ambiguous", "ambiguous-after-DATA")
    }
    if (send.deliveryState === "rejected") {
      throw new OutboundError("rejected", "smtp-rejected")
    }
    return {
      externalMessageId: send.messageId ?? email.headers?.messageId ?? null,
      deliveryState: "delivered",
      rfc2822,
    }
  } catch (err) {
    if (err instanceof OutboundError) throw err
    const code = (err as { code?: string }).code
    const deliveryState = (err as { deliveryState?: string }).deliveryState
    if (deliveryState === "unknown") {
      throw new OutboundError("ambiguous", (err as Error).message)
    }
    if (deliveryState === "rejected") {
      throw new OutboundError("rejected", (err as Error).message)
    }
    if (code === "EAUTH") {
      throw new OutboundError("auth_failed", (err as Error).message)
    }
    throw new OutboundError("preflight_failed", (err as Error).message)
  }
}
