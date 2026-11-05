// SPDX-License-Identifier: FSL-1.1-ALv2
import { serializeMention } from "~/lib/mention-format"
import { agentMentionHandle, type MentionResult } from "~/lib/mention-service"
import { matchMention } from "~/modules/shell/markdown-content"

/**
 * The chip a picked result puts in the field (the editor's `mention`): its
 * label and its wire ref. An approval is titled by its handle (`request-N`),
 * its uuid only the second line; an agent row is titled by its display name,
 * so its handle is what belongs in the message.
 */
export function mentionChipFor(item: MentionResult): { label: string; ref: string } | null {
  const wire =
    item.type === "approval_request"
      ? `@[${item.label}](kernel:approval_request:${item.id})`
      : serializeMention({
          type: item.type as "user" | "thread" | "entity" | "agent",
          id: item.id,
          label: item.type === "agent" ? agentMentionHandle(item) : item.label,
          app: item.app,
          entityType: item.entityType,
        })
  const chip = matchMention(wire)
  return chip ? { label: chip.label, ref: chip.ref } : null
}
