// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K, Task 6.5: seal the payload of a gated mail send.
//
// A gated `mail:reply` / `mail:forward` / `mail:compose` writes the agent's
// drafted message into `kernel.approval_requests.tool_params` and
// `.current_payload`, and `createApprovalRequest` copies the same payload into a
// durable `kernel.pending_events` row. Both are ordinary jsonb an operator with
// the approvals scope can read, and neither is reachable by the Phase 12 purge.
// For a compose the subject and body are text the USER typed about their own
// private mail, so this is the one mail leak that never self-heals.
//
// The fix is not to hide the payload from the approver: the approver here is the
// mailbox OWNER (the three tools declare `resourceOwner`, and
// `modules/approvals/resource-owner.ts` routes the request privately), and the
// approval card decrypts and renders the real draft client-side. The fix is that
// the SERVER stores ciphertext, exactly as it does for a message row.
//
// It refuses rather than degrades. A `ready` mailbox whose owner has no usable
// identity key fails the staging call with `NO_ACTIVE_IDENTITY_KEY`; there is no
// code path here that can fall back to a cleartext payload.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import {
  type ManagedApprovalPart,
  sealManagedApprovalParts,
} from "~/modules/mailbox-crypto/managed-approval"
import { sealForUser } from "~/modules/mailbox-crypto/seal-service"

const mailSchema = () => quoteIdent(schemaRef("app_mail"))

/**
 * The mail tools whose params carry a drafted message.
 *
 * A NAMED set rather than "everything gated", because sealing a payload the
 * approval executor later needs in cleartext (a label change, an archive) would
 * break the send with no compensating benefit. These four, and only these four,
 * carry user or agent authored prose.
 */
export const MAIL_APPROVAL_SEALED_TOOLS: ReadonlySet<string> = new Set([
  "reply",
  "forward",
  "compose",
  "composeForApp",
])

/**
 * The `encryption_state` values that mean "this mailbox is under the encryption
 * regime", shared with every other Invariant K site (`mailAccountSuppressedSql`,
 * `mailAccountContentSuppressed`). `none` and `pending_enrollment` are outside
 * it; `blocked` and `paused` are inside it and stay inside it.
 */
const MAIL_ENCRYPTED_STATES: ReadonlySet<string> = new Set([
  "ready",
  "blocked",
  "paused",
  "managed",
])

/** Param keys that hold drafted content and are replaced by ciphertext. */
const SEALED_BODY_KEYS = ["textBody", "text_body", "body", "htmlBody", "html_body"] as const
const SEALED_SUBJECT_KEYS = ["subject"] as const

/**
 * Param keys that hold a QUOTED ORIGINAL, dropped outright.
 *
 * Not sealed, dropped. Spec section 15 A10: there is no version of the quoted
 * original that an approver needs, the client already holds the conversation it
 * was quoted from, and the send path rebuilds it. Keeping a sealed copy would
 * mean one more blob to key-manage for no reader.
 */
const DROPPED_KEYS = [
  "quotedOriginal",
  "quoted_original",
  "originalBody",
  "original_body",
  "quotedText",
  "quoted_text",
] as const

/**
 * A forward's lead-in note. SEALED rather than dropped, deliberately: unlike the
 * quoted original it is prose the user wrote and the executed send must deliver,
 * so dropping it would silently send a forward with no note.
 */
const SEALED_NOTE_KEYS = ["note"] as const

function firstString(
  params: Record<string, unknown>,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = params[key]
    if (typeof value === "string" && value.length > 0) return { key, value }
  }
  return null
}

/** A non-reversible fingerprint of the subject, so the card can tell two drafts
 *  apart and a restage diff can say "the subject changed" without saying to what. */
async function hashSubject(subject: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject))
  return Buffer.from(digest).toString("base64url").slice(0, 16)
}

interface MailApprovalAccount {
  accountId: string
  ownerId: string | null
  ownerType: string
  encryptionState: string
}

/**
 * Resolve which mailbox a gated send targets.
 *
 * Three shapes reach here: an explicit `accountId` (compose), a `conversationId`
 * (reply and forward), or a `messageId` (a forward that names one message). All
 * three are resolved through one privileged read, because the staging call runs
 * before the approval row exists and has no request transaction to borrow.
 */
