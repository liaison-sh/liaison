// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `GET /api/mailbox/sync-cursor`: the sealed listing the browser reads (spec
// section 5.5 for the client index, section 7 step 6 for the migration sweep).
//
// The server hands out CIPHERTEXT and the cleartext envelope. It holds no key,
// so it contributes nothing to what the browser then does with either.
//
// TWO MODES, AND THEY MUST NOT BE COLLAPSED.
//
//   `sealed` (default), for the client search index: only rows the browser can
//   actually open (`enc_version > 0`), walked over a monotonic change cursor of
//   `(updated_at, id)` so an edited row comes back around and is re-indexed.
//
//   `verify`, for the migration sweep: EVERY personal message, whatever its
//   `enc_version`, plus the plaintext columns that are still there during the
//   dual-read window. Two reasons it is not the sealed listing with a flag.
//   First, the sweep signs a digest over the id set it covered and the server
//   recomputes that digest over `collectPersonalMessageIds`, which has no
//   `enc_version` filter, so a listing that hid unsealed rows would produce an
//   acknowledgement that can never verify, or worse, one that verifies while
//   the sweep never looked at those rows. Second, an unsealed row must be seen
//   and REFUSED by the sweep, because it means the backfill is not finished;
//   silently omitting it is exactly how a purge destroys plaintext nobody
//   verified. Its cursor is the message id alone, which no update can move, so
//   a row cannot be skipped by being touched mid walk.
//
// Both modes are owner scoped in the WHERE clause as well as by RLS: the
// account must be `owner_type = 'user'` and owned by the caller. A shared org
// mailbox is not in this regime and never appears here.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

export type SyncCursorMode = "sealed" | "verify"

export const SYNC_CURSOR_DEFAULT_LIMIT = 50
export const SYNC_CURSOR_MAX_LIMIT = 200

/** Anything that can run raw SQL: an RLS request tx or a privileged handle. */
export interface SyncCursorExecutor {
  execute(query: unknown): Promise<unknown>
}

export interface SealedListingItem {
  sealed: {
    id: string
    encVersion: number
    encKeyId: number | null
    contentKeyWrapped: string | null
    contentKeyEpk: string | null
    subjectCiphertext: string | null
    textBodyCiphertext: string | null
    htmlBodyCiphertext: string | null
    snippetCiphertext: string | null
  }
  envelope: {
    accountId: string
    conversationId: string
    sentAt: string | null
    /** Correspondents and labels, flattened. Cleartext by spec section 2.1. */
    metadata: string
  }
  /**
   * `verify` mode only. Whether this row still holds plaintext to compare the
   * decryption against, decided HERE from the columns rather than inferred by
   * the client from an absence.
   *
   * A row sealed at INGEST never had plaintext: all four columns are NULL and
   * there is nothing to compare. Its verification is that it DECRYPTS, and
   * nothing more. A LEGACY row sealed by the backfill still carries plaintext
   * during the dual-read window and must be compared byte for byte.
   *
   * The client must not guess: an absent `plaintext` on a row that should have
   * one is a listing served in the wrong mode, and treating that as "nothing to
   * compare" is exactly how a sweep silently degrades into a decryptability
   * check. So the flag is authoritative and the two always agree: `plaintext`
   * is present if and only if `hasPlaintext` is true.
   */
  hasPlaintext?: boolean
  /** `verify` mode only: the still-present plaintext half. */
  plaintext?: {
    subject: string | null
    textBody: string | null
    htmlBody: string | null
    snippet: string | null
  }
}

export interface SealedListingPage {
  cursor: string
  done: boolean
  total: number
  items: SealedListingItem[]
}

interface Row {
  id: string
  account_id: string
  conversation_id: string
  sent_at: string | null
  updated_at: string | null
  from_address: unknown
  to_addresses: unknown
  cc_addresses: unknown
  labels: unknown
  enc_version: number | null
  enc_key_id: number | null
  content_key_wrapped: Uint8Array | null
  content_key_epk: Uint8Array | null
  subject_ciphertext: Uint8Array | null
  text_body_ciphertext: Uint8Array | null
  html_body_ciphertext: Uint8Array | null
  snippet_ciphertext: Uint8Array | null
  subject: string | null
  text_body: string | null
  html_body: string | null
  snippet: string | null
}

