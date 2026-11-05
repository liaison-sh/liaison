// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Durable event consumers: run before the outbox marks an event processed.
//
// A PIPELINE, ONE STAGE PER CONSUMER. The outbox used to run every consumer
// for event 1, then every consumer for event 2, and so on, so a batch cost the
// SUM of every consumer's time for every event, and the slowest consumer
// (search indexing, a push fanout) held back everything behind it. Now each
// consumer is a stage that walks the batch in `seq` order, and the stages
// overlap: while the search indexer is on event 1, the WebSocket fan-out can
// already be on event 5. What that keeps and what it changes:
//   - per consumer, events are still handled one at a time, in `seq` order
//     (the ws-fanout ordering contract lives here);
//   - per event, consumers still run in registration order, each only after
//     the previous one succeeded on that event: a later consumer may rely on
//     an earlier one's writes (the fan-out tells clients to refetch what the
//     timeline consumer has just written), and a failure still stops the
//     event's later consumers, as before;
//   - a batch now costs about (first event through every stage) + (the
//     slowest stage x the rest of the batch), instead of the sum of every
//     stage for every event;
//   - total concurrent consumer calls are bounded (OUTBOX_CONSUMER_PARALLELISM,
//     default 4) so a batch cannot flood the database pool.
import type { AppEvent } from "~/infra/events/event-bus"
import { env } from "~/lib/env"
import { eventsLogger as log } from "~/lib/logger"

export interface DurableEventContext {
  eventId: string
  event: AppEvent
}

export type DurableEventHandler = (ctx: DurableEventContext) => Promise<void>

export type DurableOutcome = { ok: true } | { ok: false; consumer: string; err: unknown }

const consumers = new Map<string, DurableEventHandler>()

/** A consumer call slower than this is logged by name: the stage it holds up is visible. */
const SLOW_CONSUMER_MS = 2_000

/**
 * Register a handler called for every durable event before the outbox marks
 * the event as `processed_at`. Handlers must be idempotent — they may be
 * invoked multiple times for the same event on crash/restart. If any handler
 * throws, the outbox row stays unprocessed and is retried on the next poll.
 */
export function registerDurableEventConsumer(name: string, handler: DurableEventHandler): void {
  consumers.set(name, handler)
}

/** A counting semaphore: at most `limit` holders at once, FIFO. */
function semaphore(limit: number): { acquire(): Promise<void>; release(): void } {
  let held = 0
  const waiters: Array<() => void> = []
  return {
    acquire() {
      if (held < limit) {
        held++
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => waiters.push(resolve))
    },
    release() {
      const next = waiters.shift()
      if (next) next()
      else held--
    },
  }
}

async function runOne(
  name: string,
  handler: DurableEventHandler,
  ctx: DurableEventContext,
  slots: ReturnType<typeof semaphore>,
): Promise<DurableOutcome> {
  await slots.acquire()
  const started = Date.now()
  try {
    await handler(ctx)
    return { ok: true }
  } catch (err) {
    log.error(
      {
        err,
        consumer: name,
        eventId: ctx.eventId,
        app: ctx.event.app,
        entity: ctx.event.entity,
        action: ctx.event.action,
        entityId: ctx.event.entityId,
      },
      "Durable consumer failed",
    )
    return { ok: false, consumer: name, err }
  } finally {
    slots.release()
    const ms = Date.now() - started
    if (ms > SLOW_CONSUMER_MS) {
      log.warn({ consumer: name, eventId: ctx.eventId, ms }, "Slow durable consumer")
    }
  }
}

/**
 * Run every registered consumer over a batch as a pipeline (see header).
 * Returns one promise per event, in batch order, settling once the event has
 * been through every consumer: `ok`, or the failure that stopped it. Never
 * rejects.
 */
export function runDurableConsumerLanes(
  batch: readonly DurableEventContext[],
  parallelism: number = env.OUTBOX_CONSUMER_PARALLELISM,
): Array<Promise<DurableOutcome>> {
  const stages = [...consumers]
  const slots = semaphore(Math.max(1, parallelism))
  // done[c][i]: consumer c's outcome for event i. Stage c starts event i once
  // it has finished event i - 1 (its own order) AND stage c - 1 has finished
  // event i (the event's order).
  const done: Array<Array<Promise<DurableOutcome>>> = []
  stages.forEach(([name, handler], c) => {
    const row: Array<Promise<DurableOutcome>> = []
    let previous: Promise<unknown> = Promise.resolve()
    for (let i = 0; i < batch.length; i++) {
      const upstream = c > 0 ? done[c - 1]![i]! : Promise.resolve<DurableOutcome>({ ok: true })
      const cell = Promise.all([previous, upstream]).then(([, up]) =>
        up.ok ? runOne(name, handler, batch[i]!, slots) : up,
      )
      row.push(cell)
      previous = cell
    }
    done.push(row)
  })
  return batch.map((_, i) =>
    stages.length === 0
      ? Promise.resolve<DurableOutcome>({ ok: true })
      : done[stages.length - 1]![i]!,
  )
}

/** Run all registered durable consumers for one event. Throws on any failure. */
export async function runDurableConsumers(ctx: DurableEventContext): Promise<void> {
  const [outcome] = runDurableConsumerLanes([ctx])
  const result = await outcome
  if (result && !result.ok) throw result.err
}

export function durableConsumerCount(): number {
  return consumers.size
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const DurableConsumersTestAccess = {
  reset(): void {
    consumers.clear()
  },
}
