// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import * as dbPrivilegedModule from "~/db/privileged"
import * as objectStorageModule from "~/infra/storage/object-storage"
import {
  createRpcBridge,
  extractRoutineBoundDocId,
  SandboxBridgeTestAccess,
} from "~/modules/apps/sandbox/rpc-bridge"
import * as filesAttachModule from "~/modules/files/attach"
import * as filesServiceModule from "~/modules/files/service"
import * as pdfRenderModule from "~/modules/pdf/render"

const TEST_ORG = "00000000-0000-0000-0000-000000b50001"
const TEST_USER = "00000000-0000-0000-0000-000000b50002"
const TEST_APP = "test-bridge"

// BL-275 — a routine-tick knowledge_create is deterministically redirected onto the running doc the
// authored prompt BINDS ("MAINTAIN THIS EXISTING RUNNING DOC … id <UUID>"), so a flash-lite tick that
// invents an unrelated findings-doc title still updates the one running doc. Pin the id parse the
// redirect keys on.
describe("extractRoutineBoundDocId — parse the bound running-doc id from a routine prompt (BL-275)", () => {
  it("extracts the UUID the binding directive names", () => {
    const prompt =
      "Each Monday web_watch each dealer's page and update findings.\n\n" +
      "MAINTAIN THIS EXISTING RUNNING DOC (do NOT create a new one): a running findings Knowledge doc " +
      'titled EXACTLY "Dealer Price Watch — Kestrel 6 (RAL-44)" (id 11111111-2222-3333-4444-555555555555) ' +
      "already exists for this watch. EACH TICK, write this week's findings by calling knowledge_update."
    expect(extractRoutineBoundDocId(prompt)).toBe("11111111-2222-3333-4444-555555555555")
  })

  it("returns null when there is no binding directive / no prompt", () => {
    expect(extractRoutineBoundDocId("Each Monday web_watch each dealer's page.")).toBeNull()
    expect(extractRoutineBoundDocId("")).toBeNull()
    expect(extractRoutineBoundDocId(null)).toBeNull()
    // A bare UUID NOT under the directive header must NOT be picked up (only the bound directive's id).
    expect(
      extractRoutineBoundDocId("see doc 11111111-2222-3333-4444-555555555555 for context"),
    ).toBeNull()
  })
})

