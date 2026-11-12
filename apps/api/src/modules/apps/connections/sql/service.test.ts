// SPDX-License-Identifier: FSL-1.1-ALv2
// `ctx.sql.*` on the host, against fake transports (no database): the manifest
// gate, the scope gates, the liaison-self org pin, the row cap from the limit
// table, the statement timeout and the cancel at the deadline, the audit line on
// every outcome, and no credential in any answer.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { env } from "~/lib/env"
import { sqlCallLimits } from "~/modules/apps/run-limits"
import type { DatabaseCredentials } from "./credentials"
import { SqlPoolTestAccess } from "./pool"
import { type SqlCallContext, sqlQuery, sqlReads, sqlSchema } from "./service"
import type { DbTransport, ExecOptions } from "./transport"

const ORG = "00000000-0000-4000-8000-00000000a501"
const OTHER_ORG = "00000000-0000-4000-8000-00000000a502"
const DSN = "postgres://reader:hunter2-secret@db.internal.example:5432/app"

interface Call {
  kind: "read" | "query" | "describe"
  name?: string
  sql?: string
  params?: unknown
  opts?: ExecOptions
  maxRows?: number
}

class RecordingTransport implements DbTransport {
  calls: Call[] = []
  rows: Record<string, unknown>[] = [{ id: 1 }]
  hang = false
  failWith: unknown = null
  async probe() {
    return { ok: true, mode: "direct" as const, warnings: [] }
  }
  private async answer(opts?: ExecOptions) {
    if (this.failWith) throw this.failWith
    if (this.hang) {
      await new Promise<void>((resolve) => opts?.signal?.addEventListener("abort", () => resolve()))
      throw new Error("canceling statement due to user request")
    }
    return { rows: this.rows, truncated: false, durationMs: 1 }
  }
  async runRead(
    read: { maxRows?: number },
    name: string,
    params: Record<string, unknown>,
    opts?: ExecOptions,
  ) {
    this.calls.push({ kind: "read", name, params, opts, maxRows: read.maxRows })
    return this.answer(opts)
  }
  async runQuery(sql: string, opts?: ExecOptions, params?: unknown[]) {
    this.calls.push({ kind: "query", sql, params, opts })
    return this.answer(opts)
  }
  async describe() {
    this.calls.push({ kind: "describe" })
    return {
      tables: [
        {
          table: "kernel.users",
          columns: [
            { column: "id", dataType: "uuid" },
            { column: "password_hash", dataType: "text" },
          ],
        },
      ],
    }
  }
  async close() {}
}

let transport: RecordingTransport
let audits: Array<{ action: string; outcome: string; metadata: Record<string, unknown> }>
let resolvedFor: Array<{ connection: string; identifier?: string }>

const MANIFEST: Record<string, { type?: string; sql?: Record<string, unknown> }> = {
  warehouse: { type: "credentials", sql: { rawQuery: { scope: "dbapp:query:read" } } },
  reports: { type: "credentials", sql: { catalog: "instance" } },
  reportsAndRaw: {
    type: "credentials",
    sql: { catalog: "instance", rawQuery: { scope: "dbapp:query:read" } },
  },
  gateOnly: {
    type: "credentials",
    sql: { modes: ["gate"], rawQuery: { scope: "dbapp:query:read" } },
  },
  describable: {
    type: "credentials",
    sql: {
      catalog: "instance",
      rawQuery: { scope: "dbapp:query:read" },
      schema: { scope: "dbapp:reads:read" },
    },
  },
  api: { type: "credentials" },
}

function ctx(over: Partial<SqlCallContext> = {}): SqlCallContext {
  return {
    orgId: ORG,
    appName: "dbapp",
    callerScopes: ["dbapp:query:read"],
    declarationOf: (c) => MANIFEST[c] as never,
    resolveCredentials: async (connection, identifier) => {
      resolvedFor.push({ connection, ...(identifier ? { identifier } : {}) })
      return { connectionString: DSN }
    },
    writeAudit: async (entry) => {
      audits.push(entry)
    },
    transportFactory: (_creds: DatabaseCredentials) => transport,
    ...over,
  }
}

const savedAdapter = process.env.LIAISON_DATABASE_ADAPTER
const savedOperator = env.LIAISON_OPERATOR_ORG_ID

beforeEach(() => {
  transport = new RecordingTransport()
  audits = []
  resolvedFor = []
  SqlPoolTestAccess.reset()
  delete process.env.LIAISON_DATABASE_ADAPTER
  // The instance operator is another org: raw SQL over liaison-self is refused here.
  ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = OTHER_ORG
})

