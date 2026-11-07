// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A suspended org's live socket (S26): the server closes it with 4004, which
// carries no details; one ticket request follows, its 403 `org_suspended` body
// puts the page on the suspended view, and nothing reconnects after that.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const UNTIL = new Date(Date.now() + 20 * 86_400_000).toISOString()
const CONTACT = "billing@contact.example"

function suspended(): Response {
  return new Response(
    JSON.stringify({ error: { code: "org_suspended", accessUntil: UNTIL, contact: CONTACT } }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("the websocket", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("a 4004 close asks for one ticket; its 403 lands on the suspended page and nothing reconnects", async () => {
    const sockets: {
      readyState: number
      onclose: ((e: CloseEvent) => void) | null
      onopen: (() => void) | null
    }[] = []
    vi.stubGlobal(
      "WebSocket",
      class {
        static CONNECTING = 0
        static OPEN = 1
        static CLOSING = 2
        static CLOSED = 3
        readyState = 0
        onopen: (() => void) | null = null
        onclose: ((e: CloseEvent) => void) | null = null
        onmessage = null
        onerror = null
        constructor() {
          sockets.push(this)
        }
        send() {}
        close() {}
      },
    )
    vi.stubGlobal("navigator", { onLine: true })
    let tickets = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        tickets++
        if (tickets === 1) {
          return new Response(JSON.stringify({ data: { ticket: "t1" } }), { status: 200 })
        }
        return suspended()
      }),
    )
    const { createWebSocket } = await import("~/primitives/createWebSocket")
    const mod = await import("~/lib/org-suspended")
    const ws = createWebSocket({ getToken: () => "tok" })
    ws.connect()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    sockets[0].readyState = 1
    sockets[0].onopen?.()
    sockets[0].onclose?.(new CloseEvent("close", { code: 4004, reason: "org_suspended" }))
    await vi.waitFor(() => expect(tickets).toBe(2))
    await vi.waitFor(() => expect(mod.orgSuspended()).toBe(true))
    expect(mod.orgSuspension()).toEqual({ accessUntil: UNTIL, contact: CONTACT })
    await new Promise((r) => setTimeout(r, 50))
    expect(tickets).toBe(2)
    expect(sockets).toHaveLength(1)
    ws.disconnect()
  })
})
