// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a link mail goes on, kept with the trail's `sent` event for a mail that leaves later than
// the decision it was made by (a server that stopped; unsent-links.ts). Kept: the check the card
// pinned, without its addresses (the links have them), the card's id and a fingerprint of the
// message. Never the message: a later mail reads it from the card, and only while it is that text.

import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  evaluateSendGuard,
  isPinnedSendGuard,
  type PinnedSendGuard,
} from "~/modules/mail/send-guard"

/** The decision a mail goes on: the card's pinned check, and the card. */
export interface MailDecision {
  guard?: PinnedSendGuard | null
  approvalId?: string | null
}

export type OwedMailMeta = {
  check?: Omit<PinnedSendGuard, "addresses" | "line">
  card?: string
  message_sha256?: string
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

export function owedMailMeta(decision: MailDecision | null, message: string | null): OwedMailMeta {
  const { guard, approvalId } = decision ?? {}
  const meta: OwedMailMeta = {}
  if (guard) {
    const { addresses: _, line: _line, ...check } = guard
    meta.check = check
  }
  if (approvalId && message) {
    meta.card = approvalId
    meta.message_sha256 = sha256(message)
  }
  return meta
}

/**
 * Why a mail owed to one signer may not go now: what the check of its send answers for every
 * signer's address, as it did when the send went; `unavailable` when the check could not run; null
 * when it may go or no check was pinned.
 */
export async function heldBack(
  orgId: string,
  owed: OwedMailMeta,
  addresses: string[],
): Promise<string | null> {
  if (!owed.check) return null
  const guard = { ...owed.check, addresses }
  if (!isPinnedSendGuard(guard)) return "unreadable"
  const verdict = await evaluateSendGuard({ orgId, guard, recipients: addresses, at: "send" })
  return verdict.state === "clear" ? null : verdict.state
}

/** The message its requester typed, read from the card while that card holds the very text. */
export async function typedMessage(orgId: string, owed: OwedMailMeta): Promise<string | null> {
  if (!owed.card || !owed.message_sha256) return null
  const [card] = await withPrivilegedDb(orgId, "client-action-typed-message", async (tx) =>
    extractRows<{ message: string | null }>(
      await tx.execute(sql`
        SELECT current_payload->>'message' AS message
          FROM ${sql.raw(schemaRef("kernel"))}.approval_requests
         WHERE id = ${owed.card}::uuid AND org_id = ${orgId}
      `),
    ),
  )
  const message = card?.message ?? null
  return message !== null && sha256(message) === owed.message_sha256 ? message : null
}
