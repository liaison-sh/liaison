// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  inboxes: [
    { id: "ibx1", name: "Support", archivedAt: null },
    { id: "ibx2", name: "Bug reports (API)", archivedAt: null },
    { id: "ibx3", name: "Archived", archivedAt: "2026-01-01T00:00:00.000Z" },
  ],
}))

vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  ticketInboxStore: {
    get inboxes() {
      return state.inboxes
    },
  },
}))

import { MoveTicketsToInboxForm } from "./MoveTicketsToInboxForm"

describe("MoveTicketsToInboxForm", () => {
  beforeEach(() => {
    state.inboxes = [
      { id: "ibx1", name: "Support", archivedAt: null },
      { id: "ibx2", name: "Bug reports (API)", archivedAt: null },
      { id: "ibx3", name: "Archived", archivedAt: "2026-01-01T00:00:00.000Z" },
    ]
  })

  it("lists only non-archived inboxes as move targets", () => {
    render(() => (
      <MoveTicketsToInboxForm ids={["t1", "t2"]} onSubmit={vi.fn()} onCancel={vi.fn()} />
    ))
    expect(screen.getByTestId("tickets-move-target-inbox-option-ibx1")).toBeTruthy()
    expect(screen.getByTestId("tickets-move-target-inbox-option-ibx2")).toBeTruthy()
    expect(screen.queryByTestId("tickets-move-target-inbox-option-ibx3")).toBeNull()
  })

  it("submit is disabled until an inbox is chosen", () => {
    render(() => (
      <MoveTicketsToInboxForm ids={["t1", "t2"]} onSubmit={vi.fn()} onCancel={vi.fn()} />
    ))
    const submit = screen.getByTestId("tickets-move-form-submit") as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId("tickets-move-target-inbox"), {
      target: { value: "ibx2" },
    })
    expect(submit.disabled).toBe(false)
  })

  it("submits toInboxId + the full selection as ticketIds", () => {
    const onSubmit = vi.fn()
    render(() => (
      <MoveTicketsToInboxForm ids={["t1", "t2", "t3"]} onSubmit={onSubmit} onCancel={vi.fn()} />
    ))
    fireEvent.change(screen.getByTestId("tickets-move-target-inbox"), {
      target: { value: "ibx2" },
    })
    fireEvent.click(screen.getByTestId("tickets-move-form-submit"))
    expect(onSubmit).toHaveBeenCalledWith({
      toInboxId: "ibx2",
      ticketIds: ["t1", "t2", "t3"],
    })
  })

  it("cancel invokes onCancel without submitting", () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()
    render(() => <MoveTicketsToInboxForm ids={["t1"]} onSubmit={onSubmit} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId("tickets-move-form-cancel"))
    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
