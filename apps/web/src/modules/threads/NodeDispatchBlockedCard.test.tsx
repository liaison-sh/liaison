// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card of a dispatch blocked by a folder not shared: its owner, on any
// device, gets "Fix it" (the node's Folders section, searching for the name)
// and "Start again" (the same request once more); 44 px targets for the phone;
// anyone else reads the card's own line.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { ApiContext } from "~/modules/shell/ApiContext"

vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))

import { openTab } from "~/modules/shell/tab-store"
import NodeDispatchBlockedCard from "./NodeDispatchBlockedCard"

function renderCard(post: (path: string) => Promise<unknown>, viewer = "me", retried?: string) {
  const api = { post: vi.fn(post) }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <NodeDispatchBlockedCard
        messageId="m-1"
        nodeId="n-1"
        nodeName="Mac"
        name="liaison-monorepo"
        ownerUserId="me"
        currentUserId={viewer}
        retriedSessionId={retried ?? null}
        fallbackText='Not started on Mac: "liaison-monorepo" is not shared with Liaison yet.'
      />
    </ApiContext.Provider>
  ))
  return api
}

afterEach(() => vi.mocked(openTab).mockClear())

describe("NodeDispatchBlockedCard", () => {
  it("Fix it opens the computer's Folders tab searching for the name", () => {
    renderCard(async () => ({}))
    const card = screen.getByTestId("node-dispatch-blocked")
    expect(card.textContent).toContain("Not started on Mac")
    expect(card.textContent).toContain(
      "“liaison-monorepo” is not one of the folders agents can work in yet",
    )
    const fix = screen.getByTestId("node-dispatch-blocked-fix")
    expect(fix.className).toContain("min-h-[44px]")
    fireEvent.click(fix)
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "kernel:settings",
        routePath: "/settings/computers/n-1?folder=liaison-monorepo",
      }),
    )
  })

  it("Start again starts the same request once it is shared", async () => {
    const api = renderCard(async () => ({ sessionId: "s-9" }))
    fireEvent.click(screen.getByTestId("node-dispatch-blocked-again"))
    await waitFor(() =>
      expect(screen.getByTestId("node-dispatch-blocked").getAttribute("data-outcome")).toBe(
        "started",
      ),
    )
    expect(api.post).toHaveBeenCalledWith("/nodes/dispatch-blocked/m-1/retry", {})
    expect(screen.queryByTestId("node-dispatch-blocked-again")).toBeNull()
  })

  it("still not shared says so, and keeps both actions", async () => {
    renderCard(async () => {
      throw new ApiError("It did not start.", 409, "still_not_shared")
    })
    fireEvent.click(screen.getByTestId("node-dispatch-blocked-again"))
    const error = await screen.findByTestId("node-dispatch-blocked-error")
    expect(error.textContent).toContain("still not added")
    expect(screen.getByTestId("node-dispatch-blocked-fix")).toBeTruthy()
  })

  it("already started again shows it, with no button", () => {
    renderCard(async () => ({}), "me", "s-1")
    expect(screen.getByTestId("node-dispatch-blocked-started").textContent).toContain(
      "Already started again",
    )
    expect(screen.queryByTestId("node-dispatch-blocked-again")).toBeNull()
  })

  it("someone else reads the line, with no action", () => {
    renderCard(async () => ({}), "colleague")
    expect(screen.getByTestId("node-dispatch-blocked").textContent).toContain(
      'Not started on Mac: "liaison-monorepo"',
    )
    expect(screen.queryByTestId("node-dispatch-blocked-fix")).toBeNull()
    expect(screen.queryByTestId("node-dispatch-blocked-again")).toBeNull()
  })

  it("a second tap gets the session the first one started, said as such", async () => {
    renderCard(async () => ({ sessionId: "s-9", already: true }))
    fireEvent.click(screen.getByTestId("node-dispatch-blocked-again"))
    await waitFor(() =>
      expect(screen.getByTestId("node-dispatch-blocked-started").textContent).toContain(
        "Already started again",
      ),
    )
  })
})
