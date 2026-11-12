// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ctx.api.*`: the platform-held HTTP API connections (this directory) for
 * app code, on every executor. An app declares one with a credentials
 * connection carrying an `api` block (manifest-schema.ts); each of its
 * accounts is an adapter document (the API's base URL, its auth type and a
 * fixed list of named operations) plus the credentials that auth type needs.
 *
 *  - Only the app that declares the connection reaches these methods, and
 *    every one re-checks the caller's own scopes against the block's scopes
 *    (read, write, admin): app code never decides who may read a record,
 *    change an adapter or see a connection list.
 *  - The credentials are resolved and placed here, never returned: no secret
 *    crosses the bridge, so the methods are safe on Workers.
 *  - Every method takes JSON text and answers JSON text. They run without a
 *    database transaction (declared tx-less in rpc-bridge.ts: an upstream call
 *    can take seconds and must not pin a pooled connection), so every read and
 *    the audit row go through the privileged pool, scoped to the org.
 *
 * Output: operation results are external content, so an agent-facing item
 * list is returned fenced (`wrapExternalContent`); the operation catalogue is
 * the org admin's own adapter text and is returned as data. Failures come back
 * as `{ error: { code, message } }`, codes from the transport, never a body or
 * a credential.
 */

import {
  type Adapter,
  type AdapterIssue,
  type Operation,
  operationSummaries,
  ROLE_REGISTRY,
} from "@liaison/api-connector-core"
import type { ConnectionStatus, ConnectionSummary } from "@liaison/api-connector-core/contract"
import { wrapExternalContent } from "~/lib/external-content"
import { isRecord } from "~/lib/guards"
import { UUID_RE } from "~/lib/uuid"
import { participantEmail } from "~/modules/agent/context/customer-context"
import { MULTI_INSTANCE_IDENTIFIER_RE } from "~/modules/apps/connections/service"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { isDemoEgressRestricted } from "~/modules/demo/demo-egress"
import { hasScope } from "~/modules/permissions/permissions"
import { parseAdapterDocument, validateAdapterDocument } from "./adapter-policy"
import {
  describeTarget,
  listVersionsWithTargets,
  readReference,
  readStoredAdapter,
} from "./authoring"
import { invalidateConnectionCaches } from "./cache"
import { resolveCustomer } from "./customer"
import { type ApiConn, apiConnectionOf } from "./declarations"
import { demoChangeRefusal } from "./registrations"
import {
  type ConnectorCallMode,
  parseWriteTarget,
  resolveConnectorOperation,
  runConnectorOperation,
  writeTarget,
} from "./service"
import {
  AdapterChangedError,
  type AdapterSavePlan,
  CredentialsChangedError,
  credentialStatuses,
  deleteConnection,
  getAdapterVersion,
  listAdapterRows,
  planAdapterSave,
  resolveConnectionCredentials,
  upsertAdapterRow,
} from "./store"
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
  conn: ApiConn,
  identifier: string,
  operation: string,
  err: ApiConnectorError,
): Promise<Record<string, unknown>> {
  const status = err.upstreamStatus ?? null
  const hints: string[] = []
  if (status !== null && status >= 400 && status < 500) {
    const op = await resolveConnectorOperation(conn, identifier, operation, "test")
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

/**
 * The operation `config verify` probes a connection with: a READ operation
 * that takes no required params and is not a role answering "at least one
 * of" params (`customer.lookup`, `stock.check`): the connector refuses such a
 * role called without one, since with no filter it would page through every
 * record. Undefined when there is none (the connection is reported skipped):
 * give the adapter a cheap param-less list.
 */
export function verifyProbeOperation(operations: readonly Operation[]): Operation | undefined {
  return operations.find(
    (o) =>
      o.kind === "read" &&
      (o.params.required ?? []).length === 0 &&
      !(o.role && ROLE_REGISTRY[o.role].oneOfParams.length > 0),
  )
}

type ApiBridgeContext = Pick<
  BridgeContext,
  | "appName"
  | "orgId"
  | "userId"
  | "actorType"
  | "manifest"
  | "callerScopes"
  | "bridgeOptions"
  | "inheritedActor"
>

/** The public summary of one connection (no credential, ever). */
export function summarizeConnection(
  identifier: string,
  adapter: Adapter,
  status: ConnectionStatus,
): ConnectionSummary {
  const auth = adapter.auth
  return {
    identifier,
    name: adapter.name,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    baseUrl: adapter.baseUrl,
    auth: {
      type: auth.type,
      ...(auth.type === "apiKey" ? { in: auth.in, name: auth.name } : {}),
    },
    roles: adapter.operations.flatMap((o) => (o.role ? [o.role] : [])),
    operations: operationSummaries(adapter),
    status,
  }
}

function invalidAdapterJson(issues: AdapterIssue[]): string {
  return JSON.stringify({
    error: {
      code: "invalid_adapter",
      message: `The adapter is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      issues,
      status: 422,
    },
  })
}

function refusalJson(code: string, message: string, status: number): string {
  return JSON.stringify({ error: { code, message, status } })
}

function parse(json: unknown): Record<string, unknown> {
  if (typeof json !== "string" || json === "") return isRecord(json) ? json : {}
  try {
    const raw: unknown = JSON.parse(json)
    return isRecord(raw) ? raw : {}
  } catch {
    return {}
  }
}

/**
 * The `api_*` methods. Absent (an empty set) for an app that declares no `api`
 * connection, so no other app's sandbox ever sees them.
 */
export function createApiConnectionMethods(
  ctx: ApiBridgeContext,
): Record<string, (paramsJson?: unknown) => Promise<string>> {
  // Any app that declares an API connection reaches these, for its own
  // connection only: the store is keyed by the calling app's name.
  const api = apiConnectionOf(ctx.manifest as Parameters<typeof apiConnectionOf>[0])
  if (!api) return {}
  const decl = api.decl
  const orgId = ctx.orgId
  const conn: ApiConn = { orgId, app: ctx.appName, connection: api.connection }
  const actor = { orgId, userId: ctx.userId, actorType: ctx.actorType }
  const signal = ctx.bridgeOptions?.signal
  // A run the host started without a caller (an event, a provisioning run as
  // the app itself) carries the app's own scopes.
  const scopes = (): string[] => ctx.callerScopes ?? ctx.manifest.scopes ?? []
  const lacks = (scope: string): string | null =>
    hasScope(scope, scopes())
      ? null
      : refusalJson(
          "forbidden",
          `This needs the ${scope} scope, which the caller does not hold.`,
          403,
        )

  async function call(paramsJson: unknown, mode: Exclude<ConnectorCallMode, "test">) {
    const denied = lacks(mode === "write" ? decl!.writeScope : decl!.readScope)
    if (denied) return denied
    const p = parse(paramsJson)
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
        conn,
        identifier: p.connection,
        operation: p.operation,
        params,
        mode,
        ...(mode === "write" ? { approvedTarget: parseWriteTarget(p.target) } : {}),
        ...(signal ? { signal } : {}),
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
    return typeof p.identifier === "string" && MULTI_INSTANCE_IDENTIFIER_RE.test(p.identifier)
      ? p.identifier
      : null
  }

  async function summaryOf(identifier: string, adapter: Adapter): Promise<ConnectionSummary> {
    const statuses = await credentialStatuses(conn)
    return summarizeConnection(identifier, adapter, statuses.get(identifier) ?? "needs_credentials")
  }

  /** Write a planned save; a stored document or credentials changed since the plan is a refusal. */
  async function savePlanned(
    identifier: string,
    plan: AdapterSavePlan,
  ): Promise<{ credentialsCleared: boolean } | { refused: string }> {
    try {
      // The person who saved it; none for a run as the app itself (provisioning).
      const { credentialsCleared } = await upsertAdapterRow(
        conn,
        identifier,
        plan.adapter,
        UUID_RE.test(ctx.userId) ? ctx.userId : null,
        { expectPriorHash: plan.priorHash, expectCredentialsPresent: plan.credentialsPresent },
      )
      await invalidateConnectionCaches(conn, identifier)
      return { credentialsCleared }
    } catch (err) {
      if (err instanceof AdapterChangedError || err instanceof CredentialsChangedError) {
        return { refused: refusalJson("adapter_changed", err.message, 409) }
      }
      throw err
    }
  }

  function wipeRefusal(
    action: "Saving this adapter" | "Restoring this version",
    plan: { priorTarget: string | null; newTarget: string },
  ): string {
    const priorTarget = describeTarget(plan.priorTarget)
    const newTarget = describeTarget(plan.newTarget)
    return JSON.stringify({
      error: {
        code: "confirm_credential_wipe",
        message: `${action} moves the credential target from ${priorTarget} to ${newTarget}, which deletes the stored credentials.`,
        priorTarget,
        newTarget,
        status: 409,
      },
    })
  }

  return {
    // --- Agent tools ---------------------------------------------------------

    api_listOperations: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.readScope)
      if (denied) return denied
      const raw = parse(paramsJson)
      const only = typeof raw.connection === "string" ? raw.connection : null
      const rows = (await listAdapterRows(conn)).filter(
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
              next: `No API connection exists yet. An administrator connects a system (a CRM, an ERP, any HTTP API with a key or token): read the guide with ${conn.app}__connector_adapter_reference, save an adapter with ${conn.app}__connector_adapter_save (a person approves it), then ask for its credentials with kernel__request_secret.`,
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
    api_writeValidate: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.writeScope)
      if (denied) return denied
      const p = parse(paramsJson)
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
          conn,
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
      const credentials = await resolveConnectionCredentials(conn, p.connection)
      if (!credentials) {
        return refuse("not_configured", `The connection "${p.connection}" has no credentials yet.`)
      }
      return JSON.stringify({ ok: true, pinnedParams: { target } })
    },
    api_read: async (paramsJson?: unknown): Promise<string> => call(paramsJson, "read"),
    api_write: async (paramsJson?: unknown): Promise<string> => call(paramsJson, "write"),

    // --- Adapter authoring (admin) --------------------------------------------

    api_adapterGet: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const p = parse(paramsJson)
      const identifier = identifierOf(p)
      if (!identifier) return errorJson("invalid_params", "identifier is required.")
      const page = typeof p.operationsPage === "number" ? p.operationsPage : 1
      return JSON.stringify(await readStoredAdapter(conn, identifier, page))
    },
    api_adapterVersions: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const identifier = identifierOf(parse(paramsJson))
      if (!identifier) return errorJson("invalid_params", "identifier is required.")
      return JSON.stringify(await listVersionsWithTargets(conn, identifier))
    },
    api_adapterReference: async (paramsJson?: unknown): Promise<string> => {
      const p = parse(paramsJson)
      return JSON.stringify(readReference(typeof p.section === "string" ? p.section : undefined))
    },
    // One page of one READ operation with the stored credentials: the
    // author's check that an adapter answers. Writes are refused before any
    // request (write_not_testable). The agent's items are vendor data:
    // fenced; the settings screen (`raw: true`) shows them as they are.
    api_adapterTest: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const p = parse(paramsJson)
      const identifier = identifierOf(p)
      if (!identifier || typeof p.operation !== "string") {
        return errorJson("invalid_params", "identifier and operation are required.")
      }
      const raw = p.raw === true
      const started = Date.now()
      try {
        const r = await runConnectorOperation({
          actor,
          conn,
          identifier,
          operation: p.operation,
          params: isRecord(p.params) ? p.params : {},
          mode: "test",
          maxPages: 1,
          budgetMs: API_CONNECTOR_REQUEST_TIMEOUT_MS + 2_000,
          ...(signal ? { signal } : {}),
        })
        if (raw) {
          return JSON.stringify({
            ok: true,
            status: r.status,
            items: r.items,
            truncated: r.truncated,
            ms: r.ms,
          })
        }
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
        // The settings screen reads a demo org's refusal as a test result.
        const refused = raw ? err.code !== "demo_restricted" : true
        if (refused && TEST_REQUEST_ERRORS.has(err.code)) return connectorErrorJson(err)
        if (raw) {
          return JSON.stringify({
            ok: false,
            status: err.upstreamStatus ?? null,
            code: err.code,
            message: err.message,
            ms: Date.now() - started,
          })
        }
        // The API answered badly or could not be reached: a test RESULT the
        // author reads to fix the adapter, not a failed tool call. It says
        // FAILED in words, carries the API's own error text (vendor text,
        // fenced) and what to do next, so a weak model neither calls the
        // connection verified nor stalls on a bare status.
        return JSON.stringify(await failedTestResult(conn, identifier, p.operation, err))
      }
    },

    /**
     * `config verify`: one page of `verifyProbeOperation`'s pick per connection,
     * through the same service the tools use. Per connection PASS (identity),
     * SKIPPED (no such operation, or no credentials) or FAIL (the error).
     */
    api_verify: async (): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const [rows, statuses] = await Promise.all([listAdapterRows(conn), credentialStatuses(conn)])
      const results: Array<Record<string, unknown>> = []
      for (const row of rows) {
        const id = row.identifier
        if ((statuses.get(id) ?? "needs_credentials") !== "ok") {
          results.push({ connection: id, status: "SKIPPED", reason: "no credentials stored" })
          continue
        }
        const op = verifyProbeOperation(row.adapter.operations)
        if (!op) {
          results.push({
            connection: id,
            status: "SKIPPED",
            reason: "no read operation without required params",
          })
          continue
        }
        try {
          const r = await runConnectorOperation({
            actor,
            conn,
            identifier: id,
            operation: op.name,
            params: {},
            mode: "test",
            maxPages: 1,
            ...(signal ? { signal } : {}),
          })
          results.push({
            connection: id,
            status: "PASS",
            identity: `${op.name}: HTTP ${r.status}, ${r.items.length} item(s)`,
          })
        } catch (err) {
          if (!(err instanceof ApiConnectorError)) throw err
          results.push({
            connection: id,
            status: "FAIL",
            error: err.message,
            ...(err.upstreamStatus !== undefined ? { httpStatus: err.upstreamStatus } : {}),
          })
        }
      }
      return JSON.stringify({ results })
    },

    // --- Settings screen (the app's own UI) -------------------------------------

    /** Every connection with its auth shape, operations and credential status. */
    api_connections: async (): Promise<string> => {
      const denied = lacks(decl.readScope)
      if (denied) return denied
      const [rows, statuses, demo] = await Promise.all([
        listAdapterRows(conn),
        credentialStatuses(conn),
        isDemoEgressRestricted(orgId),
      ])
      return JSON.stringify({
        connections: rows.map((r) =>
          summarizeConnection(
            r.identifier,
            r.adapter,
            statuses.get(r.identifier) ?? "needs_credentials",
          ),
        ),
        ...(rows.some((r) => r.warnings.length > 0)
          ? {
              warnings: Object.fromEntries(
                rows.filter((r) => r.warnings.length > 0).map((r) => [r.identifier, r.warnings]),
              ),
            }
          : {}),
        readOnly: demo,
        ...(demo ? { readOnlyReason: "demo" as const } : {}),
      })
    },
    /** Check a document (JSON or YAML text, or an object) without saving it. */
    api_validate: async (paramsJson?: unknown): Promise<string> => {
      const p = parse(paramsJson)
      const parsed =
        typeof p.document === "string"
          ? parseAdapterDocument(p.document)
          : validateAdapterDocument(p.document)
      return JSON.stringify(
        parsed.ok
          ? { ok: true, name: parsed.adapter.name, operations: parsed.adapter.operations.length }
          : { ok: false, issues: parsed.issues },
      )
    },
    /**
     * What saving a document under `identifier` would do, nothing written (a
     * provisioning dry run): `{ ok, unchanged, created, wipesCredentials,
     * removedOperations }`, or `{ ok: false, issues }`.
     */
    api_adapterPlan: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const p = parse(paramsJson)
      const identifier = identifierOf(p)
      if (!identifier) return errorJson("invalid_params", "identifier is required.")
      const parsed =
        typeof p.document === "string"
          ? parseAdapterDocument(p.document)
          : validateAdapterDocument(p.document)
      if (!parsed.ok) return JSON.stringify({ ok: false, issues: parsed.issues })
      const plan = await planAdapterSave(conn, identifier, parsed.adapter)
      if (!plan.ok) return JSON.stringify({ ok: false, issues: plan.issues })
      return JSON.stringify({
        ok: true,
        name: plan.adapter.name,
        unchanged: plan.unchanged,
        created: plan.priorHash === null,
        wipesCredentials: plan.wipesCredentials,
        removedOperations: plan.removedOperations,
      })
    },
    /**
     * Save an adapter directly (an administrator in the settings screen, or
     * provisioning): the same validation and credential-target rule as the
     * agent's approved save. A change of credential target needs
     * `confirmCredentialWipe`; `unchanged` when the stored document is the same.
     */
    api_adapterPut: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const p = parse(paramsJson)
      const identifier = identifierOf(p)
      if (!identifier) {
        return refusalJson(
          "invalid_params",
          "identifier must be a lowercase slug (letters, digits, -) of at most 40 characters",
          400,
        )
      }
      const demo = await demoChangeRefusal(orgId)
      if (demo) return demo
      const parsed =
        typeof p.document === "string"
          ? parseAdapterDocument(p.document)
          : validateAdapterDocument(p.document)
      if (!parsed.ok) return invalidAdapterJson(parsed.issues)
      const plan = await planAdapterSave(conn, identifier, parsed.adapter)
      if (!plan.ok) return invalidAdapterJson(plan.issues)
      if (plan.wipesCredentials && p.confirmCredentialWipe !== true) {
        return wipeRefusal("Saving this adapter", plan)
      }
      if (p.skipUnchanged === true && plan.unchanged) {
        return JSON.stringify({ ...(await summaryOf(identifier, plan.adapter)), unchanged: true })
      }
      const saved = await savePlanned(identifier, plan)
      if ("refused" in saved) return saved.refused
      return JSON.stringify({
        ...(await summaryOf(identifier, plan.adapter)),
        credentialsCleared: saved.credentialsCleared,
      })
    },
    api_adapterRestore: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const p = parse(paramsJson)
      const identifier = identifierOf(p)
      if (!identifier || typeof p.versionId !== "string") {
        return errorJson("invalid_params", "identifier and versionId are required.")
      }
      const demo = await demoChangeRefusal(orgId)
      if (demo) return demo
      const version = await getAdapterVersion(conn, identifier, p.versionId)
      if (!version) {
        return refusalJson(
          "unknown_version",
          `No kept version ${p.versionId} of "${identifier}".`,
          404,
        )
      }
      const plan = await planAdapterSave(conn, identifier, version.adapter)
      if (!plan.ok) return invalidAdapterJson(plan.issues)
      if (plan.wipesCredentials && p.confirmCredentialWipe !== true) {
        return wipeRefusal("Restoring this version", plan)
      }
      const saved = await savePlanned(identifier, plan)
      if ("refused" in saved) return saved.refused
      return JSON.stringify({
        ...(await summaryOf(identifier, plan.adapter)),
        credentialsCleared: saved.credentialsCleared,
      })
    },
    /** Remove a connection: its adapter, kept versions and credentials. */
    api_adapterDelete: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.adminScope)
      if (denied) return denied
      const identifier = identifierOf(parse(paramsJson))
      if (!identifier) return errorJson("invalid_params", "identifier is required.")
      const demo = await demoChangeRefusal(orgId)
      if (demo) return demo
      const removed = await deleteConnection(conn, identifier)
      await invalidateConnectionCaches(conn, identifier)
      if (!removed) {
        return refusalJson("not_found", `No API connection named "${identifier}".`, 404)
      }
      return JSON.stringify({ identifier, removed: true })
    },
    /**
     * Who a person is in the org's own systems (the connections that fill
     * `customer.lookup`): by email, phone or company domain, or by the external
     * participant of a ticket or mail conversation the caller can see (read
     * under the caller's own access, the rule the agent's customer context uses).
     */
    api_customer: async (paramsJson?: unknown): Promise<string> => {
      const denied = lacks(decl.readScope)
      if (denied) return denied
      const p = parse(paramsJson)
      const text = (v: unknown, max: number) =>
        typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined
      let email = text(p.email, 320)
      const phone = text(p.phone, 40)
      const domain = text(p.domain, 253)
      if (domain !== undefined && !/^[A-Za-z0-9.-]*$/.test(domain)) {
        return refusalJson("invalid_params", "domain must be a domain name", 400)
      }
      const view =
        typeof p.ticketId === "string"
          ? { tabType: "tickets:ticket", entityId: p.ticketId }
          : typeof p.mailConversationId === "string"
            ? { tabType: "mail:conversation", entityId: p.mailConversationId }
            : null
      if (view) {
        const person = ctx.inheritedActor.actorType === "user" ? ctx.inheritedActor : null
        if (!person) return JSON.stringify({ email: null, matches: [], errors: [] })
        email = (await participantEmail(view, person).catch(() => null)) ?? undefined
        if (!email) return JSON.stringify({ email: null, matches: [], errors: [] })
      }
      if (!email && !phone && !domain) {
        return refusalJson("invalid_params", "email, phone or domain is required", 400)
      }
      const result = await resolveCustomer({
        actor: { orgId, userId: ctx.userId, actorType: "user" },
        conn,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(domain ? { domain } : {}),
        ...(signal ? { signal } : {}),
      })
      return JSON.stringify(view ? { ...result, email } : result)
    },
  }
}
