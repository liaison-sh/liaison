// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  AuthError,
  BudgetCapError,
  checkInsightsReport,
  createInsightsReport,
  fromAccountCurrency,
  GRAPH,
  MetaApiError,
  metaFetch,
  metaFetchPaged,
  ParamError,
  PermissionError,
  RateLimitError,
  TransientError,
  toMinorUnits,
} from "./lib/meta-client"

// ─── makeCtx helper ───────────────────────────────────────────────────────────

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

interface MockResponse {
  status: number
  headers?: Record<string, string>
  body: string
}

function makeCtx(fetchResponses: MockResponse[]): {
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(opts?.method ?? "GET"),
      headers: (opts?.headers ?? {}) as Record<string, string>,
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = fetchResponses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: resp.headers ?? {}, body: resp.body }
  }
  return { fetch, calls }
}

const ACCESS_TOKEN = "test_token_abc"

// ─── Version pin ──────────────────────────────────────────────────────────────

describe("metaFetch — version pin", () => {
  it("uses graph.facebook.com/v25.0 in the URL", async () => {
    const { fetch, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "123" }) }])
    await metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN })
    expect(calls[0]?.url).toContain("graph.facebook.com/v25.0")
    expect(calls[0]?.url).toContain(GRAPH)
  })
})

// ─── Authorization header ─────────────────────────────────────────────────────

describe("metaFetch — Authorization header", () => {
  it("sends Authorization: Bearer <token>", async () => {
    const { fetch, calls } = makeCtx([{ status: 200, body: JSON.stringify({}) }])
    await metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN })
    expect(calls[0]?.headers["Authorization"]).toBe(`Bearer ${ACCESS_TOKEN}`)
  })
})

// ─── Form-encoding ────────────────────────────────────────────────────────────

describe("metaFetch — form-encoding", () => {
  it("GET request: object/array params go in query string as JSON strings", async () => {
    const { fetch, calls } = makeCtx([{ status: 200, body: JSON.stringify({ data: [] }) }])
    await metaFetch(fetch, {
      path: "/act_123/campaigns",
      method: "GET",
      params: { fields: ["name", "status"], limit: 10 },
      accessToken: ACCESS_TOKEN,
    })
    const url = calls[0]?.url ?? ""
    // Array value should be JSON.stringify'd in query string
    expect(url).toContain(encodeURIComponent(JSON.stringify(["name", "status"])))
  })

  it("POST request: params go in the body as form-encoded, object values JSON.stringify'd", async () => {
    const { fetch, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "camp_1" }) }])
    await metaFetch(fetch, {
      path: "/act_123/campaigns",
      method: "POST",
      params: {
        name: "Test Campaign",
        special_ad_categories: [],
        targeting: { geo_locations: { countries: ["US"] } },
      },
      accessToken: ACCESS_TOKEN,
    })
    const body = calls[0]?.body ?? ""
    // special_ad_categories=[] should be JSON-encoded
    expect(body).toContain("special_ad_categories=%5B%5D")
    // targeting object should be JSON-encoded
    expect(body).toContain("targeting=")
    expect(body).toContain(
      encodeURIComponent(JSON.stringify({ geo_locations: { countries: ["US"] } })),
    )
  })
})

// ─── Typed errors ─────────────────────────────────────────────────────────────

