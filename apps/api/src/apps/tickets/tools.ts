// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { cancelSilentCloseCards, silentStepRefusal } from "~/apps/tickets/close-silent"
import { displayHandleFor, loadSegmentConfig } from "~/apps/tickets/display-handle"
import { loadTicketParties } from "~/apps/tickets/participants"
import {
  plainTextToHtml,
  type RenderPriorMessage,
  renderTicketEmail,
  ticketEmailLocale,
} from "~/apps/tickets/render"
import { resolveTicketRef } from "~/apps/tickets/resolve-ticket-ref"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { OutboundError, type OutboundProvider, sendOutbound } from "~/apps/tickets/send"
import { validateAndApply } from "~/apps/tickets/state-machine"
import { applyTeamPlaceholder } from "~/apps/tickets/team-placeholder"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { emailBody } from "~/lib/email/email-body"
import type { OutboundEmailAttachment, StructuredEmail } from "~/lib/email/types"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { UUID_RE } from "~/lib/uuid"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { cancelApprovalsForSourceTicket } from "~/modules/approvals/cancel"
import {
  getCredentialsForConnection,
  getTokenForConnection,
} from "~/modules/apps/connections/service"
import { smtpSend } from "~/modules/apps/sandbox/smtp-bridge"
import { assertDemoEgressAllowed, DemoRestrictionError } from "~/modules/demo/demo-egress"
import { demoFixtureMessageId, isDemoFixtureDelivery } from "~/modules/demo/fixture-delivery"
import {
  attachFilesToParent,
  attachFileToParent,
  isBlockedStoredFile,
} from "~/modules/files/attach"
import { FileServiceError } from "~/modules/files/service"
import { serverT } from "~/modules/i18n/server-i18n"

const log = rootLogger.child({ module: "tickets-tools" })

// System actor used for server-initiated sends that have no human/agent
// caller (e.g. the ticket-creation acknowledgement) — same nil-UUID sentinel
// used elsewhere for system-attributed rows (create.ts, inbound.ts).
const SYSTEM_ACTOR = {
  actorType: "system" as const,
  userId: "00000000-0000-0000-0000-000000000000",
}

/** Caps for the files one ticket message carries (a reply, a new ticket's
 *  first message, a note): model-proofing a runaway agent and bounding how
 *  much the API process buffers in memory for an outbound MIME. */
const MAX_OUTBOUND_ATTACHMENTS = 10
const MAX_OUTBOUND_PER_FILE_BYTES = 25 * 1024 * 1024
const MAX_OUTBOUND_TOTAL_BYTES = 35 * 1024 * 1024

interface AttachableFile {
  id: string
  filename: string
  mimeType: string
  storageKey: string
  sizeBytes: number
}

/**
 * Resolve caller-supplied file ids for a ticket message and refuse any the
 * caller may not attach. Each file is read under the caller's RLS context and
 * bound to the org (so only what the caller can see is attachable), checked
 * against the stored-file denylist, and counted against the per-message caps.
 * Throws a `FileServiceError` on the first refusal and writes nothing.
 */
export async function resolveAttachableFiles(
  ctx: { tx: Pick<RlsClient, "execute">; orgId: string },
  fileIds: string[],
): Promise<AttachableFile[]> {
  if (fileIds.length > MAX_OUTBOUND_ATTACHMENTS) {
    throw new FileServiceError(
      "FILE_TOO_LARGE",
      `Too many attachments on one message (max ${MAX_OUTBOUND_ATTACHMENTS})`,
    )
  }
  const out: AttachableFile[] = []
  let cumulative = 0
  for (const fileId of fileIds) {
    // A malformed id is not visible: answer it like one, never a uuid cast error.
    if (!UUID_RE.test(fileId)) {
      throw new FileServiceError("PARENT_NOT_FOUND", `Attachment not visible: ${fileId}`)
    }
    const row = extractRows<{
      filename: string
      mime_type: string
      storage_key: string
      size_bytes: number | string
    }>(
      await ctx.tx.execute(drizzleSql`
        SELECT filename, mime_type, storage_key, size_bytes
        FROM ${kernelRel("files")}
        WHERE id = ${fileId} AND org_id = ${ctx.orgId}
        LIMIT 1`),
    )[0]
    if (!row) {
      throw new FileServiceError("PARENT_NOT_FOUND", `Attachment not visible: ${fileId}`)
    }
    if (
      await isBlockedStoredFile(ctx.orgId, {
        id: fileId,
        filename: row.filename,
        mimeType: row.mime_type,
      })
    ) {
      throw new FileServiceError(
        "UNSAFE_FILE_TYPE",
        `File type not allowed as an attachment: ${row.filename}`,
      )
    }
    const sizeBytes = Number(row.size_bytes)
    if (sizeBytes > MAX_OUTBOUND_PER_FILE_BYTES) {
      throw new FileServiceError(
        "FILE_TOO_LARGE",
        `Attachment exceeds ${MAX_OUTBOUND_PER_FILE_BYTES} bytes: ${row.filename}`,
      )
    }
    cumulative += sizeBytes
    if (cumulative > MAX_OUTBOUND_TOTAL_BYTES) {
      throw new FileServiceError(
        "FILE_TOO_LARGE",
        `Cumulative attachment size exceeds ${MAX_OUTBOUND_TOTAL_BYTES} bytes`,
      )
    }
    out.push({
      id: fileId,
      filename: row.filename,
      mimeType: row.mime_type,
      storageKey: row.storage_key,
      sizeBytes,
    })
  }
  return out
}

/**
 * Copy files a caller resolved with `resolveAttachableFiles` onto a ticket
 * message (the `tickets` `message` fileParent), one `attachFileToParent` each,
 * so they show as that message's attachments. `rlsTx` must be the transaction
 * that inserted the message, so the new row is visible to the parent check.
 * The destination write scope is checked against `operatingScopes` when the
 * caller passes them (a declared cross-app dispatch operates as `tickets:*`;
 * the calling app never holds tickets scopes itself), else `scopes`.
 */
export async function attachFilesToTicketMessage(
  rlsTx: RlsClient,
  actor: {
    actorType: "user" | "agent" | "system" | "mcp"
    userId: string
    scopes?: string[]
    operatingScopes?: string[]
  },
  orgId: string,
  fileIds: string[],
  messageId: string,
): Promise<void> {
  for (const sourceFileId of fileIds) {
    await attachFileToParent(
      { sourceFileId, target: { app: "tickets", entityType: "message", entityId: messageId } },
      {
        rlsTx,
        privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
        orgId,
        userId: actor.userId,
        actorType: actor.actorType,
        scopes: actor.operatingScopes ?? actor.scopes ?? [],
      },
    )
  }
}

/**
 * Load agent-supplied attachment file ids as outbound email parts: the checks
 * of `resolveAttachableFiles`, then the bytes, base64 for the outbound MIME.
 */
async function loadOutboundAttachments(
  ctx: ToolCtx,
  fileIds: string[],
): Promise<OutboundEmailAttachment[]> {
  const resolved = await resolveAttachableFiles(ctx, fileIds)
  const { getObjectBytes } = await import("~/lib/storage/get-object-bytes")
  const out: OutboundEmailAttachment[] = []
  let cumulative = 0
  for (const file of resolved) {
    // Size-capped read: never buffer an unbounded object into memory.
    const { bytes } = await getObjectBytes(file.storageKey, {
      maxBytes: MAX_OUTBOUND_PER_FILE_BYTES,
    })
    cumulative += bytes.byteLength
    if (cumulative > MAX_OUTBOUND_TOTAL_BYTES) {
      throw new FileServiceError(
        "FILE_TOO_LARGE",
        `Cumulative attachment size exceeds ${MAX_OUTBOUND_TOTAL_BYTES} bytes`,
      )
    }
    out.push({
      filename: file.filename,
      mimeType: file.mimeType,
      content: bytes.toString("base64"),
      disposition: "attachment",
    })
  }
  return out
}

type ToolCtx = {
  tx: RlsClient
  orgId: string
  actor: { actorType: "user" | "agent" | "system" | "mcp"; userId: string; scopes?: string[] }
  /** Who APPROVED this call, when it arrived through the gated approval flow.
   *  The kernel sets it on every app context (createAppContext); an approved
   *  handler executes as the REQUESTER, so `actor.userId` is the drafter and
   *  this is the authoriser. Null/absent on a direct call. */
  approverUserId?: string | null
  /** The routine this call came from. A routine executes as its OWNER, so
   *  `actor.userId` is whoever created it, not an actor who chose to send. */
  originRoutineId?: string
  /** The agent that drafted this call. It, not the human the call executes as,
   *  is the author of what gets sent. Null/absent when no agent acted. */
  actingAgentId?: string | null
  /** The approval this call executes, on an approved re-entry. Null/absent on a direct call. */
  approvalRequestId?: string | null
}

// Gated tools have already passed scope + approval gates; the mutation runs
// under the privileged role so message INSERT and ticket UPDATE bypass per-row
// RLS policies that the requester role doesn't satisfy directly.
async function withCtxPrivileged<T>(
  ctx: ToolCtx,
  fn: (db: PrivilegedDb) => Promise<T>,
): Promise<T> {
  return withPrivilegedDb(ctx.orgId, "tickets-tool-action", fn)
}

export type ToolError = {
  code: string
  retryable: boolean
  message: string
  /** Approving the same request again can never pass: the approval is closed, not re-pended. */
  final?: boolean
}

export type ToolResult =
  | {
      ok: true
      messageId?: string | null
      externalMessageId?: string | null
      status?: string
      ambiguous?: boolean
    }
  | { error: ToolError }

/** The ticket row every gated tool preflights against. */
export type LoadedTicket = {
  id: string
  handle: string
  subject: string
  status: string
  reply_token: string
  source_inbox_id: string | null
  source_account_id: string | null
  last_outbound_at: Date | null
  last_inbound_at: Date | null
  nudge_sent_at: Date | null
  ack_sent_at: Date | null
  closed_reason: string | null
  merged_into_ticket_id: string | null
  converted_to_mail_conversation_id: string | null
  team: string | null
  sensitivity: string | null
  language?: string | null
}

/**
 * Resolve a caller-supplied ticket ref (uuid OR `ticket-<n>` handle) and load
 * the row. Returns the module's typed tool error instead of letting a handle
 * or a garbage id reach the uuid column and throw in the driver.
 */
async function loadTicket(
  tx: RlsClient,
  orgId: string,
  ticketRef: string,
): Promise<{ ok: true; ticket: LoadedTicket } | { ok: false; error: ToolError }> {
  const ref = await resolveTicketRef(tx, orgId, ticketRef)
  if (!ref.ok) return { ok: false, error: ref.error }
  const ticketId = ref.ticketId
  const r = await tx.execute(drizzleSql`
    SELECT id, handle, subject, status, reply_token, source_inbox_id, source_account_id,
           last_outbound_at, last_inbound_at, nudge_sent_at, ack_sent_at,
           closed_reason, merged_into_ticket_id, converted_to_mail_conversation_id,
           team, sensitivity, language
    FROM ${ticketsRel("tickets")}
    WHERE id = ${ticketId} AND org_id = ${orgId}
    LIMIT 1
  `)
  const ticket = extractRows<LoadedTicket>(r)[0]
  if (!ticket) {
    return {
      ok: false,
      error: { code: "not_found", retryable: false, message: "ticket not found" },
    }
  }
  return { ok: true, ticket }
}