describe("createRpcBridge", () => {
  // Mock txDb with a simple execute method. Declared return is a row array (not the inferred
  // `never[]`) so per-test `mockImplementationOnce` can return typed rows (e.g. a count row) for the
  // AND→OR fallback tests (BL-53) without an `as any` cast.
  const mockExecute = mock(async (): Promise<Array<Record<string, unknown>>> => [])
  const mockQueueEvent = mock(async () => {})
  const mockTx = {
    execute: mockExecute,
    select: mock(() => mockTx),
    from: mock(() => mockTx),
    where: mock(() => mockTx),
    queueEvent: mockQueueEvent,
    transaction: mock((fn: any) => fn(mockTx)),
  }

  const manifest = {
    name: TEST_APP,
    schema: {
      items: {
        fields: { title: "string", status: "string", count: "number" },
      },
    },
    events: { emits: ["items:created", "items:updated"] },
    connections: {},
    network: { allowedDomains: [] },
  }

  it("creates a bridge with all expected methods", () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    expect(typeof bridge.db_findMany).toBe("function")
    expect(typeof bridge.db_findOne).toBe("function")
    expect(typeof bridge.db_insert).toBe("function")
    expect(typeof bridge.db_update).toBe("function")
    expect(typeof bridge.db_delete).toBe("function")
    expect(typeof bridge.db_count).toBe("function")
    expect(typeof bridge.kernel_findOne).toBe("function")
    expect(typeof bridge.emit).toBe("function")
    expect(typeof bridge.enqueueJob).toBe("function")
    expect(typeof bridge.resolveContact).toBe("function")
    expect(typeof bridge.log_info).toBe("function")
    expect(typeof bridge.log_warn).toBe("function")
    expect(typeof bridge.log_error).toBe("function")
    expect(typeof bridge.log_debug).toBe("function")
  })

  it("db_findMany rejects entity not in manifest schema", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await expect(bridge.db_findMany("unknown_entity", "{}")).rejects.toThrow(
      "not found in app schema",
    )
  })

  it("kernel_findOne rejects non-whitelisted kernel entities", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)

    await expect(bridge.kernel_findOne("organizations", TEST_ORG)).rejects.toThrow("not allowed")
  })

  it("kernel_findOne allows contacts and users only", async () => {
    mockExecute.mockClear()
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)

    await bridge.kernel_findOne("contacts", "00000000-0000-0000-0000-000000b50003")
    await bridge.kernel_findOne("users", TEST_USER)

    expect(mockExecute).toHaveBeenCalledTimes(2)
    const firstQuery = (mockExecute.mock.calls as any[])[0]?.[0]
    const firstBuilt = firstQuery.toQuery({
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (index: number) => `$${index + 1}`,
      escapeString: (str: string) => `'${str}'`,
      casing: { getColumnCasing: (column: string) => column },
    })
    expect(firstBuilt.sql).toContain('"kernel"."contacts"')
  })

  it("db_insert rejects entity not in manifest schema", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await expect(bridge.db_insert("nonexistent", '{"title":"test"}')).rejects.toThrow(
      "not found in app schema",
    )
  })

  it("db_insert rejects unknown field names", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    // "color" is not declared in the items schema
    await expect(bridge.db_insert("items", '{"title":"test","color":"red"}')).rejects.toThrow(
      "Unknown field",
    )
  })

  it("db_insert rejects invalid field type (integer expected, string given)", async () => {
    const manifestWithInt = {
      ...manifest,
      schema: { items: { fields: { title: "string", priority: "integer" } } },
    }
    const bridge = createRpcBridge(
      TEST_APP,
      TEST_USER,
      TEST_ORG,
      mockTx as any,
      manifestWithInt as any,
    )
    await expect(bridge.db_insert("items", '{"title":"ok","priority":"high"}')).rejects.toThrow(
      "invalid type",
    )
  })

  // A failed db_insert must NOT poison the surrounding transaction. The INSERT runs in a
  // DRIVER savepoint (`txDb.transaction`): a raw SAVEPOINT statement is not enough, postgres.js
  // rethrows a caught failed query when its transaction scope ends. The behavioural proof against a
  // real database is modules/webhooks/caught-db-error.test.ts.
  const sqlTextOf = (q: unknown): string =>
    (q as { toQuery: (cfg: unknown) => { sql: string } }).toQuery({
      escapeName: (n: string) => `"${n}"`,
      escapeParam: (i: number) => `$${i + 1}`,
      escapeString: (s: string) => `'${s}'`,
      casing: { getColumnCasing: (c: string) => c },
    }).sql

  it("db_insert runs the INSERT inside a driver savepoint (txDb.transaction)", async () => {
    mockExecute.mockClear()
    mockTx.transaction.mockClear()
    mockExecute.mockImplementation(async () => [{ id: "row-1" }])
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_insert("items", '{"title":"ok"}')
    const stmts = (mockExecute.mock.calls as any[]).map((c) => sqlTextOf(c[0]))
    expect(stmts.some((s) => /INSERT INTO/i.test(s))).toBe(true)
    // No raw savepoint around the INSERT itself: only the anchor that releases
    // the driver's savepoint once the insert is done (db/savepoint.ts).
    expect(stmts.filter((s) => /SAVEPOINT/i.test(s))).toEqual([
      "SAVEPOINT liaison_released_sp",
      "RELEASE SAVEPOINT liaison_released_sp",
    ])
    expect(mockTx.transaction).toHaveBeenCalledTimes(1)
    mockExecute.mockImplementation(async () => [])
  })

  it("db_insert rethrows a failed INSERT from its savepoint with pg detail", async () => {
    mockExecute.mockClear()
    mockTx.transaction.mockClear()
    mockExecute.mockImplementation(async (q?: unknown) => {
      const sql = q ? sqlTextOf(q) : ""
      if (/INSERT INTO/i.test(sql)) {
        throw {
          message: "insert failed",
          cause: {
            message: 'duplicate key value violates unique constraint "items_org_id_key_key"',
            code: "23505",
          },
        }
      }
      return []
    })
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await expect(bridge.db_insert("items", '{"title":"dupe"}')).rejects.toThrow(/23505/)
    // The INSERT ran in the savepoint, which the driver rolls back alone.
    expect(mockTx.transaction).toHaveBeenCalledTimes(1)
    mockExecute.mockImplementation(async () => [])
  })

  it("db_update rejects unknown field names", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await expect(bridge.db_update("items", "id-1", '{"nonexistent_field":"val"}')).rejects.toThrow(
      "Unknown field",
    )
  })

  it("db_update serializes json fields as jsonb parameters", async () => {
    mockExecute.mockClear()
    const manifestWithJson = {
      ...manifest,
      schema: { items: { fields: { syncState: "json?" } } },
    }
    const bridge = createRpcBridge(
      TEST_APP,
      TEST_USER,
      TEST_ORG,
      mockTx as any,
      manifestWithJson as any,
    )

    await bridge.db_update(
      "items",
      "id-1",
      JSON.stringify({ syncState: { cursor: "next", count: 1 } }),
    )

    const query = (mockExecute.mock.calls as any[])[0]?.[0]
    expect(query).toBeDefined()
    const built = query.toQuery({
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (index: number) => `$${index + 1}`,
      escapeString: (str: string) => `'${str}'`,
      casing: { getColumnCasing: (column: string) => column },
    })

    expect(built.sql).toContain('"sync_state" = $1::jsonb')
    expect(built.params[0]).toBe('{"cursor":"next","count":1}')
  })

  const renderQuery = (q: any) =>
    q.toQuery({
      escapeName: (name: string) => `"${name}"`,
      escapeParam: (index: number) => `$${index + 1}`,
      escapeString: (str: string) => `'${str}'`,
      casing: { getColumnCasing: (column: string) => column },
    })

  it("db_count TOKENIZES a multi-word search (AND-of-OR per term, not whole-phrase substring) — BL-51", async () => {
    mockExecute.mockClear()
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_count(
      "items",
      JSON.stringify({
        where: {},
        search: { fields: ["title", "status"], query: "kestrel firmware" },
      }),
    )
    const built = renderQuery((mockExecute.mock.calls as any[])[0]?.[0])
    // Each TERM is matched independently (so the words need not be contiguous): the OLD code emitted a
    // single `ILIKE '%kestrel firmware%'`; the fix emits per-term ILIKEs.
    expect(built.params).toContain("%kestrel%")
    expect(built.params).toContain("%firmware%")
    expect(built.params).not.toContain("%kestrel firmware%")
    // 2 terms × 2 fields = 4 ILIKE clauses (each term OR'd across fields, terms AND'd).
    expect((built.sql.match(/ILIKE/g) || []).length).toBe(4)
  })

  it("db_count leaves a SINGLE-term search unchanged (backward-compatible) — BL-51", async () => {
    mockExecute.mockClear()
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_count(
      "items",
      JSON.stringify({ where: {}, search: { fields: ["title"], query: "firmware" } }),
    )
    const built = renderQuery((mockExecute.mock.calls as any[])[0]?.[0])
    expect(built.params).toContain("%firmware%")
    expect((built.sql.match(/ILIKE/g) || []).length).toBe(1)
  })

  it("db_count falls back from AND-of-terms to OR-of-terms when the precise count is 0 — BL-53", async () => {
    mockExecute.mockClear()
    // Default mock returns [] ⇒ count 0 ⇒ the multi-term AND finds nothing ⇒ fallback fires.
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_count(
      "items",
      JSON.stringify({
        where: {},
        search: { fields: ["title", "status"], query: "bricking firmware" },
      }),
    )
    // Two queries: the precise AND first, then the OR recall fallback.
    expect(mockExecute).toHaveBeenCalledTimes(2)
    const andQ = renderQuery((mockExecute.mock.calls as any[])[0]?.[0])
    const orQ = renderQuery((mockExecute.mock.calls as any[])[1]?.[0])
    // term-groups joined by " AND " in the first query, " OR " in the fallback (the per-field
    // join inside each group is OR in both, so `) AND (` / `) OR (` uniquely marks the term joiner).
    expect((andQ.sql.match(/\)\s+AND\s+\(/g) || []).length).toBe(1)
    expect((andQ.sql.match(/\)\s+OR\s+\(/g) || []).length).toBe(0)
    expect((orQ.sql.match(/\)\s+OR\s+\(/g) || []).length).toBe(1)
    expect((orQ.sql.match(/\)\s+AND\s+\(/g) || []).length).toBe(0)
    // both carry the same per-term params (only the joiner changes)
    expect(orQ.params).toContain("%bricking%")
    expect(orQ.params).toContain("%firmware%")
  })

  it("db_count does NOT fall back when the precise AND already matches — BL-53", async () => {
    mockExecute.mockClear()
    mockExecute.mockImplementationOnce(async () => [{ count: 3 }])
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    const out = await bridge.db_count(
      "items",
      JSON.stringify({
        where: {},
        search: { fields: ["title", "status"], query: "kestrel firmware" },
      }),
    )
    expect(out).toBe("3")
    expect(mockExecute).toHaveBeenCalledTimes(1) // AND matched ⇒ no OR fallback
  })

  it("db_count does NOT fall back for a single-term search — BL-53", async () => {
    mockExecute.mockClear()
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_count(
      "items",
      JSON.stringify({ where: {}, search: { fields: ["title"], query: "firmware" } }),
    )
    // One term is identical under AND/OR — widening would be pointless and is suppressed.
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it("db_findMany falls back from AND to OR when the first page is empty — BL-53", async () => {
    mockExecute.mockClear()
    // Default [] ⇒ AND first page empty ⇒ OR fallback (offset 0, multi-term).
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_findMany(
      "items",
      JSON.stringify({ search: { fields: ["title", "status"], query: "bricking firmware" } }),
    )
    expect(mockExecute).toHaveBeenCalledTimes(2)
    const orQ = renderQuery((mockExecute.mock.calls as any[])[1]?.[0])
    expect((orQ.sql.match(/\)\s+OR\s+\(/g) || []).length).toBe(1)
    expect((orQ.sql.match(/\)\s+AND\s+\(/g) || []).length).toBe(0)
  })

  it("db_findMany does NOT fall back when the AND page already has rows — BL-53", async () => {
    mockExecute.mockClear()
    mockExecute.mockImplementationOnce(async () => [{ id: "x", title: "firmware notes" }])
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_findMany(
      "items",
      JSON.stringify({ search: { fields: ["title", "status"], query: "kestrel firmware" } }),
    )
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it("db_findMany does NOT fall back on a non-first page (offset > 0) — BL-53", async () => {
    mockExecute.mockClear()
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await bridge.db_findMany(
      "items",
      JSON.stringify({
        offset: 20,
        search: { fields: ["title", "status"], query: "bricking firmware" },
      }),
    )
    // An empty later page means "no more rows", not "AND too strict" — never silently widen.
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  // `where: { col: null }` must compile to `col IS NULL`, not `col = NULL` (never true in SQL) —
  // a sandboxed app's null-column upsert-check (e.g. social's monitor_terms_add matching an
  // existing NULL-platform term) silently matched zero rows and duplicated on every re-add.
  describe("buildWhereClause — null where-values compile to IS NULL, not = NULL", () => {
    it("db_findMany: a null where-value emits `col IS NULL`", async () => {
      mockExecute.mockClear()
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await bridge.db_findMany("items", JSON.stringify({ where: { status: null } }))
      const q = renderQuery((mockExecute.mock.calls as any[])[0]?.[0])
      expect(q.sql).toContain('"status" IS NULL')
      expect(q.sql).not.toContain('"status" = ')
    })

    it("db_updateMany: a null where-value emits `col IS NULL`", async () => {
      mockExecute.mockClear()
      mockExecute.mockImplementationOnce(async () => ({ rowCount: 1 }) as any)
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await bridge.db_updateMany(
        "items",
        JSON.stringify({ where: { status: null }, data: { title: "updated" } }),
      )
      const q = renderQuery((mockExecute.mock.calls as any[])[0]?.[0])
      expect(q.sql).toContain('"status" IS NULL')
      expect(q.sql).not.toMatch(/"status"\s*=\s*\$/)
    })

    it("db_count: a null where-value emits `col IS NULL`", async () => {
      mockExecute.mockClear()
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await bridge.db_count("items", JSON.stringify({ where: { status: null } }))
      const q = renderQuery((mockExecute.mock.calls as any[])[0]?.[0])
      expect(q.sql).toContain('"status" IS NULL')
      expect(q.sql).not.toMatch(/"status"\s*=\s*\$/)
    })

    it("db_findMany: a non-null where-value is unaffected (still `col = $n`)", async () => {
      mockExecute.mockClear()
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await bridge.db_findMany("items", JSON.stringify({ where: { status: "active" } }))
      const q = renderQuery((mockExecute.mock.calls as any[])[0]?.[0])
      expect(q.sql).toMatch(/"status"\s*=\s*\$/)
      expect(q.sql).not.toContain("IS NULL")
    })
  })

  // postgres.js returns Postgres `numeric` columns as STRINGS; the bridge must coerce
  // manifest-declared number/integer fields back to JS numbers on the read path, or handler
  // arithmetic concatenates ("0" + 100 → "0100") and the next write fails validateFields.
  // First bitten live by social's YouTube quota accounting (sync_state.units_consumed_today).
  describe("numeric row fields — pg numeric strings coerce to numbers on read", () => {
    it("db_findMany: a declared-number field returned as a string becomes a number", async () => {
      mockExecute.mockClear()
      mockExecute.mockImplementationOnce(async () => [
        { id: "r1", title: "a", status: "active", count: "42" },
      ])
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      const rows = JSON.parse(await bridge.db_findMany("items", "{}"))
      expect(rows[0].count).toBe(42)
      expect(rows[0].status).toBe("active")
    })

    it("db_findOne: coerces the declared-number field", async () => {
      mockExecute.mockClear()
      const id = "0b7d3a1e-8f2c-4c5a-9d6e-1f2a3b4c5d6e"
      mockExecute.mockImplementationOnce(async () => [{ id, count: "0" }])
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      const row = JSON.parse(await bridge.db_findOne("items", id))
      expect(row.count).toBe(0)
    })

    // App-table ids are UUIDs (ddl.ts). An agent handing a Shopify order id to a
    // `shipment_id` parameter used to reach Postgres and raise 22P02 -- a level-50
    // "Failed query" line that paged the watchdog as a fresh signature per literal.
    it("db_findOne: a non-UUID id is 'not found' without touching the database", async () => {
      mockExecute.mockClear()
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      expect(JSON.parse(await bridge.db_findOne("items", "876374665526"))).toBeNull()
      expect(JSON.parse(await bridge.db_findOne("items", "#2357"))).toBeNull()
      expect(mockExecute).not.toHaveBeenCalled()
    })

    it("db_insert: the RETURNING row's declared-number field is coerced", async () => {
      mockExecute.mockClear()
      mockExecute.mockImplementation(async () => [{ id: "r1", count: "7" }])
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      const row = JSON.parse(await bridge.db_insert("items", JSON.stringify({ title: "t" })))
      expect(row.count).toBe(7)
      mockExecute.mockImplementation(async () => [])
    })

    it("leaves non-numeric strings and undeclared fields untouched", async () => {
      mockExecute.mockClear()
      mockExecute.mockImplementationOnce(async () => [
        { id: "r1", count: "not-a-number", title: "12" },
      ])
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      const rows = JSON.parse(await bridge.db_findMany("items", "{}"))
      expect(rows[0].count).toBe("not-a-number")
      expect(rows[0].title).toBe("12")
    })
  })

  it("smtp_send routes through the test stub when set, bypassing credential resolution — BL-57", async () => {
    // Chaos has no real connected mailbox: the real smtp_send resolves stored credentials (throws
    // "No credentials stored") then connects via nodemailer. The stub lets an approved mail:reply
    // execute deterministically without credentials or a real SMTP host.
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    SandboxBridgeTestAccess.setSmtpSend(async (conn, identifier, _msg) => ({
      messageId: `<stub-${conn}-${identifier}@chaos.test>`,
      deliveryState: "delivered",
    }))
    try {
      const out = JSON.parse(
        await bridge.smtp_send("imap", "support@qa.local", JSON.stringify({ subject: "hi" })),
      )
      expect(out.messageId).toBe("<stub-imap-support@qa.local@chaos.test>")
      expect(out.deliveryState).toBe("delivered")
    } finally {
      SandboxBridgeTestAccess.setSmtpSend(null)
    }
  })

  it("db_updateMany rejects malformed where clause", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    // No 'where' clause — required for updateMany
    await expect(bridge.db_updateMany("items", '{"data":{"title":"new"}}')).rejects.toThrow("where")
  })

  it("emit rejects undeclared events", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    await expect(
      bridge.emit(JSON.stringify({ entity: "items", action: "deleted" })),
    ).rejects.toThrow("undeclared")
  })

  it("emit accepts declared events", async () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    // This should not throw (will call mockTx.queueEvent)
    await bridge.emit(JSON.stringify({ entity: "items", action: "created", entityId: "123" }))
    expect(mockQueueEvent).toHaveBeenCalled()
  })

  it("provides userId and orgId as direct properties", () => {
    const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
    expect(bridge.getUserId()).toBe(TEST_USER)
    expect(bridge.getOrgId()).toBe(TEST_ORG)
  })

  it("emits system actorType for system callers", async () => {
    mockQueueEvent.mockClear()
    const bridge = createRpcBridge(
      TEST_APP,
      "system:test-job",
      TEST_ORG,
      mockTx as any,
      manifest as any,
    )

    await bridge.emit(JSON.stringify({ entity: "items", action: "created", entityId: "123" }))

    expect(mockQueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "system:test-job",
        actorType: "system",
      }),
    )
  })

  describe("ctx.fetch DNS pinning", () => {
    let lookupSpy: ReturnType<typeof spyOn>

    beforeEach(() => {
      lookupSpy = spyOn(dnsPromises, "lookup")
    })
    afterEach(() => {
      lookupSpy.mockRestore()
      SandboxBridgeTestAccess.setFetch(null)
    })

    it("resolves DNS exactly once per hop (no re-resolve at connect time)", async () => {
      let calls = 0
      lookupSpy.mockImplementation((async () => {
        calls++
        return calls === 1
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "169.254.169.254", family: 4 }]
      }) as never)

      const networkManifest = {
        ...manifest,
        network: { allowedDomains: ["attacker.example"] },
      }
      const bridge = createRpcBridge(
        TEST_APP,
        TEST_USER,
        TEST_ORG,
        mockTx as any,
        networkManifest as any,
      )

      SandboxBridgeTestAccess.setFetch(
        (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
      )

      await bridge.fetch("https://attacker.example/x", JSON.stringify({ method: "GET" }))
      expect(calls).toBe(1)
    })
  })

  describe("emit field-override defense", () => {
    it("ignores attacker-supplied event.app and pins to bridge appName", async () => {
      const localQueueEvent = mock(async () => {})
      const localTx = { ...mockTx, queueEvent: localQueueEvent }
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, localTx as any, manifest as any)

      await bridge.emit(
        JSON.stringify({
          app: "kernel",
          entity: "items",
          action: "created",
          entityId: "00000000-0000-0000-0000-0000000000aa",
        }),
      )

      expect(localQueueEvent).toHaveBeenCalledTimes(1)
      const queued = (localQueueEvent.mock.calls as any[])[0][0]
      expect(queued.app).toBe(TEST_APP)
      expect(queued.orgId).toBe(TEST_ORG)
      expect(queued.actorId).toBe(TEST_USER)
      expect(queued.entity).toBe("items")
      expect(queued.action).toBe("created")
    })

    it("rejects forged entity:action even when event.app is forged", async () => {
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await expect(
        bridge.emit(
          JSON.stringify({
            app: TEST_APP,
            entity: "participant",
            action: "add",
            entityId: "00000000-0000-0000-0000-0000000000bb",
          }),
        ),
      ).rejects.toThrow(/undeclared event/)
    })

    it("pins orgId/actorId/actorType/timestamp even if event tries to override", async () => {
      const localQueueEvent = mock(async () => {})
      const localTx = { ...mockTx, queueEvent: localQueueEvent }
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, localTx as any, manifest as any)

      await bridge.emit(
        JSON.stringify({
          entity: "items",
          action: "created",
          orgId: "00000000-0000-0000-0000-0000deadbeef",
          actorId: "00000000-0000-0000-0000-0000deadbeef",
          actorType: "system",
          timestamp: "1970-01-01T00:00:00.000Z",
        }),
      )

      const queued = (localQueueEvent.mock.calls as any[])[0][0]
      expect(queued.orgId).toBe(TEST_ORG)
      expect(queued.actorId).toBe(TEST_USER)
      expect(queued.actorType).not.toBe("system")
      expect(queued.timestamp).not.toBe("1970-01-01T00:00:00.000Z")
    })
  })

  // ---- Phase 10 attachment bridges ------------------------------------------

  describe("files_listAttachments", () => {
    it("rejects cross-app listing", async () => {
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await expect(
        bridge.files_listAttachments(
          JSON.stringify({
            app: "other-app",
            entityType: "message",
            entityId: "11111111-1111-1111-1111-111111111111",
          }),
        ),
      ).rejects.toThrow(/cross-app/)
    })

    it("allows listing when app matches caller", async () => {
      const localTx = {
        execute: mock(async () => []),
        select: mock(() => localTx),
        from: mock(() => localTx),
        where: mock(() => localTx),
        queueEvent: mock(async () => {}),
        transaction: mock((fn: any) => fn(localTx)),
      }
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, localTx as any, manifest as any)
      const json = await bridge.files_listAttachments(
        JSON.stringify({
          app: TEST_APP,
          entityType: "items",
          entityId: "11111111-1111-1111-1111-111111111111",
        }),
      )
      expect(JSON.parse(json)).toEqual([])
    })
  })

  describe("files_getAttachmentBytes", () => {
    it("rejects when file's app doesn't match caller", async () => {
      const localTx = {
        // First read returns a file row whose `app` differs from the caller.
        execute: mock(async () => [
          {
            id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
            app: "different-app",
            entity_type: "message",
            entity_id: "11111111-1111-1111-1111-111111111111",
            filename: "x.png",
            mime_type: "image/png",
            size_bytes: 10,
            storage_key: "orgs/o/x",
          },
        ]),
        select: mock(() => localTx),
        from: mock(() => localTx),
        where: mock(() => localTx),
        queueEvent: mock(async () => {}),
        transaction: mock((fn: any) => fn(localTx)),
      }
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, localTx as any, manifest as any)
      await expect(
        bridge.files_getAttachmentBytes(
          JSON.stringify({
            fileId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
            // Caller-supplied allowlist must NOT be the gate.
            allowedParents: [
              {
                app: "different-app",
                entityType: "message",
                entityId: "11111111-1111-1111-1111-111111111111",
              },
            ],
          }),
        ),
      ).rejects.toThrow(/cross-app|forbidden/)
    })

    it("rejects when file is missing", async () => {
      const localTx = {
        execute: mock(async () => []),
        select: mock(() => localTx),
        from: mock(() => localTx),
        where: mock(() => localTx),
        queueEvent: mock(async () => {}),
        transaction: mock((fn: any) => fn(localTx)),
      }
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, localTx as any, manifest as any)
      await expect(
        bridge.files_getAttachmentBytes(
          JSON.stringify({
            fileId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
            allowedParents: [],
          }),
        ),
      ).rejects.toThrow(/forbidden/)
    })
  })

  describe("files_importAttachment", () => {
    it("rejects cross-app import", async () => {
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await expect(
        bridge.files_importAttachment(
          JSON.stringify({
            targetApp: "other-app",
            targetEntityType: "message",
            targetEntityId: "11111111-1111-1111-1111-111111111111",
            filename: "x.png",
            mimeType: "image/png",
            bytesBase64: Buffer.from("hi").toString("base64"),
          }),
        ),
      ).rejects.toThrow(/cross-app/)
    })

    it("rejects malformed targetEntityId", async () => {
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await expect(
        bridge.files_importAttachment(
          JSON.stringify({
            targetApp: TEST_APP,
            targetEntityType: "message",
            targetEntityId: "not-a-uuid",
            filename: "x.png",
            mimeType: "image/png",
            bytesBase64: Buffer.from("hi").toString("base64"),
          }),
        ),
      ).rejects.toThrow(/invalid_target_entity_id|invalid_target/)
    })

    it("rejects mime types with CRLF (header injection)", async () => {
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await expect(
        bridge.files_importAttachment(
          JSON.stringify({
            targetApp: TEST_APP,
            targetEntityType: "message",
            targetEntityId: "11111111-1111-1111-1111-111111111111",
            filename: "x.png",
            mimeType: "image/png\r\nX-Evil: 1",
            bytesBase64: Buffer.from("hi").toString("base64"),
          }),
        ),
      ).rejects.toThrow(/invalid_mime_type|forbidden/)
    })
  })

  describe("files_attachToParent", () => {
    it("rejects a cross-app destination", async () => {
      const bridge = createRpcBridge(TEST_APP, TEST_USER, TEST_ORG, mockTx as any, manifest as any)
      await expect(
        bridge.files_attachToParent(
          JSON.stringify({
            sourceFileId: "11111111-1111-1111-1111-111111111111",
            targetApp: "other-app",
            targetEntityType: "message",
            targetEntityId: "22222222-2222-2222-2222-222222222222",
          }),
        ),
      ).rejects.toThrow(/cross-app/)
    })
  })

  // Negative-path tests (CAPABILITY_NOT_DECLARED, CHANNEL_NOT_OWNED,
  // CHANNEL_MALFORMED including Redis-glob/traversal allowlist) live in
  // ./capability-rejection.test.ts — single home for security gating
  // assertions (Task 11). This file keeps only the happy-path tests that
  // exercise streaming, actor plumbing, and Redis publishing.
  describe("ctx.agent_run happy paths", () => {
    const userActor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["chaos-debug:*"],
      dimensionGrants: { market: ["EU"] },
    }

    it("invokes runAgentChat with the actor's scopes + dimensionGrants and returns the result", async () => {
      const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")
      const calls: any[] = []
      AgentServiceTestAccess.setAgentRun(async (params: any) => {
        calls.push(params)
        return {
          userMessageId: "um-1",
          fullStream: (async function* () {
            yield { type: "text-delta", text: "hello" }
            yield {
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 10, outputTokens: 5 },
            }
          })(),
          finalize: async () => ({
            messageId: "am-1",
            creditCost: "0.001",
            finishReason: "stop",
          }),
        }
      })
      try {
        const bridge = createRpcBridge(
          TEST_APP,
          TEST_USER,
          TEST_ORG,
          mockTx as any,
          { ...manifest, capabilities: ["agent.run"] } as any,
          ["chaos-debug:*"],
          "user",
          undefined,
          { actor: userActor },
        )
        const result = JSON.parse(
          await bridge.agent_run(JSON.stringify({ threadId: "t-1", prompt: "go" })),
        )
        expect(result.result.messageId).toBe("am-1")
        expect(result.userMessageId).toBe("um-1")
        expect(calls[0].actor.scopes).toContain("chaos-debug:*")
        expect(calls[0].actor.dimensionGrants).toEqual({ market: ["EU"] })
      } finally {
        AgentServiceTestAccess.setAgentRun(undefined)
      }
    })

    it("publishes stream parts + agent-run.complete to the namespaced channel", async () => {
      const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")
      const { RedisTestAccess, REDIS_PREFIX } = await import("~/lib/redis")
      const published: Array<[string, string]> = []
      RedisTestAccess.setPublish((c, p) => {
        published.push([c, p])
        return Promise.resolve(1)
      })
      AgentServiceTestAccess.setAgentRun(async () => ({
        userMessageId: "um-1",
        fullStream: (async function* () {
          yield { type: "text-delta", text: "ok" }
          yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 } }
        })(),
        finalize: async () => ({
          messageId: "am-1",
          creditCost: "0",
          finishReason: "stop",
        }),
      }))
      try {
        const bridge = createRpcBridge(
          "chaos-debug",
          TEST_USER,
          TEST_ORG,
          mockTx as any,
          { name: "chaos-debug", schema: {}, capabilities: ["agent.run"] } as any,
          ["chaos-debug:*"],
          "user",
          undefined,
          { actor: userActor },
        )
        await bridge.agent_run(
          JSON.stringify({
            threadId: "t-1",
            prompt: "go",
            channel: "apps/chaos-debug/agent-stream/corr-1",
          }),
        )
        const channels = published.map(([c]) => c)
        const expected = `${REDIS_PREFIX}apps/chaos-debug/orgs/${TEST_ORG}/agent-stream/corr-1`
        expect(channels.every((c) => c === expected)).toBe(true)
        const last = JSON.parse(published[published.length - 1][1])
        expect(last.type).toBe("agent-run.complete")
        expect(last.result.messageId).toBe("am-1")
      } finally {
        AgentServiceTestAccess.setAgentRun(undefined)
        RedisTestAccess.setPublish(undefined)
      }
    })

    it("Invariant K: a mail tool's call is redacted for the row and the channel alike", async () => {
      const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")
      const { RedisTestAccess } = await import("~/lib/redis")
      const published: Array<[string, string]> = []
      RedisTestAccess.setPublish((async (c: string, m: string) => {
        published.push([c, m])
      }) as never)
      let finalizeParams: any = null
      AgentServiceTestAccess.setAgentRun(async () => ({
        userMessageId: "um-1",
        fullStream: (async function* () {
          yield {
            type: "tool-call",
            toolCallId: "tc-mail",
            toolName: "mail__reply",
            input: { textBody: "OBSIDIANBRIDGEDRAFT" },
          }
          // No tool name on the chunk: it comes from the call.
          yield {
            type: "tool-result",
            toolCallId: "tc-mail",
            output: { textBody: "OBSIDIANBRIDGERESULT" },
          }
          yield {
            type: "tool-call",
            toolCallId: "tc-other",
            toolName: "tickets_search",
            input: { q: "open" },
          }
          yield { type: "tool-result", toolCallId: "tc-other", output: "T-1" }
          yield { type: "finish-step", finishReason: "stop", usage: {} }
          yield { type: "finish", finishReason: "stop", usage: {} }
        })(),
        finalize: async (params: any) => {
          finalizeParams = params
          return { messageId: "am-1", creditCost: "0", finishReason: params.finishReason }
        },
      }))
      try {
        const bridge = createRpcBridge(
          "chaos-debug",
          TEST_USER,
          TEST_ORG,
          mockTx as any,
          { name: "chaos-debug", schema: {}, capabilities: ["agent.run"] } as any,
          ["chaos-debug:*"],
          "user",
          undefined,
          { actor: userActor },
        )
        await bridge.agent_run(
          JSON.stringify({
            threadId: "t-1",
            prompt: "go",
            channel: "apps/chaos-debug/agent-stream/corr-k",
          }),
        )
        const [step] = finalizeParams.steps
        expect(step.toolCalls[0].args).toMatchObject({ redacted: true })
        expect(step.toolResults[0].result).toMatchObject({ redacted: true })
        expect(step.toolCalls[1].args).toEqual({ q: "open" })
        expect(step.toolResults[1].result).toBe("T-1")
        const wire = published.map(([, m]) => m).join("\n")
        expect(wire).toContain("tc-mail")
        expect(wire).not.toContain("OBSIDIANBRIDGE")
        expect(JSON.stringify(finalizeParams.steps)).not.toContain("OBSIDIANBRIDGE")
      } finally {
        AgentServiceTestAccess.setAgentRun(undefined)
        RedisTestAccess.setPublish(undefined)
      }
    })

    it("records tool calls/results into finalize steps from a v6 multi-step stream", async () => {
      // Regression (empty-turn bug): the loop previously keyed on `step-start`
      // (a chunk type the AI SDK v6 never emits — it emits `start-step` /
      // `finish-step`) and read tool args/results off `.args`/`.result` instead
      // of v6's `.input`/`.output`. Result: `currentStep` stayed null, EVERY tool
      // call/result was dropped, and `steps` reached `finalize` empty — so a turn
      // that called tools but emitted little closing text persisted as a fully
      // blank agent message. This stream mirrors the real v6 shape and asserts
      // the tool activity now survives. Stays in lockstep with agent-service.ts.
      const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")
      let finalizeParams: any = null
      AgentServiceTestAccess.setAgentRun(async () => ({
        userMessageId: "um-1",
        fullStream: (async function* () {
          yield { type: "start-step" }
          yield { type: "text-delta", text: "Looking up tickets. " }
          yield {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "tickets_search",
            input: { q: "open" },
          }
          yield { type: "tool-result", toolCallId: "tc-1", output: "T-1, T-2" }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 20, outputTokens: 8 },
          }
          yield { type: "start-step" }
          yield { type: "text-delta", text: "Done — assigned both." }
          yield {
            type: "finish-step",
            finishReason: "stop",
            usage: { inputTokens: 5, outputTokens: 4 },
          }
          yield {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 25, outputTokens: 12 },
          }
        })(),
        finalize: async (params: any) => {
          finalizeParams = params
          return { messageId: "am-1", creditCost: "0.002", finishReason: params.finishReason }
        },
      }))
      try {
        const bridge = createRpcBridge(
          "chaos-debug",
          TEST_USER,
          TEST_ORG,
          mockTx as any,
          { name: "chaos-debug", schema: {}, capabilities: ["agent.run"] } as any,
          ["chaos-debug:*"],
          "user",
          undefined,
          { actor: userActor },
        )
        await bridge.agent_run(JSON.stringify({ threadId: "t-1", prompt: "go" }))
        // Text accumulates across both steps.
        expect(finalizeParams.text).toBe("Looking up tickets. Done — assigned both.")
        // Tool call recorded with args sourced from `.input`.
        const toolCalls = finalizeParams.steps.flatMap((s: any) => s.toolCalls)
        expect(toolCalls).toHaveLength(1)
        expect(toolCalls[0]).toMatchObject({
          toolCallId: "tc-1",
          toolName: "tickets_search",
          args: { q: "open" },
        })
        // Tool result recorded with result sourced from `.output`.
        const toolResults = finalizeParams.steps.flatMap((s: any) => s.toolResults)
        expect(toolResults).toEqual([{ toolCallId: "tc-1", result: "T-1, T-2" }])
        // Per-step usage summed across both `finish-step` parts.
        expect(finalizeParams.usage).toEqual({ promptTokens: 25, completionTokens: 12 })
      } finally {
        AgentServiceTestAccess.setAgentRun(undefined)
      }
    })

    // journey-16 (marco_week_fulfillment S4) regression: when the terminal turn ends on a provider
    // stream error, `chat.finalize` can THROW (the credit re-check / message-persist path raising an
    // HTTPException). Before the fix that throw escaped agent_run, an OUTER layer turned it into an
    // errorEnvelope with an EMPTY message + a NON-AGENT_STREAM_ERROR code, the chaos bridge re-threw a
    // bare `Error("")` with no `[chaos-agent-stream-flake]` marker, and `isInfraFlakeError` could not
    // classify it → it CRASHED the whole ~50-min journey at that step. agent_run must now CATCH a
    // finalize throw and return a properly-coded AGENT_STREAM_ERROR envelope carrying the REAL cause
    // (never an empty message), so the transient stream flake is classifiable + routes through the
    // bounded infra retry instead of crashing the journey.
    it("surfaces a finalize THROW as an AGENT_STREAM_ERROR envelope with the real message (never empty, never a crash) [journey-16]", async () => {
      const { AgentServiceTestAccess } = await import("~/modules/agent/runtime/agent-service")
      AgentServiceTestAccess.setAgentRun(async () => ({
        userMessageId: "um-1",
        fullStream: (async function* () {
          yield { type: "text-delta", text: "partial answer before the stream errored" }
          yield { type: "error", error: { message: "Overloaded" } }
        })(),
        finalize: async () => {
          // The terminal finalize raises (mirrors the HTTPException the real persist/credit path can
          // throw when the turn ended on a stream error).
          throw new Error("Failed to persist agent message")
        },
      }))
      try {
        const bridge = createRpcBridge(
          "chaos-debug",
          TEST_USER,
          TEST_ORG,
          mockTx as any,
          { name: "chaos-debug", schema: {}, capabilities: ["agent.run"] } as any,
          ["chaos-debug:*"],
          "user",
          undefined,
          { actor: userActor },
        )
        // Must NOT throw — it returns a structured error envelope.
        const raw = await bridge.agent_run(JSON.stringify({ threadId: "t-1", prompt: "go" }))
        const env = JSON.parse(raw)
        expect(env.error).toBeDefined()
        expect(env.error.code).toBe("AGENT_STREAM_ERROR")
        // The real cause is surfaced (the captured stream-error message wins over the throw text),
        // and it is NEVER an empty string (the swallow the fix closes).
        expect(typeof env.error.message).toBe("string")
        expect(env.error.message.length).toBeGreaterThan(0)
        expect(env.error.message).toContain("Overloaded")
      } finally {
        AgentServiceTestAccess.setAgentRun(undefined)
      }
    })
  })

  describe("ctx.realtime_publish happy paths", () => {
    const userActor = {
      actorType: "user" as const,
      userId: TEST_USER,
      orgId: TEST_ORG,
      scopes: ["chaos-debug:*"],
      dimensionGrants: {},
    }

    it("publishes to REDIS_PREFIX + the org-scoped channel through the test seam", async () => {
      const { RedisTestAccess, REDIS_PREFIX } = await import("~/lib/redis")
      const published: Array<[string, string]> = []
      RedisTestAccess.setPublish((c, p) => {
        published.push([c, p])
        return Promise.resolve(1)
      })
      try {
        const bridge = createRpcBridge(
          "chaos-debug",
          TEST_USER,
          TEST_ORG,
          mockTx as any,
          { name: "chaos-debug", schema: {}, capabilities: ["realtime.publish"] } as any,
          undefined,
          "user",
          undefined,
          { actor: userActor },
        )
        await bridge.realtime_publish(
          "apps/chaos-debug/agent-stream/abc",
          JSON.stringify({ ok: true }),
        )
        // The host stamps the org after the app prefix: another org's publish
        // under the same app channel name lands on a different Redis channel.
        expect(published[0][0]).toBe(
          `${REDIS_PREFIX}apps/chaos-debug/orgs/${TEST_ORG}/agent-stream/abc`,
        )
        expect(JSON.parse(published[0][1])).toEqual({ ok: true })
      } finally {
        RedisTestAccess.setPublish(undefined)
      }
    })
  })

  // Phase 16 Task A0 — bridge auto-keys `externalId` under the calling app's
  // authenticated name, so apps cannot spoof another app's `external_ids` slot.
  // End-to-end keying behaviour is pinned in `modules/contacts/service.test.ts`
  // (per-key write / merge / lookup); here we test only the bridge-side guard
  // that rejects spoofing-via-args, since that's the part with no DB call path.
  describe("resolveContact bridge keying", () => {
    it("rejects object-shaped externalId — the bridge alone decides the namespace", async () => {
      const bridge = createRpcBridge(
        "shopify",
        TEST_USER,
        TEST_ORG,
        mockTx as any,
        { name: "shopify", schema: {}, events: { emits: [] } } as any,
      )
      await expect(
        bridge.resolveContact(
          JSON.stringify({ email: "x@y", externalId: { mail: "<spoofed@x>" } }),
        ),
      ).rejects.toThrow(/expected string/i)
    })

    it("rejects number-shaped externalId for the same reason", async () => {
      const bridge = createRpcBridge(
        "shopify",
        TEST_USER,
        TEST_ORG,
        mockTx as any,
        { name: "shopify", schema: {}, events: { emits: [] } } as any,
      )
      await expect(
        bridge.resolveContact(JSON.stringify({ email: "x@y", externalId: 12345 })),
      ).rejects.toThrow(/expected string/i)
    })
  })
})

