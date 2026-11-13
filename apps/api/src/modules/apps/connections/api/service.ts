// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * One connector operation for an actor: resolve the connection (adapter row
 * plus org-owned credentials), refuse what the calling mode may not run, call
 * the transport, and write the audit row. Shared by the agent tool bridge, the
 * `/test` route and the customer resolver.
 *
 * The audit row is built from the connection, the operation name, the actor,
 * the outcome, the HTTP status and the duration: never from a URL, a param
 * value or a response, so nothing the adapter sends can reach the log.
 *
 * A chained read (`chain` on the operation) runs its own request, then each
 * step in turn with params taken from the previous step's projected items
 * (at most MAX_CHAIN_FANOUT distinct calls per step, one page each), all
 * within the call's one time budget, through the same transport: every step
 * is an operation of the same adapter, so it is host-pinned, validated and
 * projected exactly like a direct call. One audit row covers the whole call.
 */
import {
  type Adapter,
  ConnectorRenderError,
  chainStepCalls,
  MAX_CHAIN_FANOUT,
  MAX_ITEMS_PER_CALL,
  type Operation,
  type ProjectedObject,
  ROLE_REGISTRY,
  render,
} from "@liaison/api-connector-core"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type AuditEntry, writeAuditLog } from "~/modules/audit/service"
import { forgetCustomerLookups } from "./cache"
import type { ApiConn } from "./declarations"
import {
  type AdapterRow,
  type ConnectionCredentials,
  getAdapterRow,
  resolveConnectionCredentials,
} from "./store"
import {
  API_CONNECTOR_PAGES_BUDGET_MS,
  ApiConnectorError,
  adapterHash,
  apiConnectorLog,
  type CallOperationResult,
  callOperation,
  type RequestBudget,
  requestUrl,
} from "./transport"

/**
 * What an approved write sends, as its approval card shows it: the method,
 * the host, the rendered path (with its query, never an auth value) and the
 * version of the adapter it was rendered from.
 */
export interface WriteTarget {
  method: string
  host: string
  path: string
  adapterHash: string
}

/** The target of one write call, or the connector error its params map to. */
export function writeTarget(
  adapter: Adapter,
  operation: Operation,
  params: Record<string, unknown>,
): WriteTarget {
  let url: URL
  try {
    url = requestUrl(adapter, render(operation, params))
  } catch (err) {
    if (err instanceof ConnectorRenderError)
      throw new ApiConnectorError("invalid_params", err.message)
    throw err
  }
  return {
    method: operation.method,
    host: url.host,
    path: `${url.pathname}${url.search}`,
    adapterHash: adapterHash(adapter),
  }
}

/** A target as stored in the approved params, when it has the shape of one. */
export function parseWriteTarget(value: unknown): WriteTarget | null {
  if (typeof value !== "object" || value === null) return null
  const t = value as Record<string, unknown>
  const { method, host, path, adapterHash: hash } = t
  if (
    typeof method !== "string" ||
    typeof host !== "string" ||
    typeof path !== "string" ||
    typeof hash !== "string"
  ) {
    return null
  }
  return { method, host, path, adapterHash: hash }
}

function isGiven(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)
}

/** read: connector_read; write: connector_write (approved); test: the read-only probe. */
export type ConnectorCallMode = "read" | "write" | "test"

export interface ConnectorCallActor {
  orgId: string
  /** The acting user (an agent's principal, or the admin running a test). */
  userId: string
  actorType: "user" | "agent" | "system" | "mcp"
}

