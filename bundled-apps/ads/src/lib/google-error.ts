// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Google Ads + Merchant Center error-envelope parser -> typed errors.
//
// Google Ads error envelope (pinned per P4 blueprint §5):
//   {"error":{"code","status","message","details":[{"@type":".../GoogleAdsFailure",
//     "errors":[{"errorCode":{...},"message","trigger","location"}]}]}}
// googleAds:searchStream (the default read path) wraps the same envelope in a
// JSON ARRAY: `[{"error":{...}}]`. Both shapes are read; reading only the
// object dropped Google's reason and left a bare "HTTP 403".
//
// The parser extracts the FIRST GoogleAdsFailure.errors[0] (errorCode key,
// message, trigger) and surfaces status + code + trigger to the agent per the
// liaison error convention (real detail to the agent; safe message to the
// client). Auth failures (401/UNAUTHENTICATED, or an authenticationError /
// authorizationError errorCode key) map to GoogleAuthError, never a crash: an
// authentication failure says to reconnect the `google` connection; an
// authorization refusal keeps Google's errorCode and gets the hint for its known
// cause (wrong login-customer-id, user without access, Cloud project not
// approved for production).

export class GoogleAdsApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly trigger?: string,
  ) {
    super(message)
    this.name = "GoogleAdsApiError"
  }
}

export class GoogleAuthError extends GoogleAdsApiError {
  constructor(message: string, status: number, code?: string, trigger?: string) {
    super(message, status, code, trigger)
    this.name = "GoogleAuthError"
  }
}

export class GoogleParamError extends GoogleAdsApiError {
  constructor(message: string, status: number, code?: string, trigger?: string) {
    super(message, status, code, trigger)
    this.name = "GoogleParamError"
  }
}

interface GoogleAdsFailureError {
  errorCode?: Record<string, string>
  message?: string
  trigger?: { stringValue?: string } | string
  location?: unknown
}

interface GoogleAdsErrorDetail {
  "@type"?: string
  errors?: GoogleAdsFailureError[]
  /** google.rpc.ErrorInfo (e.g. SERVICE_DISABLED when the API is not enabled). */
  reason?: string
}

interface GoogleAdsErrorEnvelope {
  error?: {
    code?: number
    status?: string
    message?: string
    details?: GoogleAdsErrorDetail[]
  }
}

const AUTH_ERROR_CODE_KEYS = new Set(["authenticationError", "authorizationError"])

function extractTrigger(t: GoogleAdsFailureError["trigger"]): string | undefined {
  if (typeof t === "string") return t
  if (t && typeof t === "object" && typeof t.stringValue === "string") return t.stringValue
  return undefined
}

const ADS_ACCESS_URL = "https://console.cloud.google.com/google/ads-apis/overview"

/**
 * What to do about a known refusal, keyed by the GoogleAdsFailure errorCode
 * value (or a google.rpc.ErrorInfo reason). Access levels belong to the Google
 * Cloud project since developer tokens were retired on 2026-09-09
 * (developers.google.com/google-ads/api/docs/api-policy/developer-token).
 */
const DEVELOPER_TOKEN_DOC_URL =
  "https://developers.google.com/google-ads/api/docs/api-policy/developer-token"

const HINTS: Record<string, string> = {
  USER_PERMISSION_DENIED:
    "the signed-in Google user cannot reach this account through the manager in loginCustomerId. Check that loginCustomerId is the manager account that manages customerId (or the ad account itself when there is no manager), that customerId is the ad account, and that the Google user connected in the google connection has access to that manager in Google Ads (Admin > Access and security)",
  CUSTOMER_NOT_ENABLED:
    "the ad account in customerId is not enabled (cancelled or never set up). Check customerId in the Google Ads API settings connection",
  CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION: `the Google Cloud project of the OAuth client only has Test access, which reaches test accounts only. Open ${ADS_ACCESS_URL}, expand "Upgrade access level" and click "Apply for access" to get Explorer access (production accounts, 2,880 operations a day)`,
  ACTION_NOT_PERMITTED: `if this is a production account, the Google Cloud project of the OAuth client may only have Test access. Open ${ADS_ACCESS_URL}, expand "Upgrade access level" and click "Apply for access" to get Explorer access; otherwise the signed-in Google user lacks the role this action needs`,
  AUTHORIZATION_ERROR: `if your Cloud project's Basic or Explorer access was approved recently, this is a known issue Google documents on ${DEVELOPER_TOKEN_DOC_URL} ("Known issues": projects upgraded after September 9, 2026 receive an AUTHORIZATION_ERROR; Google has a fix and is rolling it out). Google's workaround: create a NEW Google Cloud project, apply for Explorer access from that project (${ADS_ACCESS_URL} with the new project selected) and use that project's OAuth client`,
  SERVICE_DISABLED:
    "the Google Ads API is not enabled in the Google Cloud project of the OAuth client. Enable it at https://console.cloud.google.com/flows/enableapi?apiid=googleads.googleapis.com",
}

