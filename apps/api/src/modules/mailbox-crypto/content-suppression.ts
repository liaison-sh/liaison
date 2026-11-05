// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K, the shared half: which mail rows may contribute NO content to the
// control plane, and what "content" means field by field.
//
// Every Phase 6 closure site needs the same two answers:
//
//   1. Is this row's mailbox an ENCRYPTED personal mailbox? (`isMailContentSuppressed`)
//   2. Which keys of an arbitrary payload are mail content? (`MAIL_CONTENT_KEYS`)
//
// They live here, once, because the alternative is six near-copies drifting apart:
// the emit sites, the audit stripper, the timeline denylist, the Meili document
// projection, the agent reference context and the export handlers all consult the
// same predicate. A future field that carries mail text is added to
// `MAIL_CONTENT_KEYS` and every consumer closes at the same time.
//
// SCOPING IS THE WHOLE POINT. Nothing here is a global content filter. The
// predicate keys on (app, entity, mailbox) and the key list is consulted ONLY for
// `app === "mail"`, so a ticket subject, a thread title or a Shopify order note is
// never touched. Getting that wrong would silently gut unrelated surfaces.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

/**
 * Every key, in every casing the codebase actually uses, that can carry mail
 * plaintext through a JSON payload. Both snake_case (raw rows) and camelCase
 * (projections) appear, so both are listed rather than normalised: normalisation
 * would have to run over every nested value on every event.
 */
export const MAIL_CONTENT_KEYS: ReadonlySet<string> = new Set([
  "subject",
  "snippet",
  "body",
  "note",
  "textBody",
  "text_body",
  "htmlBody",
  "html_body",
  "rawHeaders",
  "raw_headers",
  "quotedOriginal",
  "quoted_original",
  "bodyPreview",
  "body_preview",
])

/**
 * The mail entities whose content the encryption regime owns. An event about an
 * `account` or an `outbound_staging` row carries no message text, so leaving them
 * out keeps the strip narrow enough to reason about.
 */
export const MAIL_CONTENT_ENTITIES: ReadonlySet<string> = new Set([
  "message",
  "messages",
  "conversation",
  "conversations",
  "draft",
  "drafts",
])

/**
 * True when `field` is mail content for `(app, entity)`.
 *
 * Also true, for EVERY app, when the field name ends in `_ciphertext`: a sealed
 * blob is not readable but it is not useful in a timeline either, and rendering
 * "changed body_ciphertext from <base64> to <base64>" is noise at best.
 */
export function isMailContentField(app: string, entity: string, field: string): boolean {
  if (field.endsWith("_ciphertext") || field.endsWith("Ciphertext")) return true
  if (app !== "mail") return false
  if (!MAIL_CONTENT_ENTITIES.has(entity)) return false
  return MAIL_CONTENT_KEYS.has(field)
}

/**
 * Drop every mail-content key from an event payload, leaving ids, envelope and
 * state fields untouched.
 *
 * Applied at EMIT, so nothing downstream (audit, timeline, outbox, WS fan-out,
 * replay buffer) has to remember. `null` and non-objects pass through.
 */
export function stripMailContentFromPayload<T>(data: T): T {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data
  const out: Record<string, unknown> = {}
  let changed = false
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (MAIL_CONTENT_KEYS.has(key) || key.endsWith("_ciphertext") || key.endsWith("Ciphertext")) {
      changed = true
      continue
    }
    out[key] = value
  }
  return (changed ? out : data) as T
}

// ── Is this mailbox encrypted? ───────────────────────────────────────────────

/** Anything that can run raw SQL. */
export interface SuppressionExecutor {
  execute(query: unknown): Promise<unknown>
}

const mailSchema = () => quoteIdent(schemaRef("app_mail"))

/**
 * The one predicate every Invariant K suppression site uses, over an
 * `app_mail.accounts` alias.
 *
 * ARMED FIRST, not `encryption_state = 'ready'`. The database trigger and the
 * mail writers key on the existence of an active identity for the owner
 * precisely because `ready -> blocked` is legal on any seal failure and
 * `pending_enrollment -> paused` on an elapsed grace window. A suppression layer
 * that keyed on the column let one seal failure switch off the Meili title
 * projection, the thread-title suppression, the approval summaries and the agent
 * redaction, all while the dual-read plaintext columns still hold the real
 * subjects, which is the whole point of the window.
 *
 * The explicit state list is kept ALONGSIDE the armed check, never instead of
 * it: a mailbox that reached `blocked` or `paused` and then lost its identity
 * row must not become quotable, and this way the predicate is a superset of the
 * old one rather than a different one. `none` and `pending_enrollment` stay
 * unsuppressed, which is the existing behaviour for a mailbox that is not yet
 * under the regime.
 *
 * Arming is read through the same `mailbox_invariant_armed` SECURITY DEFINER
 * helper the trigger calls. An inline lookup would be evaluated under the
 * caller's RLS session, where `kernel.user_mailbox_identities` can legitimately
 * return zero rows, and a zero-row read here means "not encrypted", the one
 * wrong answer this predicate must never give.
 */
