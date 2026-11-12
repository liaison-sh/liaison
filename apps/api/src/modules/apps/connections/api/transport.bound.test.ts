// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bound egress for import transforms (boundGet, boundFetchToStream), watched
// at the wire through the outbound fetch seam and a faked resolver, and once
// end to end from a sandboxed transform: the credential never reaches the
// transform, an error or another host.
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { testApiConn } from "~/modules/apps/connections/api/app.test-helpers"
import { runApiPull } from "~/modules/imports/transforms/execute"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"
import {
  ApiConnectorError,
  type BoundRequestInput,
  boundFetchToStream,
  boundGet,
  boundRequestUrl,
} from "./transport"

const ORG = "00000000-0000-0000-0000-000000740001"
const KEY = "sk_live_SENTINEL_9f8e7d6c5b4a"
const PASSWORD = "pw-SENTINEL-1234"

function adapterOf(patch: Record<string, unknown> = {}): Adapter {
  const r = validateAdapter({
    id: "helpdesk",
    name: "Helpdesk",
    version: "1",
    baseUrl: "https://helpdesk.example.com/api/v2",
    auth: { type: "bearer" },
    redirectHosts: ["media.example-cdn.com"],
    operations: [
      {
        name: "list_tickets",
        description: "Tickets.",
        kind: "read",
        method: "GET",
        path: "/tickets",
        params: { type: "object", properties: {} },
        items: "/data",
        fields: ["id"],
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
}

let seen: Seen[] = []
let lookupSpy: ReturnType<typeof spyOn>

function answerWith(fn: (req: Seen) => Response | Promise<Response>): void {
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const req = { url: String(input), method: init?.method ?? "GET", headers }
    seen.push(req)
    return fn(req)
  }) as typeof fetch)
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

function input(path: string, patch: Partial<BoundRequestInput> = {}): BoundRequestInput {
  return {
    ...testApiConn(ORG),
    identifier: "helpdesk",
    adapter: adapterOf(),
    credentials: { token: KEY },
    credentialVersion: "v-test",
    path,
    ...patch,
  }
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
})

afterAll(async () => {
  await shutdownTransformPool()
})

describe("bound egress: the path stays on the base URL", () => {
  it("joins a relative path and query to the base URL", () => {
    expect(boundRequestUrl(adapterOf(), "/tickets?page=2&per_page=100").toString()).toBe(
      "https://helpdesk.example.com/api/v2/tickets?page=2&per_page=100",
    )
  })

  it("refuses absolute URLs, protocol-relative paths, dot segments and encoded escapes", () => {
    const refused = [
      "https://evil.example.net/x",
      "//evil.example.net/x",
      "tickets",
      "/../admin",
      "/tickets/../../admin",
      "/%2e%2e/admin",
      "/%2E%2e/admin",
      "/a%2fb/../c",
      "/tickets\\..\\admin",
      "/tickets#frag",
      "javascript:alert(1)",
    ]
    for (const p of refused) {
      expect(() => boundRequestUrl(adapterOf(), p)).toThrow(ApiConnectorError)
    }
  })

  it("sends GET only, with the auth added host-side", async () => {
    answerWith(() => json({ data: [] }))
    const r = await boundGet(input("/tickets"))
    expect(r).toEqual({ status: 200, data: { data: [] }, retryAfterMs: null })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe("GET")
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it("refuses a host that resolves to a private address", async () => {
    lookupSpy.mockImplementation((async () => [{ address: "10.0.0.5", family: 4 }]) as never)
    answerWith(() => json({}))
    const err = await errorOf(boundGet(input("/tickets")))
    expect(err.code).toBe("host_refused")
    expect(seen).toHaveLength(0)
  })
})

describe("bound egress: redirects", () => {
  it("follows a redirect to a declared host with every request header stripped", async () => {
    answerWith((req) =>
      req.url.startsWith("https://helpdesk.example.com/")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://media.example-cdn.com/f/abc?sig=1" },
          })
        : new Response("file-bytes", {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
    )
    const r = await boundFetchToStream(input("/attachments/10001/content"))
    expect(r.status).toBe(200)
    expect(await new Response(r.body).text()).toBe("file-bytes")
    expect(seen.map((s) => new URL(s.url).host)).toEqual([
      "helpdesk.example.com",
      "media.example-cdn.com",
    ])
    expect(seen[1]?.headers.authorization).toBeUndefined()
    expect(JSON.stringify(seen[1]?.headers)).not.toContain(KEY)
  })

  it("an apiKey header is not forwarded on a cross-host redirect either", async () => {
    const adapter = adapterOf({ auth: { type: "apiKey", in: "header", name: "X-Api-Key" } })
    answerWith((req) =>
      req.url.startsWith("https://helpdesk.example.com/")
        ? new Response(null, {
            status: 307,
            headers: { location: "https://media.example-cdn.com/f/abc" },
          })
        : new Response("ok", { status: 200 }),
    )
    const r = await boundFetchToStream(
      input("/attachments/1", { adapter, credentials: { apiKey: KEY } }),
    )
    expect(r.status).toBe(200)
    await r.body?.cancel()
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY)
    expect(seen[1]?.headers["x-api-key"]).toBeUndefined()
    expect(Object.keys(seen[1]?.headers ?? {})).toEqual([])
  })

  it("sends the adapter's static headers on the first hop only, after a redirect none", async () => {
    const adapter = adapterOf({ headers: { "X-ExperimentalApi": "opt-in" } })
    answerWith((req) =>
      req.url.startsWith("https://helpdesk.example.com/")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://media.example-cdn.com/f/1" },
          })
        : new Response("ok", { status: 200 }),
    )
    const r = await boundFetchToStream(input("/customers", { adapter }))
    await r.body?.cancel()
    expect(seen[0]?.headers["x-experimentalapi"]).toBe("opt-in")
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(seen[1]?.headers["x-experimentalapi"]).toBeUndefined()
    answerWith(() => json({ values: [] }))
    seen = []
    await boundGet(input("/customers", { adapter }))
    expect(seen[0]?.headers["x-experimentalapi"]).toBe("opt-in")
  })

  it("refuses a redirect to an undeclared host", async () => {
    answerWith(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.net/steal" },
        }),
    )
    const err = await errorOf(boundFetchToStream(input("/attachments/1")))
    expect(err.code).toBe("host_refused")
    expect(err.message).toContain("redirectHosts")
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["helpdesk.example.com"])
  })

  it("refuses a plain-http redirect even to a declared host", async () => {
    answerWith(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://media.example-cdn.com/f" },
        }),
    )
    const err = await errorOf(boundFetchToStream(input("/attachments/1")))
    expect(err.code).toBe("host_refused")
  })
})

