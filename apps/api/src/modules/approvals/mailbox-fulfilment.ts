// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint Task 9.8 and 9.9, the approval half. Spec sections 5.4 and 5.3b.
//
// WHY THIS EXISTS, AND WHY IT IS NOT `approval_update_payload`.
//
// `mail:reply`, `mail:forward` and `mail:compose` are gated. The agent's call
// returns a pending approval and the handler runs LATER, from
// `modules/approvals/decide.ts` through `modules/apps/run-approved-handler.ts`.
// That path never enters the tool bridge's `execute` wrapper, so the Phase 9
// plaintext broker cannot reach it: there is no turn to pause and no socket to
// ask over. The browser has to supply the plaintext as part of APPROVING.
//
// There is an obvious-looking seam for that, `approval_update_payload`, and it
// is the wrong one. An EDIT of a sealed draft changes what is stored: edit.ts
// seals the new content again (`resealMailApprovalEdit`) and keeps only
// ciphertext and a content-free diff. Supplying the draft for EXECUTION is a
// different act, and routing it through the edit path would re-seal and
// re-store a draft nobody changed, reset sign-offs and post an "Edited" note on
// every approve.
//
// So the split is: PHASE 6 DECIDES WHAT IS STORED, THIS FILE DECIDES WHAT IS
// EXECUTED. The client posts the decrypted material in the body of
// `POST /api/approvals/:id/decide`; this pure function merges it onto the sealed
// payload in memory, microseconds before the handler runs; nothing writes it
// anywhere. The row on disk stays exactly as Phase 6 sealed it, and re-reading
// the approval after execution shows ciphertext, not the sent text.
//
// REFUSING IS THE DEFAULT. Every failure here throws. A gated send that reaches
// its handler with an empty body sends a blank email and reports success, which
// is the silent data loss this whole task exists to prevent.

/** One MiB, matching the per-message plaintext ceiling the seal service enforces. */
export const MAILBOX_FULFILMENT_MAX_TEXT_BYTES = 1_048_576
/** Mirrors the client responder's per-request message cap. */
export const MAILBOX_FULFILMENT_MAX_QUOTED_MESSAGES = 25
export const MAILBOX_FULFILMENT_MAX_ATTACHMENTS = 25
/** Whole-request ceiling on decoded attachment bytes. */
export const MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/**
 * The HTTP body cap of `POST /api/approvals/:id/decide`. The fulfilment travels
 * there, so the cap admits the attachment ceiling once base64 encoded (4/3)
 * plus room for the draft, the quotes and the JSON around them. The generic
 * 1 MiB API cap refused every sealed send carrying a real attachment (413).
 */
export const APPROVAL_DECIDE_BODY_MAX_BYTES =
  Math.ceil(MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES / 3) * 4 + 8 * 1024 * 1024

/**
 * The keys `sealMailApprovalPayload` adds. They are stripped before execution:
 * the handler has no use for them, and `assertKnownParams` rejects any parameter
 * the manifest does not declare, so passing them through would 400 the send.
 */
export const SEALED_PAYLOAD_KEYS = [
  "mailboxSealed",
  "bodyCiphertext",
  "htmlBodyCiphertext",
  "noteCiphertext",
  "subjectCiphertext",
  "contentKeyWrapped",
  "contentKeyEpk",
  "encKeyId",
  "encVersion",
  "subjectHash",
  "byteLength",
  "recipientCount",
  "mailboxQuoteMessageIds",
] as const

/** The gated mail sends whose payload Phase 6 seals. Kept in step with
 *  `MAIL_APPROVAL_SEALED_TOOLS` in `modules/mailbox-crypto/approval-payload.ts`. */
export const MAILBOX_FULFILLABLE_TOOLS: ReadonlySet<string> = new Set([
  "mail:reply",
  "mail:forward",
  "mail:compose",
  "mail:composeForApp",
])

export type MailboxFulfilmentErrorCode =
  | "not_a_mail_send"
  | "payload_not_sealed"
  | "fulfilment_required"
  | "malformed"
  | "too_large"

export class MailboxFulfilmentError extends Error {
  readonly code: MailboxFulfilmentErrorCode
  constructor(code: MailboxFulfilmentErrorCode, message: string) {
    super(message)
    this.name = "MailboxFulfilmentError"
    this.code = code
  }
}

