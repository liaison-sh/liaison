// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The API connector's route contract: the request and response shapes of the
 * kernel routes mounted at `/api/api-connector` and of the multiInstance
 * credentials post. The API routes build their bodies with these types and
 * the web client reads them, so the two cannot drift.
 *
 * This module has no runtime dependency (type-only imports, constants),
 * so a browser bundle importing `@liaison/api-connector-core/contract` pulls
 * in neither the validator nor the YAML parser.
 *
 *   GET    /adapters                  -> AdaptersListResponse          (api-connector:read)
 *   PUT    /adapters/:identifier      -> AdapterPutResponse | 422 InvalidAdapterResponse
 *   DELETE /adapters/:identifier      -> AdapterDeleteResponse          (api-connector:admin)
 *   POST   /adapters/:identifier/test -> TestOperationResponse | ConnectorErrorResponse
 *   GET    /customer?email=&phone=&domain= -> CustomerLookupResponse    (api-connector:read)
 *   POST   /api/connections/api-connector/api/credentials  (generic route, multiInstance)
 */
import type { ProjectedObject } from "./project"
import type { AdapterIssue, AuthType, OperationParams, RoleName } from "./schema"

export type { ProjectedObject, ProjectedValue, Scalar } from "./project"
export type { AdapterIssue, AuthType, OperationParams, ParamSpec, RoleName } from "./schema"

/** The app and the manifest connection every api-connector credential is stored under. */
export const API_CONNECTOR_APP = "api-connector"
export const API_CONNECTOR_CONNECTION = "api"

/**
 * A connection slug: lowercase letters, digits and dashes, 1 to 40 long. The
 * kernel's multiInstance identifier rule (connections service), restated for
 * clients; a route test keeps the two equal.
 */
export const CONNECTION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * The only email shape the connector acts on: a plain addr-spec (no quoted
 * local part, no comment, no display name). The customer resolver, the
 * agent's customer context and the `email` param format all use it, so an
 * address carrying text is never looked up nor shown to the agent.
 */
export const STRICT_EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/

export function isStrictEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 320 && STRICT_EMAIL_RE.test(value)
}

/** The credential fields each auth type needs (all required). */
export const AUTH_CREDENTIAL_FIELDS: Record<AuthType, readonly string[]> = {
  apiKey: ["apiKey"],
  bearer: ["token"],
  basic: ["username", "password"],
  oauth2ClientCredentials: ["clientId", "clientSecret"],
}

export type ConnectionStatus = "ok" | "needs_credentials" | "error"

/** The adapter's auth shape as the routes expose it: never a secret, never the token URL. */
export interface ConnectionAuthSummary {
  type: AuthType
  /** apiKey only. */
  in?: "header" | "query"
  /** apiKey only: the header or query parameter name. */
  name?: string
}

export interface ConnectionOperationSummary {
  name: string
  kind: "read" | "write"
  role?: RoleName
  description: string
  /** The operation's params (a JSON Schema draft 2020-12 subset). */
  params: OperationParams
  /** The allow-listed field paths, in the adapter's order. */
  fields: string[]
}

/** One connection, as `GET /adapters` lists it and `PUT /adapters/:identifier` returns it. */
export interface ConnectionSummary {
  identifier: string
  name: string
  adapterId: string
  adapterVersion: string
  baseUrl: string
  auth: ConnectionAuthSummary
  roles: RoleName[]
  operations: ConnectionOperationSummary[]
  status: ConnectionStatus
}

/** Why an org's connections cannot be changed: a demo workspace ships pre-configured ones. */
export type ConnectionsReadOnlyReason = "demo"

/**
 * `GET /adapters`: the org's connections, and whether this org may change
 * them. The settings page renders its controls from `readOnly`, never from
 * any other fetch, so a first visit is read-only from its first paint.
 */
export interface ConnectionList {
  connections: ConnectionSummary[]
  /** True when nothing can be added, replaced, deleted or given credentials (the server refuses those too). */
  readOnly: boolean
  /** Set when `readOnly` is. */
  readOnlyReason?: ConnectionsReadOnlyReason
}

export interface AdaptersListResponse {
  data: ConnectionList
}

/** A saved connection, and whether the save deleted its credentials (the credential target moved). */
export interface AdapterSaveSummary extends ConnectionSummary {
  credentialsCleared: boolean
}

