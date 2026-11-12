// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The host transport, watched at the wire: the outbound fetch seam
// (OutboundFetchTestAccess) and the DNS resolver are the only fakes; a real
// Bun.serve stands in for a loopback development API.

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { testApiConn } from "~/modules/apps/connections/api/app.test-helpers"
import { invalidateConnectionCaches } from "./cache"
import {
  API_CONNECTOR_REQUEST_TIMEOUT_MS,
  API_CONNECTOR_RESPONSE_CAP_BYTES,
  ApiConnectorError,
  acquireConnectionSlot,
  apiConnectorLog,
  callOperation,
  ERROR_EXCERPT_MAX_CHARS,
  MAX_IN_FLIGHT_PER_CONNECTION,
} from "./transport"

const ORG = "00000000-0000-0000-0000-000000720001"
const KEY = "sk_live_SECRET_123456"

function adapterOf(
  patch: Record<string, unknown> = {},
  opPatch: Record<string, unknown> = {},
): Adapter {
  const r = validateAdapter({
    id: "crm",
    name: "CRM",
    version: "1",
    baseUrl: "https://crm.example.com/api",
    auth: { type: "apiKey", in: "header", name: "X-Api-Key" },
    operations: [
      {
        name: "list_companies",
        description: "Companies.",
        kind: "read",
        method: "GET",
        path: "/companies",
        params: { type: "object", properties: { q: { type: "string" } } },
        query: { q: "{q}" },
        items: "/data",
        fields: ["id", "name"],
        ...opPatch,
      },
    ],
    ...patch,
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
}

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
}

let seen: Seen[] = []
let lookupSpy: ReturnType<typeof spyOn>

function answerWith(fn: (req: Seen) => Response | Promise<Response>): void {
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const req: Seen = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    }
    seen.push(req)
    if (init?.signal?.aborted) throw init.signal.reason
    return fn(req)
  }) as typeof fetch)
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof ApiConnectorError) return err.code
    throw err
  }
  return "no_error"
}

async function errorOf(p: Promise<unknown>): Promise<ApiConnectorError> {
  try {
    await p
  } catch (err) {
    if (err instanceof ApiConnectorError) return err
    throw err
  }
  throw new Error("expected an ApiConnectorError")
}

function call(
  adapter: Adapter,
  params: Record<string, unknown> = {},
  credentials: Record<string, string> = { apiKey: KEY },
) {
  const operation = adapter.operations[0]
  if (!operation) throw new Error("no op")
  return callOperation({
    ...testApiConn(ORG),
    identifier: "crm",
    adapter,
    credentials,
    credentialVersion: "v-test",
    operation,
    params,
  })
}

beforeEach(() => {
  seen = []
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  delete process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
  delete process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS
})

describe("api-connector transport: the shared per-connection limiter", () => {
  it("lets MAX_IN_FLIGHT_PER_CONNECTION requests run at once, the next when one ends", async () => {
    const org = `00000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, "0")}`
    const id = `limiter-${Date.now()}`
    const first = await Promise.all(
      Array.from({ length: MAX_IN_FLIGHT_PER_CONNECTION }, () =>
        acquireConnectionSlot(testApiConn(org), id),
      ),
    )
    let granted = false
    const waiting = acquireConnectionSlot(testApiConn(org), id).then((release) => {
      granted = true
      return release
    })
    const aborted = new AbortController()
    const cancelled = acquireConnectionSlot(testApiConn(org), id, aborted.signal)
    await Bun.sleep(50)
    expect(granted).toBe(false)
    // Another connection is not held up.
    await (await acquireConnectionSlot(testApiConn(org), `${id}-other`))()
    aborted.abort(new Error("gone"))
    await expect(cancelled).rejects.toThrow("gone")
    await first[0]?.()
    const release = await waiting
    expect(granted).toBe(true)
    await release()
    for (const r of first.slice(1)) await r()
  })
})

