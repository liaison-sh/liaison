// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F3. Chats is a ROOT screen at phone tier, not an overlay: the seat opens the
// `kernel:chats` tab, and picking a row pushes the thread route on top of it.
// The seat therefore has to stay lit while the user is reading that thread,
// which the tab store alone cannot say (a thread tab looks the same whichever
// screen opened it). This is the one bit of state that answers it: the id of
// the conversation Chats pushed.
import { createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"

const [chatsThreadId, setChatsThreadIdSignal] = createSignal<string | null>(null)

export { chatsThreadId }

/** Record the conversation the Chats root has just pushed. */
export function setChatsThreadId(threadId: string | null): void {
  setChatsThreadIdSignal(threadId)
}

export function resetChatsRootStore(): void {
  setChatsThreadIdSignal(null)
}

onSessionTeardown(resetChatsRootStore)