export interface RunConnectorOperationInput {
  actor: ConnectorCallActor
  /** The app's API connection the identifier belongs to (its org is the actor's). */
  conn: ApiConn
  identifier: string
  operation: string
  params: Record<string, unknown>
  mode: ConnectorCallMode
  /**
   * write mode: the target the approval was given for (pinned at staging).
   * The call is refused unless the adapter and the rendered request still
   * match it exactly.
   */
  approvedTarget?: WriteTarget | null
  /** Transaction to write the audit row on; the privileged pool when absent. */
  auditDb?: RlsClient | PrivilegedDb
  /**
   * Collect the audit row here instead of writing it: a caller running many
   * calls at once writes them together afterwards (writeConnectorAudits), so
   * the calls take no database slot of their own.
   */
  auditSink?: AuditEntry[]
  /**
   * The connection's adapter row and credentials, when the caller already
   * loaded them for several calls: the call then reads nothing from the
   * database before its HTTP request.
   */
  connection?: { row: AdapterRow; credentials: ConnectionCredentials }
  signal?: AbortSignal
  maxPages?: number
  budgetMs?: number
  requestTimeoutMs?: number
  /** Upstream requests this call (every page and chain step) may make, shared with the caller's others. */
  requestBudget?: RequestBudget
}

export interface RunConnectorOperationResult {
  connection: string
  operation: string
  kind: Operation["kind"]
  status: number
  items: ProjectedObject[]
  truncated: boolean
  /** Pages fetched, every chain step's included. */
  pages: number
  ms: number
}

async function audit(
  input: RunConnectorOperationInput,
  outcome: { status?: number; code?: string; ms: number; ok: boolean },
): Promise<void> {
  const entry: AuditEntry = {
    orgId: input.actor.orgId,
    actorId: input.actor.userId,
    actorType: input.actor.actorType,
    app: input.conn.app,
    action: `${input.conn.app}.${input.mode}`,
    metadata: {
      connection: input.identifier,
      operation: input.operation,
      outcome: outcome.ok ? "success" : "error",
      ...(outcome.status !== undefined ? { status: outcome.status } : {}),
      ...(outcome.code ? { code: outcome.code } : {}),
      ms: outcome.ms,
    },
  }
  if (input.auditSink) {
    input.auditSink.push(entry)
    return
  }
  try {
    if (input.auditDb) await writeAuditLog(input.auditDb, entry)
    else
      await withPrivilegedDb(input.actor.orgId, "api-connector-audit", (tx) =>
        writeAuditLog(tx, entry),
      )
  } catch {
    // Audit is best-effort (writeAuditLog swallows its own errors): a call
    // never fails because its audit row did.
  }
}

/** Write the audit rows of calls that collected them (`auditSink`), in one short transaction. */
export async function writeConnectorAudits(orgId: string, entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return
  try {
    await withPrivilegedDb(orgId, "api-connector-audit", async (tx) => {
      for (const entry of entries) await writeAuditLog(tx, entry)
    })
  } catch {
    // Best-effort, like each call's own audit row.
  }
}

/** Resolve the connection and its operation, refusing what this mode may not run. */
export async function resolveConnectorOperation(
  conn: ApiConn,
  identifier: string,
  operationName: string,
  mode: ConnectorCallMode,
  loadedRow?: AdapterRow,
) {
  const row = loadedRow ?? (await getAdapterRow(conn, identifier))
  if (!row)
    throw new ApiConnectorError("unknown_connection", `No API connection named "${identifier}".`)
  const operation = row.adapter.operations.find((o) => o.name === operationName)
  if (!operation) {
    throw new ApiConnectorError(
      "unknown_operation",
      `The connection "${identifier}" has no operation "${operationName}". Call connector_list_operations first.`,
    )
  }
  if (operation.kind === "write" && mode === "test") {
    throw new ApiConnectorError(
      "write_not_testable",
      `"${operationName}" is a write operation; tests run read operations only.`,
    )
  }
  if (operation.kind === "write" && mode === "read") {
    throw new ApiConnectorError(
      "write_not_allowed",
      `"${operationName}" is a write operation; use connector_write, which asks for approval.`,
    )
  }
  if (operation.kind === "read" && mode === "write") {
    throw new ApiConnectorError(
      "write_not_allowed",
      `"${operationName}" is a read operation; use connector_read.`,
    )
  }
  return { row, operation }
}