describe("api-connector transport: happy path", () => {
  it("sends the rendered request with header auth and projects the answer", async () => {
    answerWith(() => json({ data: [{ id: 1, name: "Acme", secret: "x", owner: { ssn: "1" } }] }))
    const r = await call(adapterOf(), { q: "acme" })
    expect(r.items).toEqual([{ id: 1, name: "Acme" }])
    expect(r.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe("https://crm.example.com/api/companies?q=acme")
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY)
  })

  it("applies query, bearer and basic auth", async () => {
    answerWith(() => json({ data: [] }))
    await call(adapterOf({ auth: { type: "apiKey", in: "query", name: "api_key" } }))
    expect(new URL(seen[0]?.url ?? "").searchParams.get("api_key")).toBe(KEY)
    await call(adapterOf({ auth: { type: "bearer" } }), {}, { token: "tok_abcdef" })
    expect(seen[1]?.headers.authorization).toBe("Bearer tok_abcdef")
    await call(adapterOf({ auth: { type: "basic" } }), {}, { username: "u", password: "p4ss" })
    expect(seen[2]?.headers.authorization).toBe(`Basic ${Buffer.from("u:p4ss").toString("base64")}`)
  })

  it("refuses to call without the credential the auth type needs", async () => {
    answerWith(() => json({ data: [] }))
    expect(await codeOf(call(adapterOf(), {}, {}))).toBe("not_configured")
    expect(seen).toHaveLength(0)
  })

  it("follows cursor pagination within the operation's page limit", async () => {
    answerWith((req) => {
      const cursor = new URL(req.url).searchParams.get("cursor")
      const n = cursor ? Number(cursor) : 0
      return json({ data: [{ id: n }], next: n < 10 ? String(n + 1) : null })
    })
    const a = adapterOf(
      {},
      { pagination: { type: "cursor", param: "cursor", cursorPointer: "/next", maxPages: 3 } },
    )
    const r = await call(a)
    expect(r.items.map((i) => i.id)).toEqual([0, 1, 2])
    expect(r.pages).toBe(3)
  })
})

describe("api-connector transport: egress safety", () => {
  it("refuses an off-host redirect and never reaches the other host", async () => {
    answerWith((req) =>
      req.url.startsWith("https://crm.example.com")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://evil.example.org/steal" },
          })
        : json({ data: [{ id: "leak" }] }),
    )
    expect(await codeOf(call(adapterOf()))).toBe("host_refused")
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["crm.example.com"])
  })

  it("follows a same-host redirect", async () => {
    answerWith((req) =>
      req.url.includes("/api/companies")
        ? new Response(null, { status: 302, headers: { location: "/api/v2/companies" } })
        : json({ data: [{ id: 2, name: "Moved" }] }),
    )
    const r = await call(adapterOf())
    expect(r.items).toEqual([{ id: 2, name: "Moved" }])
  })

  it("refuses a baseUrl resolving to a private address unless the deployment allows it", async () => {
    lookupSpy.mockImplementation((async () => [{ address: "10.0.0.5", family: 4 }]) as never)
    answerWith(() => json({ data: [] }))
    expect(await codeOf(call(adapterOf()))).toBe("host_refused")
    expect(seen).toHaveLength(0)
    process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS = "true"
    expect(await codeOf(call(adapterOf()))).toBe("no_error")
    expect(seen).toHaveLength(1)
  })

  it("refuses a private IP literal baseUrl", async () => {
    answerWith(() => json({ data: [] }))
    expect(await codeOf(call(adapterOf({ baseUrl: "https://192.168.1.20" })))).toBe("host_refused")
    expect(seen).toHaveLength(0)
  })

  it("refuses the metadata address even when private hosts are allowed", async () => {
    process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS = "true"
    lookupSpy.mockImplementation((async () => [{ address: "169.254.169.254", family: 4 }]) as never)
    answerWith(() => json({ data: [{ id: "creds" }] }))
    expect(await codeOf(call(adapterOf()))).toBe("host_refused")
    expect(await codeOf(call(adapterOf({ baseUrl: "https://169.254.169.254" })))).toBe(
      "host_refused",
    )
    expect(seen).toHaveLength(0)
  })

  it("refuses plain http to a loopback host without the deployment flag", async () => {
    answerWith(() => json({ data: [] }))
    expect(await codeOf(call(adapterOf({ baseUrl: "http://127.0.0.1:9" })))).toBe("host_refused")
    expect(seen).toHaveLength(0)
  })

  it("reaches a loopback development API over http with the flag (real server)", async () => {
    process.env.LIAISON_ALLOW_PRIVATE_API_CONNECTOR_HOSTS = "true"
    lookupSpy.mockRestore()
    lookupSpy = spyOn(dnsPromises, "lookup")
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => json({ data: [{ id: 9, name: "Local", hidden: "no" }] }),
    })
    try {
      const r = await call(adapterOf({ baseUrl: `http://127.0.0.1:${server.port}` }))
      expect(r.items).toEqual([{ id: 9, name: "Local" }])
    } finally {
      server.stop(true)
    }
  })
})