function preflightCommon(ticket: {
  merged_into_ticket_id: string | null
  converted_to_mail_conversation_id: string | null
  closed_reason: string | null
  status: string
}): { ok: false; error: { code: string; retryable: boolean; message: string } } | { ok: true } {
  if (ticket.merged_into_ticket_id) {
    return {
      ok: false,
      error: { code: "merged_ticket", retryable: false, message: "ticket merged" },
    }
  }
  if (ticket.converted_to_mail_conversation_id) {
    return {
      ok: false,
      error: { code: "converted_ticket", retryable: false, message: "ticket converted" },
    }
  }
  return { ok: true }
}

function hasBody(params: { htmlBody?: string; textBody?: string }): boolean {
  return Boolean(params.htmlBody?.trim() || params.textBody?.trim())
}

/** Most CC addresses one reply may carry. */
const MAX_REPLY_CC = 10
const CC_ADDRESS_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

/**
 * Validate and normalize a reply's `cc` list: trimmed, de-duplicated (case
 * insensitive), every entry a plain address. Returns the list, or an error
 * message naming the first bad entry.
 */
export function normalizeReplyCc(
  cc: unknown,
): { ok: true; cc: string[] } | { ok: false; message: string } {
  if (cc === undefined || cc === null) return { ok: true, cc: [] }
  if (!Array.isArray(cc)) return { ok: false, message: "cc must be an array of email addresses" }
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of cc) {
    if (typeof raw !== "string") {
      return { ok: false, message: "cc must be an array of email addresses" }
    }
    const addr = raw.trim()
    if (!addr) continue
    if (!CC_ADDRESS_RE.test(addr)) return { ok: false, message: `invalid cc address: ${addr}` }
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(addr)
  }
  if (out.length > MAX_REPLY_CC) {
    return { ok: false, message: `too many cc addresses (max ${MAX_REPLY_CC})` }
  }
  return { ok: true, cc: out }
}

/** The CC header a send carries: the requested list minus the To recipients
 *  and every address of our own (any of the org's ticket inboxes, its reply
 *  from and reply to addresses): a reply never copies us or repeats To. */
function effectiveCc(
  cc: string[] | undefined,
  to: StructuredEmail["to"],
  ownAddresses: Array<string | null | undefined>,
): string[] {
  const skip = new Set(
    [...to.map((a) => (typeof a === "string" ? a : a.email)), ...ownAddresses]
      .filter((a): a is string => Boolean(a))
      .map((a) => a.toLowerCase()),
  )
  return (cc ?? []).filter((a) => !skip.has(a.toLowerCase()))
}

/** Every address the org's ticket inboxes send or receive as. */
async function loadOrgInboxAddresses(db: PrivilegedDb, orgId: string): Promise<string[]> {
  const rows = extractRows<{
    email_address: string | null
    reply_from_email: string | null
    reply_to_email: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT email_address, reply_from_email, reply_to_email
      FROM ${ticketsRel("inboxes")} WHERE org_id = ${orgId}`),
  )
  return rows
    .flatMap((r) => [r.email_address, r.reply_from_email, r.reply_to_email])
    .filter((a): a is string => Boolean(a))
}

/**
 * The files staged on a composer upload session, checked to belong to THIS
 * ticket before anything is sent: the session must be the caller's own, still
 * open, and started on this ticket (target tickets / ticket / <ticketId>, what
 * the ticket composer creates). A session started anywhere else (another
 * ticket, a Drive import, a mail draft) is refused, so no file staged for one
 * customer can ride a reply to another.
 */
export async function resolveTicketUploadSession(
  ctx: ToolCtx,
  sessionId: string,
  ticketId: string,
): Promise<{ ok: true; fileIds: string[] } | { ok: false; error: ToolError }> {
  const sessions = extractRows<{
    target_app: string
    target_entity_type: string
    target_entity_id: string | null
    expires_at: Date | string
  }>(
    await ctx.tx.execute(drizzleSql`
      SELECT target_app, target_entity_type, target_entity_id, expires_at
      FROM ${kernelRel("file_upload_sessions")}
      WHERE id::text = ${sessionId} AND org_id = ${ctx.orgId} AND created_by = ${ctx.actor.userId}
      LIMIT 1`),
  )
  const session = sessions[0]
  const fileIds = session
    ? extractRows<{ id: string }>(
        await ctx.tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${kernelRel("files")}
          WHERE org_id = ${ctx.orgId}
            AND app = 'kernel' AND entity_type = 'file_upload_session'
            AND entity_id = ${sessionId}
          ORDER BY created_at, id`),
      ).map((r) => r.id)
    : []
  if (!session || fileIds.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_attachment_session",
        retryable: false,
        message:
          `attachmentSessionId "${sessionId}" matched no staged upload with ` +
          "files. Do NOT pass another action's approval-request id, a draft id, a Drive file id, " +
          "a URL, or a filename here. To attach a file from an external source, import it first to " +
          "get a Liaison file id and pass that id in the reply's `attachments` array; to send a " +
          "plain reply, leave `attachmentSessionId` and `attachments` empty.",
      },
    }
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    return {
      ok: false,
      error: {
        code: "session_expired",
        retryable: false,
        message: "The staged files expired. Attach them again.",
      },
    }
  }
  if (
    session.target_app !== "tickets" ||
    session.target_entity_type !== "ticket" ||
    session.target_entity_id !== ticketId
  ) {
    return {
      ok: false,
      error: {
        code: "attachment_session_other_ticket",
        retryable: false,
        message:
          "These staged files were not attached on this ticket, so they are not sent with its " +
          "reply. Attach the files again from this ticket's reply box (reload the page if it was " +
          "open before an update), or pass Liaison file ids in `attachments`.",
      },
    }
  }
  return { ok: true, fileIds }
}

/**
 * Move a ticket-bound session's files onto the message they were sent with.
 * The session was checked by resolveTicketUploadSession (owner, open, this
 * ticket); this only re-checks that each file is still staged on it.
 */
