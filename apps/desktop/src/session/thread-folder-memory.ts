// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FOLDER EACH CONVERSATION RUNS IN, ACROSS RELAUNCHES.
//
// The folder a local session runs in was held in the window's memory only, so
// quitting the app forgot it: the header still said "This machine" and the
// next send opened the picker again for a conversation that already had one.
//
// This is a MEMORY, not an authority. What it holds is a path, and a path from
// this origin's storage is a path the page could have written, so it is only
// ever given back when it is still one of the agent's own recent folders (the
// shell's owner-only list, which is the set `start_session` accepts anyway).
// Reading and writing never throw: a window that refuses storage loses the
// memory, never the send.

const PREFIX = "liaison:desktop:thread-folder:"

export function rememberThreadFolder(threadId: string | null | undefined, folder: string): void {
  if (!threadId || !folder) return
  try {
    globalThis.localStorage?.setItem(PREFIX + threadId, folder)
  } catch {
    // Storage refused: the next window asks for the folder again.
  }
}

export function recallThreadFolder(threadId: string | null | undefined): string | null {
  if (!threadId) return null
  try {
    const stored = globalThis.localStorage?.getItem(PREFIX + threadId)
    return typeof stored === "string" && stored.length > 0 ? stored : null
  } catch {
    return null
  }
}
