// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { schemaRef } from "~/db/schema-ref"
import {
  DurableConsumersTestAccess,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import { initEventBus } from "~/infra/events/event-bus"
import {
  isTickInFlight,
  OutboxWorkerTestAccess,
  orgInitBackoffMs,
  processOutboxBatch,
  registerOutboxSingleton,
  resolveOutboxPollIntervalMs,
  startOutboxWorker,
  stopOutboxWorker,
} from "~/infra/events/outbox-worker"
import {
  isLeader,
  LeadershipTestAccess,
  registerSingleton,
  startLeadership,
} from "~/infra/leadership"
import { redis } from "~/lib/redis"
import { initializedOrgRuntimes } from "~/modules/apps/app-registries"

beforeAll(async () => {
  initEventBus()
  // Isolate from durable consumers any prior test file registered (indexer /
  // attention / thumbnail) so processOutboxBatch only runs what each test sets.
  DurableConsumersTestAccess.reset()
  // Seed test organization required by FK constraints
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES ('00000000-0000-0000-0000-000000000001', 'Outbox Test Org', 'outbox-test')
    ON CONFLICT (id) DO NOTHING`
})

const table = `${schemaRef("kernel")}.pending_events`

afterEach(async () => {
  await stopOutboxWorker()
  // Clean up any test events
  await sql.unsafe(`DELETE FROM ${table} WHERE (payload->>'entity')::text = 'outbox_test'`)
})

// HERMETIC. processOutboxBatch claims the 100 oldest unprocessed events in the
// whole table, and `bun test` runs many files against one database: events
// other files left unprocessed would be claimed ahead of (or instead of) the
// ones these tests insert, and change every count they assert. Before each
// test, every unprocessed event this file did not insert is PARKED, marked
// claimed "just now" by a worker id nobody else uses, which the claim query
// skips for 30 s; they are handed back untouched afterwards. Nothing is
// processed, deleted or re-dated, so another file's or process's events are
// only paused while this file runs.
const PARKED_BY = "outbox-worker-test-parked"

beforeEach(async () => {
  await sql.unsafe(
    `UPDATE ${table} SET claimed_at = now(), claimed_by = $1
     WHERE processed_at IS NULL AND failed_at IS NULL
       AND (claimed_by IS NULL OR claimed_by = $1)`,
    [PARKED_BY],
  )
})

afterAll(async () => {
  await sql.unsafe(
    `UPDATE ${table} SET claimed_at = NULL, claimed_by = NULL WHERE claimed_by = $1`,
    [PARKED_BY],
  )
})

describe("outbox worker tick overlap", () => {
  it("isTickInFlight returns false when no tick is running", () => {
    expect(isTickInFlight()).toBe(false)
  })

  it("startOutboxWorker is idempotent — second call is a no-op", () => {
    startOutboxWorker()
    startOutboxWorker() // Should not throw or create a second timer
    expect(isTickInFlight()).toBe(false) // No tick started yet (first tick hasn't fired)
  })
})

describe("processOutboxBatch", () => {
  it("processes a pending event and marks it as processed", async () => {
    // Insert a test event directly
    const [{ id }] = await sql.unsafe(
      `INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`,
      [
        "00000000-0000-0000-0000-000000000001",
        JSON.stringify({
          app: "kernel",
          entity: "outbox_test",
          action: "created",
          orgId: "00000000-0000-0000-0000-000000000001",
        }),
      ],
    )

    const processed = await processOutboxBatch()

    // Verify the event was claimed and processed (or at least attempted)
    const [row] = await sql.unsafe(
      `SELECT processed_at, claimed_by, attempts FROM ${table} WHERE id = $1`,
      [id],
    )
    // Event should have been touched by the worker — either processed or attempted
    expect(row.claimed_by !== null || row.processed_at !== null || row.attempts > 0).toBe(true)
    // If publish succeeded, processed_at is set; if it failed, attempts is incremented
    if (processed > 0) {
      expect(row.processed_at).not.toBeNull()
    }
  })

  it("marks the event's org changed for the state materializer", async () => {
    const { ORG_CHANGES_KEY } = await import("~/modules/attention/org-changes")
    const org = "00000000-0000-0000-0000-000000000001"
    await redis.zrem(ORG_CHANGES_KEY, org)
    const before = Date.now()
    await sql.unsafe(`INSERT INTO ${table} (org_id, payload) VALUES ($1, $2)`, [
      org,
      JSON.stringify({ app: "kernel", entity: "outbox_test", action: "created", orgId: org }),
    ])
    await processOutboxBatch()
    // The mark is not awaited by the batch: give it a moment.
    let score: string | null = null
    for (let i = 0; i < 50 && score === null; i++) {
      score = await redis.zscore(ORG_CHANGES_KEY, org)
      if (score === null) await new Promise((r) => setTimeout(r, 20))
    }
    expect(Number(score)).toBeGreaterThanOrEqual(before)
    await redis.zrem(ORG_CHANGES_KEY, org)
  })

  it("skips events that are already dead-lettered", async () => {
    // Insert an event that is already dead-lettered (failed_at IS NOT NULL)
    const [{ id }] = await sql.unsafe(
      `INSERT INTO ${table} (org_id, payload, attempts, failed_at) VALUES ($1, $2, 10, now()) RETURNING id`,
      [
        "00000000-0000-0000-0000-000000000001",
        JSON.stringify({
          app: "kernel",
          entity: "outbox_test",
          action: "dead",
          orgId: "00000000-0000-0000-0000-000000000001",
        }),
      ],
    )

    await processOutboxBatch()

    // Verify the dead-lettered event was NOT re-processed (processed_at stays null)
    const [row] = await sql.unsafe(`SELECT processed_at, failed_at FROM ${table} WHERE id = $1`, [
      id,
    ])
    expect(row.processed_at).toBeNull()
    expect(row.failed_at).not.toBeNull()
  })

  it("skips events that are already processed", async () => {
    const [{ id }] = await sql.unsafe(
      `INSERT INTO ${table} (org_id, payload, processed_at) VALUES ($1, $2, now()) RETURNING id`,
      [
        "00000000-0000-0000-0000-000000000001",
        JSON.stringify({
          app: "kernel",
          entity: "outbox_test",
          action: "done",
          orgId: "00000000-0000-0000-0000-000000000001",
        }),
      ],
    )

    const _processed = await processOutboxBatch()
    // Should not re-process an already-processed event
    const [row] = await sql.unsafe(`SELECT claimed_by FROM ${table} WHERE id = $1`, [id])
    expect(row.claimed_by).toBeNull()
  })
})

describe("org app runtime before the durable consumers", () => {
  const FRESH_ORG = "00000000-0000-0000-0000-0000000000f1"

  afterEach(() => {
    DurableConsumersTestAccess.reset()
  })

  it("initializes an org created by another process before its first event is consumed", async () => {
    // An org row this process never initialized, as `liaison config apply`
    // leaves one on a server that booted with no org.
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${FRESH_ORG}, 'Outbox Fresh Org', 'outbox-fresh') ON CONFLICT (id) DO NOTHING`
    initializedOrgRuntimes.delete(FRESH_ORG)
    const seen: boolean[] = []
    registerDurableEventConsumer("runtime-probe", async (ctx) => {
      if (ctx.event.orgId === FRESH_ORG) seen.push(initializedOrgRuntimes.has(FRESH_ORG))
    })
    await sql.unsafe(`INSERT INTO ${table} (org_id, payload) VALUES ($1, $2)`, [
      FRESH_ORG,
      JSON.stringify({ app: "kernel", entity: "outbox_test", action: "created", orgId: FRESH_ORG }),
    ])

    await processOutboxBatch()

    expect(seen).toEqual([true])
  })

  it("a failing org setup leaves its events unclaimed and unprocessed until a retry succeeds; other orgs flow", async () => {
    await sql.unsafe(`DELETE FROM ${table} WHERE (payload->>'entity')::text = 'outbox_test'`)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${FRESH_ORG}, 'Outbox Fresh Org', 'outbox-fresh') ON CONFLICT (id) DO NOTHING`
    initializedOrgRuntimes.delete(FRESH_ORG)
    const OTHER_ORG = "00000000-0000-0000-0000-000000000001"
    let attempts = 0
    let failing = true
    OutboxWorkerTestAccess.setOrgInit(async (orgId) => {
      if (orgId !== FRESH_ORG) return
      attempts += 1
      if (failing) throw new Error("database blip")
    })
    const consumed: string[] = []
    registerDurableEventConsumer("not-ready-probe", async (ctx) => {
      consumed.push(String(ctx.event.orgId))
    })
    try {
      const insert = (orgId: string) =>
        sql.unsafe(`INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`, [
          orgId,
          JSON.stringify({ app: "kernel", entity: "outbox_test", action: "created", orgId }),
        ])
      const rowOf = async (id: string) =>
        (
          await sql.unsafe(
            `SELECT processed_at, attempts, claimed_by FROM ${table} WHERE id = $1`,
            [id],
          )
        )[0]
      const [first] = await insert(FRESH_ORG)
      const [other] = await insert(OTHER_ORG)
      await processOutboxBatch()
      // The failed org's event reached no consumer and is back in the queue as it was.
      expect(consumed).not.toContain(FRESH_ORG)
      const row = await rowOf(first.id)
      expect(row.processed_at).toBeNull()
      expect(row.attempts).toBe(0)
      expect(row.claimed_by).toBeNull()
      expect(attempts).toBe(1)
      expect(OutboxWorkerTestAccess.orgInitBackoff(FRESH_ORG)?.failures).toBe(1)
      // Another org's event in the same batch went through.
      expect(consumed).toContain(OTHER_ORG)
      const otherRow = await rowOf(other.id)
      // Handled: processed, or attempted when this fixture event type cannot be published.
      expect(otherRow.processed_at !== null || otherRow.attempts > 0).toBe(true)

      // Within the retry delay the org is not tried again and its event is not claimed.
      await processOutboxBatch()
      expect(attempts).toBe(1)
      expect((await rowOf(first.id)).claimed_by).toBeNull()
      expect(consumed).not.toContain(FRESH_ORG)

      // The retry is due and succeeds: the event is consumed and processed.
      failing = false
      OutboxWorkerTestAccess.expireOrgInitBackoff(FRESH_ORG)
      await processOutboxBatch()
      expect(attempts).toBe(2)
      expect(consumed).toContain(FRESH_ORG)
      const done = await rowOf(first.id)
      expect(done.processed_at !== null || done.attempts > 0).toBe(true)
    } finally {
      OutboxWorkerTestAccess.setOrgInit(null)
    }
  })

  it("backs off exponentially and caps the delay", () => {
    expect([1, 2, 3, 4].map(orgInitBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000])
    expect(orgInitBackoffMs(30)).toBe(5 * 60_000)
  })
})

describe("HA leadership gate (only the Patroni leader drains the outbox)", () => {
  const ORG = "00000000-0000-0000-0000-000000000001"

  async function waitFor(pred: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await pred()) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  }

  const createdIds: string[] = []

  afterEach(async () => {
    await LeadershipTestAccess.reset()
    if (createdIds.length > 0) {
      await sql.unsafe(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [createdIds])
      createdIds.length = 0
    }
  })

  it("does NOT deliver while this node is a replica, and delivers once it becomes leader", async () => {
    let status = 503 // this node starts as a replica (warm standby)
    const patroni = Bun.serve({
      port: 0,
      fetch: () => new Response("", { status }),
    })
    try {
      // Arm the gate against the fake local Patroni, replica at boot. The
      // lease (own key, test timings) is contended only once Patroni says leader.
      await startLeadership({
        role: "all",
        patroni: {
          url: `http://localhost:${patroni.port}/leader`,
          probeIntervalMs: 25,
          probeTimeoutMs: 500,
        },
        lease: {
          key: `outbox-ha-test:${crypto.randomUUID()}`,
          ttlMs: 3_000,
          renewMs: 1_000,
          pollMs: 250,
        },
      })

      // A DECLARED kernel emit so the publish step succeeds and processed_at is
      // set once delivered (an undeclared entity would fail validation and never
      // mark processed -- see the "processes a pending event" test above).
      const [{ id }] = await sql.unsafe(
        `INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`,
        [
          ORG,
          JSON.stringify({
            app: "kernel",
            entity: "saved_view",
            action: "created",
            entityId: crypto.randomUUID(),
            orgId: ORG,
          }),
        ],
      )
      createdIds.push(id)

      // Run the real worker (interval). As a replica it must leave the event alone.
      startOutboxWorker()
      // Give it several ticks; assert it was never even claimed.
      const claimedWhileReplica = await waitFor(async () => {
        const [row] = await sql.unsafe(
          `SELECT claimed_by, processed_at FROM ${table} WHERE id = $1`,
          [id],
        )
        return row.claimed_by !== null || row.processed_at !== null
      }, 600)
      expect(claimedWhileReplica).toBe(false)

      // Promote this node -> the same running worker must now drain the event.
      status = 200
      const delivered = await waitFor(async () => {
        const [row] = await sql.unsafe(`SELECT processed_at FROM ${table} WHERE id = $1`, [id])
        return row.processed_at !== null
      })
      expect(delivered).toBe(true)
    } finally {
      patroni.stop(true)
    }
  })
})