describe("api-connector transport: bounds", () => {
  it("caps the response at 2 MB, streamed (no content-length)", async () => {
    expect(API_CONNECTOR_RESPONSE_CAP_BYTES).toBe(2 * 1024 * 1024)
    answerWith(() => {
      const chunk = new TextEncoder().encode(`${"x".repeat(64 * 1024)}`)
      let sent = 0
      const stream = new ReadableStream<Uint8Array>({
        pull(ctl) {
          if (sent > API_CONNECTOR_RESPONSE_CAP_BYTES + chunk.byteLength) return ctl.close()
          sent += chunk.byteLength
          ctl.enqueue(chunk)
        },
      })
      return new Response(stream, { status: 200 })
    })
    expect(await codeOf(call(adapterOf()))).toBe("too_large")
  })

  it("refuses a declared oversized body without reading it", async () => {
    answerWith(
      () =>
        new Response("{}", { status: 200, headers: { "content-length": String(3 * 1024 * 1024) } }),
    )
    expect(await codeOf(call(adapterOf()))).toBe("too_large")
  })

  it("times a request out (15 s by default)", async () => {
    expect(API_CONNECTOR_REQUEST_TIMEOUT_MS).toBe(15_000)
    OutboundFetchTestAccess.setFetch((async (_u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(_u), method: "GET", headers: {}, body: null })
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })
    }) as typeof fetch)
    const a = adapterOf()
    const operation = a.operations[0]
    if (!operation) throw new Error("no op")
    const p = callOperation({
      ...testApiConn(ORG),
      identifier: "crm",
      adapter: a,
      credentials: { apiKey: KEY },
      credentialVersion: "v-test",
      operation,
      params: {},
      requestTimeoutMs: 50,
    })
    expect(await codeOf(p)).toBe("timeout")
  })

  it("answers non-JSON as invalid_response", async () => {
    answerWith(() => new Response("<html>login</html>", { status: 200 }))
    expect(await codeOf(call(adapterOf()))).toBe("invalid_response")
  })

  it("refuses unknown params before any request", async () => {
    answerWith(() => json({ data: [] }))
    expect(await codeOf(call(adapterOf(), { admin: true }))).toBe("invalid_params")
    expect(seen).toHaveLength(0)
  })
})

