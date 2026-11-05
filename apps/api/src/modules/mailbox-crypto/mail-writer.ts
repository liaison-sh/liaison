// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one chokepoint every mail writer passes through.
//
// Spec section 5.9 enumerates seven distinct writers of the mail content
// columns, spread across a sandboxed app bundle and privileged server code.
// Per-call-site discipline is not enough for that: the bundle is versioned and
// changes independently of this review. So every writer calls `sealMailFields`
// and splices the columns it returns into its own INSERT, and none of them
// carries a plaintext fallback.
//
// The refusal rule, which is the whole design: a writer that CANNOT seal fails
// the operation with a named error and writes nothing. It never writes
// plaintext, and it never writes a partial row. That is what makes the Invariant
// P trigger's arming decision safe (the trigger stays armed while the account is
// `blocked` or `paused`): the application layer agrees with the database instead
// of trying to write around it.

import type { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { quoteIdent } from "~/lib/sql-utils"
import { splitMailHeaders } from "~/modules/mailbox-crypto/header-allowlist"
import { MailboxSealError } from "~/modules/mailbox-crypto/identity-resolver"
import { loadOrCreateMailboxServerKeyPrivileged } from "~/modules/mailbox-crypto/managed-keys"
import {
  MAILBOX_MANAGED_ENC_VERSION,
  managedContextOf,
  sealManaged,
} from "~/modules/mailbox-crypto/managed-seal"
import { MAX_PLAINTEXT_BYTES, sealForUser } from "~/modules/mailbox-crypto/seal-service"

/** The three entities whose content the encryption regime owns. */
export type MailboxSealEntity = "messages" | "conversations" | "drafts"

export interface SealedFieldDef {
  /** The manifest field (and, snake_cased, the column) the ciphertext lands in. */
  column: string
  /** Which of the section 3.4 binding contexts this field is sealed under. */
  aad: keyof typeof mailboxAad
  /**
   * Appended to the entity id inside the AAD, so two fields sharing one context
   * kind still cannot be swapped for each other. This is the convention the
   * approval payload already uses for a draft's html alternative and its
   * forward note (`<id>:html`, `<id>:note`), reused here rather than inventing a
   * new section 3.4 context, which would be a spec change.
   */
  aadSuffix?: string
}

/**
 * plaintext field -> where its ciphertext goes and what it is bound to.
 *
 * The AAD kinds are deliberately distinct per field: a ciphertext cannot be
 * moved from `snippet` to `text_body`, or from a message to its conversation,
 * and still open.
 */
export const MAILBOX_SEALED_FIELDS: Record<MailboxSealEntity, Record<string, SealedFieldDef>> = {
  messages: {
    subject: { column: "subjectCiphertext", aad: "messageSubject" },
    textBody: { column: "textBodyCiphertext", aad: "messageTextBody" },
    htmlBody: { column: "htmlBodyCiphertext", aad: "messageHtmlBody" },
    snippet: { column: "snippetCiphertext", aad: "messageSnippet" },
    rawHeaders: { column: "rawHeadersCiphertext", aad: "messageHeaders" },
  },
  conversations: {
    subject: { column: "subjectCiphertext", aad: "conversationSubject" },
    snippet: { column: "snippetCiphertext", aad: "conversationSnippet" },
  },
  drafts: {
    subject: { column: "subjectCiphertext", aad: "draftSubject" },
    // `body` is the TEXT body, matching the approval payload's own mapping
    // (bodyCiphertext -> textBody, htmlBodyCiphertext -> htmlBody at the
    // `:html` suffix). Both exist because a legacy draft can carry a text and
    // an html alternative that differ, and the purge NULLs both columns: one
    // sealed slot would mean one of them is destroyed with nothing behind it.
    body: { column: "bodyCiphertext", aad: "draftBody" },
    htmlBody: { column: "htmlBodyCiphertext", aad: "draftBody", aadSuffix: ":html" },
  },
}

export interface SealMailFieldsInput {
  /** The mailbox OWNER. Never a caller-chosen recipient: the call sites resolve
   *  it from the account row and refuse when it is not the acting user. */
  userId: string
  orgId: string
  entity: MailboxSealEntity
  /** The row id, which must already exist, because it is bound into the AAD. */
  entityId: string
  /** plaintext field name -> value. Absent, null and `""` all mean "nothing to
   *  seal for this field", so no empty blob is ever written. */
  values: Partial<Record<string, string | null | undefined>>
  /** Messages only: the full header map, split by the section 5.2 allowlist. */
  headers?: Record<string, unknown> | null
  /**
   * The mailbox the row belongs to. A `managed` mailbox seals in the
   * server-managed format (`enc_version = 2`, `managed-seal.ts`) under its own
   * data key; every other state seals to the owner's identity exactly as before.
   * The format follows the ACCOUNT's state, not whether the owner enrolled, so
   * one person can own a private and a managed mailbox.
   */
  account?: Pick<MailAccountCrypto, "id" | "encryptionState">
}

export interface SealMailFieldsResult {
  /** Manifest camelCase column name -> value, ready to splice into an INSERT. */
  columns: Record<string, Buffer | number>
  /** Messages only: the headers that stay in cleartext `raw_headers`. */
  retainedHeaders?: Record<string, string>
  keyId: number
}

function isPresent(value: string | null | undefined): value is string {
  return typeof value === "string" && value !== ""
}

/**
 * Fit one field under the seal's per-field cap (`MAX_PLAINTEXT_BYTES`).
 *
 * One message over the cap (a 1.5 MB html newsletter, a pasted log) must never
 * stop a mailbox's sync: the seal would refuse it, the page would roll back,
 * and every later message would wait behind it forever. So the stored field is
 * cut at the cap, on a whole character, and ends with a visible note that says
 * how big the original was and where to read it whole. Bodies only shrink:
 * a field under the cap is returned unchanged.
 */
export function fitMailFieldToSealCap(
  field: string,
  value: string,
  cap: number = MAX_PLAINTEXT_BYTES,
): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= cap) return value
  const size = bytes.byteLength
  const note =
    field === "htmlBody"
      ? `<hr><p data-liaison-truncated="${size}"><em>Message truncated: it is ${size} bytes, more than Liaison stores. Open it in your mail provider (Gmail, Outlook, ...) to read all of it.</em></p>`
      : `\n\n[Message truncated: it is ${size} bytes, more than Liaison stores. Open it in your mail provider (Gmail, Outlook, ...) to read all of it.]`
  const room = Math.max(0, cap - Buffer.byteLength(note, "utf8"))
  // Decoding a cut that lands inside a character leaves U+FFFD at the end.
  const head = bytes
    .subarray(0, room)
    .toString("utf8")
    .replace(/\uFFFD+$/, "")
  return head + note
}

