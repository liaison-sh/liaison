// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S10. The title of a mail conversation TAB. Every opener names the tab with
// what it had at hand: the inbox row's subject, but also a Home card's or a
// notification's text ("Nouveau mail de Elodie") or a mention's link text.
// Those are stand-ins: once the conversation is loaded, the tab is titled with
// its subject. A sealed conversation the mailbox cannot open yet is titled
// "Conversation", and its subject once the mailbox is unlocked.
//
// Read in two places: the tab type's `resolveLabel` (what the tab strip and
// the phone header print), and MailConversation, which also writes it into the
// stored tab label so a restored tab starts with the subject.
import { tNow } from "~/modules/i18n/i18n-context"
import { conversationStore } from "~/modules/mail/mail-conversation-store"
import { deriveSubject, openedSubjectOf } from "~/modules/mail/mail-conversation-subject"
import { getMessages } from "~/modules/mail/mail-message-store"

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The conversation's tab title, or undefined while nothing about it is loaded
 * (the opener's own label stands until then).
 */
export function mailConversationTabLabel(
  conversationId: string,
  t: Translate = tNow,
): string | undefined {
  if (!conversationId) return undefined
  const conversation = conversationStore.byId[conversationId]
  const messages = getMessages(conversationId)
  if (!conversation && messages.length === 0) return undefined

  const subject = (conversation?.subject ?? "").trim()
  if (subject) return subject
  // A sealed conversation's own subject is ciphertext; an opened message
  // carries the real one.
  const opened = openedSubjectOf(messages)
  if (opened) return opened
  const locked = messages.some((m) => (m as { encState?: string }).encState === "locked")
  if (locked || conversation?.sealed) return t("kernel.mailSubjectFallback")
  if (!conversation) return undefined
  return deriveSubject(conversation, false, t)
}
