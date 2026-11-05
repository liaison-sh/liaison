// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * C2 -- in-process outbox worker heartbeat.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus } from "~/infra/events/event-bus"
import {
  getWorkerHeartbeat,
  OutboxWorkerTestAccess,
  resolveOutboxPollIntervalMs,
  startOutboxWorker,
  stopOutboxWorker,
} from "~/infra/events/outbox-worker"
import { waitFor } from "~/tests/helpers/wait-for"

beforeAll(async () => {
  initEventBus()
  DurableConsumersTestAccess.reset()
  // Another file in this same bun process may already have run the worker.
  OutboxWorkerTestAccess.resetHeartbeat()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Outbox Test Org', 'outbox-test')
    ON CONFLICT (id) DO NOTHING`
})

afterEach(async () => {
  await stopOutboxWorker()
})

describe("outbox worker heartbeat (C2)", () => {
  it("lastTickAt is null before the worker starts", () => {
    expect(getWorkerHeartbeat().lastTickAt).toBeNull()
    expect(getWorkerHeartbeat().heartbeatSource).toBe("inproc")
  })

  it("lastTickAt becomes a recent ISO timestamp once the worker ticks", async () => {
    startOutboxWorker()
    await waitFor(() => getWorkerHeartbeat().lastTickAt !== null, { label: "first outbox tick" })
    const heartbeat = getWorkerHeartbeat()
    expect(heartbeat.lastTickAt).not.toBeNull()
    const parsed = new Date(heartbeat.lastTickAt as string)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(Date.now() - parsed.getTime()).toBeLessThan(5000)
    expect(heartbeat.heartbeatSource).toBe("inproc")
  })
})

describe("outbox poll interval", () => {
  it("is 1 s in production and fast under test, and only an in-range override changes it", () => {
    expect(resolveOutboxPollIntervalMs({ NODE_ENV: "production" })).toBe(1_000)
    expect(resolveOutboxPollIntervalMs({})).toBe(1_000)
    expect(resolveOutboxPollIntervalMs({ NODE_ENV: "test" })).toBe(25)
    expect(
      resolveOutboxPollIntervalMs({ NODE_ENV: "production", OUTBOX_POLL_INTERVAL_MS: "250" }),
    ).toBe(250)
    expect(
      resolveOutboxPollIntervalMs({ NODE_ENV: "production", OUTBOX_POLL_INTERVAL_MS: "0" }),
    ).toBe(1_000)
    expect(
      resolveOutboxPollIntervalMs({ NODE_ENV: "production", OUTBOX_POLL_INTERVAL_MS: "abc" }),
    ).toBe(1_000)
    expect(
      resolveOutboxPollIntervalMs({ NODE_ENV: "test", OUTBOX_POLL_INTERVAL_MS: "999999" }),
    ).toBe(25)
  })
})