export async function runConnectorOperation(
  input: RunConnectorOperationInput,
): Promise<RunConnectorOperationResult> {
  const started = Date.now()
  try {
    const { row, operation } = await resolveConnectorOperation(
      input.conn,
      input.identifier,
      input.operation,
      input.mode,
      input.connection?.row,
    )
    // A role answering "at least one of" (a lookup by email, phone or domain)
    // is never called with none: its filters would all drop, and the API would
    // answer a page of every record.
    const oneOf = operation.role ? ROLE_REGISTRY[operation.role].oneOfParams : []
    if (oneOf.length > 0 && !oneOf.some((p) => isGiven(input.params[p]))) {
      throw new ApiConnectorError(
        "invalid_params",
        `"${operation.name}" needs at least one of the params ${oneOf.join(", ")}.`,
      )
    }
    if (input.mode === "write") {
      const approved = input.approvedTarget
      const now = writeTarget(row.adapter, operation, input.params)
      if (
        !approved ||
        approved.adapterHash !== now.adapterHash ||
        approved.method !== now.method ||
        approved.host !== now.host ||
        approved.path !== now.path
      ) {
        throw new ApiConnectorError(
          "write_not_allowed",
          `The adapter of "${input.identifier}" or this write's target changed since it was approved; nothing was sent. Ask for approval again.`,
        )
      }
    }
    const credentials =
      input.connection?.credentials ??
      (await resolveConnectionCredentials(input.conn, input.identifier))
    if (!credentials) {
      throw new ApiConnectorError(
        "not_configured",
        `The connection "${input.identifier}" has no credentials yet.`,
      )
    }
    const deadline = Date.now() + (input.budgetMs ?? API_CONNECTOR_PAGES_BUDGET_MS)
    const call = (op: Operation, params: Record<string, unknown>, maxPages?: number) =>
      callOperation({
        ...input.conn,
        identifier: input.identifier,
        adapter: row.adapter,
        credentials: credentials.values,
        credentialVersion: credentials.version,
        operation: op,
        params,
        maxPages,
        budgetMs: Math.max(1, deadline - Date.now()),
        requestTimeoutMs: input.requestTimeoutMs,
        signal: input.signal,
        requestBudget: input.requestBudget,
      })
    let result: CallOperationResult = await call(operation, input.params, input.maxPages)
    for (const step of operation.chain ?? []) {
      const target = row.adapter.operations.find((o) => o.name === step.operation)
      // Validation refuses a step naming no read of this adapter; a stored row always passed it.
      if (target?.kind !== "read") {
        throw new ApiConnectorError(
          "unknown_operation",
          `The chain of "${operation.name}" names no read "${step.operation}".`,
        )
      }
      const calls = chainStepCalls(step, target, result.items, MAX_CHAIN_FANOUT)
      const settled = await Promise.all(calls.map((params) => call(target, params, 1)))
      const items = settled.flatMap((r) => r.items)
      result = {
        status: settled.at(-1)?.status ?? result.status,
        items: items.slice(0, MAX_ITEMS_PER_CALL),
        truncated:
          result.truncated || settled.some((r) => r.truncated) || items.length > MAX_ITEMS_PER_CALL,
        pages: result.pages + settled.reduce((n, r) => n + r.pages, 0),
        ms: Date.now() - started,
      }
    }
    await audit(input, { ok: true, status: result.status, ms: result.ms })
    if (operation.kind === "write") await forgetCustomerLookups(input.conn, input.identifier)
    return {
      connection: input.identifier,
      operation: operation.name,
      kind: operation.kind,
      status: result.status,
      items: result.items,
      truncated: result.truncated,
      pages: result.pages,
      ms: result.ms,
    }
  } catch (err) {
    const ms = Date.now() - started
    if (err instanceof ApiConnectorError) {
      await audit(input, { ok: false, code: err.code, status: err.upstreamStatus, ms })
      apiConnectorLog.warn(
        {
          orgId: input.actor.orgId,
          connection: input.identifier,
          operation: input.operation,
          code: err.code,
          status: err.upstreamStatus,
        },
        "api connector call failed",
      )
      throw err
    }
    await audit(input, { ok: false, code: "internal", ms })
    apiConnectorLog.error(
      { orgId: input.actor.orgId, connection: input.identifier, operation: input.operation, err },
      "api connector call threw",
    )
    throw err
  }
}
