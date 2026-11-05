// SPDX-License-Identifier: FSL-1.1-ALv2
import { handleConversationEvent } from "~/modules/mail/mail-conversation-store"
import { handleTicketEvent } from "~/modules/tickets/ticket-detail-store"
import { applyTicketSlaBreach } from "~/modules/tickets/ticket-list-store"

function dispatchBrowserEvent(name: string, detail?: unknown): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function handleConnectedAccountEvent(action: string, data: any): void {
  if ((action !== "create" && action !== "disconnect") || data?.appName !== "tickets") return
  dispatchBrowserEvent("tickets:inboxes-invalidated", { action, data })
}

export function handleMailConversationEvent(action: string, data: any): void {
  if (action !== "converted") return
  handleConversationEvent(action, data)

  const ticketId = data?.escalatedTicketId ?? data?.ticketId
  if (ticketId) {
    handleTicketEvent("update", {
      id: ticketId,
      changes: {
        status: data.escalatedTicketStatus ?? "open",
      },
    })
  }
}

export function handleSlaEvent(action: string, data: any): void {
  if (action !== "breach") return
  applyTicketSlaBreach(data)
  const ticketId = data?.ticketId ?? data?.id
  if (ticketId) {
    handleTicketEvent("update", {
      id: ticketId,
      changes: {
        slaBreachedAt: data.breachedAt ?? new Date().toISOString(),
        slaDeadline: data.slaDeadline,
      },
    })
  }
  dispatchBrowserEvent("tickets:attention-invalidated", { action, data })
}