function b64(value: Uint8Array | null): string | null {
  return value === null || value === undefined ? null : Buffer.from(value).toString("base64")
}

function addressBits(value: unknown, out: Set<string>): void {
  const list = Array.isArray(value) ? value : value ? [value] : []
  for (const entry of list as Array<{ name?: unknown; email?: unknown }>) {
    if (!entry || typeof entry !== "object") continue
    for (const bit of [entry.name, entry.email]) {
      if (typeof bit === "string" && bit.length > 0) out.add(bit)
    }
  }
}

/** The cleartext half, as one blob for the index's metadata tokenizer. */
function metadataOf(row: Row): string {
  const bits = new Set<string>()
  addressBits(row.from_address, bits)
  addressBits(row.to_addresses, bits)
  addressBits(row.cc_addresses, bits)
  if (Array.isArray(row.labels)) {
    for (const label of row.labels) if (typeof label === "string") bits.add(label)
  }
  return [...bits].join("\n")
}

/**
 * Does this row still hold a plaintext half worth comparing against?
 *
 * An empty string counts as ABSENT, the same rule the sweep's comparison uses
 * for a legacy `html_body = ''`. A row where every content column is NULL or
 * empty has nothing to compare, whether it was sealed at ingest or is simply an
 * empty message, and asking the sweep to compare "" against "" and call the
 * result a verification would be a claim about content fidelity that no data
 * supports.
 */
function hasPlaintextHalf(row: Row): boolean {
  for (const value of [row.subject, row.text_body, row.html_body, row.snippet]) {
    if (typeof value === "string" && value.length > 0) return true
  }
  return false
}

export function parseSyncCursorLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return SYNC_CURSOR_DEFAULT_LIMIT
  return Math.min(parsed, SYNC_CURSOR_MAX_LIMIT)
}