export async function moveTicketSessionFiles(
  orgId: string,
  sessionId: string,
  fileIds: string[],
  messageId: string,
): Promise<void> {
  if (fileIds.length === 0) return
  const idList = drizzleSql.join(
    fileIds.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  await withPrivilegedDb(orgId, "tickets-move-session-files", (db) =>
    db.execute(drizzleSql`
      UPDATE ${kernelRel("files")}
      SET app = 'tickets', entity_type = 'message', entity_id = ${messageId}
      WHERE org_id = ${orgId}
        AND app = 'kernel' AND entity_type = 'file_upload_session' AND entity_id = ${sessionId}
        AND id::text IN (${idList})`),
  )
}

// Exported for tests: resolves the effective send identity + transport for a
// ticket's source inbox (see the API-inbox reply-from decoupling).
export async function loadInboxAndProvider(db: PrivilegedDb, orgId: string, inboxId: string) {
  // Load the ticket's SOURCE inbox first. It may be an API bucket (kind='api',
  // no connected account) whose replies must be sent through a reply-via mailbox
  // rather than an account of its own -- this is the inbox<->reply-from decoupling.
  const src = extractRows<{
    id: string
    kind: string
    email_address: string | null
    from_display_name: string | null
    reply_from_email: string | null
    reply_via_inbox_id: string | null
    connected_account_id: string | null
    reply_to_email: string | null
    signature_html: string | null
    signature_text: string | null
    ack_enabled: boolean
    ack_body_text: string | null
    sla_promise_phrase: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT id, kind, email_address, from_display_name, reply_from_email,
             reply_via_inbox_id, connected_account_id,
             reply_to_email, signature_html, signature_text,
             ack_enabled, ack_body_text, sla_promise_phrase
      FROM ${ticketsRel("inboxes")}
      WHERE id = ${inboxId} AND org_id = ${orgId} AND archived_at IS NULL
      LIMIT 1
    `),
  )[0]
  if (!src) return null

  // Resolve the mailbox that actually SENDS. A mailbox inbox sends through
  // itself (unchanged behaviour). An API bucket sends through its explicit
  // reply_via_inbox_id, else the org's default-for-create mailbox -- so an org
  // keeps one reply-from identity (e.g. support@) across every bucket.
  const isApi = src.kind === "api"
  const send = extractRows<{
    email_address: string
    from_display_name: string | null
    connection_name: string
    provider_type: "oauth2" | "credentials"
    identifier: string
  }>(
    await db.execute(
      !isApi
        ? drizzleSql`
            SELECT i.email_address, i.from_display_name,
                   ca.connection_name, ca.provider_type, ca.identifier
            FROM ${ticketsRel("inboxes")} i
            JOIN ${kernelRel("connected_accounts")} ca ON ca.id = i.connected_account_id
            WHERE i.id = ${src.id} AND i.org_id = ${orgId} AND i.archived_at IS NULL
              AND ca.org_id = ${orgId} AND ca.status = 'active'
            LIMIT 1
          `
        : src.reply_via_inbox_id
          ? drizzleSql`
              SELECT i.email_address, i.from_display_name,
                     ca.connection_name, ca.provider_type, ca.identifier
              FROM ${ticketsRel("inboxes")} i
              JOIN ${kernelRel("connected_accounts")} ca ON ca.id = i.connected_account_id
              WHERE i.id = ${src.reply_via_inbox_id} AND i.org_id = ${orgId} AND i.archived_at IS NULL
                AND i.kind = 'mailbox'
                AND ca.org_id = ${orgId} AND ca.status = 'active'
              LIMIT 1
            `
          : drizzleSql`
              SELECT i.email_address, i.from_display_name,
                     ca.connection_name, ca.provider_type, ca.identifier
              FROM ${ticketsRel("inboxes")} i
              JOIN ${kernelRel("connected_accounts")} ca ON ca.id = i.connected_account_id
              WHERE i.org_id = ${orgId} AND i.archived_at IS NULL AND i.kind = 'mailbox'
                AND ca.org_id = ${orgId} AND ca.status = 'active'
              ORDER BY i.is_default_for_create DESC, i.created_at ASC
              LIMIT 1
            `,
    ),
  )[0]
  if (!send) return null

  return {
    // Keep the ticket's own source-inbox id (reply_token/messageId domain use it).
    id: src.id,
    // From identity: an API bucket may override (reply_from_email), else it
    // inherits the sending mailbox's address; a mailbox inbox uses its own.
    email_address: isApi ? (src.reply_from_email ?? send.email_address) : send.email_address,
    from_display_name: isApi
      ? (src.from_display_name ?? send.from_display_name)
      : send.from_display_name,
    // Transport always comes from the resolved sending mailbox's account.
    connection_name: send.connection_name,
    provider_type: send.provider_type,
    identifier: send.identifier,
    // Per-inbox ("virtual mailbox") email identity/config (Task 1) — always
    // read from the SOURCE inbox (the ticket's own bucket), not the resolved
    // sending mailbox, since this is per-inbox configuration even for an API
    // bucket that sends its mail through a different mailbox's transport.
    reply_to_email: src.reply_to_email,
    signature_html: src.signature_html,
    signature_text: src.signature_text,
    ack_enabled: src.ack_enabled,
    ack_body_text: src.ack_body_text,
    sla_promise_phrase: src.sla_promise_phrase ?? DEFAULT_SLA_PROMISE_EN,
  }
}

async function loadActor(db: PrivilegedDb, orgId: string, userId: string) {
  const r = await db.execute(drizzleSql`
    SELECT name
    FROM ${kernelRel("users")}
    WHERE id = ${userId} AND org_id = ${orgId}
    LIMIT 1
  `)
  const row = extractRows<{ name: string }>(r)[0]
  return {
    id: userId,
    name: row?.name ?? "Support",
  }
}

/**
 * Resolve the signature a reply from this ticket's inbox SHOULD carry, as
 * plain text plus derived safe HTML. Precedence: the inbox's configured
 * signature text, else `routineNameOverride` when the draft came from a
 * routine, else the acting user's personal signature
 * (users.settings.tickets.signature.text). This is the single source for both
 * the composer prefill (tickets_get -> composeSignatureText) and the agent
 * draft injection (tools.draftSignature) — the send path no longer appends
 * any signature, so a reply body ships exactly as composed/approved.
 *
 * `routineNameOverride`: a routine executes as its owner, so without this the
 * personal-signature fallback below signs every routine-drafted reply with
 * the routine's OWNER name — every routine reply then visibly reads as
 * written by that person, to the customer and to the person themselves
 * (ticket 10309). Pass the routine's own name so a routine-drafted reply
 * signs as the routine, not the human who happens to have created it. A
 * human-composed reply never passes this and keeps signing as that human.
 *
 * `team` is the ticket's team: it fills `{{team}}` in the
 * inbox signature.
 */
export async function loadEffectiveSignature(
  db: PrivilegedDb,
  orgId: string,
  inboxId: string | null,
  userId: string,
  routineNameOverride?: string | null,
  team?: string | null,
): Promise<{ text: string; html: string } | null> {
  let inboxText: string | null = null
  if (inboxId) {
    const r = await db.execute(drizzleSql`
      SELECT signature_text FROM ${ticketsRel("inboxes")}
      WHERE id = ${inboxId} AND org_id = ${orgId}
      LIMIT 1
    `)
    inboxText = extractRows<{ signature_text: string | null }>(r)[0]?.signature_text ?? null
  }
  let text = applyTeamPlaceholder(inboxText?.trim() ?? "", team)
  if (!text && routineNameOverride?.trim()) {
    text = routineNameOverride.trim()
  }
  // `routineNameOverride === undefined` means "no routine involved" (an
  // ordinary human/system caller) — only then does the personal fallback
  // apply. A routine caller whose name failed to resolve passes `null`
  // here and must NOT fall through to the owner's personal signature.
  if (!text && routineNameOverride === undefined) {
    const r = await db.execute(drizzleSql`
      SELECT settings->'tickets'->'signature'->>'text' AS signature_text
      FROM ${kernelRel("users")}
      WHERE id = ${userId} AND org_id = ${orgId}
      LIMIT 1
    `)
    text = extractRows<{ signature_text: string | null }>(r)[0]?.signature_text?.trim() ?? ""
  }
  if (!text) return null
  return { text, html: plainTextToHtml(text) }
}

/**
 * Non-personal fallback signature when a routine-drafted reply has no inbox
 * signature AND its routine's own name failed to resolve. Must never return
 * empty: an unsigned customer email is a worse regression than a wrong name,
 * so this falls all the way to the org name (never a human's identity).
 */
async function resolveNonPersonalFallbackSignature(
  db: PrivilegedDb,
  orgId: string,
  inboxId: string | null,
  team?: string | null,
): Promise<string | null> {
  if (inboxId) {
    const r = await db.execute(drizzleSql`
      SELECT from_display_name FROM ${ticketsRel("inboxes")}
      WHERE id = ${inboxId} AND org_id = ${orgId}
      LIMIT 1
    `)
    const name = applyTeamPlaceholder(
      extractRows<{ from_display_name: string | null }>(r)[0]?.from_display_name?.trim(),
      team,
    )
    if (name) return name
  }
  const r = await db.execute(drizzleSql`
    SELECT name FROM ${kernelRel("organizations")}
    WHERE id = ${orgId}
    LIMIT 1
  `)
  const orgName = extractRows<{ name: string | null }>(r)[0]?.name?.trim()
  return orgName || null
}

/**
 * Sandbox-facing op behind `tools.draftSignature`: the signature an AGENT
 * draft reply must carry in its body so the approval card shows (and lets the
 * approver edit) exactly what will ship. Returns nulls for human actors —
 * their composer already prefilled the signature, so injecting again would
 * duplicate it.
 */
export async function ticketsDraftSignature(
  params: { ticketId: string },
  ctx: ToolCtx,
): Promise<{ signatureText: string | null; signatureHtml: string | null }> {
  if (ctx.actor.actorType === "user") return { signatureText: null, signatureHtml: null }
  return withCtxPrivileged(ctx, async (db) => {
    const rows = extractRows<{ source_inbox_id: string | null; team: string | null }>(
      await db.execute(drizzleSql`
        SELECT source_inbox_id, team FROM ${ticketsRel("tickets")}
        WHERE id = ${params.ticketId} AND org_id = ${ctx.orgId}
        LIMIT 1
      `),
    )
    const sourceInboxId = rows[0]?.source_inbox_id ?? null
    const team = rows[0]?.team ?? null
    // Routine-drafted replies must sign with the ROUTINE's own name, never
    // the human who happens to own the routine (see loadEffectiveSignature).
    // `ctx.originRoutineId` on the live reply-drafting path comes from the
    // sandbox RPC bridge's `bridgeRoutineId` (rpc-bridge.ts, tickets_admin ->
    // runAdminOp -> here), captured IN-FRAME at bridge-construction time.
    // Deliberately NOT `currentRunContext()?.routineId` here: this call
    // arrives via a host-bridge callback invoked FROM sandbox code, which
    // runs OUTSIDE the ALS frame `currentRunContext()` reads (the same
    // BL-275-class failure the knowledge bridge hit and fixed the same way)
    // -- reading the ALS directly at this call site is silently unreachable
    // in production even though it passes a test that drives the call
    // without crossing the sandbox boundary.
    const routineId = ctx.originRoutineId
    const routineNameOverride = routineId
      ? await resolveRoutineName(db, ctx.orgId, routineId)
      : undefined
    const sig = await loadEffectiveSignature(
      db,
      ctx.orgId,
      sourceInboxId,
      ctx.actor.userId,
      routineNameOverride,
      team,
    )
    if (sig) return { signatureText: sig.text, signatureHtml: sig.html }
    // Routine context (routineNameOverride !== undefined) with NOTHING to
    // sign with — no inbox signature, no resolvable routine name — must still
    // never ship an unsigned email: fall back to the inbox's own display name,
    // then the org name (never the routine owner's personal identity).
    if (routineNameOverride !== undefined) {
      const fallback = await resolveNonPersonalFallbackSignature(db, ctx.orgId, sourceInboxId, team)
      if (fallback) return { signatureText: fallback, signatureHtml: plainTextToHtml(fallback) }
    }
    return { signatureText: null, signatureHtml: null }
  })
}

async function loadOrgSettings(db: PrivilegedDb, orgId: string) {
  const r = await db.execute(drizzleSql`
    SELECT name, settings, default_locale, timezone FROM ${kernelRel("organizations")}
    WHERE id = ${orgId}
    LIMIT 1
  `)
  const row = extractRows<{
    name: string
    settings: Record<string, unknown> | null
    default_locale: string | null
    timezone: string | null
  }>(r)[0]
  const settings = row?.settings ?? {}
  return {
    name: row?.name ?? "Support",
    defaultLocale: row?.default_locale ?? null,
    timezone: row?.timezone ?? null,
    tickets: (settings as { tickets?: unknown }).tickets as never,
  }
}

async function loadPriorMessages(
  db: PrivilegedDb,
  orgId: string,
  ticketId: string,
): Promise<RenderPriorMessage[]> {
  const r = await db.execute(drizzleSql`
    SELECT external_message_id, kind, html_body, text_body, sent_at, from_email, from_name
    FROM ${ticketsRel("messages")}
    WHERE org_id = ${orgId} AND ticket_id = ${ticketId}
    ORDER BY received_at DESC, sent_at DESC, id DESC
    LIMIT 20
  `)
  return extractRows<{
    external_message_id: string | null
    kind: "inbound" | "outbound" | "note"
    html_body: string | null
    text_body: string | null
    sent_at: Date | string
    from_email: string | null
    from_name: string | null
  }>(r).map((m) => ({
    externalMessageId: m.external_message_id,
    kind: m.kind,
    htmlBody: m.html_body,
    textBody: m.text_body,
    sentAt: m.sent_at instanceof Date ? m.sent_at.toISOString() : m.sent_at,
    from: { email: m.from_email ?? "", name: m.from_name },
  }))
}

async function buildProvider(
  db: PrivilegedDb,
  ctx: ToolCtx,
  account: { provider_type: "oauth2" | "credentials"; connection_name: string; identifier: string },
): Promise<OutboundProvider> {
  if (account.provider_type === "oauth2") {
    return {
      kind: "gmail",
      ctx: {
        connections_getToken: (_name, identifier) =>
          getTokenForConnection(
            db as never,
            ctx.orgId,
            ctx.actor.userId,
            "tickets",
            "gmail",
            identifier,
            {
              actorType: "system",
            },
          ),
        // Wrap the global fetch with a per-request timeout so a hung Gmail API
        // call cannot block the outbound reply path indefinitely.
        fetch: Object.assign(
          (
            input: Parameters<typeof globalThis.fetch>[0],
            init?: Parameters<typeof globalThis.fetch>[1],
          ) =>
            globalThis.fetch(input, {
              ...init,
              signal: init?.signal ?? AbortSignal.timeout(30_000),
            }),
          globalThis.fetch,
        ) as typeof globalThis.fetch,
      },
    }
  }

  return {
    kind: "smtp",
    smtpSend: async (accountEmail, message) => {
      const credentials = await getCredentialsForConnection(
        db as never,
        ctx.orgId,
        ctx.actor.userId,
        "tickets",
        account.connection_name,
        accountEmail,
        { actorType: "system" },
      )
      return smtpSend(
        {
          host: credentials.smtpHost,
          port: Number(credentials.smtpPort),
          username: credentials.username,
          password: credentials.password,
        },
        message as never,
      )
    },
  }
}

/**
 * The routine's own name, or null when there is no routine (or its row
 * cannot be read). Shared by the internal author-label attribution below and
 * by the customer-facing signature override in `ticketsDraftSignature`.
 */
async function resolveRoutineName(
  db: PrivilegedDb,
  orgId: string,
  routineId: string,
): Promise<string | null> {
  try {
    const r = await db.execute(drizzleSql`
      SELECT name FROM ${kernelRel("routines")}
      WHERE id = ${routineId} AND org_id = ${orgId}
      LIMIT 1
    `)
    const name = extractRows<{ name: string | null }>(r)[0]?.name
    return name && name.trim() !== "" ? name.trim() : null
  } catch {
    return null
  }
}

/**
 * Display label for a routine-originated send, or null for an ordinary one.
 *
 * A routine executes as its OWNER, so the message's `created_by` is whoever
 * created the routine and NOT an actor who chose to send anything. Attributing
 * the reply to them makes every routine-drafted message read as written by that
 * person, to colleagues and to the person themselves (reported 2026-08-05).
 * Falls back to a generic label when the routine row cannot be read, because a
 * missing name must not silently re-attribute the work to a human.
 */
async function resolveRoutineAuthorLabel(db: PrivilegedDb, ctx: ToolCtx): Promise<string | null> {
  // An agent drafted it: the agent is the author, recorded on author_agent_id
  // and read under its live name. The routine only scheduled the agent's turn.
  if (ctx.actingAgentId) return null
  if (!ctx.originRoutineId) return null
  const name = await resolveRoutineName(db, ctx.orgId, ctx.originRoutineId)
  return name ? `Routine: ${name}` : "Routine"
}

/** The current display name of the agent that drafted this send, or null
 *  when no agent acted (or it is gone from the org). */
async function resolveActingAgentName(db: PrivilegedDb, ctx: ToolCtx): Promise<string | null> {
  if (!ctx.actingAgentId) return null
  const rows = extractRows<{ display_name: string }>(
    await db.execute(drizzleSql`
      SELECT display_name FROM ${kernelRel("agents")}
      WHERE id = ${ctx.actingAgentId} AND org_id = ${ctx.orgId}
      LIMIT 1`),
  )
  return rows[0]?.display_name ?? null
}

async function insertOutboundMessage(
  db: PrivilegedDb,
  ctx: ToolCtx,
  params: {
    ticketId: string
    htmlBody?: string
    textBody?: string
    subject: string
    externalMessageId: string | null
    sentAt: string
    /** Task 2: marks this row as the ticket-creation acknowledgement send so the
     *  frontend can hide it from the rendered conversation (DTO field
     *  `isAcknowledgement`, contract with the frontend). Defaults false — every
     *  ordinary reply/nudge/close send is unmarked, unchanged behaviour. */
    isAcknowledgement?: boolean
    /** Display name to show INSTEAD of the created_by user, when the send did
     *  not really come from that person: a routine executes as its owner, so a
     *  routine-drafted reply would otherwise read as written by whoever created
     *  the routine (reported 2026-08-05). Null for an ordinary human send. */
    authorLabel?: string | null
    /** The From identity the email actually went out with (inbox address +
     *  display name resolved by renderTicketEmail). Persisted so the
     *  conversation view can show the author of outbound rows instead of a
     *  placeholder dash. */
    from?: { email: string; name: string | null }
    /** The envelope the email went out with, so the conversation shows who
     *  was copied. Empty lists when not recorded. */
    to?: string[]
    cc?: string[]
  },
): Promise<string> {
  const result = await db.execute(drizzleSql`
    INSERT INTO ${ticketsRel("messages")} (
      id, org_id, ticket_id, kind, html_body, text_body, snippet, subject,
      from_email, from_name, to_emails, cc_emails,
      external_message_id, sent_at, created_by, approved_by, author_label, author_agent_id, is_acknowledgement, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${ctx.orgId}, ${params.ticketId}, 'outbound',
      ${params.htmlBody ?? null}, ${params.textBody ?? null},
      ${(params.textBody ?? params.htmlBody ?? "").slice(0, 200)}, ${params.subject},
      ${params.from?.email ?? null}, ${params.from?.name ?? null},
      ${JSON.stringify(params.to ?? [])}::jsonb, ${JSON.stringify(params.cc ?? [])}::jsonb,
      ${params.externalMessageId}, ${params.sentAt},
      ${ctx.actor.userId}, ${ctx.approverUserId ?? null}, ${params.authorLabel ?? null}, ${ctx.actingAgentId ?? null}, ${params.isAcknowledgement ?? false}, now(), now()
    )
    RETURNING id
  `)
  // We wrote to the customer: a silence the close-silent routine proposed a
  // step on is over (its own nudge excepted).
  await cancelSilentCloseCards(db, {
    orgId: ctx.orgId,
    ticketId: params.ticketId,
    reason: "we_wrote",
    exceptApprovalId: ctx.approvalRequestId ?? null,
  })
  return extractRows<{ id: string }>(result)[0]!.id
}

async function recordAmbiguousTimeline(
  db: PrivilegedDb,
  ctx: ToolCtx,
  ticketId: string,
  reason: string,
): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO ${kernelRel("timeline_entries")} (
      id, org_id, app, entity_type, entity_id, actor_id, actor_type,
      action, summary, action_label, field_changes, created_at
    ) VALUES (
      gen_random_uuid(), ${ctx.orgId}, 'tickets', 'ticket', ${ticketId}, ${ctx.actor.userId},
      ${ctx.actor.actorType}, 'outbound_ambiguous', 'Outbound email delivery is ambiguous',
      'outbound_ambiguous', ${JSON.stringify({ reason })}::jsonb, now()
    )
  `)
}

/**
 * RFC 3834 loop-suppression headers — for genuinely automatic messages ONLY.
 *
 * `Auto-Submitted: auto-replied` means "generated automatically in response to
 * another message" (RFC 3834 §5). An acknowledgement is exactly that. A reply,
 * a nudge or a closing note is written by a person (or drafted by an agent and
 * approved by one), so stamping it is a false claim about the message, and it
 * costs real deliverability:
 *
 *  - receiving TICKETING systems drop it. Observed 2026-07-28: a desk reply
 *    sent to a mailbox Liaison itself syncs was refused by our own
 *    `detectAutoResponder` on the way back in. A B2B customer running any
 *    helpdesk would never see our answer land on their ticket.
 *  - `Precedence: bulk` is a deprioritisation marker. On a personal support
 *    reply it invites spam filing and Promotions-tab sorting.
 *
 * The out-of-office loop this was added to prevent (517015a3) is already
 * handled where it belongs — on INGEST, by `detectAutoResponder`, which drops
 * an incoming OOO. Defending against it a second time on the way out buys
 * nothing and mislabels every human answer we send.
 */
/** The inbox column default for `sla_promise_phrase` (English). */
const DEFAULT_SLA_PROMISE_EN = "within 2 business days"

export function outboundLoopSuppressionHeaders(
  kind: "reply" | "nudge" | "close" | "acknowledgement",
): Record<string, string> {
  if (kind !== "acknowledgement") return {}
  return { "Auto-Submitted": "auto-replied", Precedence: "bulk" }
}

async function renderAndSend(
  db: PrivilegedDb,
  ctx: ToolCtx,
  ticket: LoadedTicket,
  body: { htmlBody?: string; textBody?: string },
  kind: "reply" | "nudge" | "close",
  attachments: OutboundEmailAttachment[] = [],
  extra: { cc?: string[] } = {},
): Promise<{
  messageId: string | null
  subject: string
  ambiguous?: boolean
  from: { email: string; name: string | null }
  authorName: string
  /** The body as the customer received it, kept on the message row. */
  htmlBody: string
  /** The envelope the email actually went out with, kept on the message row. */
  to: string[]
  cc: string[]
}> {
  // A demo org may write a reply all it likes; it may not put it on the wire.
  // Refused FIRST, before the mailbox lookup: a demo visitor cannot connect a
  // mailbox, so "reconnect the inbox's mail account" would send them to a
  // settings screen that cannot help. The same refusal the mail app's send
  // gets, as a preflight failure, so nothing was sent and the card says why.
  try {
    await assertDemoEgressAllowed(ctx.orgId, "outbound_mail")
  } catch (err) {
    if (!(err instanceof DemoRestrictionError)) throw err
    // A demo scenario's fictional customer: every recipient on a reserved
    // domain, so the reply is recorded as delivered and nothing leaves.
    const fixture = await demoFixtureSend(db, ctx, ticket, body, extra)
    if (fixture) return fixture
    throw new OutboundError("preflight_failed", err.message)
  }
  if (!ticket.source_inbox_id)
    throw new OutboundError("preflight_failed", "ticket has no source inbox")
  const inbox = await loadInboxAndProvider(db, ctx.orgId, ticket.source_inbox_id)
  if (!inbox) {
    // The inbox is archived, or no active mail connection can send for it (its
    // account was disconnected, or an API inbox has no mailbox to reply through).
    // Say what the person can do about it rather than naming internals.
    const hint =
      kind === "close"
        ? "reconnect the inbox's mail account in Settings, or close without a message"
        : "reconnect the inbox's mail account in Settings"
    throw new OutboundError(
      "preflight_failed",
      `No connected mailbox can send this message: ${hint}`,
    )
  }
  const priorMessages = await loadPriorMessages(db, ctx.orgId, ticket.id)
  // The reply goes to the ticket's stored requester (and participants), never to
  // whoever wrote last.
  const parties = await loadTicketParties(db, ctx.orgId, ticket.id)
  if (!parties.requester)
    throw new OutboundError("preflight_failed", "ticket has no customer recipient")
  const agent = await loadActor(db, ctx.orgId, ctx.actor.userId)
  const orgSettings = await loadOrgSettings(db, ctx.orgId)
  const { html, text } = emailBody(body)
  const email: StructuredEmail = await renderTicketEmail(
    {
      id: ticket.id,
      // The email names the ticket by its display handle (`ticket-B2B-12`).
      // Its segment config is read on `db`: no second privileged connection.
      handle:
        (await displayHandleFor(
          db,
          ctx.orgId,
          ticket.id,
          await loadSegmentConfig(ctx.orgId, db),
        )) ?? ticket.handle,
      subject: ticket.subject,
      reply_token: ticket.reply_token,
      language: ticket.language ?? null,
      team: ticket.team,
    },
    { htmlBody: html, textBody: text },
    orgSettings,
    {
      id: inbox.id,
      email_address: inbox.email_address,
      from_display_name: inbox.from_display_name,
      reply_to_email: inbox.reply_to_email,
      signature_html: inbox.signature_html,
      signature_text: inbox.signature_text,
      sla_promise_phrase: inbox.sla_promise_phrase,
    },
    priorMessages,
    { kind, requester: parties.requester, participants: parties.participants },
  )
  const requestedCc = [...parties.participants, ...(extra.cc ?? [])]
  email.cc = requestedCc.length
    ? effectiveCc(requestedCc, email.to, [
        inbox.email_address,
        inbox.identifier,
        ...(await loadOrgInboxAddresses(db, ctx.orgId)),
      ])
    : []
  if (attachments.length > 0) email.attachments = attachments
  const loopHeaders = outboundLoopSuppressionHeaders(kind)
  if (Object.keys(loopHeaders).length > 0) {
    email.headers = {
      ...email.headers,
      extra: { ...email.headers?.extra, ...loopHeaders },
    }
  }
  const provider = await buildProvider(db, ctx, inbox)
  const envelope = {
    to: email.to.map((a) => (typeof a === "string" ? a : a.email)),
    cc: (email.cc ?? []).map((a) => (typeof a === "string" ? a : a.email)),
  }
  try {
    const send = await sendOutbound(email, provider, { accountEmail: inbox.identifier })
    return {
      messageId: send.externalMessageId,
      subject: email.subject,
      from: normalizeFrom(email.from),
      authorName: agent.name,
      htmlBody: html,
      ...envelope,
    }
  } catch (err) {
    if (err instanceof OutboundError && err.reason === "ambiguous") {
      return {
        messageId: null,
        subject: email.subject,
        ambiguous: true,
        from: normalizeFrom(email.from),
        authorName: agent.name,
        htmlBody: html,
        ...envelope,
      }
    }
    throw err
  }
}

/**
 * The fixture delivery of a demo org's reply (modules/demo/fixture-delivery.ts):
 * when every recipient (the requester, the participants, the extra cc) is on a
 * reserved domain, the send is recorded as delivered with no provider and no
 * network; null otherwise (the caller keeps its refusal).
 */
async function demoFixtureSend(
  db: PrivilegedDb,
  ctx: ToolCtx,
  ticket: LoadedTicket,
  body: { htmlBody?: string; textBody?: string },
  extra: { cc?: string[] },
): Promise<Awaited<ReturnType<typeof renderAndSend>> | null> {
  const parties = await loadTicketParties(db, ctx.orgId, ticket.id)
  if (!parties.requester) return null
  const cc = [...parties.participants, ...(extra.cc ?? [])]
  if (!(await isDemoFixtureDelivery(ctx.orgId, [parties.requester, ...cc]))) return null
  const inbox = ticket.source_inbox_id
    ? extractRows<{ reply_from_email: string | null; from_display_name: string | null }>(
        await db.execute(drizzleSql`
          SELECT reply_from_email, from_display_name FROM ${ticketsRel("inboxes")}
          WHERE id = ${ticket.source_inbox_id} AND org_id = ${ctx.orgId} LIMIT 1`),
      )[0]
    : undefined
  const agent = await loadActor(db, ctx.orgId, ctx.actor.userId)
  const { html } = emailBody(body)
  return {
    messageId: demoFixtureMessageId(),
    subject: /^re:/i.test(ticket.subject) ? ticket.subject : `Re: ${ticket.subject}`,
    from: {
      email: inbox?.reply_from_email ?? "support@demo.invalid",
      name: inbox?.from_display_name ?? null,
    },
    authorName: agent.name,
    htmlBody: html,
    to: [parties.requester],
    cc,
  }
}

/** StructuredEmail.from is `string | EmailAddress` — normalize to the persisted
 *  {email, name} shape insertOutboundMessage stores. */
function normalizeFrom(from: StructuredEmail["from"]): { email: string; name: string | null } {
  return typeof from === "string"
    ? { email: from, name: null }
    : { email: from.email, name: from.name ?? null }
}

function sendErrorResult(err: unknown): ToolResult {
  if (err instanceof OutboundError) {
    return {
      error: {
        code: err.reason === "ambiguous" ? "send_ambiguous" : "send_preflight_failed",
        retryable: err.retryable,
        message: err.message,
      },
    }
  }
  throw err
}

export type AckResult =
  | { ok: true; sent: true; messageId: string | null }
  | {
      ok: true
      sent: false
      reason:
        | "already_sent"
        | "ack_disabled"
        | "no_recipient"
        | "no_reply_recipient"
        | "no_inbox"
        | "merged"
        | "rate_limited"
    }
  | { error: ToolError }

/**
 * An address nobody reads replies at: an acknowledgement sent there bounces or
 * starts a loop with another robot. Matched on the local part, case-insensitive,
 * with a tag or suffix allowed ("noreply-alerts", "bounce+123").
 */
const NO_REPLY_LOCAL_PART =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?)([-_.+].*)?$/i