export function mailAccountSuppressedSql(alias: string) {
  const a = drizzleSql.raw(alias)
  return drizzleSql`(${a}.owner_type = 'user' AND (
    ${drizzleSql.raw(`${mailSchema()}.mailbox_invariant_armed`)}(${a}.id)
    OR ${a}.encryption_state IN ('ready', 'blocked', 'paused', 'managed')))`
}

/**
 * Cache of `accountId -> suppressed`, with a short TTL.
 *
 * The Meili indexer builds documents in tight loops and the agent stream emits a
 * tool result per step, so an uncached lookup would add a query per document and
 * per chunk. The TTL is short deliberately: enrollment flips this value, and a
 * stale `false` is a leak, so 30 seconds is the largest window worth trading for
 * the query. Enrollment itself is not time critical, and the client renders the
 * real subject either way.
 */
const SUPPRESSION_TTL_MS = 30_000
const suppressionCache = new Map<string, { value: boolean; at: number }>()

/**
 * True when this mail account is a PERSONAL mailbox under the encryption regime
 * (see `mailAccountSuppressedSql`), so nothing derived from its rows may carry
 * content.
 *
 * FAILS CLOSED. An account id that does not resolve (deleted, invisible, or a
 * query error) is treated as suppressed: the cost of a false positive is a blank
 * title the client fills in after decrypt, and the cost of a false negative is
 * plaintext in Meili forever. `null`/`undefined` account ids are the one exception,
 * because "no account at all" is how a non-mail row reaches here.
 */
export async function isMailAccountSuppressed(
  tx: SuppressionExecutor,
  orgId: string,
  accountId: string | null | undefined,
): Promise<boolean> {
  if (!accountId) return false
  const cacheKey = `${orgId}:${accountId}`
  const hit = suppressionCache.get(cacheKey)
  if (hit && Date.now() - hit.at < SUPPRESSION_TTL_MS) return hit.value

  let value = true
  try {
    const rows = extractRows<{ suppressed: boolean }>(
      await tx.execute(drizzleSql`
        SELECT ${mailAccountSuppressedSql("a")} AS suppressed
          FROM ${drizzleSql.raw(mailSchema())}.accounts a
         WHERE a.id = ${accountId}::uuid AND a.org_id = ${orgId}::uuid
         LIMIT 1`),
    )
    // A row that does not exist stays `true` (fail closed).
    if (rows.length > 0) value = rows[0].suppressed === true
  } catch {
    value = true
  }
  suppressionCache.set(cacheKey, { value, at: Date.now() })
  return value
}

/**
 * Resolve the owning account id for a mail entity row and answer the same
 * question. Used by the generic search projection and the agent's referenced
 * entity context, neither of which carries the account id in every shape.
 */
export async function isMailEntitySuppressed(
  tx: SuppressionExecutor,
  orgId: string,
  entity: string,
  entityId: string,
): Promise<boolean> {
  const table =
    entity === "conversation" || entity === "conversations"
      ? "conversations"
      : entity === "message" || entity === "messages"
        ? "messages"
        : entity === "draft" || entity === "drafts"
          ? "drafts"
          : null
  if (!table) return false
  try {
    const rows = extractRows<{ suppressed: boolean }>(
      await tx.execute(drizzleSql`
        SELECT ${mailAccountSuppressedSql("a")} AS suppressed
          FROM ${drizzleSql.raw(mailSchema())}.${drizzleSql.raw(table)} r
          JOIN ${drizzleSql.raw(mailSchema())}.accounts a ON a.id = r.account_id
         WHERE r.id = ${entityId}::uuid AND r.org_id = ${orgId}::uuid
         LIMIT 1`),
    )
    if (rows.length === 0) return false
    return rows[0].suppressed === true
  } catch {
    // An unresolvable row here means "not a mail row we can vouch for". Unlike
    // the account lookup there is no id to fail closed ON: returning true would
    // blank every ticket and thread label the moment this query broke.
    return false
  }
}

/**
 * The generic entry point the search document builder and the reference-display
 * resolver both call: does `(app, entity, row)` contribute content?
 *
 * Non-mail apps always contribute. A mail row contributes only when its mailbox
 * is not an encrypted personal one.
 */
