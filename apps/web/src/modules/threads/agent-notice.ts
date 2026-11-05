// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE AGENT'S FAILURE LINES, IN THE READER'S LANGUAGE.
 *
 * The runtime decides a failed turn's class once and persists it (`metadata.agentNotice`)
 * beside a fixed English line and the failure's own detail, made safe to show; the rule that
 * reads it is shared with the server (`@liaison/shared`, threads/agent-notice), which renders
 * the same classes in digests and push notifications. Every web surface that shows a message's
 * text goes through here: the conversation (with the detail: `withDetail`), and the one-line
 * summaries (the Chats list, the Home unread preview, the notification row), which show the
 * line alone.
 */
import { localizeAgentNotice as localizeShared } from "@liaison/shared"
import type { Translate } from "~/modules/i18n/i18n-context"

/** The failure line in the reader's language (with its detail when asked); any other content unchanged. */
export function localizeAgentNotice(
  content: string,
  t: Translate,
  metadata?: Record<string, unknown> | null,
  opts: { withDetail?: boolean } = {},
): string {
  return localizeShared(content, (key) => t(key), metadata, opts)
}
