// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createConnectivity, type NetworkPlugin, type NetworkStatus } from "./network"

interface FakeNetwork {
  plugin: NetworkPlugin
  emit: (connected: boolean) => void
  listeners: () => number
  settleSubscribe: () => Promise<void>
}

function fakeNetwork(status = true, opts: { deferSubscribe?: boolean } = {}): FakeNetwork {
  let handler: ((s: NetworkStatus) => void) | null = null
  let release: (() => void) | null = null
  let removed = false
  const plugin: NetworkPlugin = {
    getStatus: async () => ({ connected: status }),
    addListener: async (_event, h) => {
      handler = h
      if (opts.deferSubscribe) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return {
        remove: async () => {
          removed = true
          handler = null
        },
      }
    },
  }
  return {
    plugin,
    emit: (connected) => handler?.({ connected }),
    listeners: () => (handler !== null && !removed ? 1 : 0),
    settleSubscribe: async () => {
      release?.()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe("connectivity from the platform", () => {
  it("reports the status the platform holds", async () => {
    await expect(createConnectivity(fakeNetwork(true).plugin).isOnline()).resolves.toBe(true)
    await expect(createConnectivity(fakeNetwork(false).plugin).isOnline()).resolves.toBe(false)
  })

  it("treats an unanswerable status as online, never as a banner", async () => {
    const plugin: NetworkPlugin = {
      getStatus: async () => {
        throw new Error("no network plugin here")
      },
      addListener: async () => ({ remove: async () => {} }),
    }
    await expect(createConnectivity(plugin).isOnline()).resolves.toBe(true)
  })

  it("delivers every change to the subscriber", async () => {
    const net = fakeNetwork()
    const seen: boolean[] = []
    createConnectivity(net.plugin).onConnectivity((online) => seen.push(online))
    await Promise.resolve()
    net.emit(false)
    net.emit(true)
    expect(seen).toEqual([false, true])
  })

  it("stops delivering once unsubscribed", async () => {
    const net = fakeNetwork()
    const seen: boolean[] = []
    const off = createConnectivity(net.plugin).onConnectivity((online) => seen.push(online))
    await Promise.resolve()
    net.emit(false)
    off()
    net.emit(true)
    expect(seen).toEqual([false])
  })

  it("removes a listener that was still being registered when it was dropped", async () => {
    const net = fakeNetwork(true, { deferSubscribe: true })
    const seen: boolean[] = []
    const off = createConnectivity(net.plugin).onConnectivity((online) => seen.push(online))
    // Torn down BEFORE the native subscribe resolved: what a tier change does.
    off()
    await net.settleSubscribe()
    expect(net.listeners()).toBe(0)
    net.emit(false)
    expect(seen).toEqual([])
  })

  it("returns an unsubscribe even when the platform has no plugin", () => {
    const plugin: NetworkPlugin = {
      getStatus: async () => ({ connected: true }),
      addListener: async () => {
        throw new Error("unimplemented")
      },
    }
    const off = createConnectivity(plugin).onConnectivity(() => {})
    expect(() => off()).not.toThrow()
  })
})
