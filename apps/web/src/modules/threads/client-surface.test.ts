// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY AGENT MESSAGE NAMES THE SURFACE IT WAS SENT FROM.
//
// A turn the server runs has no shell on the person's computer. When a task
// needs one, the agent sends the person to computer mode, and the steps differ
// by surface: a browser or the phone gets the desktop app first, the desktop
// app switches its runtime to "This machine". Without the surface on the wire
// the agent cannot tell which, so the send path always says it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { resetLocalTurnMessages } from "~/modules/desktop/desktop-store"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { currentClientSurface } from "~/modules/threads/client-surface"
import { resetMessageStore, sendMessage } from "~/modules/threads/message-store"
import { resetThreadStore } from "~/modules/threads/thread-store"

const THREAD = "t-surface"
const USER = { id: "u-me", name: "Me" }

function recordingApi() {
  const bodies: Array<Record<string, unknown>> = []
  return {
    bodies,
    api: {
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        bodies.push(body)
        return { data: null }
      }),
    },
  }
}

describe("the surface an agent message is sent from", () => {
  beforeEach(() => {
    resetMessageStore()
    resetThreadStore()
    resetLocalTurnMessages()
  })

  afterEach(() => {
    uninstallFakeBridge()
    delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  })

  it("is web in a plain browser, and the message says so", async () => {
    expect(currentClientSurface()).toBe("web")
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, THREAD, "make the report", USER)
    expect(bodies[0]).toMatchObject({ clientSurface: "web" })
  })

  it("is desktop inside the desktop shell, even while turns run on Liaison", async () => {
    installFakeBridge({ runtimeLocation: "liaison" })
    expect(currentClientSurface()).toBe("desktop")
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, THREAD, "make the report", USER)
    expect(bodies[0]).toMatchObject({ clientSurface: "desktop" })
  })

  it("is mobile inside the mobile shell", async () => {
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {}
    expect(currentClientSurface()).toBe("mobile")
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, THREAD, "make the report", USER)
    expect(bodies[0]).toMatchObject({ clientSurface: "mobile" })
  })
})
