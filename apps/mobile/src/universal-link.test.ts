// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app claims no https links (D8): no associated domain, no Android app
// link, and the deep link parser routes none either, not even one on the
// server this install talks to. `liaison://` is the only way in
// (deep-link.test.ts covers that half).
import { afterEach, describe, expect, it } from "bun:test"
import { SERVER_ADDRESS_GLOBAL } from "./boot/server-global"
import * as deepLink from "./deep-link"
import { createDeepLinkQueue, parseDeepLink } from "./deep-link"

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
})

describe("https links are not routed", () => {
  it("ignores a thread link on the server this install talks to", () => {
    ;(globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = "https://acme.example.com"
    expect(parseDeepLink("https://acme.example.com/threads/xyz")).toBeNull()
  })

  it("ignores a thread link on any other host", () => {
    expect(parseDeepLink("https://liaison.example.com/threads/abc123")).toBeNull()
    expect(parseDeepLink("https://evil.example/threads/abc123")).toBeNull()
  })

  it("never queues an https link, before or after the app is ready", () => {
    ;(globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = "https://acme.example.com"
    const routed: string[] = []
    const queue = createDeepLinkQueue((route) => routed.push(route))
    queue.onAppUrlOpen("https://acme.example.com/threads/abc123")
    expect(queue.pending()).toEqual([])
    queue.markAppReady()
    queue.onAppUrlOpen("https://acme.example.com/threads/abc123")
    expect(routed).toEqual([])
  })

  it("keeps no universal link origin to route against", () => {
    const exported = deepLink as Record<string, unknown>
    expect(exported.UNIVERSAL_LINK_ORIGIN).toBeUndefined()
    expect(exported.isRoutableLinkOrigin).toBeUndefined()
  })

  it("leaves the custom scheme working exactly as before", () => {
    expect(parseDeepLink("liaison://thread/abc123")).toBe("/threads/abc123")
    expect(parseDeepLink("liaison://connect?server=https://acme.example.com")).toBeNull()
  })
})
