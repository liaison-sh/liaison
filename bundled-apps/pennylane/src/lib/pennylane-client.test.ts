// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { PennylaneFetch } from "./pennylane-client"
import { PennylaneApiError, PennylaneClient, PennylaneRateLimitError } from "./pennylane-client"

/** A PennylaneFetch fake: matches a route by URL substring, returns {status,headers,body}. */
function fakeFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: { url: string; opts?: Parameters<PennylaneFetch>[1] }[] = []
  const fn: PennylaneFetch = async (url, opts) => {
    calls.push({ url, opts })
    const match = Object.keys(routes).find((k) => url.includes(k))
    const r = match ? routes[match]! : { status: 404, body: { error: "no route" } }
    return {
      status: r.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(r.body),
    }
  }
  return Object.assign(fn, { calls })
}

describe("PennylaneClient", () => {
  it("sends Bearer auth, hits the v2 base, and parses a cursor page", async () => {
    const fetch = fakeFetch({
      "/supplier_invoices": {
        status: 200,
        body: { items: [{ id: "si_1" }], next_cursor: "c2", has_more: true },
      },
    })
    const c = new PennylaneClient({ fetch, apiToken: "tok_abc" })
    const page = await c.list<{ id: string }>("/supplier_invoices", { limit: 50 })
    expect(page.items).toEqual([{ id: "si_1" }])
    expect(page.next_cursor).toBe("c2")
    expect(page.has_more).toBe(true)
    expect(fetch.calls[0]!.opts?.headers?.Authorization).toBe("Bearer tok_abc")
    expect(fetch.calls[0]!.url.startsWith("https://app.pennylane.com/api/external/v2")).toBe(true)
  })

  it("encodes a filter array as a single filter=[{field,operator,value}] param", async () => {
    const fetch = fakeFetch({
      "/supplier_invoices": {
        status: 200,
        body: { items: [], next_cursor: null, has_more: false },
      },
    })
    const c = new PennylaneClient({ fetch, apiToken: "tok" })
    await c.list("/supplier_invoices", {
      filter: [{ field: "status", operator: "eq", value: "unpaid" }],
    })
    expect(decodeURIComponent(fetch.calls[0]!.url)).toContain(
      'filter=[{"field":"status","operator":"eq","value":"unpaid"}]',
    )
  })

  it("clamps limit to <=100", async () => {
    const fetch = fakeFetch({
      "/customer_invoices": {
        status: 200,
        body: { items: [], next_cursor: null, has_more: false },
      },
    })
    const c = new PennylaneClient({ fetch, apiToken: "tok" })
    await c.list("/customer_invoices", { limit: 9999 })
    expect(decodeURIComponent(fetch.calls[0]!.url)).toContain("limit=100")
  })

  it("defaults limit to 50 when unspecified", async () => {
    const fetch = fakeFetch({
      "/customer_invoices": {
        status: 200,
        body: { items: [], next_cursor: null, has_more: false },
      },
    })
    const c = new PennylaneClient({ fetch, apiToken: "tok" })
    await c.list("/customer_invoices")
    expect(decodeURIComponent(fetch.calls[0]!.url)).toContain("limit=50")
  })

  it("throws PennylaneApiError carrying status + body on non-2xx", async () => {
    const fetch = fakeFetch({ "/bank_accounts": { status: 403, body: { message: "forbidden" } } })
    const c = new PennylaneClient({ fetch, apiToken: "tok" })
    await expect(c.list("/bank_accounts")).rejects.toMatchObject({
      name: "PennylaneApiError",
      status: 403,
    })
    try {
      await c.list("/bank_accounts")
    } catch (e) {
      expect(e).toBeInstanceOf(PennylaneApiError)
      expect((e as PennylaneApiError).body).toContain("forbidden")
    }
  })

  it("turns a 429 into a retryable rate-limit error carrying retry-after, and refuses before sending while the budget is spent", async () => {
    let n = 0
    let clock = 1_000_000
    const fn: PennylaneFetch = async () => {
      n++
      return {
        status: 429,
        headers: { "retry-after": "3", "ratelimit-remaining": "0" },
        body: '{"message":"rate"}',
      }
    }
    const c = new PennylaneClient({ fetch: fn, apiToken: "tok", now: () => clock })
    const err = await c.list("/transactions").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PennylaneRateLimitError)
    expect((err as PennylaneRateLimitError).status).toBe(429)
    expect((err as PennylaneRateLimitError).retryAtMs).toBe(1_003_000)
    // Still inside the window: refused without a request.
    await expect(c.get("/me")).rejects.toBeInstanceOf(PennylaneRateLimitError)
    expect(n).toBe(1)
    clock = 1_004_000
    await expect(c.get("/me")).rejects.toBeInstanceOf(PennylaneRateLimitError) // a fresh 429
    expect(n).toBe(2)
  })

  it("reads the budget from every answer (ratelimit-reset is epoch seconds) and waits for the reset", async () => {
    let n = 0
    let clock = 1_792_049_810_000
    const fn: PennylaneFetch = async () => {
      n++
      return {
        status: 200,
        headers: { "ratelimit-remaining": "0", "ratelimit-reset": "1792049815" },
        body: "{}",
      }
    }
    const c = new PennylaneClient({ fetch: fn, apiToken: "tok", now: () => clock })
    await c.get("/me")
    const err = (await c.get("/me").catch((e: unknown) => e)) as PennylaneRateLimitError
    expect(err.retryAtMs).toBe(1_792_049_815_000)
    expect(n).toBe(1)
    clock = 1_792_049_815_001
    await c.get("/me")
    expect(n).toBe(2)
  })

  it("posts JSON, puts JSON, posts an empty body and a multipart upload with the company header", async () => {
    const seen: Array<{ url: string; opts?: Parameters<PennylaneFetch>[1] }> = []
    const fn: PennylaneFetch = async (url, opts) => {
      seen.push({ url, opts })
      if (url.endsWith("/send_to_pa")) return { status: 204, headers: {}, body: "" }
      if (url.endsWith("/imports"))
        return {
          status: 201,
          headers: {},
          body: '{"id":7}',
          upload: { size: 10, parts: [{ name: "file", size: 9, sha256: "ab" }] },
        }
      return { status: 201, headers: {}, body: '{"id":1}' }
    }
    const c = new PennylaneClient({ fetch: fn, apiToken: "tok", companyId: "100001" })
    expect(await c.post("/customers", { name: "x" })).toEqual({ status: 201, data: { id: 1 } })
    await c.put("/customers/1", { electronic_billing_address: "123456782" })
    expect((await c.postEmpty("/customer_invoices/9/send_to_pa")).status).toBe(204)
    const up = await c.postMultipart("/customer_invoices/e_invoices/imports", [
      { name: "file", fileId: "f", expectSha256: "ab" },
      { name: "send_to_pa", value: "false" },
    ])
    expect(up.data).toEqual({ id: 7 })
    expect(up.upload?.parts[0]?.sha256).toBe("ab")
    expect(seen[0]!.opts).toMatchObject({
      method: "POST",
      body: '{"name":"x"}',
      headers: { "Content-Type": "application/json", "X-Company-Id": "100001" },
    })
    expect(seen[1]!.opts?.method).toBe("PUT")
    expect(seen[2]!.opts?.body).toBeUndefined()
    expect(seen[3]!.opts?.body).toEqual({
      multipart: [
        { name: "file", fileId: "f", expectSha256: "ab" },
        { name: "send_to_pa", value: "false" },
      ],
    })
    expect(seen[3]!.opts?.timeoutMs).toBe(90_000)
    expect(seen[3]!.opts?.headers?.["Content-Type"]).toBeUndefined()
  })

  it("truncates a provider error body to 2 KB", async () => {
    const fn: PennylaneFetch = async () => ({ status: 422, headers: {}, body: "x".repeat(5000) })
    const err = (await new PennylaneClient({ fetch: fn, apiToken: "t" })
      .post("/x", {})
      .catch((e: unknown) => e)) as PennylaneApiError
    expect(err.status).toBe(422)
    expect(err.body.length).toBeLessThanOrEqual(2049)
  })

  it("get<T>() returns the parsed body and sends Bearer auth", async () => {
    const fetch = fakeFetch({
      "/supplier_invoices/si_9": { status: 200, body: { id: "si_9", supplier_name: "Acme" } },
    })
    const c = new PennylaneClient({ fetch, apiToken: "tok" })
    const inv = await c.get<{ id: string; supplier_name: string }>("/supplier_invoices/si_9")
    expect(inv).toEqual({ id: "si_9", supplier_name: "Acme" })
    expect(fetch.calls[0]!.opts?.headers?.Authorization).toBe("Bearer tok")
  })
})

