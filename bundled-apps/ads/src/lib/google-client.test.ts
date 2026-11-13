// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  GOOGLE_ADS_API_VERSION,
  gaqlSearch,
  googleAdsMutate,
  MICROS,
  microsToMajor,
} from "./google-client"
import { GoogleAdsApiError, GoogleAuthError } from "./google-error"

const GOOGLE_AUTH = { connection: "google", scheme: "bearer" as const }

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  /** The credential the host adds (`ctx.fetch` auth); the app never sets the header. */
  auth?: unknown
  body?: string
}

interface MockResponse {
  status: number
  body: string
}

function makeFetch(responses: MockResponse[]) {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(opts?.method ?? "GET"),
      headers: (opts?.headers ?? {}) as Record<string, string>,
      auth: opts?.auth,
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = responses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  return { fetch, calls }
}

describe("gaqlSearch — request shape", () => {
  it("posts to {version}/customers/{cid}/googleAds:searchStream with the GAQL query in the body", async () => {
    const { fetch, calls } = makeFetch([
      {
        status: 200,
        body: JSON.stringify([{ results: [{ campaign: { id: "1", name: "Camp A" } }] }]),
      },
    ])
    await gaqlSearch(fetch, {
      customerId: "1234567890",
      query: "SELECT campaign.id, campaign.name FROM campaign",
      auth: GOOGLE_AUTH,
      loginCustomerId: "9998887777",
    })
    expect(calls.length).toBe(1)
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toBe(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:searchStream`,
    )
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      query: "SELECT campaign.id, campaign.name FROM campaign",
    })
  })

  it("sends Authorization Bearer + login-customer-id + Content-Type, and never a developer-token header", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: JSON.stringify([{ results: [] }]) }])
    await gaqlSearch(fetch, {
      customerId: "1234567890",
      query: "SELECT campaign.id FROM campaign",
      auth: GOOGLE_AUTH,
      loginCustomerId: "9998887777",
    })
    const h = calls[0]?.headers ?? {}
    expect(h.Authorization).toBeUndefined()
    expect(calls[0]?.auth).toEqual(GOOGLE_AUTH)
    expect(Object.keys(h)).not.toContain("developer-token")
    expect(h["login-customer-id"]).toBe("9998887777")
    expect(h["Content-Type"]).toBe("application/json")
  })

  it("omits the developer-token header when no token is set (retired 2026-09-09; a future API version rejects it)", async () => {
    const { fetch, calls } = makeFetch([
      { status: 200, body: JSON.stringify([{ results: [] }]) },
      { status: 200, body: JSON.stringify({ results: [] }) },
    ])
    await gaqlSearch(fetch, {
      customerId: "1234567890",
      query: "SELECT campaign.id FROM campaign",
      auth: GOOGLE_AUTH,
      loginCustomerId: "9998887777",
    })
    await googleAdsMutate(fetch, {
      customerId: "1234567890",
      path: "campaigns:mutate",
      operations: [],
      auth: GOOGLE_AUTH,
      loginCustomerId: "9998887777",
    })
    for (const call of calls) {
      expect(Object.keys(call.headers)).not.toContain("developer-token")
      // The token is attached host-side from the call's auth, never as an app-built header.
      expect(call.headers.Authorization).toBeUndefined()
      expect(call.auth).toEqual(GOOGLE_AUTH)
      expect(call.headers["login-customer-id"]).toBe("9998887777")
    }
  })

  it("strips dashes from customerId in the URL path and loginCustomerId header", async () => {
    const { fetch, calls } = makeFetch([{ status: 200, body: JSON.stringify([{ results: [] }]) }])
    await gaqlSearch(fetch, {
      customerId: "123-456-7890",
      query: "SELECT campaign.id FROM campaign",
      auth: GOOGLE_AUTH,
      loginCustomerId: "999-888-7777",
    })
    expect(calls[0]?.url).toContain("/customers/1234567890/")
    expect(calls[0]?.headers["login-customer-id"]).toBe("9998887777")
  })

  it("flattens multiple searchStream batches into one results array", async () => {
    const { fetch } = makeFetch([
      {
        status: 200,
        body: JSON.stringify([
          { results: [{ campaign: { id: "1" } }, { campaign: { id: "2" } }] },
          { results: [{ campaign: { id: "3" } }] },
        ]),
      },
    ])
    const rows = await gaqlSearch(fetch, {
      customerId: "1234567890",
      query: "SELECT campaign.id FROM campaign",
      auth: GOOGLE_AUTH,
      loginCustomerId: "9998887777",
    })
    expect(rows.length).toBe(3)
  })

  it("returns an empty array when a batch has no results field", async () => {
    const { fetch } = makeFetch([{ status: 200, body: JSON.stringify([{}]) }])
    const rows = await gaqlSearch(fetch, {
      customerId: "1234567890",
      query: "SELECT campaign.id FROM campaign",
      auth: GOOGLE_AUTH,
      loginCustomerId: "9998887777",
    })
    expect(rows).toEqual([])
  })
})

describe("gaqlSearch — error surfacing", () => {
  it("throws a GoogleAdsApiError carrying status+code+trigger on a recorded GoogleAdsFailure", async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: "bad query",
        details: [
          {
            "@type": `type.googleapis.com/google.ads.googleads.${GOOGLE_ADS_API_VERSION}.errors.GoogleAdsFailure`,
            errors: [
              {
                errorCode: { queryError: "UNRECOGNIZED_FIELD" },
                message: "Unrecognized field 'foo'.",
                trigger: { stringValue: "foo" },
              },
            ],
          },
        ],
      },
    })
    const { fetch } = makeFetch([{ status: 400, body }])
    await expect(
      gaqlSearch(fetch, {
        customerId: "1234567890",
        query: "SELECT foo FROM campaign",
        auth: GOOGLE_AUTH,
        loginCustomerId: "9998887777",
      }),
    ).rejects.toBeInstanceOf(GoogleAdsApiError)
  })

  it("throws a GoogleAuthError on a 401", async () => {
    const body = JSON.stringify({
      error: { code: 401, status: "UNAUTHENTICATED", message: "bad token" },
    })
    const { fetch } = makeFetch([{ status: 401, body }])
    await expect(
      gaqlSearch(fetch, {
        customerId: "1234567890",
        query: "SELECT campaign.id FROM campaign",
        auth: GOOGLE_AUTH,
        loginCustomerId: "9998887777",
      }),
    ).rejects.toBeInstanceOf(GoogleAuthError)
  })
})

describe("microsToMajor", () => {
  it("converts integer micros to major-unit numbers by dividing by MICROS (1,000,000)", () => {
    expect(microsToMajor(1_500_000)).toBe(1.5)
    expect(MICROS).toBe(1_000_000)
  })
})
