// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))
const shellMocks = vi.hoisted(() => ({ shellRunsOAuth: vi.fn(() => false) }))
vi.mock("~/modules/settings/oauth-connect", () => shellMocks)
const externalMocks = vi.hoisted(() => ({ openExternal: vi.fn(async () => true) }))
vi.mock("~/modules/desktop/external-links", () => externalMocks)

import {
  DrivePickerCard,
  type DrivePickerStateView,
  drivePickerCardShown,
  drivePickerOrigin,
  drivePickerThread,
} from "./DrivePickerCard"

const ACCOUNT = "11111111-1111-4111-8111-111111111111"

function state(over: Partial<DrivePickerStateView> = {}): DrivePickerStateView {
  return {
    pickerConfigured: true,
    accounts: [
      {
        id: ACCOUNT,
        identifier: "ana@gmail.com",
        ownerType: "user",
        mode: "picked",
        picked: [
          { id: "doc-aaaaaaaa", name: "Plan.docx", mimeType: "application/msword" },
          {
            id: "folder-bbbbbbbb",
            name: "Projects",
            mimeType: "application/vnd.google-apps.folder",
          },
        ],
        sync: { status: "ok", documents: 7, lastError: null },
      },
    ],
    ...over,
  }
}

beforeEach(() => {
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  shellMocks.shellRunsOAuth.mockReturnValue(false)
  externalMocks.openExternal.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe("DrivePickerCard", () => {
  it("lists what is picked with the count in Knowledge, and removes an item", async () => {
    apiMocks.get.mockResolvedValue(state())
    apiMocks.post.mockResolvedValue({ picked: [], sourceId: "s" })
    render(() => <DrivePickerCard />)
    await waitFor(() => expect(screen.getByTestId("drive-picker-card")).toBeTruthy())
    expect(screen.getByTestId("drive-picker-count").textContent).toContain("2 picked")
    expect(screen.getByTestId("drive-picker-sync").textContent).toContain("7 in Knowledge")
    expect(screen.getByRole("img", { name: "folder" })).toBeTruthy()
    fireEvent.click(screen.getByTestId("drive-picker-remove-doc-aaaaaaaa"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/google-drive/picker/items", {
        accountId: ACCOUNT,
        remove: ["doc-aaaaaaaa"],
      }),
    )
  })

  it("says it is syncing while the first sync has not finished", async () => {
    const s = state()
    s.accounts[0]!.sync = { status: "running", documents: 0, lastError: null }
    apiMocks.get.mockResolvedValue(s)
    render(() => <DrivePickerCard />)
    await waitFor(() =>
      expect(screen.getByTestId("drive-picker-sync").textContent).toContain("Syncing 2 files"),
    )
  })

  it("stops polling a sync that never finishes after the follow window", async () => {
    vi.useFakeTimers()
    try {
      const s = state()
      s.accounts[0]!.sync = null
      apiMocks.get.mockResolvedValue(s)
      render(() => <DrivePickerCard />)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(apiMocks.get.mock.calls.length).toBeGreaterThan(1)
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
      const settled = apiMocks.get.mock.calls.length
      await vi.advanceTimersByTimeAsync(60_000)
      expect(apiMocks.get.mock.calls.length).toBe(settled)
    } finally {
      vi.useRealTimers()
    }
  })

  it("Choose files opens the picker page in a popup opened in the click", async () => {
    apiMocks.get.mockResolvedValue(state())
    apiMocks.post.mockResolvedValue({ url: "https://liaison.example/api/drive-picker/abc" })
    const popup = { opener: {}, location: { href: "about:blank" }, close: vi.fn() }
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
    render(() => <DrivePickerCard />)
    await waitFor(() => expect(screen.getByTestId("drive-picker-choose")).toBeTruthy())
    fireEvent.click(screen.getByTestId("drive-picker-choose"))
    expect(open).toHaveBeenCalledWith("about:blank", "liaison-drive-picker", expect.any(String))
    await waitFor(() =>
      expect(popup.location.href).toBe("https://liaison.example/api/drive-picker/abc"),
    )
    expect(popup.opener).toBeNull()
    expect(apiMocks.post).toHaveBeenCalledWith("/google-drive/picker/ticket", {
      accountId: ACCOUNT,
    })
  })

  it("under an agent's call, the ticket carries the call's origin", async () => {
    apiMocks.get.mockResolvedValue(state())
    apiMocks.post.mockResolvedValue({ url: "https://liaison.example/api/drive-picker/abc" })
    const popup = { opener: {}, location: { href: "about:blank" }, close: vi.fn() }
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
    render(() => <DrivePickerCard origin="origin-from-the-agent-call-0123456789" />)
    await waitFor(() => expect(screen.getByTestId("drive-picker-choose")).toBeTruthy())
    fireEvent.click(screen.getByTestId("drive-picker-choose"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/google-drive/picker/ticket", {
        accountId: ACCOUNT,
        origin: "origin-from-the-agent-call-0123456789",
      }),
    )
    expect(drivePickerOrigin({ result: { card: "shown", origin: "o-1" } })).toBe("o-1")
    expect(drivePickerOrigin({ result: { card: "shown" } })).toBeUndefined()
  })

  it("in a conversation, lists what was picked here first and folds the account's other picks", async () => {
    const ORIGIN = "origin-from-the-agent-call-0123456789"
    const THREAD = "22222222-2222-4222-8222-222222222222"
    apiMocks.get.mockResolvedValue({ ...state(), cardPicks: ["doc-aaaaaaaa"] })
    apiMocks.post.mockResolvedValue({ picked: [], sourceId: "s" })
    render(() => <DrivePickerCard origin={ORIGIN} threadId={THREAD} />)
    await waitFor(() =>
      expect(screen.getByTestId("drive-picker-here").textContent).toBe("Picked here"),
    )
    expect(apiMocks.get).toHaveBeenCalledWith(
      `/google-drive/picker?origin=${ORIGIN}&threadId=${THREAD}`,
    )
    expect(screen.getByTestId("drive-picker-item-doc-aaaaaaaa")).toBeTruthy()
    expect(screen.queryByTestId("drive-picker-count")).toBeNull()
    // The folder picked elsewhere is one calm line, opened on demand to manage it.
    expect(screen.queryByTestId("drive-picker-item-folder-bbbbbbbb")).toBeNull()
    expect(screen.getByTestId("drive-picker-others").textContent).toContain(
      "1 other file already visible",
    )
    fireEvent.click(screen.getByTestId("drive-picker-others-toggle"))
    expect(screen.getByTestId("drive-picker-others-list")).toBeTruthy()
    fireEvent.click(screen.getByTestId("drive-picker-remove-folder-bbbbbbbb"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/google-drive/picker/items", {
        accountId: ACCOUNT,
        remove: ["folder-bbbbbbbb"],
      }),
    )
    expect(drivePickerThread({ result: { card: "shown", threadId: THREAD } })).toBe(THREAD)
    expect(drivePickerThread({ result: { card: "shown" } })).toBeUndefined()
  })

  it("in a conversation with nothing picked here: the button and one line for the rest", async () => {
    apiMocks.get.mockResolvedValue({ ...state(), cardPicks: [] })
    render(() => (
      <DrivePickerCard
        origin="origin-from-the-agent-call-0123456789"
        threadId="22222222-2222-4222-8222-222222222222"
      />
    ))
    await waitFor(() => expect(screen.getByTestId("drive-picker-choose")).toBeTruthy())
    expect(screen.queryByTestId("drive-picker-here")).toBeNull()
    expect(screen.queryByTestId("drive-picker-count")).toBeNull()
    expect(screen.queryByTestId("drive-picker-item-doc-aaaaaaaa")).toBeNull()
    expect(screen.getByTestId("drive-picker-others").textContent).toContain(
      "2 other files already visible",
    )
    expect(screen.getByTestId("drive-picker-others-toggle").textContent).toBe("Manage")
  })

  it("says which picked files are not in Knowledge, and why", async () => {
    const base = state()
    const account = base.accounts[0]!
    apiMocks.get.mockResolvedValue({
      ...base,
      accounts: [
        { ...account, notImported: [{ id: "doc-aaaaaaaa", name: "Plan.docx", type: "Word" }] },
      ],
    })
    render(() => <DrivePickerCard />)
    await waitFor(() =>
      expect(screen.getByTestId("drive-picker-not-imported-doc-aaaaaaaa").textContent).toBe(
        "not in Knowledge: Word files have no text to import",
      ),
    )
    expect(screen.queryByTestId("drive-picker-not-imported-folder-bbbbbbbb")).toBeNull()
  })

  it("in a shell, the picker page opens in the system browser", async () => {
    shellMocks.shellRunsOAuth.mockReturnValue(true)
    apiMocks.get.mockResolvedValue(state())
    apiMocks.post.mockResolvedValue({ url: "https://liaison.example/api/drive-picker/abc" })
    const open = vi.spyOn(window, "open")
    render(() => <DrivePickerCard />)
    await waitFor(() => expect(screen.getByTestId("drive-picker-choose")).toBeTruthy())
    fireEvent.click(screen.getByTestId("drive-picker-choose"))
    await waitFor(() =>
      expect(externalMocks.openExternal).toHaveBeenCalledWith(
        "https://liaison.example/api/drive-picker/abc",
      ),
    )
    expect(open).not.toHaveBeenCalled()
  })

  it("without the server's Picker configuration, says so to admins instead of a button", async () => {
    apiMocks.get.mockResolvedValue(state({ pickerConfigured: false }))
    render(() => <DrivePickerCard />)
    await waitFor(() => expect(screen.getByTestId("drive-picker-not-configured")).toBeTruthy())
    expect(screen.queryByTestId("drive-picker-choose")).toBeNull()
    expect(screen.getByTestId("drive-picker-not-configured").textContent).toContain(
      "GOOGLE_PICKER_API_KEY",
    )
  })

  it("quiet: a full-mode Drive draws nothing; loud: it says there is nothing to pick", async () => {
    const full = state()
    full.accounts[0]!.mode = "full"
    apiMocks.get.mockResolvedValue(full)
    const quiet = render(() => <DrivePickerCard quiet />)
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalled())
    expect(screen.queryByTestId("drive-picker-card")).toBeNull()
    quiet.unmount()
    render(() => <DrivePickerCard />)
    await waitFor(() => expect(screen.getByTestId("drive-picker-full")).toBeTruthy())
  })
})

describe("drivePickerCardShown", () => {
  const call = (over: Record<string, unknown>) => ({
    toolName: "kernel__drive_picker",
    status: "completed",
    result: { card: "shown" },
    ...over,
  })
  it("shows the card only for a finished drive_picker call that asks for it", () => {
    expect(drivePickerCardShown(call({}))).toBe(true)
    expect(drivePickerCardShown(call({ result: { card: "none" } }))).toBe(false)
    expect(drivePickerCardShown(call({ status: "error" }))).toBe(false)
    expect(drivePickerCardShown(call({ toolName: "kernel__setup_state" }))).toBe(false)
  })
})