/** The sealed extra headers, or a small stand-in when they alone are over the cap. */
function fitSealedHeaders(json: string): string {
  const size = Buffer.byteLength(json, "utf8")
  if (size <= MAX_PLAINTEXT_BYTES) return json
  return JSON.stringify({ "x-liaison-headers-truncated": String(size) })
}

/**
 * Seal every supplied plaintext field of one row under ONE content key.
 *
 * One content key per row is structural here rather than a convention: the
 * batch is sealed in a single `sealForUser` call, so a caller cannot
 * accidentally mint a second key for the same row, and the client unwraps once
 * to read the whole message.
 */
export async function sealMailFields(input: SealMailFieldsInput): Promise<SealMailFieldsResult> {
  const defs = MAILBOX_SEALED_FIELDS[input.entity]
  if (!defs) {
    throw new MailboxSealError("RECIPIENT_MISMATCH", `entity "${input.entity}" is not sealable`)
  }

  const items: Array<{
    column: string
    context: { kind: SealedFieldDef["aad"]; entityId: string }
    plaintext: string
  }> = []
  let retainedHeaders: Record<string, string> | undefined

  for (const [field, def] of Object.entries(defs)) {
    if (field === "rawHeaders") continue
    const value = input.values[field]
    if (!isPresent(value)) continue
    items.push({
      column: def.column,
      context: { kind: def.aad, entityId: `${input.entityId}${def.aadSuffix ?? ""}` },
      plaintext: fitMailFieldToSealCap(field, value),
    })
  }

  if (input.entity === "messages" && input.headers) {
    const split = splitMailHeaders(input.headers)
    retainedHeaders = split.retained
    if (Object.keys(split.sealed).length > 0) {
      items.push({
        column: (defs.rawHeaders as SealedFieldDef).column,
        context: { kind: "messageHeaders", entityId: input.entityId },
        plaintext: fitSealedHeaders(JSON.stringify(split.sealed)),
      })
    }
  }

  if (input.account?.encryptionState === "managed") {
    return sealManagedMailFields(input, items, retainedHeaders, input.account.id)
  }

  // Resolve and seal even when there is nothing to seal: the row still needs
  // key material and an `enc_version`, and a row that reached this function on
  // a mailbox whose owner cannot be sealed to must fail rather than fall
  // through to a plaintext write.
  const batch = await sealForUser(
    input.userId,
    input.orgId,
    items.map((item) => ({ context: item.context, plaintext: item.plaintext })),
  )

  const columns: Record<string, Buffer | number> = {
    contentKeyWrapped: Buffer.from(batch.contentKeyWrapped),
    contentKeyEpk: Buffer.from(batch.contentKeyEpk),
    encKeyId: batch.keyId,
    encVersion: batch.encVersion,
  }
  for (let i = 0; i < items.length; i++) {
    columns[(items[i] as (typeof items)[number]).column] = Buffer.from(
      (batch.items[i] as { ciphertext: Uint8Array }).ciphertext,
    )
  }

  return { columns, retainedHeaders, keyId: batch.keyId }
}

