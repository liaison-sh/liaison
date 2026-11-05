// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Tickets, agent first: open a ticket, ask your agent (from the chat dock,
 * beside the ticket) to draft the reply from what it knows about the
 * customer, review and approve the draft, ask it for an internal note, then
 * where you can still do it yourself and the routine that can do it on every
 * new ticket. Where a connection fills the customer lookup, one more beat
 * shows the customer card.
 *
 * Nothing reaches the customer without the person's approval: the agent's
 * reply is a gated draft, and "Do it for me" presses Approve only on the
 * approve beat (the person chose it), only on the draft this run's agent made.
 *
 * The agent is asked in the person's conversation with it (`talksToAgent`),
 * opened in the dock beside the ticket. That conversation holds what earlier
 * turns read, so the note may ask first (it says what the agent read about the
 * customer to everyone who reads the ticket): the approve-note beat approves
 * exactly that request, and is passed when the note was written at once.
 */
import {
  approveCreatedSteps,
  askAgentInRunConversation,
  draftApprovedEvent,
  draftCreatedEvent,
} from "../agent-steps"
import { defineTour } from "../schema"

const k = (path: string) => `tours.tickets.basics.${path}`

const REPLY_TOOL = "tickets:reply"
const NOTE_TOOL = "tickets:addNote"

/**
 * A ticket in the phone list: the list renders cards there, not rows (walk
 * D31: "tickets-list-row-*" matched nothing at 390 and the ask stopped).
 */
const PHONE_TICKET_CARD = "tickets-card-*"

/**
 * Where a phone approves what the agent drafted: asked from the Chats tab,
 * the person is no longer on the ticket, so the draft is approved from the
 * approvals screen (the desktop keeps the ticket beside the dock).
 */
const PHONE_APPROVALS = "approvals-screen"

/** Before pressing submit on the phone note: the button must add a note (TicketComposer `data-action`). */
const NOTE_SUBMIT_GUARD = {
  require: { testid: "tickets-composer-submit", attr: "data-action", value: "add-note" },
} as const

export const ticketsBasicsTour = defineTour({
  id: "tickets.basics",
  app: "tickets",
  title: k("title"),
  summary: k("summary"),
  talksToAgent: true,
  beats: [
    {
      id: "inbox",
      kind: "show",
      title: k("inbox.title"),
      body: k("inbox.body"),
      anchor: "tickets-inbox",
      route: "/tickets",
    },
    {
      id: "open",
      kind: "show",
      title: k("open.title"),
      body: k("open.body"),
      anchor: "tickets-list",
      route: "/tickets",
    },
    {
      id: "customer-card",
      kind: "show",
      title: k("customerCard.title"),
      body: k("customerCard.body"),
      anchor: "customer-card",
      // Phone: the card opens from More (the details panel is desktop only).
      anchorPhone: "ticket-action-more",
      // Only where a connection fills the customer lookup: the installed
      // connector alone shows no card.
      optional: { whenFeature: "customer-card" },
    },
    {
      id: "ask-draft",
      kind: "do",
      title: k("askDraft.title"),
      body: k("askDraft.body"),
      anchor: "dock-chats",
      anchorPhone: "phone-tab-chats",
      // Its script starts from the tickets list: played from another screen, it goes there first.
      route: "/tickets",
      // The agent's reply is a gated draft: its approval request is the event.
      event: draftCreatedEvent(REPLY_TOOL),
      // From the list (the scenario playing on), open a ticket first: the
      // agent reads the ticket behind the dock. Phone has no dock beside the
      // ticket, so the person asks from Chats.
      autoplay: [
        { click: "tickets-list-row-*", unlessVisible: "tickets-composer" },
        { waitFor: "tickets-composer" },
        ...askAgentInRunConversation(k("askDraft.text")),
      ],
      // Phone: the ticket the script opened is the newest; the request names
      // it, since the agent no longer sees the screen the person left.
      autoplayPhone: [
        { click: PHONE_TICKET_CARD, unlessVisible: "ticket-action-bar" },
        { waitFor: "ticket-action-bar" },
        ...askAgentInRunConversation(k("askDraft.phoneText")),
      ],
    },
    {
      id: "review",
      kind: "do",
      title: k("review.title"),
      body: k("review.body"),
      // The draft's own card, wherever it is on screen: on the ticket the ask
      // opened, or under the agent's answer in the person's conversation with it.
      anchor: "approval-card[data-request-id={ask-draft}]",
      anchorPhone: PHONE_APPROVALS,
      routePhone: "/approvals",
      event: draftApprovedEvent(REPLY_TOOL),
      // The draft's card comes with the agent's message, which may still be writing.
      waitsOn: "agent",
      // Resumed elsewhere (a reload lands on Home, walk D69), the ticket the ask
      // opened is not on screen: the person's conversation with the agent,
      // opened beside the screen, holds the same card under its answer.
      autoplay: [{ openRunConversation: true }, ...approveCreatedSteps("ask-draft")],
      autoplayPhone: approveCreatedSteps("ask-draft"),
    },
    {
      id: "note",
      kind: "do",
      title: k("note.title"),
      body: k("note.body"),
      anchor: "dock-chats",
      anchorPhone: "ticket-action-bar",
      // Phone: the review was approved on the approvals screen, so the note
      // goes back to the tickets to open the one the run asked about.
      routePhone: "/tickets",
      // A note is its own event (tickets/note:create), never a customer-thread
      // message; the agent writes it for the person who asked.
      // It may park for approval instead (heldAs): the next beat approves it.
      event: {
        app: "tickets",
        entity: "note",
        action: "create",
        actor: "user-or-agent",
        heldAs: NOTE_TOOL,
      },
      autoplay: askAgentInRunConversation(k("note.text")),
      // Phone: no agent dock beside the ticket, so the note is written from
      // the composer sheet (only ever a note: the guard holds before submit).
      autoplayPhone: [
        { click: PHONE_TICKET_CARD, unlessVisible: "ticket-action-bar" },
        { waitFor: "ticket-action-bar" },
        { click: "ticket-action-note" },
        { waitFor: "ticket-composer-sheet" },
        { type: { testid: "tickets-composer-body", text: k("note.phoneText") } },
        NOTE_SUBMIT_GUARD,
        { click: "tickets-composer-submit" },
        { waitEvent: true },
      ],
    },
    {
      id: "approve-note",
      kind: "do",
      title: k("approveNote.title"),
      body: k("approveNote.body"),
      anchor: "approval-card[data-request-id={note}]",
      // Only when the note asked first; a note written at once skips it.
      whenHeld: "note",
      event: { ...draftApprovedEvent(NOTE_TOOL), sameEntityAs: "note" },
      waitsOn: "agent",
      autoplay: [{ openRunConversation: true }, ...approveCreatedSteps("note")],
    },
    {
      id: "yourself",
      kind: "show",
      title: k("yourself.title"),
      body: k("yourself.body"),
      anchor: "tickets-composer",
      anchorPhone: "ticket-action-bar",
    },
    {
      id: "routine",
      kind: "show",
      title: k("routine.title"),
      body: k("routine.body"),
      anchor: "agent-page-panel-routines",
      route: "/agents/self/routines",
    },
  ],
})
