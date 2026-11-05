// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The server-side answer to a mailbox marker, for server-managed mailboxes.
//
// A tool reading a personal mailbox returns an envelope plus a marker
// (`needsPlaintext` / `needsClientSearch`). For a PRIVATE (zero-access)
// mailbox the broker has to ask the owner's unlocked browser. For a mailbox in
// the `managed` encryption state the server holds the mailbox's data key, so it
// answers itself here: no browser, no nonce, so routines and jobs read it too.
//
// The answer has exactly the shape a browser would give
// (`MailboxRequestOutcome`), so everything after it (context block, retry
// arguments, transcript redaction) is the same code for both modes.
//
// Who may read is decided by `managed-open.ts`: the mailbox owner (or a host
// job for them), never an admin or another member. Every read is audited there.
//
// Returns null when the marker touches anything that is not a managed mailbox
// of this reader; the caller then takes the browser path unchanged.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import type { MailboxMarker } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import type { MailboxRequestResponse } from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import {
  type ManagedOpenPurpose,
  openManagedFile,
  openManagedMailRowsByAccount,
} from "~/modules/mailbox-crypto/managed-open"

const log = rootLogger.child({ module: "mailbox-managed-reader" })

/** How many messages a server-side search opens at most, newest first. */
export const MANAGED_SEARCH_SCAN_CAP = 2000
/** How many matches a server-side search returns at most. */
export const MANAGED_SEARCH_MATCH_CAP = 200

const mail = () => drizzleSql.raw(quoteIdent(schemaRef("app_mail")))

type Exec = { execute(q: unknown): Promise<unknown> }

interface ScopeAccount {
  id: string
  owner_id: string | null
  encryption_state: string | null
}