export interface AdapterPutResponse {
  data: AdapterSaveSummary
}

/** One kept previous adapter of a connection (`GET /adapters/:identifier/versions`). */
export interface AdapterVersionView {
  id: string
  adapterVersion: string
  /** The kept document's name, null when it no longer validates. */
  name: string | null
  savedBy: string | null
  savedByName: string | null
  savedAt: string
  /** Its credential target in words (origin, auth type, where the secret goes). */
  target: string | null
  /** Restoring it moves the credential target, which deletes the stored credentials. */
  targetDiffers: boolean
}

export interface AdapterVersionList {
  identifier: string
  current: { adapterVersion: string; target: string } | null
  /** Newest first, at most 20. */
  versions: AdapterVersionView[]
}

export interface AdapterVersionsResponse {
  data: AdapterVersionList
}

/** `POST /adapters/:identifier/restore`. */
export interface AdapterRestoreRequest {
  versionId: string
  /** Required when the restore moves the credential target while credentials are stored. */
  confirmCredentialWipe?: boolean
}

export interface AdapterRestoreResponse {
  data: AdapterSaveSummary
}

/** 409 of a save or restore that would delete stored credentials without the confirmation. */
export interface CredentialWipeRequiredResponse {
  error: {
    code: "confirm_credential_wipe"
    message: string
    priorTarget: string
    newTarget: string
    /** The same two targets, where the web client reads an error's structured part. */
    details: { priorTarget: string; newTarget: string }
  }
}

export interface AdapterDeleteResponse {
  data: { identifier: string; removed: true }
}

/** 422 body of `PUT /adapters/:identifier`: every issue at its path. */
export interface InvalidAdapterResponse {
  error: { code: "invalid_adapter"; message: string; issues: AdapterIssue[] }
}

/** The stable error codes a connector call reports. */
export type ApiConnectorErrorCode =
  | "upstream_status"
  | "timeout"
  | "too_large"
  | "invalid_response"
  | "host_refused"
  | "not_configured"
  | "invalid_params"
  | "demo_restricted"
  | "unknown_connection"
  | "unknown_operation"
  | "write_not_testable"
  | "write_not_allowed"

/** A refused connector request (`/test` answers these as HTTP errors). */
export interface ConnectorErrorResponse {
  error: { code: ApiConnectorErrorCode; message: string; status?: number }
}

export interface TestOperationRequest {
  operation: string
  params: Record<string, unknown>
}

/** The outcome of a read-only test call: the upstream answered, or it failed with a code. */
export type TestOperationResult =
  | { ok: true; status: number; items: ProjectedObject[]; truncated: boolean; ms: number }
  | {
      ok: false
      status: number | null
      code: ApiConnectorErrorCode
      message: string
      ms: number
    }

export interface TestOperationResponse {
  data: TestOperationResult
}

/**
 * How a customer record was found. `domain` is a company match, not the
 * person: the card labels it, and the agent's context never uses it.
 */
export type CustomerMatchKey = "email" | "phone" | "domain"

/** One customer summary value, as the record typed it (a list of scalars is joined into a string). */
export type CustomerSummaryValue = string | number | boolean

export interface CustomerMatch {
  /** The connection identifier the match came from. */
  connection: string
  /** The connection's display name (the system the card names). */
  connectionName: string
  matchedBy: CustomerMatchKey
  /** The record's allow-listed fields by dotted path, with their types kept. */
  summary: Record<string, CustomerSummaryValue>
  /**
   * The ISO 4217 code of the record's own `currency` (or `currency_code`)
   * field, upper-cased: the card formats the summary's amounts in it. Absent
   * when the record names none; an amount then prints as a plain number.
   */
  currency?: string
  orders?: ProjectedObject[]
  invoices?: ProjectedObject[]
  deals?: ProjectedObject[]
}

export interface CustomerConnectionError {
  connection: string
  connectionName: string
  code: string
}

export interface CustomerResolution {
  matches: CustomerMatch[]
  /** True when at least one connection fills customer.lookup. */
  configured: boolean
  /** The connections that were searched, to name them on "no match". */
  connections: { identifier: string; name: string }[]
  errors: CustomerConnectionError[]
}

export interface CustomerLookupResponse {
  data: CustomerResolution
}
