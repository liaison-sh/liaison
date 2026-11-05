// SPDX-License-Identifier: FSL-1.1-ALv2
// Unit coverage for the reconnect-transition -> requestResync wiring (A2) that
// Shell.tsx installs via installReconnectResync(ws.status). Drives the REAL
// exported primitive from ~/framework/resync (not a hand-copied effect).
import { createRoot, createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { installReconnectResync, resyncVersion, type WsStatus } from "~/framework/resync"

async function tick() {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe("installReconnectResync (real Shell wiring)", () => {
  it("initial connecting->connected edge does NOT bump (seeded tracker)", async () => {
    await createRoot(async (dispose) => {
      const [status, setStatus] = createSignal<WsStatus>("connecting")
      const before = resyncVersion()
      installReconnectResync(status)
      await tick()
      setStatus("connected")
      await tick()
      // The tracker was seeded at "connecting"; connecting->connected is NOT a
      // reconnect edge, so no bump.
      expect(resyncVersion()).toBe(before)
      dispose()
    })
  })

  it("disconnected->connected bumps exactly once", async () => {
    await createRoot(async (dispose) => {
      const [status, setStatus] = createSignal<WsStatus>("connected")
      installReconnectResync(status)
      await tick()
      const before = resyncVersion()
      setStatus("disconnected")
      await tick()
      setStatus("connected")
      await tick()
      expect(resyncVersion()).toBe(before + 1)
      dispose()
    })
  })

  it("reconnecting->connected bumps once", async () => {
    await createRoot(async (dispose) => {
      const [status, setStatus] = createSignal<WsStatus>("reconnecting")
      installReconnectResync(status)
      await tick()
      const before = resyncVersion()
      setStatus("connected")
      await tick()
      expect(resyncVersion()).toBe(before + 1)
      dispose()
    })
  })

  it("the socket's real reconnect (connected, reconnecting, connecting, connected) bumps once", async () => {
    await createRoot(async (dispose) => {
      const [status, setStatus] = createSignal<WsStatus>("connected")
      installReconnectResync(status)
      await tick()
      const before = resyncVersion()
      for (const next of ["disconnected", "reconnecting", "connecting", "connected"] as const) {
        setStatus(next)
        await tick()
      }
      expect(resyncVersion()).toBe(before + 1)
      // A failed attempt in between (connecting, reconnecting, connecting) still bumps once.
      for (const next of [
        "reconnecting",
        "connecting",
        "reconnecting",
        "connecting",
        "connected",
      ] as const) {
        setStatus(next)
        await tick()
      }
      expect(resyncVersion()).toBe(before + 2)
      dispose()
    })
  })
})
