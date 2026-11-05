// SPDX-License-Identifier: FSL-1.1-ALv2

import { PAGE_RELOAD_GUARD_KEY } from "@liaison/web/lib/desktop-shell-contract"
import { describe, expect, it, vi } from "vitest"
import { installReload, RELOAD_GLOBAL, reloadKindForKey, reloadWindow } from "./reload"

const key = (k: string, mods: Partial<KeyboardEventInit> = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
})

describe("reload shortcuts", () => {
  it("maps Ctrl+R and F5 to reload, Ctrl+Shift+R and Ctrl+F5 to force", () => {
    expect(reloadKindForKey(key("r", { ctrlKey: true }))).toBe("reload")
    expect(reloadKindForKey(key("F5"))).toBe("reload")
    expect(reloadKindForKey(key("R", { ctrlKey: true, shiftKey: true }))).toBe("force")
    expect(reloadKindForKey(key("F5", { ctrlKey: true }))).toBe("force")
  })

  it("ignores other keys, Cmd+R (the macOS menu's) and Alt chords", () => {
    expect(reloadKindForKey(key("r"))).toBeNull()
    expect(reloadKindForKey(key("r", { metaKey: true }))).toBeNull()
    expect(reloadKindForKey(key("r", { ctrlKey: true, altKey: true }))).toBeNull()
  })

  it("a reload reloads the page; force also drops the caches", async () => {
    const reload = vi.fn()
    const del = vi.fn(async () => true)
    const view = { location: { reload }, caches: { keys: async () => ["a", "b"], delete: del } }
    await reloadWindow(false, view as never)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(del).not.toHaveBeenCalled()
    await reloadWindow(true, view as never)
    expect(del).toHaveBeenCalledTimes(2)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("a force reload still reloads when the Cache API throws", async () => {
    const reload = vi.fn()
    const caches = {
      keys: async () => {
        throw new Error("no")
      },
    }
    await reloadWindow(true, { location: { reload }, caches } as never)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("off macOS the keydown listener reloads; on macOS only the menu global exists", () => {
    const reload = vi.fn()
    const make = () => {
      const target = new EventTarget()
      return Object.assign(target, { location: { reload }, navigator: { platform: "Win32" } })
    }
    const win = make()
    installReload(win as never, false)
    const ev = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, cancelable: true })
    win.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)

    const mac = make()
    installReload(mac as never, true)
    mac.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true }))
    expect(reload).toHaveBeenCalledTimes(1)
    const menuEntry = Reflect.get(mac, RELOAD_GLOBAL) as (force: boolean) => void
    menuEntry(false)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it("asks the page first: a page holding unsaved work takes the reload over", async () => {
    const reload = vi.fn()
    let held: (() => void) | undefined
    const guard = vi.fn((proceed: () => void) => {
      held = proceed
      return true
    })
    const view = { location: { reload }, [PAGE_RELOAD_GUARD_KEY]: guard }
    await reloadWindow(false, view as never)
    expect(guard).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    held?.()
    await Promise.resolve()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("reloads at once when the page's guard has nothing to lose", async () => {
    const reload = vi.fn()
    const view = { location: { reload }, [PAGE_RELOAD_GUARD_KEY]: () => false }
    await reloadWindow(true, view as never)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