async function sealManagedMailFields(
  input: SealMailFieldsInput,
  items: Array<{
    column: string
    context: { kind: SealedFieldDef["aad"]; entityId: string }
    plaintext: string
  }>,
  retainedHeaders: Record<string, string> | undefined,
  accountId: string,
): Promise<SealMailFieldsResult> {
  for (const item of items) {
    if (Buffer.byteLength(item.plaintext, "utf8") > MAX_PLAINTEXT_BYTES) {
      throw new MailboxSealError(
        "PLAINTEXT_TOO_LARGE",
        `plaintext is over the ${MAX_PLAINTEXT_BYTES} byte cap`,
      )
    }
  }
  const dek = await loadOrCreateMailboxServerKeyPrivileged(input.orgId, accountId)
  try {
    const sealed = sealManaged({
      accountId,
      dek: dek.key,
      items: items.map((item) => ({
        context: managedContextOf(item.context, input.userId),
        plaintext: item.plaintext,
      })),
    })
    const columns: Record<string, Buffer | number> = {
      contentKeyWrapped: sealed.contentKeyWrapped,
      encKeyId: dek.keyVersion,
      encVersion: MAILBOX_MANAGED_ENC_VERSION,
    }
    for (let i = 0; i < items.length; i++) {
      columns[(items[i] as (typeof items)[number]).column] = sealed.items[i] as Buffer
    }
    return { columns, retainedHeaders, keyId: dek.keyVersion }
  } finally {
    dek.key.fill(0)
  }
}

// ── Account resolution ───────────────────────────────────────────────────────

export type MailboxWriteErrorCode =
  | "MAILBOX_ACCOUNT_NOT_FOUND"
  | "RECIPIENT_MISMATCH"
  | "MAILBOX_ENCRYPTION_NOT_READY"
  | "MAILBOX_PLAINTEXT_DRAFT_REFUSED"

