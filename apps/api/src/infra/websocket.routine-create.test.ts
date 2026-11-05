// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A new routine (`kernel/routine:create`) names its owner, its creator and its
// template. A personal routine is its owner's business: on every delivery path
// (broadcast, bufferAndBroadcast, hello replay) its frame reaches the owner's
// and the creator's sockets only, never another member who can read routines,
// not even an org admin holding `*`. A shared routine's frame reaches every
// routines reader. A create frame that says no visibility is treated as
// personal (fail closed).
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

function created(visibility: "personal" | "shared" | undefined) {
  return {
    app: "kernel",
    entity: "routine",
    action: "create",
    entityId: "r1",
    orgId: "org-1",
    data: {
      id: "r1",
      routineId: "r1",
      kind: "recurring",
      ...(visibility ? { visibility } : {}),
      ownerUserId: "owner",
      createdByUserId: "creator",
      templateKey: "morning-brief",
    },
  }
}

const socket = () => ({ send: mock(() => {}), readyState: 1 }) as any

describe("kernel/routine:create frames", () => {
  let manager: WebSocketManager

  beforeEach(() => {
    _store.clear()
    _sets.clear()
    manager = new WebSocketManager(mockRedis as any)
    mockRedis.zrangebyscore.mockClear()
  })

  it("a personal routine reaches its owner and its creator, not another member or an admin", async () => {
    const owner = socket()
    const creator = socket()
    const member = socket()
    const admin = socket()
    manager.addConnection("owner", owner, ["kernel:routines:read"], "org-1")
    manager.addConnection("creator", creator, ["kernel:routines:read"], "org-1")
    manager.addConnection("member", member, ["kernel:routines:read"], "org-1")
    manager.addConnection("admin", admin, ["*"], "org-1")
    await manager.broadcast(created("personal"))
    await manager.bufferAndBroadcast(created("personal"))
    expect(owner.send).toHaveBeenCalledTimes(2)
    expect(creator.send).toHaveBeenCalledTimes(2)
    expect(member.send).not.toHaveBeenCalled()
    expect(admin.send).not.toHaveBeenCalled()
  })

  it("a create frame without a visibility is personal (fail closed)", async () => {
    const owner = socket()
    const member = socket()
    manager.addConnection("owner", owner, ["kernel:routines:read"], "org-1")
    manager.addConnection("member", member, ["kernel:routines:read"], "org-1")
    await manager.bufferAndBroadcast(created(undefined))
    expect(owner.send).toHaveBeenCalledTimes(1)
    expect(member.send).not.toHaveBeenCalled()
  })

  it("a shared routine reaches every routines reader", async () => {
    const member = socket()
    manager.addConnection("member", member, ["kernel:routines:read"], "org-1")
    await manager.bufferAndBroadcast(created("shared"))
    expect(member.send).toHaveBeenCalledTimes(1)
  })

  it("hello replay sends another member nothing for a personal routine", async () => {
    mockRedis.zrangebyscore.mockResolvedValueOnce([
      JSON.stringify({ type: "event", eventId: 1, payload: created("personal") }),
      JSON.stringify({ type: "event", eventId: 2, payload: created("shared") }),
    ])
    const member = socket()
    manager.addConnection("member", member, ["kernel:routines:read"], "org-1")
    await manager.handleHello(member, "member", 1, ["kernel:routines:read"], "org-1")
    expect(member.send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(member.send.mock.calls[0][0] as string).eventId).toBe(2)
  })
})
