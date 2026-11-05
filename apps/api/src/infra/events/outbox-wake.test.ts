// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { wakeOutboxAfterCommit } from "~/db/queue-event"
import { schemaRef } from "~/db/schema-ref"
import {
  OUTBOX_WAKE_CHANNEL,
  OutboxWakeTestAccess,
  signalOutboxWake,
  WAKE_COALESCE_MS,
} from "~/infra/events/outbox-wake"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function recorder() {
  const sent: string[] = []
  OutboxWakeTestAccess.setPublisher(async (channel) => {
    sent.push(channel)
    return 1
  })
  return sent
}

afterEach(() => OutboxWakeTestAccess.setPublisher(null))

describe("outbox wake", () => {
  it("coalesces a burst of commits into one publish on the wake channel", async () => {
    const sent = recorder()
    for (let i = 0; i < 20; i++) signalOutboxWake()
    await sleep(WAKE_COALESCE_MS + 20)
    expect(sent).toEqual([OUTBOX_WAKE_CHANNEL])
    signalOutboxWake()
    await sleep(WAKE_COALESCE_MS + 20)
    expect(sent.length).toBe(2)
  })

  it("a failed publish never throws (the poll delivers the event)", async () => {
    OutboxWakeTestAccess.setPublisher(async () => {
      throw new Error("redis down")
    })
    signalOutboxWake()
    await sleep(WAKE_COALESCE_MS + 20)
  })

  it("wakes only after a transaction that queued an event has committed", async () => {
    const sent = recorder()
    let commit!: () => void
    const tx = new Promise<void>((r) => {
      commit = r
    })
    const mark = { queued: true }
    wakeOutboxAfterCommit(tx, mark)
    await sleep(WAKE_COALESCE_MS + 20)
    expect(sent).toEqual([]) // still open: its rows are not visible yet
    commit()
    await sleep(WAKE_COALESCE_MS + 20)
    expect(sent).toEqual([OUTBOX_WAKE_CHANNEL])
  })

  it("a rolled-back transaction, or one that queued nothing, wakes nothing", async () => {
    const sent = recorder()
    wakeOutboxAfterCommit(Promise.reject(new Error("rollback")), { queued: true })
    wakeOutboxAfterCommit(Promise.resolve(), { queued: false })
    await sleep(WAKE_COALESCE_MS + 20)
    expect(sent).toEqual([])
  })
})

describe("outbox wake from the transaction wrappers", () => {
  const ORG = "00000000-0000-0000-0000-0000000000a7"
  const table = `${schemaRef("kernel")}.pending_events`
  const event = (action: string) => ({
    app: "outbox_wake_test",
    entity: "probe",
    action,
    entityId: ORG,
    data: {},
    actorId: null,
    actorType: "system" as const,
    orgId: ORG,
    timestamp: new Date().toISOString(),
  })
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Outbox Wake Test Org', 'outbox-wake-test') ON CONFLICT (id) DO NOTHING`
  })
  afterAll(async () => {
    await sql.unsafe(`DELETE FROM ${table} WHERE payload->>'app' = 'outbox_wake_test'`)
  })

  it("a privileged transaction that queued an event wakes the worker once committed", async () => {
    const sent = recorder()
    await withPrivilegedDb(ORG, "outbox-wake-test", async (tx) => {
      await tx.queueEvent(event("committed"))
    })
    await sleep(WAKE_COALESCE_MS + 30)
    expect(sent).toEqual([OUTBOX_WAKE_CHANNEL])
  })

  it("a rolled-back privileged transaction wakes nothing", async () => {
    const sent = recorder()
    await withPrivilegedDb(ORG, "outbox-wake-test", async (tx) => {
      await tx.queueEvent(event("rolled-back"))
      throw new Error("roll back")
    }).catch(() => {})
    await sleep(WAKE_COALESCE_MS + 30)
    expect(sent).toEqual([])
  })
})