/** A refusal to write, raised INSTEAD of writing plaintext. Never swallowed. */
export class MailboxWriteError extends Error {
  readonly code: MailboxWriteErrorCode
  constructor(code: MailboxWriteErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "MailboxWriteError"
    this.code = code
  }
}

export interface MailAccountCrypto {
  id: string
  ownerType: string
  ownerId: string | null
  encryptionState: string
  /**
   * Whether the Invariant P trigger is ARMED for this account, read from the
   * same `mailbox_invariant_armed` SECURITY DEFINER helper the trigger itself
   * calls.
   *
   * This, not `encryption_state`, is what decides whether a writer must seal.
   * Arming is the existence of an active identity for the owner, or an owner
   * who has ever enrolled (a reset mailbox, whose keyring is gone until the
   * owner enrolls again, stays armed and so refuses every write), deliberately,
   * so that one UPDATE of `encryption_state` cannot disarm the database
   * guarantee. If the writers keyed on the column instead, the two layers could
   * disagree, and every such disagreement is either a raw
   * `mailbox_plaintext_forbidden` from Postgres or a plaintext row. Reading the
   * same predicate makes disagreement impossible.
   */
  armed: boolean
}

/** Anything that can run raw SQL: an RLS request tx or a privileged handle. */
export interface MailboxSqlExecutor {
  execute(query: unknown): Promise<unknown>
}

/**
 * Read the account's owner and encryption state through the CALLER'S
 * transaction, deliberately.
 *
 * A separate privileged connection would not see an account row the caller
 * created in its own uncommitted transaction, and would also let a writer that
 * cannot see the account seal anyway. Resolving through the caller's session
 * means an invisible account produces `MAILBOX_ACCOUNT_NOT_FOUND` and the write
 * is refused, which fails closed. Every real writer has already read this row.
 */
export async function resolveMailAccountCrypto(
  tx: MailboxSqlExecutor,
  schemaName: string,
  orgId: string,
  accountId: string,
): Promise<MailAccountCrypto> {
  const schema = quoteIdent(schemaName)
  // Hold the account row FOR SHARE until the caller's transaction ends, as the
  // page writer does: a mailbox moving between encryption modes takes it FOR
  // UPDATE to recount and flip (mode-switch.ts), so a row this writer seals in
  // the format it reads below is either committed before that recount or
  // written after the flip, in the new format. Taken through the schema's
  // SECURITY DEFINER helper: a row lock under RLS would need the UPDATE policy.
  await tx.execute(
    drizzleSql`SELECT ${drizzleSql.raw(`${schema}.mail_lock_account`)}(${orgId}::uuid, ${accountId}::uuid)`,
  )
  const rows = extractRows<{
    id: string
    owner_type: string
    owner_id: string | null
    encryption_state: string | null
    armed: boolean | null
  }>(
    await tx.execute(drizzleSql`
      SELECT a.id::text AS id, a.owner_type, a.owner_id::text AS owner_id, a.encryption_state,
             ${drizzleSql.raw(`${schema}.mailbox_invariant_armed`)}(a.id) AS armed
        FROM ${drizzleSql.raw(schema)}.accounts a
       WHERE a.id = ${accountId}::uuid AND a.org_id = ${orgId}::uuid
       LIMIT 1`),
  )
  const row = rows[0]
  if (!row) {
    throw new MailboxWriteError(
      "MAILBOX_ACCOUNT_NOT_FOUND",
      `mail account ${accountId} is not visible to this writer, refusing to write`,
    )
  }
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    encryptionState: row.encryption_state ?? "none",
    armed: row.armed === true,
  }
}

