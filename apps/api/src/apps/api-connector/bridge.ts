// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * api-connector host bridge: the `connector_*` methods the sandboxed
 * handlers delegate to (the operation tools, and the adapter authoring reads:
 * the stored document, its kept versions, the authoring reference and the
 * one-page test call; the save and restore are host tools, authoring-tools.ts). They run without a database transaction (declared
 * tx-less in rpc-bridge.ts: an upstream call can take seconds and must not
 * pin a pooled connection), so every read and the audit row go through the
 * privileged pool, scoped to the org explicitly.
 *
 * Output: operation results are external content, so the item list is
 * returned fenced (`wrapExternalContent`); the operation catalogue is the
 * org admin's own adapter text and is returned as data. Failures come back as
 * `{ error: { code, message } }`, codes from the transport, never a body or a
 * credential.
 */

import { operationSummaries } from "@liaison/api-connector-core"
import { wrapExternalContent } from "~/lib/external-content"
import { isRecord } from "~/lib/guards"
import type {
  BridgeExtensionContext,
  BridgeExtensionMethod,
} from "~/modules/apps/sandbox/bridge-extensions"
import { listVersionsWithTargets, readReference, readStoredAdapter } from "./authoring"
import {
  type ConnectorCallMode,
  parseWriteTarget,
  resolveConnectorOperation,
  runConnectorOperation,
  writeTarget,
} from "./service"
import { listAdapterRows, resolveConnectionCredentials } from "./store"
import {
  API_CONNECTOR_ERROR_HTTP_STATUS,
  API_CONNECTOR_REQUEST_TIMEOUT_MS,
  ApiConnectorError,
} from "./transport"

/**
 * The caller's own mistake in the call's arguments, which the message says how
 * to correct (the params an operation accepts, the operations a connection has):
 * retryable with changed arguments, the kernel's class for a parameter error
 * (execute-tool.ts). Anything else repeats identically and is not.
 */
const CORRECTABLE_ERRORS = new Set(["invalid_params", "unknown_operation"])

/**
 * A call refused for its params that carried none: the operation's own params
 * go inside `params`, which a model easily leaves out (it then repeats the same
 * call). The refusal shows the call's shape with them in place.
 */
function withParamsShape(
  err: ApiConnectorError,
  connection: string,
  operation: string,
  params: unknown,
): ApiConnectorError {
  if (err.code !== "invalid_params") return err
  if (isRecord(params) && Object.keys(params).length > 0) return err
  return new ApiConnectorError(
    err.code,
    `${err.message} This call carried no "params": an operation's own params go inside it, as in ${JSON.stringify({ connection, operation, params: { "<param>": "<value>" } })}.`,
  )
}

function connectorErrorJson(err: ApiConnectorError): string {
  // `status` is the tool error's own HTTP class (executeTool reads it); the
  // API's answer, when there was one, rides as `upstreamStatus`.
  return JSON.stringify({
    error: {
      code: err.code,
      message: err.message,
      retryable: CORRECTABLE_ERRORS.has(err.code),
      status: API_CONNECTOR_ERROR_HTTP_STATUS[err.code],
      ...(err.upstreamStatus !== undefined ? { upstreamStatus: err.upstreamStatus } : {}),
    },
  })
}

/** Codes a test call answers as a refused request rather than as a test result. */
const TEST_REQUEST_ERRORS = new Set([
  "write_not_testable",
  "unknown_connection",
  "unknown_operation",
  "invalid_params",
  "demo_restricted",
])

function errorJson(code: "invalid_params" | "unknown_connection", message: string): string {
  return JSON.stringify({ error: { code, message, status: API_CONNECTOR_ERROR_HTTP_STATUS[code] } })
}

/** A test that reached the API (or tried to) and did not get a page back. */
async function failedTestResult(
  orgId: string,
  identifier: string,
  operation: string,
  err: ApiConnectorError,
): Promise<Record<string, unknown>> {
  const status = err.upstreamStatus ?? null
  const hints: string[] = []
  if (status !== null && status >= 400 && status < 500) {
    const op = await resolveConnectorOperation(orgId, identifier, operation, "test")
      .then((r) => r.operation)
      .catch(() => null)
    if (op?.kind === "read" && op.method === "POST" && op.body === undefined) {
      hints.push(
        `${operation} sends no body: a search endpoint usually needs a JSON body (filters, properties, a limit). Read connector_adapter_reference section search-body and the API's docs, add body, save again.`,
      )
    }
    if (status === 401 || status === 403) {
      hints.push(
        "The API refused the credentials or their permissions: check the auth type and header, or ask the person to enter the credentials again.",
      )
    }
  }
  return {
    ok: false,
    result: "FAILED",
    connection: identifier,
    operation,
    status,
    code: err.code,
    message: err.message,
    ...(err.upstreamBody ? { vendorError: wrapExternalContent(err.upstreamBody) } : {}),
    next: [
      "The test FAILED: the connection does not work yet. Do not tell the person it is verified or active.",
      ...(err.upstreamBody ? ["Read vendorError (the API's own words) for why."] : []),
      ...hints,
      "Fix the adapter with connector_adapter_save, then run connector_adapter_test again.",
    ].join(" "),
  }
}

