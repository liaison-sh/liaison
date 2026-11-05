// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Where the customer card sits. Both are contributions the api-connector
// manifest declares, so a deployment without the app carries no card:
//   ticket:detail:panel      the ticket details sidepanel (desktop and tablet;
//                            at phone width, a sheet under the ticket's More)
//   mail:conversation:banner under the mail conversation header, collapsible
// Each takes the external participant's email from data the viewer already
// loaded under their own access, and hands it to the card.
import { firstExternalInboundSender } from "@liaison/shared"
import type { Component } from "solid-js"
import { allAccounts } from "~/modules/mail/mail-account-store"
import { getMessages } from "~/modules/mail/mail-message-store"
import { ticketDetailStore } from "~/modules/tickets/ticket-detail-store"
import { CustomerCard } from "./CustomerCard"

/**
 * The person the ticket is with, as the server resolved it (`tickets:get`
 * participantEmail: requester, else linked contact, else first external
 * inbound sender), the same rule and loader as the agent's customer context.
 */
export const TicketCustomerCard: Component<{ ticketId: string }> = (props) => {
  const email = () => ticketDetailStore.byId[props.ticketId]?.participantEmail ?? null
  return <CustomerCard email={email()} variant="panel" />
}

/**
 * The person writing in: the first inbound sender that is not one of the org's
 * mailboxes, the same rule the agent's customer context applies server side.
 */
export const MailCustomerCard: Component<{ mailConversationId: string }> = (props) => {
  const email = () =>
    firstExternalInboundSender(
      getMessages(props.mailConversationId).map((m) => ({
        direction: m.direction,
        fromEmail: m.fromAddress?.email,
        sentAt: m.sentAt,
      })),
      allAccounts().map((a) => a.emailAddress),
    )
  return <CustomerCard email={email()} variant="header" />
}
