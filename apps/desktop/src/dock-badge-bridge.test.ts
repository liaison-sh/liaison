// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page's badge count reaches the shell's `set_unread_badge` command
// (src-tauri/src/dock_badge.rs) through the REAL published bridge and the real
// @tauri-apps/api `invoke`. Only the webview's IPC is stubbed: the
// `__TAURI_INTERNALS__` objects the Tauri runtime puts on the window, which is
// the boundary between the page and the OS shell.
import { DESKTOP_BRIDGE_KEY, type DesktopBridge } from "@liaison/web/lib/desktop-shell-contract"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { publishDesktopBridge } from "./bridge"

type Ipc = (command: string, args?: unknown, options?: unknown) => Promise<unknown>

const calls: Array<{ command: string; args: unknown }> = []

function installIpc(impl?: Ipc): void {
  const invoke = vi.fn(
    impl ??
      (async (command: string, args?: unknown) => {
        calls.push({ command, args })
        return null
      }),
  )
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: () => 0,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  }
  // The event plugin's half, which `listen`'s unlisten calls on the bridge's own listeners.
  ;(window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => undefined,
  }
}

function badgeCalls(): unknown[] {
  return calls.filter((c) => c.command === "set_unread_badge").map((c) => c.args)
}

describe("the app icon badge through the published bridge", () => {
  let bridge: DesktopBridge

  beforeEach(() => {
    calls.length = 0
    installIpc()
    const target: Record<string, unknown> = {}
    publishDesktopBridge(target)
    bridge = target[DESKTOP_BRIDGE_KEY] as DesktopBridge
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    delete (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__
  })

  it("hands the shell the count, and zero, which takes the badge down", async () => {
    expect(typeof bridge.setUnreadBadge).toBe("function")
    await bridge.setUnreadBadge?.(3)
    await bridge.setUnreadBadge?.(0)
    expect(badgeCalls()).toEqual([{ count: 3 }, { count: 0 }])
  })

  it("sends a whole, non-negative count (the command takes a u32)", async () => {
    await bridge.setUnreadBadge?.(2.9)
    await bridge.setUnreadBadge?.(-4)
    await bridge.setUnreadBadge?.(Number.NaN)
    expect(badgeCalls()).toEqual([{ count: 2 }, { count: 0 }, { count: 0 }])
  })

  it("a shell that refuses the command costs the badge, never the page", async () => {
    installIpc(async () => {
      throw new Error("command set_unread_badge not found")
    })
    await expect(bridge.setUnreadBadge?.(5)).resolves.toBeUndefined()
  })
})
