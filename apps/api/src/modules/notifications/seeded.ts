// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SEED WRITES THE WORLD, IT DOES NOT HAPPEN TO ANYONE. A seed (the demo
// world, its nightly reset, a visitor's fresh workspace) writes conversations
// and pending approvals that look hours old, so every notification producer
// read them as news: a reseed sent a burst of pushes and attention rows to
// every phone signed into the org (walk 2026-10-19, #17).
//
// A seed marks what it writes with `{ seeded: true }` in the row's metadata (a
// message's, an approval's), and every producer that could notify about it
// (the push fanout, the attention translator, the state materializer) checks
// it here and stays silent. The row itself is ordinary: it reads, lists and
// decides like any other.

import { AsyncLocalStorage } from "node:async_hooks"

/** The metadata a seed writes on a row nobody should be notified about. */
export const SEEDED_METADATA = { seeded: true } as const

/** Was this row written by a seed? */
export function isSeededWrite(metadata: unknown): boolean {
  return (
    metadata !== null &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>).seeded === true
  )
}

/**
 * Metadata from an app (a sandboxed app's `messages.post`) with the seed flag removed. An app is not
 * a seed: setting the flag would post into a person's thread without notifying anyone, so only the
 * server-side seed path may write it.
 */
export function withoutSeededFlag(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {}
  const { seeded: _seeded, ...rest } = metadata
  return rest
}

// ── The seed's events ───────────────────────────────────────────────────────
//
// A SEED'S EVENTS ARE NOT NEWS EITHER. A seed writes its rows through the
// ordinary services (`createTicket`, ...), so they queue the ordinary events,
// and the outbox delivers them a moment later, after the seed has switched on
// the routines it writes. An event routine then reacted to the seed's own
// tickets as if a customer had just written: a warm-pool workspace, seeded
// before any visitor owns it, ran (or was refused, and paused) its support
// routine on its own backlog. Everything a seed queues runs inside
// `runAsSeed`, which stamps `metadata.seeded` on each event (db/queue-event.ts);
// the event routine subscriber and its reconciler drop such events.

const seedScope = new AsyncLocalStorage<true>()

/** Run `fn` as a seed: every event it queues is marked as the seed's own. */
export function runAsSeed<T>(fn: () => Promise<T>): Promise<T> {
  return seedScope.run(true, fn)
}

/** Is the current call chain a seed's (`runAsSeed`)? */
export function isSeeding(): boolean {
  return seedScope.getStore() === true
}

/** Was this event queued by a seed (`runAsSeed`)? Reads the event's own metadata. */
export function isSeededEvent(event: { metadata?: unknown }): boolean {
  return isSeededWrite(event.metadata)
}
