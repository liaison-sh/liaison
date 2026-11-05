// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint Task 9.8 and 9.9, the browser half. Spec section 5.4.
//
// `mail:reply`, `mail:forward` and `mail:compose` are gated, so the handler that
// actually sends runs LATER, from the approval decide path. That path never
// enters the tool bridge, so the Phase 9 plaintext broker cannot reach it: there
// is no paused turn and no socket to ask over. The browser therefore supplies
// the plaintext as part of APPROVING, in the body of the decide request.
//
// WHAT IS STORED AND WHAT IS PASSED, because the difference is the whole point.
// Phase 6 seals the drafted body and subject into `current_payload`, so the row
// on disk is ciphertext and stays ciphertext. What this module produces is
// transit: the server merges it in memory microseconds before the handler runs
// and writes it nowhere. `approval_update_payload` is deliberately NOT used, and
// must not be: it persists the merged object as cleartext jsonb AND posts a
// field diff carrying the values into `kernel.messages.metadata`, which is the
// exact row Invariant K names.
//
// EVERY FAILURE HERE IS A REFUSAL. Approving with a body that did not decrypt
// sends a blank email that reports success, and approving with a dropped
// attachment loses a file silently. Both are worse than not sending.

import { type Translate, tNow } from "~/modules/i18n/i18n-context"
import type {
  OpenedApprovalDraft,
  OpenedMessage,
  SealedApprovalDraft,
} from "~/modules/mailbox/crypto-protocol"

/** The gated mail sends whose approval payload Phase 6 seals. */
const SEALED_MAIL_TOOLS: ReadonlySet<string> = new Set([
  "mail:reply",
  "mail:forward",
  "mail:compose",
  "mail:composeForApp",
])

export type MailApprovalFulfilmentCode =
  | "not_a_sealed_mail_send"
  | "mailbox_locked"
  | "draft_unreadable"
  | "quote_unreadable"
  | "attachments_unavailable"

export class MailApprovalFulfilmentError extends Error {
  readonly code: MailApprovalFulfilmentCode
  constructor(code: MailApprovalFulfilmentCode, message: string) {
    super(message)
    this.name = "MailApprovalFulfilmentError"
    this.code = code
  }
}

/** The approval row as this module needs to see it. */
export interface SealedMailApproval {
  id: string
  /** Canonical `app:tool`. */
  toolName: string
  payload: Record<string, unknown>
  /** Messages whose original the send quotes (a reply's or forward's source). */
  quotedMessageIds?: string[]
  /** Stored attachments that are sealed at rest and must be re-attached. */
  sealedAttachmentFileIds?: string[]
}

export interface ApprovalMailFulfilmentDeps {
  isUnlocked(): boolean
  openApprovalDraft(sealed: SealedApprovalDraft): Promise<OpenedApprovalDraft>
  openMessages(messageIds: string[]): Promise<OpenedMessage[]>
  /** Absent until sealed attachments can be opened. Its absence is a refusal,
   *  never a reason to send what the server holds. */
  openAttachments?(fileIds: string[]): Promise<Array<{ fileId: string; bytesBase64: string }>>
}

/** The body posted alongside `{ decision: "approve" }`. */
export interface MailboxFulfilmentBody {
  draft?: { subject?: string; textBody?: string; htmlBody?: string; note?: string }
  quote?: Record<string, { quotedBody?: string; resolvedSubject?: string }>
  attachments?: Record<string, string>
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** True when this approval carries a sealed mail draft that only the mailbox
 *  owner's browser can make executable. */
/** A gated mail send: the only approvals whose payload can be sealed. */
export function isMailSendTool(toolName: string | null | undefined): boolean {
  return typeof toolName === "string" && SEALED_MAIL_TOOLS.has(toolName)
}

export function isSealedMailApproval(approval: {
  toolName: string
  payload?: Record<string, unknown> | null
}): boolean {
  if (!isMailSendTool(approval.toolName)) return false
  return approval.payload?.mailboxSealed === true
}

/**
 * The stored files a gated send re-attaches, straight off the payload the
 * approver is looking at (Task 9.9).
 *
 * Envelope level, so it stays readable while the body is ciphertext: the
 * attachment ids are the tool's own parameters and Phase 6 does not seal them.
 * Anything that is not a non-empty string is dropped rather than handed to the
 * opener, which would turn a malformed payload into a failed send.
 */
export function outboundAttachmentFileIds(payload: Record<string, unknown> | null): string[] {
  const raw = payload?.attachments
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is string => typeof value === "string" && value.length > 0)
}

