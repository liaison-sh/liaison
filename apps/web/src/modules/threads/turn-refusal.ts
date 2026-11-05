// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A TURN REFUSED BEFORE IT RAN, SAID ONCE. The server writes the refusal (no
// model for Auto, no usage left, a demo's spend gate: "Confirm your email to
// run the agents") into the conversation as a system row stamped with the
// asker's id and `metadata.turnRefusal`, and the failed turn's stream error
// carries the same words. The row is the one that stays, so it is drawn as a
// system line (MessageRow), and the live Failed block and state line stay
// quiet while the conversation already says it.
import { getMessages, type Message } from "~/modules/threads/message-store"

/** A system row that records a refused turn. */
export function isTurnRefusalLine(m: Pick<Message, "authorType" | "metadata">): boolean {
  if (m.authorType !== "system") return false
  return m.metadata?.turnRefusal === true || typeof m.metadata?.demoRefusal === "string"
}

/** Whether the conversation already shows this refusal as its system line. */
export function refusalShownInThread(threadId: string, errorMessage: string | undefined): boolean {
  const said = errorMessage?.trim()
  if (!said) return false
  return getMessages(threadId).some(
    (m) => isTurnRefusalLine(m) && (m.content ?? "").trim() === said,
  )
}

/**
 * The refusal code of the line that says this error in the conversation
 * (`metadata.demoRefusal`), or null when the conversation does not say it.
 */
export function refusalCodeInThread(
  threadId: string,
  errorMessage: string | undefined,
): string | null {
  const said = errorMessage?.trim()
  if (!said) return null
  const line = getMessages(threadId).find(
    (m) => isTurnRefusalLine(m) && (m.content ?? "").trim() === said,
  )
  const code = line?.metadata?.demoRefusal
  return typeof code === "string" ? code : null
}

/**
 * A live turn that has nothing to show of its own: refused before it ran, with
 * no text or tool, while the conversation already says why. Its block (the
 * agent's name over an empty body) is not drawn beside the refusal line.
 */
export function refusedTurnIsEmpty(
  threadId: string,
  stream: {
    state: string
    content?: string | null
    toolCalls?: readonly unknown[]
    reasoning?: string | null
    error?: { message?: string } | null
  },
): boolean {
  if (stream.state !== "error") return false
  if (stream.content || (stream.toolCalls?.length ?? 0) > 0 || stream.reasoning) return false
  return refusalShownInThread(threadId, stream.error?.message)
}