describe("outbox singleton (lease hook)", () => {
  const ORG = "00000000-0000-0000-0000-000000000001"
  const createdIds: string[] = []
  const leaseKey = `outbox-singleton-test:${crypto.randomUUID()}`

  async function waitFor(
    pred: () => Promise<boolean> | boolean,
    timeoutMs = 5_000,
  ): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await pred()) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  }

  async function insertEvent(): Promise<string> {
    const [{ id }] = await sql.unsafe(
      `INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`,
      [
        ORG,
        JSON.stringify({
          app: "kernel",
          entity: "saved_view",
          action: "created",
          entityId: crypto.randomUUID(),
          orgId: ORG,
        }),
      ],
    )
    createdIds.push(id)
    return id
  }

  async function rowOf(
    id: string,
  ): Promise<{ claimed_by: string | null; processed_at: Date | null }> {
    const [row] = await sql.unsafe<{ claimed_by: string | null; processed_at: Date | null }[]>(
      `SELECT claimed_by, processed_at FROM ${table} WHERE id = $1`,
      [id],
    )
    return row
  }

  afterEach(async () => {
    await LeadershipTestAccess.reset()
    DurableConsumersTestAccess.reset()
    await redis.del(leaseKey)
    if (createdIds.length > 0) {
      await sql.unsafe(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [createdIds])
      createdIds.length = 0
    }
  })

  it("outbox drains only while this process leads, and loss waits for the in-flight batch", async () => {
    // A durable consumer that holds the batch open until released.
    let releaseBatch: () => void = () => {}
    const batchGate = new Promise<void>((r) => {
      releaseBatch = r
    })
    let holdBatches = false
    registerDurableEventConsumer("outbox-singleton-test-gate", async () => {
      if (holdBatches) await batchGate
    })

    registerOutboxSingleton()
    // Registered after the outbox: hooks run in order, so this one's onLost
    // runs only once the outbox's onLost has resolved.
    const probe: { tickInFlightAtLoss: boolean | null } = { tickInFlightAtLoss: null }
    registerSingleton({
      name: "outbox-singleton-test-probe",
      onAcquired: () => {},
      onLost: () => {
        probe.tickInFlightAtLoss = isTickInFlight()
      },
    })
    await startLeadership({
      role: "all",
      lease: { key: leaseKey, ttlMs: 3_000, renewMs: 250, pollMs: 100 },
    })
    expect(isLeader()).toBe(true)

    // Leading: an event is delivered.
    const first = await insertEvent()
    expect(await waitFor(async () => (await rowOf(first)).processed_at !== null)).toBe(true)

    // Hold the next batch in flight, then steal the lease.
    holdBatches = true
    const held = await insertEvent()
    expect(await waitFor(() => isTickInFlight())).toBe(true)
    await redis.set(leaseKey, "another-process", "PX", 60_000)
    expect(await waitFor(() => !isLeader())).toBe(true)

    // The loss is not over while the batch is in flight.
    await new Promise((r) => setTimeout(r, 500))
    expect(probe.tickInFlightAtLoss).toBeNull()

    releaseBatch()
    expect(await waitFor(() => probe.tickInFlightAtLoss !== null)).toBe(true)
    expect(probe.tickInFlightAtLoss).toBe(false)
    expect((await rowOf(held)).processed_at).not.toBeNull()

    // No longer leading: a new event stays unclaimed across several ticks.
    const after = await insertEvent()
    await new Promise((r) => setTimeout(r, 5 * resolveOutboxPollIntervalMs() + 100))
    const row = await rowOf(after)
    expect(row.claimed_by).toBeNull()
    expect(row.processed_at).toBeNull()
  })
})

