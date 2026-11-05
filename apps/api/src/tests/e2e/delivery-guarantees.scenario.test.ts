// SPDX-License-Identifier: FSL-1.1-ALv2
//
// V2 — realtime delivery guarantees through the REAL pipeline:
// transactional outbox -> durable ws-fanout consumer -> Redis replay buffer ->
// a real Bun WebSocket client connected to a real spawned API server.
//
// This is the end-to-end proof deferred from F1 (buffer-before-processed +
// ordered fan-out) and F2 (durable terminal sub_run transitions):
//
//   1. Rapid same-entity events arrive on a real socket in outbox seq order,
//      every frame carries a replay id, and every processed event is a member
//      of the Redis replay buffer (`processed_at` implies "in the replay
//      buffer").
//   2. At the FIRST observation of `processed_at`, the replay buffer already
//      contains the event (the crash-window regression: an event must never be
//      stamped processed before it is replayable).
//   3. A durable terminal sub_run frame replays to a reconnecting client that
//      presents a cursor (`lastEventId`), and survives a full server restart
//      (worker restart mid-stream loses no frames, no double-processing).
//
// These tests caught a real regression while being written: the durable
// ws-fanout consumer ran at outbox phase 2a but `_wsEventId` was assigned in
// `_publishEventInternal` (phase 2b), so frames broadcast id-less and the
// replay buffer was never written. Fixed by `assignWsReplayId` at claim time
// (outbox-worker.ts); these tests pin the contract.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { TestWorld } from "@liaison/test-helpers"
import { api, connectWs, type WorkerEnv } from "@liaison/test-helpers"
import { decodeBufferedFrame } from "~/infra/websocket-replay-buffer"
import { setupScenario, teardownScenario } from "./setup"

/**
 * The replayed sub_run frame for `runId`, read off the raw messages array.
 * Replay frames precede presence_sync, so it is normally already there when
 * connectWs resolves; polls briefly (up to the 1 s the test used to sleep)
 * instead of always waiting.
 */
async function findSubRunFrame(messages: any[], runId: string): Promise<any> {
  const match = () =>
    messages.find(
      (m: any) =>
        m.type === "event" && m.payload?.entity === "sub_run" && m.payload?.data?.runId === runId,
    )
  const deadline = Date.now() + 1_000
  while (!match() && Date.now() < deadline) await Bun.sleep(10)
  return match()
}

const WS_TEST_TIMEOUT = 40_000

let env: WorkerEnv
let world: TestWorld
let url: string

function kernelSchema(): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

function bufferKey(): string {
  return `${env.redisPrefix}ws:events:{${world.org.id}}`
}

