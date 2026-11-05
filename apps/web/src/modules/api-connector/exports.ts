// SPDX-License-Identifier: FSL-1.1-ALv2
// Every component the api-connector manifest declares (its `contributions`
// and its settings custom block) must be exported here: a missing export
// aborts the whole manifest-app registration.
import { lazy } from "solid-js"

/** Contribution `ticket:detail:panel`, props `{ ticketId }`. */
export const TicketCustomerCard = lazy(() =>
  import("./CustomerCardMounts").then((m) => ({ default: m.TicketCustomerCard })),
)
/** Contribution `mail:conversation:banner`, props `{ mailConversationId }`. */
export const MailCustomerCard = lazy(() =>
  import("./CustomerCardMounts").then((m) => ({ default: m.MailCustomerCard })),
)
/** Settings custom block of the connector card (the adapter editor and test panel). */
export const ApiConnectorAdapters = lazy(() => import("./ApiConnectorAdapters"))