describe("PennylaneApiError message", () => {
  it("carries the status plus Pennylane's own message, truncated, never the token", async () => {
    const fetch = fakeFetch({
      "/trial_balance": {
        status: 400,
        body: {
          message: "period_start is missing",
          field: "period_start",
          code: "InvalidDateFormat",
        },
      },
      "/echo": {
        status: 422,
        body: { error: `bad token tok_secret_123 ${"x".repeat(1000)}`, status: 422 },
      },
    })
    const c = new PennylaneClient({ fetch, apiToken: "tok_secret_123" })
    const err = (await c.list("/trial_balance").catch((e: unknown) => e)) as PennylaneApiError
    expect(err).toBeInstanceOf(PennylaneApiError)
    expect(err.status).toBe(400)
    expect(err.message).toBe(
      "Pennylane 400: period_start is missing (field period_start, code InvalidDateFormat)",
    )
    const err2 = (await c.get("/echo").catch((e: unknown) => e)) as PennylaneApiError
    expect(err2.message.startsWith("Pennylane 422: bad token [redacted] ")).toBe(true)
    expect(err2.message.length).toBeLessThanOrEqual(320)
    expect(err2.message).not.toContain("tok_secret_123")
    expect(err2.body).not.toContain("tok_secret_123")
  })

  it("passes extra query params through list() (e.g. trial_balance's period window)", async () => {
    const fetch = fakeFetch({
      "/trial_balance": { status: 200, body: { items: [], next_cursor: null, has_more: false } },
    })
    const c = new PennylaneClient({ fetch, apiToken: "tok" })
    await c.list("/trial_balance", {
      params: { period_start: "2026-01-01", period_end: "2026-10-25" },
    })
    expect(fetch.calls[0]!.url).toContain("period_start=2026-01-01&period_end=2026-10-25")
  })
})
