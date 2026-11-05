// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN ANSWER THAT DID NOT REACH THE CONVERSATION IS KEPT, NEVER DROPPED.
//
// A local turn's answer exists on this machine only until it is posted. The
// post can fail for good (the claim was taken over, the server refused it) or
// for longer than the retries last (the laptop went offline), and the turn
// itself cost minutes and real work in the user's folder: running it again is
// not the same as posting what it said. So the answer is kept here, keyed by
// the message it answers, until a post succeeds: the Retry on the failure line
// posts it, and a session started on the conversation later posts it on its own.
//
// localStorage, so a relaunch keeps it; the in-memory map is the fallback for a
// window that refuses storage. Bounded: an answer that is never posted must not
// grow the store for ever.

import type { LocalTurnRecord } from "@liaison/shared/threads/local-turn"

export interface UndeliveredReply {
  threadId: string
  agentId: string
  /** The human message this answers. */
  messageId: string
  text: string
  turn: LocalTurnRecord | null
  /** The reply thread the answer belongs in (A7); absent in the channel. */
  replyRootId?: string | null
  /** Epoch ms it was kept. */
  keptAt: number
}

const STORAGE_KEY = "liaison.desktop.undeliveredReplies.v1"
/** How many answers are kept at most; the oldest goes first. */
export const UNDELIVERED_CAP = 20

/**
 * What storage refused to hold (no storage, a full quota), and only that: a
 * write storage accepted clears it, so it never shadows what storage says.
 */
const memory = new Map<string, UndeliveredReply>()

function fromStorage(): Map<string, UndeliveredReply> {
  const out = new Map<string, UndeliveredReply>()
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as Record<string, UndeliveredReply>
    for (const [id, reply] of Object.entries(parsed ?? {})) {
      if (reply && typeof reply.text === "string" && typeof reply.threadId === "string") {
        out.set(id, reply)
      }
    }
  } catch {
    // Unreadable storage holds nothing we can use; the memory copy is what is left.
  }
  return out
}

function read(): Map<string, UndeliveredReply> {
  const all = fromStorage()
  for (const [id, reply] of memory) all.set(id, reply)
  return all
}

function write(all: Map<string, UndeliveredReply>): void {
  memory.clear()
  try {
    const storage = globalThis.localStorage
    if (!storage) throw new Error("no storage")
    storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(all)))
  } catch {
    // Storage would not take it: the window keeps it until it closes.
    for (const [id, reply] of all) memory.set(id, reply)
  }
}

export function keepUndeliveredReply(reply: UndeliveredReply): void {
  const all = read()
  all.delete(reply.messageId)
  all.set(reply.messageId, reply)
  const ordered = [...all.values()].sort((a, b) => a.keptAt - b.keptAt)
  while (ordered.length > UNDELIVERED_CAP) {
    const oldest = ordered.shift()
    if (oldest) all.delete(oldest.messageId)
  }
  write(all)
}

export function undeliveredReplyFor(messageId: string): UndeliveredReply | null {
  return read().get(messageId) ?? null
}

/** Every kept answer of one agent in one conversation, oldest first. */
export function undeliveredRepliesIn(threadId: string, agentId: string): UndeliveredReply[] {
  return [...read().values()]
    .filter((reply) => reply.threadId === threadId && reply.agentId === agentId)
    .sort((a, b) => a.keptAt - b.keptAt)
}

export function forgetUndeliveredReply(messageId: string): void {
  const all = read()
  if (!all.delete(messageId)) return
  write(all)
}
