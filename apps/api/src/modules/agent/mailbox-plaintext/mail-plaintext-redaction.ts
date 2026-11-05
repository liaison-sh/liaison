// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K, Task 6.6: mail plaintext never reaches the agent's persisted
// transcript, its live stream, or the late-joiner replay buffer.
//
// Three sites consume a tool result and each of them is durable or broadcast:
// `extractToolCalls` writes it into `kernel.messages.metadata.toolCalls[].result`
// through a privileged update, `emitStreamEvent("tool_result", ...)` records it
// into the in-process stream registry a late joiner replays, and the same call
// broadcasts it over Redis. One predicate, applied at all three.
//
// THE PREDICATE IS THE WHOLE DESIGN, and it is wrong in two opposite ways if
// stated carelessly:
//
//   * As a positive allowlist of mail tools to redact, a mail tool added next
//     year defaults to LEAKING. So the default for a mail tool is REDACT, and a
//     short named exemption list carries the envelope-only ones. A closure test
//     over the manifest fails when a new tool has no decision.
//   * As "every mail result", it guts the transcript for SHARED and ORG
//     mailboxes, which are explicitly out of scope (spec section 2.2) and are
//     most of today's mail-tool traffic. So the account must be a PERSONAL
//     mailbox at `encryption_state = 'ready'`.
//
// Unresolvable account means REDACT. The cost of a false positive is a terse
// tool card in a transcript; the cost of a false negative is mail plaintext in
// `kernel.messages` forever.
//
// THE RESIDUAL THIS CANNOT COVER, stated rather than tested away (spec SC13).
// The point of an unlocked turn is that the model ANSWERS using the decrypted
// body, and the assistant's own reply is persisted verbatim in
// `kernel.messages.content`. Only the tool-result metadata is redactable. That
// residual is consented and bounded: by the per-turn release caps and the
// per-session release counter, and by the settings switch that turns the agent's
// mail access off entirely. It is written out on the security settings page in
// the user's own words. Do NOT weaken an assertion here to "cover" it, and do
// NOT suppress agent output to make it go away.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import {
  isMailFilePrivate,
  mailAccountSuppressedSql,
} from "~/modules/mailbox-crypto/content-suppression"

const log = rootLogger.child({ service: "mail-redaction" })

const mailSchema = () => quoteIdent(schemaRef("app_mail"))

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The mail tools whose results are envelope only, and are therefore exempt.
 *
 * This list is the ONLY thing between a mail tool and redaction. Adding a tool
 * here is a decision that its result can never carry a subject, a body, a
 * snippet or a filename from an encrypted mailbox. The closure test in the
 * sibling spec file enumerates the manifest and fails when a tool is on neither
 * side of the line, so a new mail tool cannot be added without making that call.
 */
export const MAIL_ENVELOPE_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "listAccounts",
  "getAccount",
  "getSyncStatus",
  "setLabels",
  "archive",
  "disconnectAccount",
])

/** The redacted stand-in. The same shape at every site, by construction. */
export interface RedactedMailResult {
  messageIds: string[]
  byteLength: number
  redacted: true
  /**
   * Kept when the mailbox broker refused the read because the mailbox was
   * locked. A status and nothing else: it is what lets the chat show the owner
   * an Unlock button under the turn, and it names no content.
   */
  mailbox?: { status: "MAILBOX_LOCKED" }
}

/** Split `mail__read` into `("mail", "read")`. Returns null for a bare name. */
function splitToolName(toolName: string): { app: string; tool: string } | null {
  const idx = toolName.indexOf("__")
  if (idx === -1) return null
  return { app: toolName.slice(0, idx), tool: toolName.slice(idx + 2) }
}

