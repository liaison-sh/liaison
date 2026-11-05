// SPDX-License-Identifier: FSL-1.1-ALv2
//
// install_metadata read helpers.
//
// The sandbox db bridge (`db_findMany`/`db_findOne`) runs a raw `SELECT *` and
// returns driver rows with their **snake_case** column names — it snake_cases
// keys on write but does NOT camelCase them on read (the kernel's own ticket
// projection converts explicitly via `toCamelTicket` for the same reason). So
// reading `row.shopDomain` off a `findMany` result silently yields `undefined`.
//
// `camelizeRow` normalizes a raw row to camelCase and is idempotent on rows
// that are already camelCase (the unit-test mock db hands back camelCase), so
// routing every reader through `loadInstallMetadata` is correct under both the
// real sandbox and the mocked test db.
import type { AppContext } from "@liaison/app-sdk"

/** `granted_o_auth_scopes` → `grantedOAuthScopes`; `shopDomain` → `shopDomain`. */
function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
}

/** Convert every top-level key of a DB row from snake_case to camelCase. */
export function camelizeRow<T = Record<string, unknown>>(
  row: Record<string, unknown> | undefined | null,
): T | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v
  return out as T
}

/** camelize every row of a `findMany` result. */
export function camelizeRows<T = Record<string, unknown>>(
  rows: Array<Record<string, unknown>> | undefined | null,
): T[] {
  return (rows ?? []).map((r) => camelizeRow<T>(r) as T)
}

/** Canonical camelCase shape of an `install_metadata` row. */
export interface InstallMetadata {
  id: string
  orgId: string
  shopDomain: string
  apiBaseUrl: string | null
  apiVersion: string
  connectionId: string
  connectionStatus: "connected" | "disconnected"
  grantedOAuthScopes?: unknown
  inventoryLocationAllowlist?: unknown
  unfulfilledThresholdHours?: number
  consecutiveScopeMirrorFailures?: number
  installedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

/**
 * Load the single `install_metadata` row (camelCase-normalized), or `null` when
 * the app isn't connected. Pass `where` to scope by a specific column
 * (camelCase keys — the bridge snake_cases them on the way in).
 */
export async function loadInstallMetadata(
  ctx: AppContext,
  where?: Record<string, unknown>,
): Promise<InstallMetadata | null> {
  const rows = (await ctx.db.findMany("install_metadata", {
    ...(where ? { where } : {}),
    limit: 1,
  })) as Array<Record<string, unknown>>
  return camelizeRow<InstallMetadata>(rows[0])
}
