// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  loadTickets: vi.fn(),
  openTab: vi.fn(),
  onClose: vi.fn(),
  loadInboxes: vi.fn(),
  loadCategories: vi.fn(),
  inboxes: [
    {
      id: "in1",
      connectedAccountId: "ca1",
      name: "Support",
      emailAddress: "support@test.local",
      defaultTeam: null,
      defaultSensitivity: "internal",
      fromDisplayName: null,
      isDefaultForCreate: true,
      archivedAt: null,
    },
  ],
  categories: [{ id: "cat1", parentId: null, name: "Billing", sortOrder: 0, archivedAt: null }],
  user: {
    userId: "u1",
    orgId: "o1",
    name: "User One",
    roles: [],
    scopes: ["tickets:tickets:write"],
    dimensionGrants: { "tickets:team": ["support"], "tickets:sensitivity": ["restricted"] },
    exp: Math.floor(Date.now() / 1000) + 3600,
  },
}))

vi.mock("~/modules/auth/auth-store", () => ({ userFromToken: () => state.user }))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: state.openTab }))
vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  loadInboxes: state.loadInboxes,
  ticketInboxStore: {
    get inboxes() {
      return state.inboxes
    },
  },
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: state.loadCategories,
  ticketCategoryStore: {
    get categories() {
      return state.categories
    },
  },
}))
vi.mock("~/modules/tickets/ticket-list-store", () => ({
  loadTickets: state.loadTickets,
}))

import { NewTicketDialog } from "./NewTicketDialog"

describe("NewTicketDialog", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({ ticketId: "t-new", ticketHandle: "ticket-99" })
    state.loadTickets.mockReset()
    state.openTab.mockReset()
    state.onClose.mockReset()
    state.loadInboxes.mockResolvedValue(undefined)
    state.loadCategories.mockResolvedValue(undefined)
    state.inboxes = [
      {
        id: "in1",
        connectedAccountId: "ca1",
        name: "Support",
        emailAddress: "support@test.local",
        defaultTeam: null,
        defaultSensitivity: "internal",
        fromDisplayName: null,
        isDefaultForCreate: true,
        archivedAt: null,
      },
    ]
    state.categories = [
      { id: "cat1", parentId: null, name: "Billing", sortOrder: 0, archivedAt: null },
    ]
  })

  it("renders the modal with subject and priority inputs", () => {
    render(() => <NewTicketDialog onClose={state.onClose} />)
    expect(screen.getByTestId("tickets-new-dialog")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-subject")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-contact-email")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-contact-id")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-inbox")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-priority")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-category")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-assignee")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-team")).toBeTruthy()
    expect(screen.getByTestId("tickets-new-sensitivity")).toBeTruthy()
    // Submit disabled when subject empty.
    expect((screen.getByTestId("tickets-new-submit") as HTMLButtonElement).disabled).toBe(true)
  })

  it("[SC4] submit calls tickets:create then opens the new ticket tab and closes", async () => {
    render(() => <NewTicketDialog onClose={state.onClose} />)
    fireEvent.input(screen.getByTestId("tickets-new-subject"), { target: { value: "Hello" } })
    fireEvent.input(screen.getByTestId("tickets-new-contact-email"), {
      target: { value: "a@test.com" },
    })
    fireEvent.input(screen.getByTestId("tickets-new-contact-name"), { target: { value: "Alice" } })
    fireEvent.change(screen.getByTestId("tickets-new-inbox"), { target: { value: "in1" } })
    fireEvent.change(screen.getByTestId("tickets-new-category"), { target: { value: "cat1" } })
    fireEvent.change(screen.getByTestId("tickets-new-assignee"), { target: { value: "u1" } })
    fireEvent.input(screen.getByTestId("tickets-new-team"), { target: { value: "support" } })
    fireEvent.change(screen.getByTestId("tickets-new-sensitivity"), {
      target: { value: "restricted" },
    })
    fireEvent.input(screen.getByTestId("tickets-new-body"), { target: { value: "Initial note" } })
    fireEvent.click(screen.getByTestId("tickets-new-submit"))
    await waitFor(() => expect(state.onClose).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][0]).toBe("/apps/run-tool")
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:create",
      params: {
        subject: "Hello",
        contactEmail: "a@test.com",
        contactName: "Alice",
        sourceInboxId: "in1",
        categoryId: "cat1",
        assignedTo: "u1",
        team: "support",
        sensitivity: "restricted",
      },
    })
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "t-new" }),
    )
  })

  it("allows an existing contact id instead of contact email", async () => {
    render(() => <NewTicketDialog onClose={state.onClose} />)
    fireEvent.input(screen.getByTestId("tickets-new-subject"), { target: { value: "Hello" } })
    fireEvent.input(screen.getByTestId("tickets-new-contact-id"), {
      target: { value: "00000000-0000-4000-8000-000000000001" },
    })
    fireEvent.change(screen.getByTestId("tickets-new-inbox"), { target: { value: "in1" } })
    fireEvent.click(screen.getByTestId("tickets-new-submit"))
    await waitFor(() => expect(state.onClose).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      params: { contactId: "00000000-0000-4000-8000-000000000001", contactEmail: undefined },
    })
  })

  it("surfaces error when create fails", async () => {
    state.api.post = vi.fn().mockRejectedValue(new Error("boom"))
    render(() => <NewTicketDialog onClose={state.onClose} />)
    fireEvent.input(screen.getByTestId("tickets-new-subject"), { target: { value: "X" } })
    fireEvent.input(screen.getByTestId("tickets-new-contact-email"), {
      target: { value: "a@test.com" },
    })
    fireEvent.change(screen.getByTestId("tickets-new-inbox"), { target: { value: "in1" } })
    fireEvent.click(screen.getByTestId("tickets-new-submit"))
    await waitFor(() => expect(screen.getByTestId("tickets-new-error")).toBeTruthy())
    expect(screen.getByTestId("tickets-new-error").textContent).toContain("boom")
  })

  it("cancel calls onClose", () => {
    render(() => <NewTicketDialog onClose={state.onClose} />)
    fireEvent.click(screen.getByTestId("tickets-new-cancel"))
    expect(state.onClose).toHaveBeenCalled()
  })

  it("says what to do when the workspace has no inbox, and opens the inbox settings", async () => {
    state.inboxes = []
    render(() => <NewTicketDialog onClose={state.onClose} />)
    fireEvent.click(await screen.findByTestId("tickets-new-no-inbox-settings"))
    expect(state.onClose).toHaveBeenCalled()
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ routePath: "/settings/apps/tickets" }),
    )
  })

  it("shows no inbox hint when an inbox exists", async () => {
    render(() => <NewTicketDialog onClose={state.onClose} />)
    await waitFor(() =>
      expect((screen.getByTestId("tickets-new-inbox") as HTMLSelectElement).value).toBe("in1"),
    )
    expect(screen.queryByTestId("tickets-new-no-inbox")).toBeNull()
  })
})
