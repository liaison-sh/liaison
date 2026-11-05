// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Real stores built inside the async factories, with the component's own
// solid-js/store instance, so seeds made after render still reach the UI.
const reactive = vi.hoisted(
  () =>
    ({}) as {
      tickets: { byId: Record<string, unknown> }
      setTickets: import("solid-js/store").SetStoreFunction<{ byId: Record<string, unknown> }>
      mail: { byConversation: Record<string, unknown[]> }
      setMail: import("solid-js/store").SetStoreFunction<{
        byConversation: Record<string, unknown[]>
      }>
      reconcile: typeof import("solid-js/store").reconcile
    },
)

vi.mock("~/modules/tickets/ticket-detail-store", async () => {
  const { createStore, reconcile } = await import("solid-js/store")
  const [store, setStore] = createStore<{ byId: Record<string, unknown> }>({ byId: {} })
  reactive.tickets = store
  reactive.setTickets = setStore
  reactive.reconcile = reconcile
  return { ticketDetailStore: store }
})
vi.mock("~/modules/mail/mail-message-store", async () => {
  const { createStore } = await import("solid-js/store")
  const [store, setStore] = createStore<{ byConversation: Record<string, unknown[]> }>({
    byConversation: {},
  })
  reactive.mail = store
  reactive.setMail = setStore
  return { getMessages: (id: string) => store.byConversation[id] ?? [] }
})
vi.mock("~/modules/mail/mail-account-store", () => ({
  allAccounts: () => [{ id: "a1", emailAddress: "Sales@us.example" }],
}))
vi.mock("./CustomerCard", () => ({
  CustomerCard: (props: { email: string | null | undefined; variant: string }) => (
    <div data-testid="card-probe" data-variant={props.variant}>
      {props.email ?? ""}
    </div>
  ),
}))

import { MailCustomerCard, TicketCustomerCard } from "./CustomerCardMounts"

describe("customer card mounts", () => {
  beforeEach(() => {
    reactive.setTickets("byId", reactive.reconcile({}))
    reactive.setMail("byConversation", reactive.reconcile({}))
  })

  it("keys the ticket card on the server's participant email (the agent's rule), as a sidepanel card", async () => {
    render(() => <TicketCustomerCard ticketId="t1" />)
    expect(screen.getByTestId("card-probe").textContent).toBe("")
    // requester_email set, a different contact linked: the requester wins, as for the agent.
    reactive.setTickets("byId", "t1", {
      id: "t1",
      participantEmail: "requester@acme.example",
      contact: { email: "linked.contact@acme.example" },
    })
    expect(screen.getByTestId("card-probe").textContent).toBe("requester@acme.example")
    expect(screen.getByTestId("card-probe").dataset.variant).toBe("panel")
  })

  it("has no ticket card email when the server resolved none, whatever contact is shown", () => {
    reactive.setTickets("byId", "t2", {
      id: "t2",
      participantEmail: null,
      contact: { email: "stale.contact@acme.example" },
    })
    render(() => <TicketCustomerCard ticketId="t2" />)
    expect(screen.getByTestId("card-probe").textContent).toBe("")
  })

  it("keys the mail card on the first inbound sender, never our own outbound address", () => {
    reactive.setMail("byConversation", "c1", [
      { id: "m0", direction: "outbound", fromAddress: { email: "support@us.example" } },
      { id: "m1", direction: "inbound", fromAddress: { email: "buyer@acme.example" } },
      { id: "m2", direction: "inbound", fromAddress: { email: "colleague@acme.example" } },
    ])
    render(() => <MailCustomerCard mailConversationId="c1" />)
    expect(screen.getByTestId("card-probe").textContent).toBe("buyer@acme.example")
    expect(screen.getByTestId("card-probe").dataset.variant).toBe("header")
  })

  it("skips an inbound copy from one of our own mailboxes and orders by sent time", () => {
    reactive.setMail("byConversation", "c3", [
      {
        id: "m2",
        direction: "inbound",
        fromAddress: { email: "later@acme.example" },
        sentAt: "2026-01-03T10:00:00Z",
      },
      {
        id: "m0",
        direction: "inbound",
        fromAddress: { email: "sales@us.example" },
        sentAt: "2026-01-01T10:00:00Z",
      },
      {
        id: "m1",
        direction: "inbound",
        fromAddress: { email: "buyer@acme.example" },
        sentAt: "2026-01-02T10:00:00Z",
      },
    ])
    render(() => <MailCustomerCard mailConversationId="c3" />)
    expect(screen.getByTestId("card-probe").textContent).toBe("buyer@acme.example")
  })

  it("gives the mail card no email when every message is ours", () => {
    reactive.setMail("byConversation", "c2", [
      { id: "m0", direction: "outbound", fromAddress: { email: "support@us.example" } },
    ])
    render(() => <MailCustomerCard mailConversationId="c2" />)
    expect(screen.getByTestId("card-probe").textContent).toBe("")
  })
})