describe("api-connector transport: no credential leaks", () => {
  it("an upstream 401/500 echoing the key reports the status only", async () => {
    for (const status of [401, 500]) {
      answerWith(() => json({ error: `bad key ${KEY}`, echo: KEY }, status))
      const err = await errorOf(call(adapterOf()))
      expect(err.code).toBe("upstream_status")
      expect(err.upstreamStatus).toBe(status)
      expect(err.message).not.toContain(KEY)
      expect(err.message).not.toContain("bad key")
      // The vendor's text rides apart from the message, with the key redacted.
      expect(err.upstreamBody).toContain("bad key [redacted]")
      expect(err.upstreamBody).not.toContain(KEY)
    }
  })

  it("redacts a key echoed URL-encoded or JSON-escaped in the error excerpt", async () => {
    const odd = 'k"e/y\\+1 2&3'
    for (const echo of [
      JSON.stringify({ error: `bad key ${odd}` }),
      JSON.stringify({ error: `bad key ${encodeURIComponent(odd)}` }),
      `{"error":"bad key ${JSON.stringify(odd).slice(1, -1).replaceAll("/", "\\/")}"}`,
    ]) {
      answerWith(() => new Response(echo, { status: 400 }))
      const err = await errorOf(call(adapterOf(), {}, { apiKey: odd }))
      expect(err.upstreamBody).toContain("[redacted]")
      for (const form of [odd, encodeURIComponent(odd), JSON.stringify(odd).slice(1, -1)]) {
        expect(err.upstreamBody).not.toContain(form)
      }
    }
  })

  it("keeps a clipped excerpt of an error answer, never more than its cap", async () => {
    answerWith(() =>
      json(
        {
          status: "error",
          message: "Invalid input JSON on line 1: No content",
          pad: "x".repeat(20_000),
        },
        400,
      ),
    )
    const err = await errorOf(call(adapterOf()))
    expect(err.upstreamStatus).toBe(400)
    expect(err.upstreamBody).toContain("Invalid input JSON on line 1: No content")
    expect(err.upstreamBody?.length).toBeLessThanOrEqual(ERROR_EXCERPT_MAX_CHARS)
  })

  it("a network error carrying the query key is redacted, and logs carry no secret", async () => {
    const warn = spyOn(apiConnectorLog, "warn")
    const error = spyOn(apiConnectorLog, "error")
    try {
      OutboundFetchTestAccess.setFetch((async (
        u: string | URL | Request,
        _init?: RequestInit,
      ): Promise<Response> => {
        throw new TypeError(`connect ECONNREFUSED while fetching ${String(u)}`)
      }) as typeof fetch)
      const err = await errorOf(
        call(adapterOf({ auth: { type: "apiKey", in: "query", name: "api_key" } })),
      )
      expect(err.message).toContain("[redacted]")
      expect(err.message).not.toContain(KEY)
      const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls])
      expect(logged).not.toContain(KEY)
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it("results never carry a credential the API echoes in a non-allowed field", async () => {
    answerWith(() => json({ data: [{ id: 1, name: "A", apiKey: KEY }] }))
    const r = await call(adapterOf())
    expect(JSON.stringify(r)).not.toContain(KEY)
  })
})

describe("api-connector transport: oauth2 client credentials", () => {
  afterAll(async () => {
    await invalidateConnectionCaches(testApiConn(ORG), "crm")
  })

  it("fetches a token from the adapter's token URL once and reuses it", async () => {
    await invalidateConnectionCaches(testApiConn(ORG), "crm")
    answerWith((req) =>
      req.url.endsWith("/oauth/token")
        ? json({ access_token: "tok_from_server", expires_in: 3600 })
        : json({ data: [{ id: 1, name: "A" }] }),
    )
    const a = adapterOf({
      auth: { type: "oauth2ClientCredentials", tokenUrl: "https://crm.example.com/oauth/token" },
    })
    const creds = { clientId: "cid", clientSecret: "csecret_987654" }
    await call(a, {}, creds)
    await call(a, {}, creds)
    const tokenCalls = seen.filter((s) => s.url.endsWith("/oauth/token"))
    expect(tokenCalls).toHaveLength(1)
    expect(tokenCalls[0]?.body).toContain("grant_type=client_credentials")
    expect(
      seen.filter((s) => s.url.includes("/companies")).map((s) => s.headers.authorization),
    ).toEqual(["Bearer tok_from_server", "Bearer tok_from_server"])
  })

  it("refuses an off-host token URL at runtime, even in a document that skipped validation", async () => {
    answerWith(() => json({ access_token: "stolen" }))
    const a = adapterOf({
      auth: { type: "oauth2ClientCredentials", tokenUrl: "https://crm.example.com/oauth/token" },
    })
    const tampered: Adapter = {
      ...a,
      auth: { type: "oauth2ClientCredentials", tokenUrl: "https://evil.example.org/token" },
    }
    expect(
      await codeOf(call(tampered, {}, { clientId: "cid", clientSecret: "csecret_987654" })),
    ).toBe("host_refused")
    expect(seen).toHaveLength(0)
  })
})

describe("api-connector transport: redaction of projected values (P2-SK7, SK11)", () => {
  it("redacts a credential the API echoes in an ALLOWED field", async () => {
    answerWith(() => json({ data: [{ id: 1, name: `Acme (key ${KEY})` }] }))
    const r = await call(adapterOf())
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect(r.items).toEqual([{ id: 1, name: "Acme (key [redacted])" }])
  })

  it("redacts nested and array values too", async () => {
    answerWith(() => json({ data: [{ id: 1, name: "A", tags: ["x", KEY], owner: { name: KEY } }] }))
    const r = await call(adapterOf({}, { fields: ["id", "name", "tags", "owner.name"] }))
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect(r.items[0]).toEqual({
      id: 1,
      name: "A",
      tags: ["x", "[redacted]"],
      owner: { name: "[redacted]" },
    })
  })

  it("redacts a short credential value (no length minimum)", async () => {
    answerWith(() => json({ data: [{ id: 1, name: "user pw9 here" }] }))
    const r = await call(
      adapterOf({ auth: { type: "basic" } }),
      {},
      { username: "u", password: "pw9" },
    )
    expect(JSON.stringify(r.items)).not.toContain("pw9")
    OutboundFetchTestAccess.setFetch((async (
      _u: string | URL | Request,
      _init?: RequestInit,
    ): Promise<Response> => {
      throw new TypeError("socket closed after pw9")
    }) as typeof fetch)
    const err = await errorOf(
      call(adapterOf({ auth: { type: "basic" } }), {}, { username: "u", password: "pw9" }),
    )
    expect(err.message).not.toContain("pw9")
  })
})

describe("api-connector transport: a rendered URL outside the base (P2-SK8)", () => {
  it("is host_refused, not an internal error, with no request", async () => {
    answerWith(() => json({ data: [] }))
    const a = adapterOf()
    const op = a.operations[0]
    if (!op) throw new Error("no op")
    const tampered: Adapter = { ...a, operations: [{ ...op, path: "/../../admin" }] }
    const err = await errorOf(call(tampered))
    expect(err).toBeInstanceOf(ApiConnectorError)
    expect(err.code).toBe("host_refused")
    expect(seen).toHaveLength(0)
  })
})
