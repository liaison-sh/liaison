// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A PLATFORM-WRITTEN LINE IN A CONVERSATION, IN THE READER'S LANGUAGE.
 *
 * The server writes some thread lines itself, once, in English: an approval withdrawn by
 * its requester posts "Withdrawn by the requester. Reason: <their reason>." A French reader
 * saw that in the thread and in the Home unread preview (third QA walk). The line is rebuilt
 * from the row's metadata (`type: approval-decision`, `decision`, `reason`) when the surface
 * has it, else recognised by its fixed template; the requester's own reason is kept as they
 * wrote it. An agent's failure line goes through the agent-notice rule. Anything else is
 * shown as written.
 */
import { messagePlainText, relabelAgentMentions } from "@liaison/shared"
import type { Translate } from "~/modules/i18n/i18n-context"
import { currentAgentHandle } from "~/modules/threads/agent-directory"
import { localizeAgentNotice } from "~/modules/threads/agent-notice"

const WITHDRAWN = /^Withdrawn by the requester\.(?: Reason: ([\s\S]+)\.)?$/

export function localizeSystemLine(
  content: string,
  t: Translate,
  metadata?: Record<string, unknown> | null,
): string {
  if (metadata?.type === "approval-decision" && metadata.decision === "withdrawn") {
    const reason = typeof metadata.reason === "string" ? metadata.reason.trim() : ""
    return reason
      ? t("kernel.approvalDecisionLine.withdrawnReason", { reason })
      : t("kernel.approvalDecisionLine.withdrawn")
  }
  const withdrawn = WITHDRAWN.exec(content.trim())
  if (withdrawn) {
    return withdrawn[1]
      ? t("kernel.approvalDecisionLine.withdrawnReason", { reason: withdrawn[1] })
      : t("kernel.approvalDecisionLine.withdrawn")
  }
  return localizeAgentNotice(content, t, metadata)
}

/**
 * A message as the one plain line a list row shows (the chat list, the new
 * message picker): the localized line with its markup rendered as text, so a
 * mention reads `@Name`, never `@[Name](user:<id>)`, and an agent mention
 * reads as the agent's current handle.
 */
export function previewLine(
  content: string,
  t: Translate,
  metadata?: Record<string, unknown> | null,
): string {
  return messagePlainText(
    relabelAgentMentions(localizeSystemLine(content, t, metadata), currentAgentHandle),
  )
}
