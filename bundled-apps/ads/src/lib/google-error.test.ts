// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  GoogleAdsApiError,
  GoogleAuthError,
  GoogleParamError,
  parseGoogleAdsError,
} from "./google-error"

describe("parseGoogleAdsError — GoogleAdsFailure envelope", () => {
  it("extracts errorCode key + message + trigger from the first GoogleAdsFailure error", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
            errors: [
              {
                errorCode: { queryError: "UNRECOGNIZED_FIELD" },
                message: "Unrecognized field in the query.",
                trigger: { stringValue: "bad_field" },
                location: { fieldPathElements: [{ fieldName: "query" }] },
              },
            ],
          },
        ],
      },
    })
    const err = parseGoogleAdsError(body, 400)
    expect(err).toBeInstanceOf(GoogleAdsApiError)
    expect(err.status).toBe(400)
    expect(err.code).toBe("UNRECOGNIZED_FIELD")
    expect(err.message).toContain("Unrecognized field")
    expect(err.trigger).toBe("bad_field")
  })

  it("maps 401/UNAUTHENTICATED to GoogleAuthError naming the google connection", () => {
    const body = JSON.stringify({
      error: {
        code: 401,
        message: "Request had invalid authentication credentials.",
        status: "UNAUTHENTICATED",
      },
    })
    const err = parseGoogleAdsError(body, 401)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect(err.message.toLowerCase()).toContain("google")
  })

  it("maps AuthenticationError/AuthorizationError failures to GoogleAuthError even on non-401 status", () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: "The customer account is not accessible.",
        status: "PERMISSION_DENIED",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
            errors: [
              {
                errorCode: { authorizationError: "USER_PERMISSION_DENIED" },
                message: "User does not have permission.",
              },
            ],
          },
        ],
      },
    })
    const err = parseGoogleAdsError(body, 403)
    expect(err).toBeInstanceOf(GoogleAuthError)
  })

  it("maps a query-shaped errorCode without auth semantics to GoogleParamError", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: "bad query",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
            errors: [
              { errorCode: { queryError: "UNEXPECTED_END_OF_QUERY" }, message: "unexpected end" },
            ],
          },
        ],
      },
    })
    const err = parseGoogleAdsError(body, 400)
    expect(err).toBeInstanceOf(GoogleParamError)
  })

  it("maps EVERY real param-family errorCode key (fieldError, rangeError, stringLengthError, operatorError) to GoogleParamError", () => {
    for (const key of ["fieldError", "rangeError", "stringLengthError", "operatorError"]) {
      const body = JSON.stringify({
        error: {
          code: 400,
          message: "bad param",
          status: "INVALID_ARGUMENT",
          details: [
            {
              "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
              errors: [{ errorCode: { [key]: "SOME_SUBCODE" }, message: "bad param" }],
            },
          ],
        },
      })
      const err = parseGoogleAdsError(body, 400)
      expect(err, `errorCode key '${key}' should map to GoogleParamError`).toBeInstanceOf(
        GoogleParamError,
      )
    }
  })

  it("does NOT classify a key that merely CONTAINS 'header' or 'string' as a substring as a param error (exact-key match only)", () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        message: "some other failure",
        status: "INVALID_ARGUMENT",
        details: [
          {
            "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
            errors: [
              { errorCode: { internalError: "INTERNAL_ERROR" }, message: "some other failure" },
            ],
          },
        ],
      },
    })
    const err = parseGoogleAdsError(body, 400)
    expect(err).toBeInstanceOf(GoogleAdsApiError)
    expect(err).not.toBeInstanceOf(GoogleParamError)
  })

  it("falls back to a generic GoogleAdsApiError when the body is not JSON", () => {
    const err = parseGoogleAdsError("not json", 500)
    expect(err).toBeInstanceOf(GoogleAdsApiError)
    expect(err.status).toBe(500)
  })

  it("falls back to a generic GoogleAdsApiError when there is no GoogleAdsFailure detail", () => {
    const body = JSON.stringify({
      error: { code: 500, message: "Internal error", status: "INTERNAL" },
    })
    const err = parseGoogleAdsError(body, 500)
    expect(err).toBeInstanceOf(GoogleAdsApiError)
    expect(err.message).toContain("Internal error")
  })
})

// Real-shaped bodies. googleAds:searchStream answers an error as a JSON ARRAY
// holding one envelope (`[{"error":{...}}]`); unary calls (search, mutate) and
// Merchant API answer the bare object (`{"error":{...}}`).
function failure(
  status: string,
  httpCode: number,
  codeKey: string,
  codeValue: string,
  message: string,
) {
  return {
    error: {
      code: httpCode,
      message: "The caller does not have permission",
      status,
      details: [
        {
          "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
          errors: [{ errorCode: { [codeKey]: codeValue }, message }],
          requestId: "aBcD123",
        },
      ],
    },
  }
}