export function parseSyncCursorMode(raw: string | undefined): SyncCursorMode {
  return raw === "verify" ? "verify" : "sealed"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `ids=<uuid>,<uuid>`: the named rows only, for a browser asked to open mail it
 * has not loaded (an agent turn or a routine's Run now outside the mail view).
 * Null when absent. Anything that is not a uuid is dropped rather than passed
 * to SQL, and the list is capped at one page. Owner scoping is unchanged, so a
 * named row that is not the caller's simply does not come back.
 */
export function parseSyncCursorIds(raw: string | undefined): string[] | null {
  if (raw === undefined) return null
  const ids = [...new Set(raw.split(",").map((part) => part.trim()))].filter((part) =>
    UUID_RE.test(part),
  )
  return ids.slice(0, SYNC_CURSOR_MAX_LIMIT)
}

/**
 * The `sealed` mode cursor is `<updated_at ISO>|<id>`, a keyset over the change
 * order. It is split rather than parsed loosely: a malformed cursor starts the
 * walk over rather than silently skipping the mailbox.
 */
function splitSealedCursor(cursor: string | null): { ts: string; id: string } | null {
  if (!cursor) return null
  const at = cursor.lastIndexOf("|")
  if (at <= 0) return null
  const ts = cursor.slice(0, at)
  const id = cursor.slice(at + 1)
  if (!ts || !id || Number.isNaN(Date.parse(ts))) return null
  return { ts, id }
}

export async function listSealedMessages(
  tx: SyncCursorExecutor,
  userId: string,
  orgId: string,
  options: { mode: SyncCursorMode; cursor: string | null; limit: number; ids?: string[] | null },
): Promise<SealedListingPage> {
  const { mode, cursor } = options
  // A by-id read is the sealed listing narrowed to rows the caller named; the
  // verify walk is a digest over the whole id set and is never narrowed.
  const ids = mode === "sealed" ? (options.ids ?? null) : null
  if (ids && ids.length === 0) return { cursor: cursor ?? "", done: true, total: 0, items: [] }
  // The named rows fit one page by construction (parseSyncCursorIds caps them).
  const limit = ids ? SYNC_CURSOR_MAX_LIMIT : options.limit
  const owner = drizzleSql`a.org_id = ${orgId}::uuid AND a.owner_type = 'user' AND a.owner_id = ${userId}::uuid`
  const sealedOnly =
    mode === "sealed" ? drizzleSql` AND coalesce(m.enc_version, 0) > 0` : drizzleSql``

  let keyset = drizzleSql``
  if (ids) {
    keyset = drizzleSql` AND m.id IN (${drizzleSql.join(
      ids.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )})`
  } else if (mode === "verify") {
    if (cursor) keyset = drizzleSql` AND m.id > ${cursor}::uuid`
  } else {
    const parsed = splitSealedCursor(cursor)
    if (parsed) {
      keyset = drizzleSql` AND (m.updated_at, m.id) > (${parsed.ts}::timestamptz, ${parsed.id}::uuid)`
    }
  }
  const order =
    mode === "verify"
      ? drizzleSql`ORDER BY m.id ASC`
      : drizzleSql`ORDER BY m.updated_at ASC, m.id ASC`

  const plaintextColumns =
    mode === "verify" ? drizzleSql`, m.subject, m.text_body, m.html_body, m.snippet` : drizzleSql``

  const rows = extractRows<Row>(
    await tx.execute(drizzleSql`
      SELECT m.id::text AS id, m.account_id::text AS account_id,
             m.conversation_id::text AS conversation_id,
             m.sent_at, m.updated_at, m.from_address, m.to_addresses, m.cc_addresses, m.labels,
             m.enc_version, m.enc_key_id, m.content_key_wrapped, m.content_key_epk,
             m.subject_ciphertext, m.text_body_ciphertext, m.html_body_ciphertext,
             m.snippet_ciphertext${plaintextColumns}
        FROM ${MAIL}.messages m
        JOIN ${MAIL}.accounts a ON a.id = m.account_id
       WHERE ${owner}${sealedOnly}${keyset}
       ${order}
       LIMIT ${limit}`),
  )

  const totals = extractRows<{ total: number }>(
    await tx.execute(drizzleSql`
      SELECT count(*)::int AS total
        FROM ${MAIL}.messages m
        JOIN ${MAIL}.accounts a ON a.id = m.account_id
       WHERE ${owner}${sealedOnly}`),
  )

  const items: SealedListingItem[] = rows.map((row) => {
    const item: SealedListingItem = {
      sealed: {
        id: row.id,
        encVersion: row.enc_version ?? 0,
        encKeyId: row.enc_key_id ?? null,
        contentKeyWrapped: b64(row.content_key_wrapped),
        contentKeyEpk: b64(row.content_key_epk),
        subjectCiphertext: b64(row.subject_ciphertext),
        textBodyCiphertext: b64(row.text_body_ciphertext),
        htmlBodyCiphertext: b64(row.html_body_ciphertext),
        snippetCiphertext: b64(row.snippet_ciphertext),
      },
      envelope: {
        accountId: row.account_id,
        conversationId: row.conversation_id,
        sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
        metadata: metadataOf(row),
      },
    }
    if (mode === "verify") {
      const present = hasPlaintextHalf(row)
      item.hasPlaintext = present
      if (present) {
        item.plaintext = {
          subject: row.subject ?? null,
          textBody: row.text_body ?? null,
          htmlBody: row.html_body ?? null,
          snippet: row.snippet ?? null,
        }
      }
    }
    return item
  })

  const last = rows[rows.length - 1]
  const nextCursor = last
    ? mode === "verify"
      ? last.id
      : `${new Date(last.updated_at ?? 0).toISOString()}|${last.id}`
    : (cursor ?? "")

  return {
    cursor: nextCursor,
    // `done` is decided by the page being short, never by the running count:
    // rows can arrive mid walk, and a count-based stop would end the listing
    // while messages the caller has not seen are still behind the cursor.
    done: rows.length < limit,
    total: totals[0]?.total ?? 0,
    items,
  }
}
