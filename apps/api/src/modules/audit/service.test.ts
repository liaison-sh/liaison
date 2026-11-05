// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { auditLogger } from "~/lib/logger"
import { queryAuditLogPage, writeAuditLog } from "~/modules/audit/service"

/** A db whose insert always fails -- mirrors a constraint or connection error. */
const failingDb = {
  insert: () => ({
    values: () => {
      throw new Error("insert boom")
    },
  }),
} as unknown as Parameters<typeof writeAuditLog>[0]

/** Capture one logger level's MESSAGES while `fn` runs, then restore it. */
async function messagesAt(
  level: "error" | "warn" | "debug",
  fn: () => Promise<void>,
): Promise<string[]> {
  const seen: string[] = []
  const spy = spyOn(auditLogger, level).mockImplementation(((obj: unknown, msg?: unknown) => {
    seen.push(typeof obj === "string" ? obj : String(msg ?? ""))
  }) as never)
  try {
    await fn()
  } finally {
    spy.mockRestore()
  }
  return seen
}

describe("audit log service", () => {
  const orgId = "00000000-0000-0000-0000-000000000001"
  const actorId = "00000000-0000-0000-0000-000000000002"

  const rlsCtx = {
    actorType: "user" as const,
    userId: actorId,
    orgId,
    scopes: ["kernel"],
    dimensionGrants: {},
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${orgId}, 'Test', 'test') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
  })

  it("writes an audit entry", async () => {
    await withRlsContext(rlsCtx, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: actorId,
        actorType: "user",
        app: "test",
        entityType: "item",
        entityId: "item-1",
        action: "created",
        changes: { after: { title: "New Item" } },
      }),
    )

    const { entries } = await withRlsContext(rlsCtx, (tx) => queryAuditLogPage(tx, orgId, {}))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0].action).toBe("created")
  })

  it("records before/after diffs for updates", async () => {
    await withRlsContext(rlsCtx, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: actorId,
        actorType: "user",
        app: "test",
        entityType: "item",
        entityId: "item-1",
        action: "updated",
        changes: {
          before: { status: "open" },
          after: { status: "resolved" },
        },
      }),
    )

    const { entries } = await withRlsContext(rlsCtx, (tx) =>
      queryAuditLogPage(tx, orgId, { action: "updated" }),
    )
    expect(entries[0].changes).toEqual({
      before: { status: "open" },
      after: { status: "resolved" },
    })
  })

  it("normalizes non-UUID actorId into metadata.actorLabel and persists with null actor_id", async () => {
    await withRlsContext(rlsCtx, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: "system:mail:gmail-initial-sync",
        actorType: "system",
        app: "mail",
        action: "account.update",
        changes: { syncStatus: "active" },
      }),
    )
    const { entries } = await withRlsContext(rlsCtx, (tx) =>
      queryAuditLogPage(tx, orgId, { action: "account.update" }),
    )
    expect(entries.length).toBeGreaterThan(0)
    const row = entries[0]!
    expect(row.actorId).toBeNull()
    expect((row.metadata as Record<string, unknown> | null)?.actorLabel).toBe(
      "system:mail:gmail-initial-sync",
    )
  })

  it("an empty actor id is recorded as a system row with no actor, never a uuid error", async () => {
    // A connection created or disconnected by `liaison config apply` without an
    // admin section carried actorId "" and actorType "user": the uuid column
    // refused "" (22P02) and the durable audit consumer dead-lettered the row.
    await withRlsContext(rlsCtx, (tx) =>
      writeAuditLog(
        tx,
        {
          orgId,
          actorId: "",
          actorType: "user",
          app: "kernel",
          entityType: "connected_account",
          entityId: "00000000-0000-0000-0000-0000000000aa",
          action: "connected_account.empty-actor",
        },
        { required: true },
      ),
    )
    const { entries } = await withRlsContext(rlsCtx, (tx) =>
      queryAuditLogPage(tx, orgId, { action: "connected_account.empty-actor" }),
    )
    expect(entries.length).toBe(1)
    expect(entries[0]!.actorId).toBeNull()
    expect(entries[0]!.actorType).toBe("system")
  })

  it("audit write failure does not throw", async () => {
    // Simulate a problematic entry — should not throw
    await withRlsContext(rlsCtx, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: null as any,
        actorType: "system",
        action: "test-no-throw",
      }),
    )
    // If we get here, it didn't throw
  })

  it("a required failure the caller RECOVERS from does not page as an error (FX27)", async () => {
    // `writeAuditRowInOwnTx` catches this and retries the row in a NEW
    // transaction, so the row is not lost and no caller transaction is rolled
    // back. Logging it at error made every RECOVERED row page, and on the
    // outbox-bypass path the "rolling back" message was false as well: nothing
    // there is rolled back, the error is swallowed at that boundary.
    const entry = { orgId, actorType: "system" as const, action: "test-recovered" }
    const run = async () => {
      await expect(
        writeAuditLog(failingDb, entry, { required: true, outcomeReportedByCaller: true }),
      ).rejects.toThrow("insert boom")
    }

    expect(await messagesAt("error", run)).toEqual([])
    expect(await messagesAt("debug", run)).toEqual([
      "Audit log entry failed, propagating so the caller can retry it in a new transaction",
    ])
  })

  it("a required failure nobody recovers from still pages, and claims only what is true (FX27)", async () => {
    const entry = { orgId, actorType: "system" as const, action: "test-not-recovered" }
    const messages = await messagesAt("error", async () => {
      await expect(writeAuditLog(failingDb, entry, { required: true })).rejects.toThrow(
        "insert boom",
      )
    })
    expect(messages).toEqual([
      "Required audit log entry failed, rolling the caller transaction back",
    ])
  })

  it("swallows a failing insert by default but rethrows when required (I-EVT-3)", async () => {
    const entry = { orgId, actorType: "system" as const, action: "test-required" }

    // Best-effort path (default) swallows the error.
    await writeAuditLog(failingDb, entry)

    // Compliance-critical path propagates so the caller's tx rolls back.
    await expect(writeAuditLog(failingDb, entry, { required: true })).rejects.toThrow("insert boom")
  })

  it("queries with filters", async () => {
    const { entries } = await withRlsContext(rlsCtx, (tx) =>
      queryAuditLogPage(tx, orgId, {
        app: "test",
        entityType: "item",
      }),
    )
    expect(entries.every((e: any) => e.app === "test")).toBe(true)
  })

  it("a returned row names the acting agent", async () => {
    // Filtering by agent while returning rows that never name one makes the
    // answer uncheckable: a reader cannot tell which agent a row belongs to,
    // and a caller cannot page over mixed results (A11).
    const agentId = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${agentId}, ${orgId}, 'role', ${`@svc-audit-${agentId.slice(0, 8)}`}, 'Logistics')`
    await withRlsContext(rlsCtx, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId,
        actorType: "agent",
        app: "test",
        action: "agent-attributed",
        agentId,
      }),
    )

    const { entries } = await withRlsContext(rlsCtx, (tx) =>
      queryAuditLogPage(tx, orgId, { action: "agent-attributed" }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.agentId).toBe(agentId)

    // A row with no agent still reads as an explicit null, never as absent.
    const { entries: human } = await withRlsContext(rlsCtx, (tx) =>
      queryAuditLogPage(tx, orgId, { action: "created" }),
    )
    expect(human[0]!.agentId).toBeNull()
  })
})