/**
 * What the approver is told BEFORE they approve, when this send carries stored
 * attachments from an encrypted mailbox.
 *
 * The server cannot read those files, so approving is the moment this browser
 * opens them and puts them on the wire. Saying so is the point: a person should
 * never learn after the fact that approving decrypted something.
 */
export function mailAttachmentDisclosure(count: number, t: Translate = tNow): string | null {
  if (count <= 0) return null
  return count === 1
    ? t("kernel.mailboxEncryption.approval.disclosureOne")
    : t("kernel.mailboxEncryption.approval.disclosureMany", { count })
}

/**
 * The key material and ciphertext a sealed draft carries in its payload. None of
 * it means anything to a person, so the approval card never lists it: it shows
 * the decrypted subject and body in their place.
 */
export const SEALED_DRAFT_PAYLOAD_KEYS: ReadonlySet<string> = new Set([
  "mailboxSealed",
  "encVersion",
  "encKeyId",
  "contentKeyWrapped",
  "contentKeyEpk",
  "subjectCiphertext",
  "bodyCiphertext",
  "htmlBodyCiphertext",
  "noteCiphertext",
  "subjectHash",
  "byteLength",
])

/**
 * What the approval card shows for a sealed mail draft: the envelope fields as
 * stored, with the sealed ones replaced by the text the owner's browser just
 * decrypted. `opened` null (mailbox locked, or not decrypted yet) leaves only the
 * envelope, never the ciphertext. Display only: the result is never sent back.
 */
export function sealedDraftPreviewPayload(
  payload: Record<string, unknown>,
  opened: Pick<OpenedApprovalDraft, "subject" | "textBody" | "htmlBody" | "note"> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (opened?.subject) out.subject = opened.subject
  for (const [key, value] of Object.entries(payload)) {
    if (!SEALED_DRAFT_PAYLOAD_KEYS.has(key)) out[key] = value
  }
  if (opened?.note) out.note = opened.note
  if (opened?.textBody) out.textBody = opened.textBody
  else if (opened?.htmlBody) out.htmlBody = opened.htmlBody
  return out
}

/** Which plaintext field each sealed part of a mail draft holds. */
const SEALED_DRAFT_PART_FIELDS: ReadonlyArray<{ part: string; field: string }> = [
  { part: "subjectCiphertext", field: "subject" },
  { part: "bodyCiphertext", field: "textBody" },
  { part: "noteCiphertext", field: "note" },
]

/**
 * The fields an edit of a SEALED mail draft posts. Every part of the draft is
 * sealed under one key the server cannot open, so an edit that touches its
 * content re-seals the whole draft: each sealed part goes along as this
 * browser decrypted it (edited or not), never only the changed one. An edit of
 * the envelope alone (to, cc) stays a diff. Null when a sealed part is not
 * editable here or was not decrypted: the draft cannot be re-sealed whole.
 */
export function sealedDraftEditFields(
  payload: Record<string, unknown>,
  draft: Record<string, unknown>,
  changed: Record<string, unknown>,
  editableFields: readonly string[],
): Record<string, unknown> | null {
  const parts = SEALED_DRAFT_PART_FIELDS.filter(
    (p) => typeof payload[p.part] === "string" && payload[p.part] !== "",
  )
  const contentFields = new Set(SEALED_DRAFT_PART_FIELDS.map((p) => p.field))
  if (!Object.keys(changed).some((field) => contentFields.has(field))) return changed
  const out: Record<string, unknown> = { ...changed }
  for (const { field } of parts) {
    if (field in out) continue
    const value = draft[field]
    if (!editableFields.includes(field) || typeof value !== "string" || !value.trim()) return null
    out[field] = value
  }
  return out
}