/** Walk a result object collecting message ids and a total plaintext byte count. */
function summarizeResult(result: unknown): { messageIds: string[]; byteLength: number } {
  const messageIds: string[] = []
  let byteLength = 0
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number, underMessages: boolean): void => {
    if (depth > 8 || node === null || node === undefined) return
    if (typeof node === "string") {
      byteLength += node.length
      return
    }
    if (typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1, underMessages)
      return
    }
    const record = node as Record<string, unknown>
    // Any string id, not only a uuid: the marker shape and the client-fulfilled
    // paths carry synthetic ids, and the point of this list is to let the agent
    // ask for those messages again, not to be a foreign key.
    if (underMessages && typeof record.id === "string" && record.id.length > 0) {
      messageIds.push(record.id)
    }
    for (const [key, value] of Object.entries(record)) {
      walk(value, depth + 1, underMessages || key === "messages" || key === "messageIds")
    }
  }
  walk(result, 0, false)
  return { messageIds: [...new Set(messageIds)], byteLength }
}

/**
 * The replacement value. Extends the `stripMessageContentForAudit` pattern (an
 * id plus a length marker, never the content) to the agent metadata path.
 */
export function redactMailPlaintextResult(result: unknown): RedactedMailResult {
  const { messageIds, byteLength } = summarizeResult(result)
  const status =
    result && typeof result === "object" && !Array.isArray(result)
      ? ((result as { mailbox?: { status?: unknown } }).mailbox?.status ?? null)
      : null
  return {
    messageIds,
    byteLength,
    redacted: true,
    ...(status === "MAILBOX_LOCKED" ? { mailbox: { status: "MAILBOX_LOCKED" as const } } : {}),
  }
}

/** The `request-N` label an approval card prints, and nothing longer. */
const APPROVAL_HANDLE_RE = /^request-\d{1,12}$/

/**
 * A mail send (or any mail write) the gate PARKED for a person's approval: the
 * model-facing result the tool bridge builds (`{ blocked: true, status:
 * "pending_approval", approvalRequestId, ... }`). It ran no handler, so it read
 * no mailbox; what it can carry of the draft is in its summary, its message to
 * the model and its notes, never in its envelope.
 */
function parkedEnvelope(result: unknown): {
  blocked: true
  status: "pending_approval"
  approvalRequestId: string
  approvalHandle?: string
} | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null
  const record = result as Record<string, unknown>
  if (record.blocked !== true || record.status !== "pending_approval") return null
  const id = record.approvalRequestId
  if (typeof id !== "string" || !UUID_RE.test(id)) return null
  const handle = record.approvalHandle
  return {
    blocked: true,
    status: "pending_approval",
    approvalRequestId: id,
    ...(typeof handle === "string" && APPROVAL_HANDLE_RE.test(handle)
      ? { approvalHandle: handle }
      : {}),
  }
}

/**
 * Does this result carry the two-phase read marker?
 *
 * Deliberately an OR with the account condition rather than a replacement for
 * it: the account clause stands entirely on its own, so this module stays
 * complete and testable with no marker present at all.
 */
function isTwoPhaseMarker(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false
  const record = result as Record<string, unknown>
  // The marker the handlers actually emit is an OBJECT (`{ requestKind,
  // messageIds, purpose }`), not a boolean flag. Both shapes count: a boolean was
  // what this predicate was first written against, and widening rather than
  // replacing keeps the fail-closed direction (more results redacted, never
  // fewer).
  return record.needsPlaintext != null || record.needsClientSearch != null
}

/** Collect every candidate id from a mail result that could name a mailbox. */
function collectIdCandidates(result: unknown): {
  accountIds: string[]
  conversationIds: string[]
  messageIds: string[]
} {
  const accountIds: string[] = []
  const conversationIds: string[] = []
  const messageIds: string[] = []
  const seen = new Set<unknown>()
  const push = (into: string[], value: unknown) => {
    if (typeof value === "string" && UUID_RE.test(value)) into.push(value)
  }
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || !node || typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "accountId" || key === "account_id") push(accountIds, value)
      else if (key === "conversationId" || key === "conversation_id") push(conversationIds, value)
      else if (key === "messageId" || key === "message_id") push(messageIds, value)
      else if (key === "account" && value && typeof value === "object") {
        push(accountIds, (value as Record<string, unknown>).id)
      } else if (key === "conversation" && value && typeof value === "object") {
        push(conversationIds, (value as Record<string, unknown>).id)
      } else if (key === "messages" && Array.isArray(value)) {
        for (const m of value) {
          if (m && typeof m === "object") push(messageIds, (m as Record<string, unknown>).id)
        }
      }
      walk(value, depth + 1)
    }
  }
  walk(result, 0)
  return { accountIds, conversationIds, messageIds }
}

