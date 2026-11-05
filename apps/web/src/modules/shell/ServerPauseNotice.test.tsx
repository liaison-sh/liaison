// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  noteServerBack,
  noteServerRestarting,
  ServerPauseTestAccess,
  trackRequest,
} from "~/lib/server-pause"
import { ServerPauseNotice } from "~/modules/shell/ServerPauseNotice"
import { WsProvider } from "~/modules/shell/WsContext"

vi.mock("~/modules/shell/shell-tier", () => ({ shellTier: () => "desktop" }))

type Status = "connecting" | "connected" | "disconnected" | "reconnecting"

const UPDATING = "Liaison is updating. This usually takes less than a minute."
const STILL_UPDATING = "Still updating. If this lasts, check your connection."
const CONNECTION_LOST = "Connection lost, reconnecting…"
const OFFLINE = "You're offline. Reconnecting when you're back."

beforeEach(() => {
  vi.useFakeTimers()
  ServerPauseTestAccess.reset()
})

afterEach(() => {
  cleanup()
  ServerPauseTestAccess.reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function renderNotice(initial: Status = "connected") {
  const [status, setStatus] = createSignal<Status>(initial)
  render(() => (
    <WsProvider send={vi.fn()} status={status}>
      <ServerPauseNotice />
    </WsProvider>
  ))
  return { setStatus }
}

const notice = () => screen.queryByTestId("server-pause-notice")
const text = () => notice()?.textContent ?? null

describe("the server pause notice", () => {
  it("says nothing on first load, however long the first connect takes", () => {
    const { setStatus } = renderNotice("connecting")
    trackRequest()
    vi.advanceTimersByTime(10_000)
    setStatus("reconnecting")
    vi.advanceTimersByTime(10_000)
    expect(notice()).toBeNull()
  })

  it("says nothing for a short blip", () => {
    const { setStatus } = renderNotice()
    setStatus("reconnecting")
    vi.advanceTimersByTime(2_500)
    expect(notice()).toBeNull()
    setStatus("connected")
    vi.advanceTimersByTime(10_000)
    expect(notice()).toBeNull()
  })

  it("an abrupt drop shows the connection line after 3 s, never the update line", () => {
    const { setStatus } = renderNotice()
    setStatus("reconnecting")
    vi.advanceTimersByTime(2_900)
    expect(notice()).toBeNull()
    vi.advanceTimersByTime(600)
    expect(notice()?.getAttribute("data-pause-kind")).toBe("connectionLost")
    expect(text()).toBe(CONNECTION_LOST)
    vi.advanceTimersByTime(120_000)
    expect(text()).toBe(CONNECTION_LOST)
  })

  it("a request stuck since before the drop counts from when it started", () => {
    const { setStatus } = renderNotice()
    trackRequest()
    vi.advanceTimersByTime(2_000)
    setStatus("reconnecting")
    vi.advanceTimersByTime(1_200)
    expect(text()).toBe(CONNECTION_LOST)
  })

  it("an offline device gets the offline line, never the update line", () => {
    const { setStatus } = renderNotice()
    window.dispatchEvent(new Event("offline"))
    setStatus("disconnected")
    vi.advanceTimersByTime(3_500)
    expect(notice()?.getAttribute("data-pause-kind")).toBe("offline")
    expect(text()).toBe(OFFLINE)
    window.dispatchEvent(new Event("online"))
  })

  it("the server's restart signal (1012 close) shows the update line at once", () => {
    const { setStatus } = renderNotice()
    noteServerRestarting()
    setStatus("reconnecting")
    expect(text()).toBe(UPDATING)
  })

  it("a 503 RESTARTING with the socket still up shows the update line at once", () => {
    renderNotice()
    noteServerRestarting()
    expect(text()).toBe(UPDATING)
    // The draining process never closed the socket: it does not stay forever.
    vi.advanceTimersByTime(31_000)
    expect(notice()).toBeNull()
  })

  it("after 90 s on an update it also points at the connection", () => {
    const { setStatus } = renderNotice()
    noteServerRestarting()
    setStatus("reconnecting")
    vi.advanceTimersByTime(89_000)
    expect(text()).toBe(UPDATING)
    vi.advanceTimersByTime(1_500)
    expect(notice()?.getAttribute("data-pause-kind")).toBe("stillUpdating")
    expect(text()).toBe(STILL_UPDATING)
  })

  it("goes the moment the socket is back, with nothing in its place", () => {
    const { setStatus } = renderNotice()
    noteServerRestarting()
    setStatus("reconnecting")
    vi.advanceTimersByTime(20_000)
    expect(text()).toBe(UPDATING)
    // createWebSocket's onopen: the server is back, then the status flips.
    noteServerBack()
    setStatus("connected")
    expect(notice()).toBeNull()
    vi.advanceTimersByTime(5_000)
    expect(notice()).toBeNull()
  })

  it("the connection line goes too when the socket reconnects", () => {
    const { setStatus } = renderNotice()
    setStatus("reconnecting")
    vi.advanceTimersByTime(5_000)
    expect(text()).toBe(CONNECTION_LOST)
    setStatus("connected")
    expect(notice()).toBeNull()
  })

  it("says nothing outside the shell (no socket provider)", () => {
    noteServerRestarting()
    render(() => <ServerPauseNotice />)
    expect(notice()).toBeNull()
  })
})