/**
 * Does this account's content have to be sealed?
 *
 * The answer is the TRIGGER'S OWN predicate, not `encryption_state`: a personal
 * mailbox whose owner holds an active identity is armed, and anything written
 * to it in cleartext raises. Keying on the column instead would leave a real
 * gap, a mailbox still at `none` or `pending_enrollment` whose owner has since
 * enrolled, where the writer would send plaintext into an armed table and the
 * user would see a bare Postgres error.
 *
 * `blocked` and `paused` are armed too and have no usable seal path; their
 * writers refuse through `assertMailboxWritable`, which runs first.
 */
export function mailboxRequiresSealing(account: MailAccountCrypto): boolean {
  return account.ownerType === "user" && (account.armed || account.encryptionState === "managed")
}

/**
 * Refuse a content write that cannot be sealed. Call this before every write of
 * a guarded column on a personal mailbox.
 */
export function assertMailboxWritable(account: MailAccountCrypto, operation: string): void {
  if (account.ownerType !== "user") return
  if (account.encryptionState === "blocked" || account.encryptionState === "paused") {
    throw new MailboxWriteError(
      "MAILBOX_ENCRYPTION_NOT_READY",
      `${operation} refused: mailbox ${account.id} is "${account.encryptionState}" and cannot be sealed to. ` +
        "Writing plaintext instead is forbidden.",
    )
  }
}

/**
 * Refuse to seal to anyone but the mailbox owner.
 *
 * This is the check that stops a compromised or buggy handler from redirecting
 * a seal at another org member's public key. The acting user comes from the
 * captured execution context; the recipient comes from the account row; they
 * must be the same person.
 */
export function assertSealRecipient(account: MailAccountCrypto, actingUserId: string): string {
  if (account.ownerType !== "user" || !account.ownerId) {
    throw new MailboxWriteError(
      "RECIPIENT_MISMATCH",
      `mail account ${account.id} is not a personal mailbox and has no seal recipient`,
    )
  }
  if (account.ownerId !== actingUserId) {
    throw new MailboxWriteError(
      "RECIPIENT_MISMATCH",
      `mail account ${account.id} is owned by another user; refusing to seal to a recipient the caller does not own`,
    )
  }
  return account.ownerId
}

/**
 * Is this acting identity a headless HOST actor rather than a human?
 *
 * `runtime.ts` builds a job's bridge actor as `payload._userId ?? "system:<app>:<job>"`,
 * and `enqueueJob` refuses to stamp `_userId` when the enqueuing actor is itself
 * a system actor, so every scheduled mail sync, every Gmail push and every
 * page-chain re-enqueue arrives here as the literal string "system:mail:<job>".
 * A human actor is always a uuid, so the two spaces cannot collide.
 */
export function isSystemMailActor(actingUserId: string): boolean {
  return actingUserId === "system" || actingUserId.startsWith("system:")
}

/**
 * Resolve the identity a seal must be addressed to, for a caller that may be
 * headless.
 *
 * Inbound mail is delivered by a job, not by the person it belongs to, so
 * requiring the actor to BE the owner would mean an enrolled mailbox could
 * never ingest anything: `assertSealRecipient` would throw on every sync and
 * the mailbox would stop receiving mail permanently.
 *
 * The recipient is still never a parameter. It is read from the account row on
 * the host side of the sandbox boundary, so a headless caller gets exactly one
 * choice of recipient, the owner, and a human caller who is not the owner is
 * refused by `assertSealRecipient` exactly as before. A shared mailbox has no
 * seal recipient for anyone, system actor included.
 */
export function resolveSealRecipient(account: MailAccountCrypto, actingUserId: string): string {
  if (account.ownerType !== "user" || !account.ownerId) {
    throw new MailboxWriteError(
      "RECIPIENT_MISMATCH",
      `mail account ${account.id} is not a personal mailbox and has no seal recipient`,
    )
  }
  if (isSystemMailActor(actingUserId)) return account.ownerId
  return assertSealRecipient(account, actingUserId)
}