const CACHE_TTL_MS = 30_000
const encryptedAccountCache = new Map<string, { value: boolean; at: number }>()

/**
 * Did this result touch a personal mailbox under the encryption regime?
 *
 * The predicate is ARMED-first (`mailAccountSuppressedSql`), shared with every
 * other Invariant K suppression site: a mailbox a seal failure moved to
 * `blocked` still holds unpurged plaintext and must not start flowing back into
 * `kernel.messages.metadata.toolCalls[].result`.
 *
 * Returns null when nothing in the result names a mailbox this org can resolve,
 * which the caller treats as "redact".
 */
async function touchesEncryptedMailbox(orgId: string, result: unknown): Promise<boolean | null> {
  const { accountIds, conversationIds, messageIds } = collectIdCandidates(result)
  if (accountIds.length === 0 && conversationIds.length === 0 && messageIds.length === 0) {
    return null
  }
  const cacheKey = `${orgId}:${accountIds.sort().join(",")}|${conversationIds.sort().join(",")}|${messageIds.sort().join(",")}`
  const hit = encryptedAccountCache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const schema = drizzleSql.raw(mailSchema())
  // Built as an explicit parameter list rather than `= ANY($1::uuid[])`: an
  // array parameter that the driver types as text silently matches nothing, and
  // a lookup that silently matches nothing here reads exactly like "not
  // encrypted", which is the one wrong answer this function must never give.
  const idList = (ids: string[]) =>
    drizzleSql.join(
      ids.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql.raw(", "),
    )
  const clauses: ReturnType<typeof drizzleSql>[] = []
  if (accountIds.length > 0) clauses.push(drizzleSql`a.id IN (${idList(accountIds)})`)
  if (conversationIds.length > 0) {
    clauses.push(drizzleSql`a.id IN (SELECT account_id FROM ${schema}.conversations
       WHERE id IN (${idList(conversationIds)}) AND org_id = ${orgId}::uuid)`)
  }
  if (messageIds.length > 0) {
    clauses.push(drizzleSql`a.id IN (SELECT account_id FROM ${schema}.messages
       WHERE id IN (${idList(messageIds)}) AND org_id = ${orgId}::uuid)`)
  }
  try {
    const rows = await withPrivilegedDb(orgId, "agent-mail-redaction", async (tx) =>
      extractRows<{ encrypted: boolean | null }>(
        await tx.execute(drizzleSql`
          SELECT bool_or(${mailAccountSuppressedSql("a")}) AS encrypted
            FROM ${schema}.accounts a
           WHERE a.org_id = ${orgId}::uuid
             AND (${drizzleSql.join(clauses, drizzleSql.raw(" OR "))})`),
      ),
    )
    const encrypted = rows[0]?.encrypted
    if (encrypted === null || encrypted === undefined) return null
    encryptedAccountCache.set(cacheKey, { value: encrypted === true, at: Date.now() })
    return encrypted === true
  } catch (err) {
    log.debug({ err }, "mail redaction: account resolution failed, failing closed")
    return null
  }
}

/**
 * The kernel tools that can return an analysis of a FILE, which may be a mail attachment.
 * A summary they return about an attachment of an encrypted personal mailbox is redacted like a
 * mail tool's result. Their handlers already keep such content out of the result
 * (media-analysis-tool.ts refuses it, mail-attachment-read.ts hands it to the turn's context
 * block): this is the second line, at the sites that store and stream results.
 */
export const FILE_ANALYSIS_TOOLS: ReadonlySet<string> = new Set([
  "analyze_media",
  "mail_attachment_read",
])

