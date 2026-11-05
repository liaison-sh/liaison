// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Drain the transactional outbox in-process, so a test can assert an event's
 * effects (durable consumers, local subscribers such as audit and timeline)
 * without sleeping out the worker's poll interval.
 *
 * Each round processes one outbox batch and then awaits every local handler
 * dispatch that batch started (`flushEventHandlers`). Handlers can write new
 * outbox rows, so it repeats until two rounds in a row find nothing. Throws if
 * the outbox never empties, rather than hanging the test.
 */
import { flushEventHandlers } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"

export async function drainOutbox(opts: { maxRounds?: number } = {}): Promise<void> {
  const maxRounds = opts.maxRounds ?? 100
  let emptyRounds = 0
  for (let round = 0; round < maxRounds; round++) {
    const processed = await processOutboxBatch()
    await flushEventHandlers()
    // A macrotask boundary lets pending I/O callbacks settle before re-checking.
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (processed === 0) {
      if (++emptyRounds >= 2) return
    } else {
      emptyRounds = 0
    }
  }
  throw new Error(`drainOutbox: outbox still had events after ${maxRounds} rounds`)
}
