// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createRoot, createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CompatApp } from "~/framework/compat-mode"
import CompatModeNotice from "~/modules/shell/CompatModeNotice"
import {
  type AppShellKind,
  appShellKind,
  COMPAT_DISMISSED_KEY,
  createCompatNotice,
} from "~/modules/shell/compat-mode-notice"

afterEach(cleanup)

const BOXTAL: CompatApp = { app: "boxtal", reason: "settings", serverVersion: "0.15.0" }
const SHOPIFY: CompatApp = { app: "shopify", reason: "settings", serverVersion: "2.0.0" }

function setup(shell: AppShellKind | null, withCheck = true, stored: string | null = null) {
  const [apps, setApps] = createSignal<CompatApp[]>([])
  const run = vi.fn()
  const store = new Map<string, string>(stored ? [[COMPAT_DISMISSED_KEY, stored]] : [])
  const notice = createRoot(() =>
    createCompatNotice({
      apps,
      shell: () => shell,
      updateCheck: () => (withCheck ? run : null),
      storage: {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
      },
    }),
  )
  render(() => <CompatModeNotice notice={notice} />)
  return { setApps, run, store }
}

describe("the compatibility mode notice", () => {
  it("says nothing while every app matches, however new the server is", () => {
    const { run } = setup("desktop")
    expect(screen.queryByTestId("compat-mode-notice")).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it("on the desktop: shows once an app runs in compatibility mode, checks for an update once per set, and on a click", () => {
    const { setApps, run } = setup("desktop")
    setApps([BOXTAL])
    expect(screen.getByTestId("compat-mode-notice").textContent).toContain(
      "Some apps run in compatibility mode until you update Liaison.",
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenLastCalledWith(false)
    // The same set again (a reconnect): no second quiet check.
    setApps([{ ...BOXTAL }])
    expect(run).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId("compat-mode-check"))
    expect(run).toHaveBeenLastCalledWith(true)
    expect(screen.queryByTestId("compat-mode-store-hint")).toBeNull()
  })

  it("on the phone: points at the app store, with no check to run", () => {
    const { setApps } = setup("mobile", false)
    setApps([BOXTAL])
    expect(screen.getByTestId("compat-mode-store-hint").textContent).toContain("app store")
    expect(screen.queryByTestId("compat-mode-check")).toBeNull()
  })

  it("never in a browser tab", () => {
    const { setApps, run } = setup(null)
    setApps([BOXTAL])
    expect(screen.queryByTestId("compat-mode-notice")).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it("'Not now' is remembered for this set of apps and versions, and a new set shows it again", () => {
    const { setApps, store } = setup("desktop")
    setApps([BOXTAL])
    fireEvent.click(screen.getByTestId("compat-mode-dismiss"))
    expect(screen.queryByTestId("compat-mode-notice")).toBeNull()
    expect(store.get(COMPAT_DISMISSED_KEY)).toBe("boxtal@0.15.0:settings")
    setApps([BOXTAL, SHOPIFY])
    expect(screen.getByTestId("compat-mode-notice")).toBeTruthy()
    setApps([{ ...BOXTAL, serverVersion: "0.16.0" }])
    expect(screen.getByTestId("compat-mode-notice")).toBeTruthy()
  })

  it("a set dismissed before a restart stays hidden", () => {
    const { setApps } = setup("desktop", true, "boxtal@0.15.0:settings")
    setApps([BOXTAL])
    expect(screen.queryByTestId("compat-mode-notice")).toBeNull()
  })

  it("tells the phone from the desktop app from a browser", () => {
    expect(
      appShellKind(
        () => true,
        () => true,
      ),
    ).toBe("mobile")
    expect(
      appShellKind(
        () => false,
        () => true,
      ),
    ).toBe("desktop")
    expect(
      appShellKind(
        () => false,
        () => false,
      ),
    ).toBeNull()
  })
})
