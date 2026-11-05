// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The names a tour step's copy carries: `{{agent}}` is the person's own
 * agent as the app shows it (the chats list, the mention picker), never a
 * name written into the copy.
 */
import { userFromToken } from "~/modules/auth/auth-store"
import { tNow } from "~/modules/i18n/i18n-context"
import { personalAgentFor } from "~/modules/threads/agent-directory"
import { localizeAgentName } from "~/modules/threads/agent-name"

export function tourCopyVars(): Record<string, string> {
  const own = personalAgentFor(userFromToken()?.userId)
  return { agent: own?.name ? localizeAgentName(own.name) : tNow("tours.engine.yourAgent") }
}
