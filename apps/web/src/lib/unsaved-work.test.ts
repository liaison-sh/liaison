// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { PAGE_RELOAD_GUARD_KEY, type PageReloadGuard } from "~/lib/desktop-shell-contract"
import {
  confirmDiscard,
  installReloadGuard,
  listUnsavedWork,
  pendingDiscard,
  registerUnsavedWork,
  resetUnsavedWork,
  resolveDiscard,
} from "~/lib/unsaved-work"

afterEach(() => resetUnsavedWork())

describe("unsaved work registry", () => {
  it("lists only entries that describe something, filtered by tab", () => {
    registerUnsavedWork("a", { tabId: "t1", describe: () => "draft in t1" })
    registerUnsavedWork("b", { describe: () => null })
    const remove = registerUnsavedWork("c", { tabId: "t2", describe: () => "files in t2" })
    expect(listUnsavedWork()).toEqual(["draft in t1", "files in t2"])
    expect(listUnsavedWork((tabId) => tabId === "t2")).toEqual(["files in t2"])
    remove()
    expect(listUnsavedWork()).toEqual(["draft in t1"])
  })

  it("a stale remover does not drop the entry that replaced it", () => {
    const stale = registerUnsavedWork("a", { describe: () => "old" })
    registerUnsavedWork("a", { describe: () => "new" })
    stale()
    expect(listUnsavedWork()).toEqual(["new"])
  })

  it("confirmDiscard proceeds at once with nothing to lose, else waits for the answer", () => {
    const proceed = vi.fn()
    expect(confirmDiscard("close-tabs", [], proceed)).toBe(false)
    expect(proceed).toHaveBeenCalledTimes(1)
    expect(confirmDiscard("close-tabs", ["draft"], proceed)).toBe(true)
    expect(pendingDiscard()?.items).toEqual(["draft"])
    resolveDiscard(false)
    expect(proceed).toHaveBeenCalledTimes(1)
    confirmDiscard("close-tabs", ["draft"], proceed)
    resolveDiscard(true)
    expect(proceed).toHaveBeenCalledTimes(2)
    expect(pendingDiscard()).toBeNull()
  })

  it("the published reload guard takes the reload over only while work is held", () => {
    const target = {}
    const remove = installReloadGuard(target)
    const guard = Reflect.get(target, PAGE_RELOAD_GUARD_KEY) as PageReloadGuard
    const reload = vi.fn()
    expect(guard(reload)).toBe(false)
    registerUnsavedWork("a", { describe: () => "draft" })
    expect(guard(reload)).toBe(true)
    expect(pendingDiscard()?.action).toBe("reload")
    resolveDiscard(true)
    expect(reload).toHaveBeenCalledTimes(1)
    remove()
    expect(Reflect.get(target, PAGE_RELOAD_GUARD_KEY)).toBeUndefined()
  })
})
