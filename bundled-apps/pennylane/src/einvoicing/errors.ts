// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Contract op results: a success is the op's own shape; a failure is the structured
// `{status:"error", error:{code, message, retryable, detail?}}` the caller reads (a thrown
// sandbox error would be redacted to a bare tool_error).
import { PennylaneConnectionError } from "../lib/get-client"
import { PennylaneApiError, PennylaneRateLimitError } from "../lib/pennylane-client"

export interface OpError {
  status: "error"
  error: { code: string; message: string; retryable: boolean; status?: number; detail?: unknown }
}

/** The HTTP status each failure answers with. A refusal, a missing setting or an answer from
 *  Pennylane is not a server fault: answering 500 for it reads as one and pages the watchdog.
 *  Only a failure nobody anticipated (`provider_error`) keeps the default 500, and a Pennylane
 *  outage answers 502. */
const STATUS_BY_CODE: Record<string, number> = {
  invalid_input: 422,
  unsupported: 422,
  callback_base_url_missing: 422,
  einvoice_not_eligible: 422,
  fx_rate_missing: 422,
  legal_original_mismatch: 422,
  not_received_einvoice: 422,
  provider_ref_mismatch: 422,
  received_reason_invalid: 422,
  supplier_ambiguous: 422,
  supplier_not_found: 422,
  vat_rate_unmappable: 422,
  pa_emission_not_activated: 409,
  received_not_found: 404,
  received_file_missing: 404,
  provider_unauthorized: 424,
  provider_not_connected: 424,
  provider_rejected: 424,
  received_file_download_refused: 424,
  provider_rate_limited: 429,
  provider_unavailable: 502,
}

export function opError(code: string, message: string, retryable = false, detail?: unknown): OpError {
  const status = STATUS_BY_CODE[code]
  return {
    status: "error",
    error: {
      code,
      message,
      retryable,
      ...(status !== undefined ? { status } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
  }
}

export function isOpError(v: unknown): v is OpError {
  return !!v && typeof v === "object" && (v as { status?: unknown }).status === "error"
}

/** Map a thrown client/connection error to the op error the caller can act on. */
export function fromException(e: unknown, what: string): OpError {
  if (e instanceof PennylaneRateLimitError) {
    return opError("provider_rate_limited", `${what}: Pennylane's request budget is spent; retry later`, true, {
      retry_at: new Date(e.retryAtMs).toISOString(),
    })
  }
  if (e instanceof PennylaneApiError) {
    if (e.status >= 500 || e.status === 408) {
      return opError("provider_unavailable", `${what}: Pennylane answered ${e.status}`, true, { status: e.status, body: e.body })
    }
    if (e.status === 401 || e.status === 403) {
      return opError(
        "provider_unauthorized",
        `${what}: Pennylane refused the token (${e.status}); check the connection's token and its scopes`,
        false,
        { status: e.status, body: e.body },
      )
    }
    return opError("provider_rejected", `${what}: Pennylane answered ${e.status}`, false, { status: e.status, body: e.body })
  }
  if (e instanceof PennylaneConnectionError) return opError("provider_not_connected", e.message, false)
  const msg = e instanceof Error ? e.message : String(e)
  return opError("provider_error", `${what}: ${msg}`, true)
}