async function resolveApprovalMailAccount(
  orgId: string,
  params: Record<string, unknown>,
): Promise<MailApprovalAccount | null> {
  const accountId = typeof params.accountId === "string" ? params.accountId : null
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : null
  const messageId = typeof params.messageId === "string" ? params.messageId : null
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const schema = drizzleSql.raw(mailSchema())

  return withPrivilegedDb(orgId, "mail-approval-account", async (tx) => {
    const read = async (query: unknown) =>
      extractRows<{
        id: string
        owner_id: string | null
        owner_type: string
        encryption_state: string | null
      }>(await tx.execute(query as never))[0]

    let row: Awaited<ReturnType<typeof read>> | undefined
    if (accountId && UUID_RE.test(accountId)) {
      row = await read(drizzleSql`
        SELECT id, owner_id, owner_type, encryption_state FROM ${schema}.accounts
         WHERE id = ${accountId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`)
    }
    if (!row && conversationId && UUID_RE.test(conversationId)) {
      row = await read(drizzleSql`
        SELECT a.id, a.owner_id, a.owner_type, a.encryption_state
          FROM ${schema}.conversations c JOIN ${schema}.accounts a ON a.id = c.account_id
         WHERE c.id = ${conversationId}::uuid AND c.org_id = ${orgId}::uuid LIMIT 1`)
    }
    if (!row && messageId && UUID_RE.test(messageId)) {
      row = await read(drizzleSql`
        SELECT a.id, a.owner_id, a.owner_type, a.encryption_state
          FROM ${schema}.messages m JOIN ${schema}.accounts a ON a.id = m.account_id
         WHERE m.id = ${messageId}::uuid AND m.org_id = ${orgId}::uuid LIMIT 1`)
    }
    if (!row) return null
    return {
      accountId: row.id,
      ownerId: row.owner_id,
      ownerType: row.owner_type,
      encryptionState: row.encryption_state ?? "none",
    }
  })
}

/**
 * The messages a reply or forward will QUOTE, resolved by the same rule the
 * handler uses (an explicit `messageId`, else the latest inbound message of the
 * conversation). Blueprint Task 9.8: the approving browser has to know which
 * originals to decrypt, and message ids are cleartext by spec section 2.1.
 *
 * DRIFT IS SAFE HERE. If the conversation gains a newer inbound message between
 * staging and approval, the handler picks the newer one, finds no supplied quote
 * for it and REFUSES. The failure direction is a refused send, never a send with
 * the wrong quote.
 */
