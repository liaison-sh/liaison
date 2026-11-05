// SPDX-License-Identifier: FSL-1.1-ALv2
// Entity previews — register hover/preview rendering for ticket
// references in search/mentions. Uses tickets:get tool through ApiClient.post.

import type { ApiClient } from "~/lib/api-client"
import { runTool } from "~/lib/run-tool"
import { useI18n } from "~/modules/i18n/i18n-context"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface TicketPreviewData {
  id?: string
  handle?: string
  subject?: string
  status?: string
  priority?: string
  unread?: boolean
}

export function registerEntityPreviews(): void {
  registerEntityPreview<TicketPreviewData>({
    app: "tickets",
    entityType: "ticket",
    fetch: async (id, api) => {
      const out = await runTool<{ ticket: TicketPreviewData | null }>(
        api as ApiClient,
        "tickets:get",
        { ticketId: id },
      )
      return out.ticket ?? { id }
    },
    render: (ticket) => {
      // Rendered inside the app tree, so the provider's translator is in reach.
      const i18n = useI18n()
      const label = (key: string, raw: string | undefined) => {
        const out = raw ? i18n.t(key) : ""
        return out === key ? (raw ?? "") : out
      }
      return (
        <div data-testid={`tickets-preview-${ticket.id ?? ""}`}>
          <div class="text-text-tertiary text-[11px]">{ticket.handle}</div>
          <div class="font-medium text-text">{ticket.subject ?? i18n.t("tickets.noSubject")}</div>
          <div class="text-text-secondary text-[12px]">
            {label(`tickets.status.${ticket.status}`, ticket.status)} ·{" "}
            {label(`tickets.${ticket.priority}`, ticket.priority)}
          </div>
        </div>
      )
    },
  })
}
