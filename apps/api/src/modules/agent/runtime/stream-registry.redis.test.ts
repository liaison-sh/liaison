// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The live turn registry across processes (S6, S28, P2-1, P2-2, P2-13). Real
// Redis under a non-empty key prefix (`<run prefix>tt:`): the scripts build
// the heartbeat, meta and thread-index keys inside Lua from the prefix they
// receive in ARGV, so a script that dropped it would read every owner dead and
// list nothing. Two registry handles with different instance ids stand for two
// processes: the second one never sees the first one's module state.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import Redis from "ioredis"
import { InstanceRegistry, LIVE_INSTANCE_KEY, type RegistryRedis } from "~/infra/instance-registry"
import { LeadershipTestAccess, startLeadership } from "~/infra/leadership"
import { env } from "~/lib/env"
import { REDIS_PREFIX, RESP_PROTOCOL } from "~/lib/redis"
import {
  type LiveAgentTurnChange,
  LiveTurnRegistry,
  liveTurnKey,
  registerLiveTurnHooks,
  type TurnRedis,
} from "./stream-registry"

const PREFIX = `${REDIS_PREFIX}tt:`
const client = new Redis(env.REDIS_URL, {
  keyPrefix: PREFIX,
  protocol: RESP_PROTOCOL,
  maxRetriesPerRequest: null,
})
const subscribers: Redis[] = []
const registries: InstanceRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.stop({ releaseOwned: false })
  await LeadershipTestAccess.reset()
})

afterAll(async () => {
  const keys = await client.keys(`${PREFIX}*`)
  // `keys` answers full names; `del` would prefix them again.
  if (keys.length > 0) await client.del(...keys.map((k) => k.slice(PREFIX.length)))
  for (const s of subscribers) s.disconnect()
  client.disconnect()
})

const id = () => crypto.randomUUID()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: condition never met")
    await sleep(10)
  }
}

/** A heartbeat record as the instance registry writes it. */
async function markLive(instanceId: string): Promise<void> {
  await client.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 30_000)
}