/** The first `{error:{...}}` of an object or an array (searchStream) envelope. */
function firstEnvelope(parsed: unknown): GoogleAdsErrorEnvelope {
  const candidates = Array.isArray(parsed) ? parsed : [parsed]
  for (const c of candidates) {
    if (c && typeof c === "object" && "error" in c) return c as GoogleAdsErrorEnvelope
  }
  return {}
}

/** "status: message (errorCode). Hint: ..." -- Google's own words first, then what to do. */
function describe(
  status: number,
  topStatus: string | undefined,
  label: string | undefined,
  message: string,
  hintKey: string | undefined,
): string {
  const head = `Google Ads API refused the request (HTTP ${status}${topStatus ? ` ${topStatus}` : ""}${label ? `, ${label}` : ""}): ${message}`
  const hint = hintKey ? HINTS[hintKey] : undefined
  return hint ? `${head}. To fix: ${hint}.` : head
}

/** Parse a Google Ads (or Merchant API v1 — same Google error envelope shape) error body -> typed error. */
export function parseGoogleAdsError(body: string, status: number): GoogleAdsApiError {
  let envelope: GoogleAdsErrorEnvelope = {}
  try {
    envelope = firstEnvelope(JSON.parse(body))
  } catch {
    return new GoogleAdsApiError(`HTTP ${status}: ${body}`, status)
  }

  const err = envelope.error ?? {}
  const topStatus = err.status
  const topMessage = err.message ?? `Google Ads API error (HTTP ${status})`

  // 401/UNAUTHENTICATED at the top level -> connect-error, even with no detail.
  if (status === 401 || topStatus === "UNAUTHENTICATED") {
    return new GoogleAuthError(
      `Google connection needs re-authentication: reconnect the google connection (${topMessage})`,
      status,
    )
  }

  const failureDetail = (err.details ?? []).find((d) => d["@type"]?.includes("GoogleAdsFailure"))
  const first = failureDetail?.errors?.[0]

  if (!first) {
    const reason = (err.details ?? []).find((d) => typeof d.reason === "string")?.reason
    if (status >= 400 && status < 500 && (topStatus || reason)) {
      return new GoogleAdsApiError(
        describe(status, topStatus, reason, topMessage, reason),
        status,
        reason,
      )
    }
    return new GoogleAdsApiError(topMessage, status, reason)
  }

  const codeKey = Object.keys(first.errorCode ?? {})[0]
  const codeValue = codeKey ? first.errorCode?.[codeKey] : undefined
  const trigger = extractTrigger(first.trigger)
  const message = first.message ?? topMessage

  if (codeKey === "authenticationError") {
    return new GoogleAuthError(
      `Google connection needs re-authentication: reconnect the google connection (${codeKey}.${codeValue}: ${message})`,
      status,
      codeValue,
      trigger,
    )
  }
  if (codeKey && AUTH_ERROR_CODE_KEYS.has(codeKey)) {
    return new GoogleAuthError(
      describe(status, topStatus, `${codeKey}.${codeValue}`, message, codeValue),
      status,
      codeValue,
      trigger,
    )
  }

  // The real Google Ads errorCode param-family keys that mean "a caller-input
  // problem" (bad GAQL, missing field, out-of-range value, bad string,
  // invalid operator) — matched against the FULL key, never a bare substring
  // (so e.g. "headerError" or an unrelated key containing "field" as a
  // fragment can't false-positive).
  const PARAM_ERROR_CODE_KEYS = new Set([
    "queryError",
    "fieldError",
    "fieldMaskError",
    "rangeError",
    "stringLengthError",
    "stringFormatError",
    "operatorError",
  ])
  if (codeKey && PARAM_ERROR_CODE_KEYS.has(codeKey)) {
    return new GoogleParamError(message, status, codeValue, trigger)
  }

  return new GoogleAdsApiError(
    codeKey ? describe(status, topStatus, `${codeKey}.${codeValue}`, message, codeValue) : message,
    status,
    codeValue,
    trigger,
  )
}
