// SPDX-License-Identifier: FSL-1.1-ALv2
// Design audit 2026-09-30, finding 18: the outbox ran its durable consumers
// one after the other for every event, so a batch cost the sum of every
// consumer for every event and the slowest one held back everything. The
// consumers are now pipeline stages over the batch.
import { afterEach, describe, expect, it } from "bun:test"
import type { AppEvent } from "~/infra/events/event-bus"
import {
  DurableConsumersTestAccess,
  type DurableEventContext,
  registerDurableEventConsumer,
  runDurableConsumerLanes,
} from "./durable-consumers"

const ctx = (i: number): DurableEventContext => ({
  eventId: `evt-${i}`,
  event: {
    app: "kernel",
    entity: "message",
    action: "create",
    orgId: "o",
    entityId: `${i}`,
  } as AppEvent,
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("durable consumer pipeline", () => {
  afterEach(() => DurableConsumersTestAccess.reset())

  it("overlaps consumers: a batch costs the slowest stage, not the sum of stages", async () => {
    const STAGE_MS = 60
    const EVENTS = 6
    for (const name of ["a", "b", "c"]) {
      registerDurableEventConsumer(name, async () => {
        await sleep(STAGE_MS)
      })
    }
    const started = Date.now()
    const outcomes = await Promise.all(runDurableConsumerLanes([...Array(EVENTS).keys()].map(ctx)))
    const elapsed = Date.now() - started
    expect(outcomes.every((o) => o.ok)).toBe(true)
    // Serial: 6 events x 3 stages x 60 ms = 1,080 ms. Pipelined: the first
    // event through 3 stages, then one stage time per further event = 480 ms.
    expect(elapsed).toBeLessThan(EVENTS * 3 * STAGE_MS * 0.7)
  })

  it("keeps seq order per consumer and registration order per event", async () => {
    const log: string[] = []
    registerDurableEventConsumer("first", async ({ eventId }) => {
      log.push(`first:${eventId}`)
    })
    registerDurableEventConsumer("slow", async ({ eventId }) => {
      await sleep(30)
      log.push(`slow:${eventId}`)
    })
    registerDurableEventConsumer("last", async ({ eventId }) => {
      log.push(`last:${eventId}`)
    })
    const batch = [0, 1, 2, 3].map(ctx)
    await Promise.all(runDurableConsumerLanes(batch))
    for (const stage of ["first", "slow", "last"]) {
      expect(log.filter((l) => l.startsWith(`${stage}:`))).toEqual(
        batch.map((b) => `${stage}:${b.eventId}`),
      )
    }
    for (const b of batch) {
      const at = (s: string) => log.indexOf(`${s}:${b.eventId}`)
      expect(at("first")).toBeLessThan(at("slow"))
      expect(at("slow")).toBeLessThan(at("last"))
    }
    // The first stage ran ahead: it finished the batch before the slow stage's second event.
    expect(log.indexOf("first:evt-3")).toBeLessThan(log.indexOf("slow:evt-1"))
  })

  it("a failure stops that event's later consumers only; the rest of the batch flows", async () => {
    const ran: string[] = []
    registerDurableEventConsumer("broken", async ({ eventId }) => {
      if (eventId === "evt-1") throw new Error("boom")
    })
    registerDurableEventConsumer("after", async ({ eventId }) => {
      ran.push(eventId)
    })
    const outcomes = await Promise.all(runDurableConsumerLanes([0, 1, 2].map(ctx)))
    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true])
    expect(outcomes[1]).toMatchObject({ ok: false, consumer: "broken" })
    expect(ran).toEqual(["evt-0", "evt-2"])
  })

  it("bounds the number of consumer calls in flight", async () => {
    let inFlight = 0
    let peak = 0
    for (let c = 0; c < 6; c++) {
      registerDurableEventConsumer(`c${c}`, async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await sleep(10)
        inFlight--
      })
    }
    await Promise.all(runDurableConsumerLanes([...Array(8).keys()].map(ctx), 2))
    expect(peak).toBe(2)
  })
})
