// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cross-process delivery over real Redis. A process with a generic `onEvent`
// handler must receive another process's publication of any event, not only
// those on channels it subscribed itself with `subscribeToEvent`: the
// per-replica handlers (socket close on a permission change, WS fan-out,
// presence) subscribe no channel. The "other process" here is a raw PUBLISH on
// the events channel with a `_msgId` this process never published, exactly what
// a peer's `_publishEventInternal` puts on the wire.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import {
  type AppEvent,
  flushEventHandlers,
  initEventBus,
  onEvent,
  resetEventBus,
  subscribeToEvent,
} from "~/infra/events/event-bus"
import { REDIS_PREFIX, redis, redisSub } from "~/lib/redis"

const ORG = "00000000-0000-0000-0000-0000000000b8"

function channelOf(app: string, entity: string, action: string): string {
  return `${REDIS_PREFIX}events:${app}:${entity}:${action}`
}

/** Publish `event` as a peer process would, on its own events channel. */
async function publishAsPeer(event: AppEvent): Promise<void> {
  await redis.publish(
    channelOf(event.app, event.entity, event.action),
    JSON.stringify({ ...event, _msgId: crypto.randomUUID() }),
  )
}

/** Poll until `done()` holds or `ms` elapse. */
async function waitFor(done: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Let any duplicate delivery land before counting. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300))
  await flushEventHandlers()
}

function uniqueEvent(): AppEvent {
  const tag = crypto.randomUUID().slice(0, 8)
  return {
    app: "xproc",
    entity: `item${tag}`,
    action: "changed",
    entityId: `item-${tag}`,
    orgId: ORG,
  }
}

beforeAll(() => {
  resetEventBus()
  redisSub.removeAllListeners("message")
  redisSub.removeAllListeners("pmessage")
})

afterAll(() => {
  redisSub.removeAllListeners("message")
  redisSub.removeAllListeners("pmessage")
  resetEventBus()
})

describe("event bus cross-process delivery", () => {
  beforeEach(() => {
    initEventBus()
  })
  afterEach(async () => {
    await flushEventHandlers()
    redisSub.removeAllListeners("message")
    redisSub.removeAllListeners("pmessage")
    resetEventBus()
  })

  it("an onEvent per-replica handler receives a peer's event on a channel nobody subscribed", async () => {
    const event = uniqueEvent()
    const seen: AppEvent[] = []
    onEvent(
      async (e) => {
        if (e.entity === event.entity) seen.push(e)
      },
      { delivery: "per-replica" },
    )

    // Retry the peer publish until the subscription is live (it is set up
    // asynchronously); each attempt is a distinct message, so stop at the first.
    const deadline = Date.now() + 3000
    while (seen.length === 0 && Date.now() < deadline) {
      await publishAsPeer(event)
      await waitFor(() => seen.length > 0, 200)
    }
    await settle()

    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[0]._remote).toBe(true)
    expect(seen[0].entityId).toBe(event.entityId)
  })

  it("a once onEvent handler never runs on a peer's copy", async () => {
    const event = uniqueEvent()
    let onceCalls = 0
    let replicaCalls = 0
    onEvent(
      async (e) => {
        if (e.entity === event.entity) onceCalls++
      },
      { delivery: "once" },
    )
    onEvent(
      async (e) => {
        if (e.entity === event.entity) replicaCalls++
      },
      { delivery: "per-replica" },
    )

    const deadline = Date.now() + 3000
    while (replicaCalls === 0 && Date.now() < deadline) {
      await publishAsPeer(event)
      await waitFor(() => replicaCalls > 0, 200)
    }
    await settle()

    expect(replicaCalls).toBeGreaterThanOrEqual(1)
    expect(onceCalls).toBe(0)
  })

  it("a channel subscribed explicitly and through the pattern dispatches once", async () => {
    const warmup = uniqueEvent()
    const event: AppEvent = { ...uniqueEvent(), entity: warmup.entity, entityId: "real" }
    const globalSeen: string[] = []
    const channelSeen: string[] = []
    onEvent(
      async (e) => {
        if (e.entity === warmup.entity) globalSeen.push(e.entityId ?? "")
      },
      { delivery: "per-replica" },
    )
    await subscribeToEvent(
      warmup.app,
      warmup.entity,
      warmup.action,
      async (e) => {
        channelSeen.push(e.entityId ?? "")
      },
      { delivery: "per-replica" },
    )

    // Warm up until the global (pattern) path delivers, so both subscriptions
    // are live before the counted publish.
    const deadline = Date.now() + 3000
    while (!globalSeen.includes(warmup.entityId ?? "") && Date.now() < deadline) {
      await publishAsPeer(warmup)
      await waitFor(() => globalSeen.includes(warmup.entityId ?? ""), 200)
    }
    expect(globalSeen).toContain(warmup.entityId ?? "")
    await settle()

    await publishAsPeer(event)
    await waitFor(() => globalSeen.includes("real") && channelSeen.includes("real"))
    await settle()

    expect(globalSeen.filter((id) => id === "real")).toHaveLength(1)
    expect(channelSeen.filter((id) => id === "real")).toHaveLength(1)
  })

  it("a process's own publication is not dispatched again from the pattern", async () => {
    const { _publishEventInternal } = await import("~/infra/events/event-bus")
    const event = uniqueEvent()
    const seen: AppEvent[] = []
    onEvent(
      async (e) => {
        if (e.entity === event.entity) seen.push(e)
      },
      { delivery: "per-replica" },
    )
    // Wait for the pattern to be live by a peer warm-up on the same entity.
    const deadline = Date.now() + 3000
    while (seen.length === 0 && Date.now() < deadline) {
      await publishAsPeer({ ...event, entityId: "warmup" })
      await waitFor(() => seen.length > 0, 200)
    }
    await settle()
    seen.length = 0

    await _publishEventInternal({ ...event, entityId: "own" })
    await settle()

    expect(seen.filter((e) => e.entityId === "own")).toHaveLength(1)
    expect(seen.find((e) => e.entityId === "own")?._remote).toBeUndefined()
  })
})