/** Counts the commands a registry sends, so a test can prove which reads it made. */
class CountingClient implements TurnRedis, RegistryRedis {
  xranges = 0
  /** Script calls, by body or by hash. */
  evals = 0
  /** Script calls that sent the whole body. */
  fullEvals = 0
  evalshas = 0
  /** Answer NOSCRIPT to this many EVALSHA calls, as Redis does after a restart or SCRIPT FLUSH. */
  noscript = 0
  hang = false
  constructor(private readonly inner: Redis) {}
  private gate<T>(p: () => Promise<T>): Promise<T> {
    return this.hang ? new Promise<T>(() => {}) : p()
  }
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.evals++
    this.fullEvals++
    return this.gate(() => this.inner.eval(script, numKeys, ...args))
  }
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    this.evals++
    this.evalshas++
    if (this.noscript > 0) {
      this.noscript--
      return Promise.reject(new Error("NOSCRIPT No matching script. Please use EVAL."))
    }
    return this.gate(() => this.inner.evalsha(sha, numKeys, ...args))
  }
  xrange(key: string, start: string, end: string): Promise<[string, string[]][]> {
    this.xranges++
    return this.gate(() => this.inner.xrange(key, start, end))
  }
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    return this.gate(() => this.inner.hmget(key, ...fields))
  }
  publish(channel: string, message: string): Promise<number> {
    return this.gate(() => this.inner.publish(channel, message))
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

function turns(
  instanceId: string = id(),
  opts: { client?: TurnRedis; checkpointEvery?: number } = {},
): LiveTurnRegistry {
  const sub = client.duplicate()
  subscribers.push(sub)
  return new LiveTurnRegistry({
    client: opts.client ?? client,
    subscriber: sub,
    instanceId,
    prefix: PREFIX,
    ...(opts.checkpointEvery ? { checkpointEvery: opts.checkpointEvery } : {}),
  })
}

const ORG = "22222222-2222-2222-2222-222222222222"

describe("live turns across processes", () => {
  it("a turn recorded by one registry instance is listed by another", async () => {
    const a = turns()
    const b = turns()
    await markLive(a.instanceId)
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1", requesterId: "u1" }
    await a.record(thread, ORG, "start", {}, vis)
    await a.record(thread, ORG, "delta", { delta: "hello" }, { ...vis, accumulatedScopes: [] })

    const seen = await b.list(thread)
    expect(seen.length).toBe(1)
    expect(seen[0]?.content).toBe("hello")
    expect(seen[0]?.seq).toBe(2)
    expect(seen[0]?.requesterId).toBe("u1")
    expect(seen[0]?.timeline).toEqual([{ kind: "text", text: "hello", itemId: "t0" }])
    expect((await b.get(thread, "agent-1"))?.turnId).toBe("ask-1")
  })

  it("seq is per turn, strictly increasing, across two producers", async () => {
    const a = turns()
    const b = turns()
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1" }
    const other = { agentId: "agent-1", turnId: "ask-2" }
    const seqs: number[] = []
    seqs.push((await a.record(thread, ORG, "start", {}, vis)).seq)
    // Unawaited and interleaved, as two replicas posting node progress do.
    const pending = []
    for (let i = 0; i < 20; i++) {
      const who = i % 2 === 0 ? a : b
      pending.push(who.record(thread, ORG, "delta", { delta: `${i}` }, vis))
    }
    seqs.push(...(await Promise.all(pending)).map((f) => f.seq))
    // Another turn of the same thread has its own counter.
    expect((await b.record(thread, ORG, "start", {}, other)).seq).toBe(1)
    expect([...seqs].sort((x, y) => x - y)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1))
    expect(new Set(seqs).size).toBe(21)
  })

  it("items follow the coalescing rule across two producers", async () => {
    const a = turns()
    const b = turns()
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1" }
    await a.record(thread, ORG, "start", {}, vis)
    const frames = [
      await a.record(thread, ORG, "reasoning", { delta: "a" }, vis),
      await b.record(thread, ORG, "reasoning", { delta: "b" }, vis),
      await a.record(thread, ORG, "tool_call", { toolCallId: "x", toolName: "search" }, vis),
      await b.record(thread, ORG, "delta", { delta: "c" }, vis),
      await a.record(thread, ORG, "delta", { delta: "d" }, vis),
      await b.record(thread, ORG, "reasoning", { delta: "e" }, vis),
    ]
    expect(frames.map((f) => f.itemId)).toEqual(["r0", "r0", "x", "t2", "t2", "r3"])
    expect(frames.map((f) => f.itemKind)).toEqual([
      "reasoning",
      "reasoning",
      "tool",
      "text",
      "text",
      "reasoning",
    ])
    expect(frames.map((f) => f.seq)).toEqual([2, 3, 4, 5, 6, 7])
    const result = await b.record(thread, ORG, "tool_result", { toolCallId: "x", result: {} }, vis)
    expect(result).toEqual({ seq: 8, itemId: "x", itemKind: "tool" })
    // The fold keys its timeline by the same ids.
    await markLive(a.instanceId)
    const snap = (await b.list(thread))[0]
    expect(snap?.timeline.map((e) => e.itemId)).toEqual(["r0", "x", "t2", "r3"])
  })

  it("a re-sent tool_call keeps its item and gets a new seq without a new item", async () => {
    const a = turns()
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1" }
    await a.record(thread, ORG, "start", {}, vis)
    const first = await a.record(thread, ORG, "tool_call", { toolCallId: "x", toolName: "s" }, vis)
    const again = await a.record(thread, ORG, "tool_call", { toolCallId: "x", toolName: "s" }, vis)
    const next = await a.record(thread, ORG, "delta", { delta: "ok" }, vis)
    expect(first).toEqual({ seq: 2, itemId: "x", itemKind: "tool" })
    expect(again).toEqual({ seq: 3, itemId: "x", itemKind: "tool" })
    // Item 0 is x; the re-send did not open item 1, so the text is t1.
    expect(next.itemId).toBe("t1")
    const snap = (await a.list(thread))[0]
    expect(snap?.toolCalls.length).toBe(1)
  })

  it("start and terminal frames carry a seq and no item", async () => {
    const a = turns()
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1" }
    expect(await a.record(thread, ORG, "start", {}, vis)).toEqual({ seq: 1 })
    expect(await a.record(thread, ORG, "done", {}, vis)).toEqual({ seq: 2 })
  })

  it("a terminal event removes the turn from the thread index but keeps the stream for the TTL", async () => {
    const a = turns()
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1" }
    await a.record(thread, ORG, "start", {}, vis)
    await a.record(thread, ORG, "delta", { delta: "x" }, { ...vis, accumulatedScopes: [] })
    const k = liveTurnKey(thread, "agent-1", "ask-1")
    expect(await client.ttl(`agent:turn:${k}`)).toBeGreaterThan(env.AGENT_TURN_STREAM_TTL_S)
    await a.record(thread, ORG, "done", {}, vis)

    expect(await a.list(thread)).toEqual([])
    expect(await client.sismember(`agent:live:thread:${thread}`, k)).toBe(0)
    expect(await client.xlen(`agent:turn:${k}`)).toBe(3)
    for (const key of [`agent:turn:${k}`, `agent:turn:${k}:seq`, `agent:turn:${k}:meta`]) {
      const ttl = await client.ttl(key)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(env.AGENT_TURN_STREAM_TTL_S)
    }
  })

  it("every record refreshes the TTL of the stream, :seq and :meta", async () => {
    const a = turns()
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1" }
    await a.record(thread, ORG, "start", {}, vis)
    const k = liveTurnKey(thread, "agent-1", "ask-1")
    for (const key of [`agent:turn:${k}`, `agent:turn:${k}:seq`, `agent:turn:${k}:meta`]) {
      await client.expire(key, 5)
    }
    await a.record(thread, ORG, "delta", { delta: "x" }, vis)
    for (const key of [`agent:turn:${k}`, `agent:turn:${k}:seq`, `agent:turn:${k}:meta`]) {
      expect(await client.ttl(key)).toBeGreaterThan(660)
    }
  })

  it("a remote turn change reaches a listener in the other process, once in its own", async () => {
    const a = turns()
    const b = turns()
    const thread = id()
    const seenA: LiveAgentTurnChange[] = []
    const seenB: LiveAgentTurnChange[] = []
    a.onChange((c) => seenA.push(c))
    b.onChange((c) => seenB.push(c))
    await a.subscribeChanges()
    await b.subscribeChanges()

    const vis = { agentId: "agent-1", turnId: "ask-1", requesterId: "u1" }
    await a.record(thread, ORG, "start", {}, vis)
    await waitFor(() => seenB.length === 1)
    expect(seenB[0]).toEqual({ threadId: thread, orgId: ORG, requesterId: "u1", running: true })
    await a.record(thread, ORG, "done", {}, vis)
    await waitFor(() => seenB.length === 2)
    expect(seenB[1]?.running).toBe(false)
    await sleep(100)
    // Its own echo off the channel is dropped: A heard each change once.
    expect(seenA.map((c) => c.running)).toEqual([true, false])
  })

  it("a dead owner's turn is not listed", async () => {
    const a = turns()
    const b = turns()
    const thread = id()
    await a.record(thread, ORG, "start", {}, { agentId: "agent-1", turnId: "ask-1" })
    // A has no heartbeat record: B ignores its turn, A still lists its own.
    expect(await b.list(thread)).toEqual([])
    expect(await b.listMeta(thread)).toEqual([])
    expect((await a.list(thread)).length).toBe(1)
    await markLive(a.instanceId)
    expect((await b.list(thread)).length).toBe(1)
  })

  it("the meta-only read lists the turn without reading its stream", async () => {
    const counting = new CountingClient(client)
    const a = turns()
    const b = turns(id(), { client: counting })
    await markLive(a.instanceId)
    const thread = id()
    await a.record(
      thread,
      ORG,
      "start",
      {},
      { agentId: "agent-1", turnId: "ask-1", requesterId: "u1" },
    )
    await a.record(thread, ORG, "delta", { delta: "x" }, { agentId: "agent-1", turnId: "ask-1" })

    const metas = await b.listMeta(thread)
    expect(metas.map((m) => [m.agentId, m.turnId, m.requesterId, m.instanceId, m.phase])).toEqual([
      ["agent-1", "ask-1", "u1", a.instanceId, "started"],
    ])
    expect(counting.xranges).toBe(0)
    expect(counting.evals).toBe(1)
    await b.list(thread)
    expect(counting.xranges).toBe(1)
  })

  it("frames run the record script by its hash, falling back to the body once on NOSCRIPT", async () => {
    const counting = new CountingClient(client)
    const a = turns(id(), { client: counting })
    await markLive(a.instanceId)
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1", requesterId: "u1" }
    counting.noscript = 1
    await a.record(thread, ORG, "start", {}, vis)
    await a.record(thread, ORG, "delta", { delta: "he" }, { ...vis, accumulatedScopes: [] })
    await a.record(thread, ORG, "delta", { delta: "llo" }, { ...vis, accumulatedScopes: [] })
    expect(counting.evalshas).toBe(3)
    // The one NOSCRIPT answer is the only time the whole script was sent.
    expect(counting.fullEvals).toBe(1)
    expect((await a.list(thread))[0]?.content).toBe("hello")
  })

  it("a read Redis does not answer rejects within the bound", async () => {
    const counting = new CountingClient(client)
    const b = new LiveTurnRegistry({
      client: counting,
      subscriber: client.duplicate(),
      instanceId: id(),
      prefix: PREFIX,
      commandTimeoutMs: 150,
    })
    counting.hang = true
    const started = Date.now()
    await expect(b.listMeta(id())).rejects.toThrow(/did not answer/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("checkpoint (P2-2)", () => {
  it("a turn past the checkpoint keeps its content, its seq, its item ids and its fail-closed tag", async () => {
    const a = turns(id(), { checkpointEvery: 5 })
    const b = turns()
    await markLive(a.instanceId)
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1", requesterId: "owner" }
    await a.record(thread, ORG, "start", {}, { ...vis, accumulatedScopes: [] })
    await a.record(
      thread,
      ORG,
      "reasoning",
      { delta: "think" },
      { ...vis, accumulatedScopes: ["a:read"] },
    )
    // Untagged content: the blob is fail closed from here on.
    await a.record(thread, ORG, "tool_call", { toolCallId: "x", toolName: "s" }, vis)
    for (let i = 0; i < 12; i++) {
      await a.record(
        thread,
        ORG,
        "delta",
        { delta: `${i},` },
        { ...vis, accumulatedScopes: ["b:read"] },
      )
    }
    const k = liveTurnKey(thread, "agent-1", "ask-1")
    // Checkpoints at seq 5, 10 and 15 trimmed what they cover: no `start` is left.
    await waitFor(async () => {
      const raw = await client.xrange(`agent:turn:${k}`, "-", "+")
      return raw.every(([, f]) => f[3] !== "start") && raw.length < 15
    })
    const raw = await client.xrange(`agent:turn:${k}`, "-", "+")
    expect(raw.length).toBeLessThan(15)

    const snap = (await b.list(thread))[0]
    expect(snap?.content).toBe(Array.from({ length: 12 }, (_, i) => `${i},`).join(""))
    expect(snap?.reasoning).toBe("think")
    expect(snap?.seq).toBe(15)
    expect(snap?.requesterId).toBe("owner")
    expect(snap?.scopesUndeterminable).toBe(true)
    expect(snap?.accumulatedScopes).toBeNull()
    expect(snap?.timeline.map((e) => e.itemId)).toEqual(["r0", "x", "t2"])
    // The next frame continues the same items and seq.
    const next = await a.record(thread, ORG, "delta", { delta: "end" }, vis)
    expect(next).toEqual({ seq: 16, itemId: "t2", itemKind: "text" })
  })

  it("entries another producer adds while a checkpoint is written survive the trim", async () => {
    const a = turns(id(), { checkpointEvery: 3 })
    const b = turns(id(), { checkpointEvery: 3 })
    await markLive(a.instanceId)
    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1" }
    await a.record(thread, ORG, "start", {}, vis)
    await a.record(thread, ORG, "delta", { delta: "1" }, { ...vis, accumulatedScopes: [] })
    // Seq 3 triggers A's checkpoint; B keeps writing at the same time.
    const writes = [
      a.record(thread, ORG, "delta", { delta: "2" }, { ...vis, accumulatedScopes: [] }),
    ]
    for (let i = 3; i < 8; i++) {
      writes.push(
        b.record(thread, ORG, "delta", { delta: `${i}` }, { ...vis, accumulatedScopes: [] }),
      )
    }
    await Promise.all(writes)
    await sleep(100)
    const snap = (await b.list(thread))[0]
    expect([...(snap?.content ?? "")].sort().join("")).toBe("1234567")
    expect(snap?.seq).toBe(8)
  })
})

describe("dead instance and recovery (P2-1)", () => {
  it("the sweep takes a dead owner's turn off and tells listeners; the owner puts it back on recovery", async () => {
    const setKey = `live:instances:test:${id()}`
    const hangable = new CountingClient(client)
    const mk = (c: RegistryRedis) => {
      const r = new InstanceRegistry({
        instanceId: id(),
        client: c,
        prefix: PREFIX,
        setKey,
        ttlMs: 300,
        heartbeatMs: 100,
        sweepIntervalMs: 100,
        commandTimeoutMs: 200,
      })
      registries.push(r)
      return r
    }
    const leader = mk(client)
    const regA = mk(hangable)
    await leader.start({ role: "all", pid: 1 })
    await regA.start({ role: "api", pid: 2 })
    const ta = turns(regA.instanceId)
    const tl = turns(leader.instanceId)
    registerLiveTurnHooks(leader, tl)
    registerLiveTurnHooks(regA, ta)
    const changes: LiveAgentTurnChange[] = []
    tl.onChange((c) => changes.push(c))
    await tl.subscribeChanges()

    const thread = id()
    const vis = { agentId: "agent-1", turnId: "ask-1", requesterId: "u1" }
    await ta.record(thread, ORG, "start", {}, vis)
    await ta.record(
      thread,
      ORG,
      "delta",
      { delta: "still here" },
      { ...vis, accumulatedScopes: [] },
    )
    await waitFor(() => changes.length === 1)
    expect((await tl.list(thread)).length).toBe(1)

    leader.registerSweep(`live-turns-test-sweep-${id()}`)
    await startLeadership({
      role: "all",
      lease: { key: `live-turns-test:${id()}`, ttlMs: 3_000, renewMs: 1_000, pollMs: 250 },
    })

    hangable.hang = true // A's heartbeat lapses, the sweep takes its turn off
    await waitFor(() => changes.some((c) => !c.running), 5_000)
    expect(changes.find((c) => !c.running)).toEqual({
      threadId: thread,
      orgId: ORG,
      requesterId: "u1",
      running: false,
    })
    const k = liveTurnKey(thread, "agent-1", "ask-1")
    expect(await client.sismember(`agent:live:thread:${thread}`, k)).toBe(0)
    const ttl = await client.ttl(`agent:turn:${k}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(env.AGENT_TURN_STREAM_TTL_S)

    hangable.hang = false // A is back: it puts back the turn it still runs
    await waitFor(async () => (await tl.list(thread)).length === 1, 5_000)
    expect((await tl.list(thread))[0]?.content).toBe("still here")
    expect(await client.ttl(`agent:turn:${k}`)).toBeGreaterThan(env.AGENT_TURN_STREAM_TTL_S)
  })
})
