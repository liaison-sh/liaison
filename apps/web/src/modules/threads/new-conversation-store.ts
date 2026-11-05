// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which "new conversation" dialog is open: a new CHANNEL or a new DIRECT
// MESSAGE. They are two dialogs because they are two different acts, the way
// Slack splits them: a channel is a named place people join, a DM is a
// conversation with somebody. The old single "New thread" dialog asked for
// people first and made the room a channel only if a title was typed, which
// is the WhatsApp-era model this replaces.
//
// The shell renders both dialogs once; the sidebar's per-section "+", the
// phone Chats compose button and the command palette all open them through
// here, so none of them needs the shell's local state.

import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export type NewConversationKind = "channel" | "message"

const [open, setOpen] = createSignal<NewConversationKind | null>(null)

/** The dialog currently open, or null. */
export const newConversationDialog = open

export function openNewChannelDialog(): void {
  setOpen("channel")
}

export function openNewMessageDialog(): void {
  setOpen("message")
}

export function closeNewConversationDialog(): void {
  setOpen(null)
}

onSessionTeardown(closeNewConversationDialog)