describe("files_attachToParent — destination write-scope uses operating scopes, not attribution scopes [BL-186]", () => {
  // Regression for the second layer of BL-186: a cross-app gated send
  // (invoicing `documents_send_to_customer` → `mail:compose`) stages its PDF on
  // mail's OWN `outbound_staging` (writeScope `mail:conversations:write`). The
  // bridge used to pass the CALLER's attribution scopes (invoicing's, which
  // never hold mail write) to the attach's destination write-scope check →
  // `Forbidden: missing write scope on destination`. The destination is always
  // this bridge's own app, so the check must use the app's OPERATING scopes
  // (`${app}:*` cross-app; the user's real scopes on the direct path).
  const A_USER = "00000000-0000-0000-0000-000000b50aa1"
  const STAGE_MANIFEST = { name: TEST_APP, schema: {}, events: { emits: [] } }
  const mockAttachTx = { execute: mock(async () => []), queueEvent: mock(async () => {}) }
  let capturedScopes: string[] | undefined

  // spyOn (NOT mock.module) so mock.restore() in afterEach cleanly reverts these — mock.module
  // is NOT reverted by mock.restore and would LEAK the stubbed attachFileToParent / withPrivilegedDb
  // into every later-loaded test file in the same bun process.
  beforeEach(() => {
    capturedScopes = undefined
    spyOn(filesAttachModule, "attachFileToParent").mockImplementation((async (
      _args: unknown,
      deps: { scopes: string[] },
    ) => {
      capturedScopes = deps.scopes
      return { id: "copied-file", filename: "doc.pdf", mimeType: "application/pdf" }
    }) as unknown as typeof filesAttachModule.attachFileToParent)
    spyOn(dbPrivilegedModule, "withPrivilegedDb").mockImplementation((async (
      _org: string,
      _reason: string,
      fn: (tx: unknown) => unknown,
    ) => fn(mockAttachTx)) as unknown as typeof dbPrivilegedModule.withPrivilegedDb)
  })
  afterEach(() => {
    mock.restore()
  })

  const attachArgs = JSON.stringify({
    sourceFileId: "src-file-1",
    targetApp: TEST_APP,
    targetEntityType: "outbound_staging",
    targetEntityId: "acct-1",
  })

  it("uses the cross-app operating scopes (${app}:*) from the bridge actor, not the caller's", async () => {
    const bridge = createRpcBridge(
      TEST_APP,
      A_USER,
      TEST_ORG,
      mockAttachTx as any,
      STAGE_MANIFEST as any,
      ["invoicing:documents:send"], // caller (attribution) scopes — NO TEST_APP write
      "user",
      undefined,
      {
        actor: {
          actorType: "user",
          userId: A_USER,
          orgId: TEST_ORG,
          scopes: [`${TEST_APP}:*`], // the data-visibility/operating actor set on the cross-app dispatch
          dimensionGrants: {},
        },
      } as any,
    )
    await bridge.files_attachToParent!(attachArgs)
    // Without the fix this would be the caller's ["invoicing:documents:send"] → forbidden.
    expect(capturedScopes).toEqual([`${TEST_APP}:*`])
  })

  it("falls back to the caller's scopes on the direct path (no bridge actor) — a direct agent still needs the write scope", async () => {
    const bridge = createRpcBridge(
      TEST_APP,
      A_USER,
      TEST_ORG,
      mockAttachTx as any,
      STAGE_MANIFEST as any,
      [`${TEST_APP}:conversations:write`], // direct user genuinely holds the destination write scope
      "user",
    )
    await bridge.files_attachToParent!(attachArgs)
    expect(capturedScopes).toEqual([`${TEST_APP}:conversations:write`])
  })
})

