// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The outside-text globe: shown only while the conversation is marked, a menu saying what that
// means and what marked it, "Clear the mark" acting at once (no confirmation, no card), the
// settings entry for admins only, and the pulse when an action parks because of the mark.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({ admin: true }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, hasScope: (scope: string) => scope !== "kernel:org:admin" || auth.admin }
})

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import OutsideTextMark, { OUTSIDE_TEXT_PULSE_MS } from "~/modules/threads/OutsideTextMark"
import { handleOutsideTextApprovalCreate } from "~/modules/threads/outside-text-pulse"
import { addThread, getThread, resetThreadStore } from "~/modules/threads/thread-store"

const THREAD = "t-outside"

const SOURCES = {
  marked: true,
  clearedAt: null,
  sources: [
    {
      rowId: "m1",
      at: "2026-10-26T08:00:00.000Z",
      source: "kernel:web_fetch",
      ref: { url: "https://outside.test/page" },
      excerpt: "some page text",
    },
  ],
  omitted: 0,
}

function fakeApi() {
  return {
    get: vi.fn(async () => SOURCES),
    post: vi.fn(async () => ({ cleared: true, marked: false })),
  }
}

function renderMark(
  api: ReturnType<typeof fakeApi>,
  props: { marked?: boolean; variant?: "label" | "icon" } = {},
) {
  return render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api as never}>
        <OutsideTextMark
          threadId={THREAD}
          marked={props.marked ?? true}
          variant={props.variant ?? "label"}
        />
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

async function openMenu() {
  await fireEvent.pointerDown(screen.getByTestId("outside-text-mark"))
  return screen.findByTestId("outside-text-menu")
}

describe("OutsideTextMark", () => {
  beforeEach(() => {
    auth.admin = true
    resetThreadStore()
    resetToastStore()
    addThread({
      id: THREAD,
      handle: "t-outside",
      title: "Research",
      type: "agent_chat",
      tainted: true,
      participants: [],
    })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("shows nothing while the conversation is not marked", () => {
    renderMark(fakeApi(), { marked: false })
    expect(screen.queryByTestId("outside-text-mark")).not.toBeInTheDocument()
  })

  it("the header chip carries its label; the dock's is the globe alone with the label as hint", () => {
    const { unmount } = renderMark(fakeApi(), { variant: "label" })
    expect(screen.getByTestId("outside-text-mark")).toHaveTextContent("Outside text")
    unmount()
    renderMark(fakeApi(), { variant: "icon" })
    const icon = screen.getByTestId("outside-text-mark")
    expect(icon).not.toHaveTextContent("Outside text")
    expect(icon).toHaveAttribute("aria-label", "Outside text")
    expect(icon).toHaveAttribute("title", "Outside text")
  })

  it("opens a menu saying what the mark means and what marked it", async () => {
    const api = fakeApi()
    renderMark(api)
    const menu = await openMenu()
    expect(menu).toHaveTextContent("This conversation read outside text")
    expect(menu).toHaveTextContent("anything it writes or sends now waits for your approval")
    expect(api.get).toHaveBeenCalledWith(`/threads/${THREAD}/outside-text`)
    const source = await screen.findByTestId("outside-text-source")
    expect(source).toHaveTextContent("kernel:web_fetch")
    expect(source).toHaveTextContent("https://outside.test/page")
  })

  it("Clear the mark acts at once: no confirmation, the globe's state drops, a toast says so", async () => {
    const api = fakeApi()
    renderMark(api)
    await openMenu()
    // Kobalte selects a menu row on Enter (or pointer up), never on a bare click event.
    await fireEvent.keyDown(await screen.findByTestId("outside-text-clear"), { key: "Enter" })
    await vi.waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(`/threads/${THREAD}/outside-text/clear`),
    )
    await vi.waitFor(() => expect(getThread(THREAD)?.tainted).toBe(false))
    expect(toasts().map((t) => t.message)).toContain("Mark cleared")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })

  it("offers the approval settings to admins only", async () => {
    renderMark(fakeApi())
    await openMenu()
    expect(await screen.findByTestId("outside-text-settings")).toHaveTextContent(
      "Approval settings",
    )
    cleanup()
    auth.admin = false
    renderMark(fakeApi())
    await openMenu()
    await screen.findByTestId("outside-text-clear")
    expect(screen.queryByTestId("outside-text-settings")).not.toBeInTheDocument()
  })

  it("pulses when an action of this conversation parks because of the mark, then stops", async () => {
    vi.useFakeTimers()
    renderMark(fakeApi())
    const chip = screen.getByTestId("outside-text-mark")
    // Another reason, or another conversation: no pulse.
    handleOutsideTextApprovalCreate({ originatingThreadId: THREAD })
    handleOutsideTextApprovalCreate({ heldForOutsideText: true, originatingThreadId: "other" })
    await vi.advanceTimersByTimeAsync(0)
    expect(chip).not.toHaveClass("outside-text-pulse")

    handleOutsideTextApprovalCreate({ heldForOutsideText: true, originatingThreadId: THREAD })
    await vi.advanceTimersByTimeAsync(0)
    expect(chip).toHaveClass("outside-text-pulse")
    await vi.advanceTimersByTimeAsync(OUTSIDE_TEXT_PULSE_MS)
    expect(chip).not.toHaveClass("outside-text-pulse")
  })
})