export interface MailboxFulfilment {
  /** The decrypted draft the approver actually read on the card. */
  draft?: { subject?: string; textBody?: string; htmlBody?: string; note?: string }
  /** Task 9.8: the assembled quote and resolved subject, per quoted message id. */
  quote?: Record<string, { quotedBody?: string; resolvedSubject?: string }>
  /** Task 9.9: base64 plaintext bytes, per staged attachment file id. */
  attachments?: Record<string, string>
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function requireBoundedText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new MailboxFulfilmentError("malformed", `${label} must be a string`)
  }
  if (utf8Bytes(value) > MAILBOX_FULFILMENT_MAX_TEXT_BYTES) {
    throw new MailboxFulfilmentError(
      "too_large",
      `${label} is larger than the ${MAILBOX_FULFILMENT_MAX_TEXT_BYTES} byte ceiling`,
    )
  }
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Decoded size of a base64 string, without decoding it. */
function base64Bytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor((value.length * 3) / 4) - padding
}

/**
 * Validate an untrusted request body into a `MailboxFulfilment`.
 *
 * Deliberately hand-written rather than a zod schema on the route: this runs on
 * the decide path, where an unrecognised key must be a REFUSAL and not a silent
 * strip, so the client learns its fulfilment did not take effect instead of the
 * send going out with a blank body.
 */
export function parseMailboxFulfilment(raw: unknown): MailboxFulfilment | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!isPlainObject(raw)) {
    throw new MailboxFulfilmentError("malformed", "mailboxFulfilment must be an object")
  }
  const out: MailboxFulfilment = {}
  for (const key of Object.keys(raw)) {
    if (key !== "draft" && key !== "quote" && key !== "attachments") {
      throw new MailboxFulfilmentError("malformed", `mailboxFulfilment.${key} is not a known field`)
    }
  }
  if (raw.draft !== undefined) {
    if (!isPlainObject(raw.draft)) {
      throw new MailboxFulfilmentError("malformed", "mailboxFulfilment.draft must be an object")
    }
    const draft: NonNullable<MailboxFulfilment["draft"]> = {}
    for (const [key, value] of Object.entries(raw.draft)) {
      if (key !== "subject" && key !== "textBody" && key !== "htmlBody" && key !== "note") {
        throw new MailboxFulfilmentError("malformed", `mailboxFulfilment.draft.${key} is unknown`)
      }
      draft[key] = requireBoundedText(value, `mailboxFulfilment.draft.${key}`)
    }
    out.draft = draft
  }
  if (raw.quote !== undefined) {
    if (!isPlainObject(raw.quote)) {
      throw new MailboxFulfilmentError("malformed", "mailboxFulfilment.quote must be an object")
    }
    const quote: NonNullable<MailboxFulfilment["quote"]> = {}
    for (const [messageId, entry] of Object.entries(raw.quote)) {
      if (!isPlainObject(entry)) {
        throw new MailboxFulfilmentError("malformed", `mailboxFulfilment.quote.${messageId} shape`)
      }
      const parsed: { quotedBody?: string; resolvedSubject?: string } = {}
      for (const [key, value] of Object.entries(entry)) {
        if (key !== "quotedBody" && key !== "resolvedSubject") {
          throw new MailboxFulfilmentError(
            "malformed",
            `mailboxFulfilment.quote.${messageId}.${key} is unknown`,
          )
        }
        parsed[key] = requireBoundedText(value, `mailboxFulfilment.quote.${messageId}.${key}`)
      }
      quote[messageId] = parsed
    }
    out.quote = quote
  }
  if (raw.attachments !== undefined) {
    if (!isPlainObject(raw.attachments)) {
      throw new MailboxFulfilmentError("malformed", "mailboxFulfilment.attachments must be object")
    }
    const attachments: Record<string, string> = {}
    for (const [fileId, value] of Object.entries(raw.attachments)) {
      if (typeof value !== "string") {
        throw new MailboxFulfilmentError(
          "malformed",
          `mailboxFulfilment.attachments.${fileId} must be a base64 string`,
        )
      }
      attachments[fileId] = value
    }
    out.attachments = attachments
  }
  return out
}

