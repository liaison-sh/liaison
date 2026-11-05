// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A per-turn reminder for conversations that already changed the person's
 * notification settings.
 *
 * Measured failure (2026-09-29, gemini-flash-lite, web DM): after one or two
 * turns that called `notifications_set`, the next request ("don't send anything
 * to my computer for new email", "hourly digest instead of daily") got a reply
 * saying it was done, with no tool call in the turn (stepCount 1) and nothing
 * stored. The earlier turns' calls and confirmations in the history read as a
 * pattern to imitate, not as work still to do.
 *
 * The trigger is structural, not a reading of the text: the replayed history
 * holds a notification tool call. That is the exact condition of the failure,
 * it is language independent, and it costs nothing in every other thread.
 */

const NOTIFICATION_TOOL =
  /(?:^|[_:])(notifications_get|notifications_set|notification_rules_set|thread_mute_set)$/

type Msg = { role: string; content: unknown }

/** True when an assistant message in `messages` called a notification settings tool. */
export function historyUsedNotificationTools(messages: readonly Msg[]): boolean {
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue
    for (const part of m.content as Array<{ type?: string; toolName?: unknown }>) {
      if (part?.type === "tool-call" && typeof part.toolName === "string") {
        if (NOTIFICATION_TOOL.test(part.toolName)) return true
      }
    }
  }
  return false
}

export const NOTIFICATION_CHANGE_NOTE =
  '<runtime-context note="injected by the Liaison platform, not written by the user">\n' +
  "Earlier turns of this conversation changed notification settings. Those calls are done and cover only what they changed. " +
  "If the latest message asks for any notification change (a channel, quiet hours, the digest, muting a conversation), call the tool for it in THIS turn " +
  "(notifications_set, thread_mute_set or notification_rules_set), even if you think it is already set: the tool says so. " +
  "Confirm only what the tool result says (its `now` field). Without a tool result in this turn, nothing changed: never say it did.\n" +
  "</runtime-context>"
