// SPDX-License-Identifier: FSL-1.1-ALv2
//
// G1. The ticket detail's phone-tier nav bar: back to the list, the ticket's
// own handle, and the trigger for the "⋯" actions sheet. It used to be
// rendered a SECOND time inside TicketDetail's own body while MainPanel's
// phone top bar ALSO rendered its generic bar above it — a manifest tab type
// (tickets is one) has no way to declare a `phoneHeader` on its own
// registration, so nothing stopped the plain bar from showing too. Registered
// at runtime instead (`registerAppPhoneHeader`, called from
// `registerAppHooks()` in exports.ts), so MainPanel renders THIS in place of
// its generic bar and TicketDetail renders no bar of its own.
//
// The sheet's CONTENTS stay in TicketDetail (they need the ticket's loaded
// data and mutation calls that already live there); this component only
// flips the shared open flag in `ticket-phone-header-store`.

import { PanelRightOpen } from "lucide-solid"
import { type Component, createMemo, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"
import { ticketDetailStore } from "~/modules/tickets/ticket-detail-store"
import { openTicketMoreSheet } from "~/modules/tickets/ticket-phone-header-store"
import { openThreadMap, threadMapAvailable } from "~/ui/thread-map-store"

interface TicketPhoneHeaderProps {
  entityId: string
}

const TicketPhoneHeader: Component<TicketPhoneHeaderProps> = (props) => {
  const i18n = useI18n()
  const ticket = createMemo(() => ticketDetailStore.byId[props.entityId])

  function backToList(): void {
    openTab({ type: "tickets:inbox", entityId: "inbox", label: i18n.t("tickets.tickets2") })
  }

  return (
    <div class="flex min-w-0 flex-1 items-center gap-1" data-testid="ticket-phone-header">
      <button
        type="button"
        data-testid="ticket-phone-back"
        aria-label={i18n.t("kernel.back")}
        class="flex min-h-11 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-2 text-[15px] text-text-secondary hover:bg-surface-hover"
        onClick={() => backToList()}
      >
        <svg viewBox="0 0 20 20" class="h-5 w-5 fill-current" aria-hidden="true">
          <path d="M12.6 4.4a1 1 0 0 1 0 1.4L8.4 10l4.2 4.2a1 1 0 0 1-1.4 1.4l-4.9-4.9a1 1 0 0 1 0-1.4l4.9-4.9a1 1 0 0 1 1.4 0z" />
        </svg>
        {i18n.t("kernel.ticketBackToList")}
      </button>
      <span
        class="min-w-0 flex-1 truncate text-center font-mono text-[14px] font-semibold text-text"
        data-testid="ticket-phone-handle"
      >
        #{ticket()?.handle ?? ""}
      </span>
      {/* The thread drawer (ThreadMapDrawer, rendered by the conversation
          stream), offered once the ticket has enough messages to need a map. */}
      <Show when={threadMapAvailable(`tickets:${props.entityId}`)}>
        <button
          type="button"
          data-testid="ticket-phone-thread-map"
          aria-label={i18n.t("kernel.threadMap.open")}
          class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
          onClick={() => openThreadMap(`tickets:${props.entityId}`)}
        >
          <PanelRightOpen size={18} />
        </button>
      </Show>
      <button
        type="button"
        data-testid="ticket-phone-more"
        aria-label={i18n.t("tickets.ticketActions")}
        class="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
        onClick={() => openTicketMoreSheet(props.entityId)}
      >
        <svg viewBox="0 0 16 16" class="h-4 w-4 fill-current" aria-hidden="true">
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
    </div>
  )
}

export default TicketPhoneHeader