describe("durable consumer failure keeps the event unprocessed (I-EVT-1)", () => {
  const ORG = "00000000-0000-0000-0000-000000000001"
  // Use a declared kernel emit so the publish step (which validates against
  // declaredEmits) succeeds once the durable consumer stops throwing.
  const payloadOf = () =>
    JSON.stringify({
      app: "kernel",
      entity: "saved_view",
      action: "created",
      entityId: crypto.randomUUID(),
      orgId: ORG,
    })

  const createdIds: string[] = []

  afterEach(async () => {
    DurableConsumersTestAccess.reset()
    if (createdIds.length > 0) {
      await sql.unsafe(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [createdIds])
      createdIds.length = 0
    }
  })

  it("does not mark processed and increments attempts when a durable consumer throws", async () => {
    // Audit + timeline are durable consumers now: if one throws, the outbox
    // must NOT mark the event processed, leaving it to retry on the next tick.
    registerDurableEventConsumer("test-throwing-consumer", async () => {
      throw new Error("simulated durable consumer failure")
    })

    const [{ id }] = await sql.unsafe(
      `INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`,
      [ORG, payloadOf()],
    )
    createdIds.push(id)

    const processed = await processOutboxBatch()
    expect(processed).toBe(0)

    const [row] = await sql.unsafe(
      `SELECT processed_at, failed_at, attempts FROM ${table} WHERE id = $1`,
      [id],
    )
    expect(row.processed_at).toBeNull()
    expect(row.failed_at).toBeNull()
    expect(row.attempts).toBe(1)
  })

  it("processes the event once the durable consumer stops failing (retry succeeds)", async () => {
    let calls = 0
    registerDurableEventConsumer("test-flaky-consumer", async () => {
      calls++
      if (calls === 1) throw new Error("transient failure")
    })

    const [{ id }] = await sql.unsafe(
      `INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`,
      [ORG, payloadOf()],
    )
    createdIds.push(id)

    await processOutboxBatch() // attempt 1 — throws, released for retry
    let [row] = await sql.unsafe(`SELECT processed_at FROM ${table} WHERE id = $1`, [id])
    expect(row.processed_at).toBeNull()

    await processOutboxBatch() // attempt 2 — succeeds
    ;[row] = await sql.unsafe(`SELECT processed_at FROM ${table} WHERE id = $1`, [id])
    expect(row.processed_at).not.toBeNull()
    expect(calls).toBe(2)
  })
})

