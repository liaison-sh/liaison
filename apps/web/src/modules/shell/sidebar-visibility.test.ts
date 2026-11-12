// SPDX-License-Identifier: FSL-1.1-ALv2
// The apps hidden from the person's sidebar (0293): read once per session,
// changed optimistically through the dedicated partial PUT, applied as is when
// relayed from elsewhere, and cleared on session teardown.
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  applyRemoteSidebarVisibility,
  hiddenSidebarApps,
  hideFromSidebar,
  hydrateSidebarVisibility,
  isHiddenFromSidebar,
  resetSidebarVisibility,
  setHiddenSidebarApps,
  showInSidebar,
} from "~/modules/shell/sidebar-visibility"

function fakeApi(prefs: unknown | (() => Promise<unknown>)) {
  const getMock = vi.fn(
    (_path: string): Promise<unknown> =>
      typeof prefs === "function" ? (prefs as () => Promise<unknown>)() : Promise.resolve(prefs),
  )
  const put = vi.fn(async (_path: string, _body: unknown): Promise<unknown> => ({}))
  return { get: getMock as <T>(path: string) => Promise<T>, put, getMock }
}

afterEach(() => resetSidebarVisibility())

describe("sidebar visibility store", () => {
  it("hydrates once per session from GET /user/preferences", async () => {
    const api = fakeApi({ hiddenSidebarApps: ["sessions", "monitoring"] })
    await hydrateSidebarVisibility(api)
    await hydrateSidebarVisibility(api)
    expect(api.getMock).toHaveBeenCalledTimes(1)
    expect(api.getMock).toHaveBeenCalledWith("/user/preferences")
    expect(hiddenSidebarApps()).toEqual(["sessions", "monitoring"])
    expect(isHiddenFromSidebar("sessions")).toBe(true)
    expect(isHiddenFromSidebar("dashboards")).toBe(false)
  })

  it("reads a missing or malformed list as nothing hidden", async () => {
    await hydrateSidebarVisibility(fakeApi({ hiddenSidebarApps: null }))
    expect(hiddenSidebarApps()).toEqual([])
  })

  it("hides and shows optimistically, putting the whole list to the partial endpoint", async () => {
    const api = fakeApi({ hiddenSidebarApps: [] })
    await hydrateSidebarVisibility(api)
    await hideFromSidebar("sessions")
    expect(isHiddenFromSidebar("sessions")).toBe(true)
    expect(api.put).toHaveBeenLastCalledWith("/user/preferences/hidden-apps", {
      hiddenSidebarApps: ["sessions"],
    })
    await hideFromSidebar("dashboards")
    await showInSidebar("sessions")
    expect(hiddenSidebarApps()).toEqual(["dashboards"])
    expect(api.put).toHaveBeenLastCalledWith("/user/preferences/hidden-apps", {
      hiddenSidebarApps: ["dashboards"],
    })
    // No-ops do not write.
    const calls = api.put.mock.calls.length
    await hideFromSidebar("dashboards")
    await showInSidebar("sessions")
    expect(api.put.mock.calls.length).toBe(calls)
  })

  it("keeps a local change made while the first read is in flight", async () => {
    let answer: (v: unknown) => void = () => {}
    const api = fakeApi(() => new Promise((r) => (answer = r)))
    const hydrating = hydrateSidebarVisibility(api)
    await setHiddenSidebarApps(["monitoring"])
    answer({ hiddenSidebarApps: ["sessions"] })
    await hydrating
    expect(hiddenSidebarApps()).toEqual(["monitoring"])
  })

  it("applies a relayed list as stored", () => {
    applyRemoteSidebarVisibility({ hiddenSidebarApps: ["tickets"] })
    expect(hiddenSidebarApps()).toEqual(["tickets"])
    applyRemoteSidebarVisibility({ hiddenSidebarApps: "nope" })
    expect(hiddenSidebarApps()).toEqual(["tickets"])
  })

  it("forgets the list on session teardown", async () => {
    const api = fakeApi({ hiddenSidebarApps: ["sessions"] })
    await hydrateSidebarVisibility(api)
    resetSidebarVisibility()
    expect(hiddenSidebarApps()).toEqual([])
    await hydrateSidebarVisibility(api)
    expect(api.getMock).toHaveBeenCalledTimes(2)
  })

  it("sends quick changes one at a time, the last change stored last", async () => {
    const api = fakeApi({ hiddenSidebarApps: [] })
    await hydrateSidebarVisibility(api)
    const releases: Array<() => void> = []
    api.put.mockImplementation(
      (_path: string, body: unknown) =>
        new Promise((resolve) => releases.push(() => resolve(body))),
    )
    const first = hideFromSidebar("sessions")
    const second = hideFromSidebar("dashboards")
    await Promise.resolve()
    expect(api.put).toHaveBeenCalledTimes(1)
    releases[0]?.()
    await first
    await vi.waitFor(() => expect(api.put).toHaveBeenCalledTimes(2))
    expect(api.put).toHaveBeenLastCalledWith("/user/preferences/hidden-apps", {
      hiddenSidebarApps: ["sessions", "dashboards"],
    })
    releases[1]?.()
    await second
  })

  it("falls back to the stored list when a save fails", async () => {
    const api = fakeApi({ hiddenSidebarApps: ["monitoring"] })
    await hydrateSidebarVisibility(api)
    api.put.mockRejectedValueOnce(new Error("offline"))
    expect(await hideFromSidebar("sessions")).toBe(false)
    expect(hiddenSidebarApps()).toEqual(["monitoring"])
  })

  it("ignores the echo of its own save while it is on its way", async () => {
    const api = fakeApi({ hiddenSidebarApps: [] })
    await hydrateSidebarVisibility(api)
    let release: (() => void) | undefined
    api.put.mockImplementation(
      (_path: string, body: unknown) => new Promise((resolve) => (release = () => resolve(body))),
    )
    const saving = hideFromSidebar("sessions")
    applyRemoteSidebarVisibility({ hiddenSidebarApps: [] })
    expect(hiddenSidebarApps()).toEqual(["sessions"])
    await vi.waitFor(() => expect(release).toBeDefined())
    release?.()
    await saving
  })

  it("drops a first read that answers after the session ended", async () => {
    let answer: ((v: unknown) => void) | undefined
    const api = fakeApi(() => new Promise((resolve) => (answer = resolve)))
    const hydrating = hydrateSidebarVisibility(api)
    resetSidebarVisibility()
    answer?.({ hiddenSidebarApps: ["sessions"] })
    await hydrating
    expect(hiddenSidebarApps()).toEqual([])
  })
})