describe("files_importAttachment — kernel.files INSERT runs PRIVILEGED, not on the caller's RLS tx [BL-264]", () => {
  // Regression for BL-264: kernel.files is FORCE RLS with NO liaison_rls INSERT
  // policy ("INSERT/DELETE are kernel-only; liaison_admin BYPASSRLS handles
  // them"). When an AGENT calls a tool that materializes a file (e.g.
  // mail:export_conversations, scope mail:conversations:read), the bridge's txDb
  // is the RLS-restricted connection, so the INSERT was SILENTLY DENIED → the
  // tool returned HTTP 500 and the agent fell back to fabricating a "downloadable"
  // artifact. The fix routes the INSERT through withPrivilegedDb (authorization is
  // the parent-visibility RLS check, which still runs on txDb). This test proves
  // the INSERT goes through the privileged path, NOT the caller's tx.
  const I_USER = "00000000-0000-0000-0000-000000b50cc1"
  const ACCT_ID = "00000000-0000-0000-0000-0000000000a1"
  const IMPORT_MANIFEST = {
    name: TEST_APP,
    schema: {},
    events: { emits: [] },
  }
  let privilegedReasons: string[]
  let privilegedInserts: unknown[]
  let privilegedEvents: Array<Record<string, unknown>>

  beforeEach(() => {
    privilegedReasons = []
    privilegedInserts = []
    privilegedEvents = []
    spyOn(objectStorageModule, "putObject").mockImplementation(
      (async () => {}) as unknown as typeof objectStorageModule.putObject,
    )
    spyOn(filesServiceModule, "resolveParent").mockImplementation((() => ({
      tableName: "accounts",
      schemaRef: "app_test",
      joinOn: "id",
      readScope: `${TEST_APP}:read`,
      writeScope: `${TEST_APP}:write`,
    })) as unknown as typeof filesServiceModule.resolveParent)
    spyOn(dbPrivilegedModule, "withPrivilegedDb").mockImplementation((async (
      _org: string,
      reason: string,
      fn: (tx: unknown) => unknown,
    ) => {
      privilegedReasons.push(reason)
      return fn({
        // Only INSERT statements count: the storage-quota reads (no rows: no
        // quota) run privileged too.
        execute: async (q: unknown) => {
          const text = (
            (q as { queryChunks?: Array<{ value?: string[] } | null> }).queryChunks ?? []
          )
            .map((c) => (Array.isArray(c?.value) ? c.value.join("") : ""))
            .join("")
          if (/INSERT INTO/.test(text)) privilegedInserts.push(q)
          return []
        },
        queueEvent: async (e: Record<string, unknown>) => {
          privilegedEvents.push(e)
        },
      })
    }) as unknown as typeof dbPrivilegedModule.withPrivilegedDb)
  })
  afterEach(() => {
    mock.restore()
  })

  it("performs the kernel.files INSERT through withPrivilegedDb (the RLS tx only does the parent-visibility SELECT)", async () => {
    // The caller's RLS tx returns ONE row for the parent-visibility SELECT, then
    // must NOT be used for the INSERT (that happens privileged).
    const importTx = {
      execute: mock(async () => [{ id: ACCT_ID }]),
      queueEvent: mock(async () => {}),
    }
    const bridge = createRpcBridge(
      TEST_APP,
      I_USER,
      TEST_ORG,
      importTx as any,
      IMPORT_MANIFEST as any,
    )
    const res = JSON.parse(
      await bridge.files_importAttachment!(
        JSON.stringify({
          targetApp: TEST_APP,
          targetEntityType: "outbound_staging",
          targetEntityId: ACCT_ID,
          filename: "export.csv",
          mimeType: "text/csv",
          bytesBase64: Buffer.from("a,b\r\n1,2\r\n").toString("base64"),
          disposition: "attachment",
        }),
      ),
    )
    // A real file id comes back (the INSERT succeeded under the privileged path).
    expect(res.id).toBeTruthy()
    expect(res.filename).toBe("export.csv")
    // The INSERT ran PRIVILEGED exactly once.
    expect(privilegedReasons).toContain("files_importAttachment kernel.files insert")
    expect(privilegedInserts.length).toBe(1)
    // The caller's RLS tx did the visibility SELECT but NOT the INSERT — exactly
    // one execute on txDb (the parent-visibility check), never the insert.
    expect(importTx.execute).toHaveBeenCalledTimes(1)
    // The standard kernel `file:create` event was queued in the SAME privileged
    // tx as the insert (thumbnail pipeline + other kernel consumers fire).
    expect(privilegedEvents.length).toBe(1)
    expect(privilegedEvents[0]).toMatchObject({
      app: "kernel",
      entity: "file",
      action: "create",
      entityId: res.id,
    })
    const evData = privilegedEvents[0].data as Record<string, unknown>
    expect(evData.id).toBe(res.id)
    expect(evData.mimeType).toBe("text/csv")
    expect(evData.storageKey).toBeTruthy()
  })
})

