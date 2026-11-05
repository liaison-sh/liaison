// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketCard — small entity preview surface used by hover cards / search
// results / mention pills. Lazy-loads the ticket via tickets:get if not in
// store, then renders a compact summary.

import type { Component } from "solid-js"
import { createMemo, createResource, onCleanup, Show } from "solid-js"
import { runTool } from "~/lib/run-tool"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { ticketDetailStore } from "~/modules/tickets/ticket-detail-store"
import type { Ticket } from "~/modules/tickets/ticket-types"

interface Props {
  entityId: string
}

export const TicketCard: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const cached = createMemo(() => ticketDetailStore.byId[props.entityId])
  let activeController: AbortController | null = null
  onCleanup(() => activeController?.abort())
  const [ticket] = createResource(
    () => props.entityId,
    async (id): Promise<Ticket | null> => {
      const hit = cached()
      if (hit) return hit
      activeController?.abort()
      const ac = new AbortController()
      activeController = ac
      try {
        const out = await runTool<{ ticket: Ticket | null }>(
          api,
          "tickets:get",
          { ticketId: id },
          { signal: ac.signal },
        )
        return out.ticket
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err
        return null
      }
    },
  )
  return (
    <div class="rounded border border-border bg-surface p-2 text-sm" data-testid="tickets-card">
      <Show
        when={ticket()}
        fallback={
          <div class="text-text-tertiary" data-testid="tickets-card-loading">
            {i18n.t("kernel.common.loading2")}
          </div>
        }
      >
        {(t) => (
          <>
            <div class="text-xs text-text-tertiary">{t().handle}</div>
            <div class="font-medium" data-testid="tickets-card-subject">
              {t().subject}
            </div>
            <div class="text-xs text-text-secondary">
              {t().status} · {t().priority}
            </div>
          </>
        )}
      </Show>
    </div>
  )
}
