// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T05 (S18, L27, P2-D5): the owner's nodes stay live. A `kernel:node`
// presence frame flips `online` at once, then a debounced refetch reads
// GET /nodes/me; any other change refetches; a resync refetches; signing out
// forgets everything.
import { afterEach, describe, expect, it, vi } from "vitest"
import { requestResync } from "~/framework/resync"
import { startSession, teardownSession } from "~/lib/session-lifecycle"
import type { NodeSummary } from "./node-api"
import {
  applyNodeFrame,
  availableNodes,
  hasEnabledNode,
  installNodesStoreSync,
  loadNodes,
  modelsFor,
  nodeForRun,
  nodeOnline,
  nodes,
  nodesSocketConnected,
  nodesStatus,
  onNodeChange,
  resetNodesStore,
  setNodesStoreApi,
  sharedFolderNames,
} from "./nodes-store"

function node(over: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id: "n1",
    name: "Studio Mac",
    enabled: true,
    online: false,
    lastSeenAt: null,
    os: "macos",
    appVersion: "0.1.20",
    deviceId: "d1",
    queue: { queued: 0, running: 0 },
    sharedFolderNames: ["code"],
    models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
    levelPins: [],
    ...over,
  }
}

function serving(initial: NodeSummary[]) {
  let current = initial
  const get = vi.fn(async (path: string) => {
    if (path === "/nodes/me") return { nodes: current }
    throw new Error(`unexpected GET ${path}`)
  })
  setNodesStoreApi(() => ({ get }) as never)
  return {
    get,
    set(next: NodeSummary[]) {
      current = next
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  resetNodesStore()
  setNodesStoreApi(() => null)
})

describe("the live nodes store (S18)", () => {
  it("never offers a demo's recorded computer (a simulated node) to run on", async () => {
    serving([
      node({ online: true }),
      node({
        id: "sim",
        deviceId: "d-sim",
        name: "Recorded computer",
        online: true,
        simulated: true,
      }),
    ])
    await loadNodes()
    expect(availableNodes().map((n) => n.id)).toEqual(["n1"])
    // A run that names no node falls back to the one real enabled node.
    expect(nodeForRun(null)?.id).toBe("n1")
    // A run that names the simulated node still finds it (its replay card).
    expect(nodeForRun("sim")?.simulated).toBe(true)
  })

  it("a presence frame flips online without waiting for the refetch", async () => {
    vi.useFakeTimers()
    const api = serving([node({ online: false })])
    await loadNodes()
    expect(nodeOnline("n1")).toBe(false)
    expect(api.get).toHaveBeenCalledTimes(1)

    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "presence", online: true })
    // At once, before any read.
    expect(nodeOnline("n1")).toBe(true)
    expect(api.get).toHaveBeenCalledTimes(1)

    // Then one debounced refetch for a burst of frames.
    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "presence", online: true })
    api.set([node({ online: true })])
    await vi.advanceTimersByTimeAsync(300)
    expect(api.get).toHaveBeenCalledTimes(2)
    expect(nodeOnline("n1")).toBe(true)
  })

  it("a capabilities frame refetches and sharedFolderNames updates", async () => {
    vi.useFakeTimers()
    const api = serving([node(), node({ id: "n2", deviceId: "d2", sharedFolderNames: ["code"] })])
    await loadNodes()
    expect(sharedFolderNames()).toEqual(["code"])
    api.set([
      node({ sharedFolderNames: ["code", "notes"] }),
      node({ id: "n2", deviceId: "d2", sharedFolderNames: ["code"] }),
    ])
    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "capabilities" })
    await vi.advanceTimersByTimeAsync(300)
    expect(sharedFolderNames()).toEqual(["code", "notes"])
    expect(modelsFor("n1").map((m) => m.id)).toEqual(["claude-haiku-4-5"])
    expect(modelsFor().map((m) => m.id)).toEqual(["claude-haiku-4-5"])
  })

  it("hasEnabledNode turns true when an enable frame arrives, with no reload (L27)", async () => {
    vi.useFakeTimers()
    const api = serving([])
    await loadNodes()
    expect(hasEnabledNode()).toBe(false)
    api.set([node()])
    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "node" })
    await vi.advanceTimersByTimeAsync(300)
    expect(hasEnabledNode()).toBe(true)
  })

  it("onNodeChange hears every frame; a malformed frame is ignored", async () => {
    vi.useFakeTimers()
    serving([node()])
    await loadNodes()
    const heard: string[] = []
    const off = onNodeChange((f) => heard.push(f.change))
    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "profile" })
    applyNodeFrame({ ownerUserId: "me", change: "attachment" })
    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "rename-everything" })
    off()
    applyNodeFrame({ ownerUserId: "me", nodeId: "n1", change: "attachment" })
    expect(heard).toEqual(["profile"])
  })

  it("a resync refetches", async () => {
    const api = serving([node()])
    installNodesStoreSync()
    await loadNodes()
    expect(api.get).toHaveBeenCalledTimes(1)
    api.set([node({ name: "Office" })])
    requestResync("ws-reconnect")
    await vi.waitFor(() => expect(nodes()[0]?.name).toBe("Office"))
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("the socket's first connect reads the computers again", async () => {
    const api = serving([])
    await loadNodes()
    expect(nodes()).toHaveLength(0)
    // The demo's recorded laptop, created (and its frame sent) before the socket was up.
    api.set([node({ name: "Demo laptop (recorded)" })])
    nodesSocketConnected()
    await vi.waitFor(() => expect(nodes()[0]?.name).toBe("Demo laptop (recorded)"))
    expect(api.get).toHaveBeenCalledTimes(2)
  })

  it("a failed first load is the error state, and the next load tries again", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ nodes: [node()] })
    setNodesStoreApi(() => ({ get }) as never)
    await loadNodes()
    expect(nodesStatus()).toBe("error")
    await loadNodes()
    expect(nodesStatus()).toBe("ready")
    expect(nodes()).toHaveLength(1)
  })

  it("signing out forgets every node", async () => {
    serving([node()])
    await loadNodes()
    expect(nodes()).toHaveLength(1)
    resetNodesStore()
    expect(nodes()).toEqual([])
    expect(hasEnabledNode()).toBe(false)
  })

  it("signing in again (no page reload) reads the nodes again (m4)", async () => {
    const api = serving([node()])
    await loadNodes()
    teardownSession()
    expect(nodes()).toEqual([])
    // The next account signs in: the API getter answers again, no reload.
    api.set([node({ id: "n2", name: "Laptop" })])
    startSession()
    await vi.waitFor(() => expect(nodes().map((n) => n.id)).toEqual(["n2"]))
    expect(nodesStatus()).toBe("ready")
  })
})
