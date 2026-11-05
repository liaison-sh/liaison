// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A LOCAL TURN THAT FAILED BECAUSE CLAUDE ON THIS COMPUTER IS NOT SIGNED IN.
//
// The turn runs on the Claude Code CLI's own login. With none, or a dead one,
// the SDK answers the turn with an assistant message carrying
// `error: "authentication_failed"` and the CLI's sentence as its text ("Not
// logged in · Please run /login", "Failed to authenticate: OAuth session
// expired and could not be refreshed"), then an error result. That text used
// to be posted to the conversation as the agent's reply, and "run /login"
// means nothing to somebody who has never opened a terminal. It is now a
// failed turn instead, with a way to sign in from the app.

import type { SidecarEvent } from "./sidecar-client"

/**
 * The CLI's own words for a missing, expired or refused sign-in (read out of
 * the pinned CLI, 2.1.270). Matched case blind, anywhere in the line.
 */
const CLAUDE_AUTH_ERROR =
  /failed to authenticate|oauth session expired|oauth token (?:has expired|revoked)|not logged in|invalid api key|please run \/login|authentication_failed/i

/** Whether a line of text is the CLI saying it has no usable sign-in. */
export function isClaudeAuthError(text: unknown): boolean {
  return typeof text === "string" && CLAUDE_AUTH_ERROR.test(text)
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? ((block as { text: string }).text as string)
        : "",
    )
    .filter((text) => text.length > 0)
    .join("\n")
}

/**
 * The sign-in failure one sidecar line reports, as the CLI worded it, or null.
 *
 * Only the SDK's own error channels count: the assistant message the SDK marks
 * `authentication_failed`, an ERROR result, and the sidecar's `error` line. An
 * agent that merely writes "not logged in" in its answer is an answer.
 */
export function claudeAuthFailureOf(event: SidecarEvent): string | null {
  if (event.type === "error") {
    return isClaudeAuthError(event.message) ? String(event.message) : null
  }
  if (event.type !== "message") return null
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload !== "object") return null
  if (payload.type === "assistant" && payload.error === "authentication_failed") {
    const message = payload.message as { content?: unknown } | undefined
    return textOf(message?.content).trim() || "authentication_failed"
  }
  if (payload.type === "result" && payload.is_error === true && isClaudeAuthError(payload.result)) {
    return String(payload.result)
  }
  return null
}
