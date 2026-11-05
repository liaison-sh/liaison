// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo store's writes, shared between processes.
//
// The overlay (overlay.ts) lives in one process's memory, and a deployment
// runs several: api replicas behind a load balancer and a worker. A write (a
// tag, a note, a fulfilment, a refund, a discount) runs on whichever process
// took the tool call, while the next read lands on any other: kept only in the
// writer's memory, the order shows tagged on one replica and untagged on the
// next.
//
// So the store's WRITES are an ordered log in Redis, one list per org, and each
// process's overlay is a replica of the fixtures plus that log: before it
// answers, a process applies the entries it has not seen yet, in log order, at
// the time each was written. A write is appended first and answered from its
// own replay, so every replica applies the same writes in the same order and
// hands out the same ids. A reset (a re-seed of the org's store) bumps the
// org's epoch, so every replica starts again from the fixtures.
//
// The scenario's live order is not in the log: it is restored from its
// database mark (world/commerce-order.ts) before the log is applied, so a
// write to it (its fulfilment) finds it on every replica.
import { boundedBy } from "~/lib/bounded"
import { redis } from "~/lib/redis"
import { type AnswerInput, answerDemoShopify, isDemoShopifyStoreWrite } from "./answer"
import {
  advanceReplica,
  followReplicaEpoch,
  replicaCursor,
  resetDemoShopifyOverlay,
} from "./overlay"
import { atDemoWriteTime } from "./writes"

/** Writes one org's log takes. Past this, a write is refused (the overlay caps records too). */

/** How long one write-log call may wait on Redis before the request fails loudly. */
const REDIS_WAIT_MS = 2_000

function bounded<T>(p: Promise<T>): Promise<T> {
  return boundedBy(p, REDIS_WAIT_MS, () => new Error("demo Shopify store: Redis did not answer"))
}

const MAX_LOG_ENTRIES = 2_000
/** A demo org lives 72 hours, 7 days once it connects a service of its own. */
const LOG_TTL_SECONDS = 8 * 24 * 60 * 60

interface LoggedWrite {
  path: string
  method: string
  body: string | undefined
  /** When the write was made (ISO): what its records are stamped with. */
  at: string
  unsupported: string
  writeBlocked: string
}

function logKey(orgId: string): string {
  return `demo:shopify:log:${orgId}`
}

function epochKey(orgId: string): string {
  return `demo:shopify:epoch:${orgId}`
}

/** Serialises one org's syncs in this process: two must never apply the same entry. */
const queues = new Map<string, Promise<unknown>>()

/**
 * Bring this process's replica of the org's store up to the shared log. When
 * `answerAt` names a log position, also return the response its write got.
 */
async function syncStore(
  orgId: string,
  shape: Pick<AnswerInput, "json" | "extensions">,
  answerAt?: number,
): Promise<Response | null> {
  const previous = queues.get(orgId) ?? Promise.resolve()
  const run = previous.then(async () => {
    const epoch = (await bounded(redis.get(epochKey(orgId)))) ?? "0"
    followReplicaEpoch(orgId, epoch)
    // The live order first: a logged write to it must find it.
    const { restoreCommerceWorldOrder } = await import("~/modules/demo/world/commerce-order")
    await restoreCommerceWorldOrder(orgId)
    const from = replicaCursor(orgId).applied
    const raw = await bounded(redis.lrange(logKey(orgId), from, -1))
    // An overlay evicted or reset while the log was read starts again next time.
    const cursor = replicaCursor(orgId)
    if (cursor.epoch !== epoch || cursor.applied !== from) return null
    let answer: Response | null = null
    for (const [i, line] of raw.entries()) {
      const write = JSON.parse(line) as LoggedWrite
      const response = atDemoWriteTime(new Date(write.at), () =>
        answerDemoShopify({ ...write, orgId, json: shape.json, extensions: shape.extensions }),
      )
      advanceReplica(orgId)
      if (from + i === answerAt) answer = response
    }
    return answer
  })
  const settled = run.catch(() => undefined)
  queues.set(orgId, settled)
  void settled.then(() => {
    if (queues.get(orgId) === settled) queues.delete(orgId)
  })
  return run
}

/** The demo store's answer to one request, from this process's replica of the shared store. */
export async function answerReplicatedDemoShopify(input: AnswerInput): Promise<Response> {
  const { orgId } = input
  if (!isDemoShopifyStoreWrite(input.path, input.body)) {
    await syncStore(orgId, input)
    return answerDemoShopify(input)
  }
  await syncStore(orgId, input)
  if (replicaCursor(orgId).applied >= MAX_LOG_ENTRIES) {
    return input.json({
      data: null,
      errors: [{ message: input.writeBlocked, extensions: { code: "DEMO_WRITE_BLOCKED" } }],
      extensions: input.extensions,
    })
  }
  const write: LoggedWrite = {
    path: input.path,
    method: input.method,
    body: input.body,
    at: new Date().toISOString(),
    unsupported: input.unsupported,
    writeBlocked: input.writeBlocked,
  }
  // Appended first, answered from its own replay: every replica applies the
  // org's writes in the one order the log holds.
  const key = logKey(orgId)
  const replies = await bounded(
    redis.multi().rpush(key, JSON.stringify(write)).expire(key, LOG_TTL_SECONDS).exec(),
  )
  const [pushError, length] = replies?.[0] ?? [new Error("redis multi aborted"), null]
  if (pushError || typeof length !== "number") {
    throw pushError ?? new Error("demo Shopify store: the write log refused the write")
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = await syncStore(orgId, input, length - 1)
    if (answer) return answer
    if (replicaCursor(orgId).applied >= length) break
  }
  throw new Error("demo Shopify store: the write was not replayed")
}

/** Put a demo org's store back to the fixtures on every process. */
export async function forgetDemoShopifyStore(orgId: string): Promise<void> {
  resetDemoShopifyOverlay(orgId)
  await bounded(
    redis
      .multi()
      .incr(epochKey(orgId))
      .expire(epochKey(orgId), LOG_TTL_SECONDS)
      .del(logKey(orgId))
      .exec(),
  )
}
