// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card a tool call draws under its row, through the real ToolCallRow and
// the real card, with only the HTTP client faked: the client's paths are the
// ones asserted (a double /api prefix once drew no card at all).
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

import type { ToolCallState } from "~/modules/threads/message-store"
import ToolCallRow from "./ToolCallRow"

beforeEach(() => {
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  apiMocks.get.mockImplementation(async (path: string) => {
    throw new Error(`404 ${path}`)
  })
})
afterEach(() => vi.restoreAllMocks())

function call(toolName: string, result: unknown): ToolCallState {
  return { toolCallId: "t1", toolName, args: {}, result, status: "completed" } as ToolCallState
}

describe("cards drawn under a tool call", () => {
  it("an app tool that answered a page handle: an Open button that opens the page through the person's session", async () => {
    const handle = `lpg_${"b".repeat(43)}`
    apiMocks.post.mockResolvedValue({ url: "https://liaison.example/api/app-pages/t" })
    const popup = { opener: {}, location: { href: "" }, close: vi.fn() }
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
    render(() => (
      <ToolCallRow
        toolCall={call("google-drive__drive_picker", {
          accounts: [],
          page: { handle, app: "google-drive", page: "picker", expiresInSeconds: 300 },
        })}
      />
    ))
    fireEvent.click(await screen.findByTestId("page-handle-open"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/apps/google-drive/pages/open", { handle }),
    )
    await waitFor(() => expect(popup.location.href).toBe("https://liaison.example/api/app-pages/t"))
  })

  it("a tool answer without a page handle: no Open button", async () => {
    render(() => (
      <ToolCallRow toolCall={call("google-drive__drive_picker", { accounts: [], message: "full" })} />
    ))
    await Promise.resolve()
    expect(screen.queryByTestId("page-handle-card")).toBeNull()
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
