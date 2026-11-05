// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import { dialHttp } from "~/modules/mcp-client/transports/http"
import { makeSafeMcpFetch } from "~/modules/mcp-client/transports/safe-fetch"
import {
  McpAuthChallengeError,
  makeCredentialedFetch,
  UnauthorizedError,
} from "~/modules/mcp-client/transports/types"
import { tokenFingerprint } from "../credentials"
import { startFixtureHttpMcpServer } from "./fixtures/http-mcp-server"

describe("MCP transport SSRF guard", () => {
  it("rejects dialing a link-local metadata address", async () => {
    // Cloud IMDS — must never be reachable even with allowPrivate off.
    await expect(
      dialHttp({ url: "https://169.254.169.254/latest/meta-data", bearerToken: "tk" }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError)
  })

  it("rejects dialing loopback by default (no allowPrivate)", async () => {
    await expect(
      dialHttp({ url: "https://127.0.0.1/mcp", bearerToken: "tk" }),
    ).rejects.toBeInstanceOf(UnsafeOutboundUrlError)
  })

  it("safe fetch blocks a 302 redirect into an internal host", async () => {
    const safeFetch = makeSafeMcpFetch()
    const fakeFetch = (async (input: unknown) => {
      const url = String(input)
      if (url === "https://203.0.113.10/mcp") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }) as unknown as typeof fetch
    // Re-bind through fetchWithPinnedHost's fetchImpl seam via OutboundFetchTestAccess.setFetch
    // is not needed: makeSafeMcpFetch validates the redirect TARGET before dialing,
    // so the unsafe location throws before any second hop is attempted.
    const { OutboundFetchTestAccess } = await import("~/lib/outbound-fetch")
    OutboundFetchTestAccess.setFetch(fakeFetch)
    try {
      await expect(safeFetch("https://203.0.113.10/mcp")).rejects.toBeInstanceOf(
        UnsafeOutboundUrlError,
      )
    } finally {
      OutboundFetchTestAccess.setFetch(null)
    }
  })

  it("the bearer token never follows a redirect to another origin", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = []
    const fakeFetch = (async (input: unknown, init: RequestInit = {}) => {
      const url = String(input)
      seen.push({ url, authorization: new Headers(init.headers).get("authorization") })
      if (url.startsWith("https://93.184.216.34/")) {
        return new Response(null, { status: 307, headers: { location: "https://93.184.216.35/x" } })
      }
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const { OutboundFetchTestAccess } = await import("~/lib/outbound-fetch")
    OutboundFetchTestAccess.setFetch(fakeFetch)
    const credentialed = makeCredentialedFetch(makeSafeMcpFetch(), async () => ({
      authorization: "Bearer MCP-ACCESS-TOKEN",
      headers: {},
    }))
    try {
      // A JSON-RPC POST: a cross-origin 307 would replay the body, so it is refused.
      await expect(
        credentialed("https://93.184.216.34/mcp", { method: "POST", body: "{}" }),
      ).rejects.toBeInstanceOf(UnsafeOutboundUrlError)
      expect(seen.map((s) => s.url)).toEqual(["https://93.184.216.34/mcp"])
      // A GET (the SSE stream) follows, without the bearer.
      seen.length = 0
      const res = await credentialed("https://93.184.216.34/mcp", { method: "GET" })
      expect(res.status).toBe(200)
      expect(seen[0].authorization).toBe("Bearer MCP-ACCESS-TOKEN")
      expect(seen[1]).toEqual({ url: "https://93.184.216.35/x", authorization: null })
    } finally {
      OutboundFetchTestAccess.setFetch(null)
    }
  })
})

describe("dialHttp (Streamable HTTP)", () => {
  it("completes initialize + tools/list against an in-process MCP server", async () => {
    const fixture = await startFixtureHttpMcpServer()
    try {
      const live = await dialHttp({ url: fixture.url, bearerToken: null, allowPrivate: true })
      try {
        const { tools } = await live.client.listTools()
        expect(tools.map((t) => t.name)).toContain("echo")
      } finally {
        await live.close()
      }
    } finally {
      await fixture.close()
    }
  })

  it("attaches Authorization: Bearer when bearer token is provided", async () => {
    const seenAuth: Array<string | null> = []
    const fixture = await startFixtureHttpMcpServer({
      onAuthHeader: (h) => seenAuth.push(h),
    })
    try {
      const live = await dialHttp({
        url: fixture.url,
        bearerToken: "tk-secret",
        allowPrivate: true,
      })
      try {
        await live.client.listTools()
      } finally {
        await live.close()
      }
      expect(seenAuth.some((h) => h === "Bearer tk-secret")).toBe(true)
    } finally {
      await fixture.close()
    }
  })

  it("surfaces 401 as UnauthorizedError so caller can trigger OAuth refresh", async () => {
    const fixture = await startFixtureHttpMcpServer({ alwaysReturn401: true })
    try {
      let caught: unknown
      try {
        await dialHttp({ url: fixture.url, bearerToken: "tk-stale", allowPrivate: true })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(UnauthorizedError)
    } finally {
      await fixture.close()
    }
  })

  // ── Per-request credentials (S27 retry-after-refresh, S28 custom headers) ──
  it("reads credentials per request: a token swapped after dial is what the next request carries", async () => {
    const seenAuth: Array<string | null> = []
    const fixture = await startFixtureHttpMcpServer({ onAuthHeader: (h) => seenAuth.push(h) })
    let current = "tk-before"
    try {
      const live = await dialHttp({
        url: fixture.url,
        bearerToken: null,
        credentials: async () => ({ authorization: `Bearer ${current}`, headers: {} }),
        allowPrivate: true,
      })
      try {
        await live.client.listTools()
        current = "tk-after-refresh"
        seenAuth.length = 0
        await live.client.listTools()
      } finally {
        await live.close()
      }
      expect(seenAuth.length).toBeGreaterThan(0)
      expect(seenAuth.every((h) => h === "Bearer tk-after-refresh")).toBe(true)
    } finally {
      await fixture.close()
    }
  })

  it("sends a connection's custom headers on every request", async () => {
    const seen: string[] = []
    const fixture = await startFixtureHttpMcpServer({
      onRequestHeaders: (h) => seen.push(h.get("x-tenant") ?? ""),
    })
    try {
      const live = await dialHttp({
        url: fixture.url,
        bearerToken: null,
        credentials: async () => ({ authorization: null, headers: { "X-Tenant": "acme-42" } }),
        allowPrivate: true,
      })
      try {
        await live.client.listTools()
      } finally {
        await live.close()
      }
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((v) => v === "acme-42")).toBe(true)
    } finally {
      await fixture.close()
    }
  })

  it("a 401 carries the parsed challenge and the fingerprint of the token that was refused", async () => {
    const fixture = await startFixtureHttpMcpServer({
      alwaysReturn401: true,
      challenge:
        'Bearer resource_metadata="https://rs.example/.well-known/oauth-protected-resource", scope="read"',
    })
    try {
      let caught: unknown
      try {
        await dialHttp({
          url: fixture.url,
          bearerToken: null,
          credentials: async () => ({ authorization: "Bearer tk-stale", headers: {} }),
          allowPrivate: true,
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(McpAuthChallengeError)
      const err = caught as McpAuthChallengeError
      expect(err.httpStatus).toBe(401)
      expect(err.challenge.resourceMetadataUrl).toBe(
        "https://rs.example/.well-known/oauth-protected-resource",
      )
      expect(err.challenge.scope).toBe("read")
      expect(err.tokenFingerprint).toBe(tokenFingerprint("tk-stale"))
      expect(err.message).not.toContain("tk-stale")
    } finally {
      await fixture.close()
    }
  })
})