/** Personal accounts under encryption that a search marker covers, for this reader. */
async function searchScope(
  tx: Exec,
  orgId: string,
  userId: string,
  accountId: string | undefined,
): Promise<ScopeAccount[]> {
  return extractRows<ScopeAccount>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, owner_id::text AS owner_id, encryption_state
        FROM ${mail()}.accounts
       WHERE org_id = ${orgId}::uuid AND owner_type = 'user'
         AND ${accountId ? drizzleSql`id = ${accountId}::uuid` : drizzleSql`owner_id = ${userId}::uuid`}
         AND encryption_state IN ('ready', 'blocked', 'paused', 'managed')`),
  )
}

function accountFilterOf(marker: MailboxMarker): string | undefined {
  const filters = marker.search?.filters
  if (!filters || typeof filters !== "object") return undefined
  const value = (filters as Record<string, unknown>).accountId
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function terms(query: string | undefined): string[] {
  return (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Answer a marker server-side when every row it names lives in a managed
 * mailbox owned by `userId`. Null means "not mine to answer": take the browser
 * path.
 */
export async function answerManagedMarker(input: {
  orgId: string
  userId: string
  marker: MailboxMarker
  purpose: ManagedOpenPurpose
}): Promise<MailboxRequestResponse | null> {
  const { orgId, userId, marker } = input
  if (!userId) return null
  try {
    if (marker.requestKind === "mail.search") return await answerSearch(input)
    if (marker.messageIds.length === 0) return null
    if (marker.requestKind === "mail.attachment") return await answerAttachments(input)

    const rows = await withPrivilegedDb(orgId, "mailbox-managed:marker-rows", async (tx) =>
      extractRows<
        Record<string, unknown> & { id: string; encryption_state: string; owner_id: string }
      >(
        await tx.execute(drizzleSql`
          SELECT m.*, a.encryption_state, a.owner_id::text AS owner_id
            FROM ${mail()}.messages m
            JOIN ${mail()}.accounts a ON a.id = m.account_id AND a.org_id = m.org_id
           WHERE m.org_id = ${orgId}::uuid
             AND m.id IN (${drizzleSql.join(
               marker.messageIds.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})`),
      ),
    )
    if (rows.length === 0) return null
    if (!rows.every((r) => r.encryption_state === "managed" && r.owner_id === userId)) return null
    // A conversion makes personal mail readable by the whole team. On a private
    // mailbox the owner confirms that in their own browser; a server-side read
    // has no one to confirm it with, and a routine or an instruction planted in
    // an inbound mail must never be enough. Refuse before opening anything: the
    // owner converts it themselves, from the conversation in Mail.
    if (marker.requestKind === "mail.convert") {
      return {
        kind: "denied",
        reason:
          "converting a personal mailbox's conversation makes it readable by the team, which only its owner can decide: ask the owner to convert it themselves from the conversation in Mail",
      }
    }
    const opened = await openManagedMailRowsByAccount({
      orgId,
      entity: "messages",
      rows,
      actor: { userId },
      purpose: input.purpose,
    })
    const items: Extract<MailboxRequestResponse, { kind: "plaintext" }>["items"] = []
    const undecryptable: string[] = []
    for (const row of rows) {
      const fields = opened.get(row.id)
      if (!fields) {
        // A row stored before its mailbox moved to managed (plaintext columns)
        // is read as it is; anything else did not open.
        if (Number(row.enc_version ?? 0) === 0) {
          items.push({
            messageId: row.id,
            subject: (row.subject as string | null) ?? null,
            textBody: (row.text_body as string | null) ?? null,
            htmlBody: (row.html_body as string | null) ?? null,
          })
        } else {
          undecryptable.push(row.id)
        }
        continue
      }
      items.push({
        messageId: row.id,
        subject: fields.subject ?? null,
        textBody: fields.textBody ?? null,
        htmlBody: fields.htmlBody ?? null,
      })
    }
    return { kind: "plaintext", items, undecryptable }
  } catch (err) {
    log.error(
      { err, orgId, kind: marker.requestKind, count: marker.messageIds.length },
      "Server-side read of a managed mailbox failed",
    )
    return null
  }
}

async function answerAttachments(input: {
  orgId: string
  userId: string
  marker: MailboxMarker
  purpose: ManagedOpenPurpose
}): Promise<MailboxRequestResponse | null> {
  const items: Array<{ messageId: string; bytesBase64: string }> = []
  for (const fileId of input.marker.messageIds) {
    const opened = await withPrivilegedDb(input.orgId, "mailbox-managed:marker-file", (tx) =>
      openManagedFile(tx, {
        orgId: input.orgId,
        userId: input.userId,
        fileId,
        purpose: input.purpose,
      }),
    ).catch(() => null)
    // Any file that is not a managed one of this reader: take the browser path.
    if (!opened) return null
    items.push({ messageId: fileId, bytesBase64: opened.bytes.toString("base64") })
  }
  return { kind: "plaintext", items, undecryptable: [] }
}

async function answerSearch(input: {
  orgId: string
  userId: string
  marker: MailboxMarker
  purpose: ManagedOpenPurpose
}): Promise<MailboxRequestResponse | null> {
  const { orgId, userId, marker } = input
  const words = terms(marker.search?.query)
  const scanned = await withPrivilegedDb(orgId, "mailbox-managed:search-scan", async (tx) => {
    const scope = await searchScope(tx, orgId, userId, accountFilterOf(marker))
    // Only when EVERY encrypted mailbox in scope is a managed one of this
    // reader: a private mailbox's text can only be searched by its browser.
    if (scope.length === 0) return null
    if (!scope.every((a) => a.encryption_state === "managed" && a.owner_id === userId)) return null
    // Newest first, capped: the same order every mail read uses.
    return extractRows<Record<string, unknown> & { id: string; account_id: string }>(
      await tx.execute(drizzleSql`
        SELECT id, account_id, enc_version, enc_key_id, content_key_wrapped,
               subject_ciphertext, snippet_ciphertext, subject, snippet
          FROM ${mail()}.messages
         WHERE org_id = ${orgId}::uuid
           AND account_id IN (${drizzleSql.join(
             scope.map((a) => drizzleSql`${a.id}::uuid`),
             drizzleSql`, `,
           )})
         ORDER BY sent_at DESC NULLS LAST
         LIMIT ${MANAGED_SEARCH_SCAN_CAP}`),
    )
  })
  if (scanned === null) return null
  if (words.length === 0) return { kind: "search", messageIds: [], indexComplete: true }
  const opened = await openManagedMailRowsByAccount({
    orgId,
    entity: "messages",
    rows: scanned,
    actor: { userId },
    // The real actor: the tool (and agent or routine) that searched.
    purpose: input.purpose,
  })
  const matches: string[] = []
  for (const row of scanned) {
    const fields = opened.get(row.id)
    const haystack = (
      fields
        ? `${fields.subject ?? ""}\n${fields.snippet ?? ""}`
        : `${(row.subject as string | null) ?? ""}\n${(row.snippet as string | null) ?? ""}`
    ).toLowerCase()
    if (words.every((w) => haystack.includes(w))) {
      matches.push(row.id)
      if (matches.length >= MANAGED_SEARCH_MATCH_CAP) break
    }
  }
  return {
    kind: "search",
    messageIds: matches,
    // A scan that hit its cap did not look at the whole mailbox.
    indexComplete: scanned.length < MANAGED_SEARCH_SCAN_CAP,
  }
}

/**
 * The reader's own PRIVATE (zero-access, `ready`) mailboxes a marker needs,
 * as mail account ids, or null when it needs anything else (a managed mailbox,
 * someone else's, an attachment). Only the owner's unlocked browser can answer
 * such a marker, so a routine tick that meets one waits for its owner instead
 * of ending (routine-mailbox-wait.ts). Reads ids and states only, never content.
 */
export async function privateMailboxAccountsOf(input: {
  orgId: string
  userId: string
  marker: MailboxMarker
}): Promise<string[] | null> {
  const { orgId, userId, marker } = input
  if (!userId) return null
  try {
    const accounts = await withPrivilegedDb(
      orgId,
      "mailbox-private:marker-accounts",
      async (tx) => {
        if (marker.requestKind === "mail.search") {
          return await searchScope(tx, orgId, userId, accountFilterOf(marker))
        }
        if (marker.requestKind === "mail.attachment" || marker.messageIds.length === 0) return []
        return extractRows<ScopeAccount>(
          await tx.execute(drizzleSql`
          SELECT DISTINCT a.id::text AS id, a.owner_id::text AS owner_id, a.encryption_state
            FROM ${mail()}.messages m
            JOIN ${mail()}.accounts a ON a.id = m.account_id AND a.org_id = m.org_id
           WHERE m.org_id = ${orgId}::uuid
             AND a.owner_type = 'user'
             AND m.id IN (${drizzleSql.join(
               marker.messageIds.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})`),
        )
      },
    )
    if (accounts.length === 0 || !accounts.every((a) => a.owner_id === userId)) return null
    const ready = accounts.filter((a) => a.encryption_state === "ready").map((a) => a.id)
    return ready.length > 0 ? ready : null
  } catch (err) {
    log.warn({ err, orgId }, "Could not tell whether a marker needs a private mailbox")
    return null
  }
}
