// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  onClose: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { TicketNudgeDialog } from "./TicketNudgeDialog"

describe("TicketNudgeDialog", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({})
    state.onClose.mockReset()
  })

  it("submit calls tickets:nudge with the body and closes", async () => {
    render(() => <TicketNudgeDialog ticketId="t1" onClose={state.onClose} />)
    fireEvent.input(screen.getByTestId("tickets-nudge-body"), {
      target: { value: "Just checking in" },
    })
    fireEvent.click(screen.getByTestId("tickets-nudge-submit"))
    await waitFor(() => expect(state.onClose).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "tickets:nudge",
      params: { ticketId: "t1", textBody: "Just checking in" },
    })
  })

  it("renders pending banner when tool returns blocked", async () => {
    state.api.post = vi.fn().mockResolvedValue({ blocked: { reason: "gated" } })
    render(() => <TicketNudgeDialog ticketId="t1" onClose={state.onClose} />)
    fireEvent.click(screen.getByTestId("tickets-nudge-submit"))
    await waitFor(() => expect(screen.getByTestId("tickets-nudge-pending")).toBeTruthy())
  })

  it("prefills the follow-up in the reader's language", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <TicketNudgeDialog ticketId="t1" onClose={state.onClose} />
      </I18nProvider>
    ))
    expect((screen.getByTestId("tickets-nudge-body") as HTMLTextAreaElement).value).toBe(
      "Bonjour, je reviens vers vous à ce sujet. Pourriez-vous me dire comment procéder ?",
    )
  })
})
