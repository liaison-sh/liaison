// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which `kernel.threads.type` values are conversations people chat in.
//
// A routine's output thread (`routine`) is the run log of that routine, read
// from the agent page's Routines tab; a sub-run thread (`subrun`) is the hidden
// transcript of a delegated run. Neither is a room: nobody sits down to talk
// there, and a list, a badge or a notification that treats one as a chat
// message is noise nobody can clear. The rule is by TYPE, so a routine thread
// created tomorrow is covered without anybody remembering a flag on its row.

/** Thread types that are run logs, never chat rooms. */
export const RUN_LOG_THREAD_TYPES: readonly string[] = ["routine", "subrun"]

/** Is a thread of this type a run log (a routine's or a sub-run's)? */
export function isRunLogThreadType(type: string | null | undefined): boolean {
  return typeof type === "string" && RUN_LOG_THREAD_TYPES.includes(type)
}

/** Thread types that are never chat list rows: the run logs, and the approval
 *  anchors (opened from their approval card, never from Channels). The server
 *  list predicate (`messagesListShows`) keeps the same rows out, and more. */
export const NOT_CHAT_LIST_THREAD_TYPES: readonly string[] = [...RUN_LOG_THREAD_TYPES, "approval"]

/** May a thread of this type appear in the chat lists at all? An absent type is
 *  a plain thread (the column's default). */
export function isChatListThreadType(type: string | null | undefined): boolean {
  return type == null || !NOT_CHAT_LIST_THREAD_TYPES.includes(type)
}