afterEach(() => {
  SqlPoolTestAccess.reset()
  if (savedAdapter === undefined) delete process.env.LIAISON_DATABASE_ADAPTER
  else process.env.LIAISON_DATABASE_ADAPTER = savedAdapter
  ;(env as { LIAISON_OPERATOR_ORG_ID?: string }).LIAISON_OPERATOR_ORG_ID = savedOperator
})

const isError = (a: unknown): a is { error: { code: string; message: string } } =>
  typeof a === "object" && a !== null && "error" in a

describe("ctx.sql.query: what may be asked", () => {
  it("refuses a connection the manifest does not declare, and one with no sql block", async () => {
    const unknown = await sqlQuery(ctx(), "nope", { sql: "SELECT 1" })
    expect(isError(unknown) && unknown.error.code).toBe("unknown_connection")
    const notSql = await sqlQuery(ctx(), "api", { sql: "SELECT 1" })
    expect(isError(notSql) && notSql.error.code).toBe("not_sql_connection")
    expect(resolvedFor).toHaveLength(0)
    expect(audits.map((a) => a.outcome)).toEqual(["blocked", "blocked"])
  })

  it("refuses raw SQL without the declared scope, before any credential is resolved", async () => {
    const answer = await sqlQuery(ctx({ callerScopes: ["dbapp:reads:read"] }), "warehouse", {
      sql: "SELECT 1",
    })
    expect(isError(answer) && answer.error.code).toBe("forbidden")
    expect(resolvedFor).toHaveLength(0)
    expect(transport.calls).toHaveLength(0)
  })

  it("refuses raw SQL on a connection of named reads only", async () => {
    const answer = await sqlQuery(ctx(), "reports", { sql: "SELECT 1" })
    expect(isError(answer) && answer.error.code).toBe("raw_query_not_allowed")
  })

  it("refuses a write past the read-only guard", async () => {
    const answer = await sqlQuery(ctx(), "warehouse", { sql: "DELETE FROM t" })
    expect(isError(answer)).toBe(true)
    expect(transport.calls).toHaveLength(0)
  })

  it("refuses a request with both or neither of read and sql", async () => {
    const both = await sqlQuery(ctx(), "warehouse", { sql: "SELECT 1", read: "x" })
    const neither = await sqlQuery(ctx(), "warehouse", {})
    expect(isError(both) && both.error.code).toBe("invalid_request")
    expect(isError(neither) && neither.error.code).toBe("invalid_request")
  })

  it("refuses a credential mode the manifest excludes", async () => {
    const answer = await sqlQuery(ctx(), "gateOnly", { sql: "SELECT 1" })
    expect(isError(answer) && answer.error.code).toBe("config_error")
  })
})

describe("ctx.sql.query: a raw query", () => {
  it("runs on the pool with bound params, the default timeout and row cap", async () => {
    const answer = await sqlQuery(ctx(), "warehouse", { sql: "SELECT $1::int AS n", params: [7] })
    expect(isError(answer)).toBe(false)
    expect(answer).toMatchObject({ rows: [{ id: 1 }], truncated: false })
    const call = transport.calls[0]
    expect(call?.params).toEqual([7])
    expect(call?.opts?.statementTimeoutMs).toBe(sqlCallLimits().defaultTimeoutMs)
    expect(call?.opts?.maxRows).toBe(sqlCallLimits().defaultMaxRows)
    expect(audits[0]).toMatchObject({ action: "sql.query", outcome: "success" })
    expect(audits[0]?.metadata.sqlHash).toBeString()
    expect(JSON.stringify(audits[0])).not.toContain("SELECT")
  })

  it("caps rows at the limit table's maximum whatever is asked, and says so", async () => {
    const max = sqlCallLimits().maxRows
    transport.rows = Array.from({ length: max + 5 }, (_, i) => ({ i }))
    const answer = await sqlQuery(ctx(), "warehouse", { sql: "SELECT 1", maxRows: max * 10 })
    expect(transport.calls[0]?.opts?.maxRows).toBe(max)
    expect(isError(answer)).toBe(false)
    if (!isError(answer)) {
      expect(answer.rows).toHaveLength(max)
      expect(answer.truncated).toBe(true)
    }
  })

  it("bounds the statement timeout and cancels the statement at the deadline", async () => {
    const asked = await sqlQuery(ctx(), "warehouse", { sql: "SELECT 1", timeoutMs: 10 * 60_000 })
    expect(isError(asked)).toBe(false)
    expect(transport.calls[0]?.opts?.statementTimeoutMs).toBe(sqlCallLimits().maxTimeoutMs)

    transport.hang = true
    const started = Date.now()
    const answer = await sqlQuery(ctx(), "warehouse", {
      sql: "SELECT count(*) FROM huge_table",
      timeoutMs: 1,
    })
    expect(isError(answer) && answer.error.code).toBe("statement_timeout")
    // 1 s floor + 1 s deadline grace + the cancel grace, never the full minute.
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(transport.calls[1]?.opts?.signal?.aborted).toBe(true)
    expect(audits.at(-1)).toMatchObject({ outcome: "error" })
  })

  it("never answers the DSN: a driver error that quotes it is answered generically", async () => {
    transport.failWith = new Error(`connect ECONNREFUSED ${DSN}`)
    const answer = await sqlQuery(ctx(), "warehouse", { sql: "SELECT 1" })
    expect(isError(answer)).toBe(true)
    expect(JSON.stringify(answer)).not.toContain("hunter2")
    expect(JSON.stringify(answer)).not.toContain("db.internal.example")
    expect(JSON.stringify(audits)).not.toContain("hunter2")
  })

  it("answers not_connected when the org has no account", async () => {
    const { NoConnectedAccountError } = await import(
      "~/modules/apps/connections/no-connected-account"
    )
    const answer = await sqlQuery(
      ctx({
        resolveCredentials: async () => {
          throw new NoConnectedAccountError("warehouse")
        },
      }),
      "warehouse",
      { sql: "SELECT 1" },
    )
    expect(isError(answer) && answer.error.code).toBe("not_connected")
  })
})

