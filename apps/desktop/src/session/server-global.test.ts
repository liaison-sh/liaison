// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The address the page runs against, and the one reload that makes the wrapped
// app start against it. The failure these pin is the login that says it cannot
// reach the server: apps/web built its first requests before any address
// existed, and nothing started it again once one did.
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  ADDRESS_RELOAD_MARKER_KEY,
  publishedServerAddress,
  publishMirroredServerAddress,
  publishServerAddress,
  SERVER_ADDRESS_GLOBAL,
  SERVER_ADDRESS_MIRROR_KEY,
  type SyncStorage,
  settleServerAddress,
} from "./server-global"

function memoryStorage(initial: Record<string, string> = {}): SyncStorage & {
  values: Record<string, string>
} {
  const values: Record<string, string> = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
    removeItem: (key) => {
      delete values[key]
    },
  }
}

describe("publishServerAddress", () => {
  it("publishes the origin alone", () => {
    const target: Record<string, unknown> = {}
    expect(publishServerAddress(target, " https://box.example/app?x=1 ")).toBe(true)
    expect(target[SERVER_ADDRESS_GLOBAL]).toBe("https://box.example")
  })

  it("publishes nothing for an address that is not absolute http or https", () => {
    const target: Record<string, unknown> = {}
    for (const bad of ["", "box.example", "javascript:alert(1)", "file:///etc/passwd"]) {
      expect(publishServerAddress(target, bad)).toBe(false)
    }
    expect(SERVER_ADDRESS_GLOBAL in target).toBe(false)
  })
})

describe("the synchronous mirror", () => {
  it("publishes what the last settle wrote, with no await", () => {
    const target: Record<string, unknown> = {}
    const storage = memoryStorage({ [SERVER_ADDRESS_MIRROR_KEY]: "https://box.example" })
    expect(publishMirroredServerAddress(target, storage)).toBe(true)
    expect(publishedServerAddress(target)).toBe("https://box.example")
  })

  it("publishes nothing from an empty or poisoned mirror", () => {
    const target: Record<string, unknown> = {}
    expect(publishMirroredServerAddress(target, memoryStorage())).toBe(false)
    expect(
      publishMirroredServerAddress(
        target,
        memoryStorage({ [SERVER_ADDRESS_MIRROR_KEY]: "javascript:alert(1)" }),
      ),
    ).toBe(false)
    expect(SERVER_ADDRESS_GLOBAL in target).toBe(false)
  })
})

describe("settleServerAddress", () => {
  let target: Record<string, unknown>
  beforeEach(() => {
    target = {}
  })

  it("reloads the page when first launch binds an address the page never had", () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    expect(settleServerAddress("http://localhost:3100", { target, storage, reload })).toBe(
      "reloaded",
    )
    expect(reload).toHaveBeenCalledTimes(1)
    expect(publishedServerAddress(target)).toBe("http://localhost:3100")
    expect(storage.values[SERVER_ADDRESS_MIRROR_KEY]).toBe("http://localhost:3100")
  })

  it("does not reload when the page already booted on that address", () => {
    const reload = vi.fn()
    const storage = memoryStorage({ [SERVER_ADDRESS_MIRROR_KEY]: "http://localhost:3100" })
    publishMirroredServerAddress(target, storage)
    expect(settleServerAddress("http://localhost:3100/", { target, storage, reload })).toBe(
      "unchanged",
    )
    expect(reload).not.toHaveBeenCalled()
  })

  it("reloads once and never loops on the same origin", () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    expect(settleServerAddress("http://localhost:3100", { target, storage, reload })).toBe(
      "reloaded",
    )
    // The page comes back with no hint published (a webview that refused the
    // mirror), asks the shell again, and settles the same origin again.
    const second: Record<string, unknown> = {}
    expect(settleServerAddress("http://localhost:3100", { target: second, storage, reload })).toBe(
      "unchanged",
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("forgets the marker once the page comes back on that address", () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    settleServerAddress("http://localhost:3100", { target, storage, reload })
    expect(storage.values[ADDRESS_RELOAD_MARKER_KEY]).toBe("http://localhost:3100")
    const booted: Record<string, unknown> = {}
    publishMirroredServerAddress(booted, storage)
    settleServerAddress("http://localhost:3100", { target: booted, storage, reload })
    expect(ADDRESS_RELOAD_MARKER_KEY in storage.values).toBe(false)
  })

  it("publishes nothing and reloads nothing for an address it will not take", () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    expect(settleServerAddress("not-a-url", { target, storage, reload })).toBe("ignored")
    expect(SERVER_ADDRESS_GLOBAL in target).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