describe("pdf_render — optional link commits the file id onto a declared app column in a privileged tx [BL-191]", () => {
  // Regression for BL-191: an on-demand render inside a handler must commit the link column (e.g.
  // documents.pdf_file_id) BEFORE the handler tx commits, so a subsequent cross-app reader (a gated
  // send's mail:composeForApp, whose pdf fileParent RLS joins on that column) can see the new file.
  // The link runs in renderPdf's already-committed (privileged) write path, constrained to a column the
  // app DECLARES in its own manifest schema.
  const R_USER = "00000000-0000-0000-0000-000000b50bb1"
  const ROW_ID = "00000000-0000-0000-0000-0000000000c1"
  const PDF_MANIFEST = {
    name: TEST_APP,
    schema: { documents: { fields: { pdf_file_id: "uuid", status: "string" } } },
    events: { emits: [] },
    capabilities: ["pdf.render"],
  }
  let privilegedReasons: string[]
  let executedSql: unknown[]

  beforeEach(() => {
    privilegedReasons = []
    executedSql = []
    spyOn(pdfRenderModule, "renderPdf").mockImplementation((async () => ({
      file_id: "00000000-0000-0000-0000-0000000000f1",
      byte_size: 10,
      page_count: 1,
    })) as unknown as typeof pdfRenderModule.renderPdf)
    spyOn(dbPrivilegedModule, "withPrivilegedDb").mockImplementation((async (
      _org: string,
      reason: string,
      fn: (tx: unknown) => unknown,
    ) => {
      privilegedReasons.push(reason)
      return fn({ execute: async (q: unknown) => executedSql.push(q) })
    }) as unknown as typeof dbPrivilegedModule.withPrivilegedDb)
  })
  afterEach(() => {
    mock.restore()
  })

  const pdfTx = { execute: mock(async () => []), queueEvent: mock(async () => {}) }
  function makePdfBridge() {
    return createRpcBridge(TEST_APP, R_USER, TEST_ORG, pdfTx as any, PDF_MANIFEST as any)
  }

  it("commits the link via a privileged UPDATE when the column is declared in the app schema", async () => {
    const bridge = makePdfBridge()
    await bridge.pdf_render!(
      JSON.stringify({
        template_kind: "x",
        data: {},
        link: { table: "documents", column: "pdf_file_id", row_id: ROW_ID },
      }),
    )
    // The link committed in a SEPARATE privileged tx (visible cross-tx before the handler commits).
    expect(privilegedReasons).toContain("pdf:link")
    expect(executedSql.length).toBe(1)
  })

  it("does NOT commit a link to a column the app does not declare (no arbitrary/cross-app writes)", async () => {
    const bridge = makePdfBridge()
    await bridge.pdf_render!(
      JSON.stringify({
        template_kind: "x",
        data: {},
        link: { table: "documents", column: "not_a_declared_column", row_id: ROW_ID },
      }),
    )
    expect(privilegedReasons).not.toContain("pdf:link")
    expect(executedSql.length).toBe(0)
  })

  it("renders without a link when none is requested (no privileged link write)", async () => {
    const bridge = makePdfBridge()
    await bridge.pdf_render!(JSON.stringify({ template_kind: "x", data: {} }))
    expect(privilegedReasons).not.toContain("pdf:link")
    expect(executedSql.length).toBe(0)
  })
})

