// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card a kernel tool call draws under its row, through the real
// ToolCallRow and the real card, with only the HTTP client faked. Live walk
// 2026-10-30: the agent called kernel__drive_picker (result `card: "shown"`)
// and said "pick your CV on the card above", but no card rendered: the card
// fetched "/api/api/google-drive/picker" (a double /api prefix), got a 404 and
// drew nothing. The card tests faked the client and never saw the path.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

import type { ToolCallState } from "~/modules/threads/message-store"
import ToolCallRow from "./ToolCallRow"

const DRIVE_STATE = {
  pickerConfigured: true,
  accounts: [
    {
      id: "drive-1",
      identifier: "ana@gmail.com",
      ownerType: "user",
      mode: "picked",
      picked: [],
      sync: null,
    },
  ],
}

beforeEach(() => {
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  apiMocks.get.mockImplementation(async (path: string) => {
    if (path === "/google-drive/picker") return DRIVE_STATE
    throw new Error(`404 ${path}`)
  })
})
afterEach(() => vi.restoreAllMocks())

function call(toolName: string, result: unknown): ToolCallState {
  return { toolCallId: "t1", toolName, args: {}, result, status: "completed" } as ToolCallState
}

describe("cards drawn under a kernel tool call", () => {
  it("kernel__drive_picker with card shown: the picker card, with a Choose files button that opens the picker", async () => {
    apiMocks.post.mockResolvedValue({ url: "https://liaison.example/picker/x" })
    const open = vi.spyOn(window, "open").mockReturnValue({
      opener: null,
      location: { href: "" },
      close: vi.fn(),
    } as unknown as Window)
    render(() => (
      <ToolCallRow toolCall={call("kernel__drive_picker", { card: "shown", accounts: [] })} />
    ))
    await waitFor(() => expect(screen.getByTestId("drive-picker-card")).toBeTruthy())
    expect(apiMocks.get).toHaveBeenCalledWith("/google-drive/picker")
    fireEvent.click(screen.getByTestId("drive-picker-choose"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/google-drive/picker/ticket", {
        accountId: "drive-1",
      }),
    )
    expect(open).toHaveBeenCalled()
  })

  it("kernel__drive_picker with no card: nothing drawn", async () => {
    render(() => <ToolCallRow toolCall={call("kernel__drive_picker", { card: "none" })} />)
    await Promise.resolve()
    expect(screen.queryByTestId("drive-picker-card")).toBeNull()
  })

  it("kernel__report_bug awaiting confirmation: the reporter's Send card with the exact payload", async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === "/bug-reports/drafts/d-1") {
        return {
          draftId: "d-1",
          data: { report: { description: "Save spins" } },
          digest: "c".repeat(64),
          createdAt: "2026-11-03T10:00:00.000Z",
          sentMessageId: null,
        }
      }
      throw new Error(`404 ${path}`)
    })
    render(() => (
      <ToolCallRow
        toolCall={call("kernel__report_bug", {
          filed: false,
          teamOnly: true,
          awaitingConfirmation: true,
          draftId: "d-1",
          digest: "c".repeat(64),
        })}
      />
    ))
    expect(await screen.findByTestId("bug-report-draft-payload")).toHaveTextContent("Save spins")
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it("kernel__report_bug filed locally: no card", async () => {
    render(() => (
      <ToolCallRow toolCall={call("kernel__report_bug", { filed: true, ticketId: "t" })} />
    ))
    await Promise.resolve()
    expect(screen.queryByTestId("bug-report-draft-card")).toBeNull()
  })
})
