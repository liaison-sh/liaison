// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Signing mail never enters Mail. Every link and code mail carries
// `X-Liaison-Action-Mail: <128-bit random>`, the id stored on its event
// (`client_action_events.mail_id`). When a synced mailbox brings one back (a
// staff signer's own inbox, the sender's Sent folder, a bounce quoting it), the
// page writer asks here which of the page's ids are this org's, and drops those
// messages before anything is stored. The header alone skips nothing: an id
// that matches no row of this org is ordinary mail, so a forged header is
// stored as usual.
//
// The lookup is privileged because the syncing actor holds no client action
// scope (and a restricted action is hidden even from one who does); it reads
// one indexed column of this org's trail and answers which ids exist, nothing
// else.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

/** `ACTION_MAIL_HEADER` of mail.ts, kept literal so the page writer loads no mail sender. */
const ACTION_MAIL_HEADER = "X-Liaison-Action-Mail"
const MAIL_ID = /^[0-9a-f]{32}$/
const HEADER_NAME = ACTION_MAIL_HEADER.toLowerCase()
/** The header as a line of a quoted or bounced copy's text (a delivery report's headers part). */
const QUOTED_HEADER = new RegExp(`^[>\\s]*${ACTION_MAIL_HEADER}:\\s*([0-9a-f]{32})\\s*$`, "gim")

interface MailLike {
  headers?: Record<string, unknown>
  textBody?: string | null
}

/** The action mail ids a message carries: its header, and the header quoted in its text. */
export function actionMailIdsOf(message: MailLike): string[] {
  const ids = new Set<string>()
  const headers = message.headers
  if (headers && typeof headers === "object") {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== HEADER_NAME) continue
      const raw = headers[key]
      for (const v of Array.isArray(raw) ? raw : [raw]) {
        for (const part of String(v ?? "").split(",")) {
          const id = part.trim().toLowerCase()
          if (MAIL_ID.test(id)) ids.add(id)
        }
      }
    }
  }
  const text = message.textBody
  if (text && text.length > 0 && text.toLowerCase().includes(HEADER_NAME)) {
    for (const m of text.matchAll(QUOTED_HEADER)) if (m[1]) ids.add(m[1].toLowerCase())
  }
  return [...ids]
}

/** Which of `ids` name a sent link or code mail of this org. */
export async function knownActionMailIds(orgId: string, ids: string[]): Promise<Set<string>> {
  const wanted = [...new Set(ids.filter((id) => MAIL_ID.test(id)))]
  if (wanted.length === 0) return new Set()
  const K = sql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedDb(orgId, "client-action-synced-mail", async (tx) =>
    extractRows<{ mail_id: string }>(
      await tx.execute(sql`
        SELECT DISTINCT mail_id FROM ${K}.client_action_events
         WHERE org_id = ${orgId}::uuid AND mail_id = ANY(${`{${wanted.join(",")}}`}::text[])`),
    ),
  )
  return new Set(rows.map((r) => r.mail_id))
}

/**
 * The messages of a page that are not this org's own signing mail. Messages
 * without the header cost nothing; the lookup runs only when one carries it.
 */
export async function withoutActionMail<T extends MailLike>(
  orgId: string,
  messages: T[],
): Promise<{ kept: T[]; dropped: number }> {
  const idsByMessage = messages.map((m) => actionMailIdsOf(m))
  const all = idsByMessage.flat()
  if (all.length === 0) return { kept: messages, dropped: 0 }
  const known = await knownActionMailIds(orgId, all)
  if (known.size === 0) return { kept: messages, dropped: 0 }
  const kept = messages.filter((_, i) => !(idsByMessage[i] ?? []).some((id) => known.has(id)))
  return { kept, dropped: messages.length - kept.length }
}