describe("metaFetch — typed errors", () => {
  it("190 → AuthError", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: JSON.stringify({ error: { code: 190, message: "Invalid token", fbtrace_id: "abc" } }),
      },
    ])
    await expect(
      metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }),
    ).rejects.toBeInstanceOf(AuthError)
  })

  it("102 → AuthError", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 102, message: "Session expired", fbtrace_id: "xyz" },
        }),
      },
    ])
    await expect(
      metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }),
    ).rejects.toBeInstanceOf(AuthError)
  })

  it("100 → ParamError", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: JSON.stringify({ error: { code: 100, message: "Invalid param", fbtrace_id: "def" } }),
      },
    ])
    await expect(
      metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }),
    ).rejects.toBeInstanceOf(ParamError)
  })

  it("4 → RateLimitError", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: JSON.stringify({ error: { code: 4, message: "Rate limited", fbtrace_id: "ghi" } }),
      },
    ])
    await expect(
      metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }),
    ).rejects.toBeInstanceOf(RateLimitError)
  })

  it("613 + error_subcode 1487632 → BudgetCapError (the ad-set ~4/hr budget cap)", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 613, error_subcode: 1487632, message: "Budget cap", fbtrace_id: "jkl" },
        }),
      },
    ])
    await expect(
      metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }),
    ).rejects.toBeInstanceOf(BudgetCapError)
  })

  it("bare 613 WITHOUT subcode 1487632 → RateLimitError (NOT BudgetCapError)", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 613, message: "Generic throttle", fbtrace_id: "mno" },
        }),
      },
    ])
    const err = await metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err).not.toBeInstanceOf(BudgetCapError)
  })

  it("1 → TransientError", async () => {
    const { fetch } = makeCtx([
      {
        status: 500,
        body: JSON.stringify({ error: { code: 1, message: "Transient", fbtrace_id: "pqr" } }),
      },
    ])
    await expect(
      metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }),
    ).rejects.toBeInstanceOf(TransientError)
  })

  it("2 → TransientError", async () => {
    const { fetch } = makeCtx([
      {
        status: 500,
        body: JSON.stringify({ error: { code: 2, message: "Transient", fbtrace_id: "stu" } }),
      },
    ])
    await expect(
      metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }),
    ).rejects.toBeInstanceOf(TransientError)
  })

  it("errors include fbtrace_id in the message", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: JSON.stringify({
          error: { code: 190, message: "Bad token", fbtrace_id: "TRACE123" },
        }),
      },
    ])
    const err = await metaFetch(fetch, { path: "/me", accessToken: ACCESS_TOKEN }).catch(
      (e: Error) => e,
    )
    expect((err as Error).message).toContain("TRACE123")
  })
})

// ─── Cursor paging ────────────────────────────────────────────────────────────

describe("metaFetchPaged — cursor paging", () => {
  it("stitches two pages and stops when there is no next cursor", async () => {
    const page1 = {
      status: 200,
      body: JSON.stringify({
        data: [{ id: "a" }, { id: "b" }],
        paging: { cursors: { after: "CURSOR_1" }, next: "https://graph.facebook.com/v25.0/..." },
      }),
    }
    const page2 = {
      status: 200,
      body: JSON.stringify({
        data: [{ id: "c" }],
        paging: { cursors: {} },
        // no `next` key — stops here
      }),
    }
    const { fetch } = makeCtx([page1, page2])
    const result = await metaFetchPaged(fetch, {
      path: "/act_123/campaigns",
      method: "GET",
      accessToken: ACCESS_TOKEN,
    })
    expect(result).toHaveLength(3)
    expect((result[0] as { id: string }).id).toBe("a")
    expect((result[2] as { id: string }).id).toBe("c")
  })
})

// ─── toMinorUnits ─────────────────────────────────────────────────────────────

describe("toMinorUnits", () => {
  it("EUR: 50 → 5000", () => expect(toMinorUnits(50, "EUR")).toBe(5000))
  it("USD: 50 → 5000", () => expect(toMinorUnits(50, "USD")).toBe(5000))
  it("JPY: 50 → 50 (zero-decimal currency)", () => expect(toMinorUnits(50, "JPY")).toBe(50))
  it("KRW: 1000 → 1000 (zero-decimal currency)", () => expect(toMinorUnits(1000, "KRW")).toBe(1000))
  it("KWD: 10 → 10000 (3-decimal currency)", () => expect(toMinorUnits(10, "KWD")).toBe(10000))
})

// ─── fromAccountCurrency (read path) ─────────────────────────────────────────

