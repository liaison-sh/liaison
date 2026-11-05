// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The words for an attention kind on Settings -> Notifications. A kind id
// (`shopify:order.created`, `thread_reply`) is never shown: the catalog names
// the ones Liaison and its bundled apps emit, and a kind from any other app is
// turned into plain words from its last part.

import { catalogHasKey, type Translate } from "~/modules/i18n/i18n-context"

/**
 * Every kind the kernel attention translator emits for the `kernel` source
 * (apps/api/src/modules/attention/kernel-translations.ts; a test keeps the two
 * equal). A subscription rule is an allow-list once it exists
 * (subscriptions.ts), so dropping one kind from the Liaison row stores all the
 * others: a kind missing here would stop reaching that person silently.
 */
export const KERNEL_RULE_KINDS: readonly string[] = [
  "thread_reply",
  "thread_followup",
  "mention",
  "approval_decision",
  "file_shared",
  "agent_notification",
  "routine_mailbox_wait",
  "scope_request",
  "scope_request_decided",
  "system_alert",
]

/**
 * The Liaison row's kinds a person can see. No rule can silence a mention or a
 * system alert (translator.ts HIGH_SIGNAL_KINDS), so those two are shown
 * ticked and locked with the reason, never as a box that changes nothing.
 */
export const KERNEL_ROW_KINDS: ReadonlyArray<{ kind: string; locked: boolean }> = [
  { kind: "mention", locked: true },
  { kind: "system_alert", locked: true },
  { kind: "thread_reply", locked: false },
  { kind: "thread_followup", locked: false },
]

function catalogKey(kind: string): string {
  return `kernel.notificationSettings.kinds.${kind.replace(/[:.]/g, "_")}`
}

function humanise(kind: string): string {
  const tail = kind.includes(":") ? kind.slice(kind.indexOf(":") + 1) : kind
  const words = tail
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase()
  if (words.length === 0) return ""
  return words[0]!.toUpperCase() + words.slice(1)
}

export function kindLabel(kind: string, t: Translate): string {
  const key = catalogKey(kind)
  return catalogHasKey(key) ? t(key) : humanise(kind)
}