export function isNoReplyAddress(email: string): boolean {
  const at = email.lastIndexOf("@")
  const local = (at >= 0 ? email.slice(0, at) : email).trim()
  return NO_REPLY_LOCAL_PART.test(local)
}

/**
 * Acknowledgement send limits. An ack goes to an address nobody has proven they
 * own, from the org's real mailbox, so one recipient, one submitting source and
 * the org as a whole are each capped. Over a cap the ack is skipped (the ticket
 * itself is unaffected).
 */
const ACK_LIMITS = {
  recipientHour: 2,
  recipientDay: 5,
  sourceHour: 20,
  orgHour: 300,
} as const

/**
 * Send the ticket-creation acknowledgement email (Task 2). Colocated with
 * `renderAndSend` — reuses the same loadTicket / loadInboxAndProvider /
 * loadOrgSettings / renderTicketEmail / sendOutbound seam so the ack shares
 * every threading/loop-suppression/sanitization guarantee a reply gets.
 *
 * Called POST-COMMIT at both ticket-create call sites (the tickets-public
 * webhook, and the inbound-mail path through the ticket's `ticket:create`
 * event, ack-after-commit.ts) — never inside `createTicket` itself, which is
 * tx-scoped and provider-agnostic. Gated on the ticket's SOURCE INBOX
 * `ack_enabled` flag (Task 1 per-inbox config, default true), skipped for a
 * merged ticket and a no-reply style requester, and send-once: `ack_sent_at`
 * is CLAIMED and committed before the send, so a redelivered event or two
 * racing callers send one mail; a send that fails gives the claim back.
 */
