// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ConnectionUnstableNotice } from "~/modules/shell/ConnectionUnstableNotice"
import { WsProvider } from "~/modules/shell/WsContext"

afterEach(() => {
  cleanup()
})

function renderNotice(initial: boolean) {
  const [unstable, setUnstable] = createSignal(initial)
  render(() => (
    <WsProvider send={vi.fn()} status={() => "connected"} unstable={unstable}>
      <ConnectionUnstableNotice />
    </WsProvider>
  ))
  return { setUnstable }
}

describe("the connection-unstable notice", () => {
  it("says nothing while the connection holds", () => {
    renderNotice(false)
    expect(screen.queryByTestId("connection-unstable-notice")).toBeNull()
  })

  it("says nothing outside the shell (no socket provider)", () => {
    render(() => <ConnectionUnstableNotice />)
    expect(screen.queryByTestId("connection-unstable-notice")).toBeNull()
  })

  it("names the cause and the server to exclude while the connection keeps dropping", () => {
    renderNotice(true)
    const notice = screen.getByTestId("connection-unstable-notice")
    expect(notice.getAttribute("role")).toBe("status")
    expect(screen.getByTestId("connection-unstable-title").textContent).toBe(
      "Your connection keeps dropping",
    )
    const body = screen.getByTestId("connection-unstable-body").textContent ?? ""
    expect(body).toContain("A VPN or network filter is the usual cause")
    expect(body).toContain(`exclude ${window.location.host} from the VPN`)
    expect(body).not.toContain("{{host}}")
  })

  it("dismisses for the episode and comes back when the connection turns unstable again", async () => {
    const { setUnstable } = renderNotice(true)
    fireEvent.click(screen.getByTestId("connection-unstable-dismiss"))
    expect(screen.queryByTestId("connection-unstable-notice")).toBeNull()

    // Still the same episode: stays dismissed.
    setUnstable(true)
    expect(screen.queryByTestId("connection-unstable-notice")).toBeNull()

    // Recovered, then cut again: it shows again.
    setUnstable(false)
    setUnstable(true)
    expect(screen.queryByTestId("connection-unstable-notice")).not.toBeNull()
  })

  it("goes away on its own once the connection recovers", () => {
    const { setUnstable } = renderNotice(true)
    expect(screen.queryByTestId("connection-unstable-notice")).not.toBeNull()
    setUnstable(false)
    expect(screen.queryByTestId("connection-unstable-notice")).toBeNull()
  })
})
