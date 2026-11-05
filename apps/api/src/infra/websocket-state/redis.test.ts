// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The cell-wide connection state (S5, A12): instance-scoped connections,
// presence derived from live connections, mail access across replicas.
// Real Redis, under a non-empty key prefix (`<run prefix>t:`): every script
// that builds a key inside Lua must prepend the prefix it receives in ARGV,
// or it reads every instance dead.
import { afterAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import Redis from "ioredis"
import {
  InstanceRegistry,
  InstanceRegistryTestAccess,
  LIVE_INSTANCE_KEY,
  LIVE_INSTANCES_SET,
  type RegistryRedis,
} from "~/infra/instance-registry"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { env } from "~/lib/env"
import { REDIS_PREFIX, RESP_PROTOCOL } from "~/lib/redis"
import { type LiveRedis, RedisLiveState } from "./redis"
import type { LiveConn } from "./types"

const PREFIX = `${REDIS_PREFIX}t:`
const client = new Redis(env.REDIS_URL, {
  keyPrefix: PREFIX,
  protocol: RESP_PROTOCOL,
  maxRetriesPerRequest: null,
})

afterAll(async () => {
  const keys = await client.keys(`${PREFIX}*`)
  // `keys` answers full names; `del` would prefix them again.
  if (keys.length > 0) await client.del(...keys.map((k) => k.slice(PREFIX.length)))
  client.disconnect()
})

const id = () => crypto.randomUUID()

/** A heartbeat record as the instance registry writes it. */
async function markLive(instanceId: string, ttlMs = 30_000): Promise<void> {
  await client.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", ttlMs)
}

function state(instanceId: string, c: LiveRedis = client, timeoutMs?: number): RedisLiveState {
  return new RedisLiveState(c, instanceId, PREFIX, timeoutMs ? { commandTimeoutMs: timeoutMs } : {})
}

function conn(instanceId: string, over: Partial<LiveConn> = {}): LiveConn {
  return {
    connId: id(),
    instanceId,
    userId: id(),
    orgId: id(),
    scopes: [],
    dimensionGrants: {},
    connectedAt: Date.now(),
    ...over,
  }
}

/** Every command hangs, as Redis does during an outage. */
const hanging: LiveRedis = {
  eval: () => new Promise(() => {}),
  get: () => new Promise(() => {}),
  set: () => new Promise(() => {}),
  del: () => new Promise(() => {}),
}

describe("RedisLiveState", () => {
  it("a user with sockets on two instances stays online when one closes", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    await markLive(b)
    const sa = state(a)
    const sb = state(b)
    const ca = conn(a)
    const cb = conn(b, { userId: ca.userId, orgId: ca.orgId })
    expect((await sa.addConnection(ca)).wasOnline).toBe(false)
    expect((await sb.addConnection(cb)).wasOnline).toBe(true)

    expect((await sa.removeConnection(ca)).userStillOnline).toBe(true)
    expect(await sa.isUserOnline(ca.orgId, ca.userId)).toBe(true)

    expect((await sb.removeConnection(cb)).userStillOnline).toBe(false)
    expect(await sa.isUserOnline(ca.orgId, ca.userId)).toBe(false)
  })

  it("a user whose only socket was on a dead instance reads offline before any sweep", async () => {
    const [a, observer] = [id(), id()]
    await markLive(a, 200)
    const c = conn(a)
    await state(a).addConnection(c)
    expect(await state(observer).isUserOnline(c.orgId, c.userId)).toBe(true)
    await Bun.sleep(300)
    expect(await state(observer).isUserOnline(c.orgId, c.userId)).toBe(false)
    expect(await state(observer).onlineUsers(c.orgId, 10)).toEqual([])
  })

  it("liveOrgIds lists each org with a socket on a live instance once, never a dead instance's", async () => {
    const [a, b, dead, reader] = [id(), id(), id(), id()]
    await markLive(a)
    await markLive(b)
    await client.sadd(LIVE_INSTANCES_SET, a, b, dead)
    const [orgOne, orgTwo, orgDead] = [id(), id(), id()]
    await state(a).addConnection(conn(a, { orgId: orgOne }))
    await state(a).addConnection(conn(a, { orgId: orgOne }))
    await state(b).addConnection(conn(b, { orgId: orgTwo }))
    await state(dead).addConnection(conn(dead, { orgId: orgDead }))
    try {
      const orgs = await state(reader).liveOrgIds(100)
      const watched: string[] = [orgOne, orgTwo, orgDead]
      expect(orgs.filter((o) => watched.includes(o)).sort()).toEqual([orgOne, orgTwo].sort())
      expect(new Set(orgs).size).toBe(orgs.length)
      expect(await state(reader).liveOrgIds(1)).toHaveLength(1)
    } finally {
      await client.srem(LIVE_INSTANCES_SET, a, b, dead)
    }
  })

  it("liveOrgIds examines at most its budget of connection entries", async () => {
    const [a, reader] = [id(), id()]
    await markLive(a)
    await client.sadd(LIVE_INSTANCES_SET, a)
    const orgs = [id(), id(), id(), id(), id()]
    for (const orgId of orgs) await state(a).addConnection(conn(a, { orgId }))
    try {
      // Other tests' live instances may come first in the set: the budget
      // bounds the walk whatever they hold.
      expect((await state(reader).liveOrgIds(100, 2)).length).toBeLessThanOrEqual(2)
      expect(await state(reader).liveOrgIds(100, 0)).toEqual([])
      // The normal case is unchanged: a budget above the sockets finds them all.
      const all = await state(reader).liveOrgIds(1_000)
      expect(orgs.every((o) => all.includes(o))).toBe(true)
    } finally {
      await client.srem(LIVE_INSTANCES_SET, a)
    }
  })

  it("cleanupInstance returns the users it left offline", async () => {
    const [dead, other, sweeper] = [id(), id(), id()]
    await markLive(other)
    const org = id()
    const gone = conn(dead, { orgId: org })
    const kept = conn(dead, { orgId: org })
    const keptElsewhere = conn(other, { orgId: org, userId: kept.userId })
    await state(dead).addConnection(gone)
    await state(dead).addConnection(kept)
    await state(other).addConnection(keptElsewhere)

    const left = await state(sweeper).cleanupInstance(dead)
    expect(left).toEqual([{ orgId: org, userId: gone.userId }])
    // Nothing of the dead instance is left behind.
    expect(await client.exists(`ws:i:${dead}:conns`)).toBe(0)
    expect(await state(sweeper).onlineUsers(org, 10)).toEqual([kept.userId])
  })

  it("mail access sees a socket on another instance", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    await markLive(b)
    const account = id()
    const c = conn(b, { dimensionGrants: { "mail:inbox": [account] } })
    await state(b).addConnection(c)
    const fromA = state(a)
    expect(
      await fromA.hasOnlineUserWithMailAccess(c.orgId, {
        id: account,
        ownerType: "org",
        ownerId: null,
      }),
    ).toBe(true)
    expect(
      await fromA.hasOnlineUserWithMailAccess(c.orgId, {
        id: id(),
        ownerType: "org",
        ownerId: null,
      }),
    ).toBe(false)
    expect(
      await fromA.hasOnlineUserWithMailAccess(c.orgId, {
        id: id(),
        ownerType: "user",
        ownerId: c.userId,
      }),
    ).toBe(true)
  })

  it("a grant change on a live connection reaches the cell copy", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    await markLive(b)
    const account = id()
    const c = conn(b)
    await state(b).addConnection(c)
    const q = { id: account, ownerType: "org" as const, ownerId: null }
    expect(await state(a).hasOnlineUserWithMailAccess(c.orgId, q)).toBe(false)
    await state(b).updateConnection({ ...c, dimensionGrants: { "mail:inbox": [account] } })
    expect(await state(a).hasOnlineUserWithMailAccess(c.orgId, q)).toBe(true)
  })

  it("onlineUsers works under a key prefix", async () => {
    const [a, b] = [id(), id()]
    await markLive(a)
    await markLive(b)
    const org = id()
    const u1 = conn(a, { orgId: org })
    const u1b = conn(b, { orgId: org, userId: u1.userId })
    const u2 = conn(b, { orgId: org })
    for (const c of [u1, u2]) await state(c.instanceId).addConnection(c)
    await state(b).addConnection(u1b)
    expect((await state(id()).onlineUsers(org, 10)).sort()).toEqual([u1.userId, u2.userId].sort())
    expect(await state(id()).onlineUsers(org, 1)).toHaveLength(1)
  })

  it("the reading instance counts its own sockets live without a heartbeat record", async () => {
    const self = id()
    const c = conn(self)
    await state(self).addConnection(c)
    expect(await state(self).isUserOnline(c.orgId, c.userId)).toBe(true)
    expect(await state(id()).isUserOnline(c.orgId, c.userId)).toBe(false)
  })

  it("republish restores an instance's entries after the sweep removed them", async () => {
    const [a, sweeper] = [id(), id()]
    const c = conn(a)
    await state(a).addConnection(c)
    await state(sweeper).cleanupInstance(a)
    await markLive(a)
    expect(await state(sweeper).isUserOnline(c.orgId, c.userId)).toBe(false)
    await state(a).republish([c])
    expect(await state(sweeper).isUserOnline(c.orgId, c.userId)).toBe(true)
  })

  it("republish rewrites every other entry when one of them fails", async () => {
    const [a, sweeper] = [id(), id()]
    const [c1, bad, c2] = [conn(a), conn(a), conn(a)]
    for (const c of [c1, bad, c2]) await state(a).addConnection(c)
    await state(sweeper).cleanupInstance(a)
    await markLive(a)
    // A client that refuses the write naming `bad`, as a Redis error on one key would.
    const flaky: LiveRedis = {
      eval: (script, numKeys, ...args) =>
        args.includes(bad.connId)
          ? Promise.reject(new Error("ERR one entry refused"))
          : client.eval(script, numKeys, ...args),
      get: (k) => client.get(k),
      set: (k, v, mode, s) => client.set(k, v, mode, s),
      del: (...k) => client.del(...k),
    }
    await state(a, flaky).republish([c1, bad, c2])
    expect(await state(sweeper).isUserOnline(c1.orgId, c1.userId)).toBe(true)
    expect(await state(sweeper).isUserOnline(c2.orgId, c2.userId)).toBe(true)
    expect(await state(sweeper).isUserOnline(bad.orgId, bad.userId)).toBe(false)
  })

  it("mailbox unlock round-trips with a TTL, an expired assertion reads absent", async () => {
    const s = state(id())
    const user = id()
    await s.setMailboxUnlock(user, "inst|c", {
      unlocked: true,
      keyIds: [2],
      expiresAt: Date.now() + 60_000,
    })
    expect((await s.getMailboxUnlock(user))?.keyIds).toEqual([2])
    expect(await client.ttl(`ws:mailboxUnlock:${user}`)).toBeGreaterThan(0)
    await s.setMailboxUnlock(user, "inst|c", {
      unlocked: true,
      keyIds: [],
      expiresAt: Date.now() - 1,
    })
    expect(await s.getMailboxUnlock(user)).toBeUndefined()
  })

  // A user with two clients open. Each connection asserts its own lock state;
  // the mailbox reads unlocked while ANY live connection of the user says so.
  it("a locked connection opening after an unlocked one does not mask it", async () => {
    const s = state(id())
    const user = id()
    const ttl = () => Date.now() + 60_000
    await s.setMailboxUnlock(user, "inst|conn-a", { unlocked: true, keyIds: [1], expiresAt: ttl() })
    await s.setMailboxUnlock(user, "inst|conn-b", { unlocked: false, keyIds: [], expiresAt: ttl() })
    expect((await s.getMailboxUnlock(user))?.unlocked).toBe(true)
    expect((await s.getMailboxUnlock(user))?.keyIds).toEqual([1])
    // The other one unlocks too: the key ids of both count.
    await s.setMailboxUnlock(user, "inst|conn-b", { unlocked: true, keyIds: [2], expiresAt: ttl() })
    expect((await s.getMailboxUnlock(user))?.keyIds).toEqual([1, 2])
    // A connection that locks, or closes, withdraws only its own assertion.
    await s.setMailboxUnlock(user, "inst|conn-a", null)
    expect((await s.getMailboxUnlock(user))?.keyIds).toEqual([2])
    await s.setMailboxUnlock(user, "inst|conn-b", { unlocked: false, keyIds: [], expiresAt: ttl() })
    expect(await s.getMailboxUnlock(user)).toBeUndefined()
    // A closed connection withdraws its entry; with none left the key goes.
    await s.setMailboxUnlock(user, "inst|conn-b", null)
    expect(await client.exists(`ws:mailboxUnlock:${user}`)).toBe(0)
  })

  it("one connection's expired assertion drops out without the others'", async () => {
    const s = state(id())
    const user = id()
    await s.setMailboxUnlock(user, "inst|old", {
      unlocked: true,
      keyIds: [1],
      expiresAt: Date.now() + 30,
    })
    await s.setMailboxUnlock(user, "inst|new", {
      unlocked: true,
      keyIds: [2],
      expiresAt: Date.now() + 60_000,
    })
    await Bun.sleep(60)
    expect((await s.getMailboxUnlock(user))?.keyIds).toEqual([2])
  })

  describe("when Redis does not answer (each read is bounded, ~1 s in production)", () => {
    it("mail access fails closed", async () => {
      const s = state(id(), hanging, 50)
      const t0 = Date.now()
      expect(
        await s.hasOnlineUserWithMailAccess(id(), { id: id(), ownerType: "org", ownerId: null }),
      ).toBe(false)
      expect(Date.now() - t0).toBeLessThan(1_000)
    })

    it("a deciding read rejects instead of hanging", async () => {
      const s = state(id(), hanging, 50)
      await expect(s.isUserOnline(id(), id())).rejects.toThrow(/did not answer/)
      await expect(s.removeConnection(conn(id()))).rejects.toThrow(/did not answer/)
      await expect(s.addConnection(conn(id()))).rejects.toThrow(/did not answer/)
    })

    it("a mailbox unlock read takes the locked path", async () => {
      const s = state(id(), hanging, 50)
      expect(await s.getMailboxUnlock(id())).toBeUndefined()
    })
  })
})

