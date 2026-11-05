// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The replay buffer is bounded by size and age, against a real Redis (the Lua
// script is the thing under test), and a cursor that fell behind a trim
// resyncs instead of silently missing the dropped events.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import Redis from "ioredis"
import { WebSocketManager } from "~/infra/websocket"
import {
  appendToReplayBuffer,
  decodeBufferedFrame,
  REPLAY_BUFFER_MAX_AGE_MS,
  REPLAY_BUFFER_MAX_EVENTS,
  replayBufferKey,
  replayTrimmedKey,
} from "~/infra/websocket-replay-buffer"
import { env } from "~/lib/env"

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
const ORG = `replay-buffer-${crypto.randomUUID()}`
const frame = (id: number) =>
  JSON.stringify({
    type: "event",
    eventId: id,
    payload: { app: "kernel", entity: "presence", action: "update", orgId: ORG },
  })

afterEach(async () => {
  await redis.del(replayBufferKey(ORG), replayTrimmedKey(ORG), `ws:seq:${ORG}`)
})
afterAll(() => redis.quit())

describe("replay buffer bounds", () => {
  it("keeps at most REPLAY_BUFFER_MAX_EVENTS, dropping the oldest ids", async () => {
    const now = Date.now()
    const total = REPLAY_BUFFER_MAX_EVENTS + 25
    const pipe = redis.pipeline()
    for (let id = 1; id <= total; id++) {
      pipe.zadd(replayBufferKey(ORG), id, `${now}${frame(id)}`)
    }
    await pipe.exec()
    const dropped = await appendToReplayBuffer(redis, ORG, total + 1, frame(total + 1), now)
    expect(dropped).toBe(26)
    expect(await redis.zcard(replayBufferKey(ORG))).toBe(REPLAY_BUFFER_MAX_EVENTS)
    const [oldest] = await redis.zrange(replayBufferKey(ORG), "0", "0", "WITHSCORES")
    expect(JSON.parse(decodeBufferedFrame(oldest!)).eventId).toBe(27)
    expect(await redis.get(replayTrimmedKey(ORG))).toBe("26")
    expect(await redis.ttl(replayBufferKey(ORG))).toBeGreaterThan(0)
  })

  it("drops members older than REPLAY_BUFFER_MAX_AGE_MS, and pre-format members", async () => {
    const now = Date.now()
    const stale = now - REPLAY_BUFFER_MAX_AGE_MS - 1_000
    await appendToReplayBuffer(redis, ORG, 1, frame(1), stale)
    await appendToReplayBuffer(redis, ORG, 2, frame(2), stale)
    // A member written before the time prefix existed (plain JSON frame).
    await redis.zadd(replayBufferKey(ORG), 3, frame(3))
    await appendToReplayBuffer(redis, ORG, 4, frame(4), now)
    const left = await redis.zrange(replayBufferKey(ORG), "0", "-1")
    expect(left.map((m) => JSON.parse(decodeBufferedFrame(m)).eventId)).toEqual([4])
    expect(await redis.get(replayTrimmedKey(ORG))).toBe("3")
  })

  it("a fresh buffer drops nothing and records no watermark", async () => {
    expect(await appendToReplayBuffer(redis, ORG, 1, frame(1))).toBe(0)
    expect(await redis.get(replayTrimmedKey(ORG))).toBeNull()
  })
})

describe("hello replay against a trimmed buffer", () => {
  function fakeWs() {
    const frames: Array<Record<string, unknown>> = []
    return { frames, send: (m: string) => frames.push(JSON.parse(m)), readyState: 1 } as any
  }

  it("a cursor behind the trim watermark resyncs; a cursor past it replays", async () => {
    const m = new WebSocketManager(redis)
    const stale = Date.now() - REPLAY_BUFFER_MAX_AGE_MS - 1_000
    for (let id = 1; id <= 3; id++) {
      await appendToReplayBuffer(redis, ORG, id, frame(id), stale)
    }
    for (let id = 4; id <= 5; id++) {
      await appendToReplayBuffer(redis, ORG, id, frame(id))
    }
    await redis.set(`ws:seq:${ORG}`, "5")

    const behind = fakeWs()
    await m.handleHello(behind, "u1", 1, ["*"], ORG)
    expect(behind.frames).toEqual([{ type: "sync" }])

    const current = fakeWs()
    await m.handleHello(current, "u1", 4, ["*"], ORG)
    expect(current.frames.map((f: { eventId?: number }) => f.eventId)).toEqual([5])
  })
})
