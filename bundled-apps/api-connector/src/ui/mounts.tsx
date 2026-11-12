// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the customer card sits. Both are contributions this app's manifest
// declares, so a deployment without the app carries no card:
//   ticket:detail:panel      the ticket details sidepanel, props `{ ticketId }`
//   mail:conversation:banner under the mail conversation header, collapsible,
//                            props `{ mailConversationId }`
// The person is read by the server under the viewer's own access: a ticket's
// participant (requester, else linked contact, else first external inbound
// sender), or a conversation's first inbound sender that is not one of the
// org's mailboxes, the same rule as the agent's customer context.
import type { Component } from "solid-js"
import { CustomerCard } from "./CustomerCard"

export const TicketCustomerCard: Component<{ ticketId: string }> = (props) => (
  <CustomerCard subject={{ ticketId: props.ticketId }} variant="panel" />
)

export const MailCustomerCard: Component<{ mailConversationId: string }> = (props) => (
  <CustomerCard subject={{ mailConversationId: props.mailConversationId }} variant="header" />
)
