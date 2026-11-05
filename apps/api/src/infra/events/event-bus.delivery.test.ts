// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Delivery classes (A5). Every bus handler is `once` (it runs in the process
// that published the event, never on a peer's `_remote` copy) or `per-replica`
// (it runs in every process: local caches, socket fan-out). Without the class,
// a once handler ran once per process: N event-routine ticks, N thread messages.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { withSystemDb } from "~/db/privileged"
import { messages, threadParticipants, threads } from "~/db/schema/kernel/threads"
import {
  _publishEventInternal,
  type AppEvent,
  declaredEmits,
  flushEventHandlers,
  initEventBus,
  onEvent,
  resetEventBus,
  subscribeToEvent,
} from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { REDIS_PREFIX, redis, redisSub } from "~/lib/redis"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-0000000000a5"

function channelOf(app: string, entity: string, action: string): string {
  return `${REDIS_PREFIX}events:${app}:${entity}:${action}`
}

/** A peer process's copy of an event, as the Redis subscriber receives it. */
function deliverRemote(event: AppEvent): void {
  const { app, entity, action } = event
  redisSub.emit(
    "message",
    channelOf(app, entity, action),
    JSON.stringify({ ...event, _msgId: crypto.randomUUID() }),
  )
}

beforeAll(() => {
  resetEventBus()
  initEventBus()
})

afterAll(() => {
  redisSub.removeAllListeners("message")
  resetEventBus()
})

describe("event bus delivery classes", () => {
  beforeEach(() => {
    declaredEmits.set("a5test", new Set(["item:created"]))
  })
  afterEach(async () => {
    await flushEventHandlers()
    redisSub.removeAllListeners("message")
    resetEventBus()
    initEventBus()
    delete process.env.LIAISON_TEST_EVENT_SINK
  })

  const event: AppEvent = {
    app: "a5test",
    entity: "item",
    action: "created",
    entityId: "item-1",
    orgId: ORG,
  }

  it("a once handler does not run for a remote event", async () => {
    let onceGlobal = 0
    let perReplicaGlobal = 0
    let onceChannel = 0
    let perReplicaChannel = 0
    onEvent(
      async () => {
        onceGlobal++
      },
      { delivery: "once" },
    )
    onEvent(
      async () => {
        perReplicaGlobal++
      },
      { delivery: "per-replica" },
    )
    await subscribeToEvent(
      "a5test",
      "item",
      "created",
      async () => {
        onceChannel++
      },
      { delivery: "once" },
    )
    await subscribeToEvent(
      "a5test",
      "item",
      "created",
      async () => {
        perReplicaChannel++
      },
      { delivery: "per-replica" },
    )

    deliverRemote(event)
    await flushEventHandlers()

    expect(perReplicaGlobal).toBe(1)
    expect(perReplicaChannel).toBe(1)
    expect(onceGlobal).toBe(0)
    expect(onceChannel).toBe(0)
  })

  it("a once handler runs for a local publish", async () => {
    let once = 0
    let perReplica = 0
    let onceChannel = 0
    onEvent(
      async () => {
        once++
      },
      { delivery: "once" },
    )
    onEvent(
      async () => {
        perReplica++
      },
      { delivery: "per-replica" },
    )
    await subscribeToEvent(
      "a5test",
      "item",
      "created",
      async () => {
        onceChannel++
      },
      { delivery: "once" },
    )

    await _publishEventInternal({ ...event })
    await flushEventHandlers()

    expect(once).toBe(1)
    expect(perReplica).toBe(1)
    expect(onceChannel).toBe(1)
  })

  it("the test sink counts each named once call under LIAISON_TEST_EVENT_SINK", async () => {
    process.env.LIAISON_TEST_EVENT_SINK = "1"
    const name = `a5-sink-${crypto.randomUUID()}`
    const key = `test:event-sink:${name}:a5test:item:created:item-1`
    onEvent(async () => {}, { delivery: "once", name })

    await _publishEventInternal({ ...event })
    deliverRemote(event)
    await flushEventHandlers()

    expect(await redis.get(key)).toBe("1")
    await redis.del(key)
  })

  it("subscribeToEvent without a delivery class does not typecheck", () => {
    // The check is tsc's: each call below must be a type error. Never invoked,
    // since a handler without a class has no defined delivery.
    const untyped = async (): Promise<void> => {
      // @ts-expect-error the delivery class is required
      await subscribeToEvent("a5test", "item", "created", async () => {})
      // @ts-expect-error the delivery class is required
      onEvent(async () => {})
    }
    expect(typeof untyped).toBe("function")
  })
})

describe("the MCP resource notifier across a local and a remote delivery", () => {
  let world: McpTestWorld

  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    await releaseTestLock()
  })
  beforeEach(async () => {
    world = await buildMcpWorld()
    resetEventBus()
    redisSub.removeAllListeners("message")
    initEventBus()
    declaredEmits.set("mcp", new Set(["resource:updated"]))
    registerEventSubscribers()
  })
  afterEach(async () => {
    await flushEventHandlers()
    redisSub.removeAllListeners("message")
    resetEventBus()
  })

  it("inserts one message for an agent subscriber", async () => {
    const threadId = await withSystemDb("a5-seed-thread", async (db) => {
      const [t] = await db
        .insert(threads)
        .values({
          orgId: world.org.id,
          handle: `a5-${crypto.randomUUID().slice(0, 8)}`,
          title: "resource updates",
          type: "thread",
          createdBy: world.alice.userId,
        })
        .returning({ id: threads.id })
      await db.insert(threadParticipants).values({
        threadId: t.id,
        userId: world.alice.userId,
        orgId: world.org.id,
        role: "owner",
      })
      return t.id
    })
    const updated: AppEvent = {
      app: "mcp",
      entity: "resource",
      action: "updated",
      orgId: world.org.id,
      data: {
        connection_id: crypto.randomUUID(),
        uri: "file:///a5.txt",
        subscriber_actor_id: world.alice.userId,
        subscriber_actor_type: "agent",
        thread_id: threadId,
      },
      metadata: { slug: "linear" },
    }

    // This process published it (the outbox drain) and a peer process's copy
    // arrives through Redis: one event, one thread message.
    await _publishEventInternal({ ...updated })
    deliverRemote(updated)
    await flushEventHandlers()

    const rows = await withSystemDb("a5-list-msgs", (db) =>
      db
        .select()
        .from(messages)
        .where(and(eq(messages.threadId, threadId), eq(messages.authorType, "system"))),
    )
    expect(rows).toHaveLength(1)
  })
})
