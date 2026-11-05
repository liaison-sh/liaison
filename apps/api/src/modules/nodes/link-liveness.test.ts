// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk D9: a node socket whose peer went away without a close (Wi-Fi off) is
// cut within its silence deadline, so its sessions pause in seconds rather
// than at Bun's 120 s idle timeout or the session lease's lapse.
import { describe, expect, it } from "bun:test"
import { watchNodeLink } from "./link-liveness"

function fakeSocket() {
  return {
    pings: 0,
    terminated: 0,
    ping() {
      this.pings++
    },
    terminate() {
      this.terminated++
    },
  }
}

describe("node link liveness (walk D9)", () => {
  it("pings while the peer answers, and cuts the socket once it stays silent past the deadline", async () => {
    const ws = fakeSocket()
    let heard = Date.now()
    const stop = watchNodeLink(ws, () => heard, { intervalMs: 10, deadlineMs: 60 })
    const answering = setInterval(() => {
      heard = Date.now()
    }, 5)
    await Bun.sleep(80)
    expect(ws.pings).toBeGreaterThan(3)
    expect(ws.terminated).toBe(0)
    clearInterval(answering)
    await Bun.sleep(120)
    expect(ws.terminated).toBe(1)
    const pings = ws.pings
    await Bun.sleep(40)
    // Cut once, then the watch is over.
    expect(ws.terminated).toBe(1)
    expect(ws.pings).toBe(pings)
    stop()
  })

  it("stop ends the watch", async () => {
    const ws = fakeSocket()
    const stop = watchNodeLink(ws, () => 0, { intervalMs: 10, deadlineMs: 20 })
    stop()
    await Bun.sleep(60)
    expect(ws.terminated).toBe(0)
    expect(ws.pings).toBe(0)
  })

  it("the default deadline is well under Bun's 120 s idle timeout and over the client's 30 s heartbeat", async () => {
    const { NODE_LINK_DEADLINE_MS, NODE_LINK_PING_MS } = await import("./link-liveness")
    expect(NODE_LINK_DEADLINE_MS).toBeGreaterThan(30_000)
    expect(NODE_LINK_DEADLINE_MS).toBeLessThanOrEqual(45_000)
    expect(NODE_LINK_PING_MS * 3).toBeLessThanOrEqual(NODE_LINK_DEADLINE_MS)
  })
})
