// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The interception point: a demo org's API connector traffic never leaves the
// box.
//
// Registered into the transport's demo responder slot. The transport asks it
// first for every request; on a deployment that is not the demo instance the
// whole cost is one boolean read and the fixture is never loaded. On the demo
// instance a request is answered from the fixture CRM only when BOTH hold:
//
//   * the request goes to the demo fixture origin (sentinel.ts), and
//   * the org carries the demo marker.
//
// Anything else declines (null), and the transport goes on to
// `assertDemoAppFetchAllowed`, which refuses a demo org's egress before
// anything leaves the box, and lets a normal org's request through unchanged.
// A normal org is therefore never answered from the fixture, whatever URL its
// adapter carries.

import { boundedBy } from "~/lib/bounded"
import { redis } from "~/lib/redis"
import type { FixtureCrmHandler } from "~/modules/apps/connections/api/__fixtures__/fixture-crm/handler"
import { forgetCustomerLookups } from "~/modules/apps/connections/api/cache"
import type { DemoApiConnectorRequest } from "~/modules/apps/connections/api/transport"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import {
  DEMO_API_CONNECTION,
  DEMO_API_CONNECTOR_IDENTIFIER,
  DEMO_API_CONNECTOR_SENTINEL_KEY,
  isDemoApiConnectorOrigin,
} from "./sentinel"

type FixtureHandler = Pick<
  FixtureCrmHandler,
  "handle" | "notes" | "createdCompanies" | "createdContacts"
>

/**
 * One fixture CRM per demo org, shared by its reads and its writes, so a
 * contact the agent creates is found by the next lookup. A store lives for one
 * UTC day (so "last month" stays last month) and is never shared between orgs:
 * one visitor never sees what another wrote.
 *
 * Shared between processes. A deployment runs several api replicas and a
 * worker, and a write (an approved `connector_write`) runs on whichever one
 * took the request while the next read (the customer card) lands on any
 * other: a store kept only in the writer's memory answers "no customer" from
 * every other process. So the store's WRITES are an ordered log in Redis (one
 * list per org and day), and each process's in-memory store is a replica of
 * the seed plus that log: before it answers, a process applies the entries it
 * has not seen yet, in log order. A write is appended first and answered from
 * its own replay, so every replica applies the same writes in the same order
 * and hands out the same ids. A reset bumps the org's epoch, so every replica
 * starts again from the seed.
 *
 * Bounded: at most MAX_ORG_STORES replicas in memory (least recently used is
 * dropped and rebuilt from the log on its next request), and at most
 * MAX_WRITES_PER_STORE created records per store.
 */

/** How long one write-log call may wait on Redis before the request fails loudly. */
const REDIS_WAIT_MS = 2_000

function bounded<T>(p: Promise<T>): Promise<T> {
  return boundedBy(p, REDIS_WAIT_MS, () => new Error("demo fixture CRM: Redis did not answer"))
}

const MAX_ORG_STORES = 200
const MAX_WRITES_PER_STORE = 500
/** How long a day's write log is kept (it is only read on its own day). */
const LOG_TTL_SECONDS = 2 * 24 * 60 * 60

interface LoggedWrite {
  method: string
  url: string
  body?: string
  /** When the write was made (ISO): what its records are stamped with. */
  at: string
}

interface Replica {
  day: string
  epoch: string
  handler: FixtureHandler
  /** Log entries applied so far. */
  applied: number
  /** The write being replayed's time, read by the handler's clock. */
  clock: { at: Date | null }
  /** Serialises this replica's syncs: two must never apply the same entry. */
  queue: Promise<unknown>
}

const replicas = new Map<string, Replica>()

function logKey(orgId: string, day: string): string {
  return `demo:fixture-crm:log:${orgId}:${day}`
}

function epochKey(orgId: string): string {
  return `demo:fixture-crm:epoch:${orgId}`
}

async function newReplica(day: string, epoch: string): Promise<Replica> {
  const { createFixtureCrmHandler } = await import(
    "~/modules/apps/connections/api/__fixtures__/fixture-crm/handler"
  )
  const clock: { at: Date | null } = { at: null }
  const handler = createFixtureCrmHandler({
    apiKey: DEMO_API_CONNECTOR_SENTINEL_KEY,
    recordRequests: false,
    now: () => clock.at ?? new Date(),
  })
  return { day, epoch, handler, applied: 0, clock, queue: Promise.resolve() }
}