export async function sendTicketAcknowledgement(
  ticketId: string,
  orgId: string,
  opts: {
    /** The submitting client's address (web form), for a per-source cap. */
    sourceIp?: string | null
    /** Nobody has shown they own the recipient address (a web form or API
     *  submission): the ack carries a fixed subject, nothing the submitter wrote. */
    unverifiedRecipient?: boolean
  } = {},
): Promise<AckResult> {
  // 1. Check the gates and CLAIM the send (ack_sent_at) in a transaction of its
  //    own, committed before anything is sent: a concurrent or redelivered
  //    caller then sees the claim and stops, instead of both reading
  //    `ack_sent_at IS NULL` and both mailing the customer.
  const stop = (done: AckResult): { done: AckResult } => ({ done })
  const claim = await withPrivilegedDb(orgId, "tickets-ack-claim", async (db) => {
    const ticketRows = extractRows<{
      id: string
      handle: string
      subject: string
      reply_token: string
      source_inbox_id: string | null
      ack_sent_at: Date | null
      merged_into_ticket_id: string | null
      language: string | null
      team: string | null
    }>(
      await db.execute(drizzleSql`
        SELECT id, handle, subject, reply_token, source_inbox_id, ack_sent_at,
               merged_into_ticket_id, language, team
        FROM ${ticketsRel("tickets")}
        WHERE id = ${ticketId} AND org_id = ${orgId}
        LIMIT 1
      `),
    )
    const ticket = ticketRows[0]
    if (!ticket) {
      return stop({ error: { code: "not_found", retryable: false, message: "ticket not found" } })
    }
    if (ticket.ack_sent_at) return stop({ ok: true, sent: false, reason: "already_sent" })
    // Merged away before the acknowledgement ran: the customer's thread lives
    // on the target ticket now, and a "we received your request" for the
    // absorbed one would name a ticket nobody works.
    if (ticket.merged_into_ticket_id) {
      return stop({ ok: true, sent: false, reason: "merged" })
    }
    if (!ticket.source_inbox_id) return stop({ ok: true, sent: false, reason: "no_inbox" })

    const inbox = await loadInboxAndProvider(db, orgId, ticket.source_inbox_id)
    if (!inbox) return stop({ ok: true, sent: false, reason: "no_inbox" })
    if (inbox.ack_enabled === false) {
      return stop({ ok: true, sent: false, reason: "ack_disabled" })
    }

    const parties = await loadTicketParties(db, orgId, ticket.id)
    const requester = parties.requester
    if (!requester) return stop({ ok: true, sent: false, reason: "no_recipient" })
    if (isNoReplyAddress(requester)) {
      return stop({ ok: true, sent: false, reason: "no_reply_recipient" })
    }

    const claimed = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        UPDATE ${ticketsRel("tickets")}
        SET ack_sent_at = now()
        WHERE id = ${ticketId} AND org_id = ${orgId} AND ack_sent_at IS NULL
        RETURNING id
      `),
    )
    // Lost the race to a concurrent sender: its ack is the one of record.
    if (claimed.length === 0) {
      return stop({ ok: true, sent: false, reason: "already_sent" })
    }
    return { ticket, inbox, requester }
  })
  if ("done" in claim) return claim.done
  const { ticket, inbox, requester } = claim

  // Give the claim back, so a later attempt (a redelivery, a retry) can send.
  // Only the claimer is ever between claim and release (everyone else sees the
  // claim and stops), so the release needs no further guard.
  const releaseClaim = async (why: string, err?: unknown): Promise<void> => {
    try {
      await withPrivilegedDb(orgId, "tickets-ack-release", async (db) => {
        await db.execute(drizzleSql`
          UPDATE ${ticketsRel("tickets")} SET ack_sent_at = NULL
          WHERE id = ${ticketId} AND org_id = ${orgId}
        `)
      })
    } catch (releaseErr) {
      log.error(
        { ticketId, orgId, why, err: releaseErr },
        "ticket acknowledgement claim could not be released: no later attempt will send it",
      )
      return
    }
    if (why !== "rate_limited") {
      log.error(
        { ticketId, orgId, inboxId: inbox.id, why, err },
        "ticket acknowledgement not sent: claim released for a later attempt",
      )
    }
  }

  const ackBuckets = [
    {
      identifier: `tickets:ack:rcpt:${orgId}:${requester}:hour`,
      limit: ACK_LIMITS.recipientHour,
      windowSeconds: 3600,
    },
    {
      identifier: `tickets:ack:rcpt:${orgId}:${requester}:day`,
      limit: ACK_LIMITS.recipientDay,
      windowSeconds: 86_400,
    },
    {
      identifier: `tickets:ack:org:${orgId}:hour`,
      limit: ACK_LIMITS.orgHour,
      windowSeconds: 3600,
    },
    ...(opts.sourceIp
      ? [
          {
            identifier: `tickets:ack:src:${orgId}:${opts.sourceIp}:hour`,
            limit: ACK_LIMITS.sourceHour,
            windowSeconds: 3600,
          },
        ]
      : []),
  ]
  let ackLimit: Awaited<ReturnType<typeof checkRateLimit>>
  try {
    ackLimit = await checkRateLimit(redis, ackBuckets)
  } catch (err) {
    await releaseClaim("rate_limit_check_failed", err)
    throw err
  }
  if (!ackLimit.allowed) {
    await releaseClaim("rate_limited")
    log.warn({ ticketId, orgId }, "ticket acknowledgement skipped: rate limited")
    return { ok: true, sent: false, reason: "rate_limited" }
  }

  // 2. Send, then record the message. Once the provider has the mail (or may
  //    have it: an ambiguous outcome) the claim stays, whatever happens next:
  //    a second attempt would mail the customer twice.
  let handedToProvider = false
  try {
    const result = await withPrivilegedDb(
      orgId,
      "tickets-send-ack",
      async (db): Promise<AckResult> => {
        const orgSettings = await loadOrgSettings(db, orgId)
        // The default acknowledgement speaks the ticket's language (else the
        // org's), like the rest of the email around it. A configured ack body or
        // SLA phrase is the org's own words and is sent as written.
        const locale = ticketEmailLocale(ticket.language, orgSettings.defaultLocale)
        // The column's English default ("within 2 business days") is written on
        // every inbox nobody configured, so it counts as unset: a French ticket
        // must not read "sous 2 jours" spelled in English.
        const configuredSla = inbox.sla_promise_phrase?.trim()
        const slaPromise =
          configuredSla && configuredSla !== DEFAULT_SLA_PROMISE_EN
            ? configuredSla
            : serverT(locale, "tickets.email.defaultSlaPromise")
        // `{{team}}` in a configured ack body is the ticket's team.
        const ackBody =
          applyTeamPlaceholder(inbox.ack_body_text?.trim() ?? "", ticket.team) ||
          serverT(locale, "tickets.email.ackBody", { sla: slaPromise })

        const { html: ackHtml, text: ackText } = emailBody({ textBody: ackBody })
        const email: StructuredEmail = await renderTicketEmail(
          {
            id: ticket.id,
            // The segment config is read on this transaction: a second
            // privileged connection while this one is held can starve the pool.
            handle:
              (await displayHandleFor(db, orgId, ticket.id, await loadSegmentConfig(orgId, db))) ??
              ticket.handle,
            subject: ticket.subject,
            reply_token: ticket.reply_token,
            language: ticket.language,
            team: ticket.team,
          },
          { htmlBody: ackHtml, textBody: ackText },
          orgSettings,
          {
            id: inbox.id,
            email_address: inbox.email_address,
            from_display_name: inbox.from_display_name,
            reply_to_email: inbox.reply_to_email,
            signature_html: inbox.signature_html,
            signature_text: inbox.signature_text,
            sla_promise_phrase: slaPromise,
          },
          // Passed for threading headers only: an acknowledgement quotes nothing
          // (renderTicketEmail never builds a quote for kind "ack").
          await loadPriorMessages(db, orgId, ticket.id),
          {
            kind: "ack",
            requester,
            participants: [],
            echoSubject: opts.unverifiedRecipient !== true,
          },
        )
        // An acknowledgement IS a system auto-reply, so it carries the RFC 3834
        // headers — the one outbound message that legitimately claims them.
        email.headers = {
          ...email.headers,
          extra: {
            ...email.headers?.extra,
            ...outboundLoopSuppressionHeaders("acknowledgement"),
          },
        }

        const provider = await buildProvider(
          db,
          { orgId, actor: SYSTEM_ACTOR, tx: db as never },
          inbox,
        )
        let sentMessageId: string | null = null
        try {
          const send = await sendOutbound(email, provider, { accountEmail: inbox.identifier })
          handedToProvider = true
          sentMessageId = send.externalMessageId
        } catch (err) {
          if (err instanceof OutboundError && err.reason === "ambiguous") {
            handedToProvider = true
            sentMessageId = null
          } else if (err instanceof OutboundError) {
            return {
              error: {
                code: "send_preflight_failed",
                retryable: err.retryable,
                message: err.message,
              },
            }
          } else {
            throw err
          }
        }

        // Record the send. last_outbound_at is deliberately NOT touched: an
        // automatic acknowledgement is not a reply, and every "the customer is
        // waiting on us" read (Needs attention, the attention feed, urgency rank)
        // compares last_inbound_at to last_outbound_at. Stamping it here hid
        // every acknowledged ticket from them.
        const sentAt = new Date().toISOString()
        await db.execute(drizzleSql`
        UPDATE ${ticketsRel("tickets")}
        SET ack_sent_at = ${sentAt},
            message_count = message_count + 1, last_message_at = ${sentAt},
            updated_at = now()
        WHERE id = ${ticketId} AND org_id = ${orgId}
      `)
        await insertOutboundMessage(
          db,
          { orgId, actor: SYSTEM_ACTOR, tx: db as never },
          {
            ticketId,
            htmlBody: email.html,
            textBody: email.text,
            subject: email.subject,
            externalMessageId: sentMessageId,
            sentAt,
            from: normalizeFrom(email.from),
            isAcknowledgement: true,
          },
        )
        return { ok: true, sent: true, messageId: sentMessageId }
      },
    )
    if ("error" in result) await releaseClaim("send_failed", result.error)
    return result
  } catch (err) {
    if (handedToProvider) {
      log.error(
        { ticketId, orgId, inboxId: inbox.id, err },
        "ticket acknowledgement sent but not recorded: claim kept so it is never sent twice",
      )
    } else {
      await releaseClaim("send_threw", err)
    }
    throw err
  }
}

type TicketsReplyParams = {
  ticketId: string
  htmlBody?: string
  textBody?: string
  followup?: { at?: string; reason?: string; trigger?: string }
  attachmentSessionId?: string
  attachments?: string[]
  /** Extra recipients copied on the email (plain addresses). */
  cc?: string[]
}

/**
 * Shared, side-effect-free validation for a ticket reply: ticket loads + repliable, has an inbox,
 * has a resolvable customer recipient, a body or attachment is present, and any `attachmentSessionId`
 * resolves to something attachable (a kernel.files id — folded into `attachments` — or a staged upload
 * session with files). Returns the NORMALIZED params (with the fold applied) on success, or a
 * `{ error }` the caller surfaces.
 *
 * This runs BOTH as the gated tool's PROPOSE-time preflight (`ticketsReplyPreflight`, wired via the
 * manifest `preflight` slot) AND at the top of the execute-time `ticketsReply`. Running it at propose is
 * what makes a bad attachment / missing recipient fail AT CALL TIME — before an approval is queued — so
 * a weak model (e.g. one stuffing a prior gated call's approval-request id into `attachmentSessionId`
 * while setting up an RMA bundle) gets the error in-loop and recovers, instead of the approval being
 * queued and then EXECUTED-FAIL post-approval with a non-2xx the chaos runner verdict-overrides to fail.
 */
export async function preflightTicketsReplyParams(
  params: TicketsReplyParams,
  ctx: ToolCtx,
): Promise<{ ok: true; params: TicketsReplyParams } | { ok: false; error: ToolError }> {
  if (!params.ticketId) {
    return {
      ok: false,
      error: { code: "invalid_params", retryable: false, message: "ticketId required" },
    }
  }
  const loaded = await loadTicket(ctx.tx, ctx.orgId, params.ticketId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const ticket = loaded.ticket
  // Downstream inserts and updates bind this straight into uuid columns, so
  // carry the RESOLVED uuid forward when the caller passed a handle.
  params = { ...params, ticketId: ticket.id }
  const pf = preflightCommon(ticket)
  if (!pf.ok) return { ok: false, error: pf.error }
  if (!ticket.source_inbox_id) {
    return {
      ok: false,
      error: { code: "no_inbox", retryable: false, message: "ticket has no source inbox" },
    }
  }
  // Early customer-recipient preflight (mirrors renderAndSend's customerPrior check): a reply renders
  // the outbound `To:` from the ticket's stored requester; a ticket with NO inbound
  // customer message (e.g. one freshly CREATED inside Liaison, or holding only internal notes/outbound)
  // cannot be replied to — fail with a distinct `no_recipient` code so the agent pivots.
  const recipientRows = (await loadTicketParties(ctx.tx, ctx.orgId, params.ticketId)).requester
    ? [true]
    : []
  if (recipientRows.length === 0) {
    return {
      ok: false,
      error: {
        code: "no_recipient",
        retryable: false,
        message:
          "ticket has no customer recipient — it has no inbound customer message to reply to " +
          "(a ticket created inside Liaison, or one holding only internal notes, cannot email a " +
          "customer). Reply on the customer's original inbound ticket, or use mail__compose to " +
          "email their address directly.",
      },
    }
  }
  if (!hasBody(params) && !params.attachmentSessionId && !params.attachments?.length) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        retryable: false,
        message: "reply body or attachments required",
      },
    }
  }
  const cc = normalizeReplyCc(params.cc)
  if (!cc.ok) {
    return { ok: false, error: { code: "invalid_params", retryable: false, message: cc.message } }
  }
  params = { ...params, cc: cc.cc.length > 0 ? cc.cc : undefined }
  // Ergonomics normalization: `attachmentSessionId` is for a HUMAN upload session, but a weak model
  // often puts an imported kernel FILE id there. If it IS a readable kernel.files id, fold it into
  // `attachments` so it flows through the validated attachment path.
  let normalized = params
  if (normalized.attachmentSessionId) {
    const fileRows = extractRows<{ id: string }>(
      await ctx.tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${kernelRel("files")}
        WHERE id = ${normalized.attachmentSessionId} AND org_id = ${ctx.orgId}
        LIMIT 1`),
    )
    if (fileRows.length > 0) {
      normalized = {
        ...normalized,
        attachments: [...(normalized.attachments ?? []), fileRows[0].id],
        attachmentSessionId: undefined,
      }
    }
  }
  // Early attachment-session preflight: an `attachmentSessionId` that survived the kernel.files fold
  // must resolve to a staged upload with files, and that upload must have been started on THIS
  // ticket by this caller (resolveTicketUploadSession). Checked at propose time AND again before the
  // send (ticketsReply re-runs this), so a bad or foreign session never reaches the customer: a weak
  // model stuffing a prior approval id here, or a session staged on another ticket or by a Drive
  // import, is refused loudly before anything is queued or sent.
  if (normalized.attachmentSessionId) {
    const staged = await resolveTicketUploadSession(
      ctx,
      normalized.attachmentSessionId,
      params.ticketId,
    )
    if (!staged.ok) return { ok: false, error: staged.error }
  }
  return { ok: true, params: normalized }
}

