// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The api-connector client: one function per route, and the only place the
// web app names those routes. The settings page and the customer card call
// these; tests fake the ApiClient underneath.

import {
  type AdapterIssue,
  type AdapterRestoreRequest,
  type AdapterSaveSummary,
  type AdapterVersionList,
  API_CONNECTOR_APP,
  API_CONNECTOR_CONNECTION,
  type ConnectionList,
  type ConnectionSummary,
  type CustomerResolution,
  type TestOperationRequest,
  type TestOperationResult,
} from "@liaison/api-connector-core/contract"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"

const BASE = "/api-connector"

/** The org's connections, and whether this org may change them (a demo org may not). */
export function listConnections(api: ApiClient): Promise<ConnectionList> {
  return api.get<ConnectionList>(`${BASE}/adapters`, { suppressGlobalError: true })
}

export type PutAdapterOutcome =
  | { ok: true; summary: ConnectionSummary }
  | { ok: false; issues: AdapterIssue[] }
  /** The save would delete the stored credentials: resend with `confirmCredentialWipe`. */
  | { ok: false; wipe: { priorTarget: string; newTarget: string } }

function isIssue(value: unknown): value is AdapterIssue {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as AdapterIssue).path === "string" &&
    typeof (value as AdapterIssue).message === "string"
  )
}

/**
 * The body the adapter route takes: a JSON document goes as JSON, anything
 * else as YAML text. The server parses and validates both; the client only
 * decides which content type it is sending.
 */
export function adapterBody(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      // Not valid JSON after all: send it as text and let the server name the problem.
    }
  }
  return new Blob([text], { type: "text/yaml" })
}

/**
 * Create or replace a connection's adapter. A 422 comes back as its issues, a
 * 409 `confirm_credential_wipe` as the two credential targets (the save would
 * delete the stored credentials; `confirmCredentialWipe` sends it anyway);
 * anything else throws.
 */
export async function putAdapter(
  api: ApiClient,
  identifier: string,
  text: string,
  options: { confirmCredentialWipe?: boolean } = {},
): Promise<PutAdapterOutcome> {
  const query = options.confirmCredentialWipe ? "?confirmCredentialWipe=true" : ""
  try {
    const summary = await api.put<ConnectionSummary>(
      `${BASE}/adapters/${encodeURIComponent(identifier)}${query}`,
      adapterBody(text),
      { suppressGlobalError: true },
    )
    return { ok: true, summary }
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === "confirm_credential_wipe") {
      const prior = err.details?.priorTarget
      const next = err.details?.newTarget
      return {
        ok: false,
        wipe: {
          priorTarget: typeof prior === "string" ? prior : "",
          newTarget: typeof next === "string" ? next : "",
        },
      }
    }
    if (err instanceof ApiError && err.status === 422) {
      const raw = err.details?.issues
      const issues = Array.isArray(raw) ? raw.filter(isIssue) : []
      return {
        ok: false,
        issues: issues.length > 0 ? issues : [{ path: "", message: err.message }],
      }
    }
    throw err
  }
}

/** The kept previous adapters of a connection, newest first. */
export function listVersions(api: ApiClient, identifier: string): Promise<AdapterVersionList> {
  return api.get<AdapterVersionList>(
    `${BASE}/adapters/${encodeURIComponent(identifier)}/versions`,
    { suppressGlobalError: true },
  )
}

/** Put a kept adapter back. A restore that would delete credentials needs the confirmation (409 without). */
export function restoreVersion(
  api: ApiClient,
  identifier: string,
  request: AdapterRestoreRequest,
): Promise<AdapterSaveSummary> {
  return api.post<AdapterSaveSummary>(
    `${BASE}/adapters/${encodeURIComponent(identifier)}/restore`,
    request,
    { suppressGlobalError: true },
  )
}

export function deleteConnection(api: ApiClient, identifier: string): Promise<unknown> {
  return api.delete(`${BASE}/adapters/${encodeURIComponent(identifier)}`, undefined, {
    suppressGlobalError: true,
  })
}

/**
 * Store a connection's credentials, org-owned, under its slug. The generic
 * credentials route reads the connection identifier from the credentials'
 * `identifier` field.
 */
export function saveCredentials(
  api: ApiClient,
  identifier: string,
  fields: Record<string, string>,
): Promise<unknown> {
  return api.post(
    `/connections/${API_CONNECTOR_APP}/${API_CONNECTOR_CONNECTION}/credentials`,
    { mode: "org", credentials: { identifier, ...fields } },
    { suppressGlobalError: true },
  )
}

export function testOperation(
  api: ApiClient,
  identifier: string,
  request: TestOperationRequest,
): Promise<TestOperationResult> {
  return api.post<TestOperationResult>(
    `${BASE}/adapters/${encodeURIComponent(identifier)}/test`,
    request,
    { suppressGlobalError: true },
  )
}

/** Longer than the server's own 10 s budget for a lookup, so its error arrives first. */
export const CUSTOMER_LOOKUP_TIMEOUT_MS = 12_000

export type CustomerLookupOutcome =
  | { kind: "result"; result: CustomerResolution }
  /** No card at all: the caller lacks the read scope, or the app is not here. */
  | { kind: "absent" }

/**
 * Look a participant up across the connections that fill `customer.lookup`.
 * A refusal (403) or a missing route (404) means this viewer gets no card, not
 * an error card: whether a customer exists is itself data the scope guards.
 */
export async function lookupCustomer(
  api: ApiClient,
  email: string,
  signal?: AbortSignal,
): Promise<CustomerLookupOutcome> {
  const query = new URLSearchParams({ email })
  try {
    const result = await api.get<CustomerResolution>(`${BASE}/customer?${query.toString()}`, {
      suppressGlobalError: true,
      signal,
    })
    return { kind: "result", result }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return { kind: "absent" }
    }
    throw err
  }
}
