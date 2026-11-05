// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GateDb — the gate's own thin execution layer over postgres.js, built
// entirely on `@liaison/db-core`'s shared primitives (capRows,
// projectColumns, ConcurrencyBound, redactDbError, toOrdinalSql,
// assertReadOnlySelect) — the SAME implementation `PostgresDirect` uses, no
// copy-paste duplication (Task 4 §4.1). This is intentionally simpler than
// PostgresDirect: no TLS-by-resolved-IP classifier (the gate's TLS posture is
// its reverse proxy / cert config per §3.3, not this connector's DSN-TLS
// concern) and no probe caching — it's a small, restartable sidecar.

import {
  assertReadOnlySelect,
  ConcurrencyBound,
  capRows,
  EXECUTE_GRANT_PROBE_SQL,
  projectColumns,
  type ReadDefinition,
  redactDbError,
  toOrdinalSql,
  WRITE_GRANT_PROBE_SQL,
  wrapWithRowCap,
} from "@liaison/db-core"
import postgres from "postgres"

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000
const DEFAULT_ROW_CAP = 500
const HARD_ROW_CAP = 2000

export interface GateProbeReport {
  ok: boolean
  writeGrantsDetected: boolean
  dangerousExecuteGrantsDetected: boolean
  warnings: string[]
}

export class GateDb {
  private readonly sql: ReturnType<typeof postgres>
  private readonly concurrency: ConcurrencyBound

  constructor(
    dsn: string,
    opts: { poolMax?: number; concurrencyLimit?: number; statementTimeoutMs?: number } = {},
  ) {
    this.sql = postgres(dsn, {
      max: opts.poolMax ?? 4,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    })
    this.concurrency = new ConcurrencyBound(opts.concurrencyLimit ?? 4)
    this.statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS
  }

  private readonly statementTimeoutMs: number

  async runRead(
    read: ReadDefinition,
    params: Record<string, unknown>,
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; durationMs: number }> {
    const { text, values } = toOrdinalSql(read.sql, params)
    const maxRows = Math.min(read.maxRows ?? DEFAULT_ROW_CAP, HARD_ROW_CAP)
    const cappedText = wrapWithRowCap(text, maxRows)
    return this.concurrency.run(async () => {
      const start = Date.now()
      const rows = await this.sql.begin(async (tx) => {
        // Explicit per-txn wall, same as runQuery below — the gate's own DB
        // role is "recommended read-only, not required" (§3.3), so curated
        // reads must not lean solely on the connected role's
        // default_transaction_read_only.
        await tx.unsafe("SET TRANSACTION READ ONLY")
        await tx.unsafe(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`)
        return tx.unsafe(cappedText, values as never[])
      })
      const capped = capRows(rows as unknown as Record<string, unknown>[], maxRows)
      const projected = projectColumns(capped.rows, read.columns)
      return { rows: projected, truncated: capped.truncated, durationMs: Date.now() - start }
    })
  }

  async runQuery(
    sqlText: string,
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; durationMs: number }> {
    // Defense in depth: sql-guard runs BEFORE this is called (server.ts), but
    // the READ ONLY transaction below is the structural wall independent of
    // that validator per Task 3/7's layered model.
    assertReadOnlySelect(sqlText)
    const maxRows = DEFAULT_ROW_CAP
    const cappedText = wrapWithRowCap(sqlText, maxRows)
    return this.concurrency.run(async () => {
      const start = Date.now()
      const rows = await this.sql.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY")
        await tx.unsafe(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`)
        return tx.unsafe(cappedText)
      })
      const capped = capRows(rows as unknown as Record<string, unknown>[], maxRows)
      return { rows: capped.rows, truncated: capped.truncated, durationMs: Date.now() - start }
    })
  }

  async probe(): Promise<GateProbeReport> {
    const warnings: string[] = []
    let writeGrantsDetected = false
    let dangerousExecuteGrantsDetected = false
    try {
      // Effective-privilege check (has_table_privilege) — broader than
      // information_schema.role_table_grants WHERE grantee=current_user,
      // which misses PUBLIC grants and role-membership inheritance. See
      // WRITE_GRANT_PROBE_SQL's doc in db-core.
      const writeGrantRows = await this.sql.unsafe(WRITE_GRANT_PROBE_SQL)
      if (writeGrantRows.length > 0) {
        writeGrantsDetected = true
        warnings.push(
          `Role has ${writeGrantRows.length} effective non-SELECT privilege(s) (direct, PUBLIC, or inherited)`,
        )
      }
    } catch (err) {
      warnings.push(`Could not check write grants: ${redactDbError(err).message}`)
    }
    try {
      const executeRows = await this.sql.unsafe(EXECUTE_GRANT_PROBE_SQL)
      if (executeRows.length > 0) {
        dangerousExecuteGrantsDetected = true
        warnings.push(
          `Role has ${executeRows.length} effective EXECUTE privilege(s) (direct, PUBLIC, or inherited) beyond built-ins`,
        )
      }
    } catch (err) {
      warnings.push(`Could not check EXECUTE grants: ${redactDbError(err).message}`)
    }
    return {
      ok: warnings.length === 0,
      writeGrantsDetected,
      dangerousExecuteGrantsDetected,
      warnings,
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 })
  }
}
