// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-2 T14. What the phone mail screen SAYS it is showing, derived from the
// two stores the desktop already reads (the current view and the account
// list) rather than from anything the phone markup keeps of its own.
//
// It lives apart from MailInbox because a title that is wrong is a navigation
// bug, not a styling one: a reader who taps a shared folder and still reads
// "Inbox" over someone else's address has no way to tell where they are. A
// derivation in its own module can be pinned by a test that never renders.

import type { MailAccount } from "~/modules/mail/mail-account-store"
import type { Conversation, ViewType } from "~/modules/mail/mail-conversation-store"

/** The i18n key naming the folder the reader is in. */
export function mailFolderLabelKey(view: ViewType): string {
  if (view === "assigned-to-me") return "kernel.mailFolderAssigned"
  if (view === "starred") return "kernel.mailFolderStarred"
  if (view === "sent") return "kernel.mailFolderSent"
  if (view === "drafts") return "kernel.mailFolderDrafts"
  if (view === "trash") return "kernel.mailFolderTrash"
  return "kernel.mailFolderInbox"
}

/**
 * The muted line under the title. One address whenever the folder belongs to
 * exactly one account (a shared folder, a lone connected mailbox, the
 * personal group), and otherwise the count, because naming only the first of
 * four accounts would read as a filter that is not applied.
 */
export type MailAccountLine =
  | { kind: "address"; address: string }
  | { kind: "all"; count: number }
  | { kind: "none" }

export function mailAccountLine(view: ViewType, accounts: readonly MailAccount[]): MailAccountLine {
  if (accounts.length === 0) return { kind: "none" }

  if (view.startsWith("inbox:") && view !== "inbox:personal") {
    const accountId = view.slice("inbox:".length)
    const account = accounts.find((a) => a.id === accountId)
    if (account) return { kind: "address", address: accountAddress(account) }
    return { kind: "all", count: accounts.length }
  }

  const scope =
    view === "inbox:personal" ? accounts.filter((a) => a.ownerType === "user") : accounts
  if (scope.length === 0) return { kind: "none" }
  if (scope.length === 1) return { kind: "address", address: accountAddress(scope[0]!) }
  return { kind: "all", count: scope.length }
}

function accountAddress(account: MailAccount): string {
  return account.emailAddress || (account.displayName ?? "")
}

/** The segmented control's three seats. */
export type MailPhoneFilter = "unread" | "all" | "starred"

export const MAIL_PHONE_FILTERS: readonly MailPhoneFilter[] = ["unread", "all", "starred"]

/**
 * Whether a conversation belongs in one of the three seats. Both `isRead` and
 * `isStarred` are already on every row the list store holds, so the filter is
 * a predicate over what is loaded: no second request, which is the condition
 * the batch put on offering all three.
 */
export function matchesMailPhoneFilter(
  conversation: Pick<Conversation, "isRead" | "isStarred">,
  filter: MailPhoneFilter,
): boolean {
  if (filter === "unread") return !conversation.isRead
  if (filter === "starred") return conversation.isStarred
  return true
}

/** The count the `Unread` seat carries. */
export function unreadCount(conversations: readonly Pick<Conversation, "isRead">[]): number {
  return conversations.filter((c) => !c.isRead).length
}

/** A forwarded draft's subject, without stacking a second prefix on a reply
 *  that already carries one. */
export function forwardSubject(subject: string | null | undefined): string {
  const trimmed = (subject ?? "").trim()
  if (!trimmed) return "Fwd:"
  if (/^fwd:/i.test(trimmed)) return trimmed
  return `Fwd: ${trimmed}`
}

/** The quoted body a forward opens on: who wrote, when, and what they said. */
export function forwardBody(message: {
  fromName?: string | null
  fromEmail?: string | null
  sentAt?: string | null
  textBody?: string | null
  htmlBody?: string | null
}): string {
  const who = message.fromName?.trim() || message.fromEmail?.trim() || "Unknown sender"
  const when = message.sentAt ? new Date(message.sentAt).toISOString() : ""
  const body = (message.textBody ?? "").trim() || stripTags(message.htmlBody ?? "")
  return [`Forwarded message from ${who}${when ? ` (${when})` : ""}:`, "", body].join("\n")
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}
