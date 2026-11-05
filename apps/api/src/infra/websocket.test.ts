// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { WebSocketManager } from "~/infra/websocket"
import { decodeBufferedFrame } from "~/infra/websocket-replay-buffer"
import { type LiveRedis, RedisLiveState } from "~/infra/websocket-state/redis"
import * as grantInvalidation from "~/services/security/grant-invalidation"

// Tiny in-memory shim for the subset of ioredis the manager actually calls, so
// these tests need no live Redis (the cell-wide state has its own real-Redis
// suite under `websocket-state/`).
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
}

/**
 * The cell-wide state on a client of its own, so the replay-buffer assertions
 * on `mockRedis.eval` see only the buffer's script; its reads answer "nobody
 * elsewhere", leaving every decision to the local socket table.
 */
const liveStub: LiveRedis = {
  eval: async () => 0,
  get: async () => null,
  set: async () => "OK",
  del: async () => 0,
}
const localOnlyLive = () => new RedisLiveState(liveStub, "test-instance", "")

describe("WebSocketManager", () => {
  let manager: WebSocketManager

  beforeEach(() => {
    _store.clear()
    _sets.clear()
    manager = new WebSocketManager(mockRedis as any, localOnlyLive())
    mockRedis.zadd.mockClear()
    mockRedis.eval.mockClear()
    mockRedis.zrangebyscore.mockClear()
    mockRedis.expire.mockClear()
    mockRedis.incr.mockClear()
    mockRedis.exists.mockClear()
    mockRedis.exists.mockResolvedValue(1)
  })

  it("registers and unregisters connections", () => {
    const ws = { send: mock(() => {}) } as any
    manager.addConnection("user1", ws, ["kernel"], "org-1")
    expect(manager.getConnectionCount()).toBe(1)
    manager.removeConnection(ws)
    expect(manager.getConnectionCount()).toBe(0)
  })

  it("closeAllLocal closes every local socket with 1012", () => {
    const a = { send: mock(() => {}), close: mock(() => {}), readyState: 1 } as any
    const b = { send: mock(() => {}), close: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user1", a, ["kernel"], "org-1")
    manager.addConnection("user2", b, ["kernel"], "org-2")
    expect(manager.closeAllLocal(1012, "restart")).toBe(2)
    expect(a.close).toHaveBeenCalledWith(1012, "restart")
    expect(b.close).toHaveBeenCalledWith(1012, "restart")
  })

  it("delivers events only to users with matching scopes", async () => {
    const ws1 = { send: mock(() => {}), readyState: 1 } as any
    const ws2 = { send: mock(() => {}), readyState: 1 } as any

    manager.addConnection("user1", ws1, ["kernel"], "org-1")
    manager.addConnection("user2", ws2, ["crm"], "org-1")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "user",
      action: "updated",
      entityId: "u1",
      data: { name: "New" },
    })

    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).not.toHaveBeenCalled()
  })

  it("does not deliver to disconnected sockets", async () => {
    const ws = { send: mock(() => {}), readyState: 3 } as any // CLOSED
    manager.addConnection("user1", ws, ["kernel"], "org-1")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "user",
      action: "updated",
    })

    expect(ws.send).not.toHaveBeenCalled()
  })

  it("buffers events to Redis per user", async () => {
    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user1", ws, ["kernel"], "org-1")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "user",
      action: "created",
      entityId: "u2",
      data: {},
    })

    expect(mockRedis.eval).toHaveBeenCalled()
    expect((mockRedis.eval.mock.calls[0] as unknown[])[2]).toBe("ws:events:{global}")
  })

  it("replays buffered events on hello, filtered by scopes", async () => {
    const events = [
      JSON.stringify({
        type: "event",
        eventId: 1,
        payload: { app: "kernel", entity: "user", action: "created" },
      }),
      JSON.stringify({
        type: "event",
        eventId: 2,
        payload: { app: "crm", entity: "contact", action: "updated" },
      }),
      JSON.stringify({
        type: "event",
        eventId: 3,
        payload: { app: "kernel", entity: "user", action: "updated" },
      }),
    ]
    mockRedis.zrangebyscore.mockResolvedValueOnce(events)

    const ws = { send: mock(() => {}), readyState: 1 } as any

    // Reconnect cursor (lastEventId>0) → replay-since; 0 now means "fresh, no replay".
    await manager.handleHello(ws, "user1", 1, ["kernel"], "org-1")

    // Only kernel events should be sent (2 of 3)
    expect(ws.send).toHaveBeenCalledTimes(2)
  })

  it("sends sync signal when buffer key does not exist and lastEventId > 0", async () => {
    mockRedis.exists.mockResolvedValueOnce(0)

    const ws = { send: mock(() => {}), readyState: 1 } as any

    await manager.handleHello(ws, "user1", 5, ["kernel"], "org-1")

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "sync" }))
  })

  it("fresh connect (lastEventId=0) short-circuits — no replay, no buffer scan", async () => {
    // A fresh connect starts live from "now" (state hydrated via REST). It must NOT
    // replay history (a flood of already-known events) and must not even scan the
    // buffer. exists defaults to 1 (buffer present) — the 0 short-circuit precedes it.
    const ws = { send: mock(() => {}), readyState: 1 } as any

    await manager.handleHello(ws, "user1", 0, ["kernel"], "org-1")

    expect(ws.send).not.toHaveBeenCalled()
    expect(mockRedis.zrangebyscore).not.toHaveBeenCalled()
  })

  it("out-of-range cursor (beyond newest buffered event) → sync, not a silent empty replay", async () => {
    mockRedis.exists.mockResolvedValueOnce(1) // buffer exists
    mockRedis.get.mockResolvedValueOnce("10") // newest buffered eventId = 10
    const ws = { send: mock(() => {}), readyState: 1 } as any

    await manager.handleHello(ws, "user1", 99999, ["kernel"], "org-1")

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "sync" }))
    // The bogus future cursor must NOT be treated as "caught up" (silent no-op).
    expect(mockRedis.zrangebyscore).not.toHaveBeenCalled()
  })

  it("handleHello with no orgId forces a resync and never reads a global buffer (B23b)", async () => {
    // A missing/empty orgId must NOT fall back to the org-unscoped global buffer
    // (which would risk cross-org replay). It returns a sync and touches no buffer.
    const ws = { send: mock(() => {}), readyState: 1 } as any
    // mockRedis is shared across tests in this describe with no per-test reset;
    // clear the buffer-read spies so this assertion measures only this call.
    mockRedis.exists.mockClear()
    mockRedis.get.mockClear()
    mockRedis.zrangebyscore.mockClear()

    await manager.handleHello(ws, "user1", 5, ["kernel"], "")

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "sync" }))
    // No global (or any) buffer is consulted: no exists/get/zrangebyscore on
    // `ws:events:global` or otherwise.
    expect(mockRedis.exists).not.toHaveBeenCalled()
    expect(mockRedis.get).not.toHaveBeenCalled()
    expect(mockRedis.zrangebyscore).not.toHaveBeenCalled()
  })

  it("hasAccess matches hierarchical scopes", () => {
    // App-level scope grants all events for that app
    expect(manager.hasAccess(["kernel"], "kernel")).toBe(true)
    expect(manager.hasAccess(["kernel"], "kernel", "thread")).toBe(true)
    expect(manager.hasAccess(["kernel"], "kernel", "auth")).toBe(true)
    expect(manager.hasAccess(["kernel"], "crm")).toBe(false)
    expect(manager.hasAccess(["crm"], "kernel")).toBe(false)
    expect(manager.hasAccess(["kernel", "crm"], "crm", "contacts")).toBe(true)

    // Entity-aware: narrow scopes grant access to matching entity events
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "thread")).toBe(true)
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "message")).toBe(true) // thread sub-entity
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "reaction")).toBe(true)
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "typing")).toBe(true)

    // Narrow scopes do NOT grant access to unrelated entity events
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "auth")).toBe(false)
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "contact")).toBe(false)
    expect(manager.hasAccess(["kernel:contacts:read"], "kernel", "thread")).toBe(false)

    // Plural tolerance: entity "contact" matches scope resource "contacts"
    expect(manager.hasAccess(["kernel:contacts:read"], "kernel", "contact")).toBe(true)

    // Without entity info, deny — events must have explicit entity
    expect(manager.hasAccess(["kernel:threads:read"], "kernel")).toBe(false)

    // Org-wide entities (presence) always pass
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "presence")).toBe(true)
    expect(manager.hasAccess([], "kernel", "presence")).toBe(true)
    // An admin turning an app On/Off (S18) reaches every open session of the org
    expect(manager.hasAccess([], "kernel", "org_app")).toBe(true)

    // Cross-app scopes never grant access to a different app
    expect(manager.hasAccess(["crm:contacts:read"], "kernel")).toBe(false)
    expect(manager.hasAccess(["crm:contacts:read"], "kernel", "contact")).toBe(false)

    // Wildcard scope grants everything
    expect(manager.hasAccess(["*"], "kernel")).toBe(true)
    expect(manager.hasAccess(["*"], "crm", "contacts")).toBe(true)
  })

  it("denies (never throws on) a payload with a missing app", () => {
    // A malformed durable event with no `app` reaches the WS gate via the outbox
    // fan-out. The default resolver's `app.startsWith(...)` would throw on
    // undefined and reject the whole broadcast — in the durable path that makes
    // the outbox retry forever (error-rate spike). Deny instead, even for "*".
    expect(manager.hasAccess(["*"], undefined as unknown as string)).toBe(false)
    expect(manager.hasAccess(["kernel"], undefined as unknown as string, "thread")).toBe(false)
    expect(manager.hasAccess(["*"], "" as unknown as string)).toBe(false)
  })

  it("gates approval_request resource access explicitly", () => {
    expect(manager.hasAccess(["kernel:approvals:read"], "kernel", "approval_request")).toBe(true)
    expect(manager.hasAccess(["kernel:approvals"], "kernel", "approval_request")).toBe(true)
    expect(manager.hasAccess(["kernel"], "kernel", "approval_request")).toBe(true)
    expect(manager.hasAccess(["*"], "kernel", "approval_request")).toBe(true)
    expect(manager.hasAccess(["kernel:approval_requests:read"], "kernel", "approval_request")).toBe(
      false,
    )
    expect(manager.hasAccess(["kernel:approvals:write"], "kernel", "approval_request")).toBe(false)
  })

  it("gates security_event frames on the org admin scope", () => {
    expect(manager.hasAccess(["kernel:org:admin"], "kernel", "security_event")).toBe(true)
    expect(manager.hasAccess(["*"], "kernel", "security_event")).toBe(true)
    expect(manager.hasAccess(["kernel:threads:read"], "kernel", "security_event")).toBe(false)
    expect(manager.hasAccess(["kernel:approvals:read"], "kernel", "security_event")).toBe(false)
  })

  it("gates tickets message/sla sub-entity events on tickets:tickets:read (F2)", () => {
    // message/sla ride on the parent ticket, so a granularly-scoped support
    // agent holding the ticket read scope must receive them live.
    for (const entity of ["message", "sla"]) {
      expect(manager.hasAccess(["tickets:tickets:read"], "tickets", entity)).toBe(true)
      expect(manager.hasAccess(["tickets:tickets"], "tickets", entity)).toBe(true)
      expect(manager.hasAccess(["tickets"], "tickets", entity)).toBe(true)
      expect(manager.hasAccess(["*"], "tickets", entity)).toBe(true)
      // A user with NO tickets scope receives nothing (least-privilege).
      expect(manager.hasAccess([], "tickets", entity)).toBe(false)
      expect(manager.hasAccess(["mail:messages:read"], "tickets", entity)).toBe(false)
      // The ticket read scope alone does NOT open the sibling resources' frames.
      expect(manager.hasAccess(["tickets:inboxes:read"], "tickets", entity)).toBe(false)
      expect(manager.hasAccess(["tickets:categories:read"], "tickets", entity)).toBe(false)
    }
  })

  it("gates projects project_status frames on project/task read scopes", () => {
    // Status metadata rides on project read — the default resolver would look
    // for a nonexistent projects:project_status[s] scope and starve kanban
    // holders of live status frames.
    expect(manager.hasAccess(["projects:projects:read"], "projects", "project_status")).toBe(true)
    expect(manager.hasAccess(["projects:projects"], "projects", "project_status")).toBe(true)
    expect(manager.hasAccess(["projects:projects:*"], "projects", "project_status")).toBe(true)
    expect(manager.hasAccess(["projects:tasks:read"], "projects", "project_status")).toBe(true)
    expect(manager.hasAccess(["projects:tasks:*"], "projects", "project_status")).toBe(true)
    expect(manager.hasAccess(["projects"], "projects", "project_status")).toBe(true)
    expect(manager.hasAccess(["*"], "projects", "project_status")).toBe(true)
    // No projects scope at all: deny (least-privilege).
    expect(manager.hasAccess([], "projects", "project_status")).toBe(false)
    expect(manager.hasAccess(["tickets:tickets:read"], "projects", "project_status")).toBe(false)
    // Grants on unrelated projects resources stay denied.
    expect(manager.hasAccess(["projects:templates:read"], "projects", "project_status")).toBe(false)
  })

  it("gates tickets inbox frames on tickets:inboxes:read, not the ticket read scope (F2)", () => {
    // inbox is its OWN resource — mirror its own read scope, not tickets:tickets:read.
    expect(manager.hasAccess(["tickets:inboxes:read"], "tickets", "inbox")).toBe(true)
    expect(manager.hasAccess(["tickets:inboxes"], "tickets", "inbox")).toBe(true)
    expect(manager.hasAccess(["tickets:inboxes:*"], "tickets", "inbox")).toBe(true)
    expect(manager.hasAccess(["tickets"], "tickets", "inbox")).toBe(true)
    expect(manager.hasAccess(["*"], "tickets", "inbox")).toBe(true)
    // Holding ONLY the ticket read scope must NOT deliver inbox frames.
    expect(manager.hasAccess(["tickets:tickets:read"], "tickets", "inbox")).toBe(false)
    expect(manager.hasAccess([], "tickets", "inbox")).toBe(false)
  })

  it("gates tickets category frames on tickets:categories:read, not the ticket read scope (F2)", () => {
    // category is its OWN resource — mirror its own read scope.
    expect(manager.hasAccess(["tickets:categories:read"], "tickets", "category")).toBe(true)
    expect(manager.hasAccess(["tickets:categories"], "tickets", "category")).toBe(true)
    expect(manager.hasAccess(["tickets:categories:*"], "tickets", "category")).toBe(true)
    expect(manager.hasAccess(["tickets"], "tickets", "category")).toBe(true)
    expect(manager.hasAccess(["*"], "tickets", "category")).toBe(true)
    // Holding ONLY the ticket read scope must NOT deliver category frames.
    expect(manager.hasAccess(["tickets:tickets:read"], "tickets", "category")).toBe(false)
    expect(manager.hasAccess([], "tickets", "category")).toBe(false)
  })

  it("tickets message/sla frames enforce team/sensitivity dimension isolation (F2 leak fix)", async () => {
    // A user with tickets:tickets:read but a RESTRICTIVE team grant must NOT
    // receive a ticket message frame from ANOTHER team — the frame carries the
    // parent ticket's dimension values under their grant keys (tickets:team /
    // tickets:sensitivity) so hasDimensionAccess filters it exactly as RLS
    // (app_tickets.can_read_ticket) would.
    const euWs = { send: mock(() => {}), readyState: 1 } as any
    const usWs = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("eu-agent", euWs, ["tickets:tickets:read"], "org-1", {
      "tickets:team": ["support-eu"],
    })
    manager.addConnection("us-agent", usWs, ["tickets:tickets:read"], "org-1", {
      "tickets:team": ["support-us"],
    })

    await manager.bufferAndBroadcast({
      app: "tickets",
      entity: "message",
      action: "create",
      entityId: "msg-1",
      orgId: "org-1",
      data: {
        id: "msg-1",
        ticketId: "ticket-1",
        kind: "inbound",
        textBody: "secret us-team message body",
        "tickets:team": "support-us",
        "tickets:sensitivity": "internal",
      },
    })

    // Matching team receives; other team does NOT.
    expect(usWs.send).toHaveBeenCalledTimes(1)
    expect(euWs.send).not.toHaveBeenCalled()
  })

  it("tickets note frames ride on ticket read and the ticket's team, like a message", async () => {
    const euWs = { send: mock(() => {}), readyState: 1 } as any
    const usWs = { send: mock(() => {}), readyState: 1 } as any
    const noScopeWs = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("eu-agent", euWs, ["tickets:tickets:read"], "org-1", {
      "tickets:team": ["support-eu"],
    })
    manager.addConnection("us-agent", usWs, ["tickets:tickets:read"], "org-1", {
      "tickets:team": ["support-us"],
    })
    manager.addConnection("other", noScopeWs, ["kernel:threads:read"], "org-1", {
      "tickets:team": ["support-us"],
    })
    await manager.bufferAndBroadcast({
      app: "tickets",
      entity: "note",
      action: "create",
      entityId: "note-1",
      orgId: "org-1",
      data: {
        id: "note-1",
        ticketId: "ticket-1",
        kind: "note",
        textBody: "internal us-team note",
        "tickets:team": "support-us",
        "tickets:sensitivity": "internal",
      },
    })
    expect(usWs.send).toHaveBeenCalledTimes(1)
    expect(euWs.send).not.toHaveBeenCalled()
    expect(noScopeWs.send).not.toHaveBeenCalled()
  })

  it("tickets sla frames enforce sensitivity dimension isolation (F2 leak fix)", async () => {
    // A user cleared only to 'internal' must NOT receive an sla frame for a
    // 'restricted' ticket. (hasDimensionAccess is exact-membership over the WS
    // layer, matching how every other dimension frame is filtered.)
    const internalWs = { send: mock(() => {}), readyState: 1 } as any
    const restrictedWs = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("internal-agent", internalWs, ["tickets:tickets:read"], "org-1", {
      "tickets:sensitivity": ["internal"],
    })
    manager.addConnection("restricted-agent", restrictedWs, ["tickets:tickets:read"], "org-1", {
      "tickets:sensitivity": ["restricted"],
    })

    await manager.bufferAndBroadcast({
      app: "tickets",
      entity: "sla",
      action: "breach",
      entityId: "ticket-1",
      orgId: "org-1",
      data: {
        ticketId: "ticket-1",
        handle: "T-1",
        "tickets:team": null,
        "tickets:sensitivity": "restricted",
      },
    })

    expect(restrictedWs.send).toHaveBeenCalledTimes(1)
    expect(internalWs.send).not.toHaveBeenCalled()
  })

  it("tickets message frame reaches a matching-team reader (F2 leak fix, positive)", async () => {
    // A user whose team grant MATCHES the ticket's team receives the frame.
    const euWs = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("eu-agent", euWs, ["tickets:tickets:read"], "org-1", {
      "tickets:team": ["support-eu"],
    })

    await manager.bufferAndBroadcast({
      app: "tickets",
      entity: "message",
      action: "create",
      entityId: "msg-2",
      orgId: "org-1",
      data: {
        id: "msg-2",
        ticketId: "ticket-2",
        kind: "outbound",
        "tickets:team": "support-eu",
        "tickets:sensitivity": "internal",
      },
    })

    expect(euWs.send).toHaveBeenCalledTimes(1)
  })

  it("delivers approval_request events only to snapshot notify users", async () => {
    const insideWs = { send: mock(() => {}), readyState: 1 } as any
    const outsideWs = { send: mock(() => {}), readyState: 1 } as any

    manager.addConnection("user-inside", insideWs, ["kernel:approvals:read"], "org-1")
    manager.addConnection("user-outside", outsideWs, ["kernel:approvals:read"], "org-1")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "approval_request",
      action: "create",
      orgId: "org-1",
      entityId: "request-1",
      data: { id: "request-1", notifyUserIds: ["user-inside"] },
    })

    expect(insideWs.send).toHaveBeenCalledTimes(1)
    expect(outsideWs.send).not.toHaveBeenCalled()
  })

  it("replays approval_request events only to snapshot notify users", async () => {
    mockRedis.zrangebyscore.mockResolvedValueOnce([
      JSON.stringify({
        type: "event",
        eventId: 1,
        payload: {
          app: "kernel",
          entity: "approval_request",
          action: "create",
          orgId: "org-1",
          data: { notifyUserIds: ["user1"] },
        },
      }),
      JSON.stringify({
        type: "event",
        eventId: 2,
        payload: {
          app: "kernel",
          entity: "approval_request",
          action: "update",
          orgId: "org-1",
          data: { notifyUserIds: ["user2"] },
        },
      }),
    ])

    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user1", ws, ["kernel:approvals:read"], "org-1")
    await manager.handleHello(ws, "user1", 1, ["kernel:approvals:read"], "org-1")

    expect(ws.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(sent.eventId).toBe(1)
  })

  it("does not send sync when buffer exists but user is caught up", async () => {
    mockRedis.exists.mockResolvedValueOnce(1)
    mockRedis.zrangebyscore.mockResolvedValueOnce([])

    const ws = { send: mock(() => {}), readyState: 1 } as any

    await manager.handleHello(ws, "user1", 5, ["kernel"], "org-1")

    expect(ws.send).not.toHaveBeenCalled()
  })

  // The sub_run card summary is up to 200 characters of child output. Every
  // parent-thread participant gets the status update; only those whose grants
  // cover the card's requiredScopes (or who are on its disclosure list) get the
  // summary text.
  describe("sub_run summary visibility", () => {
    const SUMMARY = "Deal 42 closes Friday"
    const summaryEvent = (data: Record<string, unknown>) => ({
      app: "kernel",
      entity: "sub_run",
      action: "update",
      entityId: "run-1",
      orgId: "org-1",
      data: { runId: "run-1", parentThreadId: "pt", status: "done", summary: SUMMARY, ...data },
    })
    const received = (ws: any) =>
      ws.send.mock.calls.map((c: any[]) => JSON.parse(String(c[0])).payload.data)

    function connect() {
      const holder = { send: mock(() => {}), readyState: 1 } as any
      const lacker = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("holder", holder, ["kernel", "crm:deals:read"], "org-1")
      manager.addConnection("lacker", lacker, ["kernel"], "org-1")
      manager.setThreadMembership(holder, new Set(["pt"]))
      manager.setThreadMembership(lacker, new Set(["pt"]))
      return { holder, lacker }
    }

    it("a buffered update carries the summary only to members holding the card's scopes", async () => {
      const { holder, lacker } = connect()
      await manager.bufferAndBroadcast(summaryEvent({ requiredScopes: ["crm:deals:read"] }))
      expect(received(holder)).toEqual([
        expect.objectContaining({ status: "done", summary: SUMMARY }),
      ])
      expect(received(lacker)).toEqual([expect.objectContaining({ status: "done", summary: null })])
      expect(JSON.stringify(lacker.send.mock.calls)).not.toContain("Deal 42")
    })

    it("an ephemeral update is redacted the same way, and a disclosed member gets the summary", async () => {
      const { holder, lacker } = connect()
      await manager.broadcast(
        summaryEvent({ requiredScopes: ["crm:deals:read"], disclosureList: ["lacker"] }),
      )
      expect(received(holder)[0]?.summary).toBe(SUMMARY)
      expect(received(lacker)[0]?.summary).toBe(SUMMARY)
      await manager.broadcast(summaryEvent({ requiredScopes: ["crm:deals:read"] }))
      expect(received(lacker)[1]?.summary).toBeNull()
    })

    it("fails closed: an update without requiredScopes carries no summary to anyone", async () => {
      const { holder, lacker } = connect()
      await manager.bufferAndBroadcast(summaryEvent({}))
      expect(received(holder)).toEqual([expect.objectContaining({ status: "done", summary: null })])
      expect(received(lacker)).toEqual([expect.objectContaining({ status: "done", summary: null })])
    })

    it("replay redacts the summary for a member lacking the card's scopes", async () => {
      const buffered = JSON.stringify({
        type: "event",
        eventId: 2,
        payload: summaryEvent({ requiredScopes: ["crm:deals:read"] }),
      })
      mockRedis.zrangebyscore.mockResolvedValueOnce([buffered])
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("lacker", ws, ["kernel"], "org-1")
      manager.setThreadMembership(ws, new Set(["pt"]))
      await manager.handleHello(ws, "lacker", 1, ["kernel"], "org-1")
      const sent = ws.send.mock.calls.map((c: any[]) => String(c[0]))
      expect(sent.some((s: string) => s.includes('"status":"done"'))).toBe(true)
      expect(sent.join("")).not.toContain("Deal 42")
    })
  })

  // THE WITHHELD BLOCK IS THE REQUESTER'S ALONE, live as well as stored. The
  // end of turn copy of an agent reply carries it so the card draws when the
  // turn lands rather than on the next open; the room gets the same event, so
  // every connection's copy goes through the read path's own projection.
  describe("withheld metadata on a live agent reply", () => {
    const replyEvent = () => ({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: "m-1",
      orgId: "org-1",
      data: {
        id: "m-1",
        threadId: "pt",
        authorType: "agent",
        content: "Here is what I can say.",
        requiredScopes: [],
        disclosureList: null,
        metadata: {
          modelId: "test-model",
          withheld: {
            requesterId: "requester",
            turnId: "m-0",
            items: [{ label: "Advertising" }],
          },
        },
      },
    })
    const received = (ws: any) =>
      ws.send.mock.calls.map((c: any[]) => JSON.parse(String(c[0])).payload.data)

    function connect() {
      const requester = { send: mock(() => {}), readyState: 1 } as any
      const bystander = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("requester", requester, ["kernel"], "org-1")
      manager.addConnection("bystander", bystander, ["kernel"], "org-1")
      manager.setThreadMembership(requester, new Set(["pt"]))
      manager.setThreadMembership(bystander, new Set(["pt"]))
      return { requester, bystander }
    }

    it("delivers the withheld block to the requester and to nobody else", async () => {
      const { requester, bystander } = connect()
      await manager.broadcast(replyEvent())
      expect(received(requester)[0]?.metadata?.withheld?.items).toEqual([{ label: "Advertising" }])
      expect(received(bystander)[0]?.metadata?.withheld).toBeUndefined()
      // The whole room still gets the reply itself.
      expect(received(bystander)[0]?.content).toBe("Here is what I can say.")
      expect(JSON.stringify(bystander.send.mock.calls)).not.toContain("Advertising")
    })

    it("projects a buffered copy the same way", async () => {
      const { requester, bystander } = connect()
      await manager.bufferAndBroadcast(replyEvent())
      expect(received(requester)[0]?.metadata?.withheld?.requesterId).toBe("requester")
      expect(received(bystander)[0]?.metadata?.withheld).toBeUndefined()
    })
  })

  // A2 second pass, layered on top of the THREAD_SCOPED_ENTITIES membership
  // filter: a kernel `message` frame is emitted to a connection only when that
  // connection's OWN grants cover the message's requiredScopes, or its user is
  // on the message's disclosure list. It can only narrow membership, never
  // widen it, so a message RLS hides from a reader is never pushed to them live.
  describe("message scope visibility fan out (A2)", () => {
    const CONTENT = "Deal 42 closes Friday"
    const messageEvent = (data: Record<string, unknown>) => ({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: "msg-scoped",
      orgId: "org-1",
      data: { id: "msg-scoped", threadId: "t1", content: CONTENT, ...data },
    })

    // Both connections are members of the same thread, so membership can never
    // explain a difference in delivery: only their own grants differ.
    function connect() {
      const holder = { send: mock(() => {}), readyState: 1 } as any
      const lacker = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("holder", holder, ["kernel", "crm:deals:read"], "org-1")
      manager.addConnection("lacker", lacker, ["kernel"], "org-1")
      manager.setThreadMembership(holder, new Set(["t1"]))
      manager.setThreadMembership(lacker, new Set(["t1"]))
      return { holder, lacker }
    }

    it("a message event with requiredScopes the connection's user lacks is not delivered to that connection", async () => {
      const { holder, lacker } = connect()

      await manager.bufferAndBroadcast(messageEvent({ requiredScopes: ["crm:deals:read"] }))

      expect(holder.send).toHaveBeenCalledTimes(1)
      expect(String(holder.send.mock.calls[0][0])).toContain(CONTENT)
      // Nothing at all, not a redacted copy: the connection is never told the
      // message exists.
      expect(lacker.send).not.toHaveBeenCalled()
    })

    it("the same message event IS delivered once the connection's user is added to the disclosureList", async () => {
      const { lacker } = connect()

      // The disclosed connection holds none of the message's scopes: the
      // disclosure list is the only thing letting it through.
      await manager.bufferAndBroadcast(
        messageEvent({ requiredScopes: ["crm:deals:read"], disclosureList: ["lacker"] }),
      )

      expect(lacker.send).toHaveBeenCalledTimes(1)
      expect(String(lacker.send.mock.calls[0][0])).toContain(CONTENT)
    })

    it("an ephemeral broadcast is filtered by each connection's own grants, not the author's", async () => {
      const { holder, lacker } = connect()

      // Authored by the user who lacks the scope: authorship neither grants
      // that connection sight nor lends the holder's grants to anyone else.
      await manager.broadcast(
        messageEvent({ requiredScopes: ["crm:deals:read"], authorId: "lacker" }),
      )

      expect(holder.send).toHaveBeenCalledTimes(1)
      expect(lacker.send).not.toHaveBeenCalled()
    })

    it("a wildcard grant covers the required scope, matching the read path", async () => {
      const wild = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("wild", wild, ["kernel", "crm:*"], "org-1")
      manager.setThreadMembership(wild, new Set(["t1"]))

      await manager.bufferAndBroadcast(messageEvent({ requiredScopes: ["crm:deals:read"] }))

      expect(wild.send).toHaveBeenCalledTimes(1)
    })

    it("fails closed: a message event with no requiredScopes array reaches nobody", async () => {
      const { holder, lacker } = connect()

      await manager.bufferAndBroadcast(messageEvent({}))

      expect(holder.send).not.toHaveBeenCalled()
      expect(lacker.send).not.toHaveBeenCalled()
    })

    it("replay applies the same scope filter to a buffered message", async () => {
      const buffered = JSON.stringify({
        type: "event",
        eventId: 2,
        payload: messageEvent({ requiredScopes: ["crm:deals:read"] }),
      })
      const lacker = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("lacker", lacker, ["kernel"], "org-1")
      manager.setThreadMembership(lacker, new Set(["t1"]))
      mockRedis.zrangebyscore.mockResolvedValueOnce([buffered])

      await manager.handleHello(lacker, "lacker", 1, ["kernel"], "org-1")

      expect(lacker.send).not.toHaveBeenCalled()

      const holder = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("holder", holder, ["kernel", "crm:deals:read"], "org-1")
      manager.setThreadMembership(holder, new Set(["t1"]))
      mockRedis.zrangebyscore.mockResolvedValueOnce([buffered])

      await manager.handleHello(holder, "holder", 1, ["kernel", "crm:deals:read"], "org-1")

      expect(holder.send).toHaveBeenCalledTimes(1)
    })

    it("a non kernel message frame is untouched by the scope pass", async () => {
      // `mail` and `tickets` emit their own `message` entities. They carry no
      // requiredScopes and have their own gates, so the kernel scope pass must
      // leave them alone rather than fail them closed.
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("mail-user", ws, ["mail"], "org-1")

      await manager.bufferAndBroadcast({
        app: "mail",
        entity: "message",
        action: "create",
        entityId: "mail-1",
        orgId: "org-1",
        data: { id: "mail-1", conversationId: "conversation-a" },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it("the grant invalidation drain still runs with the scope pass in the chain", async () => {
      const { holder, lacker } = connect()
      const spy = spyOn(grantInvalidation, "resolveGrantInvalidations").mockResolvedValue([
        { userId: "lacker", threadIds: ["t1"] },
      ])
      const invalidatesOf = (ws: any) =>
        ws.send.mock.calls
          .map((call: any[]) => JSON.parse(String(call[0])))
          .filter((frame: any) => frame.type === "visibility:invalidate")

      try {
        await manager.bufferAndBroadcast({
          app: "kernel",
          entity: "user_scope",
          action: "grant",
          entityId: "lacker",
          orgId: "org-1",
          data: { targetUserId: "lacker" },
        })

        expect(invalidatesOf(lacker)).toEqual([
          { type: "visibility:invalidate", threadIds: ["t1"] },
        ])
        expect(invalidatesOf(holder)).toHaveLength(0)
      } finally {
        spy.mockRestore()
      }
    })
  })

  // A2 per-chunk gating, the same second pass as the message filter above but
  // against a set that GROWS while the turn runs. A chunk is gated on what the
  // turn has accumulated at the moment it is emitted: never on the final set
  // (which does not exist yet) and never once at stream start.
  describe("agent_stream per chunk scope gating (A2)", () => {
    const chunk = (text: string, data: Record<string, unknown>) => ({
      app: "kernel",
      entity: "agent_stream",
      action: "delta",
      entityId: "t1",
      orgId: "org-1",
      // The human whose request started this turn. The stream producers all
      // stamp the triggering user here.
      actorId: "requester",
      data: { threadId: "t1", text, ...data },
    })

    const textsOf = (ws: any) =>
      ws.send.mock.calls.map((c: any[]) => JSON.parse(String(c[0])).payload.data.text)

    // Three members of one thread. Membership is identical for all three, so
    // only their own grants and the turn's accumulated set can ever explain a
    // difference in delivery.
    function connect() {
      const holder = { send: mock(() => {}), readyState: 1 } as any
      const lacker = { send: mock(() => {}), readyState: 1 } as any
      const requester = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("holder", holder, ["kernel", "crm:deals:read"], "org-1")
      manager.addConnection("lacker", lacker, ["kernel"], "org-1")
      manager.addConnection("requester", requester, ["kernel"], "org-1")
      for (const ws of [holder, lacker, requester]) manager.setThreadMembership(ws, new Set(["t1"]))
      return { holder, lacker, requester }
    }

    it("a chunk of a turn that has accumulated nothing reaches every room member", async () => {
      const { holder, lacker } = connect()

      // An empty accumulated set is a positive assertion that the turn has
      // touched no scoped data yet, exactly as it is on the write path.
      await manager.broadcast(chunk("hello", { accumulatedScopes: [] }))

      expect(textsOf(holder)).toEqual(["hello"])
      expect(textsOf(lacker)).toEqual(["hello"])
    })

    it("an agent_stream chunk whose accumulatedScopes the connection's user lacks is not delivered", async () => {
      const { holder, lacker } = connect()

      await manager.broadcast(chunk("deal 42", { accumulatedScopes: ["crm:deals:read"] }))

      expect(textsOf(holder)).toEqual(["deal 42"])
      expect(lacker.send).not.toHaveBeenCalled()
    })

    it("gating is re evaluated per chunk, not once at stream start", async () => {
      const { holder, lacker } = connect()

      // The turn reads scoped data only at its second chunk. The first chunk
      // predates the tool call and is visible to the whole room; the second is
      // not. A gate evaluated once at stream start would deliver both or
      // neither.
      await manager.broadcast(chunk("thinking", { accumulatedScopes: [] }))
      await manager.broadcast(chunk("deal 42", { accumulatedScopes: ["crm:deals:read"] }))

      expect(textsOf(holder)).toEqual(["thinking", "deal 42"])
      expect(textsOf(lacker)).toEqual(["thinking"])
    })

    it("a connection that gains the scope mid turn does not receive the turn's earlier chunks", async () => {
      const { lacker } = connect()

      await manager.broadcast(chunk("deal 42", { accumulatedScopes: ["crm:deals:read"] }))
      expect(lacker.send).not.toHaveBeenCalled()

      // The grant lands. A permission change forces a reconnect, so the wider
      // grants arrive on a fresh connection.
      manager.removeConnection(lacker)
      const regranted = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("lacker", regranted, ["kernel", "crm:deals:read"], "org-1")
      manager.setThreadMembership(regranted, new Set(["t1"]))

      await manager.broadcast(chunk("deal 43", { accumulatedScopes: ["crm:deals:read"] }))

      // Forward only: the chunk emitted before the grant is never replayed.
      expect(textsOf(regranted)).toEqual(["deal 43"])
    })

    it("a connection that loses the scope mid turn stops receiving further chunks", async () => {
      const { holder } = connect()

      await manager.broadcast(chunk("deal 42", { accumulatedScopes: ["crm:deals:read"] }))
      expect(textsOf(holder)).toEqual(["deal 42"])

      // The revoke lands, and its reconnect brings back narrower grants.
      manager.removeConnection(holder)
      const revoked = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("holder", revoked, ["kernel"], "org-1")
      manager.setThreadMembership(revoked, new Set(["t1"]))

      await manager.broadcast(chunk("deal 43", { accumulatedScopes: ["crm:deals:read"] }))

      expect(revoked.send).not.toHaveBeenCalled()
    })

    it("fails closed: a chunk with no accumulatedScopes reaches nobody but the requester", async () => {
      const { holder, lacker, requester } = connect()

      // The accumulated set is unknown at this moment, so the chunk may yet
      // belong to a turn that ends up scope-tagged. It is not emitted to the
      // room (A2), which no untagged chunk of such a turn may be.
      await manager.broadcast(chunk("untagged", {}))

      expect(holder.send).not.toHaveBeenCalled()
      expect(lacker.send).not.toHaveBeenCalled()
      expect(textsOf(requester)).toEqual(["untagged"])
    })

    it("fails closed: an accumulatedScopes that is not a string array is treated as unknown", async () => {
      const { holder, lacker } = connect()

      await manager.broadcast(chunk("malformed", { accumulatedScopes: "crm:deals:read" }))
      await manager.broadcast(chunk("malformed too", { accumulatedScopes: [7] }))

      expect(holder.send).not.toHaveBeenCalled()
      expect(lacker.send).not.toHaveBeenCalled()
    })

    it("the requester's own connection keeps seeing its own turn's chunks", async () => {
      const { requester } = connect()

      // The requester holds none of the accumulated scopes here, which cannot
      // happen in production (the turn runs under their own floored scope) but
      // pins the exemption: a user never loses sight of the turn they asked for.
      await manager.broadcast(chunk("deal 42", { accumulatedScopes: ["crm:deals:read"] }))

      expect(textsOf(requester)).toEqual(["deal 42"])
    })

    it("a wildcard grant covers an accumulated scope, matching the message filter", async () => {
      const wild = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("wild", wild, ["kernel", "crm:*"], "org-1")
      manager.setThreadMembership(wild, new Set(["t1"]))

      await manager.broadcast(chunk("deal 42", { accumulatedScopes: ["crm:deals:read"] }))

      expect(textsOf(wild)).toEqual(["deal 42"])
    })

    it("the turn's final message follows the message filter, not the chunk gate", async () => {
      const { holder, lacker, requester } = connect()

      await manager.broadcast(chunk("deal 42", { accumulatedScopes: ["crm:deals:read"] }))
      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        entityId: "msg-1",
        orgId: "org-1",
        actorId: "requester",
        data: {
          id: "msg-1",
          threadId: "t1",
          content: "Deal 42 closes Friday",
          requiredScopes: ["crm:deals:read"],
        },
      })

      const contentOf = (ws: any) =>
        ws.send.mock.calls.filter((c: any[]) => String(c[0]).includes("Deal 42 closes Friday"))
          .length

      expect(contentOf(holder)).toBe(1)
      expect(contentOf(lacker)).toBe(0)
      // The chunk gate's requester exemption is the STREAM's, and deliberately
      // does not extend to the persisted message: the message filter and its
      // default are unchanged.
      expect(contentOf(requester)).toBe(0)
    })
  })

  describe("broadcast (ephemeral, no buffer)", () => {
    it("broadcasts without writing to Redis", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1")
      manager.setThreadMembership(ws, new Set(["t1"]))

      await manager.broadcast({
        app: "kernel",
        entity: "typing",
        action: "start",
        data: { threadId: "t1", userId: "user1" },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(mockRedis.eval).not.toHaveBeenCalled()
      expect(mockRedis.incr).not.toHaveBeenCalled()
    })
  })

  // A read mark moved on one device: every socket of THAT reader hears it (the
  // phone and the laptop both), whatever its scopes, and nobody else does.
  describe("read_state reaches the reader's own devices only", () => {
    const frame = (forUserId?: string) => ({
      app: "kernel",
      entity: "read_state",
      action: "update",
      orgId: "org-1",
      data: { ...(forUserId ? { forUserId } : {}), kind: "thread", threadId: "t1", unreadCount: 0 },
    })

    it("delivers to every socket of the reader and to no other member", async () => {
      const phone = { send: mock(() => {}), readyState: 1 } as any
      const laptop = { send: mock(() => {}), readyState: 1 } as any
      const otherMember = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("reader", phone, ["kernel:threads:read"], "org-1")
      manager.addConnection("reader", laptop, ["kernel"], "org-1")
      manager.addConnection("other", otherMember, ["kernel"], "org-1")
      manager.setThreadMembership(otherMember, new Set(["t1"]))

      await manager.broadcast(frame("reader"))

      expect(phone.send).toHaveBeenCalledTimes(1)
      expect(laptop.send).toHaveBeenCalledTimes(1)
      expect(otherMember.send).not.toHaveBeenCalled()
      expect(JSON.parse(phone.send.mock.calls[0][0] as string).payload.data).toMatchObject({
        kind: "thread",
        threadId: "t1",
        unreadCount: 0,
      })
    })

    it("delivers a frame with no owner to nobody (fail closed)", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("reader", ws, ["*"], "org-1")
      await manager.broadcast(frame())
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("is filtered the same way on replay", async () => {
      mockRedis.zrangebyscore.mockResolvedValueOnce([
        JSON.stringify({ type: "event", eventId: 1, payload: frame("reader") }),
        JSON.stringify({ type: "event", eventId: 2, payload: frame("other") }),
      ])
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("reader", ws, ["kernel"], "org-1")
      await manager.handleHello(ws, "reader", 1, ["kernel"], "org-1")
      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(ws.send.mock.calls[0][0] as string).eventId).toBe(1)
    })
  })

  // An agent's notification (a node chat's permission prompt) reaches the
  // people it names, whatever their scopes, and nobody else: before, no member
  // held a scope reading it, so an open chat never heard of a new prompt.
  describe("agent_notification reaches the people it names only", () => {
    const frame = (targetUserIds?: string[]) => ({
      app: "kernel",
      entity: "agent_notification",
      action: "create",
      orgId: "org-1",
      data: { ...(targetUserIds ? { targetUserIds } : {}), summary: "Data asks to use Bash" },
    })

    it("delivers to the named member, not to an admin holding *", async () => {
      const owner = { send: mock(() => {}), readyState: 1 } as any
      const admin = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("owner", owner, ["kernel:threads:read"], "org-1")
      manager.addConnection("admin", admin, ["*"], "org-1")

      await manager.bufferAndBroadcast(frame(["owner"]))

      expect(owner.send).toHaveBeenCalledTimes(1)
      expect(admin.send).not.toHaveBeenCalled()
    })

    it("delivers a frame naming nobody to nobody (fail closed)", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("owner", ws, ["*"], "org-1")
      await manager.broadcast(frame())
      expect(ws.send).not.toHaveBeenCalled()
    })

    it("is filtered the same way on replay", async () => {
      mockRedis.zrangebyscore.mockResolvedValueOnce([
        JSON.stringify({ type: "event", eventId: 1, payload: frame(["owner"]) }),
        JSON.stringify({ type: "event", eventId: 2, payload: frame(["other"]) }),
      ])
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("owner", ws, ["kernel"], "org-1")
      await manager.handleHello(ws, "owner", 1, ["kernel"], "org-1")
      expect(ws.send).toHaveBeenCalledTimes(1)
      expect(JSON.parse(ws.send.mock.calls[0][0] as string).eventId).toBe(1)
    })
  })

  describe("per-org and per-user socket lookups", () => {
    // Three orgs, five users who belong to every org, two sockets each.
    const fakeSocket = () => {
      const frames: string[] = []
      return {
        frames,
        closed: [] as number[],
        readyState: 1,
        send(data: string) {
          frames.push(data)
        },
        close(code?: number) {
          this.closed.push(code ?? 0)
        },
      }
    }
    type FakeSocket = ReturnType<typeof fakeSocket>
    const orgs = ["org-a", "org-b", "org-c"]
    const users = ["u0", "u1", "u2", "u3", "u4"]
    let sockets: Array<{ orgId: string; userId: string; ws: FakeSocket }>
    const receivers = () =>
      sockets.filter((s) => s.ws.frames.length > 0).map((s) => `${s.orgId}/${s.userId}`)
    const reset = () => {
      for (const s of sockets) s.ws.frames.length = 0
    }

    beforeEach(() => {
      sockets = []
      for (const orgId of orgs)
        for (const userId of users)
          for (let i = 0; i < 2; i++) {
            const ws = fakeSocket()
            manager.addConnection(userId, ws, ["kernel"], orgId)
            sockets.push({ orgId, userId, ws })
          }
    })

    it("delivers an org's event to that org's sockets only", async () => {
      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "x",
        orgId: "org-b",
        data: { name: "n" },
      })
      expect(receivers()).toEqual(users.flatMap((u) => [`org-b/${u}`, `org-b/${u}`]))
    })

    it("checks thread membership across the user's sockets, and forgets a closed socket's", async () => {
      const event = {
        app: "kernel",
        entity: "message",
        action: "create",
        orgId: "org-a",
        data: { threadId: "t1", requiredScopes: [] },
      }
      const holder = sockets.find((s) => s.orgId === "org-c" && s.userId === "u1")
      if (!holder) throw new Error("no holder socket")
      manager.setThreadMembership(holder.ws, new Set(["t1"]))
      await manager.broadcast(event)
      expect(receivers()).toEqual(["org-a/u1", "org-a/u1"])

      reset()
      await manager.removeConnection(holder.ws)
      await manager.broadcast(event)
      expect(receivers()).toEqual([])

      const again = fakeSocket()
      await manager.addConnection("u1", again, ["kernel"], "org-a")
      manager.addThreadMember("u1", "t1")
      sockets.push({ orgId: "org-a", userId: "u1", ws: again })
      await manager.broadcast(event)
      expect(receivers()).toEqual(["org-a/u1", "org-a/u1", "org-a/u1"])
      expect(manager.getThreadMembershipForUser("u1")).toEqual(new Set(["t1"]))
    })

    it("reaches one user's sockets in one org, or in every org when closing", () => {
      manager.emitVisibilityInvalidate("org-c", "u2", ["t9"])
      expect(receivers()).toEqual(["org-c/u2", "org-c/u2"])
      manager.closeConnectionsForUser("u3")
      expect(sockets.filter((s) => s.ws.closed.length > 0).map((s) => s.userId)).toEqual(
        Array(6).fill("u3"),
      )
    })

    it("leaves no empty index groups once every socket is gone", async () => {
      for (const s of sockets) await manager.removeConnection(s.ws)
      expect(manager.getConnectionCount()).toBe(0)
      for (const field of ["socketsByOrg", "socketsByUser"]) {
        const index: unknown = Reflect.get(manager, field)
        expect(index instanceof Map ? index.size : -1).toBe(0)
      }
    })
  })

  describe("thread membership filtering", () => {
    it("delivers thread-scoped events only to participants", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any
      const ws2 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.addConnection("user2", ws2, ["kernel"], "org-1")

      manager.setThreadMembership(ws1, new Set(["t1"]))
      manager.setThreadMembership(ws2, new Set(["t2"]))

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        entityId: "msg1",
        data: { threadId: "t1", requiredScopes: [] },
      })

      expect(ws1.send).toHaveBeenCalledTimes(1)
      expect(ws2.send).not.toHaveBeenCalled()
    })

    it("updates membership on addThreadMember", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.setThreadMembership(ws1, new Set())

      manager.addThreadMember("user1", "t1")

      await manager.broadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        data: { threadId: "t1", requiredScopes: [] },
      })

      expect(ws1.send).toHaveBeenCalledTimes(1)
    })

    it("updates membership on removeThreadMember", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.setThreadMembership(ws1, new Set(["t1"]))

      manager.removeThreadMember("user1", "t1")

      await manager.broadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        data: { threadId: "t1", requiredScopes: [] },
      })

      expect(ws1.send).not.toHaveBeenCalled()
    })

    it("bypasses membership check for presence events (org-wide)", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.setThreadMembership(ws1, new Set())

      await manager.broadcast({
        app: "kernel",
        entity: "presence",
        action: "update",
        data: { userId: "user2", status: "online" },
      })

      expect(ws1.send).toHaveBeenCalledTimes(1)
    })

    it("delivers thread:create to all participants listed in event data", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any
      const ws2 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.addConnection("user2", ws2, ["kernel"], "org-1")
      manager.setThreadMembership(ws1, new Set())
      manager.setThreadMembership(ws2, new Set())

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "thread",
        action: "create",
        data: { id: "t1", participantIds: ["user1", "user2"] },
      })

      expect(ws1.send).toHaveBeenCalledTimes(1)
      expect(ws2.send).toHaveBeenCalledTimes(1)
    })

    it("filters thread:update events to only thread participants", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any
      const ws2 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.addConnection("user2", ws2, ["kernel"], "org-1")

      manager.setThreadMembership(ws1, new Set(["t1"]))
      manager.setThreadMembership(ws2, new Set(["t2"]))

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "thread",
        action: "update",
        entityId: "t1",
        data: { id: "t1", changes: { title: "New Title" } },
      })

      expect(ws1.send).toHaveBeenCalledTimes(1)
      expect(ws2.send).not.toHaveBeenCalled()
    })

    it("defaults to deny when membership is not loaded", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      // No setThreadMembership called — membership not loaded

      await manager.broadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        data: { threadId: "t1", requiredScopes: [] },
      })

      expect(ws1.send).not.toHaveBeenCalled()
    })

    it("replays buffered events with thread membership filtering", async () => {
      const events = [
        JSON.stringify({
          type: "event",
          eventId: 1,
          payload: {
            app: "kernel",
            entity: "message",
            action: "create",
            data: { threadId: "t1", requiredScopes: [] },
          },
        }),
        JSON.stringify({
          type: "event",
          eventId: 2,
          payload: {
            app: "kernel",
            entity: "message",
            action: "create",
            data: { threadId: "t2", requiredScopes: [] },
          },
        }),
        JSON.stringify({
          type: "event",
          eventId: 3,
          payload: { app: "kernel", entity: "user", action: "updated" },
        }),
      ]
      mockRedis.zrangebyscore.mockResolvedValueOnce(events)

      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1")
      manager.setThreadMembership(ws, new Set(["t1"]))

      // Reconnect cursor (lastEventId>0) → replay-since; 0 now means "fresh, no replay".
      await manager.handleHello(ws, "user1", 1, ["kernel"], "org-1")

      // Only thread t1 event + non-thread event should be sent (2 of 3)
      expect(ws.send).toHaveBeenCalledTimes(2)
    })

    it("closing one socket does not delete thread membership for other sockets of the same user (#47)", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any
      const ws2 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.addConnection("user1", ws2, ["kernel"], "org-1")

      manager.setThreadMembership(ws1, new Set(["t1"]))
      manager.setThreadMembership(ws2, new Set(["t1"]))

      // Close one socket
      manager.removeConnection(ws1)

      // The remaining socket should still receive thread-scoped events
      await manager.broadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        data: { threadId: "t1", requiredScopes: [] },
      })

      expect(ws2.send).toHaveBeenCalledTimes(1)
    })

    it("addThreadMember updates all connections for the same user", async () => {
      const ws1 = { send: mock(() => {}), readyState: 1 } as any
      const ws2 = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user1", ws1, ["kernel"], "org-1")
      manager.addConnection("user1", ws2, ["kernel"], "org-1")

      manager.setThreadMembership(ws1, new Set())
      manager.setThreadMembership(ws2, new Set())

      manager.addThreadMember("user1", "t1")

      await manager.broadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        data: { threadId: "t1", requiredScopes: [] },
      })

      expect(ws1.send).toHaveBeenCalledTimes(1)
      expect(ws2.send).toHaveBeenCalledTimes(1)
    })
  })

  describe("replay dynamic membership update", () => {
    it("replay delivers participant:add event and dynamically updates membership for subsequent events", async () => {
      // Buffer contains:
      // 1. participant:add for user1 + "thread-new"
      // 2. message:create for "thread-new"
      // user1's membership does NOT include "thread-new" initially
      const events = [
        JSON.stringify({
          type: "event",
          eventId: 1,
          payload: {
            app: "kernel",
            entity: "participant",
            action: "add",
            data: { userId: "user1", threadId: "thread-new" },
          },
        }),
        JSON.stringify({
          type: "event",
          eventId: 2,
          payload: {
            app: "kernel",
            entity: "message",
            action: "create",
            data: { threadId: "thread-new", requiredScopes: [] },
          },
        }),
      ]
      mockRedis.zrangebyscore.mockResolvedValueOnce(events)

      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1")
      // Membership starts empty — user1 is NOT in "thread-new"
      manager.setThreadMembership(ws, new Set())

      await manager.handleHello(ws, "user1", 1, ["kernel"], "org-1")

      // Both events should be delivered:
      // 1. participant:add (thread-scoped but matches userId)
      // 2. message:create for thread-new (membership was dynamically updated by event #1)
      expect(ws.send).toHaveBeenCalledTimes(2)
    })

    it("replay handles participant:remove and blocks subsequent events for that thread", async () => {
      const events = [
        JSON.stringify({
          type: "event",
          eventId: 1,
          payload: {
            app: "kernel",
            entity: "participant",
            action: "remove",
            data: { userId: "user1", threadId: "thread-old" },
          },
        }),
        JSON.stringify({
          type: "event",
          eventId: 2,
          payload: {
            app: "kernel",
            entity: "message",
            action: "create",
            data: { threadId: "thread-old", requiredScopes: [] },
          },
        }),
      ]
      mockRedis.zrangebyscore.mockResolvedValueOnce(events)

      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1")
      // Membership initially includes "thread-old"
      manager.setThreadMembership(ws, new Set(["thread-old"]))

      await manager.handleHello(ws, "user1", 1, ["kernel"], "org-1")

      // participant:remove dynamically removes thread-old from membership
      // BEFORE the hasThreadAccess check, so both the participant:remove event
      // and the subsequent message:create for thread-old are blocked.
      // This is correct behavior: after removal, all events for that thread are denied.
      expect(ws.send).toHaveBeenCalledTimes(0)
    })
  })

  describe("dimension-based filtering", () => {
    it("delivers events matching the client's dimension grants", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["eu"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { team: "eu" },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it("blocks events that do not match the client's dimension grants", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["eu"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { team: "us" },
      })

      expect(ws.send).not.toHaveBeenCalled()
    })

    it("passes through events with no dimension data", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["eu"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { name: "New" },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
    })
  })

  it("isolates events between different organizations", async () => {
    const ws1 = { send: mock(() => {}), readyState: 1 } as any
    const ws2 = { send: mock(() => {}), readyState: 1 } as any

    manager.addConnection("user1", ws1, ["kernel"], "org-1")
    manager.addConnection("user2", ws2, ["kernel"], "org-2")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "user",
      action: "updated",
      orgId: "org-1",
      entityId: "u1",
      data: { name: "New" },
    })

    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).not.toHaveBeenCalled()
  })

  it("isolates events in reverse direction — org-2 events don't reach org-1", async () => {
    const ws1 = { send: mock(() => {}), readyState: 1 } as any
    const ws2 = { send: mock(() => {}), readyState: 1 } as any

    manager.addConnection("user1", ws1, ["kernel"], "org-1")
    manager.addConnection("user2", ws2, ["kernel"], "org-2")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "user",
      action: "updated",
      orgId: "org-2",
      entityId: "u2",
      data: { name: "New" },
    })

    expect(ws2.send).toHaveBeenCalledTimes(1)
    expect(ws1.send).not.toHaveBeenCalled()
  })

  it("events with missing orgId broadcast to all matching connections (no org filter)", async () => {
    const ws1 = { send: mock(() => {}), readyState: 1 } as any
    const ws2 = { send: mock(() => {}), readyState: 1 } as any

    manager.addConnection("user1", ws1, ["kernel"], "org-1")
    manager.addConnection("user2", ws2, ["kernel"], "org-2")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "presence",
      action: "update",
      // No orgId — falls back to all connections
      entityId: "u1",
      data: { status: "online" },
    })

    // Without orgId, event is broadcast to ALL connections with matching scopes.
    // This is intentional for org-wide events like presence. Scope checks still apply.
    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).toHaveBeenCalledTimes(1)
  })

  it("bufferAndBroadcast stores correct event shape in Redis", async () => {
    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user1", ws, ["kernel"], "org-1")

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "user",
      action: "created",
      entityId: "u2",
      data: { name: "Test" },
    })

    expect(mockRedis.eval).toHaveBeenCalled()
    const call = mockRedis.eval.mock.calls[0] as any[]
    const stored = JSON.parse(decodeBufferedFrame(call[5]))
    expect(stored.type).toBe("event")
    expect(stored.eventId).toBeDefined()
    expect(stored.payload.app).toBe("kernel")
    expect(stored.payload.entity).toBe("user")
    expect(stored.payload.action).toBe("created")
    expect(stored.payload.data.name).toBe("Test")
  })

  it("broadcast frame carries the stable eventId for at-least-once dedup (B23a)", async () => {
    // The outbox is at-least-once: a crash between publish and processed_at
    // re-delivers the same logical event. The broadcast frame must carry the
    // replay `eventId` so a client can recognise and drop a duplicate it already
    // applied (it advances its cursor by `msg.eventId`).
    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user1", ws, ["kernel"], "org-1")

    // Fan-out path: the single writer assigns the id once at publish time and
    // passes it here as presetEventId.
    await manager.bufferAndBroadcast(
      {
        app: "kernel",
        entity: "user",
        action: "updated",
        orgId: "org-1",
        entityId: "u1",
        data: { name: "New" },
      },
      77,
      true,
    )

    expect(ws.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(sent.type).toBe("event")
    expect(sent.eventId).toBe(77)
  })

  it("preserves actorId in WS event payload", async () => {
    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user1", ws, ["kernel"], "org-1")
    manager.setThreadMembership(ws, new Set(["t1"]))

    await manager.bufferAndBroadcast({
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: "msg1",
      data: { threadId: "t1", requiredScopes: [] },
      actorId: "user2",
    })

    expect(ws.send).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(ws.send.mock.calls[0][0] as string)
    expect(sent.payload.actorId).toBe("user2")
  })

  describe("presence", () => {
    it("setPresence writes Redis key with TTL", async () => {
      await manager.setPresence("org1", "user1", "online")
      expect(mockRedis.set).toHaveBeenCalledWith("presence:org1:user1", "online", "EX", 60)
    })

    it("refreshPresence extends TTL", async () => {
      await manager.refreshPresence("org1", "user1")
      expect(mockRedis.expire).toHaveBeenCalledWith("presence:org1:user1", 60)
    })

    it("getPresenceMap lists the cell's online users with their status keys", async () => {
      const live = new RedisLiveState(
        { ...liveStub, eval: async () => ["user1", "user2"] },
        "test-instance",
        "",
      )
      const mgr = new WebSocketManager(mockRedis as any, live)
      const presenceMap = await mgr.getPresenceMap("org1")
      expect(presenceMap).toEqual({ user1: "online", user2: "away" })
      expect(mockRedis.mget).toHaveBeenCalledWith("presence:org1:user1", "presence:org1:user2")
    })

    it("getPresenceMap reads a user with a live socket but no status key as online", async () => {
      const live = new RedisLiveState(
        { ...liveStub, eval: async () => ["user1"] },
        "test-instance",
        "",
      )
      const redis = { ...mockRedis, mget: mock(() => Promise.resolve([null])) }
      const mgr = new WebSocketManager(redis as any, live)
      expect(await mgr.getPresenceMap("org1")).toEqual({ user1: "online" })
    })

    it("getPresenceMap falls back to this process's sockets when the cell state does not answer", async () => {
      const live = new RedisLiveState(
        { ...liveStub, eval: () => new Promise(() => {}) },
        "test-instance",
        "",
        { commandTimeoutMs: 50 },
      )
      const redis = { ...mockRedis, mget: mock(() => Promise.resolve([null])) }
      const mgr = new WebSocketManager(redis as any, live)
      mgr.addConnection("local-user", { send: mock(() => {}), readyState: 1 } as any, [], "org1")
      expect(await mgr.getPresenceMap("org1")).toEqual({ "local-user": "online" })
    })
  })

  describe("dimension filtering aligned with RLS", () => {
    it("global wildcard {*: [*]} allows all dimension values", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("admin", ws, ["kernel"], "org-1", { "*": ["*"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { team: "us", sensitivity: "confidential" },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it("key-specific wildcard allows that dimension", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["*"], region: ["eu"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { team: "us", region: "eu" },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it("empty grant array for a key denies events with that dimension value", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: [] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { team: "eu" },
      })

      expect(ws.send).not.toHaveBeenCalled()
    })

    it("mismatched dimension value is denied", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["eu"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { team: "us" },
      })

      expect(ws.send).not.toHaveBeenCalled()
    })

    it("events without dimension data pass through even with grants", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["eu"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "user",
        action: "updated",
        entityId: "u1",
        data: { name: "Updated" },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it("denies mail conversation events for clients without the inbox grant", async () => {
      const allowedWs = { send: mock(() => {}), readyState: 1 } as any
      const deniedWs = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("allowed", allowedWs, ["mail:conversations:read"], "org-1", {
        "mail:inbox": ["account-a"],
      })
      manager.addConnection("denied", deniedWs, ["mail:conversations:read"], "org-1", {
        "mail:inbox": ["account-b"],
      })

      await manager.bufferAndBroadcast({
        app: "mail",
        entity: "conversation",
        action: "update",
        entityId: "conversation-a",
        orgId: "org-1",
        data: { id: "conversation-a", _inboxAccountId: "account-a", _mailOwnerType: "org" },
      })

      expect(allowedWs.send).toHaveBeenCalledTimes(1)
      expect(deniedWs.send).not.toHaveBeenCalled()
    })

    it("denies personal mail events to non-owners", async () => {
      const ownerWs = { send: mock(() => {}), readyState: 1 } as any
      const otherWs = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("owner", ownerWs, ["mail"], "org-1")
      manager.addConnection("other", otherWs, ["mail"], "org-1", {
        "mail:inbox": ["account-a"],
      })

      await manager.bufferAndBroadcast({
        app: "mail",
        entity: "message",
        action: "create",
        entityId: "message-a",
        orgId: "org-1",
        data: {
          id: "message-a",
          conversationId: "conversation-a",
          _inboxAccountId: "account-a",
          _mailOwnerType: "user",
          _mailOwnerId: "owner",
        },
      })

      expect(ownerWs.send).toHaveBeenCalledTimes(1)
      expect(otherWs.send).not.toHaveBeenCalled()
    })

    it("denies personal connected account events to non-owners", async () => {
      const ownerWs = { send: mock(() => {}), readyState: 1 } as any
      const adminWs = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("owner", ownerWs, ["kernel:connected_account:read"], "org-1")
      manager.addConnection("admin", adminWs, ["kernel:connected_account:read"], "org-1")

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "connected_account",
        action: "create",
        entityId: "connection-a",
        orgId: "org-1",
        data: {
          id: "connection-a",
          ownerType: "user",
          ownerId: "owner",
          identifier: "owner@example.com",
        },
      })

      expect(ownerWs.send).toHaveBeenCalledTimes(1)
      expect(adminWs.send).not.toHaveBeenCalled()
    })

    // Settings > Mail (apps/web MailAccounts.tsx) refreshes on the `mail:account`
    // key, which a frame gets from its app and entity. These are the events the
    // mail app really emits when a mailbox connects or disconnects (its manifest
    // `emits`), in the shape the fan-out enrichment gives an org mailbox.
    it("delivers every mail account event the mail app emits to an admin holding the global wildcard grant", async () => {
      const manifest = (await import("~/apps/mail/app.manifest.json")).default as {
        events: { emits: string[] }
      }
      const accountEmits = manifest.events.emits.filter((e) => e.startsWith("account:"))
      expect(accountEmits).toEqual(["account:create", "account:update"])

      const adminWs = { send: mock(() => {}), readyState: 1 } as any
      const otherInboxWs = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("admin", adminWs, ["*"], "org-1", { "*": ["*"] })
      manager.addConnection("member", otherInboxWs, ["mail:accounts:read"], "org-1", {
        "mail:inbox": ["account-other"],
      })

      for (const emit of accountEmits) {
        const [entity, action] = emit.split(":") as [string, string]
        await manager.bufferAndBroadcast({
          app: "mail",
          entity,
          action,
          entityId: "account-shared",
          orgId: "org-1",
          data: {
            id: "account-shared",
            syncStatus: action === "update" ? "disconnected" : "pre-sync",
            _inboxAccountId: "account-shared",
            _mailOwnerType: "org",
            _mailOwnerId: null,
          },
        })
      }

      expect(adminWs.send).toHaveBeenCalledTimes(accountEmits.length)
      const frames = (adminWs.send.mock.calls as unknown as Array<[string]>).map(
        ([raw]) => JSON.parse(raw).payload as { app: string; entity: string; action: string },
      )
      expect(frames.map((f) => `${f.app}:${f.entity}`)).toEqual(["mail:account", "mail:account"])
      expect(frames.map((f) => f.action)).toEqual(["create", "update"])
      // A member whose inbox grant names another mailbox still gets none.
      expect(otherInboxWs.send).not.toHaveBeenCalled()
    })

    it("array dimension values match if any overlap", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["eu", "us"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "ticket",
        action: "created",
        entityId: "t1",
        data: { team: ["us", "asia"] },
      })

      expect(ws.send).toHaveBeenCalledTimes(1)
    })

    it("array dimension values denied if no overlap", async () => {
      const ws = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user1", ws, ["kernel"], "org-1", { team: ["eu"] })

      await manager.bufferAndBroadcast({
        app: "kernel",
        entity: "ticket",
        action: "created",
        entityId: "t1",
        data: { team: ["us", "asia"] },
      })

      expect(ws.send).not.toHaveBeenCalled()
    })
  })

  describe("hasAccess denies events without entity", () => {
    it("returns false when entity is undefined", () => {
      expect(manager.hasAccess(["kernel:threads:read"], "kernel", undefined)).toBe(false)
      expect(manager.hasAccess(["kernel:threads:read"], "kernel")).toBe(false)
    })
  })

  describe("WebSocketManager.hasOnlineUserWithMailAccess", () => {
    it("returns true when the personal account owner is connected", async () => {
      const ownerWs = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user-owner", ownerWs, ["mail"], "org-1")

      expect(
        await manager.hasOnlineUserWithMailAccess("org-1", {
          id: "account-1",
          ownerType: "user",
          ownerId: "user-owner",
        }),
      ).toBe(true)
    })

    it("returns true for org-owned account when a connected client has mail:inbox grant for that account", async () => {
      const inboxWs = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user-inbox", inboxWs, ["mail"], "org-1", {
        "mail:inbox": ["account-2"],
      })

      expect(
        await manager.hasOnlineUserWithMailAccess("org-1", {
          id: "account-2",
          ownerType: "org",
          ownerId: null,
        }),
      ).toBe(true)
    })

    it("returns false for org-owned account when only unrelated users are online", async () => {
      const unrelatedWs = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user-other", unrelatedWs, ["mail"], "org-1", {
        "mail:inbox": ["account-9"],
      })

      expect(
        await manager.hasOnlineUserWithMailAccess("org-1", {
          id: "account-3",
          ownerType: "org",
          ownerId: null,
        }),
      ).toBe(false)
    })

    it("treats the global wildcard dimension grant as access to an org-owned account", async () => {
      const adminWs = { send: mock(() => {}), readyState: 1 } as any
      manager.addConnection("user-admin", adminWs, ["*"], "org-1", { "*": ["*"] })
      expect(
        await manager.hasOnlineUserWithMailAccess("org-1", {
          id: "account-7",
          ownerType: "org",
          ownerId: null,
        }),
      ).toBe(true)
    })

    it("treats wildcard mail:inbox grants as access", async () => {
      const wildcardWs = { send: mock(() => {}), readyState: 1 } as any

      manager.addConnection("user-wildcard", wildcardWs, ["mail"], "org-1", {
        "mail:inbox": ["*"],
      })

      expect(
        await manager.hasOnlineUserWithMailAccess("org-1", {
          id: "account-4",
          ownerType: "org",
          ownerId: null,
        }),
      ).toBe(true)
    })
  })
})