/**
 * A file analysis result is kept when it carries no content (an error, a two-phase marker, the
 * delivered stub) or when its file is not an attachment of a private mailbox. FAILS CLOSED: a
 * summary with no resolvable file id, or a lookup that errors, is redacted.
 */
async function redactFileAnalysisResult(orgId: string, result: unknown): Promise<unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result
  const record = result as Record<string, unknown>
  if (typeof record.summary !== "string") return result
  const fileId = typeof record.fileId === "string" ? record.fileId : null
  if (fileId && UUID_RE.test(fileId)) {
    const isPrivate = await withPrivilegedDb(orgId, "agent-file-analysis-redaction", (tx) =>
      isMailFilePrivate(tx, orgId, fileId),
    ).catch(() => true)
    if (!isPrivate) return result
  }
  const { byteLength } = summarizeResult(result)
  return { ...(fileId ? { fileId } : {}), messageIds: [], byteLength, redacted: true }
}

/**
 * Redact `result` when it carries mail plaintext from an encrypted personal
 * mailbox. Returns the ORIGINAL reference untouched in every other case, so a
 * caller can cheaply tell whether anything happened.
 */
export async function redactMailToolResult(
  orgId: string,
  toolName: string,
  result: unknown,
): Promise<unknown> {
  const parts = splitToolName(toolName)
  // Condition 0: a kernel file analysis, which can be about a mail attachment.
  if (parts?.app === "kernel" && FILE_ANALYSIS_TOOLS.has(parts.tool)) {
    return redactFileAnalysisResult(orgId, result)
  }
  // Condition 1: every other non-mail tool passes through byte for byte, always.
  if (parts?.app !== "mail") return result
  // Condition 2: the short, named exemption list. Everything else redacts.
  if (MAIL_ENVELOPE_ONLY_TOOLS.has(parts.tool)) return result
  // A write parked for approval names no mailbox, so it would fail closed
  // whole, and the conversation then had no approval id to draw the pending
  // request's card under the agent's answer. Its envelope (the id, the
  // request-N handle, the status) is not mail content and is kept on the
  // redacted stand-in; the summary, the message and the notes still go.
  const parked = parkedEnvelope(result)
  if (parked) return { ...redactMailPlaintextResult(result), ...parked }
  // Condition 3: the mailbox. A shared or org mailbox renders verbatim.
  if (isTwoPhaseMarker(result)) return redactMailPlaintextResult(result)
  const encrypted = await touchesEncryptedMailbox(orgId, result)
  if (encrypted === false) return result
  if (encrypted === null) {
    log.debug({ toolName }, "mail redaction: no resolvable account in result, failing closed")
  }
  return redactMailPlaintextResult(result)
}

/**
 * The keys a mail tool's CALL ARGS can carry drafted content in.
 *
 * Deliberately the same vocabulary `approval-payload.ts` seals, in both casings,
 * so the sealed approval row and the transcript agree about what counts as
 * content. A key that is not on this list survives, which is what keeps the
 * transcript useful: ids, addresses, labels and flags are envelope level.
 */
const MAIL_ARG_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "subject",
  "body",
  "textBody",
  "text_body",
  "htmlBody",
  "html_body",
  "snippet",
  "note",
  "quotedOriginal",
  "quoted_original",
  "originalBody",
  "original_body",
  "quotedText",
  "quoted_text",
])

/**
 * Redact drafted content out of a mail tool's CALL ARGS.
 *
 * The results half of this module stopped plaintext reaching
 * `kernel.messages.metadata.toolCalls[].result` and the `tool_result` stream
 * event. The args half was left open: `extractToolCalls` persists `chunk.input`
 * verbatim into `metadata.toolCalls[].args` and `emitStreamEvent("tool_call")`
 * puts the same object on the wire, so a gated `mail__reply` wrote the cleartext
 * body the approval had just sealed into a durable control-plane row created by
 * the same call. Spec SC13 names `kernel.messages.metadata` explicitly, and the
 * Phase 12 purge only strips `{toolCalls}` for PRE-cutover rows, on the stated
 * assumption that everything written after the cutover is envelope only.
 *
 * Same three conditions as the results half, in the same order, so the two
 * cannot disagree about which mailbox is encrypted: non-mail passes through, the
 * named exemption list passes through, and an unresolvable mailbox fails closed.
 * Returns the ORIGINAL reference when nothing happened.
 */
