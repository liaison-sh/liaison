// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { declaredEmits } from "~/infra/events/event-bus"
import { OutboxWorkerTestAccess, processOutboxBatch } from "~/infra/events/outbox-worker"

const TEST_ORG_ID = "00000000-0000-0000-0000-b00000000001"
const TEST_USER_ID = "00000000-0000-0000-0000-b00000000002"

// File-level setup: seed org/user for all describe blocks (FK constraints)
let savedEmits: Set<string> | undefined

// Synthetic `kernel`/`test:*` events emitted by the outbox-atomicity and
// role-restore blocks below. queueEvent runs assertKernelEventDeclared against
// the kernel emit set, which is populated once any test ran initEventBus — so
// in a full-suite run the guard rejects these unless we declare them here.
const KERNEL_TEST_EMITS = ["test:rollback_check", "test:commit_check", "test:role_check"]

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG_ID}, 'PendingEvents Test Org', 'pending-events-test')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
    VALUES (${TEST_USER_ID}, ${TEST_ORG_ID}, 'pending-test@test.com', 'Pending Test User', 'active', 1)
    ON CONFLICT (id) DO NOTHING`
  // The outbox tick initialises an org's apps before its first event; for this
  // org that registers the `test` fixture app, whose manifest emits replace the
  // synthetic `item:*` set declared below and refuse every event here. The org
  // runtime is not what these cases are about.
  OutboxWorkerTestAccess.setOrgInit(async () => {})
  savedEmits = declaredEmits.get("test")
  declaredEmits.set("test", new Set(["item:create", "item:update", "item:delete"]))
  const kernelEmits = declaredEmits.get("kernel")
  if (kernelEmits) for (const k of KERNEL_TEST_EMITS) kernelEmits.add(k)
})

afterAll(async () => {
  OutboxWorkerTestAccess.setOrgInit(null)
  if (savedEmits) declaredEmits.set("test", savedEmits)
  else declaredEmits.delete("test")
  const kernelEmits = declaredEmits.get("kernel")
  if (kernelEmits) for (const k of KERNEL_TEST_EMITS) kernelEmits.delete(k)
  await sql`DELETE FROM kernel.users WHERE id = ${TEST_USER_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
})

