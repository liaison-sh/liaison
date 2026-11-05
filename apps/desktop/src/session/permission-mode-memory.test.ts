// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The three cases that travelled with this memory out of
// `OpenFolderWithAgent.tsx`: a new pair is Auto (the default since
// 2026-09-23), a remembered pair comes back on its own mode, and a window with
// no usable storage falls back to Auto rather than to whatever it last saw.
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  permissionModeKey,
  recallPermissionMode,
  rememberPermissionMode,
} from "./permission-mode-memory"

describe("the permission mode a (agent, folder) pair ran in", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it("is Auto for a pair nobody chose a mode for", () => {
    expect(recallPermissionMode("agent-1", "hash-1")).toBe("auto")
  })

  // Only an explicit menu choice ever writes this memory (bridge.ts), so a
  // stored Manual is a person's own and is NOT migrated to the new default.
  it("keeps an explicitly chosen Manual, and remembers Auto", () => {
    rememberPermissionMode("agent-1", "hash-1", "manual")
    rememberPermissionMode("agent-2", "hash-1", "auto")
    expect(recallPermissionMode("agent-1", "hash-1")).toBe("manual")
    expect(recallPermissionMode("agent-2", "hash-1")).toBe("auto")
  })

  it("comes back per agent and per folder, not per machine", () => {
    rememberPermissionMode("agent-1", "hash-1", "edit")
    rememberPermissionMode("agent-2", "hash-1", "plan")
    expect(recallPermissionMode("agent-1", "hash-1")).toBe("edit")
    expect(recallPermissionMode("agent-2", "hash-1")).toBe("plan")
    // A different folder for the same agent is a different pair.
    expect(recallPermissionMode("agent-1", "hash-2")).toBe("auto")
    expect(localStorage.getItem(permissionModeKey("agent-1", "hash-1"))).toBe("edit")
  })

  it("falls back to Auto, never to Bypass, when storage refuses", () => {
    rememberPermissionMode("agent-1", "hash-1", "bypass")
    // A REFUSING STORAGE IS INSTALLED, NOT SPIED (P6d-FX7, SK-1). jsdom hands
    // out its Storage through a Proxy whose defineProperty trap writes a
    // STORAGE ITEM: `vi.spyOn(localStorage, "getItem")` therefore stored a
    // value under the key "getItem" and left the real method in place, so the
    // case read back the `bypass` it had just written and the fallback it names
    // was never reached. Whether that happened at all depended on which file
    // ran first in the worker, which is why it passed alone and failed in the
    // suite. The module resolves its storage off `globalThis` on every call,
    // so the arrangement is to put a refusing Storage there.
    const refusing = {
      getItem: () => {
        throw new Error("site data blocked")
      },
      setItem: () => {
        throw new Error("site data blocked")
      },
      removeItem: () => undefined,
      clear: () => undefined,
      key: () => null,
      length: 0,
    } as unknown as Storage
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: refusing,
    })
    try {
      expect(recallPermissionMode("agent-1", "hash-1")).toBe("auto")
      expect(() => rememberPermissionMode("agent-1", "hash-1", "edit")).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original)
    }
  })

  it("reads the same storage the window writes, whatever ran before it", () => {
    // The order dependence in one assertion: the two globals a test and a
    // module each reach for have to be one object, or the case above is
    // arranging a storage nobody reads.
    expect(globalThis.localStorage).toBe(window.localStorage)
    window.localStorage.setItem(permissionModeKey("agent-9", "hash-9"), "plan")
    expect(recallPermissionMode("agent-9", "hash-9")).toBe("plan")
  })
})
