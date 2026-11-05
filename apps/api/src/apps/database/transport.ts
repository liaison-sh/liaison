// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DbTransport — the seam behind which PostgresDirect (direct DSN) and
// HttpGate (liaison-db-gate sidecar) are interchangeable. The bridge
// (`bridge.ts`) drives whichever transport the connection's credential mode
// resolved to; the agent sees identical failure shapes regardless of which
// one is active.

import type { ReadCatalog, ReadDefinition } from "@liaison/db-core"

export interface RunReadResult {
  rows: Record<string, unknown>[]
  truncated: boolean
  durationMs: number
}

export interface RunQueryResult {
  rows: Record<string, unknown>[]
  truncated: boolean
  durationMs: number
}

export interface SchemaColumnInfo {
  column: string
  dataType: string
}

export interface SchemaTableInfo {
  table: string
  columns: SchemaColumnInfo[]
}

export interface SchemaInfo {
  tables: SchemaTableInfo[]
}

export interface ProbeReport {
  ok: boolean
  mode: "direct" | "gate"
  writeGrantsDetected?: boolean
  dangerousExecuteGrantsDetected?: boolean
  missingReads?: string[]
  warnings: string[]
}

/**
 * Per-call execution bounds the bridge derives from the calling tool's budget.
 * Both are optional so a caller outside a tool call (the connect-time probe,
 * the Knowledge read runner) keeps the transport's own configuration.
 */
export interface ExecOptions {
  /**
   * Upper bound, in ms, for this call's statement timeout. The transport's own
   * configured timeout still wins when it is lower: this can only shorten.
   */
  statementTimeoutMs?: number
  /**
   * Aborts the call. A statement already running is cancelled ON THE DATABASE,
   * not merely abandoned: a query nobody waits for must not keep a warehouse
   * busy and a pooled connection held until its own timeout.
   */
  signal?: AbortSignal
}

/** Transport-agnostic seam a bridge drives to execute reads/queries against a
 *  connected database, whether directly (PostgresDirect) or via the gate
 *  sidecar (HttpGate). */
export interface DbTransport {
  probe(opts?: ExecOptions): Promise<ProbeReport>
  runRead(
    read: ReadDefinition,
    readName: string,
    params: Record<string, unknown>,
    opts?: ExecOptions,
  ): Promise<RunReadResult>
  runQuery(sql: string, opts?: ExecOptions): Promise<RunQueryResult>
  describe(catalog: ReadCatalog, table?: string, opts?: ExecOptions): Promise<SchemaInfo>
  close(): Promise<void>
}

// -------------------------------------------------------------- error types

export class DbTransportError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "config"
      | "tls_required"
      | "not_connected"
      | "timeout"
      | "auth"
      | "unreachable"
      | "protocol"
      | "execution"
      | "unknown",
    public readonly code?: string,
  ) {
    super(message)
    this.name = "DbTransportError"
  }
}