/**
 * PROPOSE-time preflight slot for the gated tickets:reply tool (manifest `preflight`). Runs BEFORE the
 * approval request is created so attachment/recipient errors surface at call time. Returns `{ ok: true }`
 * or a tool-error result.
 */
export async function ticketsReplyPreflight(
  params: TicketsReplyParams,
  ctx: ToolCtx,
): Promise<ToolResult> {
  const pf = await preflightTicketsReplyParams(params, ctx)
  if (!pf.ok) return { error: pf.error }
  // The approval stores and links the ticket uuid, never the handle the caller passed.
  return { ok: true, canonicalParams: { ticketId: pf.params.ticketId } } as unknown as ToolResult
}

export async function ticketsReply(params: TicketsReplyParams, ctx: ToolCtx): Promise<ToolResult> {
  const pre = await preflightTicketsReplyParams(params, ctx)
  if (!pre.ok) return { error: pre.error }
  params = pre.params
  const loaded = await loadTicket(ctx.tx, ctx.orgId, params.ticketId)
  if (!loaded.ok) return { error: loaded.error }
  const ticket = loaded.ticket
  if (!ticket.source_inbox_id) {
    return {
      error: {
        code: "no_inbox",
        retryable: false,
        message: "ticket has no source inbox",
      },
    }
  }

  // Resolve every file the reply carries under RLS before sending: the
  // agent's `attachments` ids AND the files a person staged in the composer
  // (`attachmentSessionId`). Both go on the outgoing email; the staged ones
  // are also moved onto the message row once it exists. Only files the caller
  // can see are attachable, and executable types are rejected.
  let outboundAttachments: OutboundEmailAttachment[] = []
  let sessionFileIds: string[] = []
  if (params.attachmentSessionId) {
    const staged = await resolveTicketUploadSession(ctx, params.attachmentSessionId, ticket.id)
    if (!staged.ok) return { error: staged.error }
    sessionFileIds = staged.fileIds
  }
  const outboundFileIds = [...(params.attachments ?? []), ...sessionFileIds]
  if (outboundFileIds.length > 0) {
    try {
      outboundAttachments = await loadOutboundAttachments(ctx, outboundFileIds)
    } catch (err) {
      if (err instanceof FileServiceError) {
        return { error: { code: err.code.toLowerCase(), retryable: false, message: err.message } }
      }
      throw err
    }
  }

  const sentAt = new Date().toISOString()
  const newStatus = params.followup?.at ? "awaiting_followup" : "awaiting_customer"

  const result = await withCtxPrivileged(ctx, async (db): Promise<ToolResult> => {
    let send: {
      messageId: string | null
      subject: string
      ambiguous?: boolean
      from: { email: string; name: string | null }
      authorName: string
      htmlBody: string
      to: string[]
      cc: string[]
    }
    try {
      send = await renderAndSend(db, ctx, ticket, params, "reply", outboundAttachments, {
        cc: params.cc,
      })
    } catch (err) {
      return sendErrorResult(err)
    }

    const messageId = await insertOutboundMessage(db, ctx, {
      authorLabel: await resolveRoutineAuthorLabel(db, ctx),
      ticketId: params.ticketId,
      htmlBody: send.htmlBody || undefined,
      textBody: params.textBody,
      subject: send.subject,
      externalMessageId: send.messageId,
      sentAt,
      from: send.from,
      to: send.to,
      cc: send.cc,
    })

    // Live-update any open ticket detail UI. queueEvent -> outbox -> the WS
    // broadcast is the ONLY path a client learns about a new message (no DB
    // triggers/CDC) — without this the agent's own reply never echoed back
    // until a manual reload. Payload shape mirrors the webhook append path
    // (tickets-public.ts's appendIfExisting branch) exactly, since the
    // frontend's handleTicketMessageEvent reads these same fields to
    // reconcile its optimistic "sending…" placeholder against the real row.
    // Unified-search §3.3: this event's `data.ticketId` (below) ALSO already
    // flows through the indexer's `tickets:message create` derived-reindex
    // branch (indexer.ts planFromEvent) unchanged — verified, no edit needed
    // here — so an agent reply re-upserts (re-enriches) the ticket document
    // exactly like the inbound-append path now does.
    await db.queueEvent({
      app: "tickets",
      entity: "message",
      action: "create",
      entityId: messageId,
      data: {
        id: messageId,
        ticketId: params.ticketId,
        kind: "outbound",
        textBody: params.textBody ?? null,
        htmlBody: send.htmlBody || null,
        toEmails: send.to,
        ccEmails: send.cc,
        fromEmail: send.from.email || null,
        fromName: send.from.name,
        authorName: (await resolveActingAgentName(db, ctx)) ?? send.authorName,
        sentAt,
        orgId: ctx.orgId,
        // Carry the parent ticket's dimension values under their grant keys so
        // the WS-side hasDimensionAccess filter (grant keys tickets:team /
        // tickets:sensitivity) can enforce team/sensitivity isolation on the
        // frame — the message body would otherwise reach agents scoped to
        // another team or a lower sensitivity, which RLS forbids. Mirrors how
        // mail frames carry their mail:inbox dimension.
        "tickets:team": ticket.team,
        "tickets:sensitivity": ticket.sensitivity,
      },
      actorId: ctx.actor.userId,
      actorType: ctx.actor.actorType,
      orgId: ctx.orgId,
    })

    const followupAt = params.followup?.at
      ? drizzleSql`, followup_at = ${params.followup.at}::timestamptz`
      : drizzleSql``
    const followupReason = params.followup?.reason
      ? drizzleSql`, followup_reason = ${params.followup.reason}`
      : drizzleSql``
    const followupTrigger = params.followup?.trigger
      ? drizzleSql`, followup_trigger = ${params.followup.trigger}`
      : drizzleSql``

    await db.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET status = ${newStatus},
          message_count = message_count + 1,
          last_message_at = ${sentAt},
          last_outbound_at = ${sentAt},
          first_response_at = COALESCE(first_response_at, ${sentAt}),
          updated_at = now()
          ${followupAt} ${followupReason} ${followupTrigger}
      WHERE id = ${params.ticketId} AND org_id = ${ctx.orgId}
    `)
    // Live-update the ticket header + list row (status pill, last-message
    // preview, sort position) — mirrors the "status" emit in state-machine.ts.
    await db.queueEvent({
      app: "tickets",
      entity: "ticket",
      action: "update",
      entityId: params.ticketId,
      data: { ticketId: params.ticketId, changes: { status: newStatus } },
      actorId: ctx.actor.userId,
      actorType: ctx.actor.actorType,
      orgId: ctx.orgId,
    })
    if (send.ambiguous) {
      await recordAmbiguousTimeline(db, ctx, params.ticketId, "send_ambiguous")
    }

    return {
      ok: true,
      messageId,
      externalMessageId: send.messageId,
      status: newStatus,
      ambiguous: send.ambiguous,
    }
  })

  // Post-commit: a reply that actually sent supersedes any OTHER pending
  // gated REPLY draft still open on this ticket (an agent/routine "suggested"
  // reply nobody acted on). Without this, sending your own reply leaves that
  // stale draft's approval card visible on the ticket forever (ticket 10346)
  // — reusing the same cancel primitive merge.ts already uses when a ticket
  // disappears into another one, but scoped to ONLY `tickets:reply`: a
  // pending tickets:nudge or tickets:close someone else queued on this same
  // ticket (e.g. a scheduled 3-day nudge, or an agent-proposed close) is a
  // DIFFERENT, still-live decision and must not silently die alongside an
  // unrelated reply. `cancelApprovalsForSourceTicket` only touches rows still
  // `status = 'pending'`, so it can never race the approval that gated THIS
  // very send (that row is `approving` while its handler runs, never
  // `pending`). Best-effort — the reply already sent, so a cleanup failure
  // must never fail it.
  if ("ok" in result && result.ok) {
    try {
      await cancelApprovalsForSourceTicket(
        ctx.tx,
        ctx.orgId,
        params.ticketId,
        "manual_reply_sent",
        ["tickets:reply"],
      )
    } catch (err) {
      log.error(
        { err, ticketId: params.ticketId },
        "tickets.reply: failed to cancel superseded pending drafts",
      )
    }
  }

  // Post-commit: move the composer's staged files (checked to belong to this
  // ticket before the send) onto the new outbound message. The email already
  // went out WITH them, so a failure here only costs the copy on the message
  // row: it is logged, never reported as a failed reply (that would invite a
  // resend of a delivered email).
  if ("ok" in result && result.ok && result.messageId && params.attachmentSessionId) {
    try {
      await moveTicketSessionFiles(
        ctx.orgId,
        params.attachmentSessionId,
        sessionFileIds,
        result.messageId,
      )
    } catch (err) {
      log.error(
        { err, ticketId: params.ticketId, messageId: result.messageId },
        "tickets.reply: staged attachment move failed after send",
      )
    }
  }

  // Post-commit: copy the agent's attachments onto the persisted message for
  // provenance + the audit trail. Best-effort — the email is already sent, so
  // a copy failure must never fail the reply.
  if ("ok" in result && result.ok && result.messageId && params.attachments?.length) {
    try {
      await attachFilesToParent(
        {
          sourceFileIds: params.attachments,
          target: { app: "tickets", entityType: "message", entityId: result.messageId },
        },
        {
          rlsTx: ctx.tx,
          privileged: (reason, fn) => withPrivilegedDb(ctx.orgId, reason, fn),
          orgId: ctx.orgId,
          userId: ctx.actor.userId,
          actorType: ctx.actor.actorType,
          scopes: ctx.actor.scopes ?? [],
        },
      )
    } catch (err) {
      log.error(
        { err, ticketId: params.ticketId, messageId: result.messageId },
        "tickets.reply: attachment record-copy failed after send",
      )
    }
  }

  // Post-commit: the files are now on the message, which the live create event
  // (queued inside the send) could not carry. Announce them so an open ticket
  // shows them on the new card without a reload. Best-effort, like the moves.
  if (
    "ok" in result &&
    result.ok &&
    result.messageId &&
    (sessionFileIds.length > 0 || (params.attachments?.length ?? 0) > 0)
  ) {
    try {
      await announceMessageAttachments(ctx, ticket, params.ticketId, result.messageId)
    } catch (err) {
      log.error(
        { err, ticketId: params.ticketId, messageId: result.messageId },
        "tickets.reply: attachment live update failed after send",
      )
    }
  }
  return result
}

/** Emit a `tickets:message update` carrying the message's attachment list. */
async function announceMessageAttachments(
  ctx: ToolCtx,
  ticket: LoadedTicket,
  ticketId: string,
  messageId: string,
): Promise<void> {
  await withCtxPrivileged(ctx, async (db) => {
    const attachments = extractRows<{
      id: string
      filename: string
      mimeType: string
      sizeBytes: number
      disposition: string
      contentId: string | null
      ordinal: number
    }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes",
               disposition, content_id AS "contentId", ordinal
        FROM ${kernelRel("files")}
        WHERE org_id = ${ctx.orgId} AND app = 'tickets' AND entity_type = 'message'
          AND entity_id = ${messageId}
        ORDER BY ordinal, created_at, id`),
    ).map((a) => ({ ...a, sizeBytes: Number(a.sizeBytes) }))
    await db.queueEvent({
      app: "tickets",
      entity: "message",
      action: "update",
      entityId: messageId,
      data: {
        id: messageId,
        ticketId,
        attachments,
        orgId: ctx.orgId,
        "tickets:team": ticket.team,
        "tickets:sensitivity": ticket.sensitivity,
      },
      actorId: ctx.actor.userId,
      actorType: ctx.actor.actorType,
      orgId: ctx.orgId,
    })
  })
}