export async function redactMailToolArgs(
  orgId: string,
  toolName: string,
  args: unknown,
): Promise<unknown> {
  const parts = splitToolName(toolName)
  if (parts?.app === "kernel" && parts.tool === "approval_update_payload") {
    return redactSealedApprovalEditArgs(orgId, args)
  }
  if (parts?.app !== "mail") return args
  if (MAIL_ENVELOPE_ONLY_TOOLS.has(parts.tool)) return args
  if (!args || typeof args !== "object" || Array.isArray(args)) return args

  const record = args as Record<string, unknown>
  const present = Object.keys(record).filter((key) => MAIL_ARG_CONTENT_KEYS.has(key))
  // Nothing drafted in here: an args object of pure envelope is left alone
  // rather than rewritten into a redaction marker that says less than it did.
  if (present.length === 0) return args

  const encrypted = await touchesEncryptedMailbox(orgId, args)
  if (encrypted === false) return args
  if (encrypted === null) {
    log.debug({ toolName }, "mail redaction: no resolvable account in args, failing closed")
  }

  const out: Record<string, unknown> = {}
  let byteLength = 0
  for (const [key, value] of Object.entries(record)) {
    if (MAIL_ARG_CONTENT_KEYS.has(key)) {
      if (typeof value === "string") byteLength += value.length
      continue
    }
    out[key] = value
  }
  out.redacted = true
  out.redactedFields = present
  out.byteLength = byteLength
  return out
}

/**
 * The edit half of the args redaction. `kernel__approval_update_payload` carries
 * the new text of a draft in `fields`, and when that draft is a mail send sealed
 * to its mailbox (Invariant K) the edit seals the text again: the transcript must
 * not keep the cleartext the approval row no longer holds. Any other approval's
 * edit (a ticket reply, a shared mailbox) passes through untouched. A request
 * that cannot be resolved fails closed, as the mail half does.
 */
async function redactSealedApprovalEditArgs(orgId: string, args: unknown): Promise<unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args
  const record = args as Record<string, unknown>
  const fields = record.fields
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return args
  const present = Object.keys(fields).filter((key) =>
    MAIL_ARG_CONTENT_KEYS.has(key.split(".")[0] ?? key),
  )
  if (present.length === 0) return args

  const requestId = typeof record.requestId === "string" ? record.requestId : null
  let sealed: boolean | null = null
  if (requestId && UUID_RE.test(requestId)) {
    try {
      const rows = await withPrivilegedDb(orgId, "agent-approval-edit-redaction", async (tx) =>
        extractRows<{ sealed: boolean | null }>(
          await tx.execute(drizzleSql`
            SELECT (current_payload->>'mailboxSealed')::boolean AS sealed
              FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.approval_requests
             WHERE id = ${requestId}::uuid AND org_id = ${orgId}::uuid
             LIMIT 1`),
        ),
      )
      if (rows[0]) sealed = rows[0].sealed === true
    } catch (err) {
      log.debug({ err }, "approval edit redaction: lookup failed, failing closed")
    }
  }
  if (sealed === false) return args

  const kept: Record<string, unknown> = {}
  let byteLength = 0
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (present.includes(key)) {
      if (typeof value === "string") byteLength += value.length
      continue
    }
    kept[key] = value
  }
  return { ...record, fields: kept, redacted: true, redactedFields: present, byteLength }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const MailPlaintextRedactionTestAccess = {
  /** Test-only: forget every cached decision. */
  resetCache(): void {
    encryptedAccountCache.clear()
  },
}
