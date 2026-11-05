// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Walk N13: the desktop app kept presenting a node removed in Settings > Nodes
// on another device, and asked at start to launch jobs it could no longer
// claim (401). At start the session is checked against the server.
import { afterEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import {
  NodeSessionTestAccess,
  nodeCredentialForHello,
  restoreNodeSession,
  verifyNodeSession,
} from "./node-session"

const SERVER = "https://demo.liaison.example"

function setup(stored: unknown) {
  ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = SERVER
  const stores: unknown[] = []
  const handle = installFakeBridge({})
  Object.assign(handle.bridge, {
    loadNodeCredential: async () => stored,
    storeNodeCredential: async (_s: string, node: unknown) => {
      stores.push(node)
    },
  })
  return stores
}

afterEach(() => {
  NodeSessionTestAccess.reset()
  uninstallFakeBridge()
})

describe("verifyNodeSession", () => {
  it("drops a node the server no longer has", async () => {
    const stores = setup({ nodeId: "n-1", credential: "lnn_1", enabled: true })
    await restoreNodeSession()
    expect(nodeCredentialForHello()).toBe("lnn_1")
    const api = { get: vi.fn(async () => ({ nodes: [] })) } as never
    expect(await verifyNodeSession(api)).toBeNull()
    expect(nodeCredentialForHello()).toBeNull()
    expect(stores).toEqual([null])
  })

  it("keeps it when the server lists it, or cannot be asked", async () => {
    const stores = setup({ nodeId: "n-1", credential: "lnn_1", enabled: true })
    await restoreNodeSession()
    await verifyNodeSession({ get: vi.fn(async () => ({ nodes: [{ id: "n-1" }] })) } as never)
    await verifyNodeSession({
      get: vi.fn(async () => {
        throw new Error("offline")
      }),
    } as never)
    expect(nodeCredentialForHello()).toBe("lnn_1")
    expect(stores).toEqual([])
  })
})