describe("bound egress: filenames and timers", () => {
  it("a Content-Disposition filename is sanitized at the source", async () => {
    answerWith(
      () =>
        new Response("x", {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="../../evil\\..\\run.sh"' },
        }),
    )
    const r = await boundFetchToStream(input("/attachments/1"))
    await r.body?.cancel()
    expect(r.filename).toBe("run.sh")
  })

  it("boundGet clears its request timer once the answer is read", async () => {
    let signal: AbortSignal | undefined
    OutboundFetchTestAccess.setFetch((async (_u: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return json({ ok: true })
    }) as typeof fetch)
    await boundGet(input("/tickets", { requestTimeoutMs: 30 }))
    await Bun.sleep(80)
    expect(signal?.aborted).toBe(false)
  })
})

describe("bound egress: answers and secrets", () => {
  it("returns a 429 with its Retry-After instead of throwing", async () => {
    answerWith(() => json({ error: "slow down" }, 429, { "retry-after": "7" }))
    expect(await boundGet(input("/tickets"))).toEqual({
      status: 429,
      data: null,
      retryAfterMs: 7000,
    })
    answerWith(() => new Response(null, { status: 429, headers: { "retry-after": "3" } }))
    const s = await boundFetchToStream(input("/attachments/1"))
    expect(s).toMatchObject({ status: 429, body: null, retryAfterMs: 3000 })
  })

  it("other non-2xx answers report the status without the body", async () => {
    answerWith(() => json({ message: `invalid token ${KEY}` }, 401))
    expect(await boundGet(input("/tickets"))).toEqual({
      status: 401,
      data: null,
      retryAfterMs: null,
    })
  })

  it("redacts the credential from returned data, including Basic forms and keys", async () => {
    const basic = Buffer.from(`agent@example.com:${PASSWORD}`).toString("base64")
    answerWith(() =>
      json({
        echo: `token=${KEY}`,
        nested: [{ v: encodeURIComponent(PASSWORD) }, { b: basic }],
        [KEY]: 1,
      }),
    )
    const adapter = adapterOf({ auth: { type: "basic" } })
    const r = await boundGet(
      input("/me", { adapter, credentials: { username: "agent@example.com", password: PASSWORD } }),
    )
    const text = JSON.stringify(r)
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain(encodeURIComponent(PASSWORD))
    expect(text).not.toContain(basic)
    expect(text).toContain("[redacted]")
  })

  it("redacts only secret credential fields: the login identifier (Basic username, OAuth client id) arrives intact, so authors resolve", async () => {
    answerWith(() =>
      json({
        author: { emailAddress: "agent@example.com", displayName: "Agent" },
        leaked: `pw ${PASSWORD}`,
      }),
    )
    const adapter = adapterOf({ auth: { type: "basic" } })
    const r = await boundGet(
      input("/comment", {
        adapter,
        credentials: { username: "agent@example.com", password: PASSWORD },
      }),
    )
    const text = JSON.stringify(r)
    expect(text).toContain('"emailAddress":"agent@example.com"')
    expect(text).not.toContain(PASSWORD)
    expect(text).toContain("pw [redacted]")
  })

  it("redacts the credential from transport error messages", async () => {
    const adapter = adapterOf({ auth: { type: "apiKey", in: "query", name: "api_key" } })
    answerWith((req) => {
      throw new Error(`connect ECONNRESET ${req.url}`)
    })
    const err = await errorOf(
      boundGet(input("/tickets", { adapter, credentials: { apiKey: KEY } })),
    )
    expect(err.message).toContain("could not be reached")
    expect(err.message).not.toContain(KEY)
  })

  it("a sandboxed transform pulling through apiGet never holds the credential (globalThis, answers, errors)", async () => {
    const adapter = adapterOf({ auth: { type: "apiKey", in: "header", name: "X-Api-Key" } })
    answerWith((req) =>
      req.url.includes("/fail")
        ? (() => {
            throw new Error(`socket hang up (key ${KEY})`)
          })()
        : json({ data: [{ id: 1, note: `echo ${KEY}` }], next: null }),
    )
    const emitted: unknown[] = []
    const r = await runApiPull({
      source: `
          async function pull(page, ctx) {
            var ok = await ctx.apiGet("/tickets")
            var failure = null
            try { await ctx.apiGet("/fail") } catch (e) { failure = String(e && e.message || e) }
            var refused = null
            try { await ctx.apiGet("https://evil.example.net/x") } catch (e) { refused = String(e && e.message || e) }
            await ctx.emitRecords("tickets.ticket", [{
              globals: JSON.stringify(Object.getOwnPropertyNames(globalThis).map(function (k) {
                try { return k + "=" + JSON.stringify(globalThis[k]) } catch (e) { return k }
              })),
              ctx: JSON.stringify(ctx),
              ok: ok,
              failure: failure,
              refused: refused
            }])
            return { nextCursor: null }
          }`,
      host: {
        orgId: ORG,
        kinds: ["tickets.ticket"],
        apiGet: async (path: string) => {
          try {
            return await boundGet({
              ...testApiConn(ORG),
              identifier: "helpdesk",
              adapter,
              credentials: { apiKey: KEY },
              credentialVersion: "v-test",
              path,
            })
          } catch (err) {
            if (err instanceof ApiConnectorError) throw new Error(err.message)
            throw err
          }
        },
      },
      sink: {
        onEmitted: async (b) => {
          for (const e of b) emitted.push(...e.records)
        },
      },
    })
    expect(r.stoppedOn).toBe("done")
    expect(emitted).toHaveLength(1)
    const record = emitted[0] as { failure: string; refused: string; ok: { status: number } }
    expect(record.ok.status).toBe(200)
    expect(record.failure).toContain("could not be reached")
    expect(record.refused).toContain("never a full URL")
    expect(JSON.stringify(emitted)).not.toContain(KEY)
    expect(seen.every((s) => new URL(s.url).host === "helpdesk.example.com")).toBe(true)
  }, 60_000)
})