// D3 — completion of a whole batch is coalesced into a SINGLE
// `UPDATE ... WHERE id = ANY(...)` per tick, and a mid-batch failure flushes the
// completions accumulated so far before handling the failure.
describe("outbox completion batching (D3)", () => {
  const ORG = "00000000-0000-0000-0000-000000000001"
  const createdIds: string[] = []

  const insertEvent = async (): Promise<string> => {
    const [{ id }] = await sql.unsafe(
      `INSERT INTO ${table} (org_id, payload) VALUES ($1, $2) RETURNING id`,
      [
        ORG,
        JSON.stringify({
          app: "kernel",
          entity: "saved_view",
          action: "created",
          entityId: crypto.randomUUID(),
          orgId: ORG,
        }),
      ],
    )
    createdIds.push(id)
    return id
  }

  afterEach(async () => {
    DurableConsumersTestAccess.reset()
    if (createdIds.length > 0) {
      await sql.unsafe(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [createdIds])
      createdIds.length = 0
    }
  })

  it("stamps every event in a batch of 5 processed_at in one tick", async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await insertEvent())

    const processed = await processOutboxBatch()
    expect(processed).toBe(5)

    const rows = await sql.unsafe(
      `SELECT id, processed_at FROM ${table} WHERE id = ANY($1::uuid[])`,
      [ids],
    )
    expect(rows).toHaveLength(5)
    for (const row of rows) {
      expect(row.processed_at).not.toBeNull()
    }
  })

  it("flushes earlier completions when an event mid-batch fails", async () => {
    // Events are claimed in seq (insertion) order; fail the third one via a
    // durable consumer keyed on entityId so events 1-2 complete, 3 fails, and
    // 4-5 still process in the same tick.
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await insertEvent())

    // Map outbox row id -> position by reading the seq order.
    const ordered = await sql.unsafe(
      `SELECT id FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY seq`,
      [ids],
    )
    const failId = ordered[2].id as string

    registerDurableEventConsumer("d3-fail-third", async (ctx) => {
      if (ctx.eventId === failId) throw new Error("simulated mid-batch failure")
    })

    const processed = await processOutboxBatch()
    // 4 published cleanly (the failing one is released for retry, not counted).
    expect(processed).toBe(4)

    const rows = await sql.unsafe(
      `SELECT id, processed_at, attempts FROM ${table} WHERE id = ANY($1::uuid[]) ORDER BY seq`,
      [ids],
    )
    // Earlier completions (1-2) were flushed before the failure was handled.
    expect(rows[0].processed_at).not.toBeNull()
    expect(rows[1].processed_at).not.toBeNull()
    // The failing event stays unprocessed with an incremented attempt.
    expect(rows[2].processed_at).toBeNull()
    expect(rows[2].attempts).toBe(1)
    // Events after the failure still process in the same tick.
    expect(rows[3].processed_at).not.toBeNull()
    expect(rows[4].processed_at).not.toBeNull()
  })

  it("empty batch issues no completion update and returns 0", async () => {
    const processed = await processOutboxBatch()
    expect(processed).toBe(0)
  })
})
