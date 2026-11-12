// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The screens' calls: one function per tool of this app (its UI-only tools and
// the authoring reads), and the only place the screens name them. A tool's
// `{ error }` answer is thrown as an ApiError carrying its status and code.

import type {
  AdapterIssue,
  AdapterRestoreRequest,
  AdapterSaveSummary,
  AdapterVersionList,
  ConnectionList,
  ConnectionSummary,
  CustomerResolution,
  TestOperationRequest,
  TestOperationResult,
} from "@liaison/api-connector-core/contract"
import { app } from "@liaison/host"

/** A refused tool call: its status, code and whatever else the answer carried. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly details: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** Kept for the screens' call shape: the tools need no client. */
export type ApiClient = null
export function useApi(): ApiClient {
  return null
}

async function call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const out = await app.invokeTool<Record<string, unknown>>(tool, args)
  const err = out?.error as { message?: string; status?: number; code?: string } | undefined
  if (err) {
    throw new ApiError(
      err.message ?? "The request was refused.",
      typeof err.status === "number" ? err.status : 400,
      err.code,
      err as Record<string, unknown>,
    )
  }
  return out as T
}

/** The org's connections, and whether this org may change them (a demo org may not). */
export function listConnections(_api: ApiClient): Promise<ConnectionList> {
  return call<ConnectionList>("settings_connections", {})
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
 * Create or replace a connection's adapter (JSON or YAML text, parsed and
 * validated by the platform). Invalid comes back as its issues, a save that
 * would delete stored credentials as the two credential targets
 * (`confirmCredentialWipe` sends it anyway); anything else throws.
 */
export async function putAdapter(
  _api: ApiClient,
  identifier: string,
  text: string,
  options: { confirmCredentialWipe?: boolean } = {},
): Promise<PutAdapterOutcome> {
  try {
    const summary = await call<ConnectionSummary>("settings_adapter_save", {
      identifier,
      document: text,
      confirmCredentialWipe: options.confirmCredentialWipe === true,
    })
    return { ok: true, summary }
  } catch (err) {
    if (err instanceof ApiError && err.code === "confirm_credential_wipe") {
      const prior = err.details.priorTarget
      const next = err.details.newTarget
      return {
        ok: false,
        wipe: {
          priorTarget: typeof prior === "string" ? prior : "",
          newTarget: typeof next === "string" ? next : "",
        },
      }
    }
    if (err instanceof ApiError && err.status === 422) {
      const raw = err.details.issues
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
export function listVersions(_api: ApiClient, identifier: string): Promise<AdapterVersionList> {
  return call<AdapterVersionList>("connector_adapter_versions", { identifier })
}

/** Put a kept adapter back. A restore that would delete credentials needs the confirmation. */
export function restoreVersion(
  _api: ApiClient,
  identifier: string,
  request: AdapterRestoreRequest,
): Promise<AdapterSaveSummary> {
  return call<AdapterSaveSummary>("settings_adapter_restore", { identifier, ...request })
}

export function deleteConnection(_api: ApiClient, identifier: string): Promise<unknown> {
  return call("settings_adapter_delete", { identifier })
}

/**
 * Enter a connection's credentials: the host's credential dialog for this
 * account and exactly the fields its auth type needs. What is typed goes to
 * the server only, never through this app.
 */
export async function enterCredentials(identifier: string, fields: string[]): Promise<boolean> {
  const out = await app.openConnectDialog({ connectionName: "api", identifier, fields })
  return out.connected
}

export function testOperation(
  _api: ApiClient,
  identifier: string,
  request: TestOperationRequest,
): Promise<TestOperationResult> {
  return call<TestOperationResult>("settings_adapter_test", { identifier, ...request })
}

/** Longer than the server's own 10 s budget for a lookup, so its error arrives first. */
export const CUSTOMER_LOOKUP_TIMEOUT_MS = 12_000

export type CustomerLookupOutcome =
  | { kind: "result"; result: CustomerResolution; email: string | null }
  /** No card at all: the caller lacks the read scope. */
  | { kind: "absent" }

/**
 * Look the participant of a ticket or conversation up across the connections
 * that fill `customer.lookup`. A refusal (403) means this viewer gets no card,
 * not an error card: whether a customer exists is itself data the scope guards.
 */
export async function lookupCustomer(
  subject: { ticketId: string } | { mailConversationId: string } | { email: string },
): Promise<CustomerLookupOutcome> {
  try {
    const result = await call<CustomerResolution & { email?: string | null }>(
      "customer_lookup",
      subject,
    )
    return {
      kind: "result",
      result,
      email: "email" in subject ? subject.email : (result.email ?? null),
    }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
      return { kind: "absent" }
    }
    throw err
  }
}
