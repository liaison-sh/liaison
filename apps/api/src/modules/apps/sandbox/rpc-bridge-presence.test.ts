// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, mock } from "bun:test"
import { setWsManager, WebSocketManager } from "~/infra/websocket"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const TEST_ORG = "00000000-0000-0000-0000-000000000411"
const TEST_USER = "00000000-0000-0000-0000-000000000412"
// Account ids must be REAL uuids: `findEntityById` answers "not found" for any
// non-uuid id rather than letting Postgres raise 22P02, so a placeholder like
// a bare slug makes every lookup miss and hasOnlineUsers trivially false.
const ACCOUNT_1 = "00000000-0000-0000-0000-000000000421"
const ACCOUNT_2 = "00000000-0000-0000-0000-000000000422"
const ACCOUNT_3 = "00000000-0000-0000-0000-000000000423"
const ACCOUNT_9 = "00000000-0000-0000-0000-000000000429"

const mockRedis = {
  zadd: mock(() => Promise.resolve()),
  zrangebyscore: mock(() => Promise.resolve([] as string[])),
  expire: mock(() => Promise.resolve()),
  incr: mock(() => Promise.resolve(1)),
  exists: mock(() => Promise.resolve(1)),
  set: mock(() => Promise.resolve()),
  get: mock(() => Promise.resolve("online")),
  mget: mock(() => Promise.resolve([] as string[])),
  scanStream: mock(() => ({ on: mock(() => {}) })),
}

describe("RPC bridge — hasOnlineUsers", () => {
  beforeEach(() => {
    setWsManager(new WebSocketManager(mockRedis as any))
  })

  function makeTx(rows: any[]) {
    return {
      execute: mock(async () => rows),
    } as any
  }

  function makeBridge(rows: any[]) {
    return createRpcBridge("mail", TEST_USER, TEST_ORG, makeTx(rows), {
      name: "mail",
      schema: {
        accounts: { fields: { ownerType: "string", ownerId: "uuid?" } },
      },
      events: {},
      connections: {},
      network: {},
    } as any)
  }

  it("returns true for a personal account whose owner is online", async () => {
    const manager = new WebSocketManager(mockRedis as any)
    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user-owner", ws, ["mail"], TEST_ORG)
    setWsManager(manager)

    const bridge = makeBridge([{ id: ACCOUNT_1, owner_type: "user", owner_id: "user-owner" }])
    expect(JSON.parse(await bridge.hasOnlineUsers(ACCOUNT_1))).toBe(true)
  })

  it("returns true for an org-owned account when a connected client has mail:inbox access", async () => {
    const manager = new WebSocketManager(mockRedis as any)
    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user-inbox", ws, ["mail"], TEST_ORG, { "mail:inbox": [ACCOUNT_2] })
    setWsManager(manager)

    const bridge = makeBridge([{ id: ACCOUNT_2, owner_type: "org", owner_id: null }])
    expect(JSON.parse(await bridge.hasOnlineUsers(ACCOUNT_2))).toBe(true)
  })

  it("returns false when no connected client can access the account", async () => {
    const manager = new WebSocketManager(mockRedis as any)
    const ws = { send: mock(() => {}), readyState: 1 } as any
    manager.addConnection("user-other", ws, ["mail"], TEST_ORG, { "mail:inbox": [ACCOUNT_9] })
    setWsManager(manager)

    const bridge = makeBridge([{ id: ACCOUNT_3, owner_type: "org", owner_id: null }])
    expect(JSON.parse(await bridge.hasOnlineUsers(ACCOUNT_3))).toBe(false)
  })
})
