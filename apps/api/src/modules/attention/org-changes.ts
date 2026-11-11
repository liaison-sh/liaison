// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHICH ORGS THE STATE MATERIALIZER RUNS FOR, EACH MINUTE.
//
// The materializer (state-materializer.ts) asks every computed attention
// provider, for every active user of an org, what it would show, so it can
// email and push the items it sees for the first time. That costs a few
// hundred milliseconds of a kernel-cron slot per org, whether anything moved
// or not: at a thousand mostly idle workspaces it was more than the queue's
// three slots can give in a minute.
//
// A provider's answer changes when the org's state changes, or when time
// crosses a threshold (a token that expires, an approval wedged past its
// grace). Every state change a provider reads (an approval requested or
// decided, a connection made or dropped, a role granted, a user added) goes
// through the event outbox, so the outbox worker marks the org changed here
// once per batch, and the tick runs:
//   - every org changed since its last tick, the next minute, as before;
//   - every other org once every HEARTBEAT_MINUTES, on a fixed minute of its
//     own (a hash of its id), which bounds what time alone changes, and any
//     write a provider reads that sends no event.
//
// What users see: the feed reads the kernel's providers live; the apps' stored
// attention lists (apps/attention-store.ts) are also recomputed on this tick,
// besides after every run of the app.
// An item caused by an event is emailed and pushed as fast as before (the next
// minute). An item that appears with no event in an org where nothing else
// happened (an expiry passing on its own) goes out within HEARTBEAT_MINUTES
// instead of within a minute.
//
// Marks are scored with the time they were written: the tick reads the marks
// up to its own start and, once its jobs are added, removes only those, so a
// mark written meanwhile waits for the next tick. A Redis error on the read
// runs every org (fail-safe); a lost mark costs at most one heartbeat.

import { fnv1a } from "~/infra/jobs/fanout"
import { jobsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"

/** Sorted set: org id -> when its state last changed (ms). */
export const ORG_CHANGES_KEY = "attention:materialize:changed"

/** An org with no change is still materialized once this many minutes. */
export const HEARTBEAT_MINUTES = 10

/** Mark orgs changed (the outbox worker, once per batch). Best effort: never throws. */
export async function markOrgsChanged(
  orgIds: Iterable<string | null | undefined>,
  now: number = Date.now(),
): Promise<void> {
  const unique = [...new Set(orgIds)].filter((o): o is string => typeof o === "string" && o !== "")
  if (unique.length === 0) return
  try {
    await redis.zadd(ORG_CHANGES_KEY, ...unique.flatMap((orgId) => [now, orgId]))
  } catch (err) {
    log.warn({ err, orgs: unique.length }, "Could not mark orgs changed for the materializer")
  }
}

/** The orgs marked changed at or before `upTo` (ms). Throws on a Redis error. */
export async function readOrgsChanged(upTo: number): Promise<Set<string>> {
  return new Set(await redis.zrangebyscore(ORG_CHANGES_KEY, "-inf", upTo))
}

/** Remove the marks written at or before `upTo` (the ones a tick has just read). */
export async function clearOrgsChanged(upTo: number): Promise<void> {
  await redis.zremrangebyscore(ORG_CHANGES_KEY, "-inf", upTo)
}

/** Is this the org's own heartbeat minute? One minute in HEARTBEAT_MINUTES, fixed per org. */
export function heartbeatDue(orgId: string, epoch: number): boolean {
  const minute = Math.floor(epoch / 60_000)
  return (fnv1a(orgId) + minute) % HEARTBEAT_MINUTES === 0
}
