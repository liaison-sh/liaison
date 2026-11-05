// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S1/S12 AT RUNTIME: each composer surface, rendered, shows the wand and the
// mic when the org can transcribe. Surfaces whose own suites already need
// heavy store mocks carry the same assertion there (TaskDetail, ComposeBar
// phone sheet, TicketComposer); every surface is covered statically by
// composer-surface-guard.test.ts.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { NewTaskDialog } from "~/modules/projects/NewTaskDialog"
import { ApiContext } from "~/modules/shell/ApiContext"
import { MessageEditField } from "~/modules/threads/MessageEditField"
import { MailConvertToTicketDialog } from "~/modules/tickets/MailConvertToTicketDialog"
import { NewTicketDialog } from "~/modules/tickets/NewTicketDialog"
import { TicketCloseDialog } from "~/modules/tickets/TicketCloseDialog"
import { TicketConvertToMailDialog } from "~/modules/tickets/TicketConvertToMailDialog"
import { TicketNudgeDialog } from "~/modules/tickets/TicketNudgeDialog"
import { installAudioContext, installMic, removeMic } from "./dictation-fakes"

function api(): ApiClient {
  const client: Partial<ApiClient> = {
    get: vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === "/assist/capabilities" ? { dictation: true, autoClean: true } : [],
      ),
    post: vi.fn().mockResolvedValue({}),
  }
  return client as ApiClient
}

const SURFACES: Array<[string, (client: ApiClient) => JSX.Element]> = [
  ["ticket close message", () => <TicketCloseDialog ticketId="t1" onClose={() => {}} />],
  ["ticket nudge message", () => <TicketNudgeDialog ticketId="t1" onClose={() => {}} />],
  ["new ticket body", () => <NewTicketDialog onClose={() => {}} />],
  [
    "ticket to mail conversion note",
    () => <TicketConvertToMailDialog ticketId="t1" onClose={() => {}} />,
  ],
  [
    "mail to ticket conversion note",
    () => <MailConvertToTicketDialog mailConversationId="m1" onClose={() => {}} />,
  ],
  [
    "message edit",
    () => <MessageEditField content="Bonjour" onSave={() => {}} onCancel={() => {}} />,
  ],
  [
    "new task description",
    (client) => (
      <NewTaskDialog open onOpenChange={() => {}} api={client} projectId="p1" statuses={[]} />
    ),
  ],
]

beforeEach(() => {
  installMic()
  installAudioContext()
})
afterEach(() => {
  cleanup()
  removeMic()
})

describe("every composer surface shows the wand and the mic", () => {
  it.each(SURFACES)("%s", async (_name, surface) => {
    const client = api()
    render(() => <ApiContext.Provider value={client}>{surface(client)}</ApiContext.Provider>)
    await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
    expect(screen.getByTestId("magic-wand")).toBeInTheDocument()
  })
})

/**
 * DIALOGS: the primary action sits in a footer. The mic sits immediately left
 * of it, and a take turns that footer row into the recorder line (stop and
 * insert where the primary action was); the wand stays with the field.
 */
const FOOTERS: Array<[string, (client: ApiClient) => JSX.Element, string]> = [
  ["new ticket", () => <NewTicketDialog onClose={() => {}} />, "tickets-new-submit"],
  [
    "ticket close",
    () => <TicketCloseDialog ticketId="t1" onClose={() => {}} />,
    "tickets-close-submit",
  ],
  [
    "ticket nudge",
    () => <TicketNudgeDialog ticketId="t1" onClose={() => {}} />,
    "tickets-nudge-submit",
  ],
  [
    "ticket to mail conversion",
    () => <TicketConvertToMailDialog ticketId="t1" onClose={() => {}} />,
    "tickets-convert-submit",
  ],
  [
    "mail to ticket conversion",
    () => <MailConvertToTicketDialog mailConversationId="m1" onClose={() => {}} />,
    "mail-convert-submit",
  ],
  [
    "new task",
    (client) => (
      <NewTaskDialog open onOpenChange={() => {}} api={client} projectId="p1" statuses={[]} />
    ),
    "new-task-dialog.submit",
  ],
]

/** What a keyboard reaches, in document order, outside hidden subtrees. */
function reachable(): Element[] {
  return Array.from(document.querySelectorAll("button, input, select, textarea, a[href]")).filter(
    (el) => !el.closest("[hidden]"),
  )
}

describe("dialogs: the mic left of the primary action, the footer turns into the recorder", () => {
  it.each(FOOTERS)("%s", async (_name, surface, primaryId) => {
    const client = api()
    render(() => <ApiContext.Provider value={client}>{surface(client)}</ApiContext.Provider>)
    await waitFor(() => expect(screen.getByTestId("voice-dictation-button")).toBeInTheDocument())
    const mic = screen.getByTestId("voice-dictation-button")
    const primary = screen.getByTestId(primaryId).closest("button") as HTMLElement
    const order = reachable()
    expect(order[order.indexOf(mic) + 1]).toBe(primary)
    const wand = screen.getByTestId("magic-wand")

    fireEvent.click(mic)
    await waitFor(() =>
      expect(screen.getByTestId("voice-dictation-recorder").getAttribute("data-state")).toBe(
        "recording",
      ),
    )
    const recorder = screen.getByTestId("voice-dictation-recorder")
    // The footer row is the recorder now: its actions are hidden, the line in their place.
    expect(primary.closest("[hidden]")).not.toBeNull()
    const footer = primary.closest("[data-recorder-row]")?.parentElement
    expect(footer?.contains(recorder)).toBe(true)
    // The wand stays with the field's tools, outside the recorder's row.
    expect(wand.closest("[hidden]")).toBeNull()
    expect(footer?.contains(wand)).toBe(false)
  })
})
