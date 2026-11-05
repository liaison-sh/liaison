// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { merchantFetch, MERCHANT_API_BASE, classifyIssue } from "./merchant-client"
import { GoogleAdsApiError, GoogleAuthError } from "./google-error"

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
}

interface MockResponse {
  status: number
  body: string
}

function makeFetch(responses: MockResponse[]) {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({ url, method: String(opts?.method ?? "GET"), headers: (opts?.headers ?? {}) as Record<string, string> })
    const resp = responses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  return { fetch, calls }
}

describe("merchantFetch — request shape", () => {
  it("has NO global version prefix — a fully-qualified path is used verbatim against the Merchant API host", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: JSON.stringify({ ok: true }) }])
    await merchantFetch(fetch, {
      path: "/accounts/v1/accounts/mc_1/aggregateProductStatuses",
      token: "oauth_tok",
    })
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe(`${MERCHANT_API_BASE}/accounts/v1/accounts/mc_1/aggregateProductStatuses`)
    expect(calls[0]?.headers.Authorization).toBe("Bearer oauth_tok")
    expect(calls[0]?.headers["developer-token"]).toBeUndefined()
    expect(calls[0]?.headers["login-customer-id"]).toBeUndefined()
  })

  it("assembles /{subApi}/{version}{path} when subApi+version options are passed instead of a fully-qualified path", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: JSON.stringify({ ok: true }) }])
    await merchantFetch(fetch, {
      subApi: "products",
      version: "v1",
      path: "/accounts/mc_1/products",
      token: "oauth_tok",
    })
    expect(calls[0]?.url).toBe(`${MERCHANT_API_BASE}/products/v1/accounts/mc_1/products`)
  })

  it("different sub-APIs can carry different version segments in the same call site (no global version)", async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: JSON.stringify({ ok: true }) },
      { status: 200, body: JSON.stringify({ ok: true }) },
    ])
    await merchantFetch(fetch, { path: "/accounts/v1/accounts/mc_1/aggregateProductStatuses", token: "tok" })
    await merchantFetch(fetch, { path: "/products/v1/accounts/mc_1/products", token: "tok" })
    expect(calls[0]?.url).toContain("/accounts/v1/")
    expect(calls[1]?.url).toContain("/products/v1/")
  })

  it("throws a typed error on a non-2xx response using the shared Google error envelope", async () => {
    const body = JSON.stringify({ error: { code: 401, status: "UNAUTHENTICATED", message: "bad token" } })
    const { fetch } = makeFetch([{ status: 401, body }])
    await expect(
      merchantFetch(fetch, { path: "/accounts/v1/accounts/mc_1/aggregateProductStatuses", token: "bad" }),
    ).rejects.toBeInstanceOf(GoogleAuthError)
  })

  it("propagates a generic Merchant error as GoogleAdsApiError", async () => {
    const body = JSON.stringify({ error: { code: 500, status: "INTERNAL", message: "server error" } })
    const { fetch } = makeFetch([{ status: 500, body }])
    await expect(
      merchantFetch(fetch, { path: "/accounts/v1/accounts/mc_1/aggregateProductStatuses", token: "tok" }),
    ).rejects.toBeInstanceOf(GoogleAdsApiError)
  })
})

describe("classifyIssue — product-data vs non-product-data taxonomy", () => {
  it("classifies title/description/price/GTIN/availability codes as product-data", () => {
    expect(classifyIssue("title_missing").klass).toBe("product-data")
    expect(classifyIssue("description_missing").klass).toBe("product-data")
    expect(classifyIssue("price_mismatch").klass).toBe("product-data")
    expect(classifyIssue("gtin_invalid").klass).toBe("product-data")
    expect(classifyIssue("availability_mismatch").klass).toBe("product-data")
  })

  it("classifies landing-page/shipping/tax/business-verification/policy codes as non-product-data", () => {
    expect(classifyIssue("landing_page_error").klass).toBe("non-product-data")
    expect(classifyIssue("shipping_settings_missing").klass).toBe("non-product-data")
    expect(classifyIssue("tax_settings_missing").klass).toBe("non-product-data")
    expect(classifyIssue("account_not_verified").klass).toBe("non-product-data")
    expect(classifyIssue("policy_violation_generic").klass).toBe("non-product-data")
  })

  it("defaults an unknown issue code to non-product-data (safe — never auto-routed to a Shopify write)", () => {
    expect(classifyIssue("some_brand_new_code_2026").klass).toBe("non-product-data")
  })
})
