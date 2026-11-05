// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE NON-SECRET SETTINGS A PERSON ALREADY APPROVED, FOR THE SECRET CARD.
//
// An agent connects an IMAP mailbox in two steps: `config_mail` (or
// `config_tickets`) carries the hosts, ports and username and is approved on a
// card, then `request_secret` asks for the password. The credentials card used
// to ask for all seven fields again, empty. It now shows the approved settings
// read-only and asks only for what is secret.
//
// The settings come from the APPROVED config call, read on the server, never
// from the request_secret call: the agent cannot point a password at a host
// nobody approved. Only the fields the connection declares as non-secret are
// taken, and only for the account the request names.

import { IMAP_PROVIDERS, isGmailAddress } from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests, approvedHandlerExecutions } from "~/db/schema/kernel"
import { isRecord } from "~/lib/guards"

/** The config sections whose entries create an app's IMAP connection, and their list key. */
const SECTION_OF_APP: Record<string, { tool: string; section: string; list: string }> = {
  mail: { tool: "kernel:config_mail", section: "mail", list: "mailboxes" },
  tickets: { tool: "kernel:config_tickets", section: "tickets", list: "inboxes" },
}

/** The approved config calls read back, newest first. */
const APPROVED_CALLS_READ = 20

/**
 * The non-secret IMAP settings of `address` from the newest approved config
 * call that names it and whose handler ran successfully, restricted to `fields` (the connection's non-secret
 * credential fields), as strings. Empty when no approved call names it.
 */
export async function approvedImapSettings(
  orgId: string,
  app: string,
  address: string,
  fields: readonly string[],
): Promise<Record<string, string>> {
  const source = SECTION_OF_APP[app]
  if (!source || fields.length === 0) return {}
  const rows = await withPrivilegedDb(orgId, "secret-card-approved-settings", (tx) =>
    // Approved AND run: the config call's handler recorded a success, so
    // the settings are the ones the person approved and the platform applied.
    tx
      .select({ payload: approvalRequests.currentPayload })
      .from(approvalRequests)
      .innerJoin(
        approvedHandlerExecutions,
        and(
          eq(approvedHandlerExecutions.approvalRequestId, approvalRequests.id),
          eq(approvedHandlerExecutions.orgId, approvalRequests.orgId),
        ),
      )
      .where(
        and(
          eq(approvalRequests.orgId, orgId),
          eq(approvalRequests.toolName, source.tool),
          eq(approvalRequests.status, "approved"),
          eq(approvedHandlerExecutions.status, "succeeded"),
        ),
      )
      .orderBy(sql`${approvedHandlerExecutions.finishedAt} DESC NULLS LAST`)
      .limit(APPROVED_CALLS_READ),
  )
  const wanted = address.trim().toLowerCase()
  for (const row of rows) {
    const sectionValue = isRecord(row.payload) ? row.payload[source.section] : undefined
    const list = isRecord(sectionValue) ? sectionValue[source.list] : undefined
    if (!Array.isArray(list)) continue
    const entry = list.find(
      (e) => isRecord(e) && typeof e.address === "string" && e.address.toLowerCase() === wanted,
    )
    const imap = isRecord(entry) ? entry.imap : undefined
    if (!isRecord(imap)) continue
    const out: Record<string, string> = {}
    for (const name of fields) {
      const v = imap[name]
      if (typeof v === "string" && v.trim() !== "") out[name] = v.trim()
      else if (typeof v === "number" && Number.isFinite(v)) out[name] = String(v)
    }
    return out
  }
  return {}
}

/**
 * The servers of a mailbox whose provider the address alone names: a personal
 * Gmail address (@gmail.com) always signs in at Google's IMAP and SMTP servers
 * with the address as the username, so the card asks only for the app
 * password. Fixed values, never taken from the request. Restricted to
 * `fields`; empty for any other address.
 */
export function knownImapSettings(
  address: string,
  fields: readonly string[],
): Record<string, string> {
  if (!isGmailAddress(address)) return {}
  const p = IMAP_PROVIDERS.gmail
  const known: Record<string, string> = {
    imapHost: p.imapHost,
    imapPort: String(p.imapPort),
    smtpHost: p.smtpHost,
    smtpPort: String(p.smtpPort),
    username: address.trim().toLowerCase(),
  }
  const out: Record<string, string> = {}
  for (const name of fields) if (known[name] !== undefined) out[name] = known[name]
  return out
}
