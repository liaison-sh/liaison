// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Final walk F3: after a reload, a deep link or a fresh sign-in the owner's
// nodes must load without opening New. The session starts BEFORE the live API
// client is registered (startup's hydration registers it), so the store's own
// session-start read found no client and nothing read the nodes again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  } as any
})

import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { resetAppIndex } from "~/framework/define-app"
import { startSession, teardownSession } from "~/lib/session-lifecycle"
import { setAttentionApi } from "~/modules/shell/attention-store"
import { nodes, resetNodesStore } from "./nodes-store"

const NODE = {
  id: "n1",
  name: "Mac",
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: "0.1.20",
  deviceId: "d1",
  queue: { queued: 0, running: 0 },
  sharedFolderNames: ["code"],
  models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
  levelPins: [],
}

function client() {
  const get = vi.fn(async (path: string) => (path === "/nodes/me" ? { nodes: [NODE] } : {}))
  return { get, client: { get } as never }
}

const nodeReads = (get: ReturnType<typeof vi.fn>) =>
  get.mock.calls.filter(([p]) => p === "/nodes/me").length

beforeEach(() => {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  ) as unknown as typeof fetch
  setAttentionApi(null)
  resetNodesStore()
  resetRegistry()
  resetAppIndex()
  resetBootstrap()
})

afterEach(() => {
  setAttentionApi(null)
  resetNodesStore()
})

describe("the owner's nodes load at boot and at sign-in (F3)", () => {
  it("a reload: the session starts before the client exists, the nodes load once it does", async () => {
    bootstrapKernelApps()
    startSession()
    const { get, client: api } = client()
    setAttentionApi(api)
    await vi.waitFor(() => expect(nodes().map((n) => n.id)).toEqual(["n1"]))
    // Idempotent: the shell registering its own client reads nothing again.
    setAttentionApi(api)
    expect(nodeReads(get)).toBe(1)
  })

  it("a sign-out then a sign-in on the same page reads the nodes again", async () => {
    bootstrapKernelApps()
    const first = client()
    setAttentionApi(first.client)
    await vi.waitFor(() => expect(nodes()).toHaveLength(1))
    teardownSession()
    setAttentionApi(null)
    expect(nodes()).toHaveLength(0)
    startSession()
    const second = client()
    setAttentionApi(second.client)
    await vi.waitFor(() => expect(nodeReads(second.get)).toBe(1))
    await vi.waitFor(() => expect(nodes()).toHaveLength(1))
  })
})