describe("fromAccountCurrency", () => {
  it("JPY: '50' → 50 (zero-decimal — raw string IS already the major unit)", () =>
    expect(fromAccountCurrency("50")).toBe(50))

  it("EUR: '1234.56' → 1234.56 (not 12.3456 and not 123456 — never rescale on reads)", () => {
    const result = fromAccountCurrency("1234.56")
    expect(result).toBe(1234.56)
    expect(result).not.toBe(12.3456)
    expect(result).not.toBe(123456)
  })

  it("USD: '99.99' → 99.99", () => expect(fromAccountCurrency("99.99")).toBe(99.99))
})

// ─── Async insights ───────────────────────────────────────────────────────────

describe("createInsightsReport / checkInsightsReport", () => {
  const RUN = { reportRunId: "RUN_42", accessToken: ACCESS_TOKEN }

  it("createInsightsReport POSTs async=true and answers the report run id", async () => {
    const { fetch, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_42" }) },
    ])
    const id = await createInsightsReport(fetch, {
      path: "/act_123/insights",
      params: { level: "account", date_preset: "last_7d" },
      accessToken: ACCESS_TOKEN,
    })
    expect(id).toBe("RUN_42")
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.url).toContain("/act_123/insights")
    expect(calls[0]?.body).toContain("async=true")
  })

  it("createInsightsReport throws when Meta answers no report_run_id", async () => {
    const { fetch } = makeCtx([{ status: 200, body: "{}" }])
    const err = await createInsightsReport(fetch, {
      path: "/a/insights",
      params: {},
      accessToken: ACCESS_TOKEN,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(MetaApiError)
  })

  it("a completed report is extracted in the same call (status, then results; never ctx.bulk)", async () => {
    const { fetch, calls } = makeCtx([
      {
        status: 200,
        body: JSON.stringify({
          id: "RUN_42",
          async_status: "Job Completed",
          async_percent_completion: 100,
        }),
      },
      {
        status: 200,
        body: JSON.stringify({ data: [{ spend: "100.00" }], paging: { cursors: {} } }),
      },
    ])
    const out = await checkInsightsReport(fetch, RUN)
    expect(out).toEqual([{ spend: "100.00" }])
    expect(calls[0]?.url.endsWith("/RUN_42")).toBe(true)
    expect(calls[1]?.url).toContain("/RUN_42/insights")
    expect(calls.length).toBe(2)
  })

  it("a running report is asked ONCE and answers still_running: no loop inside the run", async () => {
    const running = JSON.stringify({
      id: "RUN_42",
      async_status: "Job Running",
      async_percent_completion: 40,
    })
    const { fetch, calls } = makeCtx([
      { status: 200, body: running },
      { status: 200, body: running },
    ])
    const out = await checkInsightsReport(fetch, RUN)
    expect(out).toEqual({ _pending: true, report_run_id: "RUN_42", reason: "still_running" })
    expect(calls.length).toBe(1)
  })

  it("does not extract while async_percent_completion is below 100, even when the status says completed", async () => {
    const { fetch, calls } = makeCtx([
      {
        status: 200,
        body: JSON.stringify({
          id: "RUN_42",
          async_status: "Job Completed",
          async_percent_completion: 90,
        }),
      },
    ])
    const out = await checkInsightsReport(fetch, RUN)
    expect(out).toEqual({ _pending: true, report_run_id: "RUN_42", reason: "still_running" })
    expect(calls.length).toBe(1)
  })

  it("fails fast on 'Job Failed' and 'Job Skipped'", async () => {
    for (const state of ["Job Failed", "Job Skipped"]) {
      const { fetch } = makeCtx([
        { status: 200, body: JSON.stringify({ id: "RUN_42", async_status: state }) },
      ])
      const err = await checkInsightsReport(fetch, RUN).catch((e: Error) => e)
      expect((err as Error).message).toContain(state)
      expect((err as Error).message).toContain("RUN_42")
    }
  })
})

// ─── Throttle headers do NOT discard a successful read ────────────────────────