async function resolveQuotedMessageIds(
  orgId: string,
  toolShortName: string,
  params: Record<string, unknown>,
): Promise<string[]> {
  if (toolShortName !== "reply" && toolShortName !== "forward") return []
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const messageId = typeof params.messageId === "string" ? params.messageId : null
  if (messageId && UUID_RE.test(messageId)) return [messageId]
  const conversationId = typeof params.conversationId === "string" ? params.conversationId : null
  if (!conversationId || !UUID_RE.test(conversationId)) return []
  const schema = drizzleSql.raw(mailSchema())
  return withPrivilegedDb(orgId, "mail-approval-quoted-ids", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${schema}.messages
         WHERE conversation_id = ${conversationId}::uuid AND org_id = ${orgId}::uuid
           AND direction = 'inbound'
         ORDER BY sent_at DESC NULLS LAST, created_at DESC
         LIMIT 1`),
    )
    return rows.map((r) => r.id)
  })
}

export interface SealMailApprovalPayloadInput {
  orgId: string
  appName: string
  toolShortName: string
  /**
   * The approval request id. It is minted before the transaction opens, and it
   * is what binds the ciphertext: the blob for approval A cannot be replayed
   * into approval B, because the AAD names the id.
   */
  approvalRequestId: string
  toolParams: Record<string, unknown>
}

/**
 * Return the payload to persist. Unchanged for every call that is not a gated
 * mail send from an encrypted personal mailbox.
 */
export async function sealMailApprovalPayload(
  input: SealMailApprovalPayloadInput,
): Promise<Record<string, unknown>> {
  const params = input.toolParams ?? {}
  if (input.appName !== "mail") return params
  if (!MAIL_APPROVAL_SEALED_TOOLS.has(input.toolShortName)) return params

  const account = await resolveApprovalMailAccount(input.orgId, params)
  if (!account) return params
  if (account.ownerType !== "user" || !account.ownerId) return params
  // Under the regime, not just `ready`. `ready -> blocked` is legal on any seal
  // failure and `pending_enrollment -> paused` on an elapsed grace window, and
  // an approval row is durable control-plane state: keying on `ready` alone
  // meant one seal failure started persisting the drafted body in cleartext.
  // If the mailbox genuinely cannot be sealed to, `sealForUser` throws below and
  // the approval is refused, which is the correct outcome: those mailboxes
  // refuse the send anyway (`assertMailboxWritable`), so the only thing keying
  // on `ready` bought was a cleartext row for a send that could not happen.
  if (!MAIL_ENCRYPTED_STATES.has(account.encryptionState)) return params

  const body = firstString(params, SEALED_BODY_KEYS)
  const subject = firstString(params, SEALED_SUBJECT_KEYS)
  const note = firstString(params, SEALED_NOTE_KEYS)
  const htmlBody =
    typeof params.htmlBody === "string" && params.htmlBody.length > 0 ? params.htmlBody : null

  const out: Record<string, unknown> = {}
  const contentKeys = new Set<string>([
    ...SEALED_BODY_KEYS,
    ...SEALED_SUBJECT_KEYS,
    ...SEALED_NOTE_KEYS,
    ...DROPPED_KEYS,
  ])
  for (const [key, value] of Object.entries(params)) {
    if (contentKeys.has(key)) continue
    out[key] = value
  }

  // AAD binding. There is no dedicated "approval" context among the twelve, and
  // inventing a thirteenth is a spec change, not an implementation choice. The
  // draft contexts are the honest fit: an approval payload for a mail send IS a
  // draft of that mail, and binding it to the approval request id gives exactly
  // the property the contexts exist for, a blob that opens under one id and no
  // other.
  // One named part per sealed field, each with its own AAD entity id, so a blob
  // sealed for the body can never be opened as the subject.
  const parts: ManagedApprovalPart[] = []
  if (body)
    parts.push({ outKey: "bodyCiphertext", kind: "draftBody", suffix: "", value: body.value })
  if (htmlBody && body?.key !== "htmlBody") {
    parts.push({
      outKey: "htmlBodyCiphertext",
      kind: "draftBody",
      suffix: ":html",
      value: htmlBody,
    })
  }
  if (note)
    parts.push({ outKey: "noteCiphertext", kind: "draftBody", suffix: ":note", value: note.value })
  if (subject) {
    parts.push({
      outKey: "subjectCiphertext",
      kind: "draftSubject",
      suffix: "",
      value: subject.value,
    })
  }
  if (parts.length === 0) return out

  // A server-managed mailbox seals the draft under its own key (v2); its owner
  // reads it on the card and the send opens it in memory (managed-approval.ts).
  if (account.encryptionState === "managed") {
    Object.assign(
      out,
      await sealManagedApprovalParts({
        orgId: input.orgId,
        accountId: account.accountId,
        approvalRequestId: input.approvalRequestId,
        parts,
      }),
    )
    if (body) out.byteLength = new TextEncoder().encode(body.value).byteLength
    if (subject) out.subjectHash = await hashSubject(subject.value)
    const quoted = await resolveQuotedMessageIds(input.orgId, input.toolShortName, params)
    if (quoted.length > 0) out.mailboxQuoteMessageIds = quoted
    out.recipientCount =
      (Array.isArray(params.to) ? params.to.length : 0) +
      (Array.isArray(params.cc) ? params.cc.length : 0) +
      (Array.isArray(params.bcc) ? params.bcc.length : 0)
    return out
  }

  const batch = await sealForUser(
    account.ownerId,
    input.orgId,
    parts.map((part) => ({
      context: { kind: part.kind, entityId: `${input.approvalRequestId}${part.suffix}` },
      plaintext: part.value,
    })),
  )
  for (let i = 0; i < parts.length; i++) {
    out[parts[i].outKey] = Buffer.from(batch.items[i]?.ciphertext ?? []).toString("base64")
  }
  if (body) out.byteLength = new TextEncoder().encode(body.value).byteLength
  if (subject) out.subjectHash = await hashSubject(subject.value)
  // Cleartext, deliberately: ids and counts are cleartext by section 2.1, and
  // the approving browser cannot decrypt the quoted originals without knowing
  // which ones to open (Task 9.8).
  const quotedMessageIds = await resolveQuotedMessageIds(input.orgId, input.toolShortName, params)
  if (quotedMessageIds.length > 0) out.mailboxQuoteMessageIds = quotedMessageIds
  out.contentKeyWrapped = Buffer.from(batch.contentKeyWrapped).toString("base64")
  out.contentKeyEpk = Buffer.from(batch.contentKeyEpk).toString("base64")
  out.encKeyId = batch.keyId
  out.encVersion = batch.encVersion
  out.mailboxSealed = true
  out.recipientCount =
    (Array.isArray(params.to) ? params.to.length : 0) +
    (Array.isArray(params.cc) ? params.cc.length : 0) +
    (Array.isArray(params.bcc) ? params.bcc.length : 0)
  return out
}

/**
 * The keys a sealed approval payload carries in place of its drafted content:
 * the ciphertext parts, the key material that opens them and the cleartext
 * facts derived from them. An edit can never set one of these directly.
 */
export const MAIL_APPROVAL_SEAL_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
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
  "mailboxAccountId",
])

/** The plaintext param keys a sealed payload never stores (sealed or dropped). */
export const MAIL_APPROVAL_CONTENT_KEYS: ReadonlySet<string> = new Set([
  ...SEALED_BODY_KEYS,
  ...SEALED_SUBJECT_KEYS,
  ...SEALED_NOTE_KEYS,
  ...DROPPED_KEYS,
])

/** True when this approval payload holds a sealed mail draft (either seal variant). */
export function isSealedMailApprovalPayload(payload: Record<string, unknown> | null | undefined) {
  return payload?.mailboxSealed === true
}

/** Which plaintext field each sealed part holds, for the edit coverage rule. */
const PART_FIELDS: Array<{ part: string; plain: readonly string[] }> = [
  { part: "bodyCiphertext", plain: ["textBody", "text_body", "body"] },
  { part: "htmlBodyCiphertext", plain: ["htmlBody", "html_body"] },
  { part: "noteCiphertext", plain: SEALED_NOTE_KEYS },
  { part: "subjectCiphertext", plain: SEALED_SUBJECT_KEYS },
]

/** A sealed draft edit that cannot be honoured without storing plaintext. */
export class SealedMailEditRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SealedMailEditRefusal"
  }
}

/** The diff marker recorded for a sealed field: that it changed, never to what. */
export interface SealedFieldMarker {
  sealed: true
  byteLength?: number
}

export interface ResealMailApprovalEditInput {
  orgId: string
  appName: string
  toolShortName: string
  approvalRequestId: string
  /** The stored sealed payload, with any envelope edit (to, cc) already applied. */
  payload: Record<string, unknown>
  /** The edited content fields, top-level plaintext keys (`textBody`, `subject`, `note`). */
  contentEdits: Record<string, unknown>
  /** Plaintext keys the edit invalidates (an edited `textBody` invalidates `htmlBody`). */
  invalidated: readonly string[]
  /** The editable fields of this tool, named in a refusal so the agent can self-correct. */
  editableFields: readonly string[]
}

export interface ResealMailApprovalEditResult {
  /** The payload to persist: the edited content sealed again, no plaintext anywhere. */
  payload: Record<string, unknown>
  /**
   * The draft as plaintext, for schema validation IN MEMORY only. Never persisted,
   * logged or returned to a caller that could persist it.
   */
  plaintextView: Record<string, unknown>
  /** One entry per content field the edit changed or dropped, values as markers. */
  diff: Array<{ field: string; from: SealedFieldMarker | null; to: SealedFieldMarker | null }>
}

/**
 * Apply an edit of a sealed mail draft's CONTENT by sealing the new content
 * again, through `sealMailApprovalPayload`, the same function that sealed the
 * draft when it was staged (same mailbox resolution, same recipient key, same
 * AAD binding to the approval id). Nothing new is invented here.
 *
 * The server can seal to the mailbox but cannot open what it sealed, and every
 * part of one draft shares ONE content key (one `sealForUser` batch). So a new
 * seal replaces every part at once, and each part the draft already carries must
 * be either supplied again by this edit or dropped by it (an edited `textBody`
 * invalidates the pre-rendered `htmlBody`). A part that is neither cannot be
 * kept, and the edit is REFUSED rather than stored half sealed or in the clear.
 */
export async function resealMailApprovalEdit(
  input: ResealMailApprovalEditInput,
): Promise<ResealMailApprovalEditResult> {
  const { payload, contentEdits } = input
  for (const [key, value] of Object.entries(contentEdits)) {
    if (DROPPED_KEYS.includes(key as (typeof DROPPED_KEYS)[number])) {
      throw new SealedMailEditRefusal(
        `'${key}' is never stored on an encrypted draft (the send rebuilds the quote), so it cannot be edited`,
      )
    }
    if (typeof value !== "string") {
      throw new SealedMailEditRefusal(`'${key}' must be a string`)
    }
  }

  const supplied = (plain: readonly string[]) =>
    plain.some((key) => typeof contentEdits[key] === "string" && contentEdits[key] !== "")
  const invalidated = new Set(input.invalidated)
  const diff: ResealMailApprovalEditResult["diff"] = []
  const missing: string[] = []
  for (const { part, plain } of PART_FIELDS) {
    const present = typeof payload[part] === "string" && payload[part] !== ""
    if (supplied(plain)) continue
    if (!present) continue
    const blanked = plain.some((key) => key in contentEdits)
    if (blanked || plain.some((key) => invalidated.has(key))) {
      if (part === "bodyCiphertext") {
        throw new SealedMailEditRefusal("the body of an encrypted draft cannot be emptied")
      }
      diff.push({ field: plain[0] as string, from: { sealed: true }, to: null })
      continue
    }
    missing.push(plain[0] as string)
  }
  if (missing.length > 0) {
    const editable = new Set(input.editableFields)
    const canResupply = missing.every((field) => editable.has(field))
    throw new SealedMailEditRefusal(
      canResupply
        ? `this draft is end-to-end encrypted and the server cannot read its ${missing.join(", ")}: to change it, pass ${missing.join(", ")} again in the same edit together with the field you change. Nothing was saved.`
        : `this draft is end-to-end encrypted and the server cannot read its ${missing.join(", ")}, which this edit cannot carry, so the edit was not saved. Withdraw the request with kernel__approval_withdraw and stage a new mail:${input.toolShortName} with the corrected content instead.`,
    )
  }

  // The draft as the staging call saw it: the envelope as it now stands, plus
  // the edited content. Sealed exactly as at staging, bound to the same id.
  const plaintextView: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (MAIL_APPROVAL_SEAL_ENVELOPE_KEYS.has(key) || MAIL_APPROVAL_CONTENT_KEYS.has(key)) continue
    plaintextView[key] = value
  }
  for (const [key, value] of Object.entries(contentEdits)) {
    if (typeof value === "string" && value !== "") plaintextView[key] = value
  }

  const resealed = await sealMailApprovalPayload({
    orgId: input.orgId,
    appName: input.appName,
    toolShortName: input.toolShortName,
    approvalRequestId: input.approvalRequestId,
    toolParams: plaintextView,
  })
  // Fail closed: the mailbox left the encryption regime, or nothing was sealed.
  // Storing the result would write the edited content in the clear.
  const leaked = Object.keys(resealed).filter(
    (key) => MAIL_APPROVAL_CONTENT_KEYS.has(key) && resealed[key] !== "",
  )
  if (resealed.mailboxSealed !== true || leaked.length > 0) {
    throw new SealedMailEditRefusal(
      `this draft's mailbox can no longer be sealed to, so the edit was not saved. Withdraw the request with kernel__approval_withdraw and stage a new mail:${input.toolShortName} instead.`,
    )
  }

  const byteLengthOf = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined
  for (const { part, plain } of PART_FIELDS) {
    const key = plain.find((k) => typeof contentEdits[k] === "string" && contentEdits[k] !== "")
    if (!key) continue
    const isBody = part === "bodyCiphertext"
    const fromLength = isBody ? byteLengthOf(payload.byteLength) : undefined
    const toLength = isBody ? byteLengthOf(resealed.byteLength) : undefined
    diff.push({
      field: key,
      from:
        typeof payload[part] === "string"
          ? { sealed: true, ...(fromLength !== undefined ? { byteLength: fromLength } : {}) }
          : null,
      to: { sealed: true, ...(toLength !== undefined ? { byteLength: toLength } : {}) },
    })
  }
  return { payload: resealed, plaintextView, diff }
}

/**
 * A sealed draft as its tool's schema sees it, for validating an envelope-only
 * edit (to, cc) IN MEMORY: each sealed part stands in as a placeholder string
 * under its plaintext key, so a required `textBody` is satisfied by the sealed
 * body without the server ever holding it. Never persisted.
 */
export function sealedMailValidationView(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const view: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (MAIL_APPROVAL_SEAL_ENVELOPE_KEYS.has(key) || MAIL_APPROVAL_CONTENT_KEYS.has(key)) continue
    view[key] = value
  }
  for (const { part, plain } of PART_FIELDS) {
    if (typeof payload[part] === "string" && payload[part] !== "") view[plain[0] as string] = "x"
  }
  return view
}

/** The cleartext recipient count a sealed payload carries, recomputed after an envelope edit. */
export function sealedMailRecipientCount(params: Record<string, unknown>): number {
  return (
    (Array.isArray(params.to) ? params.to.length : 0) +
    (Array.isArray(params.cc) ? params.cc.length : 0) +
    (Array.isArray(params.bcc) ? params.bcc.length : 0)
  )
}