describe("WebSocketManager — per-process throttles stay synchronous (B19)", () => {
  function redisManager(): WebSocketManager {
    _store.clear()
    _sets.clear()
    return new WebSocketManager(mockRedis as any, localOnlyLive())
  }

  it("typing throttle engages (repeat within the window is suppressed)", () => {
    const m = redisManager()
    expect(m.checkTypingThrottle("u1", "t1")).toBe(true)
    expect(m.checkTypingThrottle("u1", "t1")).toBe(false)
    // A distinct thread is throttled independently.
    expect(m.checkTypingThrottle("u1", "t2")).toBe(true)
  })

  it("auth revalidation throttles (immediate re-check is suppressed)", () => {
    const m = redisManager()
    expect(m.shouldRevalidateAuth("u1")).toBe(true)
    expect(m.shouldRevalidateAuth("u1")).toBe(false)
  })

  it("removeConnection recovers meta and clears the auth throttle on last disconnect", () => {
    const m = redisManager()
    const ws = { send() {}, close() {}, readyState: 1 } as any
    m.addConnection("u1", ws, ["kernel"], "o1")
    expect(m.getConnectionCount()).toBe(1)
    // Prime the throttle, then drop the user's only connection.
    expect(m.shouldRevalidateAuth("u1")).toBe(true)
    m.removeConnection(ws)
    expect(m.getConnectionCount()).toBe(0)
    // removeConnection recovered the (process-local) meta and cleared the
    // throttle for the user's last connection, so a re-check is due again.
    expect(m.shouldRevalidateAuth("u1")).toBe(true)
  })

  it("single-writer replay buffer: only the originator buffers; remotes broadcast-only", async () => {
    const m = redisManager()
    const ev = { app: "kernel", entity: "thread", action: "updated", orgId: "o1" }
    mockRedis.eval.mockClear()
    mockRedis.incr.mockClear()
    // Originator: preset id + shouldBuffer=true → buffers exactly once, and does
    // NOT assign its own id (the INCR happened once at publish time).
    await m.bufferAndBroadcast(ev, 42, true)
    expect(mockRedis.incr).not.toHaveBeenCalled()
    expect(mockRedis.eval).toHaveBeenCalledTimes(1)
    // A replica handling the same logical event broadcasts but must not re-buffer.
    await m.bufferAndBroadcast(ev, 42, false)
    expect(mockRedis.eval).toHaveBeenCalledTimes(1)
  })
})