// ⛔ BL-275 — competitor-firmware-news-watch duplicate-doc flake ROOT CAUSE (forensic-confirmed). An
// UNTRUSTED sandbox app (knowledge) runs its bundle in a WORKER POOL; when the QuickJS code calls back into
// the host `ctx.knowledge_create` bridge method, that callback executes OUTSIDE the routine tick's
// `runContextStore.run(runFrame, …)` ALS frame — so `currentRunContext()` returns undefined INSIDE the
// redirect, the routine-bound-doc lookup saw `routineId: null`, BYPASSED, and a flash-lite tick that
// invents a separate "…Release Log"/"…Template" title landed a DUPLICATE running watch doc (the running
// doc gained nothing). The fix CAPTURES the routineId at bridge-CONSTRUCTION time (which runs in-frame) and
// threads it into the redirect, so the lookup is independent of the lost ALS frame. This test pins it: the
// redirect fires for a routine-tick knowledge_create EVEN WHEN the ALS frame is cleared at call time
// (simulating the worker-pool callback). FAILS-WITHOUT (ALS-only read → bypass → duplicate create);
// PASSES-WITH (captured id → redirect to update).
describe("createRpcBridge — routine-bound-doc redirect survives ALS-frame loss across the sandbox worker boundary (BL-275)", () => {
  const BOUND_DOC_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  const ROUTINE_ID = "12121212-3434-5656-7878-909090909090"
  const ORG = "00000000-0000-0000-0000-0000000fbeef"
  const USER = "00000000-0000-0000-0000-0000000fcafe"

  afterEach(() => {
    mock.restore()
  })

  it("redirects the tick's knowledge_create onto the bound running doc when currentRunContext() is undefined at call time", async () => {
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    const svc = await import("~/apps/knowledge/service")

    // The mocked txDb returns the routine prompt carrying the binding directive when the redirect queries it.
    const boundPrompt =
      "Weekly competitor firmware watch.\n\n" +
      `MAINTAIN THIS EXISTING RUNNING DOC (do NOT create a new one): a running findings Knowledge doc ` +
      `titled EXACTLY "Competitor Firmware & Feature Watch" (id ${BOUND_DOC_ID}) already exists for this ` +
      "watch. EACH TICK, write this week's findings by calling knowledge_update."
    const execute = mock(async () => [{ prompt: boundPrompt }] as Record<string, unknown>[])
    const txDb = {
      execute,
      select: mock(() => txDb),
      from: mock(() => txDb),
      where: mock(() => txDb),
      queueEvent: mock(async () => {}),
      transaction: mock((fn: any) => fn(txDb)),
    }

    // Stub the knowledge service so the redirect resolves a writable bound doc and the UPDATE branch runs.
    spyOn(svc, "knowledgeActorFromContext").mockReturnValue({
      orgId: ORG,
      userId: USER,
      scopes: ["knowledge:documents:create", "knowledge:documents:update"],
      dimensionGrants: {},
    } as never)
    spyOn(svc, "loadKnowledgeDocument").mockResolvedValue({
      id: BOUND_DOC_ID,
      title: "Competitor Firmware & Feature Watch",
      revision: 3,
      documentScope: "organization",
      ownerUserId: USER,
      orgId: ORG,
    } as never)
    spyOn(svc, "assertCanWriteDocumentRow").mockReturnValue(undefined)
    const updateSpy = spyOn(svc, "updateKnowledgeDocument").mockResolvedValue({
      id: BOUND_DOC_ID,
      title: "Competitor Firmware & Feature Watch",
      revision: 4,
    } as never)
    const createSpy = spyOn(svc, "createKnowledgeDocument").mockResolvedValue({
      id: "ffffffff-0000-0000-0000-000000000000",
      title: "DUPLICATE — should never be created",
    } as never)

    // Build the bridge INSIDE the routine-tick ALS frame (as the routine worker does), capturing routineId.
    const bridge = runContextStore.run(
      {
        runId: "r",
        parentRunId: null,
        rootRunId: "r",
        nestingDepth: 0,
        background: true,
        routineId: ROUTINE_ID,
      },
      () =>
        createRpcBridge(
          "knowledge",
          USER,
          ORG,
          txDb as never,
          { name: "knowledge", schema: {}, events: {}, connections: {}, network: {} } as never,
          ["knowledge:documents:create", "knowledge:documents:update"],
        ),
    )

    // Now invoke knowledge_create OUTSIDE any ALS frame (simulating the worker-pool callback that lost it).
    // The agent invents a DUPLICATE title — without the captured-id fix this would bypass + create a dup.
    expect(runContextStore.getStore()).toBeUndefined()
    const raw = await bridge.knowledge_create(
      JSON.stringify({
        title: "Competitor Firmware & Feature Watch — New Release Log",
        documentScope: "organization",
        body: "## 2026-06-27\n- Larkspur 1.3 per-channel limiter curves",
      }),
    )
    const res = JSON.parse(raw)

    // Redirected to an UPDATE of the bound running doc — NOT a duplicate create.
    expect(res.redirectedToUpdate).toBe(true)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0][1]).toMatchObject({ id: BOUND_DOC_ID })
    expect(createSpy).not.toHaveBeenCalled()
  })
})