export interface ApplyMailboxFulfilmentInput {
  /** Canonical `app:tool`. */
  toolName: string
  payload: Record<string, unknown>
  fulfilment?: MailboxFulfilment
}

/**
 * Merge client-supplied plaintext onto a sealed approval payload, for THIS
 * execution only.
 *
 * The result is a fresh object. Nothing here writes to the database, emits an
 * event or logs a value, and callers must not persist what it returns.
 */
export function applyMailboxFulfilment(
  input: ApplyMailboxFulfilmentInput,
): Record<string, unknown> {
  const payload = input.payload ?? {}
  if (!input.fulfilment) {
    // A SEALED payload with no fulfilment cannot be executed: the handler would
    // be handed `bodyCiphertext` and friends, which `assertKnownParams` rejects
    // as manifest-undeclared, and no body at all. Refuse HERE, with something
    // the approver can act on, rather than letting the row be claimed and moved
    // and then failing as an opaque handler error.
    if (payload.mailboxSealed === true) {
      throw new MailboxFulfilmentError(
        "fulfilment_required",
        "this send is sealed to the mailbox owner: unlock the mailbox in Mail and approve from there, " +
          "so the decrypted draft is supplied with the approval",
      )
    }
    return payload
  }

  if (!MAILBOX_FULFILLABLE_TOOLS.has(input.toolName)) {
    throw new MailboxFulfilmentError(
      "not_a_mail_send",
      `${input.toolName} does not accept a mailbox fulfilment`,
    )
  }
  // A payload that was never sealed already carries the body the approver read.
  // Accepting a fulfilment for it would let whoever approves swap the reviewed
  // text for something nobody reviewed, on an ordinary shared mailbox.
  if (payload.mailboxSealed !== true) {
    throw new MailboxFulfilmentError(
      "payload_not_sealed",
      "this approval carries no sealed mail draft, so there is nothing to fulfil",
    )
  }

  // Re-checked here, not only in `parseMailboxFulfilment`: this function is the
  // last thing between a caller and the send, and an in-process caller that
  // skipped the parse must not be able to slip an unbounded body past it.
  for (const [key, value] of Object.entries(input.fulfilment.draft ?? {})) {
    requireBoundedText(value, `draft.${key}`)
  }

  const quoteEntries = Object.entries(input.fulfilment.quote ?? {})
  if (quoteEntries.length > MAILBOX_FULFILMENT_MAX_QUOTED_MESSAGES) {
    throw new MailboxFulfilmentError(
      "too_large",
      `at most ${MAILBOX_FULFILMENT_MAX_QUOTED_MESSAGES} quoted messages may be supplied`,
    )
  }
  const attachmentEntries = Object.entries(input.fulfilment.attachments ?? {})
  if (attachmentEntries.length > MAILBOX_FULFILMENT_MAX_ATTACHMENTS) {
    throw new MailboxFulfilmentError(
      "too_large",
      `at most ${MAILBOX_FULFILMENT_MAX_ATTACHMENTS} attachments may be supplied`,
    )
  }
  let attachmentBytes = 0
  for (const [, base64] of attachmentEntries) attachmentBytes += base64Bytes(base64)
  if (attachmentBytes > MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES) {
    throw new MailboxFulfilmentError(
      "too_large",
      `the supplied attachments exceed the ${MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES} byte ceiling`,
    )
  }

  const out: Record<string, unknown> = {}
  const stripped = new Set<string>(SEALED_PAYLOAD_KEYS)
  for (const [key, value] of Object.entries(payload)) {
    if (stripped.has(key)) continue
    out[key] = value
  }
  const draft = input.fulfilment.draft
  if (draft?.subject !== undefined) out.subject = draft.subject
  if (draft?.textBody !== undefined) out.textBody = draft.textBody
  if (draft?.htmlBody !== undefined) out.htmlBody = draft.htmlBody
  if (draft?.note !== undefined) out.note = draft.note
  if (quoteEntries.length > 0) out.__mailboxQuote = Object.fromEntries(quoteEntries)
  if (attachmentEntries.length > 0) out.__mailboxAttachments = Object.fromEntries(attachmentEntries)
  return out
}
