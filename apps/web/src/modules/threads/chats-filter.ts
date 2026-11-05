// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two small questions the phone Chats root asks of a conversation, kept out of
// the component so they can be pinned against a seeded store rather than
// against a render. (The root used to narrow its flat column with four chips;
// it is sectioned now, Unread / Channels / Direct messages, by
// `thread-list-model.ts`, and these two predicates are what is left.)
import type { Thread } from "~/modules/threads/thread-store"

export function isPinnedThread(thread: Pick<Thread, "isPinned" | "isPinnedByUser">): boolean {
  return Boolean(thread.isPinned) || Boolean(thread.isPinnedByUser)
}
