// SPDX-License-Identifier: FSL-1.1-ALv2
// Whether the New ticket dialog is open. Shared because the two buttons that open
// it live in different panes: the app sidebar and the list header. TicketsInbox
// renders the dialog, so the sidebar opens the list tab as well.
import { createSignal } from "solid-js"

export const [newTicketDialogOpen, setNewTicketDialogOpen] = createSignal(false)
