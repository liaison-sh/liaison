// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  openTab: vi.fn(),
  onClose: vi.fn(),
  loadAccounts: vi.fn(),
  accounts: {
    a1: {
      id: "a1",
      ownerType: "user",
      ownerId: "u1",
      emailAddress: "me@test.com",
    },
    shared: {
      id: "shared",
      ownerType: "org",
      ownerId: null,
      emailAddress: "shared@test.com",
    },
  } as Record<string, any>,
}))

vi.mock("~/modules/auth/auth-store", () => ({ userFromToken: () => ({ userId: "u1" }) }))
vi.mock("~/modules/mail/mail-account-store", () => ({
  loadAccounts: state.loadAccounts,
  mailAccountStore: {
    get byId() {
      return state.accounts
    },
  },
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: state.openTab }))

import { TicketConvertToMailDialog } from "./TicketConvertToMailDialog"

describe("TicketConvertToMailDialog", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({ mailConversationId: "conv-1" })
    state.loadAccounts.mockResolvedValue(undefined)
    state.accounts = {
      a1: { id: "a1", ownerType: "user", ownerId: "u1", emailAddress: "me@test.com" },
      shared: { id: "shared", ownerType: "org", ownerId: null, emailAddress: "shared@test.com" },
    }
    state.openTab.mockReset()
    state.onClose.mockReset()
  })

  it("[SC11] submit invokes tickets:convertToMail and opens the mail tab", async () => {
    render(() => <TicketConvertToMailDialog ticketId="t1" onClose={state.onClose} />)
    await waitFor(() => expect(screen.getByTestId("tickets-convert-account")).toBeTruthy())
    fireEvent.change(screen.getByTestId("tickets-convert-account"), { target: { value: "a1" } })
    fireEvent.click(screen.getByTestId("tickets-convert-submit"))
    await waitFor(() => expect(state.openTab).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:convertToMail",
      params: { ticketId: "t1", accountId: "a1" },
    })
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mail:conversation", entityId: "conv-1" }),
    )
  })

  it("submit disabled until accountId provided", () => {
    state.accounts = {}
    render(() => <TicketConvertToMailDialog ticketId="t1" onClose={state.onClose} />)
    expect((screen.getByTestId("tickets-convert-submit") as HTMLButtonElement).disabled).toBe(true)
  })
})