/** An id an external API returned, fit to be passed on as a value (to a later step via
 *  `@ref:<approval>:record_id`). Anything else from the vendor is never passed through. */
const SAFE_RECORD_ID = /^[A-Za-z0-9._:@-]{1,128}$/

/** The `record_id` of a write: the `id` field of the first returned item, when it is a
 *  safe id; else null with `record_id_note` saying why. */
export function writeRecordId(items: readonly unknown[]): {
  record_id: string | null
  record_id_note?: string
} {
  const first = items[0]
  const id = isRecord(first) ? first.id : undefined
  const asText = typeof id === "number" && Number.isFinite(id) ? String(id) : id
  if (typeof asText === "string" && SAFE_RECORD_ID.test(asText)) return { record_id: asText }
  const why =
    items.length === 0
      ? "the write returned no record"
      : id === undefined
        ? "the operation's returned fields include no `id`"
        : "the returned `id` is not a plain id (letters, digits and . _ : @ -, at most 128 characters)"
  return {
    record_id: null,
    record_id_note:
      `No record id: ${why}. A later step cannot use this record's id; to make it available, an ` +
      "admin adds `id` to this write operation's `fields` in the adapter (connector_adapter_save).",
  }
}

export function createApiConnectorBridgeExtension(
  ctx: BridgeExtensionContext,
): Record<string, BridgeExtensionMethod> {
  const actor = { orgId: ctx.orgId, userId: ctx.userId, actorType: ctx.actorType }

  async function call(
    paramsJson: string,
    mode: Exclude<ConnectorCallMode, "test">,
  ): Promise<string> {
    const raw: unknown = JSON.parse(paramsJson)
    const p = isRecord(raw) ? raw : {}
    if (typeof p.connection !== "string" || typeof p.operation !== "string") {
      return errorJson(
        "invalid_params",
        "connection and operation are required (see connector_list_operations).",
      )
    }
    const params = isRecord(p.params) ? p.params : {}
    try {
      const r = await runConnectorOperation({
        actor,
        identifier: p.connection,
        operation: p.operation,
        params,
        mode,
        ...(mode === "write" ? { approvedTarget: parseWriteTarget(p.target) } : {}),
        signal: ctx.signal,
      })
      return JSON.stringify({
        connection: r.connection,
        operation: r.operation,
        status: r.status,
        count: r.items.length,
        truncated: r.truncated,
        ...(mode === "write" ? writeRecordId(r.items) : {}),
        items: wrapExternalContent(JSON.stringify(r.items)),
      })
    } catch (err) {
      if (err instanceof ApiConnectorError) {
        return connectorErrorJson(withParamsShape(err, p.connection, p.operation, p.params))
      }
      throw err
    }
  }

  function identifierOf(p: Record<string, unknown>): string | null {
    return typeof p.identifier === "string" && p.identifier.length > 0 ? p.identifier : null
  }

  return {
    connector_list_operations: async (paramsJson: string): Promise<string> => {
      const raw: unknown = JSON.parse(paramsJson)
      const only = isRecord(raw) && typeof raw.connection === "string" ? raw.connection : null
      const rows = (await listAdapterRows(ctx.orgId)).filter(
        (r) => only === null || r.identifier === only,
      )
      if (only !== null && rows.length === 0) {
        return errorJson("unknown_connection", `No API connection named "${only}".`)
      }
      return JSON.stringify({
        connections: rows.map((r) => ({
          connection: r.identifier,
          name: r.adapter.name,
          ...(r.adapter.description ? { description: r.adapter.description } : {}),
          operations: operationSummaries(r.adapter),
          ...(r.warnings.length > 0 ? { warnings: r.warnings } : {}),
        })),
        // None yet: say how one is made, so "no connection" never reads as
        // "cannot be connected".
        ...(rows.length === 0
          ? {
              next: "No API connection exists yet. An administrator connects a system (a CRM, an ERP, any HTTP API with a key or token): read the guide with api-connector__connector_adapter_reference, save an adapter with api-connector__connector_adapter_save (a person approves it), then ask for its credentials with kernel__request_secret.",
            }
          : {}),
      })
    },
    // Stage-time check of a write, before its approval is parked: everything
    // knowable without calling the API (the connection, the operation and its
    // kind, the params against its schema, stored credentials), so an approver
    // is never handed a write that can only fail. No network. On success it
    // pins the canonical target (method, host, rendered path, adapter hash)
    // onto the staged call: the approval card shows it, and execution refuses
    // when the adapter or the rendered request no longer match it.
    connector_write_validate: async (paramsJson: string): Promise<string> => {
      const raw: unknown = JSON.parse(paramsJson)
      const p = isRecord(raw) ? raw : {}
      const refuse = (code: string, message: string) =>
        JSON.stringify({ error: { code, message, retryable: CORRECTABLE_ERRORS.has(code) } })
      if (typeof p.connection !== "string" || typeof p.operation !== "string") {
        return refuse(
          "invalid_params",
          "connection and operation are required (see connector_list_operations).",
        )
      }
      let target: ReturnType<typeof writeTarget>
      try {
        const { row, operation } = await resolveConnectorOperation(
          ctx.orgId,
          p.connection,
          p.operation,
          "write",
        )
        target = writeTarget(row.adapter, operation, isRecord(p.params) ? p.params : {})
      } catch (err) {
        if (err instanceof ApiConnectorError) {
          const shaped = withParamsShape(err, p.connection, p.operation, p.params)
          return refuse(shaped.code, shaped.message)
        }
        throw err
      }
      const credentials = await resolveConnectionCredentials(ctx.orgId, ctx.userId, p.connection)
      if (!credentials) {
        return refuse("not_configured", `The connection "${p.connection}" has no credentials yet.`)
      }
      return JSON.stringify({ ok: true, pinnedParams: { target } })
    },
    connector_read: (paramsJson: string) => call(paramsJson, "read"),
    connector_write: (paramsJson: string) => call(paramsJson, "write"),

    // --- Adapter authoring reads (scope api-connector:admin, checked before the handler) ---

    connector_adapter_get: async (paramsJson: string): Promise<string> => {
      const raw: unknown = JSON.parse(paramsJson)
      const p = isRecord(raw) ? raw : {}
      const identifier = identifierOf(p)
      if (!identifier) return errorJson("invalid_params", "identifier is required.")
      const page = typeof p.operationsPage === "number" ? p.operationsPage : 1
      return JSON.stringify(await readStoredAdapter(ctx.orgId, identifier, page))
    },
    connector_adapter_versions: async (paramsJson: string): Promise<string> => {
      const raw: unknown = JSON.parse(paramsJson)
      const identifier = identifierOf(isRecord(raw) ? raw : {})
      if (!identifier) return errorJson("invalid_params", "identifier is required.")
      return JSON.stringify(await listVersionsWithTargets(ctx.orgId, identifier))
    },
    connector_adapter_reference: async (paramsJson: string): Promise<string> => {
      const raw: unknown = JSON.parse(paramsJson)
      const p = isRecord(raw) ? raw : {}
      return JSON.stringify(readReference(typeof p.section === "string" ? p.section : undefined))
    },
    // One page of one READ operation with the stored credentials: the
    // author's check that an adapter answers. Writes are refused before any
    // request (write_not_testable). The items are vendor data: fenced.
    connector_adapter_test: async (paramsJson: string): Promise<string> => {
      const raw: unknown = JSON.parse(paramsJson)
      const p = isRecord(raw) ? raw : {}
      const identifier = identifierOf(p)
      if (!identifier || typeof p.operation !== "string") {
        return errorJson("invalid_params", "identifier and operation are required.")
      }
      try {
        const r = await runConnectorOperation({
          actor,
          identifier,
          operation: p.operation,
          params: isRecord(p.params) ? p.params : {},
          mode: "test",
          maxPages: 1,
          budgetMs: API_CONNECTOR_REQUEST_TIMEOUT_MS + 2_000,
          signal: ctx.signal,
        })
        return JSON.stringify({
          ok: true,
          connection: identifier,
          operation: r.operation,
          status: r.status,
          count: r.items.length,
          truncated: r.truncated,
          ms: r.ms,
          items: wrapExternalContent(JSON.stringify(r.items)),
        })
      } catch (err) {
        if (!(err instanceof ApiConnectorError)) throw err
        if (TEST_REQUEST_ERRORS.has(err.code)) return connectorErrorJson(err)
        // The API answered badly or could not be reached: a test RESULT the
        // author reads to fix the adapter, not a failed tool call. It says
        // FAILED in words, carries the API's own error text (vendor text,
        // fenced) and what to do next, so a weak model neither calls the
        // connection verified nor stalls on a bare status.
        return JSON.stringify(await failedTestResult(ctx.orgId, identifier, p.operation, err))
      }
    },
  }
}
