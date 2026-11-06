// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The send check's final say. An agent-staged mail must not go when the state
 * says it must not: a person answered, the address failed, or the person is away
 * and nobody has chosen to send anyway. Pure, so one decision serves the
 * preflight, the card and the handler alike.
 */
import type { InboundKind } from "~/modules/mail/classify-inbound"
import { parseReturnDate } from "~/modules/mail/parse-return-date"

export interface GuardInbound {
  id: string
  kind: InboundKind
  sender: string | null
  /** When it was sent, or when it was synced for a mail with no sent date. */
  at: Date
  /** The cleartext body the hold date is read from; null on a sealed mailbox. */
  textBody: string | null
}

export interface DecideSendGuardInputs {
  inbound: readonly GuardInbound[]
  now: Date
  /** Set only by a person's "send now" on a hold. */
  ignoreAutoReply?: { by: string; at: string }
  /** The requester's, for the hold date. */
  locale?: string | null
  timeZone?: string | null
}

interface NamedMessage {
  messageId: string
  who: string | null
  at: Date
}

export type SendGuardDecision =
  | { state: "clear" }
  | ({ state: "replied" | "bounced"; final: true } & NamedMessage)
  | ({
      state: "held"
      final: false
      /** Null when the message states no usable date and the default applies. */
      returnDate: string | null
      holdUntil: Date
    } & NamedMessage)

function newestOf(inbound: readonly GuardInbound[], kind: InboundKind): GuardInbound | null {
  let newest: GuardInbound | null = null
  for (const item of inbound) {
    if (item.kind !== kind) continue
    if (newest === null || item.at.getTime() > newest.at.getTime()) newest = item
  }
  return newest
}

function named(item: GuardInbound): NamedMessage {
  return { messageId: item.id, who: item.sender, at: item.at }
}

/**
 * A reply stops the send whatever came after it, so a person's answer followed
 * by their out-of-office does not read as "away". Only a hold can be overridden.
 */
export function decideSendGuard(inputs: DecideSendGuardInputs): SendGuardDecision {
  const { inbound, now, ignoreAutoReply, locale, timeZone } = inputs
  const reply = newestOf(inbound, "reply")
  if (reply) return { state: "replied", final: true, ...named(reply) }

  const bounce = newestOf(inbound, "bounce")
  if (bounce) return { state: "bounced", final: true, ...named(bounce) }

  const autoReply = newestOf(inbound, "auto_reply")
  if (autoReply && !ignoreAutoReply) {
    const { returnDate, holdUntil } = parseReturnDate(
      autoReply.textBody,
      autoReply.at,
      locale,
      timeZone,
    )
    if (now.getTime() < holdUntil.getTime()) {
      return { state: "held", final: false, ...named(autoReply), returnDate, holdUntil }
    }
  }
  return { state: "clear" }
}
