// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))
vi.mock("../tauri", () => ({ invoke, listen: vi.fn(async () => () => {}) }))

import {
  BANNER_ID,
  DISMISS_NOTICE_COMMAND,
  installServerNoticeBanner,
  NOTICES_COMMAND,
  noticeText,
  OPEN_NOTICE_COMMAND,
} from "./server-notice-banner"

const GLOBEX = "https://globex.example.com"

describe("the New in <server> fallback", () => {
  let notices: Array<{ server: string; label: string }>
  let stop: () => void = () => undefined

  beforeEach(() => {
    notices = []
    invoke.mockReset()
    invoke.mockImplementation(async (command, args) => {
      if (command === NOTICES_COMMAND) return notices
      if (command === OPEN_NOTICE_COMMAND) {
        const server = (args as { server: string }).server
        notices = notices.filter((n) => n.server !== server)
        return server
      }
      if (command === DISMISS_NOTICE_COMMAND) {
        notices = notices.filter((n) => n.server !== (args as { server: string }).server)
      }
      return undefined
    })
  })

  afterEach(() => {
    stop()
    document.getElementById(BANNER_ID)?.remove()
  })

  it("shows a banner when the window comes forward and its click switches to that server", async () => {
    const switched: string[] = []
    stop = installServerNoticeBanner({
      switchTo: async (address) => {
        switched.push(address)
      },
    })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(NOTICES_COMMAND))
    expect(document.getElementById(BANNER_ID)).toBeNull()

    notices = [{ server: GLOBEX, label: "Globex" }]
    window.dispatchEvent(new Event("focus"))
    await vi.waitFor(() => expect(document.getElementById(BANNER_ID)).not.toBeNull())
    const open = document.querySelector<HTMLButtonElement>(`#${BANNER_ID} button[data-server]`)
    expect(open?.textContent).toBe("New in Globex")
    open?.click()
    await vi.waitFor(() => expect(switched).toEqual([GLOBEX]))
    expect(invoke).toHaveBeenCalledWith(OPEN_NOTICE_COMMAND, { server: GLOBEX })
    expect(document.getElementById(BANNER_ID)).toBeNull()
  })

  it("a dismissed banner goes and switches nothing", async () => {
    notices = [{ server: GLOBEX, label: "Globex" }]
    const switched: string[] = []
    stop = installServerNoticeBanner({
      switchTo: async (address) => {
        switched.push(address)
      },
    })
    await vi.waitFor(() => expect(document.getElementById(BANNER_ID)).not.toBeNull())
    document.querySelector<HTMLButtonElement>(`#${BANNER_ID} button[aria-label="Dismiss"]`)?.click()
    await vi.waitFor(() => expect(document.getElementById(BANNER_ID)).toBeNull())
    expect(switched).toEqual([])
  })

  // A refresh runs detached, so a document that cannot take the banner (the
  // overlay boots on a document still loading) must not reject into the page.
  it("a document that cannot take the banner is reported, never rejected into the page", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const loading = {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as Document
      stop = installServerNoticeBanner({ doc: loading, switchTo: async () => undefined })
      await vi.waitFor(() =>
        expect(reported).toHaveBeenCalledWith(
          "liaison: the server notices could not be drawn",
          expect.any(TypeError),
        ),
      )
    } finally {
      reported.mockRestore()
    }
  })

  it("its words carry no dash punctuation", () => {
    expect(noticeText("Globex")).toBe("New in Globex")
    expect(noticeText("Globex")).not.toMatch(/[–—]|--/)
  })
})