function requestOf(write: LoggedWrite): Request {
  const headers: Record<string, string> = {
    accept: "application/json",
    "X-Api-Key": DEMO_API_CONNECTOR_SENTINEL_KEY,
  }
  if (write.body !== undefined) headers["content-type"] = "application/json"
  return new Request(write.url, { method: write.method, headers, body: write.body })
}

/**
 * Bring the org's replica up to the shared log and return it; when `answerAt`
 * names a log position, also the response its write got when applied.
 */
async function syncReplica(
  orgId: string,
  answerAt?: number,
): Promise<{ replica: Replica; answer: Response | null }> {
  const day = new Date().toISOString().slice(0, 10)
  const epoch = (await bounded(redis.get(epochKey(orgId)))) ?? "0"
  let replica = replicas.get(orgId)
  replicas.delete(orgId)
  if (!replica || replica.day !== day || replica.epoch !== epoch) {
    replica = await newReplica(day, epoch)
  }
  // Re-inserting keeps the map in least-recently-used order.
  replicas.set(orgId, replica)
  while (replicas.size > MAX_ORG_STORES) {
    const oldest = replicas.keys().next().value
    if (oldest === undefined) break
    replicas.delete(oldest)
  }
  const target = replica
  const answered: { response: Response | null } = { response: null }
  const run = target.queue.then(async () => {
    const raw = await bounded(redis.lrange(logKey(orgId, day), target.applied, -1))
    for (const line of raw) {
      const position = target.applied
      const write = JSON.parse(line) as LoggedWrite
      target.clock.at = new Date(write.at)
      try {
        const res = await target.handler.handle(requestOf(write))
        if (position === answerAt) answered.response = res
      } finally {
        target.clock.at = null
      }
      target.applied += 1
    }
  })
  // A failed sync must not wedge the next one.
  target.queue = run.catch(() => undefined)
  await run
  return { replica: target, answer: answered.response }
}

/** Drop an org's fixture CRM store everywhere; its next request starts from the seed. */
export async function forgetDemoFixtureCrm(orgId: string): Promise<void> {
  replicas.delete(orgId)
  const day = new Date().toISOString().slice(0, 10)
  await bounded(
    redis
      .multi()
      .incr(epochKey(orgId))
      .expire(epochKey(orgId), LOG_TTL_SECONDS)
      .del(logKey(orgId, day))
      .exec(),
  )
  // A lookup cached before the reset would still find what the reset removed.
  await forgetCustomerLookups({ orgId, ...DEMO_API_CONNECTION }, DEMO_API_CONNECTOR_IDENTIFIER)
}

function writeCount(handler: FixtureHandler): number {
  return handler.notes.length + handler.createdCompanies.length + handler.createdContacts.length
}

/** The fixture CRM's answer for a demo org's request, or null to decline. */
export async function maybeDemoApiConnectorResponse(
  req: DemoApiConnectorRequest,
): Promise<Response | null> {
  if (!isDemoModeEnabled()) return null
  if (!isDemoApiConnectorOrigin(req.url)) return null
  const { marker } = await loadDemoOrg(req.orgId)
  if (!marker) return null

  const { replica } = await syncReplica(req.orgId)
  let body: string | undefined
  if (req.body !== undefined) body = JSON.stringify(req.body)
  const write: LoggedWrite = {
    method: req.method,
    url: req.url.toString(),
    body,
    at: new Date().toISOString(),
  }
  if (req.method === "GET") return replica.handler.handle(requestOf(write))
  if (writeCount(replica.handler) >= MAX_WRITES_PER_STORE) {
    return new Response(
      JSON.stringify({
        error: { code: "rate_limited", message: "the demo CRM takes no more writes today" },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    )
  }
  // Appended first, answered from its own replay: every replica applies the
  // org's writes in the one order the log holds.
  const key = logKey(req.orgId, replica.day)
  const [[pushError, length]] = ((await bounded(
    redis.multi().rpush(key, JSON.stringify(write)).expire(key, LOG_TTL_SECONDS).exec(),
  )) ?? [[new Error("redis multi aborted"), null]]) as [Error | null, unknown][]
  if (pushError || typeof length !== "number") {
    throw pushError ?? new Error("demo fixture CRM: the write log refused the write")
  }
  const { answer } = await syncReplica(req.orgId, length - 1)
  if (!answer) throw new Error("demo fixture CRM: the write was not replayed")
  return answer
}

/** Test seam: forget this process's replicas, as another process that never served the org. */
export const DemoFixtureCrmTestAccess = {
  dropLocalReplicas(): void {
    replicas.clear()
  },
}