describe("WebSocketManager: socket decisions when Redis does not answer (P2-3)", () => {
  const hanging: LiveRedis = {
    eval: () => new Promise(() => {}),
    get: () => new Promise(() => {}),
    set: () => new Promise(() => {}),
    del: () => new Promise(() => {}),
  }
  const manager = () =>
    new WebSocketManager(
      mockRedis as any,
      new RedisLiveState(hanging, "hang-instance", "", { commandTimeoutMs: 50 }),
    )
  const sock = () => ({ send() {}, close() {}, readyState: 1 }) as any

  it("close decides userStillOnline from the local table", async () => {
    const m = manager()
    const [a, b] = [sock(), sock()]
    await m.addConnection("u1", a, ["kernel"], "o1")
    expect((await m.addConnection("u1", b, ["kernel"], "o1")).wasOnline).toBe(true)
    expect((await m.removeConnection(a)).userStillOnline).toBe(true)
    expect((await m.removeConnection(b)).userStillOnline).toBe(false)
  })

  it("mail access with no local socket fails closed", async () => {
    const t0 = Date.now()
    expect(
      await manager().hasOnlineUserWithMailAccess("o1", {
        id: "acc",
        ownerType: "org",
        ownerId: null,
      }),
    ).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  it("a local socket answers mail access without Redis", async () => {
    const m = manager()
    await m.addConnection("u1", sock(), ["mail"], "o1", { "mail:inbox": ["acc"] })
    expect(
      await m.hasOnlineUserWithMailAccess("o1", { id: "acc", ownerType: "org", ownerId: null }),
    ).toBe(true)
  })
})

// A2 reactive visibility: a grant change invalidates the affected user's open
// thread views by forcing a re-fetch. The frame carries only thread ids that
// user already participates in, goes to that user's own connections and to no
// other connection, and never rebroadcasts message content.
describe("WebSocketManager: visibility invalidate (A2)", () => {
  const ORG = "org-vis"
  const USER_A = "user-vis-a"
  const USER_B = "user-vis-b"

  let vm: WebSocketManager

  function openWs(): any {
    return { send: mock(() => {}), close: mock(() => {}), readyState: 1 }
  }
  function framesOf(ws: any): Array<Record<string, unknown>> {
    return ws.send.mock.calls.map((call: any[]) => JSON.parse(call[0] as string))
  }
  function invalidatesOf(ws: any): Array<Record<string, unknown>> {
    return framesOf(ws).filter((f) => f.type === "visibility:invalidate")
  }

  beforeEach(() => {
    _store.clear()
    _sets.clear()
    vm = new WebSocketManager(mockRedis as any)
  })

  it("is delivered only to the affected user's own connections, never to another user's", () => {
    const a = openWs()
    const b = openWs()
    // Same org, same thread: the only thing separating them is the user id.
    vm.addConnection(USER_A, a, ["kernel"], ORG)
    vm.addConnection(USER_B, b, ["kernel"], ORG)
    vm.setThreadMembership(a, new Set(["thread-1"]))
    vm.setThreadMembership(b, new Set(["thread-1"]))

    vm.emitVisibilityInvalidate(ORG, USER_A, ["thread-1"])

    // Exactly the invalidate frame, carrying thread ids and nothing else.
    expect(framesOf(a)).toEqual([{ type: "visibility:invalidate", threadIds: ["thread-1"] }])
    expect(b.send).not.toHaveBeenCalled()
  })

  it("reaches every open connection of that user and skips a closed socket", () => {
    const a1 = openWs()
    const a2 = openWs()
    const closed = openWs()
    closed.readyState = 3
    vm.addConnection(USER_A, a1, ["kernel"], ORG)
    vm.addConnection(USER_A, a2, ["kernel"], ORG)
    vm.addConnection(USER_A, closed, ["kernel"], ORG)

    vm.emitVisibilityInvalidate(ORG, USER_A, [])

    expect(invalidatesOf(a1)).toEqual([{ type: "visibility:invalidate", threadIds: [] }])
    expect(invalidatesOf(a2)).toHaveLength(1)
    expect(closed.send).not.toHaveBeenCalled()
  })

  it("a user with no open connection is a no op, not an error", () => {
    const b = openWs()
    vm.addConnection(USER_B, b, ["kernel"], ORG)

    expect(() => vm.emitVisibilityInvalidate(ORG, "user-vis-offline", ["thread-1"])).not.toThrow()
    expect(b.send).not.toHaveBeenCalled()
  })

  it("a failing send never throws and never stops that user's other connections", () => {
    const wedged = openWs()
    wedged.send = mock(() => {
      throw new Error("socket wedged")
    })
    const good = openWs()
    vm.addConnection(USER_A, wedged, ["kernel"], ORG)
    vm.addConnection(USER_A, good, ["kernel"], ORG)

    expect(() => vm.emitVisibilityInvalidate(ORG, USER_A, ["thread-1"])).not.toThrow()
    expect(invalidatesOf(good)).toHaveLength(1)
  })

  // Delivery rides the outbox fan out of the permission event the grant
  // transaction queued: a `pending_events` row only becomes visible to the
  // outbox worker once the producer committed, so the drain is strictly
  // post-commit. The event carries its own target and the resolver reads the
  // rest from the database, so nothing passes from the grant call to here and
  // any process can serve the event.
  //
  // These cases pin the DRAIN wiring, so the resolver is stubbed; it is covered
  // against a real database in services/security/grant-invalidation.test.ts.
  describe("delivery rides the outbox fan out of the grant transaction's own event", () => {
    let resolveSpy: ReturnType<typeof spyOn<typeof grantInvalidation, "resolveGrantInvalidations">>

    afterEach(() => {
      resolveSpy?.mockRestore()
    })

    function resolvesTo(entries: Array<{ userId: string; threadIds: string[] }>): void {
      resolveSpy = spyOn(grantInvalidation, "resolveGrantInvalidations").mockImplementation(
        async (_event, connectedUserIds) => {
          const connected = new Set(connectedUserIds)
          return entries.filter((entry) => connected.has(entry.userId))
        },
      )
    }

    it("a user targeted grant event invalidates that user's own sockets once, nobody else's", async () => {
      const a1 = openWs()
      const a2 = openWs()
      const b = openWs()
      vm.addConnection(USER_A, a1, ["kernel"], ORG)
      vm.addConnection(USER_A, a2, ["kernel"], ORG)
      vm.addConnection(USER_B, b, ["kernel"], ORG)
      resolvesTo([{ userId: USER_A, threadIds: ["thread-1"] }])

      await vm.bufferAndBroadcast({
        app: "kernel",
        entity: "user_scope",
        action: "grant",
        entityId: USER_A,
        orgId: ORG,
        data: { targetUserId: USER_A, scope: "kernel:threads:read" },
      })

      // Resolved once per event, not once per connection, and both of the
      // user's own sockets receive that one invalidation. The resolver is told
      // exactly who this process has connected, so it can never target anyone
      // this manager cannot deliver to.
      expect(resolveSpy.mock.calls).toHaveLength(1)
      expect([...resolveSpy.mock.calls[0][1]].sort()).toEqual([USER_A, USER_B].sort())
      expect(invalidatesOf(a1)).toEqual([
        { type: "visibility:invalidate", threadIds: ["thread-1"] },
      ])
      expect(invalidatesOf(a2)).toHaveLength(1)
      expect(invalidatesOf(b)).toHaveLength(0)
    })

    it("a role level grant event invalidates only that role's connected members", async () => {
      const a = openWs()
      const b = openWs()
      vm.addConnection(USER_A, a, ["kernel"], ORG)
      vm.addConnection(USER_B, b, ["kernel"], ORG)
      resolvesTo([{ userId: USER_B, threadIds: ["thread-2"] }])

      await vm.bufferAndBroadcast({
        app: "kernel",
        entity: "role_scope",
        action: "grant",
        entityId: "role-1",
        orgId: ORG,
        data: { roleId: "role-1", scope: "kernel:threads:read" },
      })

      expect(invalidatesOf(b)).toEqual([{ type: "visibility:invalidate", threadIds: ["thread-2"] }])
      expect(invalidatesOf(a)).toHaveLength(0)
    })

    it("an event that is not a grant change never resolves an invalidation", async () => {
      const a = openWs()
      vm.addConnection(USER_A, a, ["kernel"], ORG)
      vm.setThreadMembership(a, new Set(["thread-1"]))
      resolvesTo([{ userId: USER_A, threadIds: ["thread-1"] }])

      await vm.bufferAndBroadcast({
        app: "kernel",
        entity: "message",
        action: "create",
        entityId: "m1",
        orgId: ORG,
        data: { threadId: "thread-1", requiredScopes: [] },
      })

      expect(resolveSpy).not.toHaveBeenCalled()
      expect(invalidatesOf(a)).toHaveLength(0)
    })

    it("no affected user means no frame", async () => {
      const a = openWs()
      vm.addConnection(USER_A, a, ["kernel"], ORG)
      resolvesTo([])

      await vm.bufferAndBroadcast({
        app: "kernel",
        entity: "user_scope",
        action: "grant",
        entityId: USER_A,
        orgId: ORG,
        data: { targetUserId: USER_A },
      })

      expect(invalidatesOf(a)).toHaveLength(0)
    })

    it("a wedged socket never breaks the grant event fan out", async () => {
      const wedged = openWs()
      wedged.send = mock(() => {
        throw new Error("socket wedged")
      })
      vm.addConnection(USER_A, wedged, ["kernel"], ORG)
      resolvesTo([{ userId: USER_A, threadIds: ["thread-1"] }])

      await expect(
        vm.bufferAndBroadcast({
          app: "kernel",
          entity: "user_scope",
          action: "grant",
          entityId: USER_A,
          orgId: ORG,
          data: { targetUserId: USER_A },
        }),
      ).resolves.toBeUndefined()
    })
  })
})

// P4a: a Home channel carries agent participants alongside humans, so a human's
// reconnect must replay every message the channel fanned out while the socket was
// gone (no gap, no duplicate) and must keep receiving live messages afterwards.
describe("WebSocketManager: channel reconnect with agent participants", () => {
  const ORG = "org-4a"
  const THREAD = "thread-support"
  const SCOPES = ["kernel"]

  // A stateful shim: the module-level mock returns canned replies, which cannot
  // show whether a replay is complete. This one really stores the org buffer so
  // the assertions read the manager's own sequencing, not the mock's script.
  function bufferingRedis() {
    const values = new Map<string, string>()
    const counters = new Map<string, number>()
    const zsets = new Map<string, { score: number; member: string }[]>()
    const sets = new Map<string, Set<string>>()
    return {
      incr: mock((key: string) => {
        const next = (counters.get(key) ?? 0) + 1
        counters.set(key, next)
        values.set(key, String(next))
        return Promise.resolve(next)
      }),
      zadd: mock((key: string, score: number, member: string) => {
        const entries = zsets.get(key) ?? []
        entries.push({ score, member })
        zsets.set(key, entries)
        return Promise.resolve(1)
      }),
      // The replay buffer append script: stored like ZADD, never trimmed here
      // (the bounds have their own real-Redis suite, websocket-replay-buffer.test.ts).
      eval: mock(
        (
          _script: string,
          _n: number,
          key: string,
          _trimmed: string,
          id: number,
          member: string,
        ) => {
          const entries = zsets.get(key) ?? []
          entries.push({ score: Number(id), member })
          zsets.set(key, entries)
          return Promise.resolve(0)
        },
      ),
      zrangebyscore: mock((key: string, min: number | string, _max: string) => {
        const from = Number(min)
        const entries = (zsets.get(key) ?? [])
          .filter((e) => e.score >= from)
          .sort((a, b) => a.score - b.score)
          .map((e) => e.member)
        return Promise.resolve(entries)
      }),
      exists: mock((key: string) =>
        Promise.resolve(values.has(key) || zsets.has(key) || sets.has(key) ? 1 : 0),
      ),
      get: mock((key: string) => Promise.resolve(values.get(key) ?? null)),
      set: mock((key: string, value: string) => {
        values.set(key, value)
        return Promise.resolve("OK")
      }),
      del: mock((...keys: string[]) => {
        let n = 0
        for (const k of keys) {
          if (values.delete(k)) n++
          if (sets.delete(k)) n++
          if (zsets.delete(k)) n++
        }
        return Promise.resolve(n)
      }),
      expire: mock(() => Promise.resolve(1)),
      sadd: mock((key: string, ...members: string[]) => {
        const set = sets.get(key) ?? new Set<string>()
        sets.set(key, set)
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
        const set = sets.get(key)
        if (!set) return Promise.resolve(0)
        let removed = 0
        for (const m of members) if (set.delete(m)) removed++
        return Promise.resolve(removed)
      }),
      smembers: mock((key: string) => Promise.resolve(Array.from(sets.get(key) ?? []))),
      mget: mock((...keys: string[]) => Promise.resolve(keys.map((k) => values.get(k) ?? null))),
    }
  }

  function openWs() {
    return { send: mock((_msg: string) => {}), readyState: 1 } as any
  }

  function framesOf(ws: any): { eventId?: number; messageId?: string; type: string }[] {
    return ws.send.mock.calls.map(([raw]: [string]) => {
      const parsed = JSON.parse(raw)
      return {
        type: parsed.type,
        eventId: parsed.eventId,
        messageId: parsed.payload?.data?.id,
      }
    })
  }

  function messageEvent(id: string, authorAgentId: string | null) {
    return {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: id,
      orgId: ORG,
      // A live message frame carries its own visibility facts; `[]` asserts the
      // row holds nothing scoped (the fan-out fails closed without the array).
      data: { id, threadId: THREAD, authorAgentId, requiredScopes: [], disclosureList: null },
    }
  }

  // Two humans and three agents are participants of the same channel. Agents hold
  // always-on connections, so they are the fan-out's steady load while a human drops.
  function connectChannel(mgr: WebSocketManager) {
    const humans = ["human-a", "human-b"].map((userId) => {
      const ws = openWs()
      mgr.addConnection(userId, ws, SCOPES, ORG)
      mgr.setThreadMembership(ws, new Set([THREAD]))
      return { userId, ws }
    })
    const agents = ["agent-support", "agent-logistics", "agent-finance"].map((userId) => {
      const ws = openWs()
      mgr.addConnection(userId, ws, SCOPES, ORG)
      mgr.setThreadMembership(ws, new Set([THREAD]))
      return { userId, ws }
    })
    return { humans, agents }
  }

  it("reconnect after a mid-fanout drop on a multi-agent channel replays every missed message exactly once", async () => {
    const redis = bufferingRedis()
    const mgr = new WebSocketManager(redis as any)
    const { humans, agents } = connectChannel(mgr)
    const dropped = humans[1]

    await mgr.bufferAndBroadcast(messageEvent("m0", null))
    const preDrop = framesOf(dropped.ws)
    expect(preDrop).toHaveLength(1)
    const lastEventId = preDrop[0].eventId as number
    expect(lastEventId).toBeGreaterThan(0)

    mgr.removeConnection(dropped.ws)

    await mgr.bufferAndBroadcast(messageEvent("m1", null))
    await mgr.bufferAndBroadcast(messageEvent("m2", "agent-support"))
    await mgr.bufferAndBroadcast(messageEvent("m3", "agent-logistics"))

    // The agents stayed connected and saw all four live.
    for (const agent of agents) {
      expect(framesOf(agent.ws).map((f) => f.messageId)).toEqual(["m0", "m1", "m2", "m3"])
    }

    const reconnected = openWs()
    mgr.addConnection(dropped.userId, reconnected, SCOPES, ORG)
    mgr.setThreadMembership(reconnected, new Set([THREAD]))
    await mgr.handleHello(reconnected, dropped.userId, lastEventId, SCOPES, ORG)

    const replayed = framesOf(reconnected)
    expect(replayed.map((f) => f.type)).toEqual(["event", "event", "event"])
    expect(replayed.map((f) => f.messageId)).toEqual(["m1", "m2", "m3"])
    expect(new Set(replayed.map((f) => f.eventId)).size).toBe(3)
  })

  it("a channel with an always-connected agent participant does not silently stop live delivery after a human's reconnect", async () => {
    const redis = bufferingRedis()
    const mgr = new WebSocketManager(redis as any)
    const { humans, agents } = connectChannel(mgr)
    const dropped = humans[1]

    await mgr.bufferAndBroadcast(messageEvent("m0", null))
    const lastEventId = framesOf(dropped.ws)[0].eventId as number
    mgr.removeConnection(dropped.ws)
    await mgr.bufferAndBroadcast(messageEvent("m1", "agent-support"))

    const reconnected = openWs()
    mgr.addConnection(dropped.userId, reconnected, SCOPES, ORG)
    mgr.setThreadMembership(reconnected, new Set([THREAD]))
    await mgr.handleHello(reconnected, dropped.userId, lastEventId, SCOPES, ORG)
    const afterReplay = framesOf(reconnected).length

    await mgr.bufferAndBroadcast(messageEvent("m2", "agent-finance"))

    const frames = framesOf(reconnected)
    expect(frames.length).toBe(afterReplay + 1)
    expect(frames[frames.length - 1].messageId).toBe("m2")
    for (const agent of agents) {
      expect(framesOf(agent.ws).map((f) => f.messageId)).toEqual(["m0", "m1", "m2"])
    }
  })

  it("MAX_PRESENCE_KEYS accounts for one personal agent per human user plus named role agents", () => {
    // 1000 concurrent human sessions (the cap this constant already assumed)
    // + 1000 personal agents (one per human) + 5 named role agents = 2005.
    expect(WebSocketManager.MAX_PRESENCE_KEYS).toBeGreaterThanOrEqual(2005)
  })

  // A cell state whose online-users read answers `userCount` users, whatever
  // cap it is asked for, recording the cap: the map must ask for
  // MAX_PRESENCE_KEYS and still clamp an answer that overshoots it.
  function presenceLive(userCount: number) {
    const askedCaps: number[] = []
    const users = Array.from({ length: userCount }, (_, i) => `u${i}`)
    const live = new RedisLiveState(
      {
        ...liveStub,
        eval: async (_script: string, _numKeys: number, ...args: (string | number)[]) => {
          askedCaps.push(Number(args[args.length - 1]))
          return users
        },
      },
      "test-instance",
      "",
    )
    const redis = {
      mget: mock((...asked: string[]) => Promise.resolve(asked.map(() => "online"))),
    }
    return { mgr: new WebSocketManager(redis as never, live), askedCaps }
  }

  it("presence asks the cell state for at most MAX_PRESENCE_KEYS users", async () => {
    const { mgr, askedCaps } = presenceLive(10)
    await mgr.getPresenceMap("orgP")
    expect(askedCaps).toEqual([WebSocketManager.MAX_PRESENCE_KEYS])
  })

  it("presence truncates to exactly MAX_PRESENCE_KEYS when the answer overshoots it", async () => {
    const cap = WebSocketManager.MAX_PRESENCE_KEYS
    const { mgr } = presenceLive(cap + 1)
    const presence = await mgr.getPresenceMap("orgP")
    expect(Object.keys(presence).length).toBe(cap)
  })

  it("presence returns every holder when fewer than the ceiling are online", async () => {
    const { mgr } = presenceLive(300)
    const presence = await mgr.getPresenceMap("orgP")
    expect(Object.keys(presence).length).toBe(300)
  })
})