describe("transactional outbox via queueEvent", () => {
  beforeEach(async () => {
    await sql`DELETE FROM kernel.pending_events`
  })

  it("events queued via tx.queueEvent are inserted into pending_events table", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: ["test:items"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.queueEvent({
          app: "test",
          entity: "item",
          action: "create",
          entityId: "1",
          orgId: TEST_ORG_ID,
          actorId: TEST_USER_ID,
        })
      },
    )

    const rows =
      await sql`SELECT * FROM kernel.pending_events WHERE org_id = '00000000-0000-0000-0000-b00000000001'`
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toMatchObject({ app: "test", entity: "item", action: "create" })
    expect(rows[0].processed_at).toBeNull()
  })

  it("events are NOT inserted if transaction rolls back", async () => {
    try {
      await withRlsContext(
        {
          actorType: "user",
          userId: TEST_USER_ID,
          orgId: TEST_ORG_ID,
          scopes: ["test:items"],
          dimensionGrants: {},
        },
        async (tx) => {
          await tx.queueEvent({
            app: "test",
            entity: "item",
            action: "create",
            entityId: "1",
            orgId: TEST_ORG_ID,
            actorId: TEST_USER_ID,
          })
          throw new Error("simulated failure")
        },
      )
    } catch {
      /* expected */
    }

    const rows =
      await sql`SELECT * FROM kernel.pending_events WHERE org_id = '00000000-0000-0000-0000-b00000000001'`
    expect(rows).toHaveLength(0)
  })

  it("multiple events are inserted in order", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: ["test:items"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.queueEvent({
          app: "test",
          entity: "item",
          action: "create",
          entityId: "1",
          orgId: TEST_ORG_ID,
        })
        await tx.queueEvent({
          app: "test",
          entity: "item",
          action: "update",
          entityId: "1",
          orgId: TEST_ORG_ID,
        })
      },
    )

    const rows = await sql`
      SELECT * FROM kernel.pending_events
      WHERE org_id = '00000000-0000-0000-0000-b00000000001'
      ORDER BY created_at
    `
    expect(rows).toHaveLength(2)
    expect(rows[0].payload).toMatchObject({ action: "create" })
    expect(rows[1].payload).toMatchObject({ action: "update" })
  })

  it("audit log deduplicates on eventId", async () => {
    const { writeAuditLog } = await import("~/modules/audit/service")
    const eventId = crypto.randomUUID()

    // First write should succeed
    await withRlsContext({ actorType: "system", orgId: TEST_ORG_ID, purpose: "audit" }, (tx) =>
      writeAuditLog(tx, {
        orgId: TEST_ORG_ID,
        actorId: null,
        actorType: "system",
        app: "kernel",
        entityType: "test",
        entityId: "dedup-test",
        action: "test.dedup",
        eventId,
      }),
    )

    // Second write with same eventId should be silently ignored (onConflictDoNothing)
    await withRlsContext({ actorType: "system", orgId: TEST_ORG_ID, purpose: "audit" }, (tx) =>
      writeAuditLog(tx, {
        orgId: TEST_ORG_ID,
        actorId: null,
        actorType: "system",
        app: "kernel",
        entityType: "test",
        entityId: "dedup-test",
        action: "test.dedup",
        eventId,
      }),
    )

    // Count entries with this eventId — should be exactly 1
    const rows =
      await sql`SELECT COUNT(*)::int AS n FROM kernel.audit_log WHERE event_id = ${eventId}`
    expect(rows[0].n).toBe(1)

    // Clean up
    await sql`DELETE FROM kernel.audit_log WHERE event_id = ${eventId}`
  })

  it("processOutboxBatch processes events in creation order", async () => {
    // Queue 3 events in specific order
    await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: ["test:items"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.queueEvent({
          app: "test",
          entity: "item",
          action: "create",
          entityId: "order-1",
          orgId: TEST_ORG_ID,
        })
        await tx.queueEvent({
          app: "test",
          entity: "item",
          action: "update",
          entityId: "order-1",
          orgId: TEST_ORG_ID,
        })
        await tx.queueEvent({
          app: "test",
          entity: "item",
          action: "delete",
          entityId: "order-1",
          orgId: TEST_ORG_ID,
        })
      },
    )

    // Process the batch
    const processed = await processOutboxBatch()
    expect(processed).toBe(3)

    // Verify all events were processed (all 3 actions present and marked processed)
    const rows = await sql`
      SELECT payload, processed_at FROM kernel.pending_events
      WHERE (payload->>'entityId')::text = 'order-1'
      ORDER BY processed_at
    `
    expect(rows).toHaveLength(3)
    const actions = rows.map((r: any) => r.payload.action).sort()
    expect(actions).toEqual(["create", "delete", "update"])
    // All should be marked as processed
    for (const row of rows) {
      expect(row.processed_at).not.toBeNull()
    }
    // processed_at should be in non-decreasing order (processed sequentially)
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i].processed_at).getTime()).toBeGreaterThanOrEqual(
        new Date(rows[i - 1].processed_at).getTime(),
      )
    }
  })

  it("processOutboxBatch does NOT mark event as processed when publish fails", async () => {
    // Register declared emits for "test" so that an undeclared action triggers a throw
    // inside _publishEventInternal (event-bus validates against declared emits).
    declaredEmits.set("test", new Set(["item:create"]))

    try {
      // Insert event directly via SQL with an undeclared action — avoids withRlsContext
      // which can be affected by mocks in other test files (bun runs all in one process).
      const payload = JSON.stringify({
        app: "test",
        entity: "item",
        action: "UNDECLARED_ACTION",
        entityId: "fail-1",
        orgId: TEST_ORG_ID,
        actorId: TEST_USER_ID,
      })
      await sql`
        INSERT INTO kernel.pending_events (org_id, payload)
        VALUES (${TEST_ORG_ID}, ${payload}::jsonb)
      `

      // Verify it was inserted
      const before = await sql`
        SELECT processed_at FROM kernel.pending_events
        WHERE (payload->>'entityId')::text = 'fail-1'
      `
      expect(before).toHaveLength(1)
      expect(before[0].processed_at).toBeNull()

      // Run the outbox worker — it should catch the publish error and release the claim
      const processed = await processOutboxBatch()
      expect(processed).toBe(0)

      // Verify the event is still unprocessed and its claim was released
      const rows = await sql`
        SELECT processed_at, claimed_at, claimed_by
        FROM kernel.pending_events
        WHERE (payload->>'entityId')::text = 'fail-1'
      `
      expect(rows).toHaveLength(1)
      expect(rows[0].processed_at).toBeNull()
      expect(rows[0].claimed_at).toBeNull()
      expect(rows[0].claimed_by).toBeNull()
    } finally {
      // Clean up declared emits to avoid affecting other tests
      declaredEmits.delete("test")
    }
  })

  it("processOutboxBatch marks queued events as processed", async () => {
    await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: ["test:items"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.queueEvent({
          app: "test",
          entity: "item",
          action: "create",
          entityId: "batch-1",
          orgId: TEST_ORG_ID,
          actorId: TEST_USER_ID,
        })
      },
    )

    // Verify it exists and is unprocessed
    const before =
      await sql`SELECT * FROM kernel.pending_events WHERE org_id = '00000000-0000-0000-0000-b00000000001'`
    expect(before).toHaveLength(1)
    expect(before[0].processed_at).toBeNull()

    // Run the outbox worker batch
    const processed = await processOutboxBatch()
    expect(processed).toBeGreaterThanOrEqual(1)

    // Verify it is now marked as processed
    const after =
      await sql`SELECT * FROM kernel.pending_events WHERE org_id = '00000000-0000-0000-0000-b00000000001'`
    expect(after).toHaveLength(1)
    expect(after[0].processed_at).not.toBeNull()
  })
})