describe("Delivery guarantees (V2)", () => {
  beforeAll(async () => {
    const scenario = await setupScenario({ org: { name: "V2 Delivery Guarantees" } })
    env = scenario.env
    world = scenario.world
    url = env.serverUrl
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  // ─── V2.1 — ordered fan-out + processed_at ⇒ replay-buffer membership ────
  it(
    "V2.1 rapid same-entity updates: real socket receives frames in outbox seq order, all buffered before completion",
    async () => {
      const [u, peer] = await world.addUsers([{ name: "V2-Order" }, { name: "V2-Order-Peer" }])
      const thread = await world.threads.create(u, {
        participantIds: [peer.id],
        title: "v2 seq order",
      })

      const ws = await connectWs(url, u.token)
      try {
        // Fire 5 rapid same-entity updates. Await only the HTTP response (the
        // outbox drains asynchronously) — unlike the C3 test, there is NO
        // wait-for-frame between sends, so several events land in the same
        // outbox batch and the fan-out ordering is genuinely exercised.
        for (let i = 0; i < 5; i++) {
          const res = await api(url, `/api/threads/${thread.id}`, {
            method: "PATCH",
            token: u.token,
            body: { title: `v2-seq-${i}` },
          })
          expect(res.status).toBe(200)
        }

        // Wait for the LAST update's frame, then inspect the full arrival log.
        await ws.waitFor(
          "event",
          (m: any) =>
            m.payload?.entity === "thread" &&
            m.payload?.action === "update" &&
            m.payload?.data?.id === thread.id &&
            m.payload?.data?.changes?.title === "v2-seq-4",
          20_000,
        )

        const frames = ws.messages.filter(
          (m: any) =>
            m.type === "event" &&
            m.payload?.entity === "thread" &&
            m.payload?.action === "update" &&
            m.payload?.data?.id === thread.id &&
            typeof m.payload?.data?.changes?.title === "string" &&
            m.payload.data.changes.title.startsWith("v2-seq-"),
        )
        expect(frames.length).toBe(5)

        // Arrival order matches the API call order (the stale-status regression:
        // an out-of-order broadcast would leave the client on an older title).
        expect(frames.map((f: any) => f.payload.data.changes.title)).toEqual([
          "v2-seq-0",
          "v2-seq-1",
          "v2-seq-2",
          "v2-seq-3",
          "v2-seq-4",
        ])

        // Every frame carries a replay id and ids are strictly increasing.
        const eventIds = frames.map((f: any) => f.eventId)
        for (const id of eventIds) expect(typeof id).toBe("number")
        for (let i = 1; i < eventIds.length; i++) {
          expect(eventIds[i]).toBeGreaterThan(eventIds[i - 1])
        }

        // Outbox ground truth: the 5 rows exist, are all stamped processed, and
        // their seq order matches the broadcast arrival order exactly. Frames
        // are broadcast at phase 2a, BEFORE the (batched) phase-3 completion
        // stamp, so poll briefly for the stamp instead of asserting instantly.
        let rows: Array<{ seq: number; processed_at: string | null; payload: any }> = []
        const stampDeadline = Date.now() + 10_000
        while (Date.now() < stampDeadline) {
          rows = (await env.db.sql.unsafe(
            `SELECT seq, processed_at, payload FROM ${kernelSchema()}.pending_events
             WHERE payload->>'entity' = 'thread'
               AND payload->>'action' = 'update'
               AND payload->>'entityId' = $1
             ORDER BY seq ASC`,
            [thread.id],
          )) as unknown as Array<{ seq: number; processed_at: string | null; payload: any }>
          if (rows.length === 5 && rows.every((r) => r.processed_at !== null)) break
          await Bun.sleep(50)
        }
        expect(rows.length).toBe(5)
        for (const row of rows) expect(row.processed_at).not.toBeNull()
        expect(rows.map((r) => r.payload.data.changes.title)).toEqual(
          frames.map((f: any) => f.payload.data.changes.title),
        )

        // processed_at ⇒ replay-buffer membership: every processed event's frame
        // is present in the Redis buffer under its broadcast eventId, with the
        // same payload the socket saw.
        for (const f of frames) {
          const members = await env.redis.redis.zrangebyscore(bufferKey(), f.eventId, f.eventId)
          expect(members.length).toBe(1)
          // A member is the frame behind its 13-digit buffering-time prefix
          // (websocket-replay-buffer.ts, the age bound).
          const buffered = JSON.parse(decodeBufferedFrame(members[0]))
          expect(buffered.eventId).toBe(f.eventId)
          expect(buffered.payload.data.changes.title).toBe(f.payload.data.changes.title)
        }
      } finally {
        ws.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  // ─── V2.1b — crash-window: buffered at the FIRST sight of processed_at ───
  it(
    "V2.1b at the first observation of processed_at the event is already in the replay buffer",
    async () => {
      const [u, peer] = await world.addUsers([{ name: "V2-Window" }, { name: "V2-Window-Peer" }])
      const thread = await world.threads.create(u, {
        participantIds: [peer.id],
        title: "v2 crash window",
      })

      const res = await api(url, `/api/threads/${thread.id}`, {
        method: "PATCH",
        token: u.token,
        body: { title: "v2-window-probe" },
      })
      expect(res.status).toBe(200)

      // Tight poll on processed_at; the INSTANT it flips non-null, the buffer
      // must already contain the frame (buffer write happens in phase 2a,
      // strictly before the phase-3 stamp). If the stamp ever preceded the
      // buffer write, this check would flake red — which is the point.
      const deadline = Date.now() + 15_000
      let observedProcessed = false
      while (Date.now() < deadline) {
        const [row] = (await env.db.sql.unsafe(
          `SELECT processed_at FROM ${kernelSchema()}.pending_events
           WHERE payload->>'entity' = 'thread'
             AND payload->>'entityId' = $1
             AND payload->'data'->'changes'->>'title' = 'v2-window-probe'`,
          [thread.id],
        )) as unknown as Array<{ processed_at: string | null }>
        if (row?.processed_at) {
          observedProcessed = true
          const members = await env.redis.redis.zrangebyscore(bufferKey(), "-inf", "+inf")
          const hit = members
            .map((m) => JSON.parse(decodeBufferedFrame(m)))
            .find((m: any) => m.payload?.data?.changes?.title === "v2-window-probe")
          expect(hit).toBeDefined()
          expect(typeof hit.eventId).toBe("number")
          break
        }
        await Bun.sleep(10)
      }
      expect(observedProcessed).toBe(true)
    },
    WS_TEST_TIMEOUT,
  )

  // ─── V2.2 — durable terminal sub_run replays on reconnect with a cursor ──
  it("V2.2 terminal sub_run frame is durable: reconnecting with a cursor replays it, and it survives a server restart", async () => {
    const [u, peer] = await world.addUsers([{ name: "V2-SubRun" }, { name: "V2-SubRun-Peer" }])
    const parent = await world.threads.create(u, {
      participantIds: [peer.id],
      title: "v2 subrun parent",
    })

    const ws1 = await connectWs(url, u.token)
    let liveEventId: number
    const runId = randomUUID()
    try {
      // Queue the exact durable event shape emitSubRunStatus produces for a
      // terminal transition (F2 routes done|failed|cancelled through
      // tx.queueEvent). Inserting the outbox row directly exercises the same
      // outbox -> durable ws-fanout -> buffer -> socket path the worker uses,
      // without needing a live agent provider in e2e.
      // NOTE: the payload param MUST be the raw OBJECT — postgres.js encodes
      // a string param for a jsonb column as a JSON *scalar string* (double
      // encoding), which the outbox would then spread into character soup.
      await env.db.sql.unsafe(
        `INSERT INTO ${kernelSchema()}.pending_events (org_id, payload) VALUES ($1, $2)`,
        [
          world.org.id,
          {
            app: "kernel",
            entity: "sub_run",
            action: "update",
            entityId: runId,
            orgId: world.org.id,
            actorId: null,
            actorType: "system",
            data: {
              runId,
              parentRunId: null,
              parentThreadId: parent.id,
              status: "done",
            },
          } as never,
        ],
      )

      const live = await ws1.waitFor(
        "event",
        (m: any) => m.payload?.entity === "sub_run" && m.payload?.data?.runId === runId,
        20_000,
      )
      expect(live.payload.data.status).toBe("done")
      expect(typeof live.eventId).toBe("number")
      liveEventId = live.eventId
    } finally {
      ws1.close()
    }
    await Bun.sleep(300)

    // Reconnect with a cursor pointing just before the terminal frame — the
    // laptop-sleep case. The durable frame must replay with the SAME id.
    // Replay frames are sent BEFORE presence_sync, and connectWs's waitFor
    // cursor is already past them once the connect handshake resolves — read
    // the raw messages array directly (the B12 pattern).
    const ws2 = await connectWs(url, u.token, liveEventId - 1)
    try {
      const replayed = await findSubRunFrame(ws2.messages, runId)
      expect(replayed).toBeDefined()
      expect(replayed.eventId).toBe(liveEventId)
      expect(replayed.payload.data.status).toBe("done")
    } finally {
      ws2.close()
    }

    // Full server restart (worker crash/redeploy). The replay buffer lives in
    // Redis and the seq counter is durable, so a client with the same cursor
    // still replays the terminal frame — no frames lost across restarts.
    // App re-registration on the restarted server takes longer than the 30s
    // default (search-drift's restart uses 60s for the same reason).
    await env.restart({ timeoutMs: 90_000 })
    const ws3 = await connectWs(url, u.token, liveEventId - 1)
    try {
      const replayedAfterRestart = await findSubRunFrame(ws3.messages, runId)
      expect(replayedAfterRestart).toBeDefined()
      expect(replayedAfterRestart.eventId).toBe(liveEventId)
      expect(replayedAfterRestart.payload.data.status).toBe("done")
    } finally {
      ws3.close()
    }

    // No double-processing: exactly one outbox row for the run, stamped once,
    // with zero retry attempts.
    const rows = (await env.db.sql.unsafe(
      `SELECT processed_at, attempts FROM ${kernelSchema()}.pending_events
         WHERE payload->>'entity' = 'sub_run' AND payload->>'entityId' = $1`,
      [runId],
    )) as unknown as Array<{ processed_at: string | null; attempts: number }>
    expect(rows.length).toBe(1)
    expect(rows[0].processed_at).not.toBeNull()
    expect(rows[0].attempts).toBe(0)
  }, 180_000)
})
