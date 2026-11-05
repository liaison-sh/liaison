// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live connection state is per org, across processes.
//
// Two WebSocketManagers (two instances of one cell) on real Redis, each holding
// a socket of org A and a socket of org B. Then:
//   keys:     every Redis key the live state wrote is read back whole (name and
//             contents); none mixes the two orgs (a key named for one org that
//             holds the other's user, or a key naming both);
//   presence: each manager's presence map of org B holds no org-A user, from
//             either instance (and A's holds its own user: positive control);
//   events:   an event of org A, buffered and broadcast on both instances (the
//             per-replica delivery), reaches A's sockets and no socket of B;
//   notify:   org A's user has no notify presence under org B.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import Redis from "ioredis"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { WebSocketManager } from "~/infra/websocket"
import { RedisLiveState } from "~/infra/websocket-state/redis"
import { env } from "~/lib/env"
import { REDIS_PREFIX, RESP_PROTOCOL } from "~/lib/redis"

const PREFIX = `${REDIS_PREFIX}liveorg:${crypto.randomUUID().slice(0, 6)}:`
const client = new Redis(env.REDIS_URL, {
  keyPrefix: PREFIX,
  protocol: RESP_PROTOCOL,
  maxRetriesPerRequest: null,
})
/** The same database without a prefix, for SCAN (which ignores keyPrefix). */
const raw = new Redis(env.REDIS_URL, { protocol: RESP_PROTOCOL, maxRetriesPerRequest: null })

const orgA = crypto.randomUUID()
const orgB = crypto.randomUUID()
const userA = crypto.randomUUID()
const userB = crypto.randomUUID()
const instX = `inst-x-${crypto.randomUUID().slice(0, 6)}`
const instY = `inst-y-${crypto.randomUUID().slice(0, 6)}`
const canary = `canary-${crypto.randomUUID().slice(0, 12)}`

interface FakeSocket {
  readyState: number
  sent: string[]
  send(data: string): void
  close(): void
}
function socket(): FakeSocket {
  const s: FakeSocket = {
    readyState: 1,
    sent: [],
    send: (d: string) => {
      s.sent.push(d)
    },
    close: () => {},
  }
  return s
}

function manager(instanceId: string): WebSocketManager {
  return new WebSocketManager(client, new RedisLiveState(client, instanceId, PREFIX), {
    instanceId,
  })
}

const x = manager(instX)
const y = manager(instY)
const sockets = { aX: socket(), bX: socket(), aY: socket(), bY: socket() }
const SCOPES = ["tickets"]

/** Every key under the prefix with its whole contents as text. */
async function dumpKeys(): Promise<Array<{ key: string; text: string }>> {
  const out: Array<{ key: string; text: string }> = []
  let cursor = "0"
  do {
    const [next, keys] = await raw.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", "1000")
    cursor = next
    for (const full of keys) {
      const type = await raw.type(full)
      let text = ""
      if (type === "string") text = String(await raw.get(full))
      else if (type === "set") text = (await raw.smembers(full)).join(" ")
      else if (type === "zset") text = (await raw.zrange(full, "0", "-1", "WITHSCORES")).join(" ")
      else if (type === "hash") text = JSON.stringify(await raw.hgetall(full))
      else if (type === "list") text = (await raw.lrange(full, 0, -1)).join(" ")
      else if (type === "stream") text = JSON.stringify(await raw.xrange(full, "-", "+"))
      out.push({ key: full.slice(PREFIX.length), text })
    }
  } while (cursor !== "0")
  return out
}

/** Keys that mix the orgs: named for one org (or user) and holding or naming the other's. */
function mixedKeys(keys: Array<{ key: string; text: string }>): string[] {
  const of = (s: string) => ({
    a: s.includes(orgA) || s.includes(userA),
    b: s.includes(orgB) || s.includes(userB),
  })
  const bad: string[] = []
  for (const { key, text } of keys) {
    const name = of(key)
    const body = of(text)
    if ((name.a && name.b) || (name.a && body.b) || (name.b && body.a)) {
      bad.push(`${key} = ${text.slice(0, 200)}`)
    }
  }
  return bad
}

beforeAll(async () => {
  for (const inst of [instX, instY]) await client.set(LIVE_INSTANCE_KEY(inst), "{}", "PX", 120_000)
  await x.addConnection(userA, sockets.aX, SCOPES, orgA)
  await x.addConnection(userB, sockets.bX, SCOPES, orgB)
  await y.addConnection(userA, sockets.aY, SCOPES, orgA)
  await y.addConnection(userB, sockets.bY, SCOPES, orgB)
  await x.setPresence(orgA, userA, "online").catch(() => undefined)
  await y.setPresence(orgB, userB, "online").catch(() => undefined)
})

afterAll(async () => {
  const keys = await raw.keys(`${PREFIX}*`)
  if (keys.length > 0) await raw.del(...keys)
  client.disconnect()
  raw.disconnect()
})

describe("live connection state is keyed per org", () => {
  it("no Redis key of the live state mixes two orgs", async () => {
    const keys = await dumpKeys()
    // Floor: the connections of both orgs are in Redis at all.
    expect(keys.some((k) => k.key.includes(orgA) || k.text.includes(userA))).toBe(true)
    expect(keys.some((k) => k.key.includes(orgB) || k.text.includes(userB))).toBe(true)
    expect(mixedKeys(keys)).toEqual([])
  })

  it("presence of org B lists no org-A user, from either instance", async () => {
    for (const m of [x, y]) {
      const presenceA = await m.getPresenceMap(orgA)
      expect(Object.keys(presenceA)).toContain(userA)
      const presenceB = await m.getPresenceMap(orgB)
      expect(Object.keys(presenceB)).toContain(userB)
      expect(Object.keys(presenceB)).not.toContain(userA)
    }
  })

  it("an event of org A reaches A's sockets on every instance and no socket of B", async () => {
    for (const s of Object.values(sockets)) s.sent.length = 0
    const event = {
      app: "tickets",
      entity: "tickets",
      action: "updated",
      entityId: crypto.randomUUID(),
      data: { subject: canary },
      orgId: orgA,
      actorId: userA,
    }
    await x.bufferAndBroadcast(event)
    await y.broadcast(event)
    expect(sockets.aX.sent.join("")).toContain(canary)
    expect(sockets.aY.sent.join("")).toContain(canary)
    expect(sockets.bX.sent.join("")).not.toContain(canary)
    expect(sockets.bY.sent.join("")).not.toContain(canary)
    expect(mixedKeys(await dumpKeys())).toEqual([])
  })

  it("org A's user has no notify presence under org B", async () => {
    for (const m of [x, y]) {
      expect(await m.listNotifyPresence(orgB, userA)).toEqual([])
    }
  })
})