// ── Applying a seal to a row that already exists ─────────────────────────────
//
// The sandbox bridge mints the row id itself (`mailbox_sealAndInsert`), because
// the sandbox cannot be trusted to choose primary keys. The privileged
// non-sandboxed writers in `modules/mail/service.ts` and the two host-side mail
// bridge methods already build their own INSERTs, so they take the other route:
// INSERT with every guarded plaintext column NULL, which the Invariant P
// trigger permits, then seal against the id the INSERT returned and UPDATE the
// ciphertext columns in the SAME transaction.
//
// That ordering is safe precisely because both statements are one transaction:
// a seal failure after the insert throws, the transaction rolls back, and no
// row is left behind. What is FORBIDDEN, and impossible here, is committing a
// plaintext row and sealing later.

export interface ApplyMailSealInput {
  schemaName: string
  orgId: string
  /** The mailbox owner, already checked against the acting user. */
  userId: string
  entity: MailboxSealEntity
  rowId: string
  values: Partial<Record<string, string | null | undefined>>
  headers?: Record<string, unknown> | null
  /** The mailbox, so a `managed` one seals in its own format. */
  account?: Pick<MailAccountCrypto, "id" | "encryptionState">
}

/**
 * Seal `values` against `rowId` and write the ciphertext columns onto that row.
 * Throws rather than writing anything if the seal fails.
 */
export async function applyMailSealToRow(
  tx: MailboxSqlExecutor,
  input: ApplyMailSealInput,
): Promise<SealMailFieldsResult> {
  const sealed = await sealMailFields({
    userId: input.userId,
    orgId: input.orgId,
    entity: input.entity,
    entityId: input.rowId,
    values: input.values,
    headers: input.headers ?? null,
    account: input.account,
  })
  const assignments = Object.entries(sealed.columns).map(
    ([name, value]) => drizzleSql`${drizzleSql.raw(quoteIdent(snakeCaseColumn(name)))} = ${value}`,
  )
  if (input.entity === "messages") {
    assignments.push(
      drizzleSql`raw_headers = ${JSON.stringify(sealed.retainedHeaders ?? {})}::jsonb`,
    )
  }
  await tx.execute(drizzleSql`
    UPDATE ${drizzleSql.raw(quoteIdent(input.schemaName))}.${drizzleSql.raw(quoteIdent(input.entity))}
       SET ${drizzleSql.join(assignments, drizzleSql.raw(", "))}
     WHERE id = ${input.rowId}::uuid AND org_id = ${input.orgId}::uuid`)
  return sealed
}

/**
 * Point a conversation's derived fields at one of its messages.
 *
 * A sealed conversation never holds ciphertext of its own: its subject and
 * snippet are the SAME bytes as the source message's, under the same content
 * key, and `snippet_source_message_id` records which message so the client
 * rebuilds `mail.message:<field>:<messageId>` as the AAD. That is what lets
 * `recomputeConversationState` refresh a conversation later with no key
 * material anywhere in reach.
 */
export async function pointConversationAtMessage(
  tx: MailboxSqlExecutor,
  schemaName: string,
  orgId: string,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const schema = drizzleSql.raw(quoteIdent(schemaName))
  await tx.execute(drizzleSql`
    UPDATE ${schema}.conversations c
       SET snippet = NULL,
           subject = NULL,
           snippet_ciphertext = m.snippet_ciphertext,
           subject_ciphertext = m.subject_ciphertext,
           content_key_wrapped = m.content_key_wrapped,
           content_key_epk = m.content_key_epk,
           enc_key_id = m.enc_key_id,
           enc_version = m.enc_version,
           snippet_source_message_id = m.id,
           updated_at = now()
      FROM ${schema}.messages m
     WHERE m.id = ${messageId}::uuid
       AND c.id = ${conversationId}::uuid
       AND c.org_id = ${orgId}::uuid`)
}

/** camelCase manifest field -> snake_case column. */
function snakeCaseColumn(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}
