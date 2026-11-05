// SPDX-License-Identifier: FSL-1.1-ALv2
//
// V2 — deterministic in-process proof that the replay-buffer write PRECEDES
// the outbox `processed_at` stamp, through the REAL seams: the real outbox
// batch loop (`processOutboxBatch`), the real durable `ws-fanout` consumer
// registered by `registerEventSubscribers`, a real `WebSocketManager`, and the
// real test Redis. No mocked buffer, no mocked manager.
//
// Mechanism: durable consumers run in registration order (a Map), so a probe
// consumer registered AFTER `ws-fanout` observes the world mid-phase-2a —
// after the buffer zadd, strictly before the phase-3 completion UPDATE. The
// probe asserts, at that instant:
//   - the event already carries its replay id (`_wsEventId`, assigned at claim
//     time by `assignWsReplayId` — the fix this file pins), and
//   - the frame is already a member of the Redis replay buffer, and
//   - `processed_at` is still NULL.
// After the batch returns, `processed_at` is stamped and the member persists.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import {
  DurableConsumersTestAccess,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import { initEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch, stopOutboxWorker } from "~/infra/events/outbox-worker"
import { WebSocketManager } from "~/infra/websocket"
import { decodeBufferedFrame, replayBufferKey } from "~/infra/websocket-replay-buffer"
import { redis } from "~/lib/redis"

const TEST_ORG_ID = "00000000-0000-0000-0000-0000000000d2"
const table = `${schemaRef("kernel")}.pending_events`
const ENTITY = "outbox_ws_order_test"

interface ProbeObservation {
  entityId: string
  wsEventId: number | undefined
  bufferedAtProbe: boolean
  processedAtAtProbe: string | null
}

const probeLog: ProbeObservation[] = []

beforeAll(async () => {
  initEventBus()
  DurableConsumersTestAccess.reset()

  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG_ID}, 'V2 Outbox WS Order Org', 'v2-outbox-ws-order')
    ON CONFLICT (id) DO NOTHING`

  // Real manager + real Redis: bufferAndBroadcast executes its genuine zadd
  // (zero connected sockets — socket delivery is exercised by the e2e twin,
  // delivery-guarantees.scenario.test.ts).
  registerEventSubscribers(new WebSocketManager(redis))

  // Neutralize the timeline/audit durable consumers for these SYNTHETIC events
  // (they would try to persist timeline/audit rows for an entity that has no
  // backing table). Registration is idempotent-by-name, so overwriting keeps
  // their original position in the consumer order; `ws-fanout` stays REAL.
  registerDurableEventConsumer("timeline", async () => {})
  registerDurableEventConsumer("audit", async () => {})

  // Probe: registered after ws-fanout, so it runs mid-phase-2a, after the
  // buffer write and strictly before the phase-3 stamp.
  registerDurableEventConsumer("v2-order-probe", async (ctx) => {
    if (ctx.event.entity !== ENTITY) return
    const wsEventId = ctx.event._wsEventId
    let bufferedAtProbe = false
    if (wsEventId !== undefined) {
      const members = await redis.zrangebyscore(replayBufferKey(TEST_ORG_ID), wsEventId, wsEventId)
      bufferedAtProbe = members.length === 1
    }
    const [row] = (await sql.unsafe(`SELECT processed_at FROM ${table} WHERE id = $1`, [
      ctx.eventId,
    ])) as unknown as Array<{ processed_at: string | null }>
    probeLog.push({
      entityId: ctx.event.entityId ?? "",
      wsEventId,
      bufferedAtProbe,
      processedAtAtProbe: row?.processed_at ?? null,
    })
  })
})

afterAll(async () => {
  await stopOutboxWorker()
  DurableConsumersTestAccess.reset()
  await sql.unsafe(`DELETE FROM ${table} WHERE (payload->>'entity')::text = $1`, [ENTITY])
  await redis.del(replayBufferKey(TEST_ORG_ID))
  await redis.del(`ws:seq:${TEST_ORG_ID}`)
})

describe("outbox -> ws-fanout delivery order (V2, real consumers + real Redis)", () => {
  it("buffers every event into the replay buffer BEFORE processed_at, in seq order", async () => {
    probeLog.length = 0

    const entityIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const entityId = `v2-order-${i}-${Date.now()}`
      entityIds.push(entityId)
      // Non-kernel app name: kernel events validate against declaredEmits at
      // publish time and a synthetic entity would be rejected; apps without a
      // declared emit set pass through. The explicit ::jsonb cast makes the
      // text param parse into a jsonb OBJECT (this client passes params as raw
      // text; without the cast semantics vary by client and a string param can
      // double-encode into a jsonb scalar). The probe asserts payload fields,
      // so a double-encode fails loudly here.
      await sql.unsafe(`INSERT INTO ${table} (org_id, payload) VALUES ($1, $2::jsonb)`, [
        TEST_ORG_ID,
        JSON.stringify({
          app: "v2_order_test",
          entity: ENTITY,
          action: "created",
          entityId,
          orgId: TEST_ORG_ID,
          actorType: "system",
          data: { marker: i },
        }),
      ])
    }

    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThanOrEqual(3)

    const observations = probeLog.filter((o) => entityIds.includes(o.entityId))
    expect(observations.length).toBe(3)

    for (const obs of observations) {
      // Replay id assigned at claim time, before durable consumers ran.
      expect(typeof obs.wsEventId).toBe("number")
      // Buffer membership at probe time (mid-phase-2a) — the write preceded us.
      expect(obs.bufferedAtProbe).toBe(true)
      // Not yet stamped: the completion UPDATE is phase 3, after all consumers.
      expect(obs.processedAtAtProbe).toBeNull()
    }

    // Fan-out is outbox-seq-ordered: replay ids are strictly increasing in the
    // order the probe (and therefore the broadcast) observed the events.
    for (let i = 1; i < observations.length; i++) {
      expect(observations[i].wsEventId!).toBeGreaterThan(observations[i - 1].wsEventId!)
    }
    // And the observation order matches insertion (seq) order.
    expect(observations.map((o) => o.entityId)).toEqual(entityIds)

    // After the batch: stamped processed, and the buffer member persists.
    const rows = (await sql.unsafe(
      `SELECT payload->>'entityId' AS entity_id, processed_at FROM ${table}
       WHERE (payload->>'entity')::text = $1 ORDER BY seq ASC`,
      [ENTITY],
    )) as unknown as Array<{ entity_id: string; processed_at: string | null }>
    const mine = rows.filter((r) => entityIds.includes(r.entity_id))
    expect(mine.length).toBe(3)
    for (const row of mine) expect(row.processed_at).not.toBeNull()

    for (const obs of observations) {
      const members = await redis.zrangebyscore(
        replayBufferKey(TEST_ORG_ID),
        obs.wsEventId!,
        obs.wsEventId!,
      )
      expect(members.length).toBe(1)
      const parsed = JSON.parse(decodeBufferedFrame(members[0]!))
      expect(parsed.eventId).toBe(obs.wsEventId)
      expect(parsed.payload.entityId).toBe(obs.entityId)
    }
  }, 30_000)
})
