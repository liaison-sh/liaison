// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The durable half of a durable consumer's idempotency.
//
// `registerDurableEventConsumer` promises AT-LEAST-ONCE: the outbox row stays
// unprocessed until every consumer has run, so one consumer throwing replays
// the event for all of them, and so does a process that dies before
// `processed_at` is stamped. A consumer that only remembers what it handled in
// memory therefore re-decides an old event against the world as it is after a
// restart, which for anything whose decision depends on permissions is a
// different answer than the event deserved (A18).
//
// So a consumer that must not re-decide writes a mark here and checks it
// first. Two marks is all this is, and deliberately: it is not a delivery
// ledger and it is not an outbox offset (events are not handled in order by
// consumers).
//
// THE BOUND, EXACTLY. The mark is written AFTER the work, so a process that
// dies between the work and the write replays that work: no table closes that
// window, because the two cannot be made atomic with a side effect that leaves
// the database (a push handed to Apple is not rolled back). "Restart gap
// closed" is therefore the wrong phrase for what this does: what it closes is
// the RE-DECISION after a restart, and it narrows the replayed work to
// whatever was in flight when the process died. A caller that marks per
// recipient rather than per event (modules/push/fanout-consumer.ts) narrows
// that window to one recipient.
import { and, eq, inArray } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { durableConsumerMarks } from "~/db/schema/kernel"

// Marks are pruned by the outbox worker's own cleanup sweep, beside the rows
// they are about (outbox-worker.ts): a processed outbox row is deleted within
// the hour, so nothing can replay an event whose mark the sweep has removed.

export async function hasConsumerHandled(
  orgId: string,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "durable-consumer-mark-read", (tx) =>
    tx
      .select({ eventId: durableConsumerMarks.eventId })
      .from(durableConsumerMarks)
      .where(
        and(eq(durableConsumerMarks.consumer, consumer), eq(durableConsumerMarks.eventId, eventId)),
      )
      .limit(1),
  )
  return rows.length > 0
}

/** Idempotent: a replay that races another worker writes nothing. */
export async function markConsumerHandled(
  orgId: string,
  consumer: string,
  eventId: string,
): Promise<void> {
  await withPrivilegedDb(orgId, "durable-consumer-mark-write", (tx) =>
    tx.insert(durableConsumerMarks).values({ consumer, eventId }).onConflictDoNothing(),
  )
}

/**
 * Which of these ids this consumer has already handled, in ONE query. The
 * per-recipient callers ask about a whole fanout's worth of marks at once, and
 * a round trip per recipient inside the outbox tick is the kind of cost that
 * turns a courtesy into a stall.
 */
export async function loadHandledEventIds(
  orgId: string,
  consumer: string,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set()
  const rows = await withPrivilegedDb(orgId, "durable-consumer-marks-read", (tx) =>
    tx
      .select({ eventId: durableConsumerMarks.eventId })
      .from(durableConsumerMarks)
      .where(
        and(
          eq(durableConsumerMarks.consumer, consumer),
          inArray(durableConsumerMarks.eventId, eventIds),
        ),
      ),
  )
  return new Set(rows.map((row) => row.eventId))
}