describe("ctx.sql.query: named reads of the instance catalog (liaison-self)", () => {
  it("pins every read to the caller's org, whatever orgId the app sends", async () => {
    const answer = await sqlQuery(ctx(), "reports", {
      read: "org_tier_and_slug",
      params: { orgId: OTHER_ORG },
    })
    expect(isError(answer)).toBe(false)
    expect(transport.calls[0]).toMatchObject({ kind: "read", name: "org_tier_and_slug" })
    expect(transport.calls[0]?.params).toMatchObject({ orgId: ORG })
  })

  it("refuses a read over a table whose scope the caller lacks", async () => {
    const answer = await sqlQuery(ctx({ callerScopes: [] }), "reports", {
      read: "recent_tickets_by_status",
      params: { status: "open" },
    })
    expect(isError(answer) && answer.error.code).toBe("forbidden")
    expect(isError(answer) && answer.error.message).toContain("tickets:tickets:read")
    expect(transport.calls).toHaveLength(0)
  })

  it("refuses an unknown read and a missing param", async () => {
    const unknown = await sqlQuery(ctx(), "reports", { read: "drop_everything" })
    expect(isError(unknown) && unknown.error.code).toBe("unknown_read")
    const missing = await sqlQuery(ctx({ callerScopes: ["tickets:tickets:read"] }), "reports", {
      read: "recent_tickets_by_status",
    })
    expect(isError(missing) && missing.error.code).toBe("invalid_params")
  })

  it("refuses raw SQL over this instance's own database outside the operator's org", async () => {
    const answer = await sqlQuery(ctx(), "reportsAndRaw", { sql: "SELECT * FROM kernel.users" })
    expect(isError(answer) && answer.error.code).toBe("forbidden")
    expect(transport.calls).toHaveLength(0)
  })

  it("lists the reads, marking the ones the caller may not run", async () => {
    const answer = await sqlReads(ctx({ callerScopes: [] }), "reports")
    expect(isError(answer)).toBe(false)
    if (!isError(answer)) {
      expect(answer.adapter).toBe("liaison-self")
      expect((answer.reads.org_tier_and_slug as { allowed: boolean }).allowed).toBe(true)
      expect((answer.reads.recent_tickets_by_status as { allowed: boolean }).allowed).toBe(false)
      // liaison-self declares no domain tiers: every domain is internal.
      expect(answer.domains).toEqual({})
    }
    expect(resolvedFor).toHaveLength(0)
  })
})

describe("ctx.sql.schema", () => {
  it("drops secret columns and needs the raw-query scope", async () => {
    const answer = await sqlSchema(ctx(), "warehouse", {})
    expect(isError(answer)).toBe(false)
    if (!isError(answer)) {
      expect(answer.tables[0]?.columns.map((c) => c.column)).toEqual(["id"])
    }
    const refused = await sqlSchema(ctx({ callerScopes: [] }), "warehouse", {})
    expect(isError(refused) && refused.error.code).toBe("forbidden")
  })

  it("takes the manifest's own schema scope when it names one", async () => {
    const reader = await sqlSchema(ctx({ callerScopes: ["dbapp:reads:read"] }), "describable", {})
    expect(isError(reader)).toBe(false)
    const refused = await sqlSchema(ctx({ callerScopes: ["dbapp:query:read"] }), "describable", {})
    expect(isError(refused) && refused.error.code).toBe("forbidden")
  })
})