// ⛔ claire-routine-monthend-close-pack — PERIOD-SNAPSHOT DISCLAIMER INJECTION (l710 server-side
// discrimination). Inside a period-snapshot routine tick (lists a prior period's invoices grouped by VAT
// treatment AND saves a Knowledge snapshot doc), the persisted snapshot doc is the audit-trail deliverable
// and MUST carry the bounded/non-authoritative-listing caveat — but the flash-lite tick that renders the
// body is pinned and VARIES on whether it writes the caveat (a 3× gate's run-2 failed: the saved body
// presented uncaveated "Group Total" sums as a definitive aggregate). The rpc-bridge knowledge_create
// PREPENDS the verbatim disclaimer to the body server-side when a period-snapshot tick omitted it, so the
// persisted deliverable is ALWAYS honestly framed. FAILS-WITHOUT (uncaveated body persisted → partial-
// honesty FAIL); PASSES-WITH (disclaimer prepended). A tick that already caveated, or a non-period-snapshot
// create, is left untouched.
// PLACEMENT + ACCESS GUARD — an agent-created ORG knowledge doc must be filed into a collection and
// explicitly access-classified; confidential/restricted docs additionally need explicit role shares.
// (A real staging finance analysis landed free-floating and org-wide EDITABLE before this guard.)
describe("createRpcBridge — knowledge_create placement + access guard", () => {
  const ORG = "00000000-0000-0000-0000-0000000fbee3"
  const USER = "00000000-0000-0000-0000-0000000fcaf3"
  const COLLECTION = "cccccccc-aaaa-2222-3333-444444444444"
  const ROLE = "eeeeeeee-1111-2222-3333-444444444444"

  afterEach(() => {
    mock.restore()
  })

  interface GuardRunResult {
    out: Record<string, unknown>
    createCalls: unknown[][]
    membershipCalls: unknown[][]
    sharingCalls: unknown[][]
  }

  async function runGuarded(params: Record<string, unknown>): Promise<GuardRunResult> {
    const svc = await import("~/apps/knowledge/service")
    const collections = await import("~/apps/knowledge/collections")
    const execute = mock(async () => [] as Record<string, unknown>[])
    const txDb = {
      execute,
      select: mock(() => txDb),
      from: mock(() => txDb),
      where: mock(() => txDb),
      queueEvent: mock(async () => {}),
      transaction: mock((fn: (db: unknown) => unknown) => fn(txDb)),
    }
    spyOn(svc, "knowledgeActorFromContext").mockReturnValue({
      orgId: ORG,
      userId: USER,
      scopes: ["knowledge:documents:create", "knowledge:collections:manage"],
      dimensionGrants: { sensitivity: ["*"], team: ["*"] },
    } as never)
    spyOn(svc, "findOrgDocByTitle").mockResolvedValue(null as never)
    spyOn(svc, "findOrgRunningDocByTitlePrefix").mockResolvedValue(null as never)
    spyOn(svc, "findUniqueOrgRunningWatchDoc").mockResolvedValue(null as never)
    spyOn(collections, "listKnowledgeCollections").mockResolvedValue([
      { id: COLLECTION, name: "Finance", archivedAt: null },
    ] as never)
    spyOn(collections, "loadCollection").mockImplementation((async (_tx: unknown, id: string) =>
      id === COLLECTION
        ? ({ id: COLLECTION, name: "Finance", archivedAt: null } as never)
        : null) as never)
    const membershipSpy = spyOn(collections, "addCollectionMembership").mockResolvedValue({
      id: "m1",
    } as never)
    const sharingSpy = spyOn(svc, "setDocumentSharing").mockResolvedValue({
      orgAccess: "none",
      editScope: null,
      shares: [],
      roleShares: [],
    } as never)
    const createSpy = spyOn(svc, "createKnowledgeDocument").mockResolvedValue({
      id: "dddddddd-1111-2222-3333-444444444444",
      title: "2026 Margin Analysis",
      orgAccess: "none",
      editScope: null,
    } as never)
    const bridge = createRpcBridge(
      "knowledge",
      USER,
      ORG,
      txDb as never,
      { name: "knowledge", schema: {}, events: {}, connections: {}, network: {} } as never,
      ["knowledge:documents:create", "knowledge:collections:manage"],
    )
    const out = JSON.parse(await bridge.knowledge_create(JSON.stringify(params))) as Record<
      string,
      unknown
    >
    return {
      out,
      createCalls: createSpy.mock.calls as unknown[][],
      membershipCalls: membershipSpy.mock.calls as unknown[][],
      sharingCalls: sharingSpy.mock.calls as unknown[][],
    }
  }

  it("rejects an org create without collectionId, listing the existing collections", async () => {
    const { out, createCalls } = await runGuarded({
      documentScope: "organization",
      title: "2026 Margin Analysis",
      sensitivity: "confidential",
    })
    const err = out.error as { code?: string; message?: string }
    expect(err?.code).toBe("collection_required")
    expect(err?.message).toContain('"Finance"')
    expect(err?.message).toContain(COLLECTION)
    expect(createCalls).toHaveLength(0)
  })

  it("rejects an org create without an explicit sensitivity", async () => {
    const { out, createCalls } = await runGuarded({
      documentScope: "organization",
      title: "2026 Margin Analysis",
      collectionId: COLLECTION,
    })
    expect((out.error as { code?: string })?.code).toBe("sensitivity_required")
    expect(createCalls).toHaveLength(0)
  })

  it("rejects a confidential create without role shares, pointing at roles_list", async () => {
    const { out, createCalls } = await runGuarded({
      documentScope: "organization",
      title: "2026 Margin Analysis",
      collectionId: COLLECTION,
      sensitivity: "confidential",
    })
    const err = out.error as { code?: string; message?: string }
    expect(err?.code).toBe("access_rules_required")
    expect(err?.message?.toLowerCase()).toContain("roles_list")
    expect(createCalls).toHaveLength(0)
  })

  it("files the doc into the collection + applies role shares on a compliant confidential create", async () => {
    const { out, createCalls, membershipCalls, sharingCalls } = await runGuarded({
      documentScope: "organization",
      title: "2026 Margin Analysis",
      body: "numbers",
      collectionId: COLLECTION,
      sensitivity: "confidential",
      shareWithRoles: [{ roleId: ROLE, access: "viewer" }],
    })
    expect(out.error).toBeUndefined()
    expect(out.collection).toEqual({ id: COLLECTION, name: "Finance" })
    expect(out.roleShares).toEqual([{ roleId: ROLE, role: "viewer" }])
    // The bridge-level placement params are STRIPPED before the service create.
    const createInput = createCalls[0]?.[1] as Record<string, unknown>
    expect(createInput.collectionId).toBeUndefined()
    expect(createInput.shareWithRoles).toBeUndefined()
    expect(createInput.sensitivity).toBe("confidential")
    // Filed + shared in the same transaction as the create.
    const membershipInput = membershipCalls[0]?.[1] as Record<string, unknown>
    expect(membershipInput.collectionId).toBe(COLLECTION)
    expect(membershipInput.targetId).toBe("dddddddd-1111-2222-3333-444444444444")
    const sharingInput = sharingCalls[0]?.[2] as { roleShares?: unknown }
    expect(sharingInput.roleShares).toEqual([{ roleId: ROLE, role: "viewer" }])
  })

  it("rejects a confidential create when the caller lacks the collections scope", async () => {
    const svc = await import("~/apps/knowledge/service")
    spyOn(svc, "knowledgeActorFromContext").mockReturnValue({
      orgId: ORG,
      userId: USER,
      scopes: ["knowledge:documents:create"],
      dimensionGrants: {},
    } as never)
    const createSpy = spyOn(svc, "createKnowledgeDocument").mockResolvedValue({} as never)
    spyOn(svc, "findOrgDocByTitle").mockResolvedValue(null as never)
    spyOn(svc, "findOrgRunningDocByTitlePrefix").mockResolvedValue(null as never)
    spyOn(svc, "findUniqueOrgRunningWatchDoc").mockResolvedValue(null as never)
    const execute = mock(async () => [] as Record<string, unknown>[])
    const txDb = {
      execute,
      queueEvent: mock(async () => {}),
      transaction: mock((fn: (db: unknown) => unknown) => fn(txDb)),
    }
    const bridge = createRpcBridge(
      "knowledge",
      USER,
      ORG,
      txDb as never,
      { name: "knowledge", schema: {}, events: {}, connections: {}, network: {} } as never,
      ["knowledge:documents:create"],
    )
    const out = JSON.parse(
      await bridge.knowledge_create(JSON.stringify({ documentScope: "organization", title: "T" })),
    ) as { error?: { code?: string } }
    expect(out.error?.code).toBe("collections_scope_required")
    expect(createSpy.mock.calls).toHaveLength(0)
  })

  it("requires a collection for PERSONAL creates too (a path, never free-floating)", async () => {
    const { out, createCalls } = await runGuarded({
      documentScope: "personal",
      title: "My scratch notes",
    })
    expect((out.error as { code?: string })?.code).toBe("collection_required")
    expect(createCalls).toHaveLength(0)
  })

  it("PERSONAL creates with a collection pass without sensitivity or role shares", async () => {
    const { out, createCalls, membershipCalls } = await runGuarded({
      documentScope: "personal",
      title: "My scratch notes",
      collectionId: COLLECTION,
    })
    expect(out.error).toBeUndefined()
    expect(createCalls).toHaveLength(1)
    expect((membershipCalls[0]?.[1] as Record<string, unknown> | undefined)?.collectionId).toBe(
      COLLECTION,
    )
  })
})