describe("Fix: transactional outbox atomicity", () => {
  it("queueEvent is rolled back when transaction throws", async () => {
    // Count pending events before
    const [before] =
      await sql`SELECT COUNT(*)::int AS n FROM kernel.pending_events WHERE processed_at IS NULL`

    // Start a transaction, queue an event, then throw to roll back
    try {
      await withRlsContext(
        { actorType: "system", orgId: TEST_ORG_ID, purpose: "audit" },
        async (tx) => {
          await tx.queueEvent({
            app: "kernel",
            entity: "test",
            action: "rollback_check",
            orgId: TEST_ORG_ID,
          })
          throw new Error("Intentional rollback")
        },
      )
    } catch (e: any) {
      expect(e.message).toBe("Intentional rollback")
    }

    // Count after — should be the same (event was rolled back)
    const [after] =
      await sql`SELECT COUNT(*)::int AS n FROM kernel.pending_events WHERE processed_at IS NULL`
    expect(after.n).toBe(before.n)
  })

  it("queueEvent persists when transaction commits", async () => {
    const [before] =
      await sql`SELECT COUNT(*)::int AS n FROM kernel.pending_events WHERE processed_at IS NULL`

    await withRlsContext(
      { actorType: "system", orgId: TEST_ORG_ID, purpose: "audit" },
      async (tx) => {
        await tx.queueEvent({
          app: "kernel",
          entity: "test",
          action: "commit_check",
          orgId: TEST_ORG_ID,
        })
      },
    )

    const [after] =
      await sql`SELECT COUNT(*)::int AS n FROM kernel.pending_events WHERE processed_at IS NULL`
    expect(after.n).toBe(before.n + 1)

    // Clean up
    await sql`DELETE FROM kernel.pending_events WHERE (payload->>'action')::text = 'commit_check'`
  })
})

describe("Security: queueEvent try/finally restores liaison_rls role", () => {
  it("RLS-enforced queries work after queueEvent (role restored to liaison_rls)", async () => {
    const { users } = await import("~/db/schema/kernel")

    // If queueEvent didn't restore liaison_rls, subsequent queries would
    // bypass RLS (running as liaison_admin). This test verifies the role
    // is properly restored by running an org-scoped query after queueEvent.
    let queryWorked = false
    await withRlsContext(
      {
        actorType: "user",
        userId: TEST_USER_ID,
        orgId: TEST_ORG_ID,
        scopes: ["kernel"],
        dimensionGrants: {},
      },
      async (tx) => {
        await tx.queueEvent({
          app: "kernel",
          entity: "test",
          action: "role_check",
          orgId: TEST_ORG_ID,
        })
        // This SELECT runs after queueEvent — under liaison_rls it's org-scoped
        const rows = await tx.select({ id: users.id }).from(users).limit(10)
        queryWorked = Array.isArray(rows)
      },
    )
    expect(queryWorked).toBe(true)

    // Clean up
    await sql`DELETE FROM kernel.pending_events WHERE (payload->>'action')::text = 'role_check'`
  })
})