export function readSealedDraft(approval: SealedMailApproval): SealedApprovalDraft {
  const p = approval.payload
  const encKeyId = typeof p.encKeyId === "number" ? p.encKeyId : null
  const wrapped = str(p.contentKeyWrapped)
  const epk = str(p.contentKeyEpk)
  if (encKeyId === null || !wrapped || !epk) {
    throw new MailApprovalFulfilmentError(
      "draft_unreadable",
      tNow("kernel.mailboxEncryption.approval.draftMissingKeys"),
    )
  }
  return {
    approvalRequestId: approval.id,
    encVersion: typeof p.encVersion === "number" ? p.encVersion : 1,
    encKeyId,
    contentKeyWrapped: wrapped,
    contentKeyEpk: epk,
    subjectCiphertext: str(p.subjectCiphertext),
    bodyCiphertext: str(p.bodyCiphertext),
    htmlBodyCiphertext: str(p.htmlBodyCiphertext),
    noteCiphertext: str(p.noteCiphertext),
  }
}

/**
 * Decrypt everything this send needs, or throw.
 *
 * The result is handed straight to the decide call and then dropped. It is never
 * stored, never sent through `approval_update_payload`, and never logged.
 */
export async function buildMailboxFulfilment(
  deps: ApprovalMailFulfilmentDeps,
  approval: SealedMailApproval,
): Promise<MailboxFulfilmentBody> {
  if (!isSealedMailApproval(approval)) {
    throw new MailApprovalFulfilmentError(
      "not_a_sealed_mail_send",
      tNow("kernel.mailboxEncryption.approval.notSealed"),
    )
  }
  if (!deps.isUnlocked()) {
    throw new MailApprovalFulfilmentError(
      "mailbox_locked",
      tNow("kernel.mailboxEncryption.approval.mailboxLocked"),
    )
  }

  const opened = await deps.openApprovalDraft(readSealedDraft(approval))
  // A forward's own text is its lead-in NOTE, and the body is assembled from the
  // quote, so a forward with a note and no body is legitimate. Everything else
  // needs a body.
  const isForward = approval.toolName === "mail:forward"
  const hasBody = Boolean(opened.textBody || opened.htmlBody)
  if (!hasBody && !(isForward && opened.note)) {
    throw new MailApprovalFulfilmentError(
      "draft_unreadable",
      tNow("kernel.mailboxEncryption.approval.draftUnreadable"),
    )
  }

  const draft: NonNullable<MailboxFulfilmentBody["draft"]> = {}
  if (opened.subject) draft.subject = opened.subject
  if (opened.textBody) draft.textBody = opened.textBody
  if (opened.htmlBody) draft.htmlBody = opened.htmlBody
  if (opened.note) draft.note = opened.note

  const out: MailboxFulfilmentBody = { draft }

  const quotedIds = approval.quotedMessageIds ?? []
  if (quotedIds.length > 0) {
    const messages = await deps.openMessages(quotedIds)
    const byId = new Map(messages.map((m) => [m.id, m]))
    const missing = quotedIds.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      // Partial quoting is silent data loss dressed as a delivered mail.
      throw new MailApprovalFulfilmentError(
        "quote_unreadable",
        tNow("kernel.mailboxEncryption.approval.quoteUnreadable", { count: missing.length }),
      )
    }
    const quote: NonNullable<MailboxFulfilmentBody["quote"]> = {}
    for (const id of quotedIds) {
      const message = byId.get(id)
      if (!message) continue
      quote[id] = {
        ...(message.textBody ? { quotedBody: message.textBody } : {}),
        ...(message.subject ? { resolvedSubject: message.subject } : {}),
      }
    }
    out.quote = quote
  }

  const fileIds = approval.sealedAttachmentFileIds ?? []
  if (fileIds.length > 0) {
    if (!deps.openAttachments) {
      throw new MailApprovalFulfilmentError(
        "attachments_unavailable",
        tNow("kernel.mailboxEncryption.approval.attachmentsUnavailable"),
      )
    }
    const files = await deps.openAttachments(fileIds)
    const byFileId = new Map(files.map((f) => [f.fileId, f.bytesBase64]))
    const missing = fileIds.filter((id) => !byFileId.get(id))
    if (missing.length > 0) {
      throw new MailApprovalFulfilmentError(
        "attachments_unavailable",
        tNow("kernel.mailboxEncryption.approval.attachmentsFailed", { count: missing.length }),
      )
    }
    out.attachments = Object.fromEntries(fileIds.map((id) => [id, byFileId.get(id) as string]))
  }

  return out
}
