// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Drain the transactional outbox in-process, so a test can assert an event's
 * effects (durable consumers, local subscribers such as audit and timeline)
 * without sleeping out the worker's poll interval.
 *
 * Each round processes one outbox batch and then awaits every local handler
 * dispatch that batch started (`flushEventHandlers`). Handlers can write new
 * outbox rows, so it repeats until two rounds in a row find nothing.
 *
 * The drain is bounded by progress, not by a round count. The outbox is shared
 * by every file of a `bun test` process, so a file's drain also delivers the
 * backlog earlier files left behind (a seeded world queues hundreds of events),
 * and the number of rounds that takes grows with the backlog, a batch at a
 * time. What must not happen is an outbox that refills as fast as it drains: a
 * handler loop. So the drain fails when the pending count makes no new low for
 * `stallRounds` rounds in a row that each delivered events, or when it runs
 * past `timeoutMs`; either way the error lists what is still pending.
 */
import { flushEventHandlers } from "~/infra/events/event-bus"
import { OutboxWorkerTestAccess, processOutboxBatch } from "~/infra/events/outbox-worker"

export interface DrainOutboxOptions {
  /** Delivering rounds without a new low in the pending count before it counts as a loop. */
  stallRounds?: number
  /** Wall-clock budget for the whole drain. */
  timeoutMs?: number
}

export async function drainOutbox(opts: DrainOutboxOptions = {}): Promise<void> {
  const stallRounds = opts.stallRounds ?? 50
  const timeoutMs = opts.timeoutMs ?? 300_000
  const startedAt = Date.now()
  let lowest = Number.POSITIVE_INFINITY
  let roundsSinceLow = 0
  let emptyRounds = 0
  let rounds = 0
  let delivered = 0
  for (;;) {
    const processed = await processOutboxBatch()
    await flushEventHandlers()
    // A macrotask boundary lets pending I/O callbacks settle before re-checking.
    await new Promise<void>((resolve) => setImmediate(resolve))
    rounds++
    delivered += processed
    if (processed === 0) {
      if (++emptyRounds >= 2) return
      continue
    }
    emptyRounds = 0
    const { total } = await OutboxWorkerTestAccess.pendingSummary(0)
    if (total < lowest) {
      lowest = total
      roundsSinceLow = 0
    } else if (++roundsSinceLow >= stallRounds) {
      throw await notSettled(
        `the pending count made no new low (${lowest}) in ${stallRounds} delivering rounds: something keeps refilling it`,
        { rounds, delivered, startedAt },
      )
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw await notSettled(`still delivering after ${timeoutMs} ms`, {
        rounds,
        delivered,
        startedAt,
      })
    }
  }
}

async function notSettled(
  reason: string,
  run: { rounds: number; delivered: number; startedAt: number },
): Promise<Error> {
  const { total, groups } = await OutboxWorkerTestAccess.pendingSummary(15)
  const pending = groups
    .map(
      (g) =>
        `  ${g.kind} x${g.count} (${g.orgs} org${g.orgs === 1 ? "" : "s"}${g.retrying > 0 ? `, ${g.retrying} retrying` : ""})`,
    )
    .join("\n")
  return new Error(
    `drainOutbox: the outbox did not settle: ${reason}. ${run.rounds} rounds, ${run.delivered} events delivered in ${Date.now() - run.startedAt} ms; ${total} still pending:\n${pending}`,
  )
}
