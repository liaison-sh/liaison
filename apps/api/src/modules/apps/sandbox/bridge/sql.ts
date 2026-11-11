// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.sql.*`: the platform-held SQL connections (connections/sql/service.ts)
 * for app code, on every executor.
 *
 *  - The connection is one the CALLING app's manifest declares with an `sql`
 *    block; its org-owned account's credentials are resolved here and never
 *    returned, so the methods are safe on Workers (no secret crosses the
 *    bridge).
 *  - `sql` is a structured-return group (ctx-shim.ts SHIM_RULES): the request
 *    arrives as JSON text and every answer is JSON text, `{ rows, ... }` or
 *    `{ error: { code, message } }`.
 *  - The methods run no statement on the run's transaction: on a session
 *    bridge they are tx-less (rpc-bridge.ts), take a short transaction of
 *    their own for the credential lookup and the audit line, and hold no
 *    pool connection of Liaison's own across the remote query.
 *  - All four are reads: a read-only run may call them.
 */
import type { RlsClient } from "~/db"
import {
  type SqlCallContext,
  sqlProbe,
  sqlQuery,
  sqlReads,
  sqlSchema,
} from "~/modules/apps/connections/sql/service"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"

/** A JSON argument: text from the shim, or the value itself from a direct caller. */
function jsonArg(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return undefined
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw)
  } catch {
    return Symbol.for("invalid-json")
  }
}

function request(raw: unknown): unknown {
  const value = jsonArg(raw)
  return value === Symbol.for("invalid-json") ? { __invalid: "the request is not JSON" } : value
}

export function createSqlMethods(
  ctx: Pick<
    BridgeContext,
    | "appName"
    | "orgId"
    | "userId"
    | "actorType"
    | "txDb"
    | "manifest"
    | "callerScopes"
    | "bridgeOptions"
  >,
): {
  sql_query: (connection: string, requestJson?: unknown) => Promise<string>
  sql_reads: (connection: string) => Promise<string>
  sql_schema: (connection: string, requestJson?: unknown) => Promise<string>
  sql_probe: (connection: string, requestJson?: unknown) => Promise<string>
} {
  const { appName, orgId, userId, actorType, manifest, bridgeOptions } = ctx
  const shortTx = <T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> =>
    bridgeOptions?.withShortTx ? bridgeOptions.withShortTx(fn) : fn(ctx.txDb)

  const call: SqlCallContext = {
    orgId,
    appName,
    callerScopes: ctx.callerScopes ?? [],
    declarationOf: (connection) => manifest.connections?.[connection],
    resolveCredentials: async (connection, identifier) => {
      const { getCredentialsForConnection } = await import("~/modules/apps/connections/service")
      // Org-owned only: the pool is shared by the whole org, so a member's
      // personal account of the same name must never stand in for it.
      return shortTx((tx) =>
        getCredentialsForConnection(tx, orgId, userId, appName, connection, identifier, {
          actorType: actorType === "user" ? "user" : "system",
          ownerType: "org",
        }),
      )
    },
    writeAudit: async (entry) => {
      const { writeAuditLog } = await import("~/modules/audit/service")
      await shortTx((tx) =>
        writeAuditLog(tx, {
          orgId,
          actorId: userId,
          actorType,
          app: appName,
          action: entry.action,
          metadata: { ...entry.metadata, outcome: entry.outcome },
        }),
      )
    },
    ...(bridgeOptions?.signal ? { signal: bridgeOptions.signal } : {}),
  }

  return {
    sql_query: async (connection, requestJson) =>
      JSON.stringify(await sqlQuery(call, connection, request(requestJson))),
    sql_reads: async (connection) => JSON.stringify(await sqlReads(call, connection)),
    sql_schema: async (connection, requestJson) =>
      JSON.stringify(await sqlSchema(call, connection, request(requestJson))),
    sql_probe: async (connection, requestJson) =>
      JSON.stringify(await sqlProbe(call, connection, request(requestJson))),
  }
}
