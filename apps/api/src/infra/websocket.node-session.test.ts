// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Node sessions and their events are the owner's alone (C4, R3, D40): every
// delivery path (broadcast, bufferAndBroadcast, hello replay) sends a
// `kernel:node_session` or `kernel:node_session_event` frame to the sockets of
// `data.ownerUserId` and to nobody else, not even an org admin holding `*`.
// A frame without an owner reaches no one (fail closed).
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

// P3-T21 (G12): the full-output-ready ping is the owner's alone too. A guided
// tour's progress frame (`kernel:tour`, modules/tours) follows the same rule.
const ENTITIES = ["node_session", "node_session_event", "node_session_full_output", "tour"] as const

function frame(entity: (typeof ENTITIES)[number], ownerUserId?: string) {
  return {
    app: "kernel",
    entity,
    action: entity === "node_session" ? "update" : "create",
    entityId: "s1",
    orgId: "org-1",
    data: { ...(ownerUserId ? { ownerUserId } : {}), id: "s1", status: "running" },
  }
}

const socket = () => ({ send: mock(() => {}), readyState: 1 }) as any

describe("node session frames reach their owner only", () => {
  let manager: WebSocketManager

  beforeEach(() => {
    _store.clear()
    _sets.clear()
    manager = new WebSocketManager(mockRedis as any)
    mockRedis.eval.mockClear()
    mockRedis.zrangebyscore.mockClear()
  })

  for (const entity of ENTITIES) {
    describe(entity, () => {
      it("the owner gets the frame from broadcast and bufferAndBroadcast; another member and an admin holding * get none", async () => {
        const phone = socket()
        const laptop = socket()
        const member = socket()
        const admin = socket()
        manager.addConnection("owner", phone, ["kernel:threads:read"], "org-1")
        manager.addConnection("owner", laptop, ["kernel"], "org-1")
        manager.addConnection("member", member, ["kernel"], "org-1")
        manager.addConnection("admin", admin, ["*"], "org-1")

        await manager.broadcast(frame(entity, "owner"))
        await manager.bufferAndBroadcast(frame(entity, "owner"))

        expect(phone.send).toHaveBeenCalledTimes(2)
        expect(laptop.send).toHaveBeenCalledTimes(2)
        expect(member.send).not.toHaveBeenCalled()
        expect(admin.send).not.toHaveBeenCalled()
        expect(JSON.parse(phone.send.mock.calls[0][0] as string).payload.entity).toBe(entity)
      })

      it("a frame without ownerUserId reaches nobody", async () => {
        const owner = socket()
        const admin = socket()
        manager.addConnection("owner", owner, ["kernel"], "org-1")
        manager.addConnection("admin", admin, ["*"], "org-1")
        await manager.broadcast(frame(entity))
        await manager.bufferAndBroadcast(frame(entity))
        expect(owner.send).not.toHaveBeenCalled()
        expect(admin.send).not.toHaveBeenCalled()
      })

      it("hello replay sends the owner's frames and no one else's", async () => {
        mockRedis.zrangebyscore.mockResolvedValueOnce([
          JSON.stringify({ type: "event", eventId: 1, payload: frame(entity, "owner") }),
          JSON.stringify({ type: "event", eventId: 2, payload: frame(entity, "other") }),
          JSON.stringify({ type: "event", eventId: 3, payload: frame(entity) }),
        ])
        const ws = socket()
        manager.addConnection("owner", ws, ["kernel"], "org-1")
        await manager.handleHello(ws, "owner", 1, ["kernel"], "org-1")
        expect(ws.send).toHaveBeenCalledTimes(1)
        expect(JSON.parse(ws.send.mock.calls[0][0] as string).eventId).toBe(1)

        mockRedis.zrangebyscore.mockResolvedValueOnce([
          JSON.stringify({ type: "event", eventId: 1, payload: frame(entity, "owner") }),
        ])
        const admin = socket()
        manager.addConnection("admin", admin, ["*"], "org-1")
        await manager.handleHello(admin, "admin", 1, ["*"], "org-1")
        expect(admin.send).not.toHaveBeenCalled()
      })
    })
  }
  it("S53 (D29): a subagent's event reaches the owner's sockets that read all events, not one that said scope top; top-level events reach both", async () => {
    const old = socket()
    const fresh = socket()
    manager.addConnection("owner", old, ["kernel"], "org-1")
    manager.addConnection("owner", fresh, ["kernel"], "org-1")
    manager.setNodeSessionScope(fresh, "top")
    const ev = (parentToolUseId?: string) => ({
      ...frame("node_session_event", "owner"),
      data: {
        ownerUserId: "owner",
        sessionId: "s1",
        seq: 2,
        type: "assistant_text",
        ...(parentToolUseId ? { parentToolUseId } : {}),
      },
    })
    await manager.broadcast(ev("tu_a"))
    await manager.bufferAndBroadcast(ev("tu_a"))
    expect(old.send).toHaveBeenCalledTimes(2)
    expect(fresh.send).not.toHaveBeenCalled()
    await manager.broadcast(ev())
    expect(fresh.send).toHaveBeenCalledTimes(1)
    // Back to all (an unknown value is all): it gets them again.
    manager.setNodeSessionScope(fresh, "everything")
    await manager.broadcast(ev("tu_a"))
    expect(fresh.send).toHaveBeenCalledTimes(2)
  })

  it("a kernel:node frame reaches its owner and not an org admin; one without ownerUserId reaches no one", async () => {
    const owner = socket()
    const admin = socket()
    const member = socket()
    manager.addConnection("owner", owner, ["kernel:threads:read"], "org-1")
    manager.addConnection("admin", admin, ["*"], "org-1")
    manager.addConnection("member", member, ["kernel"], "org-1")
    const nodeFrame = (ownerUserId?: string) => ({
      app: "kernel",
      entity: "node",
      action: "update",
      entityId: "n1",
      orgId: "org-1",
      data: {
        ...(ownerUserId ? { ownerUserId } : {}),
        nodeId: "n1",
        change: "presence",
        online: true,
      },
    })
    await manager.broadcast(nodeFrame("owner"))
    await manager.bufferAndBroadcast(nodeFrame("owner"))
    expect(owner.send).toHaveBeenCalledTimes(2)
    expect(JSON.parse(owner.send.mock.calls[0][0] as string).payload.entity).toBe("node")
    expect(admin.send).not.toHaveBeenCalled()
    expect(member.send).not.toHaveBeenCalled()
    await manager.broadcast(nodeFrame())
    await manager.bufferAndBroadcast(nodeFrame())
    expect(owner.send).toHaveBeenCalledTimes(2)
    expect(admin.send).not.toHaveBeenCalled()

    mockRedis.zrangebyscore.mockResolvedValueOnce([
      JSON.stringify({ type: "event", eventId: 1, payload: nodeFrame("owner") }),
      JSON.stringify({ type: "event", eventId: 2, payload: nodeFrame("admin-not-owner") }),
    ])
    const replayed = socket()
    manager.addConnection("owner", replayed, ["kernel"], "org-1")
    await manager.handleHello(replayed, "owner", 1, ["kernel"], "org-1")
    expect(replayed.send).toHaveBeenCalledTimes(1)
  })
})
