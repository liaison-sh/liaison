// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { declaredEmits } from "~/infra/events/event-bus"

const ORG_ID = "00000000-0000-0000-0000-000000009001"

// Synthetic `kernel`/`test:*` events these tests queue. queueEvent runs
// assertKernelEventDeclared against the kernel emit set (populated once any test
// ran initEventBus), so in a full-suite run the guard rejects them unless
// declared here.
const KERNEL_TEST_EMITS = ["test:deep-nest", "test:will-rollback"]

beforeAll(async () => {
  // Seed test organization required by FK constraints
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'QueueEvent Test Org', 'queue-event-test')
    ON CONFLICT (id) DO NOTHING`
  const kernelEmits = declaredEmits.get("kernel")
  if (kernelEmits) for (const k of KERNEL_TEST_EMITS) kernelEmits.add(k)
})

afterAll(async () => {
  const kernelEmits = declaredEmits.get("kernel")
  if (kernelEmits) for (const k of KERNEL_TEST_EMITS) kernelEmits.delete(k)
  // Clean up test organization
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

afterEach(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE payload->>'action' IN ('deep-nest', 'will-rollback')`
})

describe("queueEvent — recursive transaction propagation", () => {
  it("propagates to depth-3 nested transactions", async () => {
    await withPrivilegedDb(ORG_ID, "test", async (tx) => {
      await tx.transaction(async (tx2) => {
        await tx2.transaction(async (tx3) => {
          await tx3.transaction(async (tx4) => {
            expect(typeof tx4.queueEvent).toBe("function")
            await tx4.queueEvent({
              app: "kernel",
              entity: "test",
              action: "deep-nest",
              entityId: "1",
              orgId: ORG_ID,
              data: {},
              actorId: "system",
              actorType: "system",
            })
          })
        })
      })
    })

    const [row] = await sql`
      SELECT * FROM kernel.pending_events
      WHERE payload->>'action' = 'deep-nest'
      ORDER BY seq DESC LIMIT 1
    `
    expect(row).toBeDefined()
  })

  it("queued events are rolled back when transaction is rolled back", async () => {
    try {
      await withPrivilegedDb(ORG_ID, "test", async (tx) => {
        await tx.queueEvent({
          app: "kernel",
          entity: "test",
          action: "will-rollback",
          entityId: "1",
          orgId: ORG_ID,
          data: {},
          actorId: "system",
          actorType: "system",
        })
        throw new Error("Force rollback")
      })
    } catch {
      // Expected
    }

    const [row] = await sql`
      SELECT * FROM kernel.pending_events WHERE payload->>'action' = 'will-rollback'
    `
    expect(row).toBeUndefined()
  })
})
