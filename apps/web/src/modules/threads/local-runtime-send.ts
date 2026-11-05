// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A MESSAGE IN A CONVERSATION THAT RUNS ON THIS MACHINE IS NEVER THE SERVER'S.
//
// The runtime control records where a conversation's turns run, and a local
// session is what actually runs them: the session takes the claim that stops
// the server from answering (A32). The two used to be independent, so a
// conversation set to "This machine" with no session started posted its
// messages exactly as a Liaison one did, the server saw no claim, and its own
// agent answered on its own model, silently, under a header that still said
// "This machine".
//
// So the send path asks here first. When the runtime is local and the
// conversation is a DM with one agent (the only conversation the control is
// offered in), the message is posted only once a local session is running for
// it, and it is posted saying so (`localAgentId`), which the server honours by
// never starting that agent's turn for it, claim or no claim. When the session
// cannot be had, nothing is posted at all: the caller gets a
// `LocalRuntimeUnavailableError` and hands the draft back.

import { ensureLocalSessionFor, isLocalRuntime } from "~/modules/desktop/desktop-store"
import { tNow } from "~/modules/i18n/i18n-context"
import { dmAgentSeat } from "~/modules/threads/dm-agent-seat"
import { getThread } from "~/modules/threads/thread-store"

/** Raised instead of posting when the local session could not be had. */
export class LocalRuntimeUnavailableError extends Error {
  /** `NoFolderChosen`, or the shell's own start refusal code. */
  readonly reason: string
  constructor(reason: string) {
    super(`Local session unavailable: ${reason}`)
    this.name = "LocalRuntimeUnavailableError"
    this.reason = reason
  }
}

/**
 * The agent whose turn must run on this machine for a message sent in this
 * conversation, or null when the conversation's turns are the server's.
 */
export function localRuntimeAgentFor(threadId: string, currentUserId: string): string | null {
  if (!isLocalRuntime()) return null
  const thread = getThread(threadId)
  if (!thread) return null
  return (
    dmAgentSeat({
      threadId,
      title: thread.title,
      threadType: thread.type,
      currentUserId,
      participants: thread.participants,
    })?.id ?? null
  )
}

/**
 * Makes sure the local session is running for this conversation, or throws.
 * Never posts anything itself.
 */
export async function requireLocalSession(threadId: string, agentId: string): Promise<void> {
  const ready = await ensureLocalSessionFor(threadId, agentId)
  if (!ready.ok) throw new LocalRuntimeUnavailableError(ready.reason)
}

/** The folder picker was closed: the one thing missing is a folder. */
export const LOCAL_SEND_NO_FOLDER = "kernel.desktopUi.localSend.noFolder"
/** Any other refusal. The shell's own reason is already a toast of its own. */
export const LOCAL_SEND_NOT_SENT = "kernel.desktopUi.localSend.notSent"

/**
 * What the person is told when their message was held back. It always says
 * the message was NOT sent, because the field emptied on Send and the draft
 * reappearing is otherwise a mystery. Why the start refused is the notices'
 * sentence (desktop-notices.ts), raised from the shell's own `startError`; a
 * closed picker raises no `startError`, so it is named here.
 */
export function localSendRefusalCopy(reason: string): string {
  return tNow(reason === "NoFolderChosen" ? LOCAL_SEND_NO_FOLDER : LOCAL_SEND_NOT_SENT)
}
