// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dashboard change (`kernel/dashboard:created|updated|deleted`) follows the
// row's SELECT policy on every delivery path (broadcast, bufferAndBroadcast,
// hello replay): an org dashboard's frame reaches every dashboards reader, a
// personal one's its owner only, never another member, not even an admin holding
// `*`. A switch from org to personal still reaches the readers who saw it, so
// their lists drop it. A frame that names no visibility reaches only its owner.
import { beforeEach, describe, expect, it, mock } from "bun:test"
import { WebSocketManager } from "~/infra/websocket"

// Tiny in-memory shim for the subset of ioredis the manager and its live state
// actually call, so the manager runs without a live Redis on the test runner
// (`websocket-state/redis.test.ts` runs the live state against the real Redis).
const _store = new Map<string, string>()
const _sets = new Map<string, Set<string>>()
const mockRedis = {
  zadd: mock(() => Promise.resolve()),
  // The replay buffer append (websocket-replay-buffer.ts) is one Lua script.
  eval: mock((..._args: unknown[]) => Promise.resolve(0)),
  zrangebyscore: mock(() => Promise.resolve([] as string[])),
  expire: mock(() => Promise.resolve()),
  incr: mock(() => Promise.resolve(1)),
  exists: mock(() => Promise.resolve(1)),
  set: mock((key: string, value: string) => {
    _store.set(key, value)
    return Promise.resolve("OK")
  }),
  get: mock((key: string) => Promise.resolve(_store.get(key) ?? null)),
  del: mock((...keys: string[]) => {
    let n = 0
    for (const k of keys) {
      if (_store.delete(k)) n++
      if (_sets.delete(k)) n++
    }
    return Promise.resolve(n)
  }),
  sadd: mock((key: string, ...members: string[]) => {
    let set = _sets.get(key)
    if (!set) {
      set = new Set()
      _sets.set(key, set)
    }
    let added = 0
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m)
        added++
      }
    }
    return Promise.resolve(added)
  }),
  srem: mock((key: string, ...members: string[]) => {
    const set = _sets.get(key)
    if (!set) return Promise.resolve(0)
    let removed = 0
    for (const m of members) {
      if (set.delete(m)) removed++
    }
    return Promise.resolve(removed)
  }),
  smembers: mock((key: string) => {
    const set = _sets.get(key)
    return Promise.resolve(set ? Array.from(set) : [])
  }),
  mget: mock(() => Promise.resolve(["online", "away"])),
  scanStream: mock(() => {
    const stream = {
      on: mock((event: string, cb: (...args: any[]) => void) => {
        if (event === "data") cb(["presence:org1:user1", "presence:org1:user2"])
        if (event === "end") setTimeout(() => cb(), 0)
        return stream
      }),
    }
    return stream
  }),
}

type Vis = "personal" | "org"

function frame(action: string, visibility: Vis | undefined, previousVisibility?: Vis) {
  return {
    app: "kernel",
    entity: "dashboard",
    action,
    entityId: "d1",
    orgId: "org-1",
    data: {
      dashboardId: "d1",
      ...(visibility ? { visibility } : {}),
      ...(previousVisibility ? { previousVisibility } : {}),
      ownerUserId: "owner",
      version: 2,
    },
  }
}

const socket = () => ({ send: mock(() => {}), readyState: 1 }) as any
const READ = ["kernel:dashboards:read"]

describe("kernel/dashboard frames", () => {
  let manager: WebSocketManager

  beforeEach(() => {
    _store.clear()
    _sets.clear()
    manager = new WebSocketManager(mockRedis as any)
    mockRedis.zrangebyscore.mockClear()
  })

  it("a personal dashboard's frames reach its owner only, not another member or an admin", async () => {
    const owner = socket()
    const member = socket()
    const admin = socket()
    manager.addConnection("owner", owner, READ, "org-1")
    manager.addConnection("member", member, READ, "org-1")
    manager.addConnection("admin", admin, ["*"], "org-1")
    for (const action of ["created", "updated", "deleted"]) {
      await manager.bufferAndBroadcast(frame(action, "personal"))
    }
    expect(owner.send).toHaveBeenCalledTimes(3)
    expect(member.send).not.toHaveBeenCalled()
    expect(admin.send).not.toHaveBeenCalled()
  })

  it("an org dashboard's frames reach every dashboards reader, and never carry a title", async () => {
    const member = socket()
    const outsider = socket()
    manager.addConnection("member", member, READ, "org-1")
    manager.addConnection("outsider", outsider, ["tickets:tickets:read"], "org-1")
    await manager.bufferAndBroadcast(frame("created", "org"))
    expect(member.send).toHaveBeenCalledTimes(1)
    expect(outsider.send).not.toHaveBeenCalled()
    const sent = JSON.parse(member.send.mock.calls[0][0] as string)
    expect(sent.payload.data.title).toBeUndefined()
  })

  it("a switch from org to personal reaches the members who saw it", async () => {
    const member = socket()
    manager.addConnection("member", member, READ, "org-1")
    await manager.bufferAndBroadcast(frame("updated", "personal", "org"))
    expect(member.send).toHaveBeenCalledTimes(1)
  })

  it("a frame without a visibility reaches only its owner (fail closed)", async () => {
    const owner = socket()
    const member = socket()
    manager.addConnection("owner", owner, READ, "org-1")
    manager.addConnection("member", member, READ, "org-1")
    await manager.broadcast(frame("updated", undefined))
    expect(owner.send).toHaveBeenCalledTimes(1)
    expect(member.send).not.toHaveBeenCalled()
  })

  it("hello replay sends another member nothing for a personal dashboard", async () => {
    mockRedis.zrangebyscore.mockResolvedValueOnce([
      JSON.stringify({ type: "event", eventId: 1, payload: frame("created", "personal") }),
      JSON.stringify({ type: "event", eventId: 2, payload: frame("created", "org") }),
    ])
    const member = socket()
    manager.addConnection("member", member, READ, "org-1")
    await manager.handleHello(member, "member", 1, READ, "org-1")
    expect(member.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(member.send.mock.calls[0][0] as string).eventId).toBe(2)
  })
})
