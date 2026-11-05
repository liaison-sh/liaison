// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T05: one reactive source for desktop state, so no component reaches for
// the window itself.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DESKTOP_BRIDGE_EVENT,
  DESKTOP_BRIDGE_KEY,
  DESKTOP_BRIDGE_VERSION,
  type DesktopBridge,
  type DesktopSessionState,
  emptyDesktopSessionState,
} from "~/lib/desktop-shell-contract"
import { sendMessage } from "~/modules/threads/message-store"
import {
  attachDesktopBridge,
  chooseFolder,
  desktopServers,
  desktopState,
  isDesktop,
  localSessionFor,
  resetDesktopStore,
} from "./desktop-store"

interface FakeBridge {
  bridge: DesktopBridge
  push: (state: DesktopSessionState) => void
  calls: string[]
}

function installFakeBridge(initial?: Partial<DesktopSessionState>): FakeBridge {
  const calls: string[] = []
  let snapshot: DesktopSessionState = { ...emptyDesktopSessionState(), ...initial }
  const listeners = new Set<(state: DesktopSessionState) => void>()
  const bridge = {
    version: DESKTOP_BRIDGE_VERSION,
    platform: "macos",
    pickFolder: async () => {
      calls.push("pickFolder")
      return "/Users/someone/work/tessera-monorepo"
    },
    getServerAddress: () => null,
    setServerAddress: async () => {
      calls.push("setServerAddress")
    },
    startSession: async () => {
      calls.push("startSession")
      return true
    },
    stopSession: async () => {
      calls.push("stopSession")
    },
    sendTurn: async () => {
      calls.push("sendTurn")
    },
    interruptTurn: async () => {
      calls.push("interruptTurn")
    },
    respondToPermission: async () => {
      calls.push("respondToPermission")
    },
    readLocalFile: async () => null,
    setPermissionMode: () => {
      calls.push("setPermissionMode")
    },
    setRuntimeLocation: () => {
      calls.push("setRuntimeLocation")
    },
    getState: () => snapshot,
    subscribe: (listener: (state: DesktopSessionState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as DesktopBridge
  vi.stubGlobal(DESKTOP_BRIDGE_KEY, bridge)
  attachDesktopBridge()
  return {
    bridge,
    calls,
    push: (state: DesktopSessionState) => {
      snapshot = state
      for (const listener of listeners) listener(state)
    },
  }
}

describe("desktop-store (P6d-T05)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetDesktopStore()
  })

  it("isDesktop is false with no bridge on the window", () => {
    resetDesktopStore()
    expect(isDesktop()).toBe(false)
    expect(desktopState().sessionStatus).toBe("idle")
  })

  it("desktopState follows the bridge subscription", () => {
    const fake = installFakeBridge({ folderPath: "/one" })
    expect(isDesktop()).toBe(true)
    expect(desktopState().folderPath).toBe("/one")

    fake.push({ ...emptyDesktopSessionState(), folderPath: "/two" })
    fake.push({
      ...emptyDesktopSessionState(),
      folderPath: "/three",
      sessionStatus: "running",
      threadId: "t1",
      agentId: "a1",
    })

    expect(desktopState().folderPath).toBe("/three")
    expect(localSessionFor("t1", "a1")).toBe(true)
    expect(localSessionFor("t2", "a1")).toBe(false)
  })

  // P6d-FX3, W1. THE STORE USED TO RESOLVE THE BRIDGE EXACTLY ONCE, at module
  // load, and the only thing that resolved it again was the sign-out teardown.
  // A shell that published the bridge one tick late therefore left this window
  // answering false for its whole life, and every desktop surface was invisible
  // until the user signed out and back in. The shell announces the publication
  // now and this store listens: a store that loaded FIRST still ends up
  // attached.
  it("attaches when the shell announces a bridge published after this module loaded", () => {
    resetDesktopStore()
    expect(isDesktop()).toBe(false)

    const late = {
      version: DESKTOP_BRIDGE_VERSION,
      platform: "macos",
      getState: () => ({ ...emptyDesktopSessionState(), folderPath: "/late" }),
      subscribe: () => () => undefined,
    } as unknown as DesktopBridge
    vi.stubGlobal(DESKTOP_BRIDGE_KEY, late)
    // Still false: the object being there is not what the store heard.
    expect(isDesktop()).toBe(false)

    globalThis.dispatchEvent(new Event(DESKTOP_BRIDGE_EVENT))

    expect(isDesktop()).toBe(true)
    expect(desktopState().folderPath).toBe("/late")
  })

  it("actions are inert with no bridge", async () => {
    resetDesktopStore()
    await expect(chooseFolder()).resolves.toBe(false)
    expect(desktopState().folderPath).toBeNull()
  })
})

/**
 * A LOCAL SESSION CLAIMS ONE CONVERSATION (A32), and it captures nothing from
 * any other. A send from a thread the session is not bound to goes to THAT
 * thread and starts no local turn: the shell is never told about it, so the
 * turn runs on the server where every other conversation's turn runs.
 *
 * Pinned here after a QA round reported a send landing in the live session's
 * conversation instead of the composer's.
 */
describe("a live local session and a send from another conversation", () => {
  const THREAD_A = "11111111-1111-4111-8111-111111111111"
  const THREAD_B = "22222222-2222-4222-8222-222222222222"

  it("posts to the composer's own thread and asks the shell for nothing", async () => {
    const turns: string[] = []
    const snapshot: DesktopSessionState = {
      ...emptyDesktopSessionState(),
      sessionStatus: "running",
      threadId: THREAD_A,
      agentId: "agent-a",
    }
    const bridge = {
      version: DESKTOP_BRIDGE_VERSION,
      platform: "macos",
      sendTurn: async (messageId: string) => {
        turns.push(messageId)
      },
      getState: () => snapshot,
      subscribe: () => () => undefined,
    } as unknown as DesktopBridge
    vi.stubGlobal(DESKTOP_BRIDGE_KEY, bridge)
    attachDesktopBridge()
    expect(localSessionFor(THREAD_A, "agent-a")).toBe(true)
    expect(localSessionFor(THREAD_B, "agent-a")).toBe(false)

    const posted: string[] = []
    const api = {
      post: async (path: string, body: unknown) => {
        posted.push(path)
        return {
          data: {
            id: "message-in-b",
            threadId: THREAD_B,
            content: (body as { content: string }).content,
            authorType: "user",
          },
        }
      },
    }
    await sendMessage(api, THREAD_B, "how is the desk today", { id: "u1", name: "QA" })

    expect(posted).toEqual([`/threads/${THREAD_B}/messages`])
    expect(turns).toEqual([])
  })
})

describe("the desktop's sign out", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    resetDesktopStore()
  })

  it("runs the page's before-sign-out work before the shell signs out", async () => {
    const { onBeforeSignOut } = await import("~/lib/session-lifecycle")
    const order: string[] = []
    const dispose = onBeforeSignOut(async () => {
      order.push("before")
    })
    const fake = installFakeBridge()
    ;(fake.bridge as unknown as { servers: unknown }).servers = {
      list: vi.fn(),
      add: vi.fn(),
      switchTo: vi.fn(),
      remove: vi.fn(),
      signOut: vi.fn(async () => {
        order.push("shell")
      }),
    }
    try {
      await desktopServers()?.signOut()
      expect(order).toEqual(["before", "shell"])
    } finally {
      dispose()
    }
  })
})