/** A registry client whose commands can be made to hang, as Redis does during an outage. */
class HangableClient implements RegistryRedis {
  hang = false
  constructor(private readonly inner: Redis) {}
  private gate<T>(p: () => Promise<T>): Promise<T> {
    return this.hang ? new Promise<T>(() => {}) : p()
  }
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    return this.gate(() => this.inner.eval(script, numKeys, ...args))
  }
  smembers(key: string): Promise<string[]> {
    return this.gate(() => this.inner.smembers(key))
  }
  get(key: string): Promise<string | null> {
    return this.gate(() => this.inner.get(key))
  }
  exists(key: string): Promise<number> {
    return this.gate(() => this.inner.exists(key))
  }
}

async function until(ok: () => Promise<boolean>, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms
  while (!(await ok()) && Date.now() < end) await Bun.sleep(25)
  return ok()
}

// The process's recovery hook end to end (P2-1): `setWsManager` registers it on
// the process's instance registry, the registry fires it when its record comes
// back after a lapse, and the manager rewrites its sockets from its local table.
describe("a recovered instance republishes its sockets through setWsManager's hook", () => {
  it("connections, presence and mail access are back in Redis, and another instance sees the user", async () => {
    const previous = getWsManager()
    const [a, b] = [id(), id()]
    const regClient = new HangableClient(client)
    const reg = new InstanceRegistry({
      instanceId: a,
      client: regClient,
      prefix: PREFIX,
      setKey: `live:instances:test:${id()}`,
      ttlMs: 300,
      heartbeatMs: 100,
      sweepIntervalMs: 100,
      commandTimeoutMs: 200,
    })
    const mgr = new WebSocketManager(client, undefined, { instanceId: a })
    const observer = new WebSocketManager(client, undefined, { instanceId: b })
    try {
      // A manager installed before a registry reset (as an earlier test file
      // in the same process does) must not leave the next registry without
      // its hooks.
      setWsManager(mgr)
      await InstanceRegistryTestAccess.reset()
      InstanceRegistryTestAccess.install(reg)
      setWsManager(mgr)
      await reg.start({ role: "api", pid: 1 })

      const [orgId, userId, accountId] = [id(), id(), id()]
      const ws = { send: () => {}, close: () => {}, readyState: 1 }
      await mgr.addConnection(userId, ws, [], orgId, { "mail:inbox": [accountId] })
      await mgr.setPresence(orgId, userId, "online")
      const account = { id: accountId, ownerType: "org" as const, ownerId: null }
      expect(await observer.hasOnlineUserWithMailAccess(orgId, account)).toBe(true)

      // The outage: the record lapses and the leader's sweep removes a's sockets.
      regClient.hang = true
      await client.del(LIVE_INSTANCE_KEY(a))
      await observer.cleanupDeadInstance(a)
      expect(await client.hlen(`ws:i:${a}:conns`)).toBe(0)
      expect(await observer.getPresence(orgId, userId)).toBe("offline")
      expect(await observer.hasOnlineUserWithMailAccess(orgId, account)).toBe(false)

      // Back: the next renew finds the record gone and fires the recovery hook.
      regClient.hang = false
      expect(await until(async () => (await client.hlen(`ws:i:${a}:conns`)) === 1)).toBe(true)
      expect(
        await until(async () => (await observer.getPresence(orgId, userId)) === "online"),
      ).toBe(true)
      expect(await client.scard(`ws:user:${orgId}:${userId}:conns`)).toBe(1)
      expect(await client.scard(`ws:org:${orgId}:conns`)).toBe(1)
      expect(await observer.hasOnlineUserWithMailAccess(orgId, account)).toBe(true)
      expect((await observer.getPresenceMap(orgId))[userId]).toBe("online")
    } finally {
      await InstanceRegistryTestAccess.reset()
      if (previous) setWsManager(previous)
    }
  }, 20_000)
})