describe("metaFetch — throttle headers never throw on a successful 2xx", () => {
  it("80%-usage successful read RETURNS the data (warn, not throw) — flat X-App-Usage shape", async () => {
    const { fetch } = makeCtx([
      {
        status: 200,
        headers: {
          "x-app-usage": JSON.stringify({ call_count: 80, total_time: 30, total_cputime: 30 }),
        },
        body: JSON.stringify({ data: [{ id: "a" }] }),
      },
    ])
    const result = (await metaFetch(fetch, {
      path: "/act_123/campaigns",
      accessToken: ACCESS_TOKEN,
    })) as { data: unknown[] }
    // Busy-but-OK account: the completed read is returned, not thrown away.
    expect(result.data).toHaveLength(1)
  })

  it("80%-usage successful read RETURNS the data — nested-array X-Business-Use-Case-Usage shape", async () => {
    const { fetch } = makeCtx([
      {
        status: 200,
        headers: {
          "x-business-use-case-usage": JSON.stringify({
            "1234567890": [{ type: "ads_management", call_count: 82, total_time: 20 }],
          }),
        },
        body: JSON.stringify({ data: [{ id: "b" }] }),
      },
    ])
    const result = (await metaFetch(fetch, {
      path: "/act_123/insights",
      accessToken: ACCESS_TOKEN,
    })) as { data: unknown[] }
    expect(result.data).toHaveLength(1)
  })
})

// ─── Upstream classification of the Graph answers seen in production ────────

const INSIGHTS_THROTTLE_FR =
  "Trop d\u2019appels ont \u00e9t\u00e9 pass\u00e9s depuis cette application. Patientez un moment puis r\u00e9essayez."
const REPORT_NOT_READY_FR =
  "Impossible de charger le rapport. V\u00e9rifiez que le statut de votre t\u00e2che est termin\u00e9 et non pas \u00e9chou\u00e9 ou en cours avant d\u2019extraire les donn\u00e9es."

function graphError(code: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    error: { code, message: "x", type: "OAuthException", fbtrace_id: "FB1", ...extra },
  })
}

describe("metaFetch: production error envelopes classify as expected upstream answers", () => {
  it("#80000 insights call-load throttle is a RateLimitError carrying the HTTP status", async () => {
    const { fetch } = makeCtx([
      {
        status: 400,
        body: graphError(80000, { error_subcode: 2446079, error_user_msg: INSIGHTS_THROTTLE_FR }),
      },
    ])
    const err = await metaFetch(fetch, {
      path: "/act_1/insights",
      accessToken: ACCESS_TOKEN,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as MetaApiError).httpStatus).toBe(400)
    expect((err as MetaApiError).subcode).toBe(2446079)
  })

  it("#10 'Application does not have permission' is a PermissionError", async () => {
    const { fetch } = makeCtx([{ status: 403, body: graphError(10) }])
    const err = await metaFetch(fetch, { path: "/act_1/x", accessToken: ACCESS_TOKEN }).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(PermissionError)
    expect((err as MetaApiError).httpStatus).toBe(403)
  })
})

describe("checkInsightsReport: transient Meta answers are pending, not errors", () => {
  const RUN = { reportRunId: "RUN_S", accessToken: ACCESS_TOKEN }

  it("report-not-ready delivered as #100 with subcode 1815005 answers not_ready instead of throwing", async () => {
    const notReady = graphError(100, {
      error_subcode: 1815005,
      error_user_msg: REPORT_NOT_READY_FR,
    })
    const { fetch } = makeCtx([
      { status: 200, body: JSON.stringify({ id: "RUN_S", async_status: "Job Completed" }) },
      { status: 400, body: notReady },
    ])
    expect(await checkInsightsReport(fetch, RUN)).toEqual({
      _pending: true,
      report_run_id: "RUN_S",
      reason: "not_ready",
    })
  })

  it("a throttle on the status answers a rate_limited pending marker", async () => {
    const { fetch, calls } = makeCtx([
      { status: 400, body: graphError(80000, { error_user_msg: INSIGHTS_THROTTLE_FR }) },
    ])
    expect(await checkInsightsReport(fetch, RUN)).toEqual({
      _pending: true,
      report_run_id: "RUN_S",
      reason: "rate_limited",
    })
    expect(calls.length).toBe(1)
  })
})
