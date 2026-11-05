// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connection lifecycle. Subscribed via events.subscribes to kernel
// connected_account:create/disconnect. On connect: one GET /supplier_invoices
// (must 200) + one GET /bank_accounts (200→cash live; 403→invoice-only degrade;
// non-403 bank error re-throws). supplier-403 throws scoped to finance.
//
// `runConnectProbe` REIMPLEMENTS (does not import — a bundled app may import only
// @liaison/app-sdk, never scripts/chaos/) the locked 3-way classifier semantics
// from scripts/chaos/pennylane-probe.ts. The two consumers agree on semantics;
// only the labels differ, mapped 1:1:
//   probe verdict (script)   →  this connector
//   full_scope               →  { scope: "full",         cash_status: "live" }
//   invoice_only             →  { scope: "invoice_only", cash_status: "unavailable" }
//   blocked_finance          →  throw (supplier-403 → BLOCKED finance class)
// Keep this table in lockstep with the script's locked verdict table (§5.5).
import { BASE_URL_KEY, setAppConfig } from "./einvoicing/webhooks"
import { getClient } from "./lib/get-client"
import { PennylaneApiError } from "./lib/pennylane-client"

export interface ConnectProbeResult {
  ok: true
  scope: "full" | "invoice_only"
  cash_status: "live" | "unavailable"
}

/** Reuses the locked 3-way classifier semantics (scripts/chaos/pennylane-probe.ts). */
export async function runConnectProbe(
  client: { list(path: string, q?: { cursor?: string; limit?: number }): Promise<unknown> },
): Promise<ConnectProbeResult> {
  try {
    await client.list("/supplier_invoices", { limit: 1 }) // MUST 200
  } catch (e) {
    const status = e instanceof PennylaneApiError ? e.status : undefined
    throw new Error(
      `Pennylane supplier_invoices probe failed (${status ?? "?"}): BLOCKED finance class`,
    )
  }
  try {
    await client.list("/bank_accounts", { limit: 1 }) // 200 → cash live
    return { ok: true, scope: "full", cash_status: "live" }
  } catch (e) {
    if (e instanceof PennylaneApiError && e.status === 403) {
      // degrade, do NOT block
      return { ok: true, scope: "invoice_only", cash_status: "unavailable" }
    }
    throw e // non-403 (e.g. 500) → transient, re-throw
  }
}

interface ConnectionEventData {
  id: string
  appName: string
  orgId?: string
  /** The kernel's public base URL, carried on the connect event. */
  kernelPublicBaseUrl?: string
}
interface ConnectionEvent {
  app: "kernel"
  entity: "connected_account"
  action: "create" | "disconnect"
  orgId: string
  data: ConnectionEventData | { id: string; appName: string }
}
interface ConnectionCtx {
  orgId: string
  db: {
    findMany(
      entity: string,
      opts?: { where?: Record<string, unknown>; limit?: number },
    ): Promise<unknown[]>
    insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
    delete(entity: string, id: string): Promise<void>
  }
  fetch: import("./lib/pennylane-client").PennylaneFetch
  connections: unknown
  logger?: {
    info(m: string, d?: unknown): void
    warn(m: string, d?: unknown): void
    error(m: string, d?: unknown): void
    debug(m: string, d?: unknown): void
  }
}

/** Persist the probe verdict in app_config so reads know whether cash is descoped. */
async function persistConnectionScope(
  ctx: ConnectionCtx,
  scope: string,
  cashStatus: string,
): Promise<void> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: "connection_scope" },
    limit: 1,
  })) as Array<{ id: string }>
  const value = JSON.stringify({ scope, cash_status: cashStatus })
  if (rows[0]) await ctx.db.update("app_config", rows[0].id, { value })
  else await ctx.db.insert("app_config", { key: "connection_scope", value })
}

export async function onConnectionEstablished(
  event: ConnectionEvent,
  ctx: ConnectionCtx,
): Promise<void> {
  if (event.data?.appName !== "pennylane") return
  // Remember the instance's public address: the e-invoicing webhook callback is built from it.
  const base = (event.data as ConnectionEventData).kernelPublicBaseUrl
  if (typeof base === "string" && /^https?:\/\//.test(base)) await setAppConfig(ctx, BASE_URL_KEY, base.replace(/\/$/, ""))
  const { client } = await getClient(ctx)
  const probe = await runConnectProbe(client) // throws on supplier-403 → blocked finance class
  await persistConnectionScope(ctx, probe.scope, probe.cash_status)
}

export async function onConnectionDisconnected(
  event: ConnectionEvent,
  ctx: ConnectionCtx,
): Promise<void> {
  if (event.data?.appName !== "pennylane") return
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: "connection_scope" },
    limit: 1,
  })) as Array<{ id: string }>
  if (rows[0]) await ctx.db.delete("app_config", rows[0].id)
}
