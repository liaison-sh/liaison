// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The test drain is bounded by progress, not by a round count. Every file of a
// `bun test` process shares the outbox, so a file's drain also delivers what
// earlier files left queued: a backlog of more than a hundred batches is a
// normal state there, not a loop, and the drain must deliver it. An outbox a
// handler keeps refilling must still fail, and say which events it holds.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import {
  type AppEvent,
  declaredEmits,
  initEventBus,
  onEvent,
  resetEventBus,
} from "~/infra/events/event-bus"
import { createTestOrg } from "~/tests/helpers/org"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const BACKLOG = "drain-backlog"
const LOOP = "drain-loop"

let orgId: string

async function queue(action: string, count: number): Promise<void> {
  await withPrivilegedDb(orgId, "test-drain-queue", async (tx) => {
    for (let i = 0; i < count; i++) {
      await tx.queueEvent({
        app: "kernel",
        entity: "test",
        action,
        entityId: crypto.randomUUID(),
        orgId,
        actorType: "system",
        data: {},
      })
    }
  })
}

async function pendingOf(action: string): Promise<number> {
  const [row] = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    return await tx.unsafe(
      `SELECT count(*)::int AS n FROM kernel.pending_events
        WHERE org_id = $1 AND payload->>'action' = $2 AND processed_at IS NULL`,
      [orgId, action],
    )
  })
  return Number(row?.n ?? 0)
}

beforeAll(async () => {
  await acquireTestLock()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  const kernelEmits = declaredEmits.get("kernel")
  if (kernelEmits) for (const a of [BACKLOG, LOOP]) kernelEmits.add(`test:${a}`)
  orgId = (await createTestOrg()).id
  // Leave nothing of other files ahead of this one's events.
  await drainOutbox()
})

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE liaison_admin")
    await tx.unsafe("DELETE FROM kernel.pending_events WHERE org_id = $1", [orgId])
  })
  resetEventBus()
  await releaseTestLock()
})

describe("drainOutbox", () => {
  it("delivers a backlog of more batches than a fixed round count allowed", async () => {
    // 101 batches of the worker's 100: past the old bound of 100 rounds.
    await queue(BACKLOG, 10_100)
    await drainOutbox()
    expect(await pendingOf(BACKLOG)).toBe(0)
  }, 300_000)

  it("fails on an outbox a handler keeps refilling, naming what is pending", async () => {
    onEvent(
      async (event: AppEvent) => {
        if (event.app === "kernel" && event.entity === "test" && event.action === LOOP) {
          await queue(LOOP, 1)
        }
      },
      { delivery: "once", name: "test-drain-refill" },
    )
    await queue(LOOP, 3)
    const failure = await drainOutbox({ stallRounds: 5 }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toContain("something keeps refilling it")
    expect(message).toContain(`kernel:test:${LOOP} x3 (1 org)`)
  }, 120_000)
})