export async function isContentSuppressedForRow(
  tx: SuppressionExecutor,
  orgId: string,
  app: string,
  entity: string,
  row: Record<string, unknown>,
): Promise<boolean> {
  if (app !== "mail") return false
  if (!MAIL_CONTENT_ENTITIES.has(entity)) return false
  const accountId =
    (typeof row.account_id === "string" ? row.account_id : undefined) ??
    (typeof row.accountId === "string" ? row.accountId : undefined)
  if (accountId) return isMailAccountSuppressed(tx, orgId, accountId)
  const rowId = typeof row.id === "string" ? row.id : null
  if (!rowId) return false
  return isMailEntitySuppressed(tx, orgId, entity, rowId)
}

/** The mail table a mail attachment's `entity_type` names (outbound staging names an account). */
const MAIL_FILE_PARENT_TABLES: Readonly<Record<string, string>> = {
  message: "messages",
  messages: "messages",
  conversation: "conversations",
  conversations: "conversations",
  draft: "drafts",
  drafts: "drafts",
}

/**
 * Is the mailbox a mail attachment belongs to (its `kernel.files` `entity_type`/`entity_id`) a
 * personal one under the encryption regime?
 *
 * For the decisions that keep an attachment's content off the server (no stored analysis, no
 * cache, nothing in a stored tool result), so it FAILS CLOSED, unlike `isMailEntitySuppressed`
 * (whose false positive would blank labels): a parent row or account that does not resolve, an
 * entity type this does not know, a missing id and a query error all answer `true`. The cost
 * of a false positive is an attachment read through the private path; of a false negative, an
 * attachment's content stored on the server for every admin to read. Uncached for the same
 * reason: a stale `false` is a leak.
 */
export async function isMailAttachmentMailboxPrivate(
  tx: SuppressionExecutor,
  orgId: string,
  entityType: string,
  entityId: string | null | undefined,
): Promise<boolean> {
  if (!entityId) return true
  const schema = drizzleSql.raw(mailSchema())
  try {
    let rows: { suppressed: boolean | null }[]
    if (entityType === "outbound_staging") {
      rows = extractRows<{ suppressed: boolean | null }>(
        await tx.execute(drizzleSql`
          SELECT ${mailAccountSuppressedSql("a")} AS suppressed
            FROM ${schema}.accounts a
           WHERE a.id = ${entityId}::uuid AND a.org_id = ${orgId}::uuid
           LIMIT 1`),
      )
    } else {
      const table = MAIL_FILE_PARENT_TABLES[entityType]
      if (!table) return true
      rows = extractRows<{ suppressed: boolean | null }>(
        await tx.execute(drizzleSql`
          SELECT ${mailAccountSuppressedSql("a")} AS suppressed
            FROM ${schema}.${drizzleSql.raw(table)} r
            JOIN ${schema}.accounts a ON a.id = r.account_id
           WHERE r.id = ${entityId}::uuid AND r.org_id = ${orgId}::uuid
           LIMIT 1`),
      )
    }
    return rows.length === 0 || rows[0].suppressed !== false
  } catch {
    return true
  }
}

/**
 * Is this file an attachment of a private mailbox: a sealed file (`enc_version >= 1`), or a mail
 * file whose mailbox `isMailAttachmentMailboxPrivate` judges private? A file of another app is
 * not. FAILS CLOSED like it: a file id that does not resolve in the org, or a query error, is
 * private. Run it privileged: the answer must not depend on what the caller can see.
 */
export async function isMailFilePrivate(
  tx: SuppressionExecutor,
  orgId: string,
  fileId: string,
): Promise<boolean> {
  let file:
    | { app: string; entityType: string; entityId: string | null; encVersion: number | null }
    | undefined
  try {
    file = extractRows<{
      app: string
      entityType: string
      entityId: string | null
      encVersion: number | null
    }>(
      await tx.execute(drizzleSql`
        SELECT app, entity_type AS "entityType", entity_id::text AS "entityId",
               enc_version AS "encVersion"
          FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.files
         WHERE id = ${fileId}::uuid AND org_id = ${orgId}::uuid
         LIMIT 1`),
    )[0]
  } catch {
    return true
  }
  if (!file) return true
  if (file.app !== "mail") return false
  if (Number(file.encVersion ?? 0) > 0) return true
  return isMailAttachmentMailboxPrivate(tx, orgId, file.entityType, file.entityId)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ContentSuppressionTestAccess = {
  /** Test-only: forget every cached decision. */
  resetCache(): void {
    suppressionCache.clear()
  },
}