/**
 * A nudge or close in the close-silent routine's frame acts only while the
 * silence it was proposed on holds (close-silent.ts, `silentStepRefusal`). The
 * ticket may be named by its handle: the uuid is resolved first.
 */
async function silentStepRefusalFor(ticketId: string, ctx: ToolCtx): Promise<ToolError | null> {
  if (!ctx.originRoutineId || !ticketId) return null
  const loaded = await loadTicket(ctx.tx, ctx.orgId, ticketId)
  if (!loaded.ok) return null
  const refusal = await silentStepRefusal({
    orgId: ctx.orgId,
    routineId: ctx.originRoutineId,
    ticketId: loaded.ticket.id,
    approvalRequestId: ctx.approvalRequestId ?? null,
  })
  return refusal ? { ...refusal } : null
}

/**
 * Shared, read-only validation for tickets:nudge. ONE copy, called by BOTH the manifest `preflight`
 * export (`ticketsNudgePreflight`) and the execute-time handler, so the two can never drift.
 *
 * WHY it runs at propose time: tickets:nudge is GATED, so a call whose ticket does not exist, is
 * merged/converted, is not in a waiting state, or has already been nudged would otherwise park a
 * pending approval for a human and only fail once that human clicked approve. A gated call must not be
 * parked for a human when the data it needs is missing.
 */
