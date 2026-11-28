// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DesktopBridge, DesktopShellStatus } from "~/lib/desktop-shell-contract"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import {
  createNativeServedShellUpdater,
  createServedShellUpdater,
  IDLE_RELOAD_MS,
  loadShellStatus,
  resetShellReady,
  resetShellStatus,
  runningServedShell,
  SERVED_CHECK_INTERVAL_MS,
  shellReport,
  signalShellReady,
} from "~/lib/served-shell"

const PAGE = "0123456789abcdef"
const NEWER = "fedcba9876543210"

function updater(over: { unsaved?: boolean; serverId?: string | null; pending?: string | null }) {
  let clock = 1_000_000
  const reload = vi.fn()
  const refreshShell = vi.fn(async () => (over.pending === undefined ? NEWER : over.pending))
  const u = createServedShellUpdater({
    pageBuildId: PAGE,
    fetchServerBuildId: async () => (over.serverId === undefined ? NEWER : over.serverId),
    refreshShell,
    hasUnsavedWork: () => over.unsaved === true,
    reload,
    now: () => clock,
  })
  return {
    u,
    reload,
    refreshShell,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

afterEach(() => {
  resetShellStatus()
  resetShellReady()
  ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = undefined
})

describe("the idle reload onto a newer served build", () => {
  it("reloads once the page is idle and clean", async () => {
    const t = updater({})
    await t.u.check()
    expect(t.u.pending()).toBe(NEWER)
    t.advance(IDLE_RELOAD_MS)
    expect(t.u.tick()).toBe(true)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it("waits while the page is not idle", async () => {
    const t = updater({})
    await t.u.check()
    t.advance(IDLE_RELOAD_MS - 1)
    expect(t.u.tick()).toBe(false)
    t.advance(1)
    t.u.noteInput()
    t.advance(IDLE_RELOAD_MS - 1)
    expect(t.u.tick()).toBe(false)
    expect(t.reload).not.toHaveBeenCalled()
  })

  it("a dirty draft blocks the reload", async () => {
    const t = updater({ unsaved: true })
    await t.u.check()
    t.advance(IDLE_RELOAD_MS * 3)
    expect(t.u.tick()).toBe(false)
    expect(t.reload).not.toHaveBeenCalled()
  })

  it("does nothing when the server runs this build or the shell has nothing pending", async () => {
    const same = updater({ serverId: PAGE })
    await same.u.check()
    expect(same.refreshShell).not.toHaveBeenCalled()
    const none = updater({ pending: null })
    await none.u.check()
    none.advance(IDLE_RELOAD_MS)
    expect(none.u.tick()).toBe(false)
    expect(none.reload).not.toHaveBeenCalled()
  })

  it("a staged bundled shell reloads the same way, when idle and clean", async () => {
    const t = updater({ pending: "bundled" })
    await t.u.check()
    expect(t.u.pending()).toBe("bundled")
    t.advance(IDLE_RELOAD_MS)
    expect(t.u.tick()).toBe(true)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it("asks the server at most every few minutes", async () => {
    const t = updater({ pending: null })
    await t.u.check()
    await t.u.check()
    expect(t.refreshShell).toHaveBeenCalledTimes(1)
    t.advance(SERVED_CHECK_INTERVAL_MS)
    await t.u.check()
    expect(t.refreshShell).toHaveBeenCalledTimes(2)
  })
})

describe("what the page tells and learns from the shell", () => {
  it("signals ready once, with the page's build id", () => {
    const shellReady = vi.fn(async () => {})
    const bridge = { shellReady } as unknown as DesktopBridge
    const doc = new DOMParser().parseFromString(
      `<html><head><meta name="liaison-web-build" content="${PAGE}"></head></html>`,
      "text/html",
    )
    signalShellReady(bridge, doc)
    signalShellReady(bridge, doc)
    expect(shellReady).toHaveBeenCalledTimes(1)
    expect(shellReady).toHaveBeenCalledWith(PAGE)
  })

  it("never signals for the unbuilt placeholder", () => {
    const shellReady = vi.fn(async () => {})
    const doc = new DOMParser().parseFromString(
      '<html><head><meta name="liaison-web-build" content="__LIAISON_WEB_BUILD_ID__"></head></html>',
      "text/html",
    )
    signalShellReady({ shellReady } as unknown as DesktopBridge, doc)
    expect(shellReady).not.toHaveBeenCalled()
  })

  it("learns whether a served build runs", async () => {
    const served: DesktopShellStatus = { served: true, buildId: PAGE, reason: null, pending: false }
    const bridge = { shellStatus: async () => served } as unknown as DesktopBridge
    expect(runningServedShell()).toBe(false)
    expect(await loadShellStatus(bridge)).toEqual(served)
    expect(runningServedShell()).toBe(true)
    expect(await loadShellStatus({} as DesktopBridge)).toBeNull()
  })

  it("reports served or bundled with a reason, and nothing it cannot vouch for", () => {
    expect(shellReport({ served: true, buildId: PAGE, reason: null, pending: false })).toBe(
      `served:${PAGE}`,
    )
    expect(shellReport({ served: false, buildId: null, reason: "no_build", pending: false })).toBe(
      "bundled:no_build",
    )
    expect(shellReport({ served: false, buildId: null, reason: "x\r\ny: z", pending: false })).toBe(
      "bundled:unknown",
    )
    expect(shellReport(null)).toBeNull()
  })
})

describe("the served shell on the phone", () => {
  const global = globalThis as Record<string, unknown>
  const SERVED = {
    bridgeVersion: 1,
    shell: `served:${PAGE}`,
    served: true,
    buildId: PAGE,
  }

  it("learns from the phone's host whether a served build runs", async () => {
    global[NATIVE_BRIDGE_GLOBAL] = { shellInfo: async () => SERVED }
    const status = await loadShellStatus(null)
    expect(status).toEqual({ served: true, buildId: PAGE, reason: null, pending: false })
    expect(runningServedShell()).toBe(true)
    expect(shellReport(status)).toBe(`served:${PAGE}`)
    global[NATIVE_BRIDGE_GLOBAL] = {
      shellInfo: async () => ({
        bridgeVersion: 1,
        shell: "bundled:no_build",
        served: false,
        reason: "no_build",
      }),
    }
    const bundled = await loadShellStatus(null)
    expect(runningServedShell()).toBe(false)
    expect(shellReport(bundled)).toBe("bundled:no_build")
  })

  function phone(over: { unsaved?: boolean; serverId?: string | null; staged?: boolean }) {
    let clock = 1_000_000
    const reload = vi.fn()
    const refresh = vi.fn(async () => over.staged !== false)
    const u = createNativeServedShellUpdater({
      pageBuildId: PAGE,
      fetchServerBuildId: async () => (over.serverId === undefined ? NEWER : over.serverId),
      refresh,
      hasUnsavedWork: () => over.unsaved === true,
      reload,
      now: () => clock,
    })
    return {
      u,
      reload,
      refresh,
      advance: (ms: number) => {
        clock += ms
      },
    }
  }

  it("a newer build the host staged reloads once the page is idle and clean", async () => {
    const t = phone({})
    await t.u.check()
    expect(t.refresh).toHaveBeenCalledTimes(1)
    t.advance(IDLE_RELOAD_MS - 1)
    expect(t.u.tick()).toBe(false)
    t.advance(1)
    expect(t.u.tick()).toBe(true)
    expect(t.reload).toHaveBeenCalledTimes(1)
  })

  it("a dirty draft blocks the reload", async () => {
    const t = phone({ unsaved: true })
    await t.u.check()
    t.advance(IDLE_RELOAD_MS * 3)
    expect(t.u.tick()).toBe(false)
    expect(t.reload).not.toHaveBeenCalled()
  })

  it("nothing staged by the host, or the server runs this build: no reload", async () => {
    const none = phone({ staged: false })
    await none.u.check()
    none.advance(IDLE_RELOAD_MS)
    expect(none.u.tick()).toBe(false)
    const same = phone({ serverId: PAGE })
    await same.u.check()
    expect(same.refresh).not.toHaveBeenCalled()
    same.advance(IDLE_RELOAD_MS)
    expect(same.u.tick()).toBe(false)
  })
})