describe("parseGoogleAdsError — searchStream ARRAY envelope and 403 hints", () => {
  it("reads an ARRAY envelope: keeps Google's errorCode and message instead of a bare 'HTTP 403'", () => {
    const body = JSON.stringify([
      failure(
        "PERMISSION_DENIED",
        403,
        "authorizationError",
        "USER_PERMISSION_DENIED",
        "User doesn't have permission to access customer. Note: If you're accessing a client customer, the manager's customer id must be set in the 'login-customer-id' header.",
      ),
    ])
    const err = parseGoogleAdsError(body, 403)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect(err.status).toBe(403)
    expect(err.code).toBe("USER_PERMISSION_DENIED")
    expect(err.message).not.toBe("Google Ads API error (HTTP 403)")
    expect(err.message).toContain("authorizationError.USER_PERMISSION_DENIED")
    expect(err.message).toContain("login-customer-id")
    // Actionable hint: the manager id / the signed-in user's access, not "reconnect".
    expect(err.message).toContain("loginCustomerId")
    expect(err.message).toContain("customerId")
  })

  it("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION (array envelope) points to Explorer access in the Cloud console", () => {
    const body = JSON.stringify([
      failure(
        "PERMISSION_DENIED",
        403,
        "authorizationError",
        "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
        "The Google Cloud project is not approved to access production accounts.",
      ),
    ])
    const err = parseGoogleAdsError(body, 403)
    expect(err.code).toBe("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION")
    expect(err.message).toContain("console.cloud.google.com/google/ads-apis/overview")
    expect(err.message).toContain("Explorer")
    expect(err.message).not.toContain("API Center")
  })

  it("ACTION_NOT_PERMITTED (v24 and earlier: the same Test-access refusal, object envelope) gets the same hint", () => {
    const body = JSON.stringify(
      failure(
        "PERMISSION_DENIED",
        403,
        "authorizationError",
        "ACTION_NOT_PERMITTED",
        "The user does not have permission to perform this action.",
      ),
    )
    const err = parseGoogleAdsError(body, 403)
    expect(err.code).toBe("ACTION_NOT_PERMITTED")
    expect(err.message).toContain("console.cloud.google.com/google/ads-apis/overview")
  })

  it("AUTHORIZATION_ERROR quotes Google's documented known issue (fix rolling out) and its workaround: a NEW project applying for Explorer", () => {
    const body = JSON.stringify([
      failure(
        "PERMISSION_DENIED",
        403,
        "authorizationError",
        "AUTHORIZATION_ERROR",
        "Authorization of the request failed.",
      ),
    ])
    const err = parseGoogleAdsError(body, 403)
    expect(err.code).toBe("AUTHORIZATION_ERROR")
    expect(err.message).toContain("Authorization of the request failed.")
    expect(err.message).toContain(
      "https://developers.google.com/google-ads/api/docs/api-policy/developer-token",
    )
    expect(err.message).toContain("known issue Google documents")
    expect(err.message).toContain("rolling it out")
    expect(err.message).toMatch(
      /NEW Google Cloud project, apply for Explorer access from that project/,
    )
  })

  it("a 403 with no GoogleAdsFailure (API not enabled, google.rpc.ErrorInfo) keeps status, reason and message", () => {
    const body = JSON.stringify([
      {
        error: {
          code: 403,
          message:
            "Google Ads API has not been used in project 123456789 before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "SERVICE_DISABLED",
              domain: "googleapis.com",
              metadata: { service: "googleads.googleapis.com", consumer: "projects/123456789" },
            },
          ],
        },
      },
    ])
    const err = parseGoogleAdsError(body, 403)
    expect(err.code).toBe("SERVICE_DISABLED")
    expect(err.message).toContain("PERMISSION_DENIED")
    expect(err.message).toContain("has not been used in project")
    expect(err.message).toContain("googleads.googleapis.com")
  })

  it("an authenticationError still says to reconnect the google connection", () => {
    const body = JSON.stringify([
      failure(
        "UNAUTHENTICATED",
        401,
        "authenticationError",
        "OAUTH_TOKEN_INVALID",
        "Oauth token is invalid.",
      ),
    ])
    const err = parseGoogleAdsError(body, 401)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect(err.message).toContain("reconnect the google connection")
  })
})

describe("microsToMajor", () => {
  it("converts micros to major units by dividing by 1,000,000", async () => {
    const { microsToMajor } = await import("./google-client")
    expect(microsToMajor(1_500_000)).toBe(1.5)
    expect(microsToMajor(0)).toBe(0)
    expect(microsToMajor(999_999)).toBeCloseTo(0.999999)
  })
})