// STAGE-TIME validator for the same guard. knowledge:create parks a human approval BEFORE the bridge
// runs, so running these checks only at execution time meant an incomplete create failed IN THE
// APPROVER'S HANDS. knowledge_create_validate lets the knowledge handler refuse it at staging.
// FAILS-WITHOUT (no validator: the approver meets the error); PASSES-WITH (the agent meets it in-loop).
describe("createRpcBridge - knowledge_create_validate (stage-time guard, no write)", () => {
  const ORG = "00000000-0000-0000-0000-0000000fbee4"
  const USER = "00000000-0000-0000-0000-0000000fcaf4"
  const COLLECTION = "cccccccc-aaaa-2222-3333-555555555555"
  const ROLE = "eeeeeeee-1111-2222-3333-555555555555"

  afterEach(() => {
    mock.restore()
  })

  async function runValidate(params: Record<string, unknown>): Promise<{
    out: { error?: { code?: string; message?: string } }
    createCalls: unknown[][]
  }> {
    const svc = await import("~/apps/knowledge/service")
    const collections = await import("~/apps/knowledge/collections")
    const execute = mock(async () => [] as Record<string, unknown>[])
    const txDb = {
      execute,
      select: mock(() => txDb),
      from: mock(() => txDb),
      where: mock(() => txDb),
      queueEvent: mock(async () => {}),
      transaction: mock((fn: (db: unknown) => unknown) => fn(txDb)),
    }
    spyOn(svc, "knowledgeActorFromContext").mockReturnValue({
      orgId: ORG,
      userId: USER,
      scopes: ["knowledge:documents:create", "knowledge:collections:manage"],
      dimensionGrants: { sensitivity: ["*"], team: ["*"] },
    } as never)
    spyOn(collections, "listKnowledgeCollections").mockResolvedValue([
      { id: COLLECTION, name: "Finance", archivedAt: null },
    ] as never)
    spyOn(collections, "loadCollection").mockImplementation((async (_tx: unknown, id: string) =>
      id === COLLECTION
        ? ({ id: COLLECTION, name: "Finance", archivedAt: null } as never)
        : null) as never)
    const createSpy = spyOn(svc, "createKnowledgeDocument").mockResolvedValue({ id: "x" } as never)
    const bridge = createRpcBridge(
      "knowledge",
      USER,
      ORG,
      txDb as never,
      { name: "knowledge", schema: {}, events: {}, connections: {}, network: {} } as never,
      ["knowledge:documents:create", "knowledge:collections:manage"],
    )
    const out = JSON.parse(await bridge.knowledge_create_validate(JSON.stringify(params))) as {
      error?: { code?: string; message?: string }
    }
    return { out, createCalls: createSpy.mock.calls as unknown[][] }
  }

  it("reports sensitivity_required for an unclassified org create, and writes nothing", async () => {
    const { out, createCalls } = await runValidate({
      documentScope: "organization",
      title: "2026 Margin Analysis",
      collectionId: COLLECTION,
    })
    expect(out.error?.code).toBe("sensitivity_required")
    expect(createCalls).toHaveLength(0)
  })

  it("reports collection_required when the doc is not filed", async () => {
    const { out } = await runValidate({
      documentScope: "organization",
      title: "2026 Margin Analysis",
      sensitivity: "confidential",
    })
    expect(out.error?.code).toBe("collection_required")
  })

  it("reports access_rules_required for a confidential doc with no role shares", async () => {
    const { out } = await runValidate({
      documentScope: "organization",
      title: "2026 Margin Analysis",
      collectionId: COLLECTION,
      sensitivity: "confidential",
    })
    expect(out.error?.code).toBe("access_rules_required")
  })

  it("returns no error for a compliant create and leaves the staged params untouched", async () => {
    const params = {
      documentScope: "organization",
      title: "2026 Margin Analysis",
      body: "numbers",
      collectionId: COLLECTION,
      sensitivity: "confidential",
      shareWithRoles: [{ roleId: ROLE, access: "viewer" }],
    }
    const { out } = await runValidate(params)
    expect(out.error).toBeUndefined()
    // Validation must NOT strip the bridge-level keys off the params the caller
    // is about to stage: the approved re-entry replays them verbatim.
    expect(params.collectionId).toBe(COLLECTION)
    expect(params.shareWithRoles).toHaveLength(1)
  })
})

describe("createRpcBridge — period-snapshot tick knowledge_create gets the bounded-listing disclaimer prepended server-side", () => {
  const ROUTINE_ID = "13131313-2424-3535-4646-575757575757"
  const ORG = "00000000-0000-0000-0000-0000000fbee2"
  const USER = "00000000-0000-0000-0000-0000000fcaf2"
  // A PERIOD-SNAPSHOT routine prompt (lists prior-month invoices grouped by VAT treatment + saves a
  // knowledge snapshot) — NOT a bound-doc directive, so the running-doc redirect does NOT fire; the create
  // path runs and the disclaimer injector applies. No banned literals.
  const SNAPSHOT_PROMPT =
    "On the 1st of each month, search issued invoices for the prior month via date_range, group by " +
    "tax_treatment, post the digest, and create ONE Knowledge snapshot doc as the audit trail."

  afterEach(() => {
    mock.restore()
  })

  async function runCreate(body: string, prompt: string): Promise<Record<string, unknown>> {
    const { runContextStore } = await import("~/modules/agent/runtime/run-context")
    const svc = await import("~/apps/knowledge/service")
    const collections = await import("~/apps/knowledge/collections")
    const execute = mock(async () => [{ prompt }] as Record<string, unknown>[])
    const txDb = {
      execute,
      select: mock(() => txDb),
      from: mock(() => txDb),
      where: mock(() => txDb),
      queueEvent: mock(async () => {}),
      transaction: mock((fn: (db: unknown) => unknown) => fn(txDb)),
    }
    // The disclaimer injector reads the routine prompt via withPrivilegedDb (kernel.routines is unreachable
    // from the sandboxed knowledge app's RLS tx — the forensic-confirmed root cause). Mock it to a tx whose
    // execute returns the authored prompt so the period-snapshot detection sees it.
    spyOn(dbPrivilegedModule, "withPrivilegedDb").mockImplementation((async (
      _orgId: string,
      _reason: string,
      fn: (db: unknown) => unknown,
    ) => fn({ execute })) as unknown as typeof dbPrivilegedModule.withPrivilegedDb)
    spyOn(svc, "knowledgeActorFromContext").mockReturnValue({
      orgId: ORG,
      userId: USER,
      // collections:manage — the placement guard requires filing the org doc
      // into a collection, which needs this scope.
      scopes: ["knowledge:documents:create", "knowledge:collections:manage"],
      dimensionGrants: {},
    } as never)
    // No bound running doc + no title collision → the create branch runs.
    spyOn(svc, "loadKnowledgeDocument").mockResolvedValue(null as never)
    spyOn(svc, "findOrgDocByTitle").mockResolvedValue(null as never)
    spyOn(svc, "findOrgRunningDocByTitlePrefix").mockResolvedValue(null as never)
    spyOn(svc, "findUniqueOrgRunningWatchDoc").mockResolvedValue(null as never)
    // Placement guard collaborators — the tick files the snapshot into an
    // existing "Finance" collection.
    spyOn(collections, "loadCollection").mockResolvedValue({
      id: "cccccccc-1111-2222-3333-444444444444",
      name: "Finance",
      archivedAt: null,
    } as never)
    spyOn(collections, "addCollectionMembership").mockResolvedValue({ id: "m1" } as never)
    const createSpy = spyOn(svc, "createKnowledgeDocument").mockResolvedValue({
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      title: "Invoice Audit",
    } as never)
    const bridge = runContextStore.run(
      {
        runId: "r",
        parentRunId: null,
        rootRunId: "r",
        nestingDepth: 0,
        background: true,
        routineId: ROUTINE_ID,
      },
      () =>
        createRpcBridge(
          "knowledge",
          USER,
          ORG,
          txDb as never,
          { name: "knowledge", schema: {}, events: {}, connections: {}, network: {} } as never,
          ["knowledge:documents:create", "knowledge:collections:manage"],
        ),
    )
    await bridge.knowledge_create(
      JSON.stringify({
        title: "Invoice Audit - May 2026",
        documentScope: "organization",
        body,
        collectionId: "cccccccc-1111-2222-3333-444444444444",
        sensitivity: "internal",
      }),
    )
    return { persistedBody: createSpy.mock.calls[0]?.[1]?.body }
  }

  it("PREPENDS the verbatim bounded-listing disclaimer when a period-snapshot tick's body lacks a caveat", async () => {
    const uncaveated =
      "# Invoice Audit - May 2026\n## Summary by Tax Treatment\n| Treatment | Group Total |\n| FR | €3,019.68 |"
    const { persistedBody } = await runCreate(uncaveated, SNAPSHOT_PROMPT)
    const { PERIOD_SNAPSHOT_DISCLAIMER } = await import(
      "~/modules/agent/tools/skills-routines-tools"
    )
    // The saved body now OPENS with the disclaimer and still contains the original listing.
    expect(typeof persistedBody).toBe("string")
    expect((persistedBody as string).startsWith(PERIOD_SNAPSHOT_DISCLAIMER)).toBe(true)
    expect(persistedBody as string).toContain("Summary by Tax Treatment")
  })

  it("does NOT double-prepend when the tick already wrote a non-authoritative caveat", async () => {
    const caveated =
      "This report is a bounded listing, NOT an authoritative VAT aggregate.\n\n## Summary by Tax Treatment"
    const { persistedBody } = await runCreate(caveated, SNAPSHOT_PROMPT)
    // Unchanged — the tick's own caveat is honored (no double-prepend).
    expect(persistedBody).toBe(caveated)
  })

  it("leaves a NON-period-snapshot tick's create untouched (no spurious disclaimer)", async () => {
    const body = "# Weekly Ops Digest\nOpen tickets: 12 · SLA breaches: 1"
    const { persistedBody } = await runCreate(
      body,
      "Every Monday, post a weekly ops digest of open tickets and SLA breaches.",
    )
    expect(persistedBody).toBe(body)
  })
})
