// SPDX-License-Identifier: FSL-1.1-ALv2
// database connector — sandboxed manifest handler bundle.
//
// Headless connector. Its agent tools are thin sandboxed handlers that
// delegate to host-side bridge methods (`db_*`), where credential
// resolution and transport execution happen with host privileges. Mirrors
// the gitlab/Drive handler <-> bridge split.
//
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

import type {} from "node:buffer"

interface DatabaseSandboxCtx {
  db_list_reads: (paramsJson: string) => Promise<string>
  db_read: (paramsJson: string) => Promise<string>
  db_describe: (paramsJson: string) => Promise<string>
  db_probe: (paramsJson: string) => Promise<string>
  db_query: (paramsJson: string) => Promise<string>
  log_info: (msg: string, dataJson?: string) => void
  log_warn: (msg: string, dataJson?: string) => void
}

async function dbListReads(params: unknown, ctx: DatabaseSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.db_list_reads(JSON.stringify(params ?? {})))
}

async function dbRead(params: unknown, ctx: DatabaseSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.db_read(JSON.stringify(params ?? {})))
}

async function dbDescribe(params: unknown, ctx: DatabaseSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.db_describe(JSON.stringify(params ?? {})))
}

async function dbProbe(params: unknown, ctx: DatabaseSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.db_probe(JSON.stringify(params ?? {})))
}

async function dbQuery(params: unknown, ctx: DatabaseSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.db_query(JSON.stringify(params ?? {})))
}

// --- Event handlers ---

interface DatabaseConnectionEventData {
  id: string
  appName: string
  connectionName?: string
  identifier?: string
}

interface DatabaseKernelConnectionEvent {
  app: "kernel"
  entity: "connected_account"
  action: "create"
  data: DatabaseConnectionEventData
}

/**
 * S2 (review_code.md) — the connect-time safety probe (`db_probe`) is meant
 * to be self-diagnosing, not manual-only: it runs automatically once a
 * `database` credential is saved, logging warnings/missingReads, exactly
 * like `db_probe` called on demand would (same underlying bridge method —
 * `runDatabaseProbe`). Mirrors the `kernel/connected_account:create`
 * subscriber pattern used by mail's `onAccountConnected` and boxtal's
 * `onConnectionEstablished`: filter to this app's own connection, then do
 * best-effort, non-fatal post-connect work. A probe failure must never block
 * the connection itself — it's advisory (spec §3.6 layer 8), so every path
 * below only logs.
 */
async function onDatabaseConnected(
  event: DatabaseKernelConnectionEvent,
  ctx: DatabaseSandboxCtx,
): Promise<void> {
  if (event.data?.appName !== "database") return
  // Probe the connection that was just saved: the second, `warehouse`
  // connection is its own manifest connection and must not re-probe the default.
  const probeParams =
    event.data.connectionName === "warehouse" ? JSON.stringify({ connection: "warehouse" }) : "{}"
  try {
    const result = JSON.parse(await ctx.db_probe(probeParams)) as {
      ok?: boolean
      warnings?: string[]
      missingReads?: string[]
      error?: { code: string; message: string }
    }
    if (result.error) {
      ctx.log_warn("database: auto-probe returned an error", JSON.stringify(result.error))
      return
    }
    if (result.ok === false) {
      ctx.log_warn(
        "database: auto-probe at connect reported issues",
        JSON.stringify({ warnings: result.warnings, missingReads: result.missingReads }),
      )
    } else {
      ctx.log_info("database: auto-probe at connect is clean", JSON.stringify({}))
    }
  } catch (err) {
    // Non-fatal by design (spec §3.6 layer 8 is advisory) — never throw out
    // of a connect-event subscriber over a probe failure.
    ctx.log_warn(
      "database: auto-probe at connect threw",
      JSON.stringify({ reason: err instanceof Error ? err.message : String(err) }),
    )
  }
}
