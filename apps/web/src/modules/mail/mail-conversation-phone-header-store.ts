// SPDX-License-Identifier: FSL-1.1-ALv2
//
// K4. `MailConversationPhoneHeader` (the phone top bar's registered header for
// the mail conversation tab) and `MailConversation` (the tab body) are two
// SEPARATE components — the header is rendered by MainPanel's phone top bar
// through the registry, the body inside the tab content area — but the "⋯"
// actions sheet the header's button opens carries content (archive, convert to
// ticket, discuss) that needs the conversation's already-loaded data and
// mutation calls, which live in MailConversation. This tiny signal is the
// shared switch between them: the header flips it open, the body renders the
// sheet from it. Mirrors `ticket-phone-header-store.ts`.
import { createSignal } from "solid-js"

const [openForConversationId, setOpenForConversationId] = createSignal<string | null>(null)

export function openMailConversationMoreSheet(conversationId: string): void {
  setOpenForConversationId(conversationId)
}

export function closeMailConversationMoreSheet(): void {
  setOpenForConversationId(null)
}

export function isMailConversationMoreSheetOpen(conversationId: string): boolean {
  return openForConversationId() === conversationId
}
