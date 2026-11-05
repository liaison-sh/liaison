// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cold start case, which is the one that actually breaks: the app is NOT
// running, the user taps a push, and the operating system delivers the URL as
// part of launching the process. Everything downstream (the web app's router,
// the view that renders the thread) exists milliseconds later. A link handled
// where it arrives is handled into nothing.
//
// Warm navigation is deep-link.test.ts. What is pinned here is the ORDER: a
// link that arrives before the app is ready is still delivered, exactly once,
// after it is ready, in the order the links arrived, and it is delivered
// through the boot wiring rather than through a queue a test built by hand.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createDeepLinkQueue } from "./deep-link"
import { startBoot } from "./main"

/** A native listener that can be fired at any point in the boot sequence. */
function fakeNative() {
  let handler: ((url: string) => void) | null = null
  return {
    addUrlListener: (cb: (url: string) => void) => {
      handler = cb
    },
    open: (url: string) => {
      if (!handler) throw new Error("no listener was subscribed yet")
      handler(url)
    },
  }
}

describe("cold start deep link", () => {
  it("delivers a link that arrived before the app was ready, exactly once", async () => {
    const seen: string[] = []
    const native = fakeNative()
    const queue = createDeepLinkQueue((routePath) => seen.push(routePath))
    let signalReady = () => {}

    await startBoot({
      queue,
      addUrlListener: native.addUrlListener,
      whenAppReady: (cb) => {
        signalReady = cb
      },
    })

    // The OS hands over the URL while the web app is still booting.
    native.open("liaison://thread/coldstart1")
    expect(seen).toEqual([])
    expect(queue.pending()).toEqual(["/threads/coldstart1"])

    signalReady()
    expect(seen).toEqual(["/threads/coldstart1"])

    // A second ready signal (a re-entrant boot, a re-mounted app) must not
    // replay the link.
    signalReady()
    expect(seen).toEqual(["/threads/coldstart1"])
  })

  it("delivers a session link taken before ready once, after markAppReady", async () => {
    const seen: string[] = []
    const native = fakeNative()
    const queue = createDeepLinkQueue((routePath) => seen.push(routePath))
    let signalReady = () => {}

    await startBoot({
      queue,
      addUrlListener: native.addUrlListener,
      whenAppReady: (cb) => {
        signalReady = cb
      },
    })

    native.open("liaison://session/coldsession1")
    expect(seen).toEqual([])
    expect(queue.pending()).toEqual(["/sessions/coldsession1"])

    signalReady()
    signalReady()
    expect(seen).toEqual(["/sessions/coldsession1"])
  })

  it("keeps the order of several links taken during launch", async () => {
    const seen: string[] = []
    const native = fakeNative()
    const queue = createDeepLinkQueue((routePath) => seen.push(routePath))
    let signalReady = () => {}
    await startBoot({
      queue,
      addUrlListener: native.addUrlListener,
      whenAppReady: (cb) => {
        signalReady = cb
      },
    })
    native.open("liaison://thread/first")
    native.open("liaison://thread/second")
    signalReady()
    expect(seen).toEqual(["/threads/first", "/threads/second"])
  })

  it("offers a connect link to first launch instead of routing it", async () => {
    // `liaison://connect?server=...` repoints the whole install. It is never a
    // navigation: it goes to the first launch flow, which shows it and waits
    // for a click.
    const routed: string[] = []
    const offered: string[] = []
    const native = fakeNative()
    await startBoot({
      queue: createDeepLinkQueue((routePath) => routed.push(routePath)),
      addUrlListener: native.addUrlListener,
      whenAppReady: (cb) => cb(),
      firstLaunch: {
        start: async () => "https://acme.example.com",
        boundAddress: async () => null,
        offerAddress: (address) => offered.push(address),
      },
    })
    native.open("liaison://connect?server=https://acme.example.com")
    expect(offered).toEqual(["https://acme.example.com"])
    expect(routed).toEqual([])
  })

  it("subscribes the native listener before it waits for the app", async () => {
    // The regression in one assertion: if the subscription happened after the
    // app-ready wiring, the first link of a cold start would land on nothing.
    const order: string[] = []
    await startBoot({
      queue: createDeepLinkQueue(() => {}),
      addUrlListener: () => order.push("subscribed"),
      whenAppReady: () => order.push("waiting for ready"),
    })
    expect(order).toEqual(["subscribed", "waiting for ready"])
  })

  it("boot-entry installs the native shelf before startBoot, with no await gating either", () => {
    // boot-entry.ts is the file that actually wires the real Capacitor
    // listener: it installs the native shelf (member-visibility ordering,
    // unrelated to deep links) and THEN calls startBoot, which is where
    // addUrlListener is subscribed (pinned above). Regardless of what the
    // shelf install does, an `await` inserted before either call -- or
    // between them -- would let a link delivered at cold start arrive before
    // anything is listening for it.
    const source = readFileSync(path.join(import.meta.dir, "boot-entry.ts"), "utf8")
    const body = source.slice(source.indexOf("if (typeof document"))
    const shelfIdx = body.indexOf("installNativeShelf(")
    const startBootIdx = body.indexOf("startBoot(")
    expect(shelfIdx).toBeGreaterThan(-1)
    expect(startBootIdx).toBeGreaterThan(shelfIdx)
    expect(body.slice(0, startBootIdx)).not.toContain("await ")
  })
})
