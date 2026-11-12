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

import { pageHandleOf } from "./open-page"
import { PageHandleCard } from "./PageHandleCard"

const HANDLE = `lpg_${"a".repeat(43)}`

beforeEach(() => {
  apiMocks.post.mockReset()
  shellMocks.shellRunsOAuth.mockReturnValue(false)
  externalMocks.openExternal.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe("pageHandleOf", () => {
  it("finds a handle in the result or its page field, and nothing else", () => {
    const h = { handle: HANDLE, app: "files-app", page: "picker", expiresInSeconds: 300 }
    expect(pageHandleOf({ status: "done", result: h })).toEqual({
      handle: HANDLE,
      app: "files-app",
      page: "picker",
    })
    expect(pageHandleOf({ status: "done", result: { page: h, note: "x" } })?.page).toBe("picker")
    expect(pageHandleOf({ status: "error", result: h })).toBeNull()
    expect(pageHandleOf({ status: "done", result: { ...h, handle: "https://evil" } })).toBeNull()
    expect(pageHandleOf({ status: "done", result: { ...h, app: "../x" } })).toBeNull()
  })
})

describe("PageHandleCard", () => {
  it("opens the page through the person's own session, in a popup opened by the click", async () => {
    const popup = { opener: {}, location: { href: "" }, close: vi.fn() }
    vi.spyOn(window, "open").mockReturnValue(popup as never)
    apiMocks.post.mockResolvedValue({ url: "https://org.example/api/app-pages/t" })
    render(() => <PageHandleCard handle={{ handle: HANDLE, app: "files-app", page: "picker" }} />)
    fireEvent.click(screen.getByTestId("page-handle-open"))
    await waitFor(() => expect(popup.location.href).toBe("https://org.example/api/app-pages/t"))
    expect(apiMocks.post).toHaveBeenCalledWith("/apps/files-app/pages/open", { handle: HANDLE })
    expect(popup.opener).toBeNull()
    expect(screen.getByTestId("page-handle-card").textContent).toContain("Opened")
  })

  it("in a shell, opens the system browser; a used handle says to ask again", async () => {
    shellMocks.shellRunsOAuth.mockReturnValue(true)
    apiMocks.post.mockRejectedValue(new Error("page_handle_invalid"))
    render(() => <PageHandleCard handle={{ handle: HANDLE, app: "files-app", page: "picker" }} />)
    fireEvent.click(screen.getByTestId("page-handle-open"))
    await waitFor(() =>
      expect(screen.getByTestId("page-handle-card").textContent).toContain("expired"),
    )
    expect(externalMocks.openExternal).not.toHaveBeenCalled()
  })
})
