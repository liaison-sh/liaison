// SPDX-License-Identifier: FSL-1.1-ALv2
//
// K4. `deriveSubject` used to live only inside `MailConversation.tsx`.
// `MailConversationPhoneHeader.tsx` needs the exact same fallback chain for
// its own subject line (a bare `phoneHeader` import of the tab body would
// eagerly bundle the whole conversation screen into the phone top bar), so it
// moved to its own module both import.
import type { Conversation } from "~/modules/mail/mail-conversation-store"

/** The translator, passed in: this is a pure function, outside any component. */
type Translate = (key: string, params?: Record<string, string | number>) => string

/** The subject of the newest message this browser has opened, if any. */
export function openedSubjectOf(
  messages: ReadonlyArray<{ encState?: string; subject?: string | null }>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const subject = (message?.subject ?? "").trim()
    if (message?.encState === "opened" && subject) return subject
  }
  return null
}

export function deriveSubject(
  c: Conversation | undefined,
  locked: boolean,
  t: Translate,
  openedSubject?: string | null,
): string {
  if (!c) return t("kernel.mailSubjectFallback")
  const trimmed = (c.subject ?? "").trim()
  if (trimmed) return trimmed
  // A sealed conversation's own subject is ciphertext; the opened messages
  // carry the real one.
  if (openedSubject?.trim()) return openedSubject.trim()
  // A sealed conversation whose subject has not been opened says so, rather
  // than falling back to a sender line that reads like the real subject (or to
  // "no subject", which is false).
  if (locked || c.sealed) return t("kernel.mailSubjectLocked")
  const sender = (c.senderName ?? c.senderEmail ?? "").trim()
  if (sender) return t("kernel.mailSubjectWithSender", { sender })
  return c.snippet?.trim() || t("kernel.mailSubjectFallback")
}
