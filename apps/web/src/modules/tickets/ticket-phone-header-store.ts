// SPDX-License-Identifier: FSL-1.1-ALv2
//
// G1. `TicketPhoneHeader` (the phone top bar's registered header for the
// ticket detail tab) and `TicketDetail` (the tab body) are two SEPARATE
// components — the header is rendered by MainPanel's phone top bar through
// the registry, the body inside the tab content area — but the "⋯" actions
// sheet the header's button opens carries content (assign, category,
// priority, nudge, convert-to-mail, close) that needs the ticket's already-
// loaded data and mutation calls, which live in TicketDetail. This tiny
// signal is the shared switch between them: the header flips it open, the
// body renders the sheet from it.
import { createSignal } from "solid-js"

const [openForTicketId, setOpenForTicketId] = createSignal<string | null>(null)

export function openTicketMoreSheet(ticketId: string): void {
  setOpenForTicketId(ticketId)
}

export function closeTicketMoreSheet(): void {
  setOpenForTicketId(null)
}

export function isTicketMoreSheetOpen(ticketId: string): boolean {
  return openForTicketId() === ticketId
}