export async function preflightTicketsNudgeParams(
  params: { ticketId: string; htmlBody?: string; textBody?: string },
  ctx: ToolCtx,
): Promise<{ ok: true; ticket: LoadedTicket } | { ok: false; error: ToolError }> {
  if (!params.ticketId) {
    return {
      ok: false,
      error: { code: "invalid_params", retryable: false, message: "ticketId required" },
    }
  }
  const loaded = await loadTicket(ctx.tx, ctx.orgId, params.ticketId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const ticket = loaded.ticket
  const pf = preflightCommon(ticket)
  if (!pf.ok) return { ok: false, error: pf.error }
  // BL-89: a nudge (a reminder to a customer who owes us a response) is valid in EITHER waiting state —
  // awaiting_customer OR awaiting_followup. Requiring strictly awaiting_customer broke the common
  // "nudge the customer AND snooze a 3-day follow-up" flow: tickets:nudge is GATED, so it executes only
  // when the approval is decided, and an ungated tickets:setFollowup on the same ticket (which moves it
  // to awaiting_followup) runs first — invalidating the pending nudge with a wrong_status at execution
  // time. Both waiting states mean "the customer still owes a reply", so a nudge is appropriate in both.
  if (ticket.status !== "awaiting_customer" && ticket.status !== "awaiting_followup") {
    return {
      ok: false,
      error: {
        code: "wrong_status",
        retryable: false,
        message:
          "nudge requires the ticket to be awaiting the customer (awaiting_customer or awaiting_followup)",
      },
    }
  }
  if (ticket.nudge_sent_at) {
    return {
      ok: false,
      error: { code: "nudge_already_sent", retryable: false, message: "nudge already sent" },
    }
  }
  if (!hasBody(params)) {
    return {
      ok: false,
      error: { code: "invalid_params", retryable: false, message: "nudge body required" },
    }
  }
  return { ok: true, ticket }
}

/**
 * PROPOSE-time preflight slot for the gated tickets:nudge tool (manifest `preflight`). Runs BEFORE the
 * approval request is created. Returns `{ ok: true }` or a tool-error result.
 */
export async function ticketsNudgePreflight(
  params: { ticketId: string; htmlBody?: string; textBody?: string },
  ctx: ToolCtx,
): Promise<ToolResult> {
  const pf = await preflightTicketsNudgeParams(params, ctx)
  if (!pf.ok) return { error: pf.error }
  // The approval stores and links the ticket uuid, never the handle the caller passed.
  return { ok: true, canonicalParams: { ticketId: pf.ticket.id } } as unknown as ToolResult
}

export async function ticketsNudge(
  params: { ticketId: string; htmlBody?: string; textBody?: string },
  ctx: ToolCtx,
): Promise<ToolResult> {
  const stale = await silentStepRefusalFor(params.ticketId, ctx)
  if (stale) return { error: stale }
  const pre = await preflightTicketsNudgeParams(params, ctx)
  if (!pre.ok) return { error: pre.error }
  const ticket = pre.ticket
  // The caller may have passed the `ticket-<n>` handle; everything below binds
  // this into uuid columns, so carry the resolved uuid forward.
  params = { ...params, ticketId: ticket.id }

  const sentAt = new Date().toISOString()
  return withCtxPrivileged(ctx, async (db) => {
    let send: {
      messageId: string | null
      subject: string
      ambiguous?: boolean
      from: { email: string; name: string | null }
      authorName: string
      htmlBody: string
    }
    try {
      send = await renderAndSend(db, ctx, ticket, params, "nudge")
    } catch (err) {
      return sendErrorResult(err)
    }
    const messageId = await insertOutboundMessage(db, ctx, {
      authorLabel: await resolveRoutineAuthorLabel(db, ctx),
      ticketId: params.ticketId,
      htmlBody: send.htmlBody || undefined,
      textBody: params.textBody,
      subject: send.subject,
      externalMessageId: send.messageId,
      sentAt,
      from: send.from,
    })

    await db.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET nudge_sent_at = ${sentAt},
          last_outbound_at = ${sentAt},
          message_count = message_count + 1,
          last_message_at = ${sentAt},
          updated_at = now()
      WHERE id = ${params.ticketId} AND org_id = ${ctx.orgId}
    `)
    if (send.ambiguous) {
      await recordAmbiguousTimeline(db, ctx, params.ticketId, "send_ambiguous")
    }

    return {
      ok: true,
      messageId,
      externalMessageId: send.messageId,
      status: ticket.status,
      ambiguous: send.ambiguous,
    }
  })
}

/**
 * Shared, read-only validation for tickets:close. ONE copy, called by BOTH the manifest `preflight`
 * export (`ticketsClosePreflight`) and the execute-time handler, so the two can never drift.
 *
 * WHY it runs at propose time: tickets:close is GATED, so a close aimed at a ticket id that does not
 * exist (or at a ticket already merged/converted away) would otherwise park a pending approval for a
 * human and only fail once that human clicked approve. A gated call must not be parked for a human when
 * the data it needs is missing. This covers only the KNOWABLE part: a merge or conversion landing
 * between staging and approval is a genuine race, which is why the handler keeps running this same check
 * at execution time.
 */
export async function preflightTicketsCloseParams(
  params: { ticketId: string },
  ctx: ToolCtx,
): Promise<{ ok: true; ticket: LoadedTicket } | { ok: false; error: ToolError }> {
  if (!params.ticketId) {
    return {
      ok: false,
      error: { code: "invalid_params", retryable: false, message: "ticketId required" },
    }
  }
  const loaded = await loadTicket(ctx.tx, ctx.orgId, params.ticketId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const ticket = loaded.ticket
  const pf = preflightCommon(ticket)
  if (!pf.ok) return { ok: false, error: pf.error }
  return { ok: true, ticket }
}

/**
 * PROPOSE-time preflight slot for the gated tickets:close tool (manifest `preflight`). Runs BEFORE the
 * approval request is created. Returns `{ ok: true }` or a tool-error result.
 */
export async function ticketsClosePreflight(
  params: { ticketId: string },
  ctx: ToolCtx,
): Promise<ToolResult> {
  const pf = await preflightTicketsCloseParams(params, ctx)
  if (!pf.ok) return { error: pf.error }
  // The approval stores and links the ticket uuid, never the handle the caller passed.
  return { ok: true, canonicalParams: { ticketId: pf.ticket.id } } as unknown as ToolResult
}

export async function ticketsClose(
  params: {
    ticketId: string
    closedReason?: "resolved" | "duplicate" | "spam" | "no_response"
    sendBody?: boolean
    htmlBody?: string
    textBody?: string
  },
  ctx: ToolCtx,
): Promise<ToolResult> {
  const stale = await silentStepRefusalFor(params.ticketId, ctx)
  if (stale) return { error: stale }
  const pre = await preflightTicketsCloseParams(params, ctx)
  if (!pre.ok) return { error: pre.error }
  const ticket = pre.ticket
  // The caller may have passed the `ticket-<n>` handle; everything below binds
  // this into uuid columns, so carry the resolved uuid forward.
  params = { ...params, ticketId: ticket.id }

  return withCtxPrivileged(ctx, async (db) => {
    let messageId: string | undefined
    let externalMessageId: string | null | undefined
    let ambiguous = false
    const closeHasBody = hasBody(params)
    if (closeHasBody) {
      const sentAt = new Date().toISOString()
      let send: {
        messageId: string | null
        subject: string
        ambiguous?: boolean
        from: { email: string; name: string | null }
        authorName: string
        htmlBody: string
      }
      try {
        send = await renderAndSend(db, ctx, ticket, params, "close")
      } catch (err) {
        return sendErrorResult(err)
      }
      messageId = await insertOutboundMessage(db, ctx, {
        authorLabel: await resolveRoutineAuthorLabel(db, ctx),
        ticketId: params.ticketId,
        htmlBody: send.htmlBody || undefined,
        textBody: params.textBody,
        subject: send.subject,
        externalMessageId: send.messageId,
        sentAt,
        from: send.from,
      })
      externalMessageId = send.messageId
      await db.execute(drizzleSql`
        UPDATE ${ticketsRel("tickets")}
        SET last_outbound_at = ${sentAt},
            last_message_at = ${sentAt},
            message_count = message_count + 1,
            updated_at = now()
        WHERE id = ${params.ticketId} AND org_id = ${ctx.orgId}
      `)
      if (send.ambiguous) {
        ambiguous = true
        await recordAmbiguousTimeline(db, ctx, params.ticketId, "send_ambiguous")
      }
    }

    await validateAndApply(
      db as never,
      params.ticketId,
      { kind: "close", closedReason: params.closedReason ?? "resolved" } as never,
      {
        ...ctx.actor,
        orgId: ctx.orgId,
        ...(ctx.originRoutineId ? { originRoutineId: ctx.originRoutineId } : {}),
        approvalRequestId: ctx.approvalRequestId ?? null,
      },
    )

    return { ok: true, messageId, externalMessageId, status: "closed", ambiguous }
  })
}
